import { afterEach, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';

let runtime: Miniflare | undefined;
afterEach(async () => { await runtime?.dispose(); runtime = undefined; });

it('maps SQLite account/grant identity to scoped Project actors and blocks spoofed identities', async () => {
  const bundle = await build({ stdin: { contents: `
    export { Platform } from './apps/worker/src/platform/index';
    export { Project } from './apps/worker/src/project/index';
    import { platformProjectRoute } from './apps/worker/src/http/platform-project';
    export default { fetch: async (request, env) => { const response = await platformProjectRoute(request, env); return response ?? new Response('legacy-fallback', { status: 200 }); } };
  `, resolveDir: process.cwd(), sourcefile: 'platform-project-test-entry.ts', loader: 'ts' }, bundle: true, platform: 'browser', format: 'esm', write: false, external: ['cloudflare:workers'] });
  runtime = new Miniflare(convertV4MiniflareOptions({ name: 'platform-project-test', modules: true, script: bundle.outputFiles[0]!.text, compatibilityDate: '2026-08-01', durableObjects: { PLATFORM: { className: 'Platform', useSQLite: true }, PROJECTS: { className: 'Project', useSQLite: true } }, host: '127.0.0.1', port: 0 }));
  const origin = new URL((await runtime.ready).toString()).origin;
  const pns: any = await runtime.getDurableObjectNamespace('PLATFORM');
  const platform = pns.get(pns.idFromName('swarmflare-platform-v1'));
  const account = async (username: string, email: string) => {
    const signup = await platform.fetch(origin + '/api/platform/auth/signup', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ username, email, password: 'valid-secret-1' }) });
    expect(signup.status).toBe(201);
    return { cookie: signup.headers.get('set-cookie')!.split(';')[0]!, csrf: (await signup.json() as any).csrf };
  };
  const owner = await account('owner-one', 'owner@example.test');
  const outsider = await account('outsider-one', 'outsider@example.test');
  const create = await platform.fetch(origin + '/api/platform/repos', { method: 'POST', headers: { origin, cookie: owner.cookie, 'x-csrf-token': owner.csrf, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'real-project' }) });
  expect(create.status).toBe(201);
  const repo = (await create.json() as any).repository;
  expect(repo.status).toBe('failed'); // No Artifacts binding: explicit unavailable, not synthetic source success.
  const secondCreate = await platform.fetch(origin + '/api/platform/repos', { method: 'POST', headers: { origin, cookie: owner.cookie, 'x-csrf-token': owner.csrf, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'other-project' }) });
  const otherRepo = (await secondCreate.json() as any).repository;
  const refresh = await platform.fetch(origin + '/api/platform/repos/owner-one/real-project/refresh', { method: 'POST', headers: { origin, cookie: owner.cookie, 'x-csrf-token': owner.csrf } });
  expect(refresh.status).toBe(409); expect(refresh.headers.get('cache-control')).toBe('no-store');
  const grantResponse = await platform.fetch(origin + `/api/platform/repos/owner-one/real-project/agents`, { method: 'POST', headers: { origin, cookie: owner.cookie, 'x-csrf-token': owner.csrf, 'content-type': 'application/json' }, body: JSON.stringify({ role: 'contributor', expiresInSeconds: 600 }) });
  expect(grantResponse.status).toBe(201);
  const grantData = await grantResponse.json() as any;
  const grant = grantData.token;
  const request = (path: string, token?: string, extra: Record<string, string> = {}, body?: unknown) => new Request(origin + `/api/v1/projects/${repo.projectId}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra, ...(body === undefined ? {} : { 'content-type': 'application/json' }) , ...(body === undefined ? {} : { 'x-actor': JSON.stringify({ id: 'fake', projectId: repo.projectId, role: 'runner' }), 'x-project-id': repo.projectId }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const dispatch = async (req: Request) => { const headers: Record<string, string> = {}; req.headers.forEach((value, key) => { headers[key] = value; }); return runtime!.dispatchFetch(req.url, { method: req.method, headers, body: req.body ? await req.arrayBuffer() : undefined }); };
  const claimBody = { requestId: 'claim-1', payload: { obligationIds: ['scope-check'], areas: ['src'] } };
  const claim = await (await dispatch(request('/claims', grant, {}, claimBody))).json() as any;
  expect(claim.resource.data.areas).toEqual(['src']);
  expect(claim.resource.owner).not.toBe('fake');
  const findingRoute = await dispatch(request('/findings', grant, {}, { requestId: 'finding-shape', payload: {} }));
  const findingBody = await findingRoute.json() as any;
  expect(findingBody.message).not.toBe('Unknown project route');
  expect(findingRoute.status).toBe(422); // Project validates the real finding contract.
  expect((await dispatch(request('/claims', grant, {}, 'x'.repeat(65537)))).status).toBe(413);
  const crossProject = await dispatch(new Request(origin + `/api/v1/projects/${otherRepo.projectId}/claims`, { method: 'POST', headers: { authorization: `Bearer ${grant}`, 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'cross-project', payload: { obligationIds: ['scope-check'], areas: ['src'] } }) }));
  expect(crossProject.status).toBe(403);
  const outsiderWrite = await dispatch(request('/claims', undefined, { cookie: outsider.cookie, origin, 'x-csrf-token': outsider.csrf }, { requestId: 'outsider-claim', payload: { obligationIds: ['scope-check'], areas: ['src'] } }));
  expect(outsiderWrite.status).toBe(403);
  const ownerWrite = await dispatch(request('/claims', undefined, { cookie: owner.cookie, origin, 'x-csrf-token': owner.csrf }, { requestId: 'owner-claim', payload: { obligationIds: ['scope-check'], areas: ['owner'] } }));
  expect(ownerWrite.status).toBe(201);
  const spoof = await dispatch(request('/claims', undefined, { 'x-actor': JSON.stringify({ id: 'fake', projectId: repo.projectId, role: 'human' }), 'x-project-id': repo.projectId }, { requestId: 'spoof-claim', payload: { obligationIds: ['scope-check'], areas: ['src'] } }));
  expect(spoof.status).toBe(403);
  const runner = await dispatch(request('/runner/claim', grant));
  expect(runner.status).toBe(404);
  const acceptance = await dispatch(request('/acceptances', grant, {}, { requestId: 'agent-accept', payload: {} }));
  expect(acceptance.status).toBe(403);
  const privateJob = await dispatch(request('/runner/jobs/job-id'));
  expect(privateJob.status).toBe(403);
  const internal = await dispatch(request('/internal/dashboard-sessions'));
  expect(internal.status).toBe(403);
  const unmapped = await dispatch(new Request(origin + '/api/v1/projects/legacy-project/claims', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(claimBody) }));
  expect(unmapped.status).toBe(200); expect(await unmapped.text()).toBe('legacy-fallback'); // Only explicit unmapped signal permits legacy fallback.
  for (const [method, path] of [['POST', '/runner/claim'], ['GET', '/runner/jobs/legacy-job']] as const) {
    const legacy = await dispatch(new Request(origin + `/api/v1/projects/legacy-project${path}`, { method }));
    expect(legacy.status).toBe(200);
    expect(await legacy.text()).toBe('legacy-fallback');
  }
  const malformedProject = await dispatch(new Request(origin + '/api/v1/projects/%2F/claims'));
  expect(malformedProject.status).toBe(400);
  expect(await malformedProject.json()).toEqual({ code: 'INVALID_REQUEST', message: 'Invalid project ID' });
  const noncanonicalProject = await dispatch(new Request(origin + '/api/v1/projects/%6cegacy-project/claims'));
  expect(noncanonicalProject.status).toBe(422);
  expect(await noncanonicalProject.json()).toEqual({ code: 'INVALID_REQUEST', message: 'Noncanonical project ID' });
  const revoke = await platform.fetch(origin + `/api/platform/repos/owner-one/real-project/agents/${grantData.grant.id}`, { method: 'DELETE', headers: { origin, cookie: owner.cookie, 'x-csrf-token': owner.csrf } });
  expect(revoke.status).toBe(200);
  expect((await dispatch(request('/claims', grant, {}, { requestId: 'revoked-claim', payload: { obligationIds: ['scope-check'], areas: ['src'] } }))).status).toBe(403);
});
