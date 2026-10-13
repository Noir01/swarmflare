import { afterEach, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';

let runtime: Miniflare | undefined;
afterEach(async () => { await runtime?.dispose(); runtime = undefined; });

it('lets an owner select the supported upstream branch for a pending import and retains repository identity', async () => {
  const bundle = await build({ stdin: { contents: "export {Platform} from './apps/worker/src/platform/index';", resolveDir: process.cwd(), sourcefile: 'import-refresh-test-entry.ts', loader: 'ts' }, bundle: true, platform: 'browser', format: 'esm', write: false, external: ['cloudflare:workers'], plugins: [{ name: 'synthetic-repository-source-for-import-refresh', setup(builder) {
    builder.onResolve({ filter: /repository-source/ }, () => ({ path: 'refresh-source', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'ts', contents: `
      export async function provisionRepository(_binding, input) {
        return { status: 'importing', artifactsName: input.artifactsName, remote: 'https://acct.artifacts.cloudflare.net/git/default/repo.git', ref: 'refs/heads/main', commitOid: input.name === 'assigned-repo' ? 'assigned-commit' : null, treeOid: input.name === 'assigned-repo' ? 'assigned-tree' : null };
      }
      export async function readRepositorySource() { throw new Error('unused'); }
      export async function refreshRepository(_binding, source) {
        if (source.ref !== 'refs/heads/master') return source;
        return { ...source, status: 'ready', commitOid: 'verified-fixture-commit', treeOid: 'verified-fixture-tree' };
      }
    ` }));
  } }] });
  runtime = new Miniflare(convertV4MiniflareOptions({ name: 'import-refresh-test', modules: true, script: bundle.outputFiles[0]!.text, compatibilityDate: '2026-08-01', durableObjects: { PLATFORM: { className: 'Platform', useSQLite: true }, PROJECTS: { className: 'Platform', useSQLite: true } }, host: '127.0.0.1', port: 0 }));
  const origin = new URL((await runtime.ready).toString()).origin;
  const ns: any = await runtime.getDurableObjectNamespace('PLATFORM');
  const stub = ns.get(ns.idFromName('refresh-test'));
  const call = (path: string, method = 'GET', body?: unknown, cookie?: string, csrf?: string, requestOrigin = origin) => stub.fetch(origin + '/api/platform' + path, { method, headers: { origin: requestOrigin, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const signup = async (username: string) => {
    const response = await call('/auth/signup', 'POST', { username, email: `${username}@example.test`, password: 'valid-secret-1' });
    const data: any = await response.json();
    return { cookie: response.headers.get('set-cookie')!.split(';')[0]!, csrf: data.csrf };
  };
  const owner = await signup('refresh-owner');
  const outsider = await signup('refresh-outsider');
  const created = await call('/repos', 'POST', { name: 'refresh-repo', importUrl: 'https://github.com/owner/repo' }, owner.cookie, owner.csrf);
  expect(created.status).toBe(201);
  const initial = (await created.json() as any).repository;
  expect(initial).toMatchObject({ status: 'importing', source: { ref: 'refs/heads/main', commitOid: null, treeOid: null } });
  const endpoint = '/repos/refresh-owner/refresh-repo/refresh';
  const unchanged = await call(endpoint, 'POST', {}, owner.cookie, owner.csrf);
  expect((await unchanged.json() as any).repository).toMatchObject({ status: 'importing', source: { ref: 'refs/heads/main', commitOid: null, treeOid: null } });
  expect((await call(endpoint, 'POST', { ref: 'refs/heads/master' })).status).toBe(403);
  expect((await call(endpoint, 'POST', { ref: 'refs/heads/master' }, outsider.cookie, outsider.csrf)).status).toBe(403);
  expect((await call(endpoint, 'POST', { ref: 'refs/heads/master' }, owner.cookie, owner.csrf, 'https://attacker.test')).status).toBe(403);
  for (const invalid of [{ ref: 'refs/heads/main' }, { ref: 'master' }, { ref: 'refs/tags/v1' }, { ref: 'refs/heads/master', extra: true }, [], null]) {
    expect((await call(endpoint, 'POST', invalid, owner.cookie, owner.csrf)).status).toBe(400);
  }
  const selected = await call(endpoint, 'POST', { ref: 'refs/heads/master' }, owner.cookie, owner.csrf);
  expect(selected.status).toBe(200);
  const repository = (await selected.json() as any).repository;
  expect(repository).toMatchObject({ id: initial.id, projectId: initial.projectId, name: 'refresh-repo', status: 'ready', source: { ref: 'refs/heads/master', commitOid: 'verified-fixture-commit', treeOid: 'verified-fixture-tree' } });
  const list = await (await call('/repos')).json() as any;
  expect(list.repositories).toHaveLength(1);
  expect(list.repositories[0]).toMatchObject({ id: initial.id, projectId: initial.projectId });
  expect((await call(endpoint, 'POST', {}, owner.cookie, owner.csrf)).status).toBe(409);

  const assigned = await call('/repos', 'POST', { name: 'assigned-repo', importUrl: 'https://github.com/owner/repo' }, owner.cookie, owner.csrf);
  expect(assigned.status).toBe(201);
  expect((await call('/repos/refresh-owner/assigned-repo/refresh', 'POST', { ref: 'refs/heads/master' }, owner.cookie, owner.csrf)).status).toBe(409);
});
