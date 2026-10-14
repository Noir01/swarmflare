import { afterEach, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';

let runtime: Miniflare | undefined;
afterEach(async () => { await runtime?.dispose(); runtime = undefined; });

it('renews a repository grant in place, rotating its bearer token and preserving its actor scope', async () => {
  const bundle = await build({ stdin: { contents: `
    import { Platform as BasePlatform } from './apps/worker/src/platform/index';
    export class Platform extends BasePlatform {
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === '/test-only/expire-grant' && request.method === 'POST') {
          const body = await request.json();
          if (!body || typeof body.id !== 'string' || !/^[0-9a-f-]{36}$/.test(body.id)) return Response.json({ error: 'invalid grant id' }, { status: 400 });
          this.ctx.storage.sql.exec('UPDATE grants SET expires=0 WHERE id=?', body.id);
          return Response.json({ ok: true });
        }
        return super.fetch(request);
      }
    }
    export { Project } from './apps/worker/src/project/index';
    import { platformProjectRoute } from './apps/worker/src/http/platform-project';
    export default { fetch: async (request, env) => (await platformProjectRoute(request, env)) ?? new Response('legacy-fallback') };
  `, resolveDir: process.cwd(), sourcefile: 'grant-renewal-test-entry.ts', loader: 'ts' }, bundle: true, platform: 'browser', format: 'esm', write: false, external: ['cloudflare:workers'] });
  runtime = new Miniflare(convertV4MiniflareOptions({ name: 'grant-renewal-test', modules: true, script: bundle.outputFiles[0]!.text, compatibilityDate: '2026-08-01', durableObjects: { PLATFORM: { className: 'Platform', useSQLite: true }, PROJECTS: { className: 'Project', useSQLite: true } }, host: '127.0.0.1', port: 0 }));
  const origin = new URL((await runtime.ready).toString()).origin;
  const ns: any = await runtime.getDurableObjectNamespace('PLATFORM');
  const platform = ns.get(ns.idFromName('swarmflare-platform-v1'));
  const signup = async (username: string) => {
    const response = await platform.fetch(origin + '/api/platform/auth/signup', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ username, email: `${username}@example.test`, password: 'synthetic-test-password' }) });
    expect(response.status).toBe(201);
    return { cookie: response.headers.get('set-cookie')!.split(';')[0]!, csrf: (await response.json() as any).csrf };
  };
  const owner = await signup('renewal-owner'), outsider = await signup('renewal-outsider');
  const ownerHeaders = { origin, cookie: owner.cookie, 'x-csrf-token': owner.csrf, 'content-type': 'application/json' };
  const created = await platform.fetch(origin + '/api/platform/repos', { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ name: 'renewable-repo' }) });
  expect(created.status).toBe(201);
  const repo = (await created.json() as any).repository;
  expect(repo.status).toBe('failed'); // Missing provider is explicit; no synthetic source is created.
  const issued = await platform.fetch(origin + `/api/platform/repos/renewal-owner/renewable-repo/agents`, { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ role: 'contributor', expiresInSeconds: 600 }) });
  const original = await issued.json() as any;
  expect(issued.status).toBe(201);
  const dispatch = async (token: string, path = '/claims', body: unknown = { requestId: 'claim-original', payload: { obligationIds: ['scope-check'], areas: ['src'] } }) => runtime!.dispatchFetch(origin + `/api/v1/projects/${repo.projectId}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const claimed = await dispatch(original.token);
  const claim = await claimed.json() as any;
  expect(claimed.status).toBe(201);
  expect(claim.resource.owner).toBe(original.grant.id);
  const continueClaim = async (token: string, id: string) => runtime!.dispatchFetch(origin + `/api/v1/projects/${repo.projectId}/claims/${id}`, { method: 'PATCH', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'claim-continuation', payload: { status: 'working' } }) });
  expect((await continueClaim(original.token, claim.resource.id)).status).toBe(201);
  const renewalUrl = origin + `/api/platform/repos/renewal-owner/renewable-repo/agents/${original.grant.id}/renew`;
  const renewedResponse = await platform.fetch(renewalUrl, { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ expiresInSeconds: 3600 }) });
  const renewed = await renewedResponse.json() as any;
  expect(renewedResponse.status).toBe(200);
  expect(renewedResponse.headers.get('cache-control')).toBe('no-store');
  expect(renewed.grant).toEqual({ id: original.grant.id, role: 'contributor', expiresAt: expect.any(Number) });
  expect(renewed.token).toMatch(/^[a-f0-9]{64}$/);
  expect(renewed.token).not.toBe(original.token);
  const expire = async (id: string) => platform.fetch(origin + '/test-only/expire-grant', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) });
  expect((await expire(original.grant.id)).status).toBe(200);
  expect((await platform.fetch(origin + '/api/platform/agent/session', { headers: { authorization: `Bearer ${original.token}` } })).status).toBe(401);
  expect((await dispatch(original.token, '/claims', { requestId: 'claim-expired', payload: { obligationIds: ['scope-check'], areas: ['src'] } })).status).toBe(403);
  const expiredRenewal = await platform.fetch(renewalUrl, { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ expiresInSeconds: 3600 }) });
  const expiredRenewed = await expiredRenewal.json() as any;
  expect(expiredRenewal.status).toBe(200);
  expect(expiredRenewed.grant).toEqual({ id: original.grant.id, role: 'contributor', expiresAt: expect.any(Number) });
  expect((await platform.fetch(origin + '/api/platform/agent/session', { headers: { authorization: `Bearer ${original.token}` } })).status).toBe(401);
  expect((await platform.fetch(origin + '/api/platform/agent/session', { headers: { authorization: `Bearer ${expiredRenewed.token}` } })).status).toBe(200);
  expect((await dispatch(expiredRenewed.token, '/claims', { requestId: 'claim-expired-renewed', payload: { obligationIds: ['scope-check'], areas: ['src'] } })).status).toBe(201);
  expect((await continueClaim(expiredRenewed.token, claim.resource.id)).status).toBe(201);
  expect((await platform.fetch(origin + '/api/platform/agent/session', { headers: { authorization: `Bearer ${original.token}` } })).status).toBe(401);
  const oldIdPost = await platform.fetch(origin + `/api/platform/repos/renewal-owner/renewable-repo/agents/${original.grant.id}`, { method: 'POST', headers: ownerHeaders, body: '{}' });
  expect(oldIdPost.status).toBe(404);
  for (const body of [{ expiresInSeconds: 60, role: 'reviewer' }, { expiresInSeconds: 60, actorId: 'spoof' }, { expiresInSeconds: 60, projectId: repo.projectId }, { expiresInSeconds: 59 }, { expiresInSeconds: 3601 }, { expiresInSeconds: 60.5 }]) {
    const rejected = await platform.fetch(renewalUrl, { method: 'POST', headers: ownerHeaders, body: JSON.stringify(body) });
    expect(rejected.status).toBe(400);
  }
  expect((await platform.fetch(renewalUrl, { method: 'POST', headers: { ...ownerHeaders, 'x-csrf-token': 'wrong' }, body: JSON.stringify({ expiresInSeconds: 60 }) })).status).toBe(403);
  expect((await platform.fetch(renewalUrl, { method: 'POST', headers: { ...ownerHeaders, origin: 'https://outsider.example.test' }, body: JSON.stringify({ expiresInSeconds: 60 }) })).status).toBe(403);
  expect((await platform.fetch(renewalUrl, { method: 'POST', headers: { origin, authorization: `Bearer ${renewed.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ expiresInSeconds: 60 }) })).status).toBe(403);
  expect((await platform.fetch(renewalUrl, { method: 'POST', headers: { origin, cookie: outsider.cookie, 'x-csrf-token': outsider.csrf, 'content-type': 'application/json' }, body: JSON.stringify({ expiresInSeconds: 60 }) })).status).toBe(403);
  expect((await platform.fetch(origin + `/api/platform/repos/renewal-owner/other-repo/agents/${original.grant.id}/renew`, { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ expiresInSeconds: 60 }) })).status).toBe(404);
  expect((await platform.fetch(origin + `/api/platform/repos/renewal-owner/renewable-repo/agents/not-a-uuid/renew`, { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ expiresInSeconds: 60 }) })).status).toBe(404);
  const revoke = await platform.fetch(origin + `/api/platform/repos/renewal-owner/renewable-repo/agents/${original.grant.id}`, { method: 'DELETE', headers: ownerHeaders });
  expect(revoke.status).toBe(200);
  expect((await platform.fetch(renewalUrl, { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ expiresInSeconds: 60 }) })).status).toBe(404);
});
