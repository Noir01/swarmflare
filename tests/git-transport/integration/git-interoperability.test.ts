import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { AddressInfo } from 'node:net';
import { assertRefUpdated, buildPack, encodeCommit, encodeTree, fetchPack, hashObject, listRefs, parsePack, receivePack, ZERO_SHA } from '../../../packages/git-transport/index.js';
import { ArtifactsSourceStore } from '../../../packages/artifacts-source/index.js';
import { sourceRef, type SourceJobInput } from '../../../packages/contracts/source.js';
import { runSourceJob } from '../../../packages/local-runner/index.js';

let root = '', base = '', server: Server;
const children = new Set<ReturnType<typeof spawn>>();
const routes: string[] = [];
let closed = false;
const gitEnv = () => ({ PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'xdg'), TMPDIR: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_ATTR_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: root });
function run(args: string[], cwd = root, input?: Uint8Array): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn('git', args, { cwd, env: gitEnv(), stdio: ['pipe', 'pipe', 'pipe'] }); children.add(p);
    const out: Buffer[] = []; let size = 0, err = ''; const timer = setTimeout(() => p.kill('SIGKILL'), 15000);
    p.stdout.on('data', x => { size += x.length; if (size <= 16*1024*1024) out.push(x); else p.kill('SIGKILL'); }); p.stderr.on('data', x => { if (err.length < 8192) err += x.toString().slice(0, 8192-err.length); });
    p.on('error', e => { clearTimeout(timer); children.delete(p); reject(e); });
    p.on('close', code => { clearTimeout(timer); children.delete(p); code === 0 ? resolve(Buffer.concat(out)) : reject(Error(`git ${args.join(' ')} exit ${code}: ${err}`)); }); p.stdin.end(input);
  });
}
function cgi(env: NodeJS.ProcessEnv, body: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn('git', ['http-backend'], { cwd: root, env, stdio: ['pipe','pipe','ignore'] }); children.add(p); const chunks: Buffer[]=[]; let size=0; const timer=setTimeout(()=>p.kill('SIGKILL'),15000);
    p.stdout.on('data', x=>{size+=x.length;if(size<=16*1024*1024)chunks.push(x);else p.kill('SIGKILL')}); p.on('error',e=>{clearTimeout(timer);children.delete(p);reject(e)}); p.on('close',code=>{clearTimeout(timer);children.delete(p);code===0?resolve(Buffer.concat(chunks)):reject(Error(`http-backend exit ${code}`))}); p.stdin.end(body);
  });
}
function parseCgi(data: Buffer) { const a=data.indexOf('\r\n\r\n'), b=a<0?data.indexOf('\n\n'):a; if(b<0)return {status:502,headers:{},body:data}; const d=a<0?2:4; let status=200; const headers:Record<string,string>={}; for(const l of data.subarray(0,b).toString().split(/\r?\n/)){const i=l.indexOf(':');if(i<0)continue;const k=l.slice(0,i).trim(),v=l.slice(i+1).trim();if(k.toLowerCase()==='status')status=parseInt(v,10);else headers[k]=v;} return {status,headers,body:data.subarray(b+d)}; }
async function start() {
  const repos=join(root,'repos'); await mkdir(repos);
  server=createServer((req,res)=>{const u=new URL(req.url??'/','http://127.0.0.1');routes.push(`${req.method} ${u.pathname}${u.search}`);const chunks:Buffer[]=[];req.on('data',c=>chunks.push(Buffer.from(c)));req.on('end',async()=>{try{let body=Buffer.concat(chunks);if(req.headers['content-encoding']==='gzip')body=gunzipSync(body);const env={...gitEnv(),GIT_PROJECT_ROOT:repos,GIT_HTTP_EXPORT_ALL:'1',REQUEST_METHOD:req.method??'GET',PATH_INFO:decodeURIComponent(u.pathname),QUERY_STRING:u.search.slice(1),CONTENT_TYPE:req.headers['content-type']??'',CONTENT_LENGTH:String(body.length),REMOTE_ADDR:'127.0.0.1',SERVER_PROTOCOL:'HTTP/1.1',...(req.headers['git-protocol']?{GIT_PROTOCOL:String(req.headers['git-protocol'])}:{})};const r=parseCgi(await cgi(env,body));res.writeHead(r.status,r.headers).end(r.body);}catch{res.writeHead(500).end();}});});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await run(['init','-q','--bare','--initial-branch=main',join(repos,'target.git')]);await run(['-C',join(repos,'target.git'),'config','http.receivepack','true']);await run(['-C',join(repos,'target.git'),'config','core.hooksPath','/dev/null']);
}
const logical='https://acct.artifacts.cloudflare.net/git/project/repo.git';
const mappedFetch:typeof fetch=async(input,init)=>{const r=input instanceof Request?input:new Request(input,init),u=new URL(r.url),l=new URL(logical),suffix=u.pathname.slice(l.pathname.length);if(u.origin!==l.origin||u.pathname!==l.pathname+suffix||!['/info/refs','/git-upload-pack','/git-receive-pack'].includes(suffix)||u.searchParams.size>1||[...u.searchParams.keys()].some(k=>k!=='service'))throw Error('logical URL refused');const h=new Headers(r.headers);h.delete('authorization');return fetch(`${base}/target.git${suffix}${u.search}`,{method:r.method,headers:h,body:['GET','HEAD'].includes(r.method)?undefined:await r.arrayBuffer(),redirect:'manual'});};
const remote=()=>({url:logical,fetch:mappedFetch});
const oid=(ref:string)=>run(['--git-dir',join(root,'repos/target.git'),'rev-parse',ref]).then(b=>b.toString().trim());
const sig={name:'Test',email:'test@example.invalid',timestamp:1,timezone:'+0000'};
async function commitPack(label:string){const blob=new TextEncoder().encode(label+'\n'),bo=await hashObject({type:'blob',data:blob}),tree=encodeTree([{mode:'100644',name:'file.txt',sha:bo}]),to=await hashObject({type:'tree',data:tree}),commit=encodeCommit({tree:to,parents:[],author:sig,committer:sig,message:label+'\n'}),co=await hashObject({type:'commit',data:commit}),pack=await buildPack([{type:'blob',data:blob},{type:'tree',data:tree},{type:'commit',data:commit}]);return {bo,to,co,pack};}

describe('local Git smart-HTTP interoperability',()=>{
 beforeAll(async()=>{root=await mkdtemp(join(tmpdir(),'git-transport-'));await mkdir(join(root,'home'));await mkdir(join(root,'xdg'));await start();},30000);
 afterAll(async()=>{for(const p of children)p.kill('SIGKILL');await Promise.all([...children].map(p=>new Promise<void>(r=>p.once('close',()=>r()))));if(server)await new Promise<void>(r=>server.close(()=>{closed=true;r()}));expect(closed).toBe(true);expect(children.size).toBe(0);if(root){await rm(root,{recursive:true,force:true});await expect(access(root)).rejects.toThrow();}},30000);
 it('discovers v1/v2 and CAS-creates a real Git-readable object graph',async()=>{const {to,co,pack}=await commitPack('success'),r='refs/heads/integration-success';const a=await listRefs(remote(),{protocol:1}),b=await listRefs(remote(),{protocol:2});expect([a.protocol,b.protocol]).toEqual([1,2]);expect((await parsePack(pack)).map(x=>x.sha)).toContain(co);const report=await receivePack(remote(),[{ref:r,oldSha:ZERO_SHA,newSha:co}],pack);expect(assertRefUpdated(report,r).ok).toBe(true);expect(await oid(r)).toBe(co);expect((await run(['--git-dir',join(root,'repos/target.git'),'cat-file','-p',co])).toString()).toContain('success');expect((await run(['--git-dir',join(root,'repos/target.git'),'cat-file','-e',to])).length).toBe(0);},30000);
 it('refuses stale CAS and preserves actual Git winner',async()=>{const x=await commitPack('winner'),y=await commitPack('loser'),r='refs/heads/integration-cas';await receivePack(remote(),[{ref:r,oldSha:ZERO_SHA,newSha:x.co}],x.pack);const report=await receivePack(remote(),[{ref:r,oldSha:ZERO_SHA,newSha:y.co}],y.pack);expect(()=>assertRefUpdated(report,r)).toThrow();expect(await oid(r)).toBe(x.co);},30000);
 it('fetches upload-pack and imports real pack into Git',async()=>{const x=await commitPack('fetch'),r='refs/heads/integration-fetch';await receivePack(remote(),[{ref:r,oldSha:ZERO_SHA,newSha:x.co}],x.pack);const pack=await fetchPack(remote(),{wants:[x.co]});expect((await parsePack(pack)).some(o=>o.sha===x.co&&o.type==='commit')).toBe(true);const dest=join(root,'import.git');await run(['init','-q','--bare',dest]);await run(['--git-dir',dest,'index-pack','--stdin'],root,pack);expect((await run(['--git-dir',dest,'cat-file','-p',x.co])).toString()).toContain('fetch');},30000);
 it('maps exact logical HTTPS URL to loopback and routes requests',async()=>{const n=routes.length;await listRefs({...remote(),auth:{bearer:'synthetic-test-token'}});expect(routes.length).toBeGreaterThan(n);expect(routes.slice(n).every(x=>x.includes('/target.git/'))).toBe(true);});
 it('isolates Git subprocesses from operator and injected Git environment',async()=>{const keys=['PROJECT_SECRET_TEST_ONLY','GIT_CONFIG_COUNT','GIT_CONFIG_KEY_0','GIT_CONFIG_VALUE_0','GIT_DIR','GIT_CONFIG_GLOBAL','GIT_CONFIG_NOSYSTEM','GIT_ATTR_NOSYSTEM','GIT_TRACE'];const old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));try{Object.assign(process.env,{PROJECT_SECRET_TEST_ONLY:'sentinel-secret-value',GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'safe.sentinel',GIT_CONFIG_VALUE_0:'injected-config-value',GIT_DIR:'/definitely/not/a/repository',GIT_CONFIG_GLOBAL:'/tmp/operator-config',GIT_CONFIG_NOSYSTEM:'0',GIT_ATTR_NOSYSTEM:'0',GIT_TRACE:'/tmp/operator-trace'});const output=(await run(['config','--list'])).toString();expect(output).not.toContain('injected-config-value');expect(output).not.toContain('sentinel-secret-value');const check=join(root,'environment-check');await run(['init','-q',check]);expect((await run(['rev-parse','--show-toplevel'],check)).toString().trim()).toBe(check);}finally{for(const k of keys){if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k];}}});
 it('rejects logical URL prefix confusion and unrelated routes',async()=>{for(const url of [`${logical}.attacker.invalid/info/refs?service=git-upload-pack`,`${logical}/../other.git/info/refs?service=git-upload-pack`,`https://evil.invalid/git/project/repo.git/info/refs?service=git-upload-pack`])await expect(mappedFetch(url)).rejects.toThrow('logical URL refused');});
 it('publishes then reads back through ArtifactsSourceStore and real Git transport',async()=>{
  const {to,co,pack}=await commitPack('adapter integration');const job:SourceJobInput={kind:'seed',seedId:'adapter_seed',source:{commitOid:co,treeOid:to}},ref=sourceRef(job);let revoked=0;
  const repo={info:async()=>({remote:logical}),createToken:async(_scope:'read'|'write',_ttl:number):Promise<{id?:string;plaintext:string;expiresAt?:string}>=>{const expiry=Math.floor(Date.now()/1000)+240;return{id:'synthetic-token',plaintext:`art_v1_${'a'.repeat(40)}?expires=${expiry}`,expiresAt:new Date(expiry*1000).toISOString()};},revokeToken:async(_token:string)=>{revoked++;return true;}};
  const store=new ArtifactsSourceStore({repo,remote:logical,fetch:mappedFetch,allowWrites:true});
  const receipt=await store.publish({input:job,commitOid:co,treeOid:to,pack});expect(receipt).toEqual({backend:'artifacts-git',ref,commitOid:co,treeOid:to});expect(await oid(ref)).toBe(co);expect((await run(['--git-dir',join(root,'repos/target.git'),'cat-file','-p',co])).toString()).toContain('adapter integration');
  expect(await store.read({ref,commitOid:co,treeOid:to})).toEqual(receipt);expect(revoked).toBe(2);
  expect(await store.publish({input:job,commitOid:co,treeOid:to,pack})).toEqual(receipt);
  const other=await commitPack('conflict');const badJob:SourceJobInput={kind:'seed',seedId:'adapter_seed',source:{commitOid:other.co,treeOid:other.to}};
  await expect(store.publish({input:badJob,commitOid:other.co,treeOid:other.to,pack:other.pack})).rejects.toThrow('SOURCE_REF_CONFLICT');expect(await oid(ref)).toBe(co);
  const before=revoked;await expect(store.publish({input:job,commitOid:'b'.repeat(40),treeOid:to,pack})).rejects.toThrow();expect(revoked).toBe(before);
  const disabled=new ArtifactsSourceStore({repo,remote:logical,fetch:mappedFetch});await expect(disabled.publish({input:job,commitOid:co,treeOid:to,pack})).rejects.toThrow('ARTIFACTS_WRITES_DISABLED');expect(revoked).toBe(before);
  const failingRepo={...repo,revokeToken:async()=>{revoked++;return true;}};const failing=new ArtifactsSourceStore({repo:failingRepo,remote:logical,fetch:async()=>{throw Error('deliberate test failure');},allowWrites:true});await expect(failing.read({ref,commitOid:co,treeOid:to})).rejects.toThrow('ARTIFACTS_TRANSPORT_FAILED');expect(revoked).toBe(before+1);
 },30000);
 it('runs seed, revision, and composed View through local runner and real Git HTTP',async()=>{
  const source=join(root,'runner-source'),revisionSource=join(root,'runner-revision'),localBare=join(root,'runner-local.git');await mkdir(source);await run(['init','-q',source]);await run(['init','--bare','-q',localBare]);
  await run(['-C',source,'config','user.name','Runner Test']);await run(['-C',source,'config','user.email','runner@example.invalid']);
  const {writeFile}=await import('node:fs/promises');await writeFile(join(source,'runner.txt'),'baseline\n');await run(['-C',source,'add','.']);await run(['-C',source,'commit','-qm','runner baseline']);
  const baseCommitOid=(await run(['-C',source,'rev-parse','HEAD'])).toString().trim(),baseTreeOid=(await run(['-C',source,'rev-parse','HEAD^{tree}'])).toString().trim();
  await run(['clone','-q',source,revisionSource]);await run(['-C',revisionSource,'config','user.name','Runner Test']);await run(['-C',revisionSource,'config','user.email','runner@example.invalid']);await writeFile(join(revisionSource,'runner.txt'),'revision contribution\n');await run(['-C',revisionSource,'add','.']);await run(['-C',revisionSource,'commit','-qm','runner revision']);
  const revisionCommitOid=(await run(['-C',revisionSource,'rev-parse','HEAD'])).toString().trim(),revisionTreeOid=(await run(['-C',revisionSource,'rev-parse','HEAD^{tree}'])).toString().trim();
  const revision={changeId:'runner_change',revisionId:'runner_revision',owner:'runner',baseCommitOid,commitOid:revisionCommitOid,treeOid:revisionTreeOid,obligationIds:['runner_obligation'],decisionRevisions:[],dependencies:[]};
  const seed:SourceJobInput={kind:'seed',seedId:'runner_wire_seed',source:{commitOid:baseCommitOid,treeOid:baseTreeOid}};
  const publication:SourceJobInput={kind:'publication',revision};
  const manifest={baseVersion:1,baseCommitOid,contractVersion:1,policyVersion:1,orderedRevisions:[{changeId:revision.changeId,revisionId:revision.revisionId}],excludedChangeIds:[],decisionRevisions:[],compositionVersion:1};
  const view:SourceJobInput={kind:'composition',viewId:'runner_wire_view',manifest,manifestDigest:'d'.repeat(64),revisions:[revision]};
  const inputs=[seed,publication,view];let next=0;const calls:string[]=[];
  // Repo/token/job metadata are synthetic test doubles; Git objects and HTTP wire are real local Git.
  const repo={info:async()=>({remote:logical}),createToken:async()=>{const expiry=Math.floor(Date.now()/1000)+240;return{id:'synthetic-runner-token',plaintext:`art_v1_${'c'.repeat(40)}?expires=${expiry}`,expiresAt:new Date(expiry*1000).toISOString()};},revokeToken:async()=>true};
  const store=new ArtifactsSourceStore({repo,remote:logical,fetch:mappedFetch,allowWrites:true});
  const client={claimSourceJob:async()=>{const input=inputs[next++]!;const attemptId=`runner_wire_attempt_${next}`;calls.push(`claim:${input.kind}`);return{id:`runner_wire_job_${next}`,version:1,owner:'system',data:{input,status:'leased',attemptId,runnerId:'synthetic-test-runner',leaseExpiresAt:Date.now()+30000,receipt:null,error:null}};},publishArtifactsSourceJob:async(_id:string,envelope:{payload:{attemptId:string;commitOid:string;treeOid:string;packBase64:string;manifestDigest?:string}})=>{const input=inputs[Number(envelope.payload.attemptId.slice(-1))-1]!;calls.push(`publish:${input.kind}`);const payload=envelope.payload;const receipt=await store.publish({input,commitOid:payload.commitOid,treeOid:payload.treeOid,pack:Buffer.from(payload.packBase64,'base64')});return{id:`runner_wire_job_${next}`,version:1,owner:'system',data:{input,status:'completed',attemptId:envelope.payload.attemptId,runnerId:'synthetic-test-runner',leaseExpiresAt:null,receipt,error:null}};},completeSourceJob:async()=>{throw Error('Artifacts backend must not use legacy completion');}};
  const resolveRepository=(input:SourceJobInput)=>input.kind==='seed'?source:input.kind==='publication'?revisionSource:localBare;
  const results=[];for(let i=0;i<inputs.length;i++)results.push(await runSourceJob(client as never,{remote:localBare,workspaceRoot:root,resolveRepository,requestId:`runner-wire-${i}`,sourceBackend:'artifacts-git'}));
  expect(results.map(result=>result?.data.status)).toEqual(['completed','completed','completed']);expect(calls).toEqual(['claim:seed','publish:seed','claim:publication','publish:publication','claim:composition','publish:composition']);expect(next).toBe(3);
  const expected=[seed,publication,view];for(const input of expected){const ref=sourceRef(input);const actual=(await oid(ref));const receipt=await store.read({ref,commitOid:actual,treeOid:(await run(['--git-dir',join(root,'repos/target.git'),'rev-parse',`${actual}^{tree}`])).toString().trim()});expect(receipt).toMatchObject({backend:'artifacts-git',ref,commitOid:actual});expect((await run(['--git-dir',join(root,'repos/target.git'),'cat-file','-e',actual])).length).toBe(0);}
  const viewOid=await oid(sourceRef(view));expect((await run(['--git-dir',join(root,'repos/target.git'),'show',`${viewOid}:runner.txt`])).toString().trim()).toBe('revision contribution');
  expect((await run(['--git-dir',join(root,'repos/target.git'),'rev-parse',`${revisionCommitOid}^{tree}`])).toString().trim()).toBe(revisionTreeOid);
 },30000);
});
