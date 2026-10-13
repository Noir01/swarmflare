import { expect, it } from 'vitest';
import { acceptanceFixture } from './acceptance-fixture';
import { sourceRef } from '../../packages/contracts/source';

// Source and check receipts are synthetic emulator metadata, not execution evidence.
async function completed(f: Awaited<ReturnType<typeof acceptanceFixture>>, commit: string, tree: string) {
  const job = await f.ok('runner', '/runner/claim', { leaseSeconds: 120 });
  const receipt = { backend: 'local-git', commitOid: commit, treeOid: tree, ref: sourceRef(job.data.input) };
  await f.ok('runner', `/runner/jobs/${job.id}/complete`, { attemptId: job.data.attemptId, ok: true, receipt });
  return receipt;
}

async function createIntegration(f: Awaited<ReturnType<typeof acceptanceFixture>>, opts: {
  base?: string; dependencies?: Array<{ changeId: string; revisionId: string }>;
  obligations?: string[]; owner?: 'alice' | 'otherHuman'; publish?: boolean;
} = {}) {
  const change = await f.ok(opts.owner ?? 'alice', '/changes', { title: 'Separate integration repair', obligationIds: ['obligation'] });
  const revisionResponse = await f.request(opts.owner ?? 'alice', `/changes/${change.id}/revisions`, {
    baseCommitOid: opts.base ?? f.view.data.receipt.commitOid,
    commitOid: '7'.repeat(40), treeOid: '8'.repeat(40),
    obligationIds: opts.obligations ?? ['obligation'], decisionRevisions: [],
    dependencies: opts.dependencies ?? [{ changeId: f.change.id, revisionId: f.revision.id }],
  });
  if (revisionResponse.status !== 201) throw new Error(`integration revision creation failed (${revisionResponse.status}): ${JSON.stringify(revisionResponse.body)}`);
  const revision = revisionResponse.body.resource;
  if (opts.publish === false) return { change, revision, creationStatus: revisionResponse.status };
  await completed(f, '7'.repeat(40), '8'.repeat(40));
  return { change, revision };
}

async function finding(f: Awaited<ReturnType<typeof acceptanceFixture>>) {
  return f.ok('reviewer', '/findings', f.finding);
}

it('links separately authored integration work and requires a fresh full-composed closure to resolve', async () => {
  const f = await acceptanceFixture();
  const second = await f.ok('alice', '/changes', { title: 'Second selected contribution', obligationIds: ['obligation'] });
  const secondRevision = await f.ok('alice', `/changes/${second.id}/revisions`, {
    baseCommitOid: f.baseline.commitOid, commitOid: '1'.repeat(40), treeOid: '2'.repeat(40),
    obligationIds: ['obligation'], decisionRevisions: [], dependencies: [],
  });
  await completed(f, '1'.repeat(40), '2'.repeat(40));
  const twoManifest = { ...f.manifest, orderedRevisions: [...f.manifest.orderedRevisions, { changeId: second.id, revisionId: secondRevision.id }], excludedChangeIds: [] };
  const twoQueued = await f.ok('alice', '/views', twoManifest);
  const twoReceipt = await completed(f, '9'.repeat(40), 'a'.repeat(40));
  const twoView = await f.ok('human', `/views/${twoQueued.id}`);
  const findingResource = await f.ok('reviewer', '/findings', { ...f.finding, viewId: twoView.id, manifestDigest: twoView.data.manifestDigest, composedCommitOid: twoReceipt.commitOid, treeOid: twoReceipt.treeOid, affectedChangeIds: [f.change.id], nextOwner: 'alice' });
  const { change, revision } = await createIntegration(f, { base: twoReceipt.commitOid, dependencies: [{ changeId: f.change.id, revisionId: f.revision.id }, { changeId: second.id, revisionId: secondRevision.id }] });
  const repair = await f.request('alice', `/findings/${findingResource.id}/repair`, {
    revisions: [{ changeId: change.id, revisionId: revision.id }],
  }, findingResource.version);
  expect(repair.status, JSON.stringify(repair.body)).toBe(201);
  const linked = repair.body.resource;
  expect(linked.data).toMatchObject({ status: 'repair-proposed', repairs: [{ changeId: change.id, revisionId: revision.id }] });

  const manifest = {
    ...twoManifest,
    orderedRevisions: [...twoManifest.orderedRevisions, { changeId: change.id, revisionId: revision.id }],
    excludedChangeIds: [],
  };
  const queued = await f.ok('alice', '/views', manifest);
  const receipt = await completed(f, '9'.repeat(40), 'a'.repeat(40));
  const view = await f.ok('human', `/views/${queued.id}`);
  const applicability = {
    projectId: f.projectId, viewId: view.id, manifestDigest: view.data.manifestDigest,
    composedCommitOid: receipt.commitOid, treeOid: receipt.treeOid,
    contractVersion: 1, policyVersion: 1, checkSuiteDigest: f.policy.checkSuiteDigest,
  };
  await f.ok('runner', `/runner/views/${view.id}/checks`, {
    ...f.check, applicability,
    execution: { ...f.check.execution, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() },
  });
  const { projectId: _projectId, ...anchor } = applicability;
  await f.ok('reviewer', `/views/${view.id}/reviews`, {
    ...anchor, obligationIds: ['obligation'], summary: 'Synthetic independent review of integration closure', verdict: 'passed', findings: [],
  });

  const self = await f.request('alice', `/findings/${findingResource.id}/resolve`, { viewId: view.id, note: 'Own repair' });
  expect(self.status).toBe(403);
  const resolved = await f.request('reviewer', `/findings/${findingResource.id}/resolve`, { viewId: view.id, note: 'Fresh synthetic evidence for full repair closure' });
  expect(resolved.status, JSON.stringify(resolved.body)).toBe(201);
  expect(resolved.body.resource.data.resolutionEvidence).toMatchObject({ applicability, resolverId: 'reviewer' });
  const oldReadiness = await f.ok('human', `/views/${f.view.id}/readiness`);
  expect(oldReadiness.ready).toBe(false);
  expect(oldReadiness.findingIds).toContain(findingResource.id);
});

it.each([
  ['wrong base', { base: '6'.repeat(40) }],
  ['foreign owner', { owner: 'otherHuman' as const }],
  ['unpublished revision', { publish: false }],
] as const)('rejects a separate repair with %s without mutating the finding', async (_label, options) => {
  const f = await acceptanceFixture();
  const original = await finding(f);
  const { change, revision } = await createIntegration(f, options as Parameters<typeof createIntegration>[1]);
  const result = await f.request('alice', `/findings/${original.id}/repair`, {
    revisions: [{ changeId: change.id, revisionId: revision.id }],
  }, original.version);
  expect(result.status).toBe(422);
  expect(await f.ok('human', `/findings/${original.id}`)).toEqual(original);
});

it('rejects a selected non-affected Change and an offending original revision as repair links', async () => {
  const f = await acceptanceFixture();
  const original = await finding(f);
  const selected = await f.ok('alice', '/changes', { title: 'Selected but not affected', obligationIds: ['obligation'] });
  const selectedRevision = await f.ok('alice', `/changes/${selected.id}/revisions`, {
    baseCommitOid: f.baseline.commitOid, commitOid: '2'.repeat(40), treeOid: '3'.repeat(40),
    obligationIds: ['obligation'], decisionRevisions: [], dependencies: [],
  });
  await completed(f, '2'.repeat(40), '3'.repeat(40));
  const selectedView = await f.request('alice', `/findings/${original.id}/repair`, {
    revisions: [{ changeId: selected.id, revisionId: selectedRevision.id }],
  }, original.version);
  expect(selectedView.status).toBe(422);
  expect(await f.ok('human', `/findings/${original.id}`)).toEqual(original);

  const offending = await f.request('alice', `/findings/${original.id}/repair`, {
    revisions: [{ changeId: f.change.id, revisionId: f.revision.id }],
  }, original.version);
  expect(offending.status).toBe(422);
  expect(await f.ok('human', `/findings/${original.id}`)).toEqual(original);
});
