import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ACCOUNT_ID, PLATFORM_ORIGIN, WORKER_NAME, configureSecret, fixedPlatformUrl, loadOrCreateState, parseKnownRepositories, parseMode, probeRunner, requestClient } from '../../demo/cloud/runner-smoke.js';

const sourceA = { ref: 'refs/heads/main', commitOid: 'a'.repeat(40), treeOid: 'b'.repeat(40) };
const sourceB = { ref: 'refs/heads/master', commitOid: 'c'.repeat(40), treeOid: 'd'.repeat(40) };
const platformReceipt = { origin: PLATFORM_ORIGIN, phase: 'logout', created: { owner: 'owner-a', name: 'repo-a', projectId: 'fc34f086-87da-4067-a648-484af2297bd7', status: 'ready', source: sourceA }, imported: { owner: 'owner-b', name: 'repo-b', projectId: '1f337519-a35f-4ef6-92d5-c8dd51f36145', status: 'ready', source: sourceB } };
const secret = 'a'.repeat(64);
const runnerToken = `sfr_${'e'.repeat(64)}`;
const tempDirs: string[] = [];
async function temp() { const dir = await mkdtemp(join(tmpdir(), 'runner-smoke-')); tempDirs.push(dir); return dir; }
afterEach(async () => { const { rm } = await import('node:fs/promises'); await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('continuous44 native runner helper safety', () => {
  it('accepts only fixed one-shot modes and fixed HTTPS service paths', () => {
    expect(parseMode('prepare')).toBe('prepare'); expect(parseMode('configure')).toBe('configure'); expect(parseMode('probe')).toBe('probe');
    for (const invalid of ['https://attacker.test', 'account', 'worker', 'source', 'job', '', undefined]) expect(() => parseMode(invalid)).toThrow();
    expect(ACCOUNT_ID).toBe('cb50a73b7487ae7039cbc8b613986b8b'); expect(WORKER_NAME).toBe('git-collaboration-demo-c29');
    expect(fixedPlatformUrl('/api/platform/runner/sessions')).toBe(`${PLATFORM_ORIGIN}/api/platform/runner/sessions`);
    expect(fixedPlatformUrl('/runner/sessions')).toBe(`${PLATFORM_ORIGIN}/api/platform/runner/sessions`);
    for (const path of ['//attacker.test/x', 'https://attacker.test', '/x\\@attacker.test', '/x?y=z']) expect(() => fixedPlatformUrl(path)).toThrow();
  });
  it('strictly accepts only the known sanitized ready source mappings', () => {
    expect(parseKnownRepositories(platformReceipt).created.projectId).toBe(platformReceipt.created.projectId);
    expect(() => parseKnownRepositories({ ...platformReceipt, origin: 'https://attacker.test' })).toThrow();
    expect(() => parseKnownRepositories({ ...platformReceipt, created: { ...platformReceipt.created, status: 'importing' } })).toThrow();
  });
  it('keeps provider errors and bearer secrets out of safe receipts', async () => {
    const entries: unknown[] = [];
    const call = requestClient(async (_url, init) => {
      expect(init?.redirect).toBe('error'); expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${secret}`);
      return new Response(JSON.stringify({ code: 'FORBIDDEN', message: `sensitive ${secret}` }), { status: 403 });
    }, entry => { entries.push(entry); });
    await expect(call('/runner/sessions', { method: 'POST', bearer: secret, body: { projectId: platformReceipt.created.projectId } })).rejects.toMatchObject({ safe: { status: 403, code: 'FORBIDDEN' } });
    expect(JSON.stringify(entries)).not.toContain(secret); expect(JSON.stringify(entries)).not.toContain('sensitive');
    await expect(requestClient(async () => { throw new Error(`Bearer ${secret}`); })('/runner/sessions')).rejects.toMatchObject({ safe: { code: 'NETWORK', status: 0 } });
  });
  it('creates and reuses only mode-0600 private key state without overwriting', async () => {
    const dir = await temp(), path = join(dir, '.local/cloud-cont44/runner-private.json');
    const first = await loadOrCreateState(path), second = await loadOrCreateState(path);
    expect(first).toEqual(second); expect(first.key).toMatch(/^[a-f0-9]{64}$/);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const original = await readFile(path, 'utf8');
    expect(await readFile(path, 'utf8')).toBe(original);
  });
  it('tests source invariance and scoped sessions with a synthetic fetch only', async () => {
    const dir = await temp(), privatePath = join(dir, 'runner-private.json'), receiptPath = join(dir, 'receipt.json'), inputPath = join(dir, 'platform.json');
    await writeFile(inputPath, JSON.stringify(platformReceipt)); await writeFile(privatePath, JSON.stringify({ key: secret }), { mode: 0o600 });
    const seen: Array<{ path: string; method: string; token?: string; body?: any }> = [];
    let oneUseContextCount = 0;
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input)); expect(url.origin).toBe(PLATFORM_ORIGIN); expect(init?.redirect).toBe('error');
      const path = url.pathname.replace('/api/platform', ''); const method = init?.method ?? 'GET';
      const token = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '');
      let body: any; if (typeof init?.body === 'string') body = JSON.parse(init.body);
      seen.push({ path, method, token, body });
      if (path === '/repos/owner-a/repo-a') return Response.json({repository:platformReceipt.created});
      if (path === '/repos/owner-a/repo-a/source') return Response.json({commitOid:sourceA.commitOid,treeOid:sourceA.treeOid,entries:[]});
      if (path === '/runner/sessions' && token === secret) return new Response(JSON.stringify({ token: runnerToken }), { status: 201 });
      if (path === '/runner/sessions' && token === '0'.repeat(64)) return new Response(JSON.stringify({ code: 'FORBIDDEN', message: secret }), { status: 403 });
      if (path.endsWith('/context')) {
        if (token !== runnerToken || !path.includes(platformReceipt.created.projectId)) return new Response(JSON.stringify({ code: 'FORBIDDEN' }), { status: 403 });
        if (seen.filter(item => item.path.endsWith('/runner/sessions') && item.body?.maxOperations === 1).length && ++oneUseContextCount > 1) return new Response(JSON.stringify({ code: 'FORBIDDEN' }), { status: 403 });
        return new Response('{}', { status: 200 });
      }
      if (path.endsWith('/baseline/initialize')) return new Response(JSON.stringify({ code: 'FORBIDDEN' }), { status: 403 });
      throw new Error('unexpected synthetic request');
    };
    const result = await probeRunner({ key: secret }, fetcher, () => 1000, privatePath, receiptPath, inputPath, 'synthetic');
    expect(result.assertions).toEqual({ sourceUnchanged: true, nativeSessionScope: false, noHumanActions: true });
    expect(result.provenance).toBe('synthetic');
    expect(result.results).toHaveLength(12);
    expect(result.results.map(entry => [entry.method, entry.status])).toEqual([['GET',200],['GET',200],['POST',201],['GET',200],['GET',403],['POST',403],['POST',201],['GET',200],['GET',403],['POST',403],['GET',200],['GET',200]]);

    expect(seen.filter(item => item.path === '/runner/sessions').every(item => item.body?.projectId === platformReceipt.created.projectId && item.body?.expiresInSeconds === 30 && [1,3].includes(item.body?.maxOperations))).toBe(true);
    expect(seen.filter(item => item.method === 'POST').every(item => item.path === '/runner/sessions' || item.path.endsWith('/baseline/initialize'))).toBe(true);
    const serialized = JSON.stringify(result); expect(serialized).not.toContain(secret); expect(serialized).not.toContain(runnerToken);
    const written = await readFile(receiptPath, 'utf8'); expect(written).not.toContain(secret); expect(written).not.toContain(runnerToken); expect(written).not.toContain('message');
    expect((await readFile(privatePath, 'utf8'))).toContain(runnerToken); expect((await stat(privatePath)).mode & 0o777).toBe(0o600);
  });
  it('configures only after exact-account auth and verifies settings without exposing secrets', async () => {
    const names = ['Project', 'Platform', 'Artifacts'];
    const bindings = names.map(name => ({ name, type: 'durable_object_namespace', namespace_id: `${name}-id`, class_name: name }));
    const calls: Array<{ method: string; body?: any }> = [];
    let current: any[] = bindings;
    const fetcher: typeof fetch = async (_input, init) => {
      const method = init?.method ?? 'GET'; let body: any;
      if (typeof init?.body === 'string') body = JSON.parse(init.body);
      calls.push({ method, body });
      if (method === 'PUT') { current = [...current, { name: body.name, type: body.type }]; return Response.json({ success: true, result: {} }); }
      return Response.json({ success: true, result: { bindings: current } });
    };
    let checked = false;
    const result = await configureSecret({ key: secret }, fetcher, {
      checkAuth: async () => { checked = true; return JSON.stringify({ authenticated: true, tokenValid: true, accounts: [{ id: ACCOUNT_ID }] }); },
      loadToken: async () => { expect(checked).toBe(true); return 'synthetic-oauth'; }
    });
    expect(calls.map(call => call.method)).toEqual(['GET', 'PUT', 'GET']);
    expect(calls[1]?.body).toEqual({ name: 'RUNNER_SERVICE_KEY', text: secret, type: 'secret_text' });
    expect(result.otherBindingsPreserved).toBe(true);
    expect(JSON.stringify(result)).not.toContain(secret);
    await expect(configureSecret({ key: secret }, fetcher, { checkAuth: async () => JSON.stringify({ authenticated: true, tokenValid: true, accounts: [{ id: 'wrong' }] }), loadToken: async () => { throw new Error('must not load'); } })).rejects.toThrow('authentication check failed');
    await expect(configureSecret({ key: secret }, fetcher, { checkAuth: async () => { throw new Error(secret); }, loadToken: async () => { throw new Error('must not load'); } })).rejects.toThrow('authentication check failed');
  });
  it('surfaces failed settings readback as safe status metadata', async () => {
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls++;
      if (calls === 1) return Response.json({ success: true, result: { bindings: [] } });
      if (calls === 2) return Response.json({ success: true, result: {} });
      return Response.json({ success: false, errors: [{ code: 'READBACK_FAILED', message: secret }] }, { status: 503 });
    };
    const safe: unknown[] = [];
    await expect(configureSecret({ key: secret }, fetcher, { checkAuth: async () => JSON.stringify({ authenticated: true, tokenValid: true, accounts: [{ id: ACCOUNT_ID }] }), loadToken: async () => 'synthetic-oauth', record: entry => { safe.push(entry); } })).rejects.toMatchObject({ safe: { status: 503, code: null } });
    expect(JSON.stringify(safe)).not.toContain(secret);
  });
});
