import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLocalWorkspace } from '../../apps/local/index';
import { WorkspaceClient } from '../../packages/client/index';
import { readSourceReceipt } from '../../packages/git-runner/index';

const execFileAsync = promisify(execFile);
const cli = join(process.cwd(), 'apps/runner/index.ts');
const token = 'synthetic-cli-runner-secret-sentinel';
async function invoke(args: string[], baseUrl?: string) {
  try {
    const result = await execFileAsync(process.execPath, ['node_modules/tsx/dist/cli.mjs', cli, ...args], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, WORKSPACE_BASE_URL: baseUrl, WORKSPACE_PROJECT_ID: 'runner-e2e', WORKSPACE_TOKEN: token },
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string; killed?: boolean };
    if (e.killed) throw new Error('runner CLI child exceeded 60000ms');
    return { code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}
const git = async (cwd: string, ...args: string[]) => (await execFileAsync('git', ['-C', cwd, ...args])).stdout.trim();

it('runs seed and publication jobs through the real CLI and verifies Git receipts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runner-cli-e2e-'));
  let app: Awaited<ReturnType<typeof startLocalWorkspace>> | undefined;
  try {
    const projectId = 'runner-e2e';
    const identities = [['human', 'human', 'synthetic-human'], ['alice', 'contributor', 'synthetic-alice'], ['runner', 'runner', token]];
    const authCredentials = JSON.stringify(identities.map(([id, role, secret]) => ({ id, projectId, role, tokenHash: createHash('sha256').update(secret!).digest('hex'), expiresAt: Date.now() + 300_000 })));
    app = await startLocalWorkspace({ stateDirectory: join(root, 'state'), authCredentials, dashboardSessionKey: 'd'.repeat(64), runBudgetMs: 60_000 });
    const human = new WorkspaceClient({ baseUrl: app.url, projectId, token: 'synthetic-human', maxRequests: 100, deadline: 60_000 });
    const alice = new WorkspaceClient({ baseUrl: app.url, projectId, token: 'synthetic-alice', maxRequests: 100, deadline: 60_000 });
    const runner = new WorkspaceClient({ baseUrl: app.url, projectId, token, maxRequests: 100, deadline: 60_000 });
    const seed = join(root, 'seed'), branch = join(root, 'alice-repo'), remote = join(root, 'remote.git'), workspaceRoot = join(root, 'work');
    await mkdir(seed); await mkdir(workspaceRoot);
    await execFileAsync('git', ['init', '-q', seed]);
    await git(seed, 'config', 'user.name', 'E2E'); await git(seed, 'config', 'user.email', 'e2e@example.invalid');
    await writeFile(join(seed, 'base.txt'), 'baseline\n'); await git(seed, 'add', '.'); await git(seed, 'commit', '-qm', 'baseline');
    const baseCommit = await git(seed, 'rev-parse', 'HEAD'), baseTree = await git(seed, 'rev-parse', 'HEAD^{tree}');
    await execFileAsync('git', ['init', '--bare', '-q', remote]);
    const proposal = await human.createProposal({ requestId: 'proposal', payload: { outcome: 'Exercise local source publishing', constraints: [], obligations: [{ id: 'source-obligation', description: 'Publish source', acceptanceExamples: [] }], requiredCheckIds: ['demo'], unresolvedQuestions: [] } }) as { id: string };
    await human.approveProposal(proposal.id, { requestId: 'approve', payload: {} });
    const decision = await human.createDecision({ requestId: 'decision', payload: { question: 'Publish this revision?', obligationIds: ['source-obligation'], participants: ['alice'], material: false } }) as { id: string };
    await alice.respondDecision(decision.id, { requestId: 'response', payload: { body: 'I agree to publish the revision.', acknowledge: true } });
    const agreement = await alice.agreeDecision(decision.id, { requestId: 'agreement', payload: {} }) as { version: number };
    const baseline = await human.initializeBaseline({ requestId: 'baseline', expectedVersion: 0, payload: { commitOid: baseCommit, treeOid: baseTree } });
    expect(baseline.data.input.kind).toBe('seed');
    const envUrl = app.url;
    const seedJob = await invoke(['source-job', JSON.stringify({ remote, workspaceRoot, seedRepository: seed, repositories: {}, requestId: 'seed-cli' })], envUrl);
    expect(seedJob.code).toBe(0);
    const seedResult = JSON.parse(seedJob.stdout);
    expect(seedResult.data.status).toBe('completed');
    const seededJob = await runner.sourceJob(baseline.id);
    expect(seededJob.data.receipt).toEqual(await readSourceReceipt(remote, `refs/agent/seeds/${baseline.data.input.kind === 'seed' ? baseline.data.input.seedId : ''}`));
    expect(await invoke(['source-job', JSON.stringify({ remote, workspaceRoot, seedRepository: seed, repositories: {}, requestId: 'empty-cli' })], envUrl)).toMatchObject({ code: 0, stdout: 'null\n' });
    await expect(alice.claimSourceJob({ requestId: 'contributor-claim', payload: { leaseSeconds: 30 } })).rejects.toMatchObject({ status: 403 });

    await execFileAsync('git', ['clone', '-q', seed, branch]);
    await git(branch, 'config', 'user.name', 'E2E'); await git(branch, 'config', 'user.email', 'e2e@example.invalid');
    await writeFile(join(branch, 'change.txt'), 'published\n'); await git(branch, 'add', '.'); await git(branch, 'commit', '-qm', 'change');
    const commitOid = await git(branch, 'rev-parse', 'HEAD'), treeOid = await git(branch, 'rev-parse', 'HEAD^{tree}');
    const change = await alice.createChange({ requestId: 'change', payload: { title: 'CLI publication', obligationIds: ['source-obligation'] } });
    const revision = await alice.publishRevision(change.id, { requestId: 'revision', payload: { baseCommitOid: baseCommit, commitOid, treeOid, obligationIds: ['source-obligation'], decisionRevisions: [{ decisionId: decision.id, version: agreement.version }], dependencies: [] } });
    expect(revision.data.status).toBe('reserved');
    const publishArgs = (repositories: Record<string, string>, requestId: string) => ['source-job', JSON.stringify({ remote, workspaceRoot, seedRepository: seed, repositories, requestId })];
    const missing = await invoke(publishArgs({ bob: branch }, 'publish-missing-cli'), envUrl);
    expect(missing.code).not.toBe(0);
    expect(missing.stdout).not.toContain(token); expect(missing.stderr).not.toContain(token);
    expect((await human.revision(revision.id)).data.status).toBe('failed');
    expect((await runner.sourceJob((await human.change(change.id)).data.revisions[0]!.jobId)).data.status).toBe('failed');

    const validChange = await alice.createChange({ requestId: 'change-valid', payload: { title: 'CLI valid publication', obligationIds: ['source-obligation'] } });
    const validRevision = await alice.publishRevision(validChange.id, { requestId: 'revision-valid', payload: { baseCommitOid: baseCommit, commitOid, treeOid, obligationIds: ['source-obligation'], decisionRevisions: [{ decisionId: decision.id, version: agreement.version }], dependencies: [] } });
    const valid = await invoke(publishArgs({ alice: branch }, 'publish-valid-cli'), envUrl);
    expect(valid.code, `${valid.stdout} ${valid.stderr}`).toBe(0);
    expect(JSON.parse(valid.stdout).data.status).toBe('completed');
    expect(await human.revision(validRevision.id)).toMatchObject({ data: { status: 'published', receipt: { commitOid, treeOid } } });
    expect(await readSourceReceipt(remote, `refs/agent/revisions/${validChange.id}/${validRevision.id}`)).toMatchObject({ commitOid, treeOid });
    expect(valid.stdout).not.toContain(token); expect(valid.stderr).not.toContain(token);
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 90_000);

it('shows help and rejects remote targets before network access', async () => {
  const help = await execFileAsync(process.execPath, ['node_modules/tsx/dist/cli.mjs', cli, '--help'], { timeout: 60_000 });
  expect(help.stdout).toContain('verify-source');
  const result = await invoke(['verify-source', JSON.stringify({ remote: '/tmp/local.git', viewId: 'view-1', requestId: 'verify-1' })], 'https://example.invalid');
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain('loopback');
});
