import { afterEach, expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createHash } from 'node:crypto';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceClient } from '../../packages/client/index';
import { runSourceJob } from '../../packages/local-runner/index';
import { verifyViewSource } from '../../packages/local-runner/checks';
import { runViewMandatoryDemoSuite } from '../../packages/local-runner/checks';
import { mandatoryDemoSuiteDigest } from '../../packages/git-runner/checks/mandatory-demo-suite';
import { buildReviewArtifact } from '../../packages/local-runner/review-artifact';
import { preparedPaginatedDemo } from '../fixtures/paginated-demo';
import { readSourceReceipt } from '../../packages/git-runner/index';

// Synthetic only: native Artifacts capability/token and exact logical HTTPS mapping.
// Project, WorkspaceClient, source store, Git smart HTTP and Git objects are real local.
let runtime: Miniflare | undefined, server: Server | undefined, scratch: string | undefined;
const children = new Set<ChildProcess>();
const logical = 'https://acct.artifacts.cloudflare.net/git/project/repo.git';
let loopback = '';
const wireTrace: string[] = [];
const targetRepo = () => join(scratch!, 'repos', 'target.git');
function runGit(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', timeout: 10_000,
    env: { PATH: process.env.PATH, HOME: join(scratch!, 'home'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}
async function backend(env: NodeJS.ProcessEnv, input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn('git', ['http-backend'], { cwd: scratch!, env, stdio: ['pipe', 'pipe', 'ignore'] }); children.add(p);
    const chunks: Buffer[] = []; let bytes = 0; const timer = setTimeout(() => p.kill('SIGKILL'), 10_000);
    p.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 16 * 1024 * 1024) p.kill('SIGKILL'); else chunks.push(Buffer.from(chunk)); });
    p.once('error', e => { clearTimeout(timer); children.delete(p); reject(e); });
    p.once('close', code => { clearTimeout(timer); children.delete(p); code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`git http-backend exited ${code}`)); }); p.stdin.end(input);
  });
}
function parseCgi(data: Buffer) { const crlf = data.indexOf('\r\n\r\n'), lf = data.indexOf('\n\n'), at = crlf >= 0 ? crlf : lf; if (at < 0) return { status: 502, headers: {}, body: data }; const separator = crlf >= 0 ? 4 : 2, headers: Record<string,string> = {}; let status = 200; for (const line of data.subarray(0, at).toString().split(/\r?\n/)) { const i = line.indexOf(':'); if (i < 0) continue; const k=line.slice(0,i).trim(),v=line.slice(i+1).trim(); if(k.toLowerCase()==='status')status=Number.parseInt(v,10);else headers[k]=v; } return {status,headers,body:data.subarray(at+separator)}; }
async function startGitHttp() {
  const repos = join(scratch!, 'repos'); await mkdir(repos); runGit(scratch!, 'init', '-q', '--bare', '--initial-branch=main', join(repos, 'target.git')); runGit(join(repos, 'target.git'), 'config', 'http.receivepack', 'true'); runGit(join(repos, 'target.git'), 'config', 'core.hooksPath', '/dev/null');
  server = createServer((req,res) => { const u=new URL(req.url??'/', 'http://127.0.0.1'), chunks:Buffer[]=[]; let bytes=0; req.on('data',c=>{bytes+=c.length;if(bytes>64*1024){req.destroy();return;}chunks.push(Buffer.from(c));}); req.on('end',async()=>{try{const body=Buffer.concat(chunks),path=decodeURIComponent(u.pathname),method=req.method??'';wireTrace.push(`server ${method} ${path}${u.search}`);const query=u.searchParams;const allowed=(method==='GET'&&path==='/target.git/info/refs'&&query.size===1&&['git-upload-pack','git-receive-pack'].includes(query.get('service')??''))||(method==='POST'&&['/target.git/git-upload-pack','/target.git/git-receive-pack'].includes(path)&&query.size===0);if(!allowed){wireTrace.push(`fixture-reject path=${path} method=${method} query=${query.toString()} size=${query.size}`);res.writeHead(404).end();return;}const env:NodeJS.ProcessEnv={PATH:process.env.PATH,HOME:join(scratch!,'home'),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_PROJECT_ROOT:repos,GIT_HTTP_EXPORT_ALL:'1',REQUEST_METHOD:method,PATH_INFO:path,QUERY_STRING:u.search.slice(1),CONTENT_TYPE:String(req.headers['content-type']??''),CONTENT_LENGTH:String(body.length),REMOTE_ADDR:'127.0.0.1',SERVER_PROTOCOL:'HTTP/1.1',...(req.headers['git-protocol']?{GIT_PROTOCOL:String(req.headers['git-protocol'])}:{})};const r=parseCgi(await backend(env,body));res.writeHead(r.status,r.headers).end(r.body);}catch{res.writeHead(500).end();}}); }); await new Promise<void>(r=>server!.listen(0,'127.0.0.1',r)); loopback=`http://127.0.0.1:${(server.address() as AddressInfo).port}/target.git`;
}
afterEach(async()=>{await runtime?.dispose();runtime=undefined;if(server){await new Promise<void>(r=>server!.close(()=>r()));server=undefined;}for(const p of children)p.kill('SIGKILL');await Promise.all([...children].map(p=>new Promise<void>(r=>p.once('close',()=>r()))));expect(children.size).toBe(0);children.clear();expect(server).toBeUndefined();if(scratch){await rm(scratch,{recursive:true,force:true});scratch=undefined;}});
it('persists a real Project baseline and publishes a seed through ArtifactsSourceStore and local Git HTTP',async()=>{
  scratch=await mkdtemp(join(tmpdir(),'artifacts-wire-'));await mkdir(join(scratch,'home'));
  const source=join(scratch,'source'),work=join(scratch,'work'),localBare=join(scratch,'local.git');await mkdir(source);await mkdir(work,{recursive:true});runGit(scratch,'init','-q',source);runGit(scratch,'init','--bare','-q',localBare);runGit(source,'config','user.name','Wire test');runGit(source,'config','user.email','wire@example.invalid');await writeFile(join(source,'baseline.txt'),'wire baseline\n');runGit(source,'add','.');runGit(source,'commit','-qm','wire baseline');
  const commitOid=runGit(source,'rev-parse','HEAD'),treeOid=runGit(source,'rev-parse','HEAD^{tree}');await startGitHttp();
  const projectId='artifacts-wire-project', roles=['human','contributor','runner'] as const, tokens={human:'synthetic-human-wire',contributor:'synthetic-contributor-wire',runner:'synthetic-runner-wire'};
  const credentials=roles.map(role=>({id:role,projectId,role,tokenHash:createHash('sha256').update(tokens[role]).digest('hex'),expiresAt:Date.now()+300_000}));
  const sourceText=`import { Project } from './apps/worker/src/project/index'; import { route } from './apps/worker/src/http/router'; const logical=${JSON.stringify(logical)}; const capabilityTrace=[]; const repo={info:async()=>{capabilityTrace.push('info');return {remote:logical}},createToken:async(_scope,_ttl)=>{capabilityTrace.push('createToken');const expiry=Math.floor(Date.now()/1000)+240;return {id:'fixture-token',plaintext:'art_v1_'+'a'.repeat(40)+'?expires='+expiry,expiresAt:new Date(expiry*1000).toISOString()}},revokeToken:async()=>{capabilityTrace.push('revokeToken');return true},[Symbol.dispose](){capabilityTrace.push('dispose')}}; export class ArtifactsWireProject extends Project { constructor(state,env){super(state,{...env,ARTIFACTS:{get:async(_name)=>{capabilityTrace.push('get');return repo}}})} } export default {fetch:(request,env)=>new URL(request.url).pathname==='/fixture-capabilities' ? Response.json(capabilityTrace) : route(request,env)};`;
  const bundle=await build({stdin:{contents:sourceText,resolveDir:process.cwd(),sourcefile:'artifacts-wire-entry.ts',loader:'ts'},bundle:true,platform:'browser',format:'esm',write:false,external:['cloudflare:workers']});
  runtime=new Miniflare(convertV4MiniflareOptions({name:'artifacts-wire',modules:true,script:bundle.outputFiles[0]!.text,compatibilityDate:'2026-08-01',durableObjects:{PROJECTS:{className:'ArtifactsWireProject',useSQLite:true}},bindings:{AUTH_CREDENTIALS:JSON.stringify(credentials),ARTIFACTS_SOURCE_CONFIG:JSON.stringify({projectId,repository:'demo/source',remote:logical,allowWrites:true})},outboundService:async request=>{const url=new URL(request.url),base=new URL(logical);wireTrace.push(`${request.method} ${url.pathname}${url.search}`);if(url.origin!==base.origin||!url.pathname.startsWith(base.pathname))throw Error('outside logical origin');const suffix=url.pathname.slice(base.pathname.length);if(!['/info/refs','/git-upload-pack','/git-receive-pack'].includes(suffix))throw Error('unexpected git route');try{const headers=new Headers(request.headers);headers.delete('content-length');headers.delete('host');const response=await fetch(new URL(`${loopback}${suffix}${url.search}`),{method:request.method,headers,body:['GET','HEAD'].includes(request.method)?undefined:await request.arrayBuffer(),redirect:'manual'});wireTrace.push(`response ${response.status} ${response.headers.get('content-type')??''}`);return response;}catch(error){wireTrace.push(`outbound-error ${String(error)} cause=${String((error as Error & {cause?:unknown}).cause)}`);throw error;}},host:'127.0.0.1',port:0}));
  const baseUrl=(await runtime.ready).origin,client=(role:typeof roles[number])=>new WorkspaceClient({baseUrl,projectId,token:tokens[role],maxRequests:100,deadline:60_000}),human=client('human'),runner=client('runner');
  const apiObligations=['legacy-response','pagination-order','cursor-validation','tenant-isolation'],uiObligations=['ui-navigation','ui-tenant-switch'];
  const proposal=await human.createProposal({requestId:'proposal',payload:{outcome:'Verify the supported paginated demo and exact source publication',constraints:['Offline fixture only'],obligations:[...apiObligations,...uiObligations].map(id=>({id,description:id,acceptanceExamples:[]})),requiredCheckIds:['mandatory-demo-api','mandatory-demo-ui'],unresolvedQuestions:[]}}) as {id:string};
  await human.approveProposal(proposal.id,{requestId:'approve',expectedVersion:0,payload:{}});
  await human.configurePolicy({requestId:'policy',expectedVersion:0,payload:{contractVersion:1,checkSuiteDigest:mandatoryDemoSuiteDigest(),harnessVersion:'json-oracle-v1',checks:[{id:'mandatory-demo-api',obligationIds:apiObligations},{id:'mandatory-demo-ui',obligationIds:uiObligations}],requireIndependentReview:true,sourceBackend:'artifacts-git'}});
  const initialized=await human.initializeBaseline({requestId:'baseline',expectedVersion:0,payload:{commitOid,treeOid}});
  const result=await runSourceJob(runner,{remote:localBare,workspaceRoot:work,resolveRepository:()=>source,requestId:'wire-seed',sourceBackend:'artifacts-git'}).catch(async error=>{const fixture=await (await fetch(`${baseUrl}/fixture-capabilities`)).json();const job=await runner.sourceJob(initialized.id);throw new Error(`${String(error)} sourceJob=${JSON.stringify(job.data)} wire=${wireTrace.join('|')} fixture=${JSON.stringify(fixture)}`)});
  expect(result?.data, `job=${JSON.stringify(result?.data)} wire=${wireTrace.join('|')}`).toMatchObject({status:'completed'});expect((await runner.sourceJob(initialized.id)).data.status).toBe('completed');
  const baseline=await human.baseline();expect(baseline?.receipt).toMatchObject({backend:'artifacts-git',commitOid,treeOid});
  const readback=await readSourceReceipt(localBare,baseline!.receipt!.ref);
  expect(readback).toMatchObject({ref:baseline!.receipt!.ref,commitOid:baseline!.receipt!.commitOid,treeOid:baseline!.receipt!.treeOid});
  expect(baseline!.receipt!.backend).toBe('artifacts-git');
  expect(runGit(join(scratch,'repos','target.git'), 'rev-parse', '--verify', baseline!.receipt!.ref)).toBe(baseline!.receipt!.commitOid);
  expect(runGit(join(scratch,'repos','target.git'), 'show', `${commitOid}:baseline.txt`)).toBe('wire baseline');
  expect(wireTrace.some(x=>x.includes('git-receive-pack'))).toBe(true);expect(wireTrace.some(x=>x.includes('git-upload-pack'))).toBe(true);
  const capabilities = await (await fetch(`${baseUrl}/fixture-capabilities`)).json() as string[];
  expect(capabilities).toContain('get');expect(capabilities).toContain('info');expect(capabilities).toContain('createToken');expect(capabilities).toContain('revokeToken');expect(capabilities.filter(x=>x==='dispose').length).toBeGreaterThan(0);
  expect(await human.baseline()).toEqual(baseline);
  const contributor=client('contributor');
  const change=await contributor.createChange({requestId:'change',payload:{title:'Prepared paginated demo',obligationIds:[...apiObligations,...uiObligations]}});
  await mkdir(join(source,'demo/seed'),{recursive:true});await writeFile(join(source,'demo/seed/index.ts'),preparedPaginatedDemo);runGit(source,'add','.');runGit(source,'commit','-qm','prepared paginated demo');
  const revisionCommit=runGit(source,'rev-parse','HEAD'),revisionTree=runGit(source,'rev-parse','HEAD^{tree}');
  const revision=await contributor.publishRevision(change.id,{requestId:'revision',payload:{baseCommitOid:commitOid,commitOid:revisionCommit,treeOid:revisionTree,obligationIds:[...apiObligations,...uiObligations],decisionRevisions:[],dependencies:[]}});
  await runSourceJob(runner,{remote:localBare,workspaceRoot:work,resolveRepository:()=>source,requestId:'wire-publication',sourceBackend:'artifacts-git'});
  const published=await contributor.revision(revision.id);expect(published.data.status).toBe('published');
  const publicationReceipt=published.data.receipt!;expect(publicationReceipt).toMatchObject({backend:'artifacts-git',commitOid:revisionCommit,treeOid:revisionTree});
  expect(runGit(targetRepo(),'rev-parse','--verify',publicationReceipt.ref)).toBe(revisionCommit);
  expect(runGit(targetRepo(),'show',`${revisionCommit}:baseline.txt`)).toBe('wire baseline');
  const viewCreated=await contributor.createView({requestId:'view',payload:{baseVersion:1,baseCommitOid:commitOid,contractVersion:1,policyVersion:1,orderedRevisions:[{changeId:change.id,revisionId:revision.id}],excludedChangeIds:[],decisionRevisions:[],compositionVersion:1}});
  await runSourceJob(runner,{remote:localBare,workspaceRoot:work,requestId:'wire-composition',sourceBackend:'artifacts-git',resolveRepository:()=>{throw new Error('composition uses its local cache');}});
  const view=await contributor.view(viewCreated.id);expect(view.data.status).toBe('runnable');expect(view.data.receipt).toMatchObject({backend:'artifacts-git',commitOid:view.data.receipt!.commitOid,treeOid:view.data.receipt!.treeOid});
  const viewReceipt=view.data.receipt!;expect(runGit(targetRepo(),'rev-parse','--verify',viewReceipt.ref)).toBe(viewReceipt.commitOid);
  expect(runGit(targetRepo(),'show',`${viewReceipt.commitOid}:baseline.txt`)).toBe('wire baseline');
  expect(runGit(targetRepo(),'show',`${viewReceipt.commitOid}:demo/seed/index.ts`)).toBe(preparedPaginatedDemo.trimEnd());
  await verifyViewSource(runner,{remote:localBare,viewId:view.id,requestId:'wire-source-verification'});
  const verified=await contributor.sourceVerification(view.id);expect(verified?.data).toMatchObject({viewId:view.id,receipt:{ref:viewReceipt.ref,commitOid:viewReceipt.commitOid,treeOid:viewReceipt.treeOid}});
  const mandatory=await runViewMandatoryDemoSuite(runner,{remote:localBare,workspaceRoot:work,viewId:view.id,projectId,requestId:'mandatory-demo'});
  expect(mandatory).toHaveLength(2);expect(mandatory.map(c=>c.data.checkId).sort()).toEqual(['mandatory-demo-api','mandatory-demo-ui']);expect(mandatory.every(c=>c.data.result==='passed')).toBe(true);
  expect(mandatory.every(c=>c.data.applicability.checkSuiteDigest===mandatoryDemoSuiteDigest()&&c.data.applicability.composedCommitOid===viewReceipt.commitOid&&c.data.applicability.treeOid===viewReceipt.treeOid)).toBe(true);
  const readbackChecks=(await human.checks(view.id)).filter(c=>c.data.checkId.startsWith('mandatory-demo-'));expect(readbackChecks.map(c=>c.data.checkId).sort()).toEqual(['mandatory-demo-api','mandatory-demo-ui']);expect(readbackChecks.every(c=>c.data.result==='passed')).toBe(true);
  const readiness = await human.readiness(view.id);
  expect(readiness.ready).toBe(false);
  expect([...new Set(readiness.blockers.map((blocker) => blocker.code))]).toEqual(['REVIEW_MISSING']);
  const artifact=await buildReviewArtifact(runner,{remote:localBare,workspaceRoot:work,viewId:view.id});
  expect(artifact.data.diff.patch).toContain('demo/seed/index.ts');expect(artifact.data.preview?.supported).toBe('project-list-demo-v1');expect(artifact.data.preview?.expiresAt).toBeGreaterThan(Date.now());
  expect(await human.reviewArtifact(view.id)).toEqual(artifact);
  expect(await human.baseline()).toEqual(baseline);
  expect(runGit(targetRepo(),'rev-parse','--verify',viewReceipt.ref)).toBe(viewReceipt.commitOid);
  expect((await human.readiness(view.id)).ready).toBe(false);
  expect(wireTrace.filter(x=>x.startsWith('POST ')&&x.includes('/git-upload-pack')).length).toBeGreaterThanOrEqual(1);
  expect(wireTrace).toContain(`server GET /target.git/info/refs?service=git-upload-pack`);
  expect(wireTrace).toContain('server POST /target.git/git-upload-pack');
},90_000);
