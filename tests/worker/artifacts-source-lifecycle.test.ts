import { expect, it } from 'vitest';
import { env } from 'cloudflare:test';

// Exercises the real SQLite-backed Project Durable Object over its HTTP API.
// The configured Artifacts binding is deliberately synthetic; this test makes
// no Cloudflare API or cloud repository calls.
const projectId = () => `artifacts-lifecycle-${crypto.randomUUID()}`;
const actor = (id: string, role: string, project: string) => ({ id, role, projectId: project });
const request = (path: string, project: string, who: ReturnType<typeof actor>, body?: unknown) => new Request(`https://internal${path}`, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { 'x-project-id': project, 'x-actor': JSON.stringify(who), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const mutation = (requestId: string, payload: unknown, expectedVersion?: number) => ({ requestId, ...(expectedVersion === undefined ? {} : { expectedVersion }), payload });
const oid = (x: string) => x.repeat(40);

it('keeps legacy local completion unable to claim an Artifacts publication', async () => {
  const project = projectId(), human = actor('fixture-human', 'human', project), runner = actor('fixture-runner', 'runner', project);
  const stub = env.PROJECTS.get(env.PROJECTS.idFromName(project));
  const proposal = await stub.fetch(request('/contracts/proposals', project, human, mutation('contract-proposal', {
    outcome: 'Publish exact source', constraints: [], obligations: [{ id: 'source', description: 'Publish source safely', acceptanceExamples: [] }], requiredCheckIds: ['source-check'], unresolvedQuestions: [],
  })));
  expect(proposal.status).toBe(201);
  const proposalId = ((await proposal.json() as any).resource.id as string);
  expect((await stub.fetch(request(`/contracts/${proposalId}/approve`, project, human, mutation('contract-approve', {}, 0)))).status).toBe(201);
  const seed = await stub.fetch(request('/baseline/initialize', project, human, mutation('seed', { commitOid: oid('a'), treeOid: oid('b') }, 0)));
  expect(seed.status).toBe(201);
  const claim = await stub.fetch(request('/runner/claim', project, runner, mutation('claim', { leaseSeconds: 30 })));
  const job = (await claim.json() as any).resource;
  expect(job.data.status).toBe('leased');
  const publish = { attemptId: job.data.attemptId, commitOid: oid('a'), treeOid: oid('b'), packBase64: 'UEFDSw==' };
  const wrongRole = await stub.fetch(request(`/runner/jobs/${job.id}/publish-artifacts`, project, human, mutation('wrong-role-publish', publish)));
  expect(wrongRole.status).toBe(403);
  const wrongLease = await stub.fetch(request(`/runner/jobs/${job.id}/publish-artifacts`, project, runner, mutation('wrong-lease-publish', { ...publish, attemptId: crypto.randomUUID() })));
  expect(wrongLease.status).toBe(409);
  const forged = await stub.fetch(request(`/runner/jobs/${job.id}/publish-artifacts`, project, runner, mutation('forged-receipt', { ...publish, receipt: { backend: 'artifacts-git', ref: `refs/agent/seeds/${job.data.input.seedId}`, commitOid: oid('a'), treeOid: oid('b') } })));
  expect(forged.status).toBe(422);
  const fakeCloudReceipt = { backend: 'artifacts-git', ref: `refs/agent/seeds/${job.data.input.seedId}`, commitOid: oid('a'), treeOid: oid('b') };
  const legacy = await stub.fetch(request(`/runner/jobs/${job.id}/complete`, project, runner, mutation('legacy-cloud-complete', { attemptId: job.data.attemptId, ok: true, receipt: fakeCloudReceipt })));
  expect(legacy.status).toBe(422);
  const baseline = await stub.fetch(request('/baseline', project, human));
  expect((await baseline.json() as any).resource).toBeNull();
  expect((await stub.fetch(request('/runner/jobs/not-a-job/publish-artifacts', project, runner, mutation('unknown-job', { attemptId: job.data.attemptId, commitOid: oid('a'), treeOid: oid('b'), packBase64: 'UEFDSw==' })))).status).toBe(404);
});
