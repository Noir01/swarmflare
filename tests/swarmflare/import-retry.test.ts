import { afterEach, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';

let runtime: Miniflare | undefined;
afterEach(async () => { await runtime?.dispose(); runtime = undefined; });

it('allows an owner-only retry for a narrowly eligible failed import without creating another repository', async () => {
  const bundle = await build({ stdin: { contents: "export {Platform} from './apps/worker/src/platform/index';", resolveDir: process.cwd(), sourcefile: 'import-retry-test-entry.ts', loader: 'ts' }, bundle: true, platform: 'browser', format: 'esm', write: false, external: ['cloudflare:workers'], plugins: [{ name: 'synthetic-repository-source-for-retry-policy', setup(builder) {
    builder.onResolve({ filter: /repository-source/ }, () => ({ path: 'retry-source', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'ts', contents: `
      export async function provisionRepository(_binding, input) {
        if (input.importUrl === 'https://github.com/owner/repo') throw new Error('IMPORT_NOT_ALLOWED');
        return { status: 'ready', artifactsName: input.artifactsName, remote: 'https://github.com/owner/repo', ref: 'refs/heads/main', commitOid: 'commit', treeOid: 'tree' };
      }
      export async function readRepositorySource() { throw new Error('unused'); }
      export async function refreshRepository() { throw new Error('unused'); }
    ` }));
  } }] });
  runtime = new Miniflare(convertV4MiniflareOptions({ name: 'import-retry-test', modules: true, script: bundle.outputFiles[0]!.text, compatibilityDate: '2026-08-01', durableObjects: { PLATFORM: { className: 'Platform', useSQLite: true }, PROJECTS: { className: 'Platform', useSQLite: true } }, host: '127.0.0.1', port: 0 }));
  const origin = new URL((await runtime.ready).toString()).origin;
  const ns: any = await runtime.getDurableObjectNamespace('PLATFORM');
  const stub = ns.get(ns.idFromName('retry-test'));
  const call = (path: string, method = 'GET', body?: unknown, cookie?: string, csrf?: string, requestOrigin = origin) => stub.fetch(origin + '/api/platform' + path, { method, headers: { origin: requestOrigin, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const signup = async (username: string) => {
    const response = await call('/auth/signup', 'POST', { username, email: `${username}@example.test`, password: 'valid-secret-1' });
    const data: any = await response.json();
    return { cookie: response.headers.get('set-cookie')!.split(';')[0]!, csrf: data.csrf };
  };
  const owner = await signup('retry-owner');
  const outsider = await signup('retry-outsider');
  const created = await call('/repos', 'POST', { name: 'retry-repo', importUrl: 'https://github.com/owner/repo' }, owner.cookie, owner.csrf);
  expect(created.status).toBe(201);
  expect((await created.json() as any).repository).toMatchObject({ status: 'failed', error: 'IMPORT_NOT_ALLOWED' });

  expect((await call('/repos/retry-owner/retry-repo/retry', 'POST', { importUrl: 'https://github.com/owner/repo' })).status).toBe(403);
  expect((await call('/repos/retry-owner/retry-repo/retry', 'POST', { importUrl: 'https://github.com/owner/repo' }, outsider.cookie, outsider.csrf)).status).toBe(403);
  expect((await call('/repos/retry-owner/retry-repo/retry', 'POST', { importUrl: 'https://github.com/owner/repo' }, owner.cookie, owner.csrf, 'https://attacker.test')).status).toBe(403);
  for (const invalid of [{}, { importUrl: '' }, { importUrl: 'x'.repeat(513) }, { importUrl: 'https://github.com/owner/repo', name: 'replacement' }]) {
    expect((await call('/repos/retry-owner/retry-repo/retry', 'POST', invalid, owner.cookie, owner.csrf)).status).toBe(400);
  }
  const retried = await call('/repos/retry-owner/retry-repo/retry', 'POST', { importUrl: 'https://github.com/owner/repo-new' }, owner.cookie, owner.csrf);
  expect(retried.status).toBe(200);
  const repository = (await retried.json() as any).repository;
  expect(repository).toMatchObject({ status: 'ready', source: { ref: 'refs/heads/main', commitOid: 'commit', treeOid: 'tree' } });
  const list = await (await call('/repos')).json() as any;
  expect(list.repositories).toHaveLength(1);
  expect(list.repositories[0]).toMatchObject({ id: repository.id, projectId: repository.projectId, name: 'retry-repo' });
  expect((await call('/repos/retry-owner/retry-repo/retry', 'POST', { importUrl: 'https://github.com/owner/repo-new' }, owner.cookie, owner.csrf)).status).toBe(409);
});
