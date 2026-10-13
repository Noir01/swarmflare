import { expect, it } from 'vitest';
import { acceptanceFixture } from './acceptance-fixture';

// Synthetic emulator metadata only; this does not exercise real Git or execution.
async function events(f: Awaited<ReturnType<typeof acceptanceFixture>>) {
  return (await f.ok('human', '/events')).events as Array<{sequence:number;action:string;resourceId:string}>;
}

it.each(['finding', 'contract-approval', 'policy'] as const)('%s mutation and acceptance are ordered atomically', async kind => {
  const f = await acceptanceFixture();
  // Proposal creation is intentionally outside the race; it cannot invalidate
  // readiness by advancing the approved contract during the acceptance race.
  const proposal = kind === 'contract-approval'
    ? await f.ok('human', '/contracts/proposals', f.contract)
    : undefined;
  const confirmation = await f.confirm();
  const input = f.acceptInput(confirmation);
  const before = await events(f);
  const mutation = kind === 'finding'
    ? f.request('reviewer', '/findings', f.finding)
    : kind === 'policy'
      ? f.request('human', '/policy', f.policy, 1)
      : f.request('human', `/contracts/${proposal!.id}/approve`, {}, 1);
  const [acceptedRace, changedRace] = await Promise.all([
    f.request('human', '/acceptances', input, undefined, `race-${kind}`), mutation,
  ]);
  expect(changedRace.status, JSON.stringify(changedRace.body)).toBe(201);
  const changedRecord = changedRace.body.resource;
  if (kind === 'finding') {
    expect(await f.ok('human', `/findings/${changedRecord.id}`)).toEqual(changedRecord);
  } else if (kind === 'policy') {
    expect(await f.ok('human', '/policy')).toEqual(changedRecord);
  } else {
    expect(await f.ok('human', `/contracts/${changedRecord.version}`)).toEqual(changedRecord);
  }

  const audit = await events(f);
  const since = audit.filter(event => event.sequence > before.at(-1)!.sequence);
  const acceptanceEvent = since.find(event => event.action === 'acceptance.accept');
  const mutationAction = kind === 'finding' ? 'finding.create' : kind === 'policy' ? 'policy.configure' : 'contract.approve';
  const mutationEvent = since.find(event => event.action === mutationAction);
  expect(mutationEvent, JSON.stringify(since)).toBeDefined();
  const baseline = await f.ok('human', '/baseline');
  const acceptanceRecord = acceptedRace.status === 201
    ? await f.ok('human', `/acceptances/${acceptedRace.body.resource.id}`)
    : undefined;

  if (acceptanceEvent && mutationEvent) {
    expect(acceptanceEvent.sequence).toBeLessThan(mutationEvent.sequence);
    expect(acceptedRace.status, JSON.stringify(acceptedRace.body)).toBe(201);
    expect(baseline).toEqual(acceptanceRecord.data.newBaseline);
  } else {
    expect(mutationEvent, JSON.stringify(since)).toBeDefined();
    expect(acceptanceEvent, JSON.stringify(since)).toBeUndefined();
    expect(acceptedRace.status).toBe(409);
    expect(baseline).toEqual(f.baseline);
    expect(await f.ok('human', `/views/${f.view.id}/readiness`)).toMatchObject({ready:false});
  }

  // Exact retry is idempotent when acceptance committed, and cannot silently
  // create a second acceptance after a mutation-first rejection.
  if (acceptanceRecord) {
    const retry = await f.request('human', '/acceptances', input, undefined, `race-${kind}`);
    expect(retry.status).toBe(201);
    expect(retry.body.resource).toEqual(acceptanceRecord);
    expect(await f.ok('human', `/acceptances/${acceptanceRecord.id}`)).toEqual(acceptanceRecord);
  } else {
    const retry = await f.request('human', '/acceptances', input, undefined, `race-${kind}`);
    expect(retry.status).toBe(409);
    expect(await f.ok('human', '/baseline')).toEqual(f.baseline);
  }
  // The original View/evidence remains addressable regardless of race winner.
  expect(await f.ok('human', `/views/${f.view.id}`)).toEqual(f.view);
  expect((await f.ok('human', `/views/${f.view.id}/checks`)).length).toBeGreaterThan(0);
});
