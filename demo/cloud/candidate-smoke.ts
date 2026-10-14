import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkoutExactNativeSource, PROJECT_ID } from './native-checkout.js';
import { validateFixture, ORIGIN } from './foundation-smoke.js';
import { WorkspaceClient } from '../../packages/client/index.js';
import { runSourceJob } from '../../packages/local-runner/index.js';
import { verifyViewSource, runViewMandatoryDemoSuite } from '../../packages/local-runner/checks.js';
import { buildReviewArtifact } from '../../packages/local-runner/review-artifact.js';
import { readSourceReceipt } from '../../packages/git-runner/index.js';
import { preparedPaginatedDemo } from '../../tests/fixtures/paginated-demo.js';
import { demoPolicyManifest } from '../../apps/worker/src/generated/demo-policy.js';

export const CANDIDATE_PHASES=['prepare','revision','view','checks'] as const;
export type CandidatePhase=typeof CANDIDATE_PHASES[number];
export function parsePhase(x:unknown):CandidatePhase{if(typeof x!=='string'||!CANDIDATE_PHASES.includes(x as CandidatePhase))throw new Error('INVALID_PHASE');return x as CandidatePhase;}
const ROOT=resolve('.local/cloud-cont47'), CACHE=resolve(ROOT,'cache.git'), WORK=resolve(ROOT,'prepared');
const PRIVATE=resolve(ROOT,'candidate-private.json'), REPORT=resolve('reports/evaluation/continuous47-native-candidate.json');
const ORIGINAL=resolve('.local/cloud-cont40/platform-smoke-private.json');
const OID=/^[0-9a-f]{40}$/;
const obligations=demoPolicyManifest.contract.obligations.map(o=>o.id);
type Tuple={ref:string;commitOid:string;treeOid:string};
type State={projectId:string;requestIds:Record<string,string>;baseline?:Tuple&{version:number};prepared?:{commitOid:string;treeOid:string};grant?:{token:string;id:string;expiresAt:number};changeId?:string;revisionId?:string;viewId?:string;revision?:Tuple;view?:Tuple;checks?:Array<{checkId:string;result:string;id:string}>;artifactId?:string};
const canonical=(x:any):any=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const same=(a:unknown,b:unknown)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
function git(path:string,...args:string[]){return execFileSync('git',['-C',path,...args],{encoding:'utf8',timeout:10000,stdio:['ignore','pipe','ignore'],env:{PATH:process.env.PATH,HOME:'/nonexistent',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_NO_REPLACE_OBJECTS:'1',GIT_CONFIG_COUNT:'2',GIT_CONFIG_KEY_0:'core.hooksPath',GIT_CONFIG_VALUE_0:'/dev/null',GIT_CONFIG_KEY_1:'commit.gpgsign',GIT_CONFIG_VALUE_1:'false',GIT_AUTHOR_NAME:'Prepared trusted fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'Prepared trusted fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'}}).trim();}
export async function prepareRepository(cache:string,work:string,baselineOid:string){
 if(!OID.test(baselineOid))throw Error('INVALID_BASELINE');
 try{await lstat(work);throw Error('WORK_ALREADY_EXISTS');}catch(e:any){if(e.code!=='ENOENT')throw e;}
 await mkdir(dirname(work),{recursive:true,mode:0o700});
 execFileSync('git',['clone','--quiet','--no-checkout',cache,work],{stdio:['ignore','ignore','ignore'],timeout:10000,env:{PATH:process.env.PATH,HOME:'/nonexistent',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}});
 git(work,'checkout','-q','--detach',baselineOid);
 await mkdir(resolve(work,'demo/seed'),{recursive:true});
 await writeFile(resolve(work,'demo/seed/index.ts'),preparedPaginatedDemo+'\n');
 git(work,'add','demo/seed/index.ts');git(work,'commit','-qm','prepared first-party pagination fixture');
 const commitOid=git(work,'rev-parse','HEAD'),treeOid=git(work,'rev-parse','HEAD^{tree}');
 if(git(work,'rev-parse','HEAD^')!==baselineOid||commitOid===baselineOid)throw Error('INVALID_PREPARED_PARENT');
 return{commitOid,treeOid};
}
async function privateRead(path:string){const s=await lstat(path);if(s.isSymbolicLink()||!s.isFile()||(s.mode&0o077)!==0)throw Error('PRIVATE_PERMISSIONS');return JSON.parse(await readFile(path,'utf8'));}
export async function executePhase(phase:CandidatePhase){
 parsePhase(phase);
 const original=await privateRead(ORIGINAL);
 const safe=JSON.parse(await readFile('reports/evaluation/continuous40-platform-smoke.json','utf8'));
 const repo=validateFixture(original.identity,safe);if(repo.projectId!==PROJECT_ID)throw Error('SCOPE_INVALID');
 const foundation=JSON.parse(await readFile('reports/evaluation/continuous46-native-foundation.json','utf8'));
 if(foundation.projectId!==PROJECT_ID||foundation.baseline?.commitOid!==repo.source.commitOid||foundation.baseline?.treeOid!==repo.source.treeOid||!/^refs\/agent\/seeds\/[0-9a-f-]{36}$/.test(foundation.baseline.receiptRef))throw Error('FOUNDATION_INVALID');
 await mkdir(ROOT,{recursive:true,mode:0o700});const dir=await lstat(ROOT);if(dir.isSymbolicLink()||(dir.mode&0o077)!==0)throw Error('PRIVATE_PERMISSIONS');
 let state:State;try{state=await privateRead(PRIVATE);}catch(e:any){if(e.code!=='ENOENT')throw e;state={projectId:PROJECT_ID,requestIds:{}};await writeFile(PRIVATE,JSON.stringify(state),{mode:0o600,flag:'wx'});}
 if(state.projectId!==PROJECT_ID||!state.requestIds)throw Error('STATE_SCOPE_INVALID');
 const results:any[]=[];const end=Date.now()+90000;let requests=0;
 const save=async()=>{await writeFile(PRIVATE,JSON.stringify(state),{mode:0o600});};
 const report=async()=>{await writeFile(REPORT,JSON.stringify({provenance:'Actual native Worker/Artifacts and real Git; explicitly prepared trusted FIRST-PARTY fixture, not a fresh agent campaign or human acceptance.',phase,projectId:PROJECT_ID,results,baseline:state.baseline,prepared:state.prepared,changeId:state.changeId,revisionId:state.revisionId,viewId:state.viewId,revision:state.revision,view:state.view,checks:state.checks,artifactId:state.artifactId,acceptancePerformed:false},null,2)+'\n',{mode:0o600});};
 const boundedFetch:typeof fetch=async(input,init)=>{const url=new URL(typeof input==='string'||input instanceof URL?String(input):input.url);if(url.origin!==ORIGIN||url.username||url.password||++requests>60||Date.now()>end)throw Error('REQUEST_SCOPE_BUDGET');const method=init?.method??'GET';const r=await fetch(input,{...init,redirect:'error',signal:AbortSignal.timeout(Math.min(20000,Math.max(1,end-Date.now())))});results.push({path:url.pathname,method,status:r.status});await report();return r;};
 const call=async(path:string,method='GET',body?:unknown,headers:Record<string,string>={},expected=200)=>{const r=await boundedFetch(ORIGIN+path,{method,headers:{origin:ORIGIN,'content-type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});let data:any;try{data=await r.json();}catch{throw Error('RESPONSE_INVALID');}if(r.status!==expected)throw Object.assign(Error('HTTP_REFUSED'),{safe:{phase,path,status:r.status,code:typeof data.code==='string'&&/^[A-Z_]{1,64}$/.test(data.code)?data.code:'REFUSED'}});return{data,response:r};};
 const key=async(name:string)=>{state.requestIds[name]??=randomUUID();await save();return state.requestIds[name]!;};
 const base='/api/v1/projects/'+PROJECT_ID;
 const catalog=(await call('/api/platform/repos/'+repo.owner+'/'+repo.name)).data.repository;
 if(!catalog||catalog.id!==repo.id||catalog.status!=='ready'||!same(catalog.source,repo.source))throw Error('CATALOG_CHANGED');
 const baseline=(await call(base+'/baseline')).data.resource,context=(await call(base+'/context')).data.resource,policy=(await call(base+'/policy')).data.resource;
 if(!baseline||baseline.version!==1||baseline.commitOid!==repo.source.commitOid||baseline.treeOid!==repo.source.treeOid||baseline.receipt?.ref!==foundation.baseline.receiptRef||baseline.receipt.backend!=='artifacts-git'||context.contract?.version!==1||!same(context.contract.data,demoPolicyManifest.contract)||policy?.version!==1||!same(policy.data,{contractVersion:1,...demoPolicyManifest.policyTemplate}))throw Error('FOUNDATION_CHANGED');
 state.baseline={version:baseline.version,commitOid:baseline.commitOid,treeOid:baseline.treeOid,ref:baseline.receipt.ref};await save();
 const client=(token:string)=>new WorkspaceClient({baseUrl:ORIGIN,projectId:PROJECT_ID,token,fetch:boundedFetch,maxRequests:60,deadline:90000});
 const runner=async()=>{const k=await privateRead('.local/cloud-cont44/runner-private.json');if(!/^[a-f0-9]{64}$/.test(k.key))throw Error('RUNNER_CONFIG');const issued=(await call('/api/platform/runner/sessions','POST',{projectId:PROJECT_ID,expiresInSeconds:120,maxOperations:60},{authorization:'Bearer '+k.key},201)).data;if(!/^sfr_[a-f0-9]{64}$/.test(issued.token))throw Error('RUNNER_SESSION');return client(issued.token);};
 const contribution=()=>{if(!state.grant||state.grant.expiresAt<=Date.now())throw Error('CONTRIBUTOR_GRANT_EXPIRED');return client(state.grant.token);};
 const unchanged=async()=>{const b=(await call(base+'/baseline')).data.resource,c=(await call('/api/platform/repos/'+repo.owner+'/'+repo.name)).data.repository;if(!same(b,baseline)||!same(c.source,repo.source))throw Error('BASELINE_SOURCE_CHANGED');};
 if(phase==='prepare'){
  await checkoutExactNativeSource({ref:baseline.receipt.ref,commitOid:baseline.commitOid,treeOid:baseline.treeOid,barePath:CACHE});
  if(!state.prepared){state.prepared=await prepareRepository(CACHE,WORK,baseline.commitOid);await save();}else if(git(WORK,'rev-parse','HEAD')!==state.prepared.commitOid||git(WORK,'rev-parse','HEAD^{tree}')!==state.prepared.treeOid)throw Error('PREPARED_SOURCE_CHANGED');
  if(!state.grant){let cookie='',csrf='';try{const login=await call('/api/platform/auth/login','POST',{login:original.identity.email,password:original.identity.password});cookie=login.response.headers.get('set-cookie')?.split(';')[0]??'';csrf=login.data.csrf;if(!cookie||!csrf)throw Error('LOGIN_INVALID');const s=(await call('/api/platform/auth/session','GET',undefined,{cookie})).data;if(s.user?.username!==repo.owner)throw Error('LOGIN_SCOPE');const issued=(await call('/api/platform/repos/'+repo.owner+'/'+repo.name+'/agents','POST',{role:'contributor',expiresInSeconds:900},{cookie,'x-csrf-token':csrf},201)).data;if(issued.grant?.role!=='contributor'||!issued.token)throw Error('GRANT_INVALID');state.grant={token:issued.token,id:issued.grant.id,expiresAt:issued.grant.expiresAt};await save();}finally{if(cookie){await call('/api/platform/auth/logout','POST',{}, {cookie,'x-csrf-token':csrf});if((await call('/api/platform/auth/session')).data.user!==null)throw Error('LOGOUT_INVALID');}}}
 }else if(phase==='revision'){
  if(!state.prepared)throw Error('PREPARE_REQUIRED');const actor=contribution();
  const change=state.changeId?await actor.change(state.changeId):await actor.createChange({requestId:await key('change'),payload:{title:'Prepared first-party pagination fixture',obligationIds:obligations}});state.changeId=change.id;await save();
  const rev=state.revisionId?await actor.revision(state.revisionId):await actor.publishRevision(change.id,{requestId:await key('revision'),payload:{baseCommitOid:baseline.commitOid,commitOid:state.prepared.commitOid,treeOid:state.prepared.treeOid,obligationIds:obligations,decisionRevisions:[],dependencies:[]}});state.revisionId=rev.id;await save();
  if(rev.data.status!=='published'){const job=await runSourceJob(await runner(),{remote:CACHE,workspaceRoot:ROOT,requestId:await key('revision-job'),sourceBackend:'artifacts-git',resolveRepository:()=>WORK});if(!job||job.data.status!=='completed'||job.data.input.kind!=='publication'||job.data.input.revision.revisionId!==rev.id)throw Error('REVISION_JOB_FAILED');}
  const actual=await actor.revision(rev.id);if(actual.data.status!=='published'||actual.data.receipt?.backend!=='artifacts-git'||actual.data.receipt.commitOid!==state.prepared.commitOid||actual.data.receipt.treeOid!==state.prepared.treeOid)throw Error('REVISION_READBACK');state.revision=actual.data.receipt;await save();
 }else if(phase==='view'){
  if(!state.changeId||!state.revisionId||!state.revision)throw Error('REVISION_REQUIRED');const actor=contribution();const view=state.viewId?await actor.view(state.viewId):await actor.createView({requestId:await key('view'),payload:{baseVersion:1,baseCommitOid:baseline.commitOid,contractVersion:1,policyVersion:1,orderedRevisions:[{changeId:state.changeId,revisionId:state.revisionId}],excludedChangeIds:[],decisionRevisions:[],compositionVersion:1}});state.viewId=view.id;await save();
  if(view.data.status!=='runnable'){const job=await runSourceJob(await runner(),{remote:CACHE,workspaceRoot:ROOT,requestId:await key('view-job'),sourceBackend:'artifacts-git',resolveRepository:()=>CACHE});if(!job||job.data.status!=='completed'||job.data.input.kind!=='composition'||job.data.input.viewId!==view.id)throw Error('VIEW_JOB_FAILED');}
  const actual=await actor.view(view.id),cache=await readSourceReceipt(CACHE,'refs/agent/views/'+view.id);if(actual.data.status!=='runnable'||actual.data.receipt?.backend!=='artifacts-git'||cache.commitOid!==actual.data.receipt.commitOid||cache.treeOid!==actual.data.receipt.treeOid||cache.ref!==actual.data.receipt.ref)throw Error('VIEW_READBACK');state.view=actual.data.receipt;await save();
 }else{
  if(!state.viewId||!state.view)throw Error('VIEW_REQUIRED');const r=await runner();const actual=await r.view(state.viewId),cache=await readSourceReceipt(CACHE,state.view.ref);if(actual.data.receipt?.backend!=='artifacts-git'||!same(actual.data.receipt,state.view)||cache.commitOid!==state.view.commitOid||cache.treeOid!==state.view.treeOid)throw Error('CHECK_SOURCE_CHANGED');
  await verifyViewSource(r,{remote:CACHE,viewId:state.viewId,requestId:await key('verify')});
  const checks=await runViewMandatoryDemoSuite(r,{remote:CACHE,workspaceRoot:ROOT,viewId:state.viewId,projectId:PROJECT_ID,requestId:await key('checks')});state.checks=checks.map(c=>({id:c.id,checkId:c.data.checkId,result:c.data.result}));await save();
  const artifact=await buildReviewArtifact(r,{remote:CACHE,workspaceRoot:ROOT,viewId:state.viewId});state.artifactId=artifact.id;await save();
 }
 await unchanged();await save();await report();return{phase,projectId:PROJECT_ID,viewId:state.viewId,checks:state.checks,baselineUnchanged:true,acceptancePerformed:false};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){const args=process.argv.slice(2);Promise.resolve().then(()=>{if(args.length!==1)throw Error('INVALID_PHASE');return executePhase(parsePhase(args[0]));}).then(x=>console.log(JSON.stringify(x))).catch(e=>{console.error(JSON.stringify(e.safe??{code:typeof e.message==='string'&&/^[A-Z_]{1,64}$/.test(e.message)?e.message:'CANDIDATE_FAILED'}));process.exitCode=1;});}
