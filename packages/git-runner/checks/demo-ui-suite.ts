import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, open, realpath, writeFile, chmod, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runSandboxedNode, type SandboxExecution } from './sandbox.js';
import { applicabilitySchema, type Applicability } from '../../contracts/index.js';
import type { DemoCheckReceipt } from './demo-suite.js';
import { launchIsolatedBrowser } from '../../browser-test/isolated.js';
import { trustedSourceArtifactDigest } from './trusted-source-digest.js';

const driverName = '.trusted-demo-ui-driver.mjs';
const checkId = 'mandatory-demo-ui';
const obligationIds = ['ui-navigation', 'ui-tenant-switch'];
const harnessVersion = 'json-oracle-v1' as const;
const deniedDirectories = new Set(['.git', '.ssh', '.aws', '.config', '.gnupg', '.hermes', '.npm']);
const deniedFile = /^(?:\.env(?:\..*)?|.*(?:credential|secret|private[-_]?key.*))$/i;
const driver = `
const write = process.stdout.write.bind(process.stdout);
const mode = process.argv[2];
const {html, clientScript, createProjectListHandler} = await import('./demo/seed/index.ts');
if (mode !== 'record') throw new Error('invalid mode');
const handler = createProjectListHandler(), records = {};
for (const tenant of ['tenant-a','tenant-b']) {
  let cursor = null; const seen = new Set();
  for (let page = 0; page < 6; page++) {
    const q = new URLSearchParams({tenant,limit:'2'}); if (cursor !== null) q.set('cursor',cursor);
    const url = 'http://demo.invalid/api/projects?' + q.toString();
    const response = await handler(new Request(url)); const body = await response.text();
    if (response.status !== 200 || body.length > 8192) { records[new URL(url).pathname + '?' + new URL(url).searchParams.toString()] = {status:response.status,body}; break; }
    const parsed = JSON.parse(body), next = parsed?.nextCursor ?? null;
    if (next !== null && (typeof next !== 'string' || next.length > 2048 || seen.has(next) || page === 5)) throw new Error('invalid cursor traversal');
    const key = new URL(url).pathname + '?' + [...new URL(url).searchParams.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>encodeURIComponent(k)+'='+encodeURIComponent(v)).join('&');
    if (records[key]) throw new Error('duplicate request record'); records[key] = {status:response.status,body};
    if (next === null) break; seen.add(next); cursor = next;
  }
}
write(JSON.stringify({html, clientScript, records}));
`;
const csp = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
const htmlHeaders = [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }, { name: 'Content-Security-Policy', value: csp }];
const scriptHeaders = [{ name: 'Content-Type', value: 'text/javascript; charset=utf-8' }, { name: 'Content-Security-Policy', value: csp }];
const maxOutput = 32768;

async function copyCandidate(source: string, destination: string, state: { files: number; bytes: number }, depth = 0): Promise<void> {
  if (depth > 32) throw new Error('Candidate exceeds maximum snapshot depth');
  for (const name of await readdir(source)) {
    if (deniedDirectories.has(name.toLowerCase()) || deniedFile.test(name)) continue;
    if (name === driverName) throw new Error('Candidate collides with reserved trusted demo UI driver');
    const from = join(source, name), to = join(destination, name), st = await lstat(from);
    if (st.isSymbolicLink()) throw new Error('Candidate contains a symlink');
    if (st.isDirectory()) { await mkdir(to, { mode: 0o755 }); await copyCandidate(from, to, state, depth + 1); await chmod(to, 0o555); }
    else if (st.isFile()) {
      if (++state.files > 1000 || st.size > 4 * 1024 * 1024 || state.bytes + st.size > 20 * 1024 * 1024) throw new Error('Candidate exceeds snapshot size limits');
      const handle = await open(from, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes: Buffer;
      try {
        const fresh = await handle.stat();
        if (!fresh.isFile() || fresh.ino !== st.ino || fresh.dev !== st.dev) throw new Error('Candidate changed during snapshot');
        const chunks: Buffer[] = []; let total = 0;
        while (true) { const chunk = Buffer.alloc(65536); const { bytesRead } = await handle.read(chunk, 0, chunk.length, null); if (!bytesRead) break; total += bytesRead; if (total > 4 * 1024 * 1024 || state.bytes + total > 20 * 1024 * 1024) throw new Error('Candidate exceeds snapshot size limits'); chunks.push(chunk.subarray(0, bytesRead)); }
        bytes = Buffer.concat(chunks, total);
      } finally { await handle.close(); }
      state.bytes += bytes.length; await mkdir(dirname(to), { recursive: true, mode: 0o755 }); await writeFile(to, bytes, { mode: 0o444 });
    } else throw new Error('Candidate contains a non-regular file');
  }
}
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const expected = {
  'tenant-a': ['a-project-01', 'a-project-02', 'a-project-03'],
  'tenant-b': ['b-project-01', 'b-project-02'],
};
const controlContract = { tenant: '#tenant', rows: '#projects [data-project-id]', next: '#next-page', status: '#status', pageSize: 2 };
function evaluate(observations: any): boolean {
  const events = observations.events;
  if (!Array.isArray(events) || observations.requestCount > 20) return false;
  const matches = (event: any, tenant: string, ids: string[], cursor: string | null, domIds: string[], disabled: boolean) => event?.status === 200 && event?.tenant === tenant && JSON.stringify(event.ids) === JSON.stringify(ids) && event.cursor === cursor && JSON.stringify(event.dom?.ids) === JSON.stringify(domIds) && event.dom?.nextDisabled === disabled;
  return matches(events[0], 'tenant-a', expected['tenant-a'].slice(0, 2), null, expected['tenant-a'].slice(0, 2), false) &&
    typeof events[0]?.nextCursor === 'string' && events[0].nextCursor.length > 0 &&
    matches(events[1], 'tenant-a', expected['tenant-a'].slice(2), events[0].nextCursor, expected['tenant-a'].slice(2), true) &&
    matches(events[2], 'tenant-b', expected['tenant-b'], null, expected['tenant-b'], true) &&
    matches(events[3], 'tenant-a', expected['tenant-a'].slice(0, 2), null, expected['tenant-a'].slice(0, 2), false) &&
    matches(events[4], 'tenant-b', expected['tenant-b'], null, expected['tenant-b'], true) &&
    matches(events[5], 'tenant-a', expected['tenant-a'].slice(0, 2), null, expected['tenant-a'].slice(0, 2), false) && events.length === 6;
}
export function demoUiSuiteDigest(): string {
  return trustedSourceArtifactDigest(new URL('./demo-ui-suite.ts', import.meta.url));
}

export async function runDemoUiSuite(options: { candidateDirectory: string; applicability: Applicability }): Promise<DemoCheckReceipt[]> {
  const startedAt = new Date().toISOString();
  const deadline = Date.now() + 40000;
  const remaining = (cap: number) => Math.max(1, Math.min(cap, deadline - Date.now()));
  const assertTime = () => { if (Date.now() >= deadline) { timedOut = true; throw new Error('UI suite timed out'); } };
  const applicability = applicabilitySchema.parse(options.applicability);
  if (applicability.checkSuiteDigest !== demoUiSuiteDigest()) throw new Error('Applicability check suite digest does not match trusted demo UI suite');
  const source = await realpath(options.candidateDirectory);
  const root = await mkdtemp(join(tmpdir(), 'git-runner-demo-ui-'));
  let browser: Awaited<ReturnType<typeof launchIsolatedBrowser>> | undefined;
  let snapshotTask: Promise<void> | undefined;
  const apiTasks = new Set<Promise<void>>();
  const facts: any = { events: [], requests: [], requestCount: 0, failures: [] };
  let closing = false;
  let requestTail: Promise<void> = Promise.resolve();
  let timedOut = false;
  let overall: ReturnType<typeof setTimeout> | undefined;
  try {
    assertTime();
    const stat = await lstat(options.candidateDirectory);
    if (stat.isSymbolicLink()) throw new Error('Candidate directory must not be a symlink');
    const staged = join(root, 'candidate'); await mkdir(staged, { mode: 0o755 });
    snapshotTask = copyCandidate(source, staged, { files: 0, bytes: 0 });
    let snapshotTimer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([snapshotTask, new Promise((_, reject) => { snapshotTimer = setTimeout(() => { timedOut = true; reject(new Error('UI suite timed out')); }, remaining(40000)); })]); }
    finally { if (snapshotTimer) clearTimeout(snapshotTimer); }
    const entry = join(staged, 'demo/seed/index.ts');
    if (!(await lstat(entry)).isFile()) throw new Error('Candidate must provide regular demo/seed/index.ts');
    await writeFile(join(staged, driverName), driver, { mode: 0o444 }); await chmod(staged, 0o555);
    const assetsExec = await runSandboxedNode({ candidateDirectory: staged, entrypoint: driverName, args: ['record'], timeoutMs: remaining(3000), maxOutputBytes: maxOutput });
    if (assetsExec.status !== 'exited' || assetsExec.exitCode !== 0) throw new Error('Candidate UI asset extraction failed');
    const assets = JSON.parse(assetsExec.stdout) as { html: string; clientScript: string; records: Record<string,{status:number;body:string}> };
    if (typeof assets.html !== 'string' || assets.html.length > 16384 || typeof assets.clientScript !== 'string' || assets.clientScript.length > 16384 || !assets.records || Object.keys(assets.records).length > 12) throw new Error('Candidate UI assets or recorded responses missing/exceed bounds');
    browser = await launchIsolatedBrowser({ timeoutMs: remaining(40000) });
    const b = browser;
    await b.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, b.pageSessionId);
    const handleRequest = async (params: any, sessionId?: string) => {
      const task = (async () => {
        if (Date.now() >= deadline) { timedOut = true; throw new Error('UI suite timed out'); }
        const request = params.request;
        const url = new URL(request.url);
        facts.requests.push({ method: String(request.method).slice(0, 16), url: url.href.slice(0, 512) });
        if (url.origin !== 'http://demo.invalid' || request.method !== 'GET') throw new Error('Blocked unknown UI request');
        if (url.pathname === '/' && request.method === 'GET') {
          await b.send('Fetch.fulfillRequest', { requestId: params.requestId, responseCode: 200, responseHeaders: htmlHeaders, body: Buffer.from(assets.html).toString('base64') }, sessionId);
        } else if (url.pathname === '/app.js') {
          await b.send('Fetch.fulfillRequest', { requestId: params.requestId, responseCode: 200, responseHeaders: scriptHeaders, body: Buffer.from(assets.clientScript).toString('base64') }, sessionId);
        } else if (url.pathname === '/api/projects') {
          if (url.search.length > 2048) throw new Error('Recorded request query exceeds bound');
          const query = [...url.searchParams.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>encodeURIComponent(k)+'='+encodeURIComponent(v)).join('&');
          const response = assets.records[url.pathname + '?' + query];
          if (!response) throw new Error('Unrecorded UI request blocked');
          if (!Number.isInteger(response.status) || typeof response.body !== 'string' || response.body.length > 8192) throw new Error('Malformed recorded API response');
          const parsed = JSON.parse(response.body);
          const tenant = url.searchParams.get('tenant');
          const ids = Array.isArray(parsed) ? parsed.map((p: any) => p.id) : Array.isArray(parsed.items) ? parsed.items.map((p: any) => p.id) : [];
          facts.events.push({ tenant, ids, cursor: url.searchParams.get('cursor'), nextCursor: parsed?.nextCursor ?? null, status: response.status });
          await b.send('Fetch.fulfillRequest', { requestId: params.requestId, responseCode: response.status, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Content-Security-Policy', value: csp }], body: Buffer.from(response.body).toString('base64') }, sessionId);
        } else throw new Error('Unknown UI route blocked');
      })().catch(async error => { if (facts.failures.length < 20) facts.failures.push(String(error)); try { if (!closing) await b.send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'BlockedByClient' }, sessionId); } catch {} });
      return task;
    };
    const handler = (params: any, sessionId?: string) => {
      if (closing) return;
      facts.requestCount++;
      if (facts.requestCount > 20) {
        closing = true;
        facts.failures.push('UI request limit exceeded');
        return;
      }
      const task = requestTail.then(() => handleRequest(params, sessionId));
      requestTail = task.catch(() => {});
      apiTasks.add(task);
      void task.finally(() => apiTasks.delete(task));
    };
    await b.send('Log.enable', {}, b.pageSessionId);
    const unsubscribeLog = b.on('Log.entryAdded', (params: any) => {
      const entry = params?.entry;
      const text = String(entry?.text ?? '');
      if (/content security policy|connect-src|refused to connect|blocked by.*policy/i.test(text)) {
        if (facts.failures.length < 20) facts.failures.push(`CSP violation observed: ${text.slice(0, 500)}`);
      }
    });
    const unsubscribe = b.on('Fetch.requestPaused', handler);
    try {
      const session = b.pageSessionId;
      await b.send('Page.navigate', { url: 'http://demo.invalid/' }, session);
      const frame = await b.send('Page.getFrameTree', {}, session);
      const isolated = await b.send('Page.createIsolatedWorld', { frameId: frame.frameTree.frame.id, worldName: 'trusted-demo-ui-oracle' }, session);
      const contextId = isolated.executionContextId;
      const evaluateDom = (expression: string) => b.send('Runtime.evaluate', { expression, contextId, returnByValue: true }, session);
      const wait = (async () => {
        const until = Math.min(deadline, Date.now() + 3000);
        while (Date.now() < until) {
          if (Date.now() >= deadline) throw new Error('UI suite timed out');
          const r = await evaluateDom(`(() => {const t=document.querySelector('${controlContract.tenant}'), n=document.querySelector('${controlContract.next}'); return !!t && !!n && document.querySelectorAll('${controlContract.rows}').length > 0})()`);
          if (r?.result?.value) return;
          await new Promise(resolve => setTimeout(resolve, 40));
        }
        throw new Error('Required UI controls did not become ready');
      })();
      await Promise.race([wait, new Promise((_, reject) => { overall = setTimeout(() => { timedOut = true; closing = true; void b.close(); reject(new Error('UI suite timed out')); }, remaining(40000)); })]);
      const readState = async () => {
        const r = await evaluateDom(`(() => ({tenant:document.querySelector('#tenant')?.value, ids:[...document.querySelectorAll('#projects [data-project-id]')].map(x=>x.getAttribute('data-project-id')), nextDisabled:document.querySelector('#next-page')?.disabled ?? document.querySelector('#next-page')?.getAttribute('aria-disabled')==='true', status:document.querySelector('#status')?.textContent}))()`);
        return r?.result?.value;
      };
      const waitRequest = async (count: number, tenant: string, ids: string[], disabled: boolean) => { const end = Math.min(deadline, Date.now()+3000); while(Date.now()<end){ assertTime(); await Promise.all([...apiTasks]); if(facts.events.length >= count && facts.events[count-1]?.status === 200){ const s=await readState(); if(s?.tenant===tenant&&JSON.stringify(s.ids)===JSON.stringify(ids)&&s.nextDisabled===disabled){facts.events[count-1].dom=s; return;} } await new Promise(resolve=>setTimeout(resolve,Math.min(20, remaining(20)))); } if(Date.now()>=deadline)timedOut=true; throw new Error('Expected UI state did not become ready'); };
      await waitRequest(1,'tenant-a',expected['tenant-a'].slice(0,2),false);
      await evaluateDom(`document.querySelector('#next-page').click()`);
      await waitRequest(2,'tenant-a',expected['tenant-a'].slice(2),true);
      await evaluateDom(`document.querySelector('#tenant').value='tenant-b';document.querySelector('#tenant').dispatchEvent(new Event('change',{bubbles:true}))`);
      await waitRequest(3,'tenant-b',expected['tenant-b'],true);
      await evaluateDom(`document.querySelector('#tenant').value='tenant-a';document.querySelector('#tenant').dispatchEvent(new Event('change',{bubbles:true}))`);
      await waitRequest(4,'tenant-a',expected['tenant-a'].slice(0,2),false);
      await evaluateDom(`document.querySelector('#tenant').value='tenant-b';document.querySelector('#tenant').dispatchEvent(new Event('change',{bubbles:true}))`);
      await waitRequest(5,'tenant-b',expected['tenant-b'],true);
      await evaluateDom(`document.querySelector('#tenant').value='tenant-a';document.querySelector('#tenant').dispatchEvent(new Event('change',{bubbles:true}))`);
      await waitRequest(6,'tenant-a',expected['tenant-a'].slice(0,2),false);
    } finally {
      closing = true;
      unsubscribe(); unsubscribeLog();
      await Promise.allSettled([...apiTasks]);
      await requestTail;
      await b.close();
    }
    const frame = JSON.stringify({ facts, browserPid: b.pid });
    if (Buffer.byteLength(frame) > maxOutput) throw new Error('UI observations exceeded output limit');
    const execution: SandboxExecution = { status: timedOut ? 'timed-out' : 'exited', exitCode: timedOut ? null : 0, stdout: frame, stderr: '', startedAt, finishedAt: new Date().toISOString(), nodeVersion: process.version, stdoutDigest: hash(frame), stderrDigest: hash('') };
    return [{ kind: 'recorded-check', checkId, obligationIds: [...obligationIds], applicability, harnessVersion, result: !timedOut && facts.failures.length === 0 && evaluate(facts) ? 'passed' : 'failed', execution }];
  } catch (error) {
    const details = JSON.stringify({ facts, error: String(error) });
    const output = Buffer.byteLength(details) <= maxOutput ? details : JSON.stringify({ facts: { requestCount: facts.requestCount, failures: ['UI observations exceeded output limit'] }, error: 'UI observations exceeded output limit' });
    return [{ kind: 'recorded-check', checkId, obligationIds: [...obligationIds], applicability, harnessVersion, result: 'failed', execution: { status: timedOut ? 'timed-out' : 'exited', exitCode: timedOut ? null : 1, stdout: output, stderr: '', startedAt, finishedAt: new Date().toISOString(), nodeVersion: process.version, stdoutDigest: hash(output), stderrDigest: hash('') } }];
  } finally {
    if (overall) clearTimeout(overall);
    closing = true;
    if (browser) await browser.close();
    await requestTail;
    if (snapshotTask) await Promise.allSettled([snapshotTask]);
    const unlock = async (path: string): Promise<void> => { try { await chmod(path, 0o700); for (const name of await readdir(path)) { const child = join(path, name); if ((await lstat(child)).isDirectory()) await unlock(child); else await chmod(child, 0o600); } } catch {} };
    await unlock(root); await rm(root, { recursive: true, force: true });
  }
}
