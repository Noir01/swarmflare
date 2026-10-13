import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const PLATFORM_ORIGIN = 'https://git-collaboration-demo-c29.sriva140.workers.dev';
export const ACCOUNT_ID = 'cb50a73b7487ae7039cbc8b613986b8b';
export const WORKER_NAME = 'git-collaboration-demo-c29';
export const PRIVATE_PATH = resolve('.local/cloud-cont44/runner-private.json');
export const RECEIPT_PATH = resolve('reports/evaluation/continuous44-runner-smoke.json');
const PLATFORM_RECEIPT = resolve('reports/evaluation/continuous40-platform-smoke.json');
const phases = ['prepare', 'configure', 'probe'] as const;
const execFileAsync = promisify(execFile);
export type Phase = typeof phases[number];
export type RunnerState = { key: string; runnerToken?: string };
export type SafeEntry = { path: string; method: string; status: number; code: string | null };
export function parseMode(value: unknown): Phase { if (typeof value !== 'string' || !phases.includes(value as Phase)) throw new Error('mode'); return value as Phase; }
export function fixedPlatformUrl(path: string): string {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('\\') || /[?#\0]/.test(path)) throw new Error('url');
  const target=path.startsWith('/api/')?path:`/api/platform${path}`;
  return new URL(target, PLATFORM_ORIGIN).href;
}
function safeCode(data: any): string | null { return typeof data?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(data.code) ? data.code : null; }
export function requestClient(fetcher: typeof fetch, record: (entry: SafeEntry) => void | Promise<void> = () => {}, now: () => number = Date.now, budget = 16) {
  let count = 0;
  return async (path: string, options: { method?: string; body?: unknown; bearer?: string; expected?: number } = {}) => {
    if (++count > budget) throw new Error('request budget exceeded');
    const method = options.method ?? 'GET';
    const headers = new Headers();
    if (options.body !== undefined) headers.set('content-type', 'application/json');
    if (options.bearer) headers.set('authorization', `Bearer ${options.bearer}`);
    let response: Response;
    try {
      response = await fetcher(fixedPlatformUrl(path), { method, headers, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }), redirect: 'error', signal: AbortSignal.timeout(20_000) });
    } catch { const entry = { path, method, status: 0, code: 'NETWORK' }; await record(entry); throw Object.assign(new Error('request failed'), { safe: entry }); }
    let data: any = null; try { data = await response.json(); } catch { /* omit provider body */ }
    const entry = { path, method, status: response.status, code: safeCode(data) }; await record(entry);
    if (response.status !== (options.expected ?? 200)) throw Object.assign(new Error('request failed'), { safe: entry });
    return { response, data, now: now() };
  };
}
function validState(value: unknown): value is RunnerState { const state = value as RunnerState; return !!value && typeof value === 'object' && /^[a-f0-9]{64}$/.test(state.key) && (Object.keys(value as object).length === 1 || (Object.keys(value as object).length === 2 && typeof state.runnerToken === 'string' && /^sfr_[a-f0-9]{64}$/.test(state.runnerToken))); }
async function securePrivateDirectory(path = PRIVATE_PATH) {
  const dir = dirname(path);
  const components = dir.split('/').filter(Boolean); let current = dir.startsWith('/') ? '/' : '';
  for (const [index, component] of components.entries()) {
    current = current ? `${current}/${component}` : component;
    try { const entry = await lstat(current); if (!entry.isDirectory() || entry.isSymbolicLink() || (index === components.length - 1 && (entry.mode & 0o077) !== 0)) throw new Error('private directory permissions'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await mkdir(current, { mode: 0o700 }); }
  }
  try {
    const existing = await lstat(path);
    if (!existing.isFile() || existing.isSymbolicLink() || (existing.mode & 0o077) !== 0) throw new Error('private state permissions');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
export async function loadOrCreateState(path = PRIVATE_PATH): Promise<RunnerState> {
  await securePrivateDirectory(path);
  try {
    const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error('private state permissions');
    const state: unknown = JSON.parse(await readFile(path, 'utf8')); if (!validState(state)) throw new Error('private state invalid'); return state;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const state = { key: randomBytes(32).toString('hex') };
  await writeFile(path, JSON.stringify(state) + '\n', { mode: 0o600, flag: 'wx' }); await chmod(path, 0o600); return state;
}
async function savePrivateState(path: string, state: RunnerState) {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0) throw new Error('private state permissions');
  const handle = await open(path, constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW);
  try { await handle.chmod(0o600); await handle.writeFile(JSON.stringify(state) + '\n'); } finally { await handle.close(); }
}
async function writeReceipt(receipt: Record<string, unknown>, path = RECEIPT_PATH) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 }); await chmod(path, 0o600);
}
function initialReceipt(phase: Phase) { return { origin: PLATFORM_ORIGIN, accountId: ACCOUNT_ID, worker: WORKER_NAME, phase, provenance: 'not-established', results: [] as SafeEntry[], assertions: { sourceUnchanged: false, nativeSessionScope: false, noHumanActions: true } }; }

async function cloudflareRequest(fetcher: typeof fetch, token: string, path: string, init: RequestInit = {}, results: SafeEntry[] = [], record: (entry: SafeEntry) => void | Promise<void> = () => {}) {
  if (!path.startsWith(`/accounts/${ACCOUNT_ID}/workers/scripts/${WORKER_NAME}/`)) throw new Error('cloudflare path');
  let response: Response;
  try { response = await fetcher(`https://api.cloudflare.com/client/v4${path}`, { ...init, headers: new Headers({ authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers as HeadersInit ?? {}) }), redirect: 'error', signal: AbortSignal.timeout(20_000) }); }
  catch { const entry = { path, method: init.method ?? 'GET', status: 0, code: 'NETWORK' }; results.push(entry); await record(entry); throw Object.assign(new Error('configuration request failed'), { safe: entry }); }
  let data: any = null; try { data = await response.json(); } catch { /* no provider output */ }
  results.push({ path, method: init.method ?? 'GET', status: response.status, code: safeCode(data) });
  await record(results.at(-1)!);
  if (!response.ok || data?.success !== true) throw Object.assign(new Error('configuration request failed'), { safe: results.at(-1) });
  return data.result;
}
function bindingMetadata(settings: any): string {
  const bindings = settings?.bindings;
  if (!Array.isArray(bindings)) throw new Error('configuration readback invalid');
  return JSON.stringify(bindings.map((b: any) => ({ ...b })).filter((b: any) => b.name !== 'RUNNER_SERVICE_KEY').sort((a: any, b: any) => `${a.name}:${a.type}`.localeCompare(`${b.name}:${b.type}`)));
}
async function verifyExistingCloudflareAuth(check: () => Promise<string> = async () => {
  const executable = resolve(process.env.HOME ?? '', '.local/share/cf-cli/node_modules/.bin/cf');
  // This native cf version emits JSON by default; --json is not supported.
  const { stdout } = await execFileAsync(executable, ['auth', 'whoami'], { timeout: 20_000, maxBuffer: 64 * 1024, windowsHide: true });
  return stdout;
}): Promise<void> {
  let parsed: any;
  try { parsed = JSON.parse(await check()); } catch { throw new Error('authentication check failed'); }
  const accounts = Array.isArray(parsed?.accounts) ? parsed.accounts : [];
  if (parsed?.authenticated !== true || parsed?.tokenValid !== true || !accounts.some((account: any) => account?.id === ACCOUNT_ID)) throw new Error('authentication check failed');
}
async function loadCloudflareOAuth(): Promise<string> {
  const path = resolve(process.env.HOME ?? '', '.config/cloudflare/config/default.json');
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  const token = parsed?.oauth_token;
  if (typeof token !== 'string' || !token) throw new Error('configuration unavailable');
  return token;
}
export async function configureSecret(state: RunnerState, fetcher: typeof fetch = fetch, options: { checkAuth?: () => Promise<string>; loadToken?: () => Promise<string>; record?: (entry: SafeEntry) => void | Promise<void> } = {}) {
  if (!validState(state)) throw new Error('private state invalid');
  await verifyExistingCloudflareAuth(options.checkAuth);
  const token = await (options.loadToken ?? loadCloudflareOAuth)();
  const results: SafeEntry[] = [];
  const path = `/accounts/${ACCOUNT_ID}/workers/scripts/${WORKER_NAME}/settings`;
  const before = await cloudflareRequest(fetcher, token, path, {}, results, options.record);
  bindingMetadata(before);
  const secretPath = `/accounts/${ACCOUNT_ID}/workers/scripts/${WORKER_NAME}/secrets`;
  await cloudflareRequest(fetcher, token, secretPath, { method: 'PUT', body: JSON.stringify({ name: 'RUNNER_SERVICE_KEY', text: state.key, type: 'secret_text' }) }, results, options.record);
  const after = await cloudflareRequest(fetcher, token, path, {}, results, options.record);
  const bindings = Array.isArray(after?.bindings) ? after.bindings : [];
  const keyBinding = bindings.find((binding: any) => binding?.name === 'RUNNER_SERVICE_KEY' && binding?.type === 'secret_text');
  if (!keyBinding || bindingMetadata(after) !== bindingMetadata(before)) throw new Error('configuration readback mismatch');
  return { secretBinding: true, otherBindingsPreserved: true, results };
}

type Repo = { owner: string; name: string; projectId: string; status: string; source: { ref: string; commitOid: string; treeOid: string } };
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function readRepo(x: any): Repo {
  if (!x || typeof x !== 'object' || x.status !== 'ready' || typeof x.owner !== 'string' || !/^[a-z0-9-]{1,64}$/i.test(x.owner) || typeof x.name !== 'string' || !/^[a-z0-9-]{1,100}$/i.test(x.name) || !idPattern.test(x.projectId) || !x.source || typeof x.source.ref !== 'string' || !/^refs\/heads\/[A-Za-z0-9._/-]{1,100}$/.test(x.source.ref) || !/^[a-f0-9]{40}$/i.test(x.source.commitOid) || !/^[a-f0-9]{40}$/i.test(x.source.treeOid)) throw new Error('platform receipt invalid');
  return { owner: x.owner, name: x.name, projectId: x.projectId, status: x.status, source: { ref: x.source.ref, commitOid: x.source.commitOid, treeOid: x.source.treeOid } };
}
export function parseKnownRepositories(input: unknown): { created: Repo; imported: Repo } {
  const receipt = typeof input === 'string' ? JSON.parse(input) : input as any;
  if (!receipt || receipt.origin !== PLATFORM_ORIGIN || receipt.phase !== 'logout') throw new Error('platform receipt invalid');
  const created = readRepo(receipt.created), imported = readRepo(receipt.imported);
  if (created.projectId === imported.projectId) throw new Error('platform receipt invalid');
  return { created, imported };
}
function sameSource(actual: any, repo: Repo) { return actual?.ref === repo.source.ref && actual?.commitOid === repo.source.commitOid && actual?.treeOid === repo.source.treeOid; }
export async function probeRunner(state: RunnerState, fetcher: typeof fetch = fetch, clock: () => number = Date.now, privatePath = PRIVATE_PATH, receiptPath = RECEIPT_PATH, platformReceiptPath = PLATFORM_RECEIPT, provenance: 'native' | 'synthetic' = 'synthetic') {
  if (!validState(state)) throw new Error('private state invalid');
  const input = await readFile(platformReceiptPath, 'utf8');
  const { created, imported } = parseKnownRepositories(input);
  const receipt = initialReceipt('probe');
  receipt.provenance=provenance;
  const call = requestClient(fetcher, async entry => { receipt.results.push(entry); await writeReceipt(receipt,receiptPath); }, clock, 16);
  const catalog=(await call(`/repos/${created.owner}/${created.name}`)).data;
  if(catalog?.repository?.status!=='ready'||!sameSource(catalog.repository.source,created))throw new Error('source verification failed');
  const sourcePath = `/repos/${created.owner}/${created.name}/source`;
  const source = (await call(sourcePath)).data;
  if (source?.commitOid!==created.source.commitOid||source?.treeOid!==created.source.treeOid) throw new Error('source verification failed');
  const createPath = `/runner/sessions`;
  const issued = await call(createPath, { method: 'POST', bearer: state.key, body: { projectId: created.projectId, expiresInSeconds: 30, maxOperations: 3 }, expected: 201 });
  const runnerToken = issued.data?.token;
  if (typeof runnerToken !== 'string' || !/^sfr_[a-f0-9]{64}$/.test(runnerToken)) throw new Error('runner session invalid');
  state.runnerToken = runnerToken; await savePrivateState(privatePath, state);
  const contextPath = `/api/v1/projects/${created.projectId}/context`;
  await call(contextPath, { bearer: runnerToken });
  await call(`/api/v1/projects/${imported.projectId}/context`, { bearer: runnerToken, expected: 403 });
  await call(`/api/v1/projects/${created.projectId}/baseline/initialize`, { method: 'POST', bearer: runnerToken, body: {}, expected: 403 });
  const one = await call(createPath, { method: 'POST', bearer: state.key, body: { projectId: created.projectId, expiresInSeconds: 30, maxOperations: 1 }, expected: 201 });
  const oneToken = one.data?.token;
  if (typeof oneToken !== 'string' || !/^sfr_[a-f0-9]{64}$/.test(oneToken)) throw new Error('runner session invalid');
  state.runnerToken = oneToken; await savePrivateState(privatePath, state);
  await call(contextPath, { bearer: oneToken });
  await call(contextPath, { bearer: oneToken, expected: 403 });
  await call(createPath, { method: 'POST', bearer: '0'.repeat(64), body: { projectId: created.projectId, expiresInSeconds: 30, maxOperations: 3 }, expected: 403 });
  const catalogAfter=(await call(`/repos/${created.owner}/${created.name}`)).data;
  const sourceAfter=(await call(sourcePath)).data;
  if(catalogAfter?.repository?.status!=='ready'||!sameSource(catalogAfter.repository.source,created)||sourceAfter?.commitOid!==created.source.commitOid||sourceAfter?.treeOid!==created.source.treeOid)throw new Error('source verification failed');
  receipt.assertions.sourceUnchanged = true;
  receipt.provenance = provenance;
  receipt.assertions.nativeSessionScope = provenance === 'native';
  receipt.assertions.noHumanActions = true;
  await writeReceipt(receipt, receiptPath);
  return receipt;
}

export async function runMode(mode: Phase, options: { fetcher?: typeof fetch; clock?: () => number } = {}) {
  const fetcher = options.fetcher ?? fetch;
  if (mode === 'prepare') {
    const state = await loadOrCreateState();
    const receipt = initialReceipt('prepare'); receipt.assertions.noHumanActions = true;
    await writeReceipt(receipt);
    return { prepared: true, keyPresent: state.key.length === 64 };
  }
  const state = await loadOrCreateState();
  if (mode === 'configure') {
    const receipt = initialReceipt('configure'); receipt.assertions.noHumanActions = true;
    const result = await configureSecret(state, fetcher, { record: async entry => { receipt.results.push(entry); await writeReceipt(receipt); } });
    (receipt.assertions as any).secretBinding = result.secretBinding; (receipt.assertions as any).otherBindingsPreserved = result.otherBindingsPreserved;
    await writeReceipt(receipt); return receipt;
  }
  return probeRunner(state, fetcher, options.clock, PRIVATE_PATH, RECEIPT_PATH, PLATFORM_RECEIPT, fetcher === fetch ? 'native' : 'synthetic');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runMode(parseMode(process.argv[2])); }
  catch (error) { const safe = (error as any)?.safe; process.stderr.write(JSON.stringify(safe ?? { phase: 'runner-smoke', path: '', status: 0, code: 'FAILED' }) + '\n'); process.exitCode = 1; }
}
