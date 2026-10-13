import { expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import worker from '../../apps/worker/src/index';

it('keeps acceptance fail-closed without a configured policy and checks role before parsing body', async () => {
  const projectId = `acceptance-${crypto.randomUUID()}`;
  const actors = [
    { id: 'human', projectId, role: 'human', token: 'acceptance-human-test' },
    { id: 'writer', projectId, role: 'contributor', token: 'acceptance-writer-test' },
  ];
  const credentials = await Promise.all(actors.map(async ({ token, ...actor }) => ({
    ...actor, expiresAt: Date.now() + 60_000,
    tokenHash: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))), b => b.toString(16).padStart(2, '0')).join(''),
  })));
  const bindings = { ...env, AUTH_CREDENTIALS: JSON.stringify(credentials) };
  const post = (token: string, body: string) => worker.fetch(new Request(`https://local/api/v1/projects/${projectId}/acceptances`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body,
  }), bindings);
  const human = await post(actors[0]!.token, '{');
  expect(human.status).toBe(409);
  expect(await human.json()).toMatchObject({ code: 'EVIDENCE_MISSING' });
  const contributor = await post(actors[1]!.token, '{');
  expect(contributor.status).toBe(403);
  expect(await contributor.json()).toMatchObject({ code: 'FORBIDDEN' });
});
