import { expect, it } from 'vitest';
import { acceptanceFixture } from './acceptance-fixture';

it('allows only the finding reporter or human to correct an open finding owner with an audit record', async () => {
  const f = await acceptanceFixture();
  const finding = await f.ok('reviewer', '/findings', f.finding);
  const unauthorized = await f.request('alice', `/findings/${finding.id}/owner`, { nextOwner: 'alice', note: 'try' }, finding.version);
  expect(unauthorized.status).toBe(403);
  const runner = await f.request('runner', `/findings/${finding.id}/owner`, { nextOwner: 'alice', note: 'try' }, finding.version);
  expect(runner.status).toBe(403);
  const badTarget = await f.request('reviewer', `/findings/${finding.id}/owner`, { nextOwner: 'unknown', note: 'bad target' }, finding.version);
  expect(badTarget.status).toBe(422);
  const stale = await f.request('reviewer', `/findings/${finding.id}/owner`, { nextOwner: 'alice', note: 'stale' }, finding.version + 1);
  expect(stale.status).toBe(409);

  const corrected = await f.request('reviewer', `/findings/${finding.id}/owner`, { nextOwner: 'alice', note: 'Reporter confirms affected Change owner' }, finding.version);
  expect(corrected.status).toBe(201);
  expect(corrected.body.resource).toMatchObject({
    owner: 'reviewer', version: finding.version + 1,
    data: { nextOwner: 'alice', status: 'open', repairs: [], resolution: null,
      ownerCorrections: [{ previousOwner: 'alice', nextOwner: 'alice', actorId: 'reviewer', note: 'Reporter confirms affected Change owner' }] },
  });
  expect(corrected.body.resource.data).toMatchObject({
    viewId: finding.data.viewId, manifestDigest: finding.data.manifestDigest,
    composedCommitOid: finding.data.composedCommitOid, treeOid: finding.data.treeOid,
    affectedChangeIds: finding.data.affectedChangeIds,
  });

  expect(corrected.body.resource.data.ownerCorrections).toHaveLength(1);
});

it('rejects a Change ID as the next owner and does not reassign after repair is proposed or finding resolved', async () => {
  const f = await acceptanceFixture();
  const invalidCreate = await f.request('reviewer', '/findings', { ...f.finding, nextOwner: f.change.id });
  expect(invalidCreate.status).toBe(422);
  const finding = await f.ok('reviewer', '/findings', f.finding);
  const invalid = await f.request('reviewer', `/findings/${finding.id}/owner`, { nextOwner: f.change.id, note: 'wrong identifier' }, finding.version);
  expect(invalid.status).toBe(422);
  const repairRevision = await f.ok('alice', `/changes/${f.change.id}/revisions`, {
    baseCommitOid: f.baseline.commitOid, commitOid: '9'.repeat(40), treeOid: '8'.repeat(40),
    obligationIds: ['obligation'], decisionRevisions: [], dependencies: [],
  });
  const repairJob = await f.ok('runner', '/runner/claim', { leaseSeconds: 120 });
  await f.ok('runner', `/runner/jobs/${repairJob.id}/complete`, {
    attemptId: repairJob.data.attemptId, ok: true,
    receipt: { backend: 'local-git', commitOid: '9'.repeat(40), treeOid: '8'.repeat(40), ref: `refs/agent/revisions/${f.change.id}/${repairRevision.id}` },
  });
  const repaired = await f.request('alice', `/findings/${finding.id}/repair`, { revisions: [{ changeId: f.change.id, revisionId: repairRevision.id }] }, finding.version);
  expect(repaired.status).toBe(201);
  const afterRepair = await f.request('reviewer', `/findings/${finding.id}/owner`, { nextOwner: 'alice', note: 'too late' }, repaired.body.resource.version);
  expect(afterRepair.status).toBe(409);
});

it('requires expectedVersion and validates requested owner against affected Changes pinned by original View', async () => {
  const f = await acceptanceFixture();
  const finding = await f.ok('reviewer', '/findings', f.finding);
  const noVersion = await f.request('reviewer', `/findings/${finding.id}/owner`, { nextOwner: 'alice', note: 'missing version' });
  expect(noVersion.status).toBe(409);
  const corrected = await f.request('reviewer', `/findings/${finding.id}/owner`, { nextOwner: 'alice', note: 'preserve route' }, finding.version);
  expect(corrected.status).toBe(201);
  const repairNotOwner = await f.request('alice', `/findings/${finding.id}/repair`, { revisions: [{ changeId: f.change.id, revisionId: f.revision.id }] }, corrected.body.resource.version);
  expect(repairNotOwner.status).toBe(422);
});
