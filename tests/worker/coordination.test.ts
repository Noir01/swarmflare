import { expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import worker from '../../apps/worker/src/index';
import { WorkspaceClient } from '../../packages/client/index';
import { contractInput, responseSchema, type Resource } from '../../packages/contracts/index';

// Scripted local integration, not a real-agent or remote Cloudflare demonstration.
it('preserves human-approved contract history through client, HTTP and SQLite while code acceptance stays closed', async () => {
  const projectId = `integration-${crypto.randomUUID()}`;
  const identities = [
    { id: 'human', projectId, role: 'human', token: 'synthetic-human-test' },
    { id: 'writer', projectId, role: 'contributor', token: 'synthetic-writer-test' },
    { id: 'writer', projectId: `${projectId}-other`, role: 'contributor', token: 'synthetic-other-test' },
  ];
  const credentials = await Promise.all(identities.map(async ({ token, ...actor }) => ({
    ...actor, expiresAt: Date.now() + 60000,
    tokenHash: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))), byte => byte.toString(16).padStart(2, '0')).join(''),
  })));
  const bindings = { ...env, AUTH_CREDENTIALS: JSON.stringify(credentials) };
  // Workerd Request supports manual/follow, not Node fetch's redirect:error.
  // This in-process adapter cannot redirect; redirect safety is a Node client test.
  const fetcher: typeof fetch = async (input, init) => worker.fetch(new Request(input, { ...init, redirect: 'manual' }), bindings);
  const human = new WorkspaceClient({ baseUrl: 'https://local', projectId, token: identities[0]!.token, fetch: fetcher });
  const writer = new WorkspaceClient({ baseUrl: 'https://local', projectId, token: identities[1]!.token, fetch: fetcher });
  const payload = { outcome: 'Preserve tenant isolation', constraints: ['No cross-tenant rows'], obligations: [{ id: 'tenant', description: 'Tenant-bound queries', acceptanceExamples: ['Tenant A never reads B'] }], requiredCheckIds: ['tenant-check'], unresolvedQuestions: [] };
  const proposal = await writer.createProposal({ requestId: 'proposal', payload }) as Resource;
  await expect(writer.approveProposal(proposal.id, { requestId: 'agent-approval', expectedVersion: 0, payload: {} })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  const initial = await human.approveProposal(proposal.id, { requestId: 'human-approval', expectedVersion: 0, payload: {} }) as Resource;
  expect(initial.version).toBe(1);
  expect(contractInput.parse(initial.data)).toEqual(payload);
  expect(await human.approveProposal(proposal.id, { requestId: 'human-approval', expectedVersion: 0, payload: {} })).toEqual(initial);
  await expect(human.approveProposal(proposal.id, { requestId: 'human-approval', expectedVersion: 1, payload: {} })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  const firstContext = await writer.context();
  expect(firstContext.contract).toEqual(initial);
  expect(await writer.context()).toEqual(firstContext); // actual conditional 304 through HTTP
  const revised = await writer.createProposal({ requestId: 'revision', payload: { ...payload, outcome: 'Preserve tenant isolation and legacy shape' } }) as Resource;
  await expect(human.approveProposal(revised.id, { requestId: 'stale', expectedVersion: 0, payload: {} })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  const current = await human.approveProposal(revised.id, { requestId: 'current', expectedVersion: 1, payload: {} }) as Resource;
  expect(current.version).toBe(2);
  expect(await writer.contract(1)).toEqual(initial);
  expect((await writer.context()).contract).toEqual(current);
  const acceptance = await fetcher(`https://local/api/v1/projects/${projectId}/acceptances`, { method: 'POST', headers: { Authorization: `Bearer ${identities[0]!.token}` }, body: JSON.stringify({ requestId: 'accept', payload: {} }) });
  expect(acceptance.status).toBe(409);
  expect(await acceptance.json()).toMatchObject({ code: 'EVIDENCE_MISSING' });
  expect((await writer.context()).baseline).toBeNull();
  const forged = await fetcher(`https://local/api/v1/projects/${projectId}/context`, { headers: { Authorization: `Bearer ${identities[2]!.token}`, 'x-project-id': projectId, 'x-actor': JSON.stringify({ id: 'human', projectId, role: 'human' }) } });
  expect(forged.status).toBe(403); await forged.text();
  const isolated = await fetcher(`https://local/api/v1/projects/${projectId}-other/context`, { headers: { Authorization: `Bearer ${identities[2]!.token}` } });
  const other = responseSchema.parse(await isolated.json()).resource as { contract: unknown };
  expect(other.contract).toBeNull();
});
