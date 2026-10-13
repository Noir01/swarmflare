import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { startLocalWorkspace } from '../../apps/local/index';
import { WorkspaceClient } from '../../packages/client/index';
import { runSourceJob } from '../../packages/local-runner/index';
import { readSourceReceipt } from '../../packages/git-runner/index';

const execFileAsync = promisify(execFile);
const token = 'recovery-runner-token';
const git = async (cwd: string, ...args: string[]) => (await execFileAsync('git', ['-C', cwd, ...args])).stdout.trim();

it('recovers a committed source completion after a deliberately injected lost HTTP response and restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'source-recovery-'));
  const stateDirectory = join(root, 'state');
  let app: Awaited<ReturnType<typeof startLocalWorkspace>> | undefined;
  let proxy: Server | undefined;
  let proxyUrl: string | undefined;
  let droppedResponses = 0;
  let completionRequests = 0;
  const closeProxy = async () => {
    if (!proxy?.listening) return;
    await new Promise<void>((resolve, reject) => proxy!.close(error => error ? reject(error) : resolve()));
  };
  try {
    const projectId = 'recovery-e2e';
    const credentials = JSON.stringify([
      { id: 'human', projectId, role: 'human', tokenHash: createHash('sha256').update('recovery-human-token').digest('hex'), expiresAt: Date.now() + 300_000 },
      { id: 'runner', projectId, role: 'runner', tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: Date.now() + 300_000 },
    ]);
    app = await startLocalWorkspace({ stateDirectory, authCredentials: credentials, dashboardSessionKey: 'e'.repeat(64), runBudgetMs: 80_000 });
    const baseUrl = app.url;
    const human = new WorkspaceClient({ baseUrl, projectId, token: 'recovery-human-token', deadline: 60_000 });
    const directRunner = new WorkspaceClient({ baseUrl, projectId, token, deadline: 60_000 });
    const source = join(root, 'source'), remote = join(root, 'remote.git'), workspaceRoot = join(root, 'work');
    await mkdir(source); await mkdir(workspaceRoot);
    await execFileAsync('git', ['init', '-q', source]);
    await git(source, 'config', 'user.name', 'Recovery Test'); await git(source, 'config', 'user.email', 'recovery@example.invalid');
    await writeFile(join(source, 'source.txt'), 'real persisted source\n');
    await git(source, 'add', '.'); await git(source, 'commit', '-qm', 'recovery source');
    const commitOid = await git(source, 'rev-parse', 'HEAD');
    const treeOid = await git(source, 'rev-parse', 'HEAD^{tree}');
    await execFileAsync('git', ['init', '--bare', '-q', remote]);
    const proposal = await human.createProposal({ requestId: 'recovery-proposal', payload: { outcome: 'Persist local source', constraints: [], obligations: [{ id: 'source', description: 'Publish source', acceptanceExamples: [] }], requiredCheckIds: ['check'], unresolvedQuestions: [] } }) as { id: string };
    await human.approveProposal(proposal.id, { requestId: 'recovery-approve', payload: {} });
    const queued = await human.initializeBaseline({ requestId: 'recovery-baseline', expectedVersion: 0, payload: { commitOid, treeOid } });
    expect(queued.data.input.kind).toBe('seed');

    // Deliberately injected transport fault: consume upstream 201, then destroy only the first completion response socket.
    proxy = createServer((incoming, outgoing) => {
      const target = new URL(incoming.url ?? '/', baseUrl);
      const upstream = httpRequest(target, { method: incoming.method, headers: incoming.headers }, response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.on('end', () => {
          const isCompletion = incoming.method === 'POST' && /^\/api\/v1\/projects\/[^/]+\/runner\/jobs\/[^/]+\/complete$/.test(target.pathname);
          if (isCompletion) completionRequests++;
          if (isCompletion && response.statusCode === 201 && droppedResponses === 0) {
            droppedResponses++;
            outgoing.destroy();
            return;
          }
          outgoing.writeHead(response.statusCode ?? 502, response.headers);
          outgoing.end(Buffer.concat(chunks));
        });
      });
      upstream.on('error', error => { if (!outgoing.destroyed) { outgoing.destroy(error); } });
      incoming.pipe(upstream);
    });
    await new Promise<void>((resolve, reject) => { proxy!.once('error', reject); proxy!.listen(0, '127.0.0.1', resolve); });
    const address = proxy.address();
    if (!address || typeof address === 'string') throw new Error('proxy did not bind a TCP port');
    proxyUrl = `http://127.0.0.1:${address.port}`;
    const faultRunner = new WorkspaceClient({ baseUrl: proxyUrl, projectId, token, deadline: 15_000 });
    await expect(runSourceJob(faultRunner, { remote, workspaceRoot, resolveRepository: () => source, requestId: 'stable-recovery' })).rejects.toBeDefined();
    expect(droppedResponses).toBe(1);
    expect(completionRequests).toBe(1);
    const completedBeforeRestart = await directRunner.sourceJob(queued.id);
    expect(completedBeforeRestart.data.status).toBe('completed');
    expect(completedBeforeRestart.data.receipt).toMatchObject({ backend: 'local-git', commitOid, treeOid, ref: `refs/agent/seeds/${queued.data.input.kind === 'seed' ? queued.data.input.seedId : ''}` });
    const originalReceipt = completedBeforeRestart.data.receipt!;
    expect(await readSourceReceipt(remote, originalReceipt.ref)).toEqual(originalReceipt);
    const eventsBefore = await directRunner.events({ limit: 100 }) as { events: Array<{ action: string; resourceId: string }> };
    const completionEventsBefore = eventsBefore.events.filter(event => event.action === 'runner.complete' && event.resourceId === queued.id);
    expect(completionEventsBefore).toHaveLength(1);

    await closeProxy(); proxy = undefined;
    await app.close(); app = undefined;
    app = await startLocalWorkspace({ stateDirectory, authCredentials: credentials, dashboardSessionKey: 'e'.repeat(64), runBudgetMs: 80_000 });
    const restartedRunner = new WorkspaceClient({ baseUrl: app.url, projectId, token, deadline: 15_000 });
    const jobAfterRestart = await restartedRunner.sourceJob(queued.id);
    expect(jobAfterRestart).toEqual(completedBeforeRestart);
    expect(await readSourceReceipt(remote, originalReceipt.ref)).toEqual(originalReceipt);
    const retry = await runSourceJob(restartedRunner, { remote, workspaceRoot, resolveRepository: () => source, requestId: 'stable-recovery' });
    expect(retry).toEqual(completedBeforeRestart);
    expect(retry?.data.receipt).toEqual(originalReceipt);
    expect(await restartedRunner.sourceJob(queued.id)).toEqual(completedBeforeRestart);
    const eventsAfter = await restartedRunner.events({ limit: 100 }) as { events: Array<{ action: string; resourceId: string }> };
    expect(eventsAfter.events.filter(event => event.action === 'runner.complete' && event.resourceId === queued.id)).toEqual(completionEventsBefore);
    expect(completionRequests).toBe(1);
    expect(await git(source, 'rev-parse', 'HEAD')).toBe(commitOid);
    expect(await git(source, 'status', '--porcelain')).toBe('');
    expect(await git(remote, 'rev-parse', originalReceipt.ref)).toBe(commitOid);
  } finally {
    await closeProxy().catch(() => {});
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 85_000);


