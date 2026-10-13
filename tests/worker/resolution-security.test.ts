import { expect, it } from 'vitest';
import { acceptanceFixture } from './acceptance-fixture';

// All source/check receipts are synthetic emulator metadata, never Git claims.
async function replacement(f: Awaited<ReturnType<typeof acceptanceFixture>>, digit: string) {
  const revision = await f.ok('alice', `/changes/${f.change.id}/revisions`, {
    baseCommitOid: f.baseline.commitOid, commitOid: digit.repeat(40), treeOid: 'e'.repeat(40),
    obligationIds: ['obligation'], decisionRevisions: [], dependencies: [],
  });
  const job = await f.ok('runner', '/runner/claim', { leaseSeconds: 120 });
  const receipt = { backend: 'local-git', commitOid: digit.repeat(40), treeOid: 'e'.repeat(40), ref: (await import('../../packages/contracts/source')).sourceRef(job.data.input) };
  await f.ok('runner', `/runner/jobs/${job.id}/complete`, { attemptId: job.data.attemptId, ok: true, receipt });
  return { revision, receipt };
}

async function viewWithEvidence(f: Awaited<ReturnType<typeof acceptanceFixture>>, revision: any, digit: string) {
  const queued = await f.ok('alice', '/views', {
    ...f.manifest, orderedRevisions: [{ changeId: f.change.id, revisionId: revision.id }],
  });
  const job = await f.ok('runner', '/runner/claim', { leaseSeconds: 120 });
  const receipt = { backend: 'local-git', commitOid: digit.repeat(40), treeOid: 'e'.repeat(40), ref: (await import('../../packages/contracts/source')).sourceRef(job.data.input) };
  await f.ok('runner', `/runner/jobs/${job.id}/complete`, { attemptId: job.data.attemptId, ok: true, receipt });
  const view = await f.ok('human', `/views/${queued.id}`);
  const applicability = { projectId: f.projectId, viewId: view.id, manifestDigest: view.data.manifestDigest, composedCommitOid: receipt.commitOid, treeOid: receipt.treeOid, contractVersion: 1, policyVersion: 1, checkSuiteDigest: f.policy.checkSuiteDigest };
  await f.ok('runner', `/runner/views/${view.id}/checks`, {
    ...f.check, applicability,
    execution: { ...f.check.execution, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() },
  });
  const { projectId: _projectId, ...anchor } = applicability;
  await f.ok('reviewer', `/views/${view.id}/reviews`, { ...anchor, obligationIds: ['obligation'], summary: 'Synthetic independent review', verdict: 'passed', findings: [] });
  return { view, applicability };
}

async function start(f: Awaited<ReturnType<typeof acceptanceFixture>>) {
  const finding = await f.ok('reviewer', '/findings', f.finding);
  return { finding, original: await f.ok('human', `/views/${f.view.id}`) };
}

it('resolves to an exact replacement tuple, preserves anchor and supports exact replay', async () => {
  const f = await acceptanceFixture(), { finding, original } = await start(f);
  const { revision } = await replacement(f, '1');
  await f.ok('alice', `/findings/${finding.id}/repair`, { revisions: [{ changeId: f.change.id, revisionId: revision.id }] }, finding.version);
  const next = await viewWithEvidence(f, revision, '2');
  const payload = { viewId: next.view.id, note: 'Fresh checks and review passed' };
  const first = await f.request('reviewer', `/findings/${finding.id}/resolve`, payload, undefined, 'resolution-replay');
  expect(first.status, JSON.stringify(first.body)).toBe(201);
  const resource = first.body.resource;
  expect(resource).toEqual(await f.ok('human', `/findings/${finding.id}`));
  expect(resource.data).toMatchObject({ status: 'resolved', resolutionEvidence: { applicability: next.applicability, resolverId: 'reviewer' } });
  expect(resource.data.resolutionEvidence.checkIds).toHaveLength(1);
  expect(resource.data.resolutionEvidence.reviewIds).toHaveLength(1);
  expect(resource.data.resolutionEvidence.resolvedAt).toEqual(expect.any(String));
  expect(resource.data).toMatchObject({ viewId: f.finding.viewId, manifestDigest: f.finding.manifestDigest, composedCommitOid: f.finding.composedCommitOid, treeOid: f.finding.treeOid, contractVersion: f.finding.contractVersion, policyVersion: f.finding.policyVersion });
  expect(await f.request('reviewer', `/findings/${finding.id}/resolve`, payload, undefined, 'resolution-replay')).toEqual(first);
  const oldReadiness = await f.ok('human', `/views/${original.id}/readiness`);
  expect(oldReadiness.ready).toBe(false);
  expect(oldReadiness.blockers.map((b: any) => b.code)).toContain('FINDING_RESOLUTION_STALE');
  expect(oldReadiness.findingIds).toContain(finding.id);
  expect((await f.request('human', `/views/${original.id}/confirmations`, {})).status).not.toBe(201);
});

it('allows a human who is not an author of any selected Change to resolve another author’s repair', async () => {
  const f = await acceptanceFixture(), { finding } = await start(f);
  const { revision } = await replacement(f, '3');
  await f.ok('alice', `/findings/${finding.id}/repair`, { revisions: [{ changeId: f.change.id, revisionId: revision.id }] }, finding.version);
  const next = await viewWithEvidence(f, revision, '4');
  expect((await f.request('human', `/findings/${finding.id}/resolve`, { viewId: next.view.id, note: 'Independent human' })).status).toBe(201);
});

it('requires the latest linked repair revision for each Change and keeps unrelated findings blocking', async () => {
  const f = await acceptanceFixture(), { finding } = await start(f);
  const first = await replacement(f, '5');
  await f.ok('alice', `/findings/${finding.id}/repair`, { revisions: [{ changeId: f.change.id, revisionId: first.revision.id }] }, finding.version);
  const latest = await replacement(f, '6');
  await f.ok('alice', `/findings/${finding.id}/repair`, { revisions: [{ changeId: f.change.id, revisionId: latest.revision.id }] }, 2);
  const superseded = await viewWithEvidence(f, first.revision, '7');
  expect((await f.request('reviewer', `/findings/${finding.id}/resolve`, { viewId: superseded.view.id, note: 'Old repair' })).status).toBe(409);
  const current = await viewWithEvidence(f, latest.revision, '8');
  const resolved = await f.request('reviewer', `/findings/${finding.id}/resolve`, { viewId: current.view.id, note: 'Resolve first' });
  expect(resolved.status, JSON.stringify(resolved.body)).toBe(201);
  expect((await f.ok('human', `/views/${current.view.id}/readiness`)).ready).toBe(true);
  const unrelated = await f.ok('reviewer', '/findings', f.finding);
  const readiness = await f.ok('human', `/views/${current.view.id}/readiness`);
  expect(readiness.ready).toBe(false);
  expect(readiness.findingIds).toContain(unrelated.id);
});

it('can resolve findings independently without clearing another blocker or advancing baseline', async () => {
  const f = await acceptanceFixture(), { finding } = await start(f);
  const { revision } = await replacement(f, '9');
  const repair = await f.ok('alice', `/findings/${finding.id}/repair`, { revisions: [{ changeId: f.change.id, revisionId: revision.id }] }, finding.version);
  const next = await viewWithEvidence(f, revision, '0');
  const other = await f.ok('reviewer', '/findings', f.finding);
  const resolved = await f.request('reviewer', `/findings/${finding.id}/resolve`, { viewId: next.view.id, note: 'This repair is evaluated independently; other blocker remains' });
  expect(resolved.status, JSON.stringify(resolved.body)).toBe(201);
  expect(await f.ok('human', `/findings/${finding.id}`)).toEqual(resolved.body.resource);
  expect(resolved.body.resource.version).toBe(repair.version + 1);
  expect(await f.ok('human', `/findings/${other.id}`)).toEqual(other);
  const ready = await f.ok('human', `/views/${next.view.id}/readiness`);
  expect(ready.ready).toBe(false);
  expect(ready.findingIds).toContain(other.id);
  expect(ready.findingIds).not.toContain(finding.id);
  const denied = await f.request('human', `/views/${next.view.id}/confirmations`, { applicability: next.applicability, expectedBaselineVersion: f.baseline.version, expectedBaselineCommitOid: f.baseline.commitOid, readinessSequence: ready.sequence, confirm: true });
  expect(denied.status).toBe(409);
  expect(await f.ok('human', '/baseline')).toEqual(f.baseline);
});
