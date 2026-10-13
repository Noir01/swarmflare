import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { runSandboxedNode } from '../../packages/git-runner/checks/sandbox.js';
import { launchIsolatedBrowser } from '../../packages/browser-test/isolated.js';

const MAX_MS = 30_000;
const MAX_REQUESTS = 10;
const MAX_FILES = 1000;
const MAX_BLOB_BYTES = 4 * 1024 * 1024;
const MAX_TREE_BYTES = 20 * 1024 * 1024;
const MAX_PATH_BYTES = 1024;
const DRIVER_PATH = '.page-observation-driver.mjs';
const driver = `const {html,clientScript,createProjectListHandler}=await import('./demo/seed/index.ts'); const mode=process.argv[2]; if(mode==='assets') process.stdout.write(JSON.stringify({html,clientScript})); else if(mode==='api'){const u=process.argv[3];if(!u||!u.startsWith('http://demo.invalid/api/projects?'))throw Error('bad URL');const r=await createProjectListHandler()(new Request(u));process.stdout.write(JSON.stringify({status:r.status,body:await r.text()}))} else throw Error('bad mode')`;
const gitEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0', GIT_CONFIG_PARAMETERS: '', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'file' };

function remaining(deadline: number): number {
  const ms = deadline - Date.now();
  if (ms <= 0) throw new Error('Page observation exceeded 30-second deadline');
  return ms;
}
function git(repo: string, args: string[], deadline: number, maxBuffer = 8 * 1024 * 1024): Buffer {
  return execFileSync('git', ['-C', resolve(repo), '-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', '-c', 'protocol.ext.allow=never', '-c', 'protocol.file.allow=always', '-c', 'core.fsmonitor=false', ...args], { env: gitEnv, timeout: Math.max(1, Math.min(8000, remaining(deadline))), maxBuffer });
}
function gitText(repo: string, args: string[], deadline: number, maxBuffer?: number): string {
  return git(repo, args, deadline, maxBuffer).toString('utf8').trim();
}
function validatePath(bytes: Buffer): string {
  if (!bytes.length || bytes.length > MAX_PATH_BYTES) throw new Error('Unsafe or oversized Git path');
  const path = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (path.startsWith('/') || path.includes('\\') || /[\x00-\x1f\x7f]/.test(path) || path.split('/').some(p => !p || p === '.' || p === '..' || p.toLowerCase() === '.git')) throw new Error('Unsafe Git path');
  if (path === DRIVER_PATH || path.startsWith(`${DRIVER_PATH}/`)) throw new Error('Git tree collides with observation driver');
  return path;
}
async function materialize(repo: string, commit: string, candidate: string, deadline: number): Promise<void> {
  const tree = git(repo, ['ls-tree', '-r', '-z', '--full-tree', commit], deadline, 8 * 1024 * 1024);
  if (tree.length > MAX_TREE_BYTES) throw new Error('Git tree exceeds 20 MiB');
  const entries = tree.toString('binary').split('\0').filter(Boolean);
  if (entries.length > MAX_FILES) throw new Error('Git tree exceeds 1000 files');
  const paths = new Set<string>();
  let total = 0;
  for (const record of entries) {
    remaining(deadline);
    const tab = record.indexOf('\t');
    if (tab < 0) throw new Error('Malformed Git tree entry');
    const header = record.slice(0, tab);
    const match = /^(100644|100755) blob ([0-9a-f]{40})$/.exec(header);
    if (!match) throw new Error('Git tree contains a symlink, gitlink, or non-regular entry');
    const pathBytes = Buffer.from(record.slice(tab + 1), 'binary');
    const path = validatePath(pathBytes);
    if (paths.has(path)) throw new Error('Duplicate Git tree path');
    paths.add(path);
    const sizeText = gitText(repo, ['cat-file', '-s', match[2]!], deadline, 1024);
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size) || size > MAX_BLOB_BYTES || total + size > MAX_TREE_BYTES) throw new Error('Git blob or total tree content exceeds size limit');
    const blob = git(repo, ['cat-file', 'blob', match[2]!], deadline, MAX_BLOB_BYTES + 1);
    if (blob.length !== size) throw new Error('Git blob size mismatch');
    total += size;
    const destination = join(candidate, ...path.split('/'));
    await mkdir(dirname(destination), { recursive: true });
    remaining(deadline);
    await writeFile(destination, blob, { flag: 'wx', mode: (match[1] === '100755' ? 0o700 : 0o600) });
  }
}

export async function observePage(repository: string, viewId: string, output: string) {
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(viewId)) throw new Error('Invalid view ID');
  const started = Date.now();
  const deadline = started + MAX_MS;
  const ref = `refs/agent/views/${viewId}`;
  const repo = resolve(repository);
  if (gitText(repo, ['rev-parse', '--is-bare-repository'], deadline, 1024) !== 'true') throw new Error('Repository must be a local bare Git repository');
  const commitOid = gitText(repo, ['rev-parse', '--verify', ref], deadline, 1024);
  if (!/^[0-9a-f]{40}$/.test(commitOid) || gitText(repo, ['cat-file', '-t', commitOid], deadline, 1024) !== 'commit') throw new Error('Invalid source commit');
  const treeOid = gitText(repo, ['rev-parse', `${commitOid}^{tree}`], deadline, 1024);
  if (!/^[0-9a-f]{40}$/.test(treeOid)) throw new Error('Invalid source tree');
  const root = await mkdtemp(join(tmpdir(), 'page-observation-'));
  let browser: Awaited<ReturnType<typeof launchIsolatedBrowser>> | undefined;
  try {
    const candidate = join(root, 'candidate'); await mkdir(candidate);
    await materialize(repo, commitOid, candidate, deadline);
    remaining(deadline);
    await writeFile(join(candidate, DRIVER_PATH), driver, { flag: 'wx', mode: 0o600 });
    const sandboxTimeout = () => Math.max(1, Math.min(3000, remaining(deadline)));
    const asset = await runSandboxedNode({ candidateDirectory: candidate, entrypoint: DRIVER_PATH, args: ['assets'], timeoutMs: sandboxTimeout(), maxOutputBytes: 32768 });
    remaining(deadline);
    if (asset.status !== 'exited' || asset.exitCode !== 0) throw new Error('Sandbox asset extraction failed');
    const assets = JSON.parse(asset.stdout) as { html: string; clientScript: string };
    if (typeof assets.html !== 'string' || typeof assets.clientScript !== 'string' || Buffer.byteLength(assets.html) > 16384 || Buffer.byteLength(assets.clientScript) > 16384) throw new Error('Assets exceed limit');
    const browserTimeout = remaining(deadline);
    if (browserTimeout < 100) throw new Error('Insufficient time to launch isolated browser');
    browser = await launchIsolatedBrowser({ timeoutMs: Math.min(MAX_MS, browserTimeout) });
    const b = browser;
    let requests = 0; const tasks = new Set<Promise<void>>(); let closing = false;
    const origin = 'http://demo.invalid';
    await b.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, b.pageSessionId);
    const observations: any = { firstPage: null, secondPage: null, tenantChange: null, api: [], errors: [], requestCount: 0 };
    const unsubscribe = b.on('Fetch.requestPaused', (p: any, session?: string) => {
      if (closing || Date.now() >= deadline || tasks.size >= MAX_REQUESTS || requests >= MAX_REQUESTS) {
        if (!closing && observations.errors.length < 20) observations.errors.push('request limit exceeded or observer closing');
        try { void b.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }, session); } catch {}
        return;
      }
      requests++;
      const task = (async () => {
        if (closing || Date.now() >= deadline) return;
        const u = new URL(p.request.url);
        if (u.origin !== origin || p.request.method !== 'GET') throw new Error('blocked non-demo origin or method');
        let status = 200, body: string, headers: any[];
        if (u.pathname === '/') { body = assets.html; headers = [{ name: 'Content-Type', value: 'text/html' }]; }
        else if (u.pathname === '/app.js') { body = assets.clientScript; headers = [{ name: 'Content-Type', value: 'text/javascript' }]; }
        else if (u.pathname === '/favicon.ico') { observations.faviconPath = u.pathname; throw new Error(`unknown route: ${u.pathname}`); }
        else if (u.pathname === '/api/projects') {
          const x = await runSandboxedNode({ candidateDirectory: candidate, entrypoint: DRIVER_PATH, args: ['api', u.href], timeoutMs: sandboxTimeout(), maxOutputBytes: 32768 });
          if (closing || Date.now() >= deadline) return;
          if (x.status !== 'exited' || x.exitCode !== 0) throw new Error('sandbox API failed');
          const value = JSON.parse(x.stdout); status = value.status; body = value.body; headers = [{ name: 'Content-Type', value: 'application/json' }];
          if (observations.api.length < MAX_REQUESTS) observations.api.push({ url: u.href, status, body: JSON.parse(body) });
        } else throw new Error(`unknown route: ${u.pathname}`);
        if (closing || Date.now() >= deadline) return;
        await b.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: status, responseHeaders: headers, body: Buffer.from(body!).toString('base64') }, session);
      })().catch(async e => { if (!closing && observations.errors.length < 20) observations.errors.push(String(e).slice(0, 500)); try { await b.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }, session); } catch {} });
      tasks.add(task); void task.finally(() => tasks.delete(task));
    });
    try {
      const s = b.pageSessionId; await b.send('Page.navigate', { url: `${origin}/` }, s);
      await b.send('Page.createIsolatedWorld', { frameId: (await b.send('Page.getFrameTree', {}, s)).frameTree.frame.id, worldName: 'diagnostic-observer' }, s).then(async (ctx: any) => {
        const ev = async (expression: string) => { remaining(deadline); return b.send('Runtime.evaluate', { expression, contextId: ctx.executionContextId, returnByValue: true }, s).then((x: any) => x.result?.value); };
        const state = async () => ev(`(()=>({tenant:document.querySelector('#tenant')?.value,ids:[...document.querySelectorAll('#projects [data-project-id]')].map(x=>x.getAttribute('data-project-id')),text:document.querySelector('#projects')?.innerText,nextDisabled:document.querySelector('#next-page')?.disabled}))()`);
        const wait = async (requestMatches: (x: any) => boolean) => { const until = Math.min(Date.now() + 5000, deadline); while (Date.now() < until && !closing) { await Promise.all([...tasks]); remaining(deadline); if (observations.api.some(requestMatches)) { await new Promise(r => setTimeout(r, Math.min(100, remaining(deadline)))); const v = await state(); if (v?.ids?.length) return v; } await new Promise(r => setTimeout(r, Math.min(25, remaining(deadline)))); } throw new Error('DOM observation timed out'); };
        observations.firstPage = await wait((x: any) => x.url.includes('tenant=tenant-a') && !x.url.includes('cursor='));
        await ev("document.querySelector('#next-page').click()"); observations.secondPage = await wait((x: any) => x.url.includes('cursor='));
        await ev("document.querySelector('#tenant').value='tenant-b';document.querySelector('#tenant').dispatchEvent(new Event('change',{bubbles:true}))"); observations.tenantChange = await wait((x: any) => x.url.includes('tenant=tenant-b'));
      });
      await Promise.all([...tasks]);
    } finally { closing = true; unsubscribe(); observations.requestCount = requests; await Promise.allSettled([...tasks]); await b.close(); }
    remaining(deadline);
    const result = { commitOid, treeOid, ref, observations, durationMs: Date.now() - started, diagnosticOnly: true };
    await writeFile(resolve(output), JSON.stringify(result, null, 2) + '\n'); return result;
  } finally { if (browser) await browser.close().catch(() => {}); await rm(root, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const [, , repository, viewId, output] = process.argv;
  if (!repository || !viewId || !output) { process.stderr.write('usage: page-observation.ts REMOTE VIEWID OUTPUT\n'); process.exitCode = 2; }
  else observePage(repository, viewId, output).then(x => process.stdout.write(JSON.stringify(x) + '\n')).catch(e => { process.stderr.write(String(e).slice(0, 1000) + '\n'); process.exitCode = 1; });
}
