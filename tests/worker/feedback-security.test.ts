import { expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import worker from '../../apps/worker/src/index';
import { sourceRef } from '../../packages/contracts/source';

// Coordinator-owned independent HTTP/SQLite tests. Source receipts below are
// synthetic unit fixtures, NOT executed Git/check evidence or a real demo.
async function fixture(author: 'alice' | 'human' = 'alice') {
  const projectId = `feedback-security-${crypto.randomUUID()}`;
  const actors = { alice: 'contributor', bob: 'contributor', human: 'human', reviewer: 'reviewer', runner: 'runner' } as const;
  const credentials = await Promise.all(Object.entries(actors).map(async ([id, role]) => ({
    id, role, projectId, expiresAt: Date.now() + 60000,
    tokenHash: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`fixture-${id}`))), b => b.toString(16).padStart(2, '0')).join(''),
  })));
  const bindings = { ...env, AUTH_CREDENTIALS: JSON.stringify(credentials) };
  const request = async (actor: keyof typeof actors, path: string, payload?: unknown, expectedVersion?: number, requestId: string = crypto.randomUUID()) => {
    const response = await worker.fetch(new Request(`https://local/api/v1/projects/${projectId}${path}`, {
      method: payload === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer fixture-${actor}`, 'content-type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify({ requestId, expectedVersion, payload }),
    }), bindings);
    return { status: response.status, body: await response.json() as any };
  };
  const contract = { outcome: 'Safe feedback', constraints: [], obligations: [{ id: 'tenant', description: 'Never mix tenants', acceptanceExamples: [] }], requiredCheckIds: ['tenant-check'], unresolvedQuestions: [] };
  const proposal = (await request('human', '/contracts/proposals', contract)).body.resource;
  expect((await request('human', `/contracts/${proposal.id}/approve`, {}, 0)).status).toBe(201);
  const complete = async (commitOid: string, treeOid: string) => {
    const job = (await request('runner', '/runner/claim', { leaseSeconds: 30 })).body.resource;
    expect(job).not.toBeNull();
    expect((await request('runner', `/runner/jobs/${job.id}/complete`, { attemptId: job.data.attemptId, ok: true, receipt: { backend: 'local-git', commitOid, treeOid, ref: sourceRef(job.data.input) } })).status).toBe(201);
  };
  const baseCommitOid = 'a'.repeat(40);
  expect((await request('human', '/baseline/initialize', { commitOid: baseCommitOid, treeOid: 'b'.repeat(40) }, 0)).status).toBe(201);
  await complete(baseCommitOid, 'b'.repeat(40));
  const change = (await request(author, '/changes', { title: 'Tenant safety', obligationIds: ['tenant'] })).body.resource;
  const publish = async (digit: string) => {
    const result = await request(author, `/changes/${change.id}/revisions`, { baseCommitOid, commitOid: digit.repeat(40), treeOid: 'd'.repeat(40), obligationIds: ['tenant'], decisionRevisions: [], dependencies: [] });
    expect(result.status).toBe(201);
    await complete(digit.repeat(40), 'd'.repeat(40));
    return result.body.resource;
  };
  const view = async (revision: any) => {
    const result = await request(author, '/views', { baseVersion: 1, baseCommitOid, contractVersion: 1, policyVersion: 1, orderedRevisions: [{ changeId: change.id, revisionId: revision.id }], excludedChangeIds: [], decisionRevisions: [], compositionVersion: 1 });
    expect(result.status).toBe(201);
    await complete(revision.data.commitOid, revision.data.treeOid);
    return (await request('reviewer', `/views/${result.body.resource.id}`)).body.resource;
  };
  const original = await publish('c');
  const originalView = await view(original);
  const anchor = (v: any) => ({ viewId: v.id, manifestDigest: v.data.manifestDigest, composedCommitOid: v.data.receipt.commitOid, treeOid: v.data.receipt.treeOid, contractVersion: v.data.manifest.contractVersion, policyVersion: v.data.manifest.policyVersion });
  const findingPayload = { ...anchor(originalView), obligationIds: ['tenant'], affectedChangeIds: [change.id], paths: ['ui.js'], expected: 'reset rows', observed: 'old tenant rows remain', nextOwner: author };
  const finding = (await request('reviewer', '/findings', findingPayload)).body.resource;
  expect(finding.data.status).toBe('open');
  return { projectId, request, contract, change, original, originalView, finding, findingPayload, publish, view, anchor, author };
}

it('refuses the exact offending revision as its own repair and leaves finding unchanged', async () => {
  const f = await fixture();
  const result = await f.request('alice', `/findings/${f.finding.id}/repair`, { revisions: [{ changeId: f.change.id, revisionId: f.original.id }] }, f.finding.version);
  expect(result.status).toBe(422);
  expect((await f.request('alice', `/findings/${f.finding.id}`)).body.resource).toEqual(f.finding);
});

it('enforces repair CAS and idempotency without erasing the current blocker', async () => {
  const f = await fixture();
  const revision = await f.publish('e');
  const payload = { revisions: [{ changeId: f.change.id, revisionId: revision.id }] };
  expect((await f.request('alice', `/findings/${f.finding.id}/repair`, payload, 0)).status).toBe(409);
  const first = await f.request('alice', `/findings/${f.finding.id}/repair`, payload, 1, 'repair-replay');
  expect(first.status).toBe(201);
  expect(await f.request('alice', `/findings/${f.finding.id}/repair`, payload, 1, 'repair-replay')).toEqual(first);
  expect((await f.request('alice', `/findings/${f.finding.id}/repair`, payload, 2, 'repair-replay')).status).toBe(409);
  const replacement = await f.view(revision);
  const readiness = (await f.request('human', `/views/${replacement.id}/readiness`)).body.resource;
  expect(readiness.ready).toBe(false);
  expect(readiness.findingIds).toContain(f.finding.id);
  expect(readiness.reviewIds).toEqual([]);
});

it('lets an independent reporting reviewer evaluate a replacement but not waive missing checks', async () => {
  const f = await fixture();
  const revision = await f.publish('e');
  await f.request('alice', `/findings/${f.finding.id}/repair`, { revisions: [{ changeId: f.change.id, revisionId: revision.id }] }, 1);
  const replacement = await f.view(revision);
  const result = await f.request('reviewer', `/findings/${f.finding.id}/resolve`, { viewId: replacement.id, note: 'Request fresh evaluation' });
  expect(result.status).toBe(409);
  expect(result.body.code).toBe('EVIDENCE_MISSING');
  expect((await f.request('human', '/baseline')).body.resource.version).toBe(1);
});

it('prohibits a human repair author from independently resolving their own work', async () => {
  const f = await fixture('human');
  const revision = await f.publish('e');
  await f.request('human', `/findings/${f.finding.id}/repair`, { revisions: [{ changeId: f.change.id, revisionId: revision.id }] }, 1);
  const replacement = await f.view(revision);
  expect((await f.request('human', `/findings/${f.finding.id}/resolve`, { viewId: replacement.id, note: 'I fixed it' })).status).toBe(403);
  expect((await f.request('human', `/views/${replacement.id}/reviews`, { ...f.anchor(replacement), obligationIds: ['tenant'], summary: 'Own work', verdict: 'passed', findings: [] })).status).toBe(403);
});

it('reports changed contract and uncovered obligations while preserving old feedback', async () => {
  const f = await fixture();
  const updated = { ...f.contract, obligations: [...f.contract.obligations, { id: 'legacy', description: 'Keep old clients', acceptanceExamples: [] }] };
  const proposal = (await f.request('human', '/contracts/proposals', updated)).body.resource;
  expect((await f.request('human', `/contracts/${proposal.id}/approve`, {}, 1)).status).toBe(201);
  const readiness = (await f.request('human', `/views/${f.originalView.id}/readiness`)).body.resource;
  expect(readiness.ready).toBe(false);
  expect(readiness.blockers.map((b: any) => b.code)).toEqual(expect.arrayContaining(['CONTRACT_STALE', 'OBLIGATION_UNCOVERED', 'EVIDENCE_MISSING']));
  expect((await f.request('alice', `/findings/${f.finding.id}`)).body.resource).toEqual(f.finding);
});

async function checkFixture(f: Awaited<ReturnType<typeof fixture>>) {
  const hash = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), b => b.toString(16).padStart(2, '0')).join('');
  // Synthetic protocol receipt only; the separate real Git/Node E2E executes checks.
  return { hash, payload: {
    kind: 'recorded-check', checkId: 'tenant-check', obligationIds: ['tenant'],
    applicability: { ...f.anchor(f.originalView), projectId: f.projectId, checkSuiteDigest: 'f'.repeat(64) },
    harnessVersion: 'json-oracle-v1', result: 'passed', execution: {
      status: 'exited', exitCode: 0, stdout: '{}', stderr: '',
      startedAt: '2026-10-08T00:00:00.000Z', finishedAt: '2026-10-08T00:00:01.000Z',
      nodeVersion: 'v22.19.0', stdoutDigest: await hash('{}'), stderrDigest: await hash(''),
    },
  } };
}

it('enforces runner evidence identity, exact anchors, digests and idempotent readback', async () => {
  const f = await fixture();
  const { payload } = await checkFixture(f);
  const path = `/runner/views/${f.originalView.id}/checks`;
  expect((await f.request('alice', path, payload)).status).toBe(403);
  expect((await f.request('human', path, payload)).status).toBe(403);
  for (const applicability of [
    { ...payload.applicability, projectId: 'another-project' },
    { ...payload.applicability, treeOid: '0'.repeat(40) },
    { ...payload.applicability, viewId: 'another-view' },
  ]) expect((await f.request('runner', path, { ...payload, applicability })).status).toBe(422);
  expect((await f.request('runner', path, { ...payload, execution: { ...payload.execution, stdoutDigest: '0'.repeat(64) } })).status).toBe(422);
  expect((await f.request('runner', path, { ...payload, checkId: 'unapproved' })).status).toBe(422);
  expect((await f.request('runner', path, { ...payload, obligationIds: ['unapproved'] })).status).toBe(422);
  const first = await f.request('runner', path, payload, undefined, 'evidence-replay');
  expect(first.status).toBe(201);
  expect(first.body.resource.owner).toBe('runner');
  expect(first.body.resource.data).toEqual(payload);
  expect(await f.request('runner', path, payload, undefined, 'evidence-replay')).toEqual(first);
  expect((await f.request('runner', path, { ...payload, result: 'failed' }, undefined, 'evidence-replay')).status).toBe(409);
  expect((await f.request('alice', `/views/${f.originalView.id}/checks`)).body.resource).toEqual([first.body.resource]);
  expect((await f.request('human', `/views/${f.originalView.id}/readiness`)).body.resource.ready).toBe(false);
  expect((await f.request('human', '/baseline')).body.resource.version).toBe(1);
});

it('refuses interrupted passes and credential-looking logs without persisting them', async () => {
  const f = await fixture();
  const { payload, hash } = await checkFixture(f);
  const path = `/runner/views/${f.originalView.id}/checks`;
  for (const execution of [
    { ...payload.execution, status: 'timed-out', exitCode: null },
    { ...payload.execution, status: 'output-limit', exitCode: null },
    { ...payload.execution, status: 'exited', exitCode: 1 },
  ]) expect((await f.request('runner', path, { ...payload, execution })).status).toBe(422);
  const stdout = 'Authorization: Bearer synthetic-test-only';
  expect((await f.request('runner', path, { ...payload, execution: { ...payload.execution, stdout, stdoutDigest: await hash(stdout) } })).status).toBe(422);
  expect((await f.request('human', `/views/${f.originalView.id}/checks`)).body.resource).toEqual([]);
});
