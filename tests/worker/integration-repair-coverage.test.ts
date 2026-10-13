import { expect, it } from 'vitest';
import { acceptanceFixture } from './acceptance-fixture';
import { sourceRef } from '../../packages/contracts/source';

// All receipts below are synthetic emulator metadata, not execution evidence.
async function complete(f: Awaited<ReturnType<typeof acceptanceFixture>>, commit: string, tree: string) {
  const job = await f.ok('runner', '/runner/claim', { leaseSeconds: 120 });
  const receipt = { backend: 'local-git', commitOid: commit, treeOid: tree, ref: sourceRef(job.data.input) };
  await f.ok('runner', `/runner/jobs/${job.id}/complete`, { attemptId: job.data.attemptId, ok: true, receipt });
  return receipt;
}

it('rejects a valid separate integration revision that omits an approved other obligation, while accepting full finding coverage', async () => {
  const f = await acceptanceFixture();
  const contract2 = await f.ok('human', '/contracts/proposals', {
    ...f.contract,
    obligations: [...f.contract.obligations, { id: 'other', description: 'Second approved fixture obligation', acceptanceExamples: [] }],
  });
  await f.ok('human', `/contracts/${contract2.id}/approve`, {}, 1);
  await f.ok('human', '/policy', {
    contractVersion: 2, checkSuiteDigest: 'd'.repeat(64), harnessVersion: 'json-oracle-v1',
    checks: [{ id: 'check', obligationIds: ['obligation', 'other'] }], requireIndependentReview: true, sourceBackend: 'local-git',
  }, 1);

  const otherChange = await f.ok('alice', '/changes', { title: 'Second approved obligation contribution', obligationIds: ['other'] });
  const otherRevision = await f.ok('alice', `/changes/${otherChange.id}/revisions`, {
    baseCommitOid: f.baseline.commitOid, commitOid: '1'.repeat(40), treeOid: '2'.repeat(40),
    obligationIds: ['other'], decisionRevisions: [], dependencies: [],
  });
  await complete(f, '1'.repeat(40), '2'.repeat(40));
  const manifest = {
    ...f.manifest, contractVersion: 2, policyVersion: 2,
    orderedRevisions: [...f.manifest.orderedRevisions, { changeId: otherChange.id, revisionId: otherRevision.id }], excludedChangeIds: [],
  };
  const queued = await f.ok('alice', '/views', manifest);
  const receipt = await complete(f, '9'.repeat(40), 'a'.repeat(40));
  const view = await f.ok('human', `/views/${queued.id}`);
  const original = await f.ok('reviewer', '/findings', {
    ...f.finding, viewId: view.id, manifestDigest: view.data.manifestDigest,
    composedCommitOid: receipt.commitOid, treeOid: receipt.treeOid,
    contractVersion: 2, policyVersion: 2, affectedChangeIds: [f.change.id], obligationIds: ['obligation'], nextOwner: 'alice',
  });
  const deps = [{ changeId: f.change.id, revisionId: f.revision.id }, { changeId: otherChange.id, revisionId: otherRevision.id }];

  const insufficient = await f.ok('alice', '/changes', { title: 'Integration omitting finding coverage', obligationIds: ['other'] });
  const insufficientRevision = await f.ok('alice', `/changes/${insufficient.id}/revisions`, {
    baseCommitOid: receipt.commitOid, commitOid: '3'.repeat(40), treeOid: '4'.repeat(40),
    obligationIds: ['other'], decisionRevisions: [], dependencies: deps,
  });
  await complete(f, '3'.repeat(40), '4'.repeat(40));
  const refused = await f.request('alice', `/findings/${original.id}/repair`, { revisions: [{ changeId: insufficient.id, revisionId: insufficientRevision.id }] }, original.version);
  expect(refused.status).toBe(422);
  expect(await f.ok('human', `/findings/${original.id}`)).toEqual(original);

  const sufficient = await f.ok('alice', '/changes', { title: 'Integration covering finding obligation', obligationIds: ['obligation'] });
  const sufficientRevision = await f.ok('alice', `/changes/${sufficient.id}/revisions`, {
    baseCommitOid: receipt.commitOid, commitOid: '5'.repeat(40), treeOid: '6'.repeat(40),
    obligationIds: ['obligation'], decisionRevisions: [], dependencies: deps,
  });
  await complete(f, '5'.repeat(40), '6'.repeat(40));
  const accepted = await f.request('alice', `/findings/${original.id}/repair`, { revisions: [{ changeId: sufficient.id, revisionId: sufficientRevision.id }] }, original.version);
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
});
