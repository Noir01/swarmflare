import { expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { sourceRef, jobResourceSchema } from '../../packages/contracts/source';

const actors = {
  human: { id: 'human', role: 'human' },
  runner: { id: 'runner', role: 'runner' },
  otherRunner: { id: 'other-runner', role: 'runner' },
} as const;

function fixture() {
  const projectId = `replay-recovery-${crypto.randomUUID()}`;
  const stub = env.PROJECTS.get(env.PROJECTS.idFromName(projectId));
  const request = async (actor: keyof typeof actors, path: string, payload?: unknown, requestId: string = crypto.randomUUID(), expectedVersion?: number) => {
    const response = await stub.fetch(new Request(`https://local${path}`, {
      method: payload === undefined ? 'GET' : 'POST',
      headers: { 'x-project-id': projectId, 'x-actor': JSON.stringify({ ...actors[actor], projectId }), 'content-type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify({ requestId, expectedVersion, payload }),
    }));
    return { status: response.status, body: await response.json() as any };
  };
  return { request };
}

it('replays a committed completion immutably and rejects changed payloads for the same request ID', async () => {
  const f = fixture();
  const proposal = await f.request('human', '/contracts/proposals', {
    outcome: 'Recover source completion', constraints: [],
    obligations: [{ id: 'source', description: 'Preserve source receipt', acceptanceExamples: [] }],
    requiredCheckIds: ['check'], unresolvedQuestions: [],
  }, 'proposal');
  expect(proposal.status).toBe(201);
  expect((await f.request('human', `/contracts/${proposal.body.resource.id}/approve`, {}, 'approve', 0)).status).toBe(201);
  expect((await f.request('human', '/baseline/initialize', { commitOid: 'a'.repeat(40), treeOid: 'b'.repeat(40) }, 'baseline', 0)).status).toBe(201);

  const claimedResponse = await f.request('runner', '/runner/claim', { leaseSeconds: 30 }, 'claim');
  const claimed = jobResourceSchema.parse(claimedResponse.body.resource);
  const path = `/runner/jobs/${claimed.id}/complete`;
  const payload = { attemptId: claimed.data.attemptId, ok: true, receipt: {
    backend: 'local-git', commitOid: 'a'.repeat(40), treeOid: 'b'.repeat(40), ref: sourceRef(claimed.data.input),
  } };
  const committed = await f.request('runner', path, payload, 'completion');
  expect(committed.status).toBe(201);
  expect(committed.body.resource.data.status).toBe('completed');
  expect(committed.body.resource.data.receipt).toEqual(payload.receipt);

  // Simulate retry after the original successful response was lost.
  expect(await f.request('runner', path, payload, 'completion')).toEqual(committed);
  const changedReceipt = { ...payload, receipt: { ...payload.receipt, commitOid: 'c'.repeat(40) } };
  expect((await f.request('runner', path, changedReceipt, 'completion')).status).toBe(409);
  expect((await f.request('runner', path, { attemptId: payload.attemptId, ok: false, error: 'CHANGED' }, 'completion')).status).toBe(409);

  // A different actor/request cannot use the replay as authorization for this attempt.
  expect((await f.request('otherRunner', path, payload, 'completion')).status).toBe(409);
  expect((await f.request('runner', `/runner/jobs/${claimed.id}`)).body.resource).toEqual(committed.body.resource);
  const events = await f.request('runner', '/events');
  expect(events.body.resource.events.filter((event: any) => event.action === 'runner.complete' && event.resourceId === claimed.id)).toHaveLength(1);
});
