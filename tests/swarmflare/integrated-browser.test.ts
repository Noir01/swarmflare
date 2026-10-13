import { afterEach, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launchLocalBrowser } from '../../packages/browser-test/index';
import { WorkspaceClient } from '../../packages/client/index';
import { runSourceJob } from '../../packages/local-runner/index';
import { verifyViewSource, runViewMandatoryDemoSuite } from '../../packages/local-runner/checks';
import { buildReviewArtifact } from '../../packages/local-runner/review-artifact';
import { mandatoryDemoSuiteDigest } from '../../packages/git-runner/checks/mandatory-demo-suite';
import { demoPolicyManifest } from '../../apps/worker/src/generated/demo-policy';
import { preparedPaginatedDemo } from '../fixtures/paginated-demo';

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
    export const nativeFixture = fixture;
    export const provisionRepository = (_binding, input) => provision(fixture,input);
    export const readRepositorySource = (_binding, source, path) => read(fixture,source,path);
    export const refreshRepository = (_binding, source) => refresh(fixture,source);
  `;
  const factoryModule = `import { createArtifactsSourceStore as create, resolveArtifactsSourceStore as resolve } from ${JSON.stringify(resolve('apps/worker/src/artifacts/source.ts'))};import {nativeFixture} from 'fixture-native';export const createArtifactsSourceStore=(env,id)=>create({...env,ARTIFACTS:nativeFixture},id);export const resolveArtifactsSourceStore=(env,id)=>resolve({...env,ARTIFACTS:nativeFixture},id);`;
  const bundle = await build({ stdin:{contents:`import worker from './apps/worker/src/index';export {Project} from './apps/worker/src/index';import {Platform as BasePlatform} from './apps/worker/src/platform/index';export class Platform extends BasePlatform {async fetch(request){if(new URL(request.url).pathname==='/fixture-expire'){this.ctx.storage.sql.exec('UPDATE runner_sessions SET expires=0');return new Response(null,{status:204})}return super.fetch(request)}}import {nativeFixture} from 'fixture-native';export default {fetch:(request,env)=>new URL(request.url).pathname==='/fixture-expire'?env.PLATFORM.get(env.PLATFORM.idFromName('swarmflare-platform-v1')).fetch(request):worker.fetch(request,{...env,ARTIFACTS:nativeFixture})};`,resolveDir:process.cwd(),loader:'ts'}, bundle: true, platform: 'browser', format: 'esm', write: false, external: ['cloudflare:workers'], plugins: [{ name: 'synthetic-provider-real-git', setup(builder) {
    builder.onResolve({ filter: /^\.\/repository-source$/ }, args => args.importer.endsWith('/platform/index.ts') ? { path: 'fixture-source', namespace: 'fixture' } : undefined);
    builder.onResolve({filter:/^fixture-native$/},()=>({path:'fixture-source',namespace:'fixture'}));
    builder.onResolve({filter:/^\.\.\/artifacts\/source$/},args=>args.importer.endsWith('/project/index.ts')?{path:'fixture-factory',namespace:'fixture'}:undefined);
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path==='fixture-factory'?factoryModule:fixtureModule, loader: 'ts', resolveDir: process.cwd() }));
  } }] });
  runtime = new Miniflare(convertV4MiniflareOptions({ name: 'swarmflare-integrated-test', modules: true, script: bundle.outputFiles[0]!.text, compatibilityDate: '2026-08-01', bindings:{RUNNER_SERVICE_KEY:'1'.repeat(64)}, durableObjects: { PLATFORM: { className: 'Platform', useSQLite: true }, PROJECTS: { className: 'Project', useSQLite: true } }, host: '127.0.0.1', port: 0, outboundService: async (request: Request) => {
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
  const envelope = { requestId: crypto.randomUUID(), payload: { title: 'Prepared first-party pagination fixture through scoped access', obligationIds: demoPolicyManifest.contract.obligations.map(o=>o.id) } };
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
  await evaluate('document.querySelector("form[data-api=demo-task-proposal]").requestSubmit()');
  await wait('document.body.innerText.includes("awaiting human approval")');
  const proposals = await fetch(origin + '/api/v1/projects/' + repo.projectId + '/proposals').then(r => r.json()) as any;
  expect(proposals.resource).toHaveLength(1);
  expect(proposals.resource[0].data.outcome).toBe(demoPolicyManifest.contract.outcome);
  await navigate('/browser-owner/browser-repo/tasks');
  expect(await evaluate('document.body.innerText')).toContain(demoPolicyManifest.contract.outcome);
  expect(await evaluate('document.body.innerText')).toContain('awaiting human approval');
  // Synthetic local owner explicitly approves; no real human/cloud decision.
  await evaluate('document.querySelector("form[data-api=task-approval]").requestSubmit()');
  await wait('document.body.innerText.includes("Current approved task") && !document.body.innerText.includes("awaiting human approval")');
  const approved = await fetch(origin + '/api/v1/projects/' + repo.projectId + '/context').then(r=>r.json()) as any;
  expect(approved.resource.contract.version).toBe(1);
  expect(approved.resource.contract.owner).toBe(repo.ownerId);
  await evaluate('document.querySelector("form[data-api=configure-policy]").requestSubmit()');
  await wait('document.body.innerText.includes("Current policy is configured")');
  const policy=await fetch(origin+'/api/v1/projects/'+repo.projectId+'/policy').then(r=>r.json()) as any;
  expect(policy.resource.data.checkSuiteDigest).toBe(mandatoryDemoSuiteDigest());
  expect(policy.resource.data.requireIndependentReview).toBe(true);
  const initEnvelope={requestId:crypto.randomUUID(),expectedVersion:0,payload:{commitOid:repo.source.commitOid,treeOid:repo.source.treeOid}};
  const initPath=origin+'/api/swarmflare/repos/browser-owner/browser-repo/baseline/initialize';
  expect((await fetch(initPath,{method:'POST',headers:{origin,authorization:'Bearer '+grantToken,'content-type':'application/json'},body:JSON.stringify(initEnvelope)})).status).toBe(403);
  expect((await fetch(origin+'/api/v1/projects/'+repo.projectId+'/internal/seed-jobs/forged/publish-artifacts',{method:'POST',headers:{authorization:'Bearer '+grantToken,'x-actor':JSON.stringify({role:'runner',id:'service-seed-'+repo.id}),'content-type':'application/json'},body:JSON.stringify({})})).status).toBe(404);
  await evaluate('document.querySelector("form[data-api=initialize-baseline]").requestSubmit()');
  await wait('document.body.innerText.includes("Current baseline") && !document.querySelector("form[data-api=initialize-baseline]")');
  const baseline = await fetch(origin + '/api/v1/projects/' + repo.projectId + '/baseline').then(r=>r.json()) as any;
  expect(baseline.resource.commitOid).toBe(repo.source.commitOid);
  expect(baseline.resource.treeOid).toBe(repo.source.treeOid);
  expect(baseline.resource.receipt.backend).toBe('artifacts-git');
  expect(git('-C',bare,'rev-parse',baseline.resource.receipt.ref)).toBe(repo.source.commitOid);
  expect(git('-C',bare,'rev-parse',baseline.resource.receipt.ref+'^{tree}')).toBe(repo.source.treeOid);

  const allowedChange = await fetch(origin+'/api/v1/projects/'+repo.projectId+'/changes',{method:'POST',headers:{authorization:'Bearer '+grantToken,'content-type':'application/json'},body:JSON.stringify(envelope)});
  expect(allowedChange.status).toBe(201);
  const change=(await allowedChange.json() as any).resource;expect(change.owner).toBe(claim.resource.owner);
  const safeEvidenceDir=resolve('reports/evaluation/continuous42-integrated');await mkdir(safeEvidenceDir,{recursive:true});
  const taskCapture=await browser.send('Page.captureScreenshot',{format:'png'},browser.pageSessionId);await writeFile(join(safeEvidenceDir,'tasks.png'),Buffer.from(taskCapture.data,'base64'));
  await writeFile(join(safeEvidenceDir,'baseline.json'),JSON.stringify({provenance:'Actual local Worker/SQLite accounts, explicit synthetic owner task approval, actual Git immutable seed source and verified readback. Provider metadata/token RPC and HTTPS mapping synthetic. Not native cloud, human review or acceptance.',projectId:repo.projectId,baseline:baseline.resource,approvedContractVersion:1},null,2));
  const sessionUrl=origin+'/api/platform/runner/sessions',scope={projectId:repo.projectId,expiresInSeconds:120,maxOperations:60};
  expect((await fetch(sessionUrl,{method:'POST',headers:{authorization:'Bearer '+grantToken,'content-type':'application/json'},body:JSON.stringify(scope)})).status).toBe(403);
  const issuedResponse=await fetch(sessionUrl,{method:'POST',headers:{authorization:'Bearer '+'1'.repeat(64),'content-type':'application/json'},body:JSON.stringify(scope)});expect(issuedResponse.status).toBe(201);
  const issued=await issuedResponse.json() as any;
  const ownerKeyDenied=await evaluate(`fetch('/api/platform/runner/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(${JSON.stringify(scope)})}).then(r=>r.status)`);expect(ownerKeyDenied).toBe(403);
  const second=await evaluate(`fetch('/api/platform/auth/session').then(r=>r.json()).then(s=>fetch('/api/platform/repos',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':s.csrf},body:JSON.stringify({name:'other-repo',initializeReadme:true})})).then(r=>r.json())`);
  expect((await fetch(origin+'/api/v1/projects/'+second.repository.projectId+'/context',{headers:{authorization:'Bearer '+issued.token}})).status).toBe(403);
  const oneOperation=await fetch(sessionUrl,{method:'POST',headers:{authorization:'Bearer '+'1'.repeat(64),'content-type':'application/json'},body:JSON.stringify({...scope,maxOperations:1})}).then(r=>r.json()) as any;
  expect((await fetch(origin+'/api/v1/projects/'+repo.projectId+'/context',{headers:{authorization:'Bearer '+oneOperation.token}})).status).toBe(200);
  expect((await fetch(origin+'/api/v1/projects/'+repo.projectId+'/context',{headers:{authorization:'Bearer '+oneOperation.token}})).status).toBe(403);
  expect((await fetch(sessionUrl,{method:'POST',headers:{authorization:'Bearer '+'1'.repeat(64),'content-type':'application/json'},body:JSON.stringify({...scope,role:'human'})})).status).toBe(400);
  const fakePolicy=await evaluate(`fetch('/api/platform/auth/session').then(r=>r.json()).then(s=>fetch('/api/swarmflare/repos/browser-owner/browser-repo/policy',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':s.csrf},body:JSON.stringify({requestId:crypto.randomUUID(),expectedVersion:1,contractVersion:1,checkSuiteDigest:'fake'})})).then(r=>r.status)`);expect(fakePolicy).toBe(400);
  const runner=new WorkspaceClient({baseUrl:origin,projectId:repo.projectId,token:issued.token,maxRequests:60,deadline:90000});
  const contributor=new WorkspaceClient({baseUrl:origin,projectId:repo.projectId,token:grantToken,maxRequests:60,deadline:90000});
  for(const path of ['/acceptances','/baseline/initialize','/policy','/contracts/proposals','/views/forged/confirmations'])expect((await fetch(origin+'/api/v1/projects/'+repo.projectId+path,{method:'POST',headers:{authorization:'Bearer '+issued.token,'content-type':'application/json'},body:JSON.stringify({})})).status).toBe(403);
  const localBare=join(scratch,'runner-cache.git'),sourceWork=join(scratch,'runner-source'),work=join(scratch,'runner-work');await mkdir(work);
  git('init','--bare','-q','--initial-branch=main',localBare);git('-C',bare,'push',localBare,baseline.resource.receipt.ref);
  git('clone','-q',bare,sourceWork);git('-C',sourceWork,'config','user.name','Synthetic first-party fixture');git('-C',sourceWork,'config','user.email','fixture@example.invalid');
  await mkdir(join(sourceWork,'demo/seed'),{recursive:true});await writeFile(join(sourceWork,'demo/seed/index.ts'),preparedPaginatedDemo);git('-C',sourceWork,'add','.');git('-C',sourceWork,'commit','-qm','prepared first-party pagination fixture');
  const revision=await contributor.publishRevision(change.id,{requestId:crypto.randomUUID(),payload:{baseCommitOid:repo.source.commitOid,commitOid:git('-C',sourceWork,'rev-parse','HEAD'),treeOid:git('-C',sourceWork,'rev-parse','HEAD^{tree}'),obligationIds:envelope.payload.obligationIds,decisionRevisions:[],dependencies:[]}});
  expect((await runSourceJob(runner,{remote:localBare,workspaceRoot:work,resolveRepository:()=>sourceWork,requestId:'mapped-publication',sourceBackend:'artifacts-git'}))?.data.status).toBe('completed');
  const created=await contributor.createView({requestId:crypto.randomUUID(),payload:{baseVersion:baseline.resource.version,baseCommitOid:repo.source.commitOid,contractVersion:approved.resource.contract.version,policyVersion:policy.resource.version,orderedRevisions:[{changeId:change.id,revisionId:revision.id}],excludedChangeIds:[],decisionRevisions:[],compositionVersion:1}});
  expect((await runSourceJob(runner,{remote:localBare,workspaceRoot:work,resolveRepository:()=>sourceWork,requestId:'mapped-composition',sourceBackend:'artifacts-git'}))?.data.status).toBe('completed');
  const view=await contributor.view(created.id);expect(git('-C',bare,'rev-parse',view.data.receipt!.ref)).toBe(view.data.receipt!.commitOid);
  await verifyViewSource(runner,{remote:localBare,viewId:view.id,requestId:'mapped-source-verification'});
  const checks=await runViewMandatoryDemoSuite(runner,{remote:localBare,workspaceRoot:work,viewId:view.id,projectId:repo.projectId,requestId:'mapped-mandatory'});expect(checks.map(c=>c.data.result)).toEqual(['passed','passed']);
  const artifact=await buildReviewArtifact(runner,{remote:localBare,workspaceRoot:work,viewId:view.id});expect(artifact.data.diff.files).toContain('demo/seed/index.ts');
  expect((await contributor.readiness(view.id)).ready).toBe(false);
  await navigate('/browser-owner/browser-repo/candidates/'+view.id);
  await evaluate("document.querySelector('#finding-expected').value='Document pagination behavior in the README';document.querySelector('#finding-observed').value='README still contains initial repository description only';document.querySelector('#finding-paths').value='README.md';document.querySelector('form[data-api=request-changes]').requestSubmit()");
  await wait('document.body.innerText.includes("README still contains initial repository description only") && document.body.innerText.includes("open")');
  const findings=await contributor.findings();expect(findings).toHaveLength(1);expect(findings[0]!.data.nextOwner).toBe(change.owner);expect(findings[0]!.data.viewId).toBe(view.id);
  expect(await contributor.baseline()).toEqual(baseline.resource);expect((await contributor.readiness(view.id)).ready).toBe(false);
  const candidateCapture=await browser.send('Page.captureScreenshot',{format:'png'},browser.pageSessionId);await mkdir(resolve('reports/evaluation/continuous43-integrated'),{recursive:true});await writeFile(resolve('reports/evaluation/continuous43-integrated/candidate.png'),Buffer.from(candidateCapture.data,'base64'));
  await writeFile(resolve('reports/evaluation/continuous43-integrated/journey.json'),JSON.stringify({provenance:'Actual local SQLite account ownership and scoped runner session, real Git publication/composition/readback, actually executed mandatory API/UI suites on prepared FIRST-PARTY trusted fixture (not imported source), persisted browser request-changes. Native provider/token/HTTPS mapping synthetic. No cloud or real human acceptance.',projectId:repo.projectId,viewId:view.id,source:view.data.receipt,policyDigest:policy.resource.data.checkSuiteDigest,checks:checks.map(c=>({id:c.data.checkId,result:c.data.result})),finding:findings[0],baselineUnchanged:true,ready:false},null,2));
  for(const [tab,expected] of [['Files changed','demo/seed/index.ts'],['Checks','mandatory-demo-api'],['Preview','Isolated project-list demo preview']]){
    await navigate('/browser-owner/browser-repo/candidates/'+view.id+'?tab='+encodeURIComponent(tab!));expect(await evaluate('document.body.innerText')).toContain(expected!);
    const capture=await browser.send('Page.captureScreenshot',{format:'png'},browser.pageSessionId);await writeFile(resolve('reports/evaluation/continuous43-integrated/'+tab!.toLowerCase().replaceAll(' ','-')+'.png'),Buffer.from(capture.data,'base64'));
  }
  const preview=await fetch(origin+'/api/swarmflare/repos/browser-owner/browser-repo/candidates/'+view.id+'/preview');expect(preview.status).toBe(200);expect(preview.headers.get('content-security-policy')).toContain('sandbox allow-scripts');expect(preview.headers.get('content-security-policy')).toContain("connect-src 'none'");
  expect((await fetch(origin+'/fixture-expire',{method:'POST'})).status).toBe(204);
  expect((await fetch(origin+'/api/v1/projects/'+repo.projectId+'/context',{headers:{authorization:'Bearer '+issued.token}})).status).toBe(403);
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
}, 90000);
