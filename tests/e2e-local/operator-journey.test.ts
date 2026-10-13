import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startLocalWorkspace } from '../../apps/local/index';
import { WorkspaceClient } from '../../packages/client/index';

const execFileAsync = promisify(execFile);
const tsx = resolve('node_modules/tsx/dist/cli.mjs');
const setup = resolve('apps/setup/index.ts');
const runner = resolve('apps/runner/index.ts');
const cli = resolve('apps/cli/index.ts');
const projectId = 'operator-journey';
const identities = {
  human: { id: 'demo-human', role: 'human', token: 'synthetic-human-operator-token' },
  contributor: { id: 'demo-contributor', role: 'contributor', token: 'synthetic-contributor-token' },
  runner: { id: 'demo-runner', role: 'runner', token: 'synthetic-runner-token' },
} as const;
const git = async (cwd: string, ...args: string[]) => (await execFileAsync('git', ['-C', cwd, ...args], { timeout: 10_000 })).stdout.trim();

async function child(entry: string, args: string[], baseUrl: string, identity: typeof identities[keyof typeof identities]) {
  const { stdout, stderr } = await execFileAsync(process.execPath, [tsx, entry, ...args], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, WORKSPACE_BASE_URL: baseUrl, WORKSPACE_PROJECT_ID: projectId, WORKSPACE_TOKEN: identity.token },
  });
  expect(stderr).toBe('');
  return JSON.parse(stdout.trim());
}

it('proves the bounded local setup, seed, contributor publication, and exact readback journey', async () => {
  const root = await mkdtemp(join(tmpdir(), 'operator-journey-'));
  let app: Awaited<ReturnType<typeof startLocalWorkspace>> | undefined;
  try {
    const authCredentials = JSON.stringify(Object.values(identities).map(({ id, role, token }) => ({
      id, role, projectId, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: Date.now() + 180_000,
    })));
    app = await startLocalWorkspace({ stateDirectory: join(root, 'state'), authCredentials, dashboardSessionKey: 'a'.repeat(64), runBudgetMs: 150_000 });

    const seed = join(process.cwd(), 'demo/seed/index.ts');
    const seedRepo = join(root, 'seed');
    const remote = join(root, 'remote.git');
    const workspaceRoot = join(root, 'work');
    await mkdir(seedRepo);
    await mkdir(workspaceRoot);
    await execFileAsync('git', ['init', '-q', seedRepo]);
    await git(seedRepo, 'config', 'user.name', 'Synthetic Seed Author');
    await git(seedRepo, 'config', 'user.email', 'seed@example.invalid');
    await mkdir(join(seedRepo, 'demo', 'seed'), { recursive: true });
    await writeFile(join(seedRepo, 'demo', 'seed', 'index.ts'), await (await import('node:fs/promises')).readFile(seed, 'utf8'));
    await git(seedRepo, 'add', 'demo/seed/index.ts');
    await git(seedRepo, 'commit', '-qm', 'seed from demo/seed/index.ts');
    await execFileAsync('git', ['init', '--bare', '-q', remote]);
    const baseCommit = await git(seedRepo, 'rev-parse', 'HEAD');
    const baseTree = await git(seedRepo, 'rev-parse', 'HEAD^{tree}');

    const setupResult = await child(setup, [JSON.stringify({ requestId: 'operator-setup', commitOid: baseCommit, treeOid: baseTree })], app.url, identities.human);
    expect(setupResult).toMatchObject({ mode: 'local-only', contractVersion: 1, policyVersion: 1, status: 'pending-seed-publication', commitOid: baseCommit, treeOid: baseTree });
    const contributor = identities.contributor;
    const humanApi = new WorkspaceClient({ baseUrl: app.url, projectId, token: identities.human.token });
    const contributorApi = new WorkspaceClient({ baseUrl: app.url, projectId, token: contributor.token });
    const runnerApi = new WorkspaceClient({ baseUrl: app.url, projectId, token: identities.runner.token });
    const metadata = await humanApi.contract(1) as any;
    expect(metadata.data.obligations.map((x: { id: string }) => x.id)).toEqual(['legacy-response', 'pagination-order', 'cursor-validation', 'tenant-isolation', 'ui-navigation', 'ui-tenant-switch']);
    expect((await humanApi.policy())?.version).toBe(1);
    expect(await humanApi.baseline()).toBeNull();

    const seedOutput = await child(runner, ['source-job', JSON.stringify({ remote, workspaceRoot, seedRepository: seedRepo, repositories: {}, requestId: 'operator-seed' })], app.url, identities.runner);
    expect(seedOutput.data.status).toBe('completed');
    const seedJobId = setupResult.pendingSeedJobId as string;
    const seedJob = await child(cli, ['source-job', JSON.stringify({ id: seedJobId })], app.url, identities.runner);
    expect(seedJob.data.status).toBe('completed');
    expect(seedJob.data.input.kind).toBe('seed');
    if (seedJob.data.input.kind !== 'seed' || !seedJob.data.receipt) throw new Error('completed seed job is missing its seed receipt');
    const seedReceipt = seedJob.data.receipt;
    expect(seedReceipt).toMatchObject({ backend: 'local-git', commitOid: baseCommit, treeOid: baseTree, ref: `refs/agent/seeds/${seedJob.data.input.seedId}` });
    const baseline = await child(cli, ['baseline'], app.url, identities.human);
    expect(baseline).toMatchObject({ version: 1, commitOid: baseCommit, treeOid: baseTree, receipt: seedReceipt });
    expect(await git(remote, 'rev-parse', seedReceipt.ref)).toBe(baseCommit);
    expect(await git(remote, 'rev-parse', `${seedReceipt.ref}^{tree}`)).toBe(baseTree);
    expect(await git(remote, 'show', `${seedReceipt.ref}:demo/seed/index.ts`)).toContain('export const projects');

    const context = await child(cli, ['context'], app.url, contributor);
    expect(context.contract.data.obligations).toHaveLength(6);
    expect(context.baseline).toEqual({ version: 1, commitOid: baseCommit });
    const claim = await child(cli, ['claim', JSON.stringify({ requestId: 'operator-claim', payload: { obligationIds: ['legacy-response'], areas: ['demo/seed/index.ts'], status: 'working' } })], app.url, contributor);
    expect(claim.owner).toBe(contributor.id);

    const branch = join(root, 'contributor');
    await execFileAsync('git', ['clone', '-q', seedRepo, branch]);
    await git(branch, 'config', 'user.name', 'Synthetic Contributor');
    await git(branch, 'config', 'user.email', 'contributor@example.invalid');
    await writeFile(join(branch, 'operator-journey.txt'), 'synthetic contributor publication\n');
    await git(branch, 'add', 'operator-journey.txt');
    await git(branch, 'commit', '-qm', 'publish operator journey change');
    const commitOid = await git(branch, 'rev-parse', 'HEAD');
    const treeOid = await git(branch, 'rev-parse', 'HEAD^{tree}');
    const change = await child(cli, ['change-create', JSON.stringify({ requestId: 'operator-change', payload: { title: 'Operator journey source publication', obligationIds: ['legacy-response'] } })], app.url, contributor);
    const revision = await child(cli, ['revision-publish', JSON.stringify({ id: change.id, mutation: { requestId: 'operator-revision', payload: { baseCommitOid: baseCommit, commitOid, treeOid, obligationIds: ['legacy-response'], decisionRevisions: [], dependencies: [] } } })], app.url, contributor);
    expect(revision.data.status).toBe('reserved');

    const publication = await child(runner, ['source-job', JSON.stringify({ remote, workspaceRoot, seedRepository: seedRepo, repositories: { [contributor.id]: branch }, requestId: 'operator-publication' })], app.url, identities.runner);
    expect(publication.data.status).toBe('completed');
    const changeReadback = await child(cli, ['change', JSON.stringify({ id: change.id })], app.url, contributor);
    const revisionReadback = await child(cli, ['revision', JSON.stringify({ id: revision.id })], app.url, contributor);
    const ref = `refs/agent/revisions/${change.id}/${revision.id}`;
    expect(changeReadback.data.latestRevisionId).toBe(revision.id);
    expect(revisionReadback.data).toMatchObject({ status: 'published', receipt: { backend: 'local-git', ref, commitOid, treeOid } });
    expect(await git(remote, 'rev-parse', ref)).toBe(commitOid);
    expect(await git(remote, 'rev-parse', `${ref}^{tree}`)).toBe(treeOid);
    expect(await git(remote, 'show', `${ref}:operator-journey.txt`)).toBe('synthetic contributor publication');
    expect(await runnerApi.sourceJob(revisionReadback.data.jobId)).toMatchObject({ data: { status: 'completed', receipt: revisionReadback.data.receipt } });
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
