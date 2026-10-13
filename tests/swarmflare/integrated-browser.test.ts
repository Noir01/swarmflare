import { afterEach, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launchLocalBrowser } from '../../packages/browser-test/index';

let runtime: Miniflare | undefined;
let browser: Awaited<ReturnType<typeof launchLocalBrowser>> | undefined;
let scratch: string | undefined;
afterEach(async () => {
  await browser?.close(); browser = undefined;
  await runtime?.dispose(); runtime = undefined;
  if (scratch) await rm(scratch, { recursive: true, force: true }); scratch = undefined;
});

it('navigates real SQLite accounts, Git-backed repository source, scoped contribution and logout', async () => {
  scratch = await mkdtemp(join(tmpdir(), 'swarmflare-integrated-'));
  const repos = join(scratch, 'repos'); await mkdir(repos);
  const gitEnv = { PATH: process.env.PATH, HOME: scratch, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
  const git = (...args: string[]) => execFileSync('git', args, { env: gitEnv, encoding: 'utf8', timeout: 5000 }).trim();
  const tokens = new Set<string>();
  // Only provider metadata/token RPCs and logical HTTPS are synthetic. The
  // actual source module creates/fetches Git packs through git http-backend.
  const fixtureModule = `
    import { provisionRepository as provision, readRepositorySource as read, refreshRepository as refresh } from ${JSON.stringify(resolve('apps/worker/src/platform/repository-source.ts'))};
    const token = () => 'art_v2_x_'+'a'.repeat(40)+'?expires='+Math.floor(Date.now()/1000+240);
    const remote = name => 'https://fixture.artifacts.cloudflare.net/git/default/'+name+'.git';
    const fixture = {
      create: async name => { await fetch('https://fixture.internal/create',{method:'POST',body:name}); return {name,remote:remote(name),token:token()}; },
      import: async () => { throw Error('Import is exercised separately, not simulated by this browser fixture'); },
      get: async name => ({info:async()=>({remote:remote(name)}),createToken:async()=>{const plaintext=token();return {plaintext,expiresAt:new Date(Number(plaintext.split('=').at(-1))*1000).toISOString()};},revokeToken:async value=>{await fetch('https://fixture.internal/revoke',{method:'POST',body:value});return true;},[Symbol.dispose](){} })
    };
    export const provisionRepository = (_binding, input) => provision(fixture,input);
    export const readRepositorySource = (_binding, source, path) => read(fixture,source,path);
    export const refreshRepository = (_binding, source) => refresh(fixture,source);
  `;
  const bundle = await build({ entryPoints: ['apps/worker/src/index.ts'], bundle: true, platform: 'browser', format: 'esm', write: false, external: ['cloudflare:workers'], plugins: [{ name: 'synthetic-provider-real-git', setup(builder) {
    builder.onResolve({ filter: /^\.\/repository-source$/ }, args => args.importer.endsWith('/platform/index.ts') ? { path: 'fixture-source', namespace: 'fixture' } : undefined);
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: fixtureModule, loader: 'ts', resolveDir: process.cwd() }));
  } }] });
  runtime = new Miniflare(convertV4MiniflareOptions({ name: 'swarmflare-integrated-test', modules: true, script: bundle.outputFiles[0]!.text, compatibilityDate: '2026-08-01', durableObjects: { PLATFORM: { className: 'Platform', useSQLite: true }, PROJECTS: { className: 'Project', useSQLite: true } }, host: '127.0.0.1', port: 0, outboundService: async (request: Request) => {
    const url = new URL(request.url);
    if (url.hostname === 'fixture.internal' && url.pathname === '/create') {
      const name = await request.text(); expect(name).toMatch(/^sf-[a-f0-9-]+$/);
      const bare = join(repos, 'git', 'default', name + '.git'); await mkdir(join(repos, 'git', 'default'), { recursive: true });
      git('init', '--bare', '-q', '--initial-branch=main', bare); git('-C', bare, 'config', 'http.receivepack', 'true');
      return new Response('created');
    }
    if (url.hostname === 'fixture.internal' && url.pathname === '/revoke') { tokens.add(await request.text()); return new Response('revoked'); }
    if (url.hostname !== 'fixture.artifacts.cloudflare.net') return new Response('Fixture egress refused', { status: 403 });
    const body = Buffer.from(await request.arrayBuffer());
    const output = execFileSync('git', ['http-backend'], { input: body, timeout: 5000, maxBuffer: 8 * 1024 * 1024, env: { ...gitEnv, GIT_PROJECT_ROOT: repos, GIT_HTTP_EXPORT_ALL: '1', REQUEST_METHOD: request.method, PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), CONTENT_TYPE: request.headers.get('content-type') ?? '', CONTENT_LENGTH: String(body.length), REMOTE_ADDR: '127.0.0.1', SERVER_PROTOCOL: 'HTTP/1.1', ...(request.headers.get('git-protocol') ? { GIT_PROTOCOL: request.headers.get('git-protocol')! } : {}) } });
    const split = output.indexOf(Buffer.from('\r\n\r\n')); expect(split).toBeGreaterThan(0);
    const headers = new Headers(); let status = 200;
    for (const line of output.subarray(0, split).toString().split('\r\n')) { const i = line.indexOf(':'); if (i < 0) continue; const name = line.slice(0, i), value = line.slice(i + 1).trim(); if (name.toLowerCase() === 'status') status = Number(value.split(' ')[0]); else headers.set(name, value); }
    return new Response(output.subarray(split + 4), { status, headers });
  } }));
  const origin = new URL((await runtime.ready).toString()).origin;
  browser = await launchLocalBrowser({ timeoutMs: 60000 });
  const evaluate = async (expression: string) => {
    const result = await browser!.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, browser!.pageSessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  const wait = async (condition: string) => { const until = Date.now() + 8000; while (Date.now() < until) { if (await evaluate(condition)) return; await new Promise(r => setTimeout(r, 40)); } throw new Error(`Browser condition timed out: ${condition}; ${await evaluate('document.body.innerText')}`); };
  const navigate = async (path: string) => { await browser!.send('Page.navigate', { url: origin + path }, browser!.pageSessionId); await wait('document.readyState === "complete"'); };
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, browser.pageSessionId);
  await navigate('/signup');
  await evaluate(`document.querySelector('#username').value='browser-owner';document.querySelector('#email').value='browser-owner@example.test';document.querySelector('#password').value='synthetic-password-only';document.querySelector('form[data-api="signup"]').requestSubmit()`);
  await wait('location.pathname === "/repositories"');
  await navigate('/new');
  await evaluate(`document.querySelector('#name').value='browser-repo';document.querySelector('#description').value='Actual local Git source, synthetic provider binding';document.querySelector('form[data-api="create-repository"]').requestSubmit()`);
  await wait('location.pathname === "/browser-owner/browser-repo"');
  expect(await evaluate('document.body.innerText')).toContain('Actual local Git source');
  const list = await fetch(origin + '/api/platform/repos').then(r => r.json()) as any;
  expect(list.repositories).toHaveLength(1); const repo = list.repositories[0]; expect(repo.status).toBe('ready');
  const bare = join(repos, 'git', 'default', 'sf-' + repo.id + '.git');
  expect(git('-C', bare, 'rev-parse', 'refs/heads/main')).toBe(repo.source.commitOid);
  expect(git('-C', bare, 'show', 'refs/heads/main:README.md')).toContain('Actual local Git source');
  await navigate('/browser-owner/browser-repo?path=README.md');
  expect(await evaluate('document.body.innerText')).toContain('# browser-repo');
  await navigate('/browser-owner/browser-repo/settings');
  await evaluate('document.querySelector("form[data-api=agent-grant]").requestSubmit()');
  await wait('document.querySelector("form[data-api=agent-grant] [role=status]").textContent.includes("one-time")');
  const grantToken = await evaluate('document.querySelector("form[data-api=agent-grant] [role=status]").textContent.match(/[a-f0-9]{64}/)[0]');
  const envelope = { requestId: crypto.randomUUID(), payload: { title: 'Agent contribution through scoped access', obligationIds: ['readme'] } };
  const contribution = await fetch(origin + '/api/v1/projects/' + repo.projectId + '/changes', { method: 'POST', headers: { authorization: 'Bearer ' + grantToken, 'content-type': 'application/json' }, body: JSON.stringify(envelope) });
  // A new repository has no human-approved task yet. A scoped grant must not
  // silently manufacture that prerequisite just to submit a Change.
  expect(contribution.status).toBe(409);
  const claimResponse = await fetch(origin + '/api/v1/projects/' + repo.projectId + '/claims', { method: 'POST', headers: { authorization: 'Bearer ' + grantToken, 'content-type': 'application/json' }, body: JSON.stringify({ requestId: crypto.randomUUID(), payload: { obligationIds: ['readme'], areas: ['src/readme'], status: 'working' } }) });
  expect(claimResponse.status).toBe(201); const claim = await claimResponse.json() as any; expect(claim.resource.owner).not.toBe(repo.ownerId);
  const denied = await fetch(origin + '/api/v1/projects/' + repo.projectId + '/acceptances', { method: 'POST', headers: { authorization: 'Bearer ' + grantToken, 'content-type': 'application/json' }, body: JSON.stringify({ requestId: crypto.randomUUID(), payload: {} }) });
  expect(denied.status).toBe(403);
  const context = await fetch(origin + '/api/v1/projects/' + repo.projectId + '/context').then(r => r.json()) as any;
  expect(context.resource.claims[0].data.areas).toEqual(['src/readme']);
  await navigate('/browser-owner/browser-repo/tasks');
  expect(await evaluate('document.body.innerText')).toContain('working');
  await evaluate(`document.querySelector('#proposal-outcome').value='Document the repository API';document.querySelector('#obligation-id').value='readme';document.querySelector('#obligation-description').value='README explains source and agent access';document.querySelector('#required-checks').value='readme-check';document.querySelector('form[data-api="task-proposal"]').requestSubmit()`);
  await wait('document.querySelector("form[data-api=task-proposal] [role=status]").textContent.includes("proposed") || document.querySelector("form[data-api=task-proposal] [role=status]").textContent.includes("Proposal")');
  const proposals = await fetch(origin + '/api/v1/projects/' + repo.projectId + '/proposals').then(r => r.json()) as any;
  expect(proposals.resource).toHaveLength(1);
  expect(proposals.resource[0].data.outcome).toBe('Document the repository API');
  await navigate('/browser-owner/browser-repo/tasks');
  expect(await evaluate('document.body.innerText')).toContain('Document the repository API');
  expect(await evaluate('document.body.innerText')).toContain('awaiting human approval');
  await navigate('/repositories');
  await evaluate('document.querySelector("form[data-api=logout]").requestSubmit()');
  await wait('location.pathname === "/login" || !document.body.innerText.includes("Signed in as")');
  const session = await evaluate('fetch("/api/platform/auth/session").then(r=>r.json())'); expect(session.user).toBeNull();
  await navigate('/login');
  await evaluate(`document.querySelector('#login').value='browser-owner@example.test';document.querySelector('#password').value='synthetic-password-only';document.querySelector('form[data-api="login"]').requestSubmit()`);
  await wait('location.pathname === "/repositories"');
  expect(await evaluate('document.body.innerText')).toContain('Signed in as browser-owner');
  await evaluate('document.querySelector("form[data-api=logout]").requestSubmit()');
  await wait('location.pathname === "/login" || !document.body.innerText.includes("Signed in as")');
  await navigate('/browser-owner/browser-repo');
  const outsider = await evaluate(`fetch('/api/platform/repos/browser-owner/browser-repo/agents',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({role:'contributor',expiresInSeconds:600})}).then(r=>r.status)`); expect(outsider).toBe(403);
  const evidenceDir = resolve('reports/evaluation/continuous38-integrated'); await mkdir(evidenceDir, { recursive: true });
  const capture = await browser.send('Page.captureScreenshot', { format: 'png' }, browser.pageSessionId);
  await writeFile(join(evidenceDir, 'repository.png'), Buffer.from(capture.data, 'base64'));
  await writeFile(join(evidenceDir, 'navigation.json'), JSON.stringify({ provenance: 'Actual Worker/SQLite accounts and actual Git pack source; synthetic Artifacts metadata/token provider and HTTPS mapping. No cloud or human acceptance.', projectId: repo.projectId, commitOid: repo.source.commitOid, journey: ['signup', 'create README repository', 'public source file', 'owner grant', 'Change refused without approved task', 'scoped agent work claim', 'agent acceptance denied', 'task proposal persists awaiting human approval', 'logout', 'email login', 'logout', 'outsider grant denied'], revokedTemporaryTokens: tokens.size }, null, 2));
}, 60000);
