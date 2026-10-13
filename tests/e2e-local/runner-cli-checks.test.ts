import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLocalWorkspace } from '../../apps/local/index';
import { WorkspaceClient } from '../../packages/client/index';
import { runSourceJob } from '../../packages/local-runner/index';
import { readSourceReceipt } from '../../packages/git-runner/index';
import { mandatoryDemoSuiteDigest } from '../../packages/git-runner/checks/mandatory-demo-suite';
import { preparedPaginatedDemo } from '../fixtures/paginated-demo';

const execFileAsync = promisify(execFile);
const cli = join(process.cwd(), 'apps/runner/index.ts');
const token = 'synthetic-runner-cli-checks-token';
const projectId = 'runner-cli-checks';
async function invoke(command: string, input: Record<string, unknown>, baseUrl: string) {
  try {
    const r = await execFileAsync(process.execPath, ['--import', 'tsx', cli, command, JSON.stringify(input)], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, WORKSPACE_BASE_URL: baseUrl, WORKSPACE_PROJECT_ID: projectId, WORKSPACE_TOKEN: token },
    });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string; killed?: boolean };
    if (e.killed) throw new Error('runner CLI child exceeded 60000ms');
    return { code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}
const git = async (cwd: string, ...args: string[]) => (await execFileAsync('git', ['-C', cwd, ...args])).stdout.trim();

it('proves mandatory-checks and verify-source CLI behavior against real local Git and API state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runner-cli-checks-'));
  let app: Awaited<ReturnType<typeof startLocalWorkspace>> | undefined;
  try {
    const roles = ['human', 'author', 'runner'];
    const authCredentials = JSON.stringify(roles.map(role => ({ id: role, projectId, role: role === 'author' ? 'contributor' : role, tokenHash: createHash('sha256').update(role === 'runner' ? token : `synthetic-${role}`).digest('hex'), expiresAt: Date.now() + 300_000 })));
    app = await startLocalWorkspace({ stateDirectory: join(root, 'state'), authCredentials, dashboardSessionKey: 'd'.repeat(64), runBudgetMs: 60_000 });
    const client = (role: string, secret = `synthetic-${role}`) => new WorkspaceClient({ baseUrl: app!.url, projectId, token: secret, maxRequests: 150, deadline: 60_000 });
    const human = client('human'), author = client('author'), runner = client('runner', token);
    const source = join(root, 'source'), remote = join(root, 'remote.git'), work = join(root, 'work');
    await mkdir(source); await mkdir(work); await execFileAsync('git', ['init', '-q', source]); await execFileAsync('git', ['init', '--bare', '-q', remote]);
    await git(source, 'config', 'user.name', 'Synthetic CLI Test'); await git(source, 'config', 'user.email', 'cli@example.invalid');
    await writeFile(join(source, 'baseline.txt'), 'baseline\n'); await git(source, 'add', '.'); await git(source, 'commit', '-qm', 'baseline');
    const baseCommitOid = await git(source, 'rev-parse', 'HEAD'), baseTreeOid = await git(source, 'rev-parse', 'HEAD^{tree}');
    const api = ['legacy-response', 'pagination-order', 'cursor-validation', 'tenant-isolation'];
    const ui = ['ui-navigation', 'ui-tenant-switch'];
    const obligations = [...api, ...ui];
    const proposal = await human.createProposal({ requestId: 'proposal', payload: { outcome: 'CLI mandatory demo checks', constraints: [], obligations: obligations.map(id => ({ id, description: id, acceptanceExamples: [] })), requiredCheckIds: ['mandatory-demo-api', 'mandatory-demo-ui'], unresolvedQuestions: [] } }) as { id: string };
    await human.approveProposal(proposal.id, { requestId: 'approve', expectedVersion: 0, payload: {} });
    await human.configurePolicy({ requestId: 'policy', expectedVersion: 0, payload: { contractVersion: 1, checkSuiteDigest: mandatoryDemoSuiteDigest(), harnessVersion: 'json-oracle-v1', checks: [{ id: 'mandatory-demo-api', obligationIds: api }, { id: 'mandatory-demo-ui', obligationIds: ui }], requireIndependentReview: true, sourceBackend: 'local-git' } });
    const baseline = await human.initializeBaseline({ requestId: 'baseline', expectedVersion: 0, payload: { commitOid: baseCommitOid, treeOid: baseTreeOid } });
    expect(baseline.data.input.kind).toBe('seed');
    await runSourceJob(runner, { remote, workspaceRoot: work, resolveRepository: () => source, requestId: 'seed-source' });

    // Publish the original demo seed and compose a real View through the source job.
    const change = await author.createChange({ requestId: 'original-change', payload: { title: 'Original demo seed', obligationIds: obligations } });
    await mkdir(join(source, 'demo/seed'), { recursive: true });
    await writeFile(join(source, 'demo/seed/index.ts'), 'export const original = true;\n');
    await git(source, 'add', '.'); await git(source, 'commit', '-qm', 'original approved demo source');
    const originalCommit = await git(source, 'rev-parse', 'HEAD'), originalTree = await git(source, 'rev-parse', 'HEAD^{tree}');
    const revision = await author.publishRevision(change.id, { requestId: 'original-revision', payload: { baseCommitOid, commitOid: originalCommit, treeOid: originalTree, obligationIds: obligations, decisionRevisions: [], dependencies: [] } });
    await runSourceJob(runner, { remote, workspaceRoot: work, resolveRepository: () => source, requestId: 'original-publish' });
    const view = await author.createView({ requestId: 'original-view', payload: { baseVersion: 1, baseCommitOid, contractVersion: 1, policyVersion: 1, orderedRevisions: [{ changeId: change.id, revisionId: revision.id }], excludedChangeIds: [], decisionRevisions: [], compositionVersion: 1 } });
    await runSourceJob(runner, { remote, workspaceRoot: work, resolveRepository: () => remote, requestId: 'original-compose' });
    const viewResource = await human.view(view.id), composed = await readSourceReceipt(remote, viewResource.data.receipt!.ref);

    // The actual prepared demo passes both mandatory suites via the CLI.
    await git(source, 'checkout', '-q', '--detach', baseCommitOid); await git(source, 'checkout', '-qb', 'prepared-demo');
    await mkdir(join(source, 'demo/seed'), { recursive: true }); await writeFile(join(source, 'demo/seed/index.ts'), preparedPaginatedDemo);
    await git(source, 'add', '.'); await git(source, 'commit', '-qm', 'prepared paginated demo');
    const preparedCommit = await git(source, 'rev-parse', 'HEAD'), preparedTree = await git(source, 'rev-parse', 'HEAD^{tree}');
    const preparedRevision = await author.publishRevision(change.id, { requestId: 'prepared-revision', payload: { baseCommitOid, commitOid: preparedCommit, treeOid: preparedTree, obligationIds: obligations, decisionRevisions: [], dependencies: [] } });
    await runSourceJob(runner, { remote, workspaceRoot: work, resolveRepository: () => source, requestId: 'prepared-publish' });
    const preparedView = await author.createView({ requestId: 'prepared-view', payload: { baseVersion: 1, baseCommitOid, contractVersion: 1, policyVersion: 1, orderedRevisions: [{ changeId: change.id, revisionId: preparedRevision.id }], excludedChangeIds: [], decisionRevisions: [], compositionVersion: 1 } });
    await runSourceJob(runner, { remote, workspaceRoot: work, resolveRepository: () => remote, requestId: 'prepared-compose' });
    const preparedResource = await human.view(preparedView.id), preparedReceipt = await readSourceReceipt(remote, preparedResource.data.receipt!.ref);
    const cliBase = { remote, workspaceRoot: work };
    const passed = await invoke('mandatory-checks', { ...cliBase, viewId: preparedView.id, requestId: 'cli-passed' }, app.url);
    expect(passed.code, `${passed.stdout} ${passed.stderr}`).toBe(0);
    const cliChecks = JSON.parse(passed.stdout);
    expect(cliChecks).toHaveLength(2);
    expect(cliChecks.map((c: any) => c.data.result)).toEqual(['passed', 'passed']);
    expect(cliChecks.every((c: any) => c.data.applicability.checkSuiteDigest === mandatoryDemoSuiteDigest() && c.data.applicability.composedCommitOid === preparedReceipt.commitOid && c.data.applicability.treeOid === preparedReceipt.treeOid)).toBe(true);
    expect(await human.checks(preparedView.id)).toEqual(cliChecks);

    // Original demo must fail and persist failed receipts without moving baseline.
    const before = await human.baseline();
    const failed = await invoke('mandatory-checks', { ...cliBase, viewId: view.id, requestId: 'cli-failed' }, app.url);
    expect(failed.code).not.toBe(0);
    const failureRecords = JSON.parse(failed.stdout);
    expect(failureRecords).toHaveLength(2);
    expect(failureRecords.every((c: any) => c.data.result === 'failed' && c.data.applicability.composedCommitOid === composed.commitOid && c.data.applicability.treeOid === composed.treeOid)).toBe(true);
    expect(await human.checks(view.id)).toEqual(failureRecords);
    expect(await human.baseline()).toEqual(before);

    // CLI source receipt must equal the actual Git receipt and persisted verification resource.
    const verified = await invoke('verify-source', { remote, viewId: preparedView.id, requestId: 'cli-verify' }, app.url);
    expect(verified.code).toBe(0);
    const verification = JSON.parse(verified.stdout);
    expect(verification.data.receipt).toEqual(await readSourceReceipt(remote, preparedResource.data.receipt!.ref));
    const verificationResource = await human.sourceVerification(preparedView.id);
    expect(verificationResource).toEqual(verification);

    // Removing the referenced View ref makes verification fail; it cannot accept the View.
    await git(remote, 'update-ref', '-d', preparedResource.data.receipt!.ref);
    const missing = await invoke('verify-source', { remote, viewId: preparedView.id, requestId: 'cli-missing-ref' }, app.url);
    expect(missing.code).not.toBe(0);
    expect(await human.baseline()).toEqual(before);
    expect((await human.view(preparedView.id)).data.status).not.toBe('accepted');
    for (const result of [passed, failed, verified, missing]) { expect(result.stdout).not.toContain(token); expect(result.stderr).not.toContain(token); }
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
