import { expect, it } from 'vitest';
import { acceptanceFixture } from './acceptance-fixture';
import { sourceRef } from '../../packages/contracts/source';

// Emulator source receipts are synthetic metadata, not execution evidence.
async function complete(f: Awaited<ReturnType<typeof acceptanceFixture>>, commit: string, tree: string) {
  const job = await f.ok('runner', '/runner/claim', { leaseSeconds: 120 });
  const receipt = { backend: 'local-git', commitOid: commit, treeOid: tree, ref: sourceRef(job.data.input) };
  await f.ok('runner', `/runner/jobs/${job.id}/complete`, { attemptId: job.data.attemptId, ok: true, receipt });
  return receipt;
}

it('rejects separate repair dependency/base/coverage mismatches after valid publication, preserving the finding', async () => {
  for (const mismatch of ['wrong-base', 'missing-dependency', 'extra-dependency', 'wrong-pin'] as const) {
    const f = await acceptanceFixture();

    const secondChange = await f.ok('alice', '/changes', { title: 'Second selected fixture contribution', obligationIds: ['obligation'] });
    const secondRevision = await f.ok('alice', `/changes/${secondChange.id}/revisions`, {
      baseCommitOid: f.baseline.commitOid, commitOid: '1'.repeat(40), treeOid: '2'.repeat(40),
      obligationIds: ['obligation'], decisionRevisions: [], dependencies: [],
    });
    await complete(f, '1'.repeat(40), '2'.repeat(40));

    const twoManifest = { ...f.manifest, orderedRevisions: [...f.manifest.orderedRevisions, { changeId: secondChange.id, revisionId: secondRevision.id }], excludedChangeIds: [] };
    const twoQueued = await f.ok('alice', '/views', twoManifest);
    const twoReceipt = await complete(f, '9'.repeat(40), 'a'.repeat(40));
    const twoView = await f.ok('human', `/views/${twoQueued.id}`);
    const original = await f.ok('reviewer', '/findings', { ...f.finding, viewId: twoView.id, manifestDigest: twoView.data.manifestDigest, composedCommitOid: twoReceipt.commitOid, treeOid: twoReceipt.treeOid, affectedChangeIds: [f.change.id], nextOwner: 'alice' });
    const dependencies = [
      { changeId: f.change.id, revisionId: f.revision.id },
      { changeId: secondChange.id, revisionId: secondRevision.id },
    ];
    let actualDependencies = dependencies;
    if (mismatch === 'extra-dependency') {
      const third = await f.ok('alice', '/changes', { title: 'Third selected contribution', obligationIds: ['obligation'] });
      const thirdRevision = await f.ok('alice', `/changes/${third.id}/revisions`, { baseCommitOid: f.baseline.commitOid, commitOid: '5'.repeat(40), treeOid: '6'.repeat(40), obligationIds: ['obligation'], decisionRevisions: [], dependencies: [] });
      await complete(f, '5'.repeat(40), '6'.repeat(40));
      actualDependencies = [...dependencies, { changeId: third.id, revisionId: thirdRevision.id }];
    } else if (mismatch === 'wrong-pin') {
      const newerA = await f.ok('alice', `/changes/${f.change.id}/revisions`, { baseCommitOid: f.baseline.commitOid, commitOid: '5'.repeat(40), treeOid: '6'.repeat(40), obligationIds: ['obligation'], decisionRevisions: [], dependencies: [] });
      await complete(f, '5'.repeat(40), '6'.repeat(40));
      actualDependencies = [{ changeId: f.change.id, revisionId: newerA.id }, dependencies[1]!];
    }
    const altered = mismatch === 'missing-dependency' ? dependencies.slice(0, 1)
      : actualDependencies
    const badChange = await f.ok('alice', '/changes', { title: `Integration ${mismatch}`, obligationIds: ['obligation'] });
    const created = await f.request('alice', `/changes/${badChange.id}/revisions`, {
      baseCommitOid: mismatch === 'wrong-base' ? '6'.repeat(40) : twoReceipt.commitOid,
      commitOid: '3'.repeat(40), treeOid: '4'.repeat(40),
      obligationIds: ['obligation'], decisionRevisions: [], dependencies: altered,
    });
    expect(created.status, `${mismatch} must be validly published as a revision`).toBe(201);
    const revision = created.body.resource;
    await complete(f, '3'.repeat(40), '4'.repeat(40));
    const refused = await f.request('alice', `/findings/${original.id}/repair`, {
      revisions: [{ changeId: badChange.id, revisionId: revision.id }],
    }, original.version);
    expect(refused.status, mismatch).toBe(422);
    expect(await f.ok('human', `/findings/${original.id}`)).toEqual(original);
  }
});
