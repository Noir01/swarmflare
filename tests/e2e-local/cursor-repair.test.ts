import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { buildCursorRepair } from '../../demo/cloud/cursor-repair.js';
import { buildTenantRepair } from '../../demo/cloud/repair-fixture.js';
import { prepareRepository } from '../../demo/cloud/candidate-smoke.js';

let root = '';
let work = '';
let handler: (request: Request) => Promise<Response>;
let api: string;
let oldSource: string, newSource: string, original: any, repaired: any;
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'false', GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: '/dev/null', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'] }).trim();

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'cursor-test-'));
  const cache = join(root, 'cache.git');
  work = join(root, 'materialized');
  const seed = join(root, 'seed'); await mkdir(seed); git('init', seed);
  await writeFile(join(seed, 'README.md'), 'Synthetic baseline\n');
  git('-C', seed, 'add', '.'); git('-C', seed, 'commit', '-qm', 'Synthetic baseline');
  const base = git('-C', seed, 'rev-parse', 'HEAD'); git('clone', '--bare', seed, cache);
  const prepared = await prepareRepository(cache, join(root, 'prepared'), base);
  git('--git-dir='+cache, 'fetch', join(root, 'prepared'), prepared.commitOid);
  await mkdir(join(root, 'ui'));
  const ui = await buildTenantRepair({ cache, viewCommitOid: prepared.commitOid, baselineCommitOid: base, workDirectory: join(root, 'ui') });
  git('--git-dir='+cache, 'fetch', join(root, 'ui'), ui.commitOid);
  oldSource = await readFile(join(root, 'ui/demo/seed/index.ts'), 'utf8');
  original = await import(pathToFileURL(join(root, 'ui/demo/seed/index.ts')).href);
  const built = await buildCursorRepair({ cache, viewCommitOid: ui.commitOid, baselineCommitOid: base, workDirectory: work });
  expect(git('-C', work, 'rev-parse', 'HEAD')).toBe(built.commitOid);
  expect(git('-C', work, 'rev-parse', `${built.commitOid}^`)).toBe(base);
  expect(git('-C', work, 'rev-parse', 'HEAD^{tree}')).toBe(built.treeOid);
  newSource = await readFile(join(work, 'demo/seed/index.ts'), 'utf8');
  const moduleUrl = pathToFileURL(join(work, 'demo/seed/index.ts')).href;
  // Import TS source via project tsx loader is handled by the test runner.
  repaired = await import(moduleUrl);
  handler = repaired.createProjectListHandler();
  api = 'http://demo.invalid/api/projects?tenant=';
});

afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

it('authenticates page cursors and preserves legacy/order/tenant behavior', async () => {
  const before = original.createProjectListHandler();
  const oldPage = await (await before(new Request(api+'tenant-a&limit=1'))).json();
  const unsigned = JSON.parse(Buffer.from(oldPage.nextCursor, 'base64url').toString()); unsigned.offset=2;
  expect((await before(new Request(api+'tenant-a&limit=1&cursor='+Buffer.from(JSON.stringify(unsigned)).toString('base64url')))).status).toBe(200);
  const legacy = await (await handler(new Request(api + 'tenant-a'))).json();
  expect(Array.isArray(legacy)).toBe(true);
  const first = await (await handler(new Request(api + 'tenant-a&limit=1'))).json() as { items: {id:string}[]; nextCursor: string };
  const cursor = first.nextCursor as string;
  expect(cursor).toContain('.');
  const tamperedPayload = Buffer.from(cursor.split('.')[0], 'base64url').toString().replace('offset":1', 'offset":2');
  const tampered = Buffer.from(tamperedPayload).toString('base64url') + '.' + cursor.split('.')[1];
  expect((await handler(new Request(api + 'tenant-a&limit=1&cursor=' + tampered))).status).toBe(400);
  expect((await handler(new Request(api + 'tenant-b&limit=1&cursor=' + cursor))).status).toBe(400);
  const second = await handler(new Request(api + 'tenant-a&limit=1&cursor=' + cursor));
  expect(second.status).toBe(200);
  expect(((await second.json()) as {items: {id:string}[]}).items[0].id).not.toBe(first.items[0].id);
  expect((await handler(new Request(api + 'tenant-a&limit=1&cursor=eyJ0ZW5hbnQiOiJ0ZW5hbnQtYSIsIm9mZnNldCI6MX0'))).status).toBe(400);
  const source = await readFile(join(work, 'demo/seed/index.ts'), 'utf8');
  expect(source.slice(source.indexOf('export const html'))).not.toContain('randomBytes');
  expect(source.slice(source.indexOf('export const html'))).not.toContain('createHmac');
});

it('preserves complete ordered pagination and identical UI bytes with fresh server-only keys', async () => {
  const legacy:any[] = await (await handler(new Request(api+'tenant-a'))).json();
  for (const limit of [1,2,50]) {
    const ids:string[]=[]; let cursor:string|null=null, pages=0;
    do { const response=await handler(new Request(api+'tenant-a&limit='+limit+(cursor?'&cursor='+cursor:''))); expect(response.status).toBe(200); const page:any=await response.json(); ids.push(...page.items.map((x:any)=>x.id)); cursor=page.nextCursor; if(++pages>20)throw Error('PAGINATION_LOOP'); } while(cursor);
    expect(ids).toEqual(legacy.map(x=>x.id));
  }
  expect(newSource.slice(newSource.indexOf('export const html'))).toBe(oldSource.slice(oldSource.indexOf('export const html')));
  const page:any=await(await handler(new Request(api+'tenant-a&limit=1'))).json();
  expect((await repaired.createProjectListHandler()(new Request(api+'tenant-a&limit=1&cursor='+page.nextCursor))).status).toBe(400);
  expect(newSource).toContain('randomBytes(32)'); expect(repaired.html).not.toContain('createHmac'); expect(repaired.clientScript).not.toContain('randomBytes');
});

it('rejects unsigned, malformed, extra-field and signature-tampered cursors', async () => {
  const page:any=await(await handler(new Request(api+'tenant-a&limit=1'))).json(); const [payload,sig]=page.nextCursor.split('.');
  const extra=JSON.parse(Buffer.from(payload,'base64url').toString()); extra.extra=true;
  for(const cursor of ['bad','',payload,payload+'=',payload+'.'+(sig[0]==='a'?'b':'a')+sig.slice(1),Buffer.from(JSON.stringify(extra)).toString('base64url')+'.'+sig,page.nextCursor+'.extra'])expect((await handler(new Request(api+'tenant-a&limit=1&cursor='+encodeURIComponent(cursor)))).status).toBe(400);
  expect((await handler(new Request(api+'tenant-a&cursor='+page.nextCursor))).status).toBe(400);
});