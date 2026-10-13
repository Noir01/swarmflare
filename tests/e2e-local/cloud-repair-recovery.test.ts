import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  view: vi.fn(), baseline: vi.fn(), revision: vi.fn(), finding: vi.fn(), createView: vi.fn(),
  sourceJob: vi.fn(), runSourceJob: vi.fn(), readSourceReceipt: vi.fn(),
}));
vi.mock('../../packages/client/index.js', () => ({ WorkspaceClient: class {
  view = mocks.view; baseline = mocks.baseline; revision = mocks.revision; finding = mocks.finding; createView = mocks.createView; sourceJob = mocks.sourceJob;
} }));
vi.mock('../../packages/local-runner/index.js', () => ({ runSourceJob: mocks.runSourceJob }));
vi.mock('../../packages/git-runner/index.js', () => ({ readSourceReceipt: mocks.readSourceReceipt }));

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRepairConfig, runPhase } from '../../demo/cloud/repair.js';

const receipt = { backend: 'artifacts-git', ref: 'refs/agent/views/replacement', commitOid: 'c'.repeat(40), treeOid: 't'.repeat(40) };
const localReceipt = { ...receipt, backend: 'local-git' };
const base = { version: 1, commitOid: 'b'.repeat(40), treeOid: 'u'.repeat(40), receipt: { backend: 'artifacts-git', ref: 'refs/agent/baseline', commitOid: 'b'.repeat(40), treeOid: 'u'.repeat(40) } };
const originalManifest = { baseVersion: 1, baseCommitOid: base.commitOid, contractVersion: 1, policyVersion: 1, orderedRevisions: [{ changeId: 'change_old', revisionId: 'revision_old' }], excludedChangeIds: [], decisionRevisions: [], compositionVersion: 1 };
const replacementManifest = { ...originalManifest, orderedRevisions: [{ changeId: 'change_old', revisionId: 'revision_old' }, { changeId: 'change_repair', revisionId: 'revision_repair' }] };
const original = { id: 'view_original', data: { manifest: originalManifest } };
const created = { id: 'view_replacement', data: { manifest: replacementManifest, jobId: 'job_replacement' } };
const completedJob = { data: { status: 'completed', input: { kind: 'composition', viewId: created.id, manifest: replacementManifest, revisions: replacementManifest.orderedRevisions }, receipt } };
let scratch: string;
const config = () => parseRepairConfig(JSON.stringify({ baseUrl: 'https://git-collaboration-demo-c29.sriva140.workers.dev', projectId: 'project', runnerToken: 'runner', contributorToken: 'contributor', seedRepository: '/tmp/seed', revisionRepository: '/tmp/revision', remote: '/tmp/remote.git', workspaceRoot: '/tmp/work', receiptPath: join(scratch, 'receipt.json'), approvedOrigin: 'https://git-collaboration-demo-c29.sriva140.workers.dev', repairRepository: '/tmp/repair', findingId: 'finding', originalViewId: original.id, repairChangeId: 'change_repair', repairRevisionId: 'revision_repair' }));

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'cloud-repair-recovery-'));
  vi.clearAllMocks();
  mocks.view.mockImplementation(async (id: string) => id === original.id ? original : { id, data: { status: 'runnable', receipt } });
  mocks.baseline.mockResolvedValue(base);
  mocks.revision.mockResolvedValue({ data: { changeId: 'change_repair', status: 'published' } });
  mocks.finding.mockResolvedValue({ data: { repairs: [{ changeId: 'change_repair', revisionId: 'revision_repair' }] } });
  mocks.createView.mockResolvedValue(created);
  mocks.sourceJob.mockResolvedValue(completedJob);
  mocks.readSourceReceipt.mockResolvedValue(localReceipt);
});
afterEach(async () => { await rm(scratch, { recursive: true, force: true }); });

it('recovers an expired replacement lease against the CREATED two-revision manifest and persists exact readbacks', async () => {
  mocks.sourceJob.mockResolvedValueOnce({ data: { ...completedJob.data, status: 'leased', leaseExpiresAt: Date.now() - 1 } }).mockResolvedValueOnce(completedJob);
  mocks.runSourceJob.mockImplementation(async (_client: unknown, options: { requestId: string }) => ({ options }));
  await runPhase('compose', config());
  expect(mocks.createView).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'cloud-repair-view', payload: replacementManifest }));
  expect(mocks.runSourceJob).toHaveBeenCalledTimes(1);
  expect(mocks.runSourceJob.mock.calls[0]![1].requestId).toMatch(/^cloud-repair-compose-/);
  expect(mocks.sourceJob).toHaveBeenCalledTimes(2);
  expect(mocks.readSourceReceipt).toHaveBeenCalledWith('/tmp/remote.git', receipt.ref);
  const { readFile } = await import('node:fs/promises');
  const saved = JSON.parse(await readFile(join(scratch, 'receipt.json'), 'utf8'));
  expect(saved.replacementViewId).toBe(created.id);
  expect(saved.receipt).toEqual(receipt);
  expect(saved.localCacheReceipt).toEqual(localReceipt);
  expect(saved.baseline).toEqual({ version: base.version, commitOid: base.commitOid, treeOid: base.treeOid, ref: base.receipt.ref });
  expect(mocks.baseline).toHaveBeenCalledTimes(2);
});

it.each([
  ['active lease', () => ({ data: { ...completedJob.data, status: 'leased', leaseExpiresAt: Date.now() + 60_000 } })],
  ['wrong manifest', () => ({ data: { ...completedJob.data, status: 'queued', input: { ...completedJob.data.input, manifest: originalManifest } } })],
  ['wrong revision tuple', () => ({ data: { ...completedJob.data, status: 'queued', input: { ...completedJob.data.input, revisions: originalManifest.orderedRevisions } } })],
])('rejects %s without invoking the source runner', async (_label, job) => {
  mocks.sourceJob.mockResolvedValue(job());
  await expect(runPhase('compose', config())).rejects.toThrow();
  expect(mocks.runSourceJob).not.toHaveBeenCalled();
});

it('accepts exact completed readback without a runner call and uses the stable create idempotency key', async () => {
  await runPhase('compose', config());
  expect(mocks.runSourceJob).not.toHaveBeenCalled();
  expect(mocks.createView).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'cloud-repair-view' }));
});
