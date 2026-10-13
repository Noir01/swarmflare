import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { startLocalWorkspace } from '../../apps/local/index';
import { WorkspaceClient } from '../../packages/client/index';

const children = new Set<ReturnType<typeof spawn>>();
afterEach(async () => {
  for (const child of children) child.kill('SIGKILL');
  await Promise.all([...children].map(child => new Promise<void>(resolveChild => child.once('close', () => resolveChild()))));
  children.clear();
});

it('records artifacts-git selection without creating a baseline or relaxing setup policy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'setup-artifacts-'));
  const projectId = 'setup-artifacts'; const token = 'synthetic-artifacts-human';
  const runnerToken = 'synthetic-artifacts-runner';
  const credentials = JSON.stringify([
    { id: 'human', projectId, role: 'human', tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: Date.now() + 300_000 },
    { id: 'runner', projectId, role: 'runner', tokenHash: createHash('sha256').update(runnerToken).digest('hex'), expiresAt: Date.now() + 300_000 },
  ]);
  let app: Awaited<ReturnType<typeof startLocalWorkspace>> | undefined;
  try {
    app = await startLocalWorkspace({ stateDirectory: join(root, 'state'), authCredentials: credentials, dashboardSessionKey: 'a'.repeat(64), runBudgetMs: 30_000 });
    const arg = JSON.stringify({ requestId: 'artifacts-demo', commitOid: 'a'.repeat(40), treeOid: 'b'.repeat(40), sourceBackend: 'artifacts-git' });
    const run = (input = arg) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveRun, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', resolve('apps/setup/index.ts'), input], { env: { ...process.env, WORKSPACE_BASE_URL: app!.url, WORKSPACE_PROJECT_ID: projectId, WORKSPACE_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
      children.add(child);
      const outputLimit = 1_000_000;
      let stdout = ''; let stderr = ''; let settled = false;
      const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
      child.stdout.setEncoding('utf8').on('data', chunk => { if (stdout.length < outputLimit) stdout += chunk.slice(0, outputLimit - stdout.length); });
      child.stderr.setEncoding('utf8').on('data', chunk => { if (stderr.length < outputLimit) stderr += chunk.slice(0, outputLimit - stderr.length); });
      child.once('error', error => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
      child.once('close', code => { children.delete(child); clearTimeout(timer); if (!settled) { settled = true; resolveRun({ code, stdout, stderr }); } });
    });
    const result = await run(); expect(result.code).toBe(0); expect(result.stderr).toBe('');
    const output = JSON.parse(result.stdout); expect(output).toMatchObject({ mode: 'local-only', sourceBackend: 'artifacts-git', status: 'pending-seed-publication' });
    const client = new WorkspaceClient({ baseUrl: app.url, projectId, token, deadline: 10_000 });
    const runner = new WorkspaceClient({ baseUrl: app.url, projectId, token: runnerToken, deadline: 10_000 });
    expect((await client.policy())?.data).toMatchObject({ sourceBackend: 'artifacts-git', requireIndependentReview: true, checkSuiteDigest: expect.any(String) });
    expect(await client.baseline()).toBeNull();
    expect((await runner.sourceJob(output.pendingSeedJobId)).data).toMatchObject({ status: 'queued', input: { kind: 'seed' } });
    const eventsBeforeMismatch = await client.events({ limit: 100 });
    const mismatch = await run(JSON.stringify({ requestId: 'artifacts-demo', commitOid: 'a'.repeat(40), treeOid: 'b'.repeat(40), sourceBackend: 'local-git' }));
    expect(mismatch.code).toBe(1); expect(mismatch.stderr).toContain('incompatible preexisting policy');
    expect(await client.events({ limit: 100 })).toEqual(eventsBeforeMismatch);
    expect((await run()).code).toBe(0);
  } finally { await app?.close(); await rm(root, { recursive: true, force: true }); }
}, 60_000);
