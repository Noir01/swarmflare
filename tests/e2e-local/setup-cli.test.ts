import { afterEach, expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WorkspaceClient } from '../../packages/client/index';

let runtime: Miniflare | undefined;
let scratch: string | undefined;
const children = new Set<ReturnType<typeof spawn>>();
afterEach(async () => {
  for (const child of children) child.kill('SIGKILL');
  await Promise.all([...children].map(child => new Promise<void>(resolveChild => child.once('close', () => resolveChild()))));
  children.clear(); await runtime?.dispose(); runtime = undefined; if (scratch) await rm(scratch, { recursive: true, force: true }); scratch = undefined;
});

it('initializes through the spawned CLI with idempotency, server-enforced human role and strict local preflight', async () => {
  scratch = await mkdtemp(join(tmpdir(), 'setup-cli-'));
  const repo = join(scratch, 'repo'); execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'Local Setup Test']);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'setup@example.invalid']);
  execFileSync('git', ['-C', repo, 'commit', '--allow-empty', '-qm', 'pending seed']);
  const commitOid = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const treeOid = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
  const projectId = 'setup-cli-test';
  const credentials = ['human', 'contributor', 'runner'].map(role => ({ id: role, role, projectId, tokenHash: createHash('sha256').update(`synthetic-${role}`).digest('hex'), expiresAt: Date.now() + 300_000 }));
  const bundle = await build({ entryPoints: ['apps/worker/src/index.ts'], bundle: true, platform: 'browser', format: 'esm', write: false, external: ['cloudflare:workers'] });
  runtime = new Miniflare(convertV4MiniflareOptions({ name: projectId, modules: true, script: bundle.outputFiles[0]!.text, compatibilityDate: '2026-08-01', durableObjects: { PROJECTS: { className: 'Project', useSQLite: true } }, bindings: { AUTH_CREDENTIALS: JSON.stringify(credentials) }, host: '127.0.0.1', port: 0 }));
  const baseUrl = (await runtime.ready).toString();
  const cli = resolve('apps/setup/index.ts');

  const run = (arg: string, role = 'human', url = baseUrl) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveRun, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', cli, arg], { env: { ...process.env, WORKSPACE_BASE_URL: url, WORKSPACE_PROJECT_ID: projectId, WORKSPACE_TOKEN: `synthetic-${role}` }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let stdout = '', stderr = '', settled = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.stdout.setEncoding('utf8').on('data', chunk => stdout += chunk); child.stderr.setEncoding('utf8').on('data', chunk => stderr += chunk);
    child.once('error', error => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
    child.once('close', code => { children.delete(child); clearTimeout(timer); if (!settled) { settled = true; resolveRun({ code, stdout, stderr }); } });
  });
  const input = JSON.stringify({ requestId: 'seed-demo', commitOid, treeOid });
  const observer = new WorkspaceClient({ baseUrl, projectId, token: 'synthetic-human', maxRequests: 20, deadline: 10_000 });
  const eventsBeforeInvalid = await observer.events({ limit: 100 });
  for (const invalid of [
    JSON.stringify({ requestId: 'invalid-backend', commitOid, treeOid, sourceBackend: 'remote' }),
    JSON.stringify({ requestId: 'extra-key', commitOid, treeOid, unexpected: true }),
  ]) {
    const rejected = await run(invalid); expect(rejected.code).toBe(1);
  }
  expect(await observer.events({ limit: 100 })).toEqual(eventsBeforeInvalid);
  const contributor = await run(input, 'contributor');
  expect(contributor.code).toBe(1); expect(contributor.stderr).toContain('FORBIDDEN');
  expect(contributor.stderr).not.toContain('synthetic-contributor');
  const first = await run(input); expect(first.code).toBe(0); expect(first.stderr).toBe('');
  const result = JSON.parse(first.stdout);
  expect(result).toMatchObject({ mode: 'local-only', contractVersion: 1, policyVersion: 1, status: 'pending-seed-publication', commitOid, treeOid });
  expect(result.pendingSeedJobId).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(result.note).toContain('No code was executed');
  const client = new WorkspaceClient({ baseUrl, projectId, token: 'synthetic-human', maxRequests: 20, deadline: 10_000 });
  const persistedContract = (await client.contract(1) as { data: { outcome: string; constraints: string[]; obligations: {id:string}[]; requiredCheckIds: string[] } }).data;
  expect(persistedContract.outcome).toContain('approved demo');
  expect(persistedContract.obligations.map(x => x.id)).toEqual(['legacy-response','pagination-order','cursor-validation','tenant-isolation','ui-navigation','ui-tenant-switch']);
  expect(persistedContract.requiredCheckIds).toEqual(['mandatory-demo-api','mandatory-demo-ui']);
  expect(persistedContract.constraints).toContain('Use the mandatory local API and UI demo suites; preserve tenant isolation.');
  expect((await client.policy())?.data).toMatchObject({ contractVersion: 1, harnessVersion: 'json-oracle-v1', requireIndependentReview: true, sourceBackend: 'local-git', checks: [{id:'mandatory-demo-api',obligationIds:['legacy-response','pagination-order','cursor-validation','tenant-isolation']},{id:'mandatory-demo-ui',obligationIds:['ui-navigation','ui-tenant-switch']}] });
  const eventsBeforeBackendMismatch = await client.events({ limit: 100 });
  const mismatch = await run(JSON.stringify({ requestId: 'seed-demo', commitOid, treeOid, sourceBackend: 'artifacts-git' }));
  expect(mismatch.code).toBe(1); expect(mismatch.stderr).toContain('incompatible preexisting policy');
  expect(await client.events({ limit: 100 })).toEqual(eventsBeforeBackendMismatch);
  expect(await client.baseline()).toBeNull();
  const runnerClient = new WorkspaceClient({ baseUrl, projectId, token: 'synthetic-runner', maxRequests: 20, deadline: 10_000 });
  const persistedJob = await runnerClient.sourceJob(result.pendingSeedJobId);
  expect(persistedJob.data).toMatchObject({ status: 'queued', input: { kind: 'seed', source: { commitOid, treeOid } } });
  expect(await run(input)).toMatchObject({ code: 0, stdout: first.stdout });
  const changed = await run(JSON.stringify({ requestId: 'seed-demo', commitOid: '1'.repeat(40), treeOid }));
  expect(changed.code).toBe(1); expect(changed.stderr).toContain('CONFLICT');
  const bad = await run('{"requestId":"bad","commitOid":"oops","treeOid":"bad"}');
  expect(bad.code).toBe(1); expect(bad.stderr).toContain('Invalid');
  const malformed = await run(JSON.stringify({ requestId: 'bad extra', commitOid, treeOid }));
  expect(malformed.code).toBe(1); expect(malformed.stderr).toContain('requestId');
  const remote = await run(input, 'human', 'http://example.com');
  expect(remote.code).toBe(1); expect(remote.stderr).toContain('loopback');
  const help = await new Promise<string>((resolveHelp, reject) => { const child = spawn(process.execPath, ['--import', 'tsx', cli, '--help'], { env: { ...process.env, WORKSPACE_TOKEN: '', WORKSPACE_BASE_URL: '', WORKSPACE_PROJECT_ID: '' }, stdio: ['ignore', 'pipe', 'pipe'] }); let out = ''; child.stdout.setEncoding('utf8').on('data', chunk => out += chunk); child.once('error', reject); child.once('close', code => code === 0 ? resolveHelp(out) : reject(new Error('help failed'))); });
  expect(help).toContain('Local loopback only');
}, 60_000);
