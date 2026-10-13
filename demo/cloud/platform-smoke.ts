import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLATFORM_ORIGIN = 'https://git-collaboration-demo-c29.sriva140.workers.dev';
const PRIVATE = resolve('.local/cloud-cont40/platform-smoke-private.json');
const RECEIPT = resolve('reports/evaluation/continuous40-platform-smoke.json');
const phases = ['auth', 'create', 'import', 'grants', 'logout'] as const;
export type Phase = typeof phases[number];
type State = { identity: { username: string; email: string; password: string }; identityRegistered?: boolean; cookie: string; csrf: string; owner?: any; created?: any; imported?: any; grant?: any; outsider?: any; results: any[] };
export function parsePhase(value: unknown): Phase { if (typeof value !== 'string' || !phases.includes(value as Phase)) throw new Error('phase'); return value as Phase; }
export function checkedPlatformUrl(path: string): string { if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || /[?#\0]/.test(path)) throw new Error('url'); if (/^\/api\/v1\/projects\/[A-Za-z0-9_-]{1,120}\//.test(path)) return new URL(path, PLATFORM_ORIGIN).href; return new URL(`/api/platform${path}`, PLATFORM_ORIGIN).href; }
export function requestClient(fetcher: typeof fetch, onResult: (entry: any) => Promise<void> = async () => {}) {
  let requests = 0;
  return async (path: string, options: { method?: string; cookie?: string; csrf?: string; body?: unknown; bearer?: string; expected?: number } = {}) => {
    if (++requests > 30) throw new Error('request budget exceeded');
    const method = options.method ?? 'GET';
    const headers = new Headers({ origin: PLATFORM_ORIGIN });
    if (options.body !== undefined) headers.set('content-type', 'application/json');
    if (options.cookie) headers.set('cookie', options.cookie);
    if (options.csrf) headers.set('x-csrf-token', options.csrf);
    if (options.bearer) headers.set('authorization', `Bearer ${options.bearer}`);
    let response: Response;
    try { response = await fetcher(checkedPlatformUrl(path), { method, headers, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }), redirect: 'error', signal: AbortSignal.timeout(20_000) }); }
    catch { throw Object.assign(new Error('request failed'), { safe: { phase: 'request', path, status: 0, code: 'NETWORK' } }); }
    let data: any = null; try { data = await response.json(); } catch { /* response body is never surfaced */ }
    const entry = { path, method, status: response.status, code: typeof data?.code === 'string' ? data.code : null };
    await onResult(entry);
    if (response.status !== (options.expected ?? 200)) throw Object.assign(new Error('request failed'), { safe: entry });
    return { response, data };
  };
}
async function main(phase: Phase) {
  await mkdir(dirname(PRIVATE), { recursive: true, mode: 0o700 }); await mkdir(dirname(RECEIPT), { recursive: true });
  let state: State;
  try { state = JSON.parse(await readFile(PRIVATE, 'utf8')); } catch {
    const salt = randomBytes(18).toString('hex');
    state = { identity: { username: `smoke-${salt.slice(0, 20)}`, email: `smoke-${salt}@example.test`, password: randomBytes(32).toString('base64url') }, cookie: '', csrf: '', results: [] };
    await writeFile(PRIVATE, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
  }
  const record = async (entry: any) => { state.results.push(entry); await save(state); };
  const call = requestClient(fetch, record);
  const save = async (s: State) => { await writeFile(RECEIPT, JSON.stringify({ origin: PLATFORM_ORIGIN, phase, results: s.results, owner: safeRepo(s.owner), created: safeRepo(s.created), imported: safeRepo(s.imported), grant: s.grant ? { id: s.grant.grant?.id, expiresAt: s.grant.grant?.expiresAt } : undefined, outsider: safeRepo(s.outsider) }, null, 2) + '\n', { mode: 0o600 }); await writeFile(PRIVATE, JSON.stringify(s), { mode: 0o600 }); await chmod(PRIVATE, 0o600); };
  const auth = (data: any, response: Response) => { state.csrf = data.csrf; state.cookie = response.headers.get('set-cookie')?.split(';')[0] ?? ''; if (!state.csrf || !state.cookie) throw new Error('auth'); };
  const session = { cookie: state.cookie, csrf: state.csrf };
  if (phase === 'auth') {
    const x = state.identityRegistered
      ? await call('/auth/login', { method: 'POST', body: { login: state.identity.email, password: state.identity.password } })
      : await call('/auth/signup', { method: 'POST', body: state.identity, expected: 201 });
    auth(x.data, x.response);state.identityRegistered=true;await save(state);
    const current = await call('/auth/session', { cookie: state.cookie }); if (current.data.user?.username !== state.identity.username) throw new Error('session');
    await call('/auth/logout', { method: 'POST', body: {}, cookie: state.cookie, csrf: state.csrf }); state.cookie = ''; state.csrf = '';
    const revoked=await call('/auth/session');if(revoked.data.user!==null)throw new Error('logout readback');
    const login = await call('/auth/login', { method: 'POST', body: { login: state.identity.email, password: state.identity.password } }); auth(login.data, login.response);
    await call('/auth/session', { cookie: state.cookie });
  } else {
    if (!state.cookie || !state.csrf) throw new Error('run auth phase first');
    if (phase === 'create') {
      if (state.created) throw new Error('create mapping already exists; refusing duplicate');
      const description = 'Synthetic bounded platform smoke';
      const r = await call('/repos', { method: 'POST', ...session, body: { name: `probe-${randomBytes(5).toString('hex')}`, description, initializeReadme: true }, expected: 201 }); state.created = r.data.repository; state.owner = { username: state.identity.username }; await save(state); await assertSource(call, state.created, `# ${state.created.name}\n\n${description}\n`);
    } else if (phase === 'import') {
      if (state.imported) {
        if(state.imported.status==='failed'&&['IMPORT_NOT_ALLOWED','IMPORT_SOURCE_UNAVAILABLE'].includes(state.imported.error)){
          const r=await call(`/repos/${state.imported.owner}/${state.imported.name}/retry`,{method:'POST',...session,body:{importUrl:'https://github.com/octocat/Hello-World'}});state.imported=r.data.repository;await save(state);
        } else if(state.imported.status!=='ready'&&state.imported.status!=='importing')throw new Error('import cannot be retried safely');
      } else {
        const r = await call('/repos', { method: 'POST', ...session, body: { name: `import-${randomBytes(5).toString('hex')}`, description: 'Synthetic public import probe', importUrl: 'https://github.com/octocat/Hello-World' }, expected: 201 }); state.imported = r.data.repository;await save(state);
      }
      for (let n = 0; state.imported.status === 'importing' && n < 5; n++) { await new Promise(resolve=>setTimeout(resolve,500));const selectInitialBranch=state.imported.source?.ref==='refs/heads/main'&&!state.imported.source?.commitOid&&!state.imported.source?.treeOid;const x = await call(`/repos/${state.imported.owner}/${state.imported.name}/refresh`, { method: 'POST', ...session,body:selectInitialBranch?{ref:'refs/heads/master'}:{} }); state.imported = x.data.repository;await save(state); }
      if (state.imported.status !== 'ready') throw new Error('import pending or failed');
      const source = await call(`/repos/${state.imported.owner}/${state.imported.name}/source`); if (source.data.commitOid !== state.imported.source?.commitOid || source.data.treeOid !== state.imported.source?.treeOid) throw new Error('source mismatch');
    } else if (phase === 'grants') {
      const repo = state.created; if (!repo) throw new Error('run create first');
      state.grant = (await call(`/repos/${repo.owner}/${repo.name}/agents`, { method: 'POST', ...session, body: { role: 'contributor', expiresInSeconds: 600 }, expected: 201 })).data;
      if (state.grant.grant?.role !== 'contributor' || state.grant.grant.expiresAt < Date.now() + 590_000 || state.grant.grant.expiresAt > Date.now() + 610_000) throw new Error('grant scope/expiry mismatch');
      const own = await call('/agent/session', { bearer: state.grant.token }); if (own.data.actor?.id !== state.grant.grant.id || own.data.repository?.id !== repo.id) throw new Error('grant mismatch');
      const mutation = { requestId: `smoke-${randomBytes(12).toString('hex')}`, payload: { obligationIds: ['smoke-readme'], areas: ['platform-smoke'], status: 'working' } };
      const ownWrite = await call(`/api/v1/projects/${repo.projectId}/claims`, { method: 'POST', bearer: state.grant.token, body: mutation, expected: 201 });
      const context = await call(`/api/v1/projects/${repo.projectId}/context`, { bearer: state.grant.token }); if (!(context.data.resource?.claims ?? []).some((x: any) => x.id === ownWrite.data.resource.id && x.owner === state.grant.grant.id)) throw new Error('scoped claim readback mismatch');
      const outsider = (await call(`/repos/${repo.owner}/${repo.name}/agents`, { method: 'POST', body: { role: 'contributor', expiresInSeconds: 600 }, expected: 403 })).data; state.outsider = { status: 403 };
      const other = state.imported; if (other) await call(`/api/v1/projects/${other.projectId}/claims`, { method: 'POST', bearer: state.grant.token, body: mutation, expected: 403 });
      await call(`/api/v1/projects/${repo.projectId}/acceptances`, { method: 'POST', bearer: state.grant.token, body: { requestId: `forged-${randomBytes(12).toString('hex')}`, payload: {} }, expected: 403 });
      await call(`/repos/${repo.owner}/${repo.name}/agents/${state.grant.grant.id}`, { method: 'DELETE', ...session, body: {} }); await call('/agent/session', { bearer: state.grant.token, expected: 401 });
      await call(`/api/v1/projects/${repo.projectId}/claims`, { method: 'POST', bearer: state.grant.token, body: mutation, expected: 403 });
    } else {
      await call('/auth/logout', { method: 'POST', body: {}, ...session }); state.cookie = ''; state.csrf = ''; await call('/auth/session');
    }
  }
  await save(state);
}
async function assertSource(call: ReturnType<typeof requestClient>, repo: any, expected: string) {
  if (repo.status !== 'ready') throw new Error('repository failed or pending');
  const source = await call(`/repos/${repo.owner}/${repo.name}/source`);
  if (source.data.commitOid !== repo.source?.commitOid || source.data.treeOid !== repo.source?.treeOid || source.data.readme !== expected) throw new Error('source mismatch');
}
function safeRepo(repo: any) { return repo ? { id: repo.id, owner: repo.owner, name: repo.name, projectId: repo.projectId, status: repo.status, error: repo.error, source: repo.source && { ref: repo.source.ref, commitOid: repo.source.commitOid, treeOid: repo.source.treeOid } } : undefined; }
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(parsePhase(process.argv[2])).catch(error => { const safe = (error as any)?.safe; process.stderr.write(JSON.stringify(safe ?? { phase: 'setup', path: '', status: 0, code: 'FAILED' }) + '\n'); process.exitCode = 1; });
