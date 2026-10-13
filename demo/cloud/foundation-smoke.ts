import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { demoPolicyManifest } from '../../apps/worker/src/generated/demo-policy.js';

export const ORIGIN='https://git-collaboration-demo-c29.sriva140.workers.dev';
const ORIGINAL=resolve('.local/cloud-cont40/platform-smoke-private.json');
const ORIGINAL_RECEIPT=resolve('reports/evaluation/continuous40-platform-smoke.json');
const PRIVATE=resolve('.local/cloud-cont46/foundation-private.json');
const RECEIPT=resolve('reports/evaluation/continuous46-native-foundation.json');
const MAX_REQUESTS=25, TIMEOUT=20_000;
type Repo={id:string;projectId:string;owner:string;name:string;status:string;source:{ref:string;commitOid:string;treeOid:string}};
type State={username?:string;email?:string;password?:string;cookie?:string;csrf?:string;requestIds:Record<string,string>;projectId?:string;results?:any[]};
const safeCode=(x:any)=>typeof x?.code==='string'&&/^[A-Z0-9_]{1,80}$/.test(x.code)?x.code:null;
export function validateFixture(identity:any, receipt:any):Repo {
  if(!identity||typeof identity!=='object'||!/^smoke-[a-f0-9]{20}$/.test(identity.username)||!/^smoke-[a-f0-9]{36}@example\.test$/.test(identity.email)||identity.email.slice(6,26)!==identity.username.slice(6)||typeof identity.password!=='string'||identity.password.length<20) throw new Error('SYNTHETIC_IDENTITY_INVALID');
  const r=receipt?.created;
  if(receipt?.origin!==ORIGIN||receipt?.phase!=='logout'||!r||r.owner!==identity.username||r.status!=='ready'||r.projectId!==r.id||! /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(r.projectId)||typeof r.name!=='string'||!/^probe-[a-f0-9]{10}$/.test(r.name)||!/^refs\/heads\/(main|master)$/.test(r.source?.ref)||! /^[0-9a-f]{40}$/.test(r.source?.commitOid)||! /^[0-9a-f]{40}$/.test(r.source?.treeOid))throw new Error('CREATED_REPOSITORY_INVALID');
  return r as Repo;
}
export function fixedUrl(path:string){if(!path.startsWith('/')||path.startsWith('//')||path.includes('\\')||/[?#\0]/.test(path))throw new Error('URL_INVALID');return new URL(path.startsWith('/api/')?path:`/api/platform${path}`,ORIGIN).href;}
export function requestClient(fetcher:typeof fetch,onResult: (x:any)=>Promise<void>=async()=>{}) {
 let count=0;
 return async(path:string, options:{method?:string;body?:unknown;cookie?:string;csrf?:string;expected?:number}={})=>{
  if(++count>MAX_REQUESTS)throw Object.assign(new Error('REQUEST_BUDGET'),{safe:{path,status:0,code:'REQUEST_BUDGET'}});
  const headers=new Headers({origin:ORIGIN,accept:'application/json'});if(options.cookie)headers.set('cookie',options.cookie);if(options.csrf)headers.set('x-csrf-token',options.csrf);if(options.body!==undefined)headers.set('content-type','application/json');
  let response:Response;try{response=await fetcher(fixedUrl(path),{method:options.method??'GET',headers,...(options.body===undefined?{}:{body:JSON.stringify(options.body)}),redirect:'error',signal:AbortSignal.timeout(TIMEOUT)});}catch{const e={path,status:0,code:'NETWORK'};await onResult(e);throw Object.assign(new Error('REQUEST_FAILED'),{safe:e});}
  let data:any=null;try{data=await response.json();}catch{} const entry={path,method:options.method??'GET',status:response.status,code:safeCode(data)};await onResult(entry);
  if(response.status!==(options.expected??200))throw Object.assign(new Error('REQUEST_FAILED'),{safe:entry});return {response,data};
 };
}
const canonical=(x:any):any=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const equal=(a:unknown,b:unknown)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
export async function executeFoundation(state:State, repo:Repo, fetcher:typeof fetch, onResult: (x:any)=>Promise<void>=async()=>{}, persistRequestId: (s:State)=>Promise<void>=async()=>{}) {
 if(state.username!==repo.owner||!/^smoke-[a-f0-9]{20}$/.test(state.username)||typeof state.email!=='string'||!/^smoke-[a-f0-9]{36}@example\.test$/.test(state.email)||state.email.slice(6,26)!==state.username.slice(6)||typeof state.password!=='string')throw new Error('SYNTHETIC_SCOPE_INVALID');
 const call=requestClient(fetcher,onResult), session=()=>({cookie:state.cookie,csrf:state.csrf});
 const saveId=async(key:string)=>{state.requestIds[key]??=randomUUID();await persistRequestId(state);return state.requestIds[key]!;};
 try {
 const catalog=(await call(`/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`)).data.repository;
 if(!catalog||catalog.id!==repo.id||catalog.projectId!==repo.projectId||catalog.owner!==repo.owner||catalog.name!==repo.name||catalog.status!=='ready'||!equal(catalog.source,repo.source))throw new Error('CATALOG_MISMATCH');
 const sourcePath=`/repos/${repo.owner}/${repo.name}/source`, source=(await call(sourcePath)).data;
 if(source.commitOid!==repo.source.commitOid||source.treeOid!==repo.source.treeOid)throw new Error('SOURCE_MISMATCH');
 const login=await call('/auth/login',{method:'POST',body:{login:state.email,password:state.password},expected:200});
 state.cookie=login.response.headers.get('set-cookie')?.split(';')[0];state.csrf=login.data.csrf;
 if(!state.cookie||!state.csrf)throw new Error('AUTH_INVALID');
 const current=await call('/auth/session',{cookie:state.cookie});if(current.data.user?.username!==state.username)throw new Error('SESSION_SCOPE_INVALID');
 const policyManifest=(await call('/api/swarmflare/demo-policy')).data;
 if(!policyManifest.supported||!equal(policyManifest.contract,demoPolicyManifest.contract)||!equal(policyManifest.policyTemplate,demoPolicyManifest.policyTemplate))throw new Error('POLICY_MANIFEST_MISMATCH');
 const base=`/api/v1/projects/${repo.projectId}`;
 const [ctx0,base0,pol0]=await Promise.all([call(`${base}/context`,session()),call(`${base}/baseline`,session()),call(`${base}/policy`,session())]);
 const existingContract=ctx0.data.resource?.contract;
 if(existingContract&&!equal(existingContract.data,policyManifest.contract))throw new Error('EXISTING_RESOURCE_CONFLICT');
 if(base0.data.resource&&(base0.data.resource.version!==1||base0.data.resource.commitOid!==repo.source.commitOid||base0.data.resource.treeOid!==repo.source.treeOid||base0.data.resource.receipt?.backend!=='artifacts-git'))throw new Error('EXISTING_RESOURCE_CONFLICT');
 if(pol0.data.resource&&!equal(pol0.data.resource.data,{contractVersion:1,...policyManifest.policyTemplate}))throw new Error('EXISTING_RESOURCE_CONFLICT');
 const proposals=(await call(`${base}/proposals`,session())).data.resource??[];
 const existing=proposals.find((x:any)=>equal(Object.fromEntries(Object.entries(x.data).filter(([k])=>k!=='status')),policyManifest.contract));
 const proposalId=await saveId('proposal');let prop=existing;
 if(!prop&&!existingContract){prop=(await call(`${base}/contracts/proposals`,{method:'POST',...session(),expected:201,body:{requestId:proposalId,payload:policyManifest.contract}})).data.resource;}
 if(!prop?.id||!equal(Object.fromEntries(Object.entries(prop.data).filter(([k])=>k!=='status')),policyManifest.contract))throw new Error('PROPOSAL_MISMATCH');
 const approvalId=await saveId('approve');const approved=existingContract??(await call(`${base}/contracts/${encodeURIComponent(prop.id)}/approve`,{method:'POST',...session(),expected:201,body:{requestId:approvalId,expectedVersion:0,payload:{}}})).data.resource;
 if(!approved||approved.version!==1||!equal(approved.data,policyManifest.contract))throw new Error('CONTRACT_READBACK_MISMATCH');
 const approvedProposals=(await call(`${base}/proposals`,session())).data.resource;
 if(!Array.isArray(approvedProposals)||!approvedProposals.some((p:any)=>p.id===prop.id&&p.data?.status==='approved'))throw new Error('PROPOSAL_APPROVAL_READBACK_MISMATCH');
 const policyId=await saveId('policy');let policy=pol0.data.resource;
 const expectedPolicy={contractVersion:1,...policyManifest.policyTemplate};
 if(!policy){policy=(await call(`/api/swarmflare/repos/${repo.owner}/${repo.name}/policy`,{method:'POST',...session(),expected:200,body:{requestId:policyId,expectedVersion:0,contractVersion:1}})).data.policy;}
 if(!policy?.id||policy.version!==1||!equal(policy.data,expectedPolicy))throw new Error('POLICY_READBACK_MISMATCH');
 const baselineId=await saveId('baseline');let initialized=base0.data.resource;
 if(!initialized){const response=(await call(`/api/swarmflare/repos/${repo.owner}/${repo.name}/baseline/initialize`,{method:'POST',...session(),expected:200,body:{requestId:baselineId,expectedVersion:0,payload:{commitOid:repo.source.commitOid,treeOid:repo.source.treeOid}}})).data;initialized=response.baseline;const job=response.job;if(response.status!=='initialized'||job?.data?.status!=='completed'||job.data.input?.kind!=='seed'||job.data.input.source?.commitOid!==repo.source.commitOid||job.data.input.source?.treeOid!==repo.source.treeOid||job.data.receipt?.backend!=='artifacts-git'||job.data.receipt.ref!==initialized?.receipt?.ref||job.data.receipt.commitOid!==repo.source.commitOid||job.data.receipt.treeOid!==repo.source.treeOid)throw new Error('SEED_JOB_READBACK_MISMATCH');}
 if(initialized?.version!==1||initialized.commitOid!==repo.source.commitOid||initialized.treeOid!==repo.source.treeOid||initialized.receipt?.backend!=='artifacts-git'||!/^refs\/agent\/seeds\/[A-Za-z0-9_-]+$/.test(initialized.receipt.ref))throw new Error('BASELINE_READBACK_MISMATCH');
 const [ctx1,base1,pol1,source1]=await Promise.all([call(`${base}/context`,session()),call(`${base}/baseline`,session()),call(`${base}/policy`,session()),call(sourcePath)]);
 if(ctx1.data.resource?.contract?.version!==1||ctx1.data.resource.baseline?.version!==1||!equal(base1.data.resource,initialized)||!equal(pol1.data.resource?.data,policy.data)||source1.data.commitOid!==repo.source.commitOid||source1.data.treeOid!==repo.source.treeOid)throw new Error('FINAL_READBACK_MISMATCH');
 return {projectId:repo.projectId,repository:{owner:repo.owner,name:repo.name,id:repo.id,source:repo.source},proposalId:prop.id,contractVersion:1,policy:{id:policy.id,version:policy.version},baseline:{version:initialized.version,commitOid:initialized.commitOid,treeOid:initialized.treeOid,receiptRef:initialized.receipt.ref},status:'prepared-metadata-only'};
 } finally {
  if(state.cookie){try{await call('/auth/logout',{method:'POST',...session(),body:{}});const loggedOut=await call('/auth/session');if(loggedOut.data.user!==null)throw new Error('LOGOUT_READBACK_MISMATCH');}finally{state.cookie=undefined;state.csrf=undefined;await persistRequestId(state);}}
 }
}
async function main(){
 const privateInfo=await lstat(ORIGINAL), parent=await lstat(dirname(ORIGINAL));if(privateInfo.isSymbolicLink()||!privateInfo.isFile()||(privateInfo.mode&0o777)!==0o600||parent.isSymbolicLink())throw new Error('ORIGINAL_PRIVATE_PERMISSIONS');
 const [raw,receiptRaw]=await Promise.all([readFile(ORIGINAL,'utf8'),readFile(ORIGINAL_RECEIPT,'utf8')]);const original=JSON.parse(raw),receipt=JSON.parse(receiptRaw),repo=validateFixture(original.identity,receipt);
 await mkdir(dirname(PRIVATE),{recursive:true,mode:0o700});const privateDir=await lstat(dirname(PRIVATE));if(privateDir.isSymbolicLink()||!privateDir.isDirectory()||(privateDir.mode&0o777)!==0o700)throw new Error('PRIVATE_DIRECTORY_PERMISSIONS');let state:State;
 try{const st=await lstat(PRIVATE);if(st.isSymbolicLink()||!st.isFile()||(st.mode&0o777)!==0o600)throw new Error('PRIVATE_PERMISSIONS');state=JSON.parse(await readFile(PRIVATE,'utf8'));if(Object.keys(state).some(k=>!['cookie','csrf','requestIds'].includes(k)))throw new Error('PRIVATE_STATE_INVALID');}catch(e:any){if(e?.code!=='ENOENT')throw e;state={requestIds:{}};await writeFile(PRIVATE,JSON.stringify(state),{mode:0o600,flag:'wx'});}
 if(!state.requestIds||typeof state.requestIds!=='object'||Array.isArray(state.requestIds))throw new Error('PRIVATE_STATE_INVALID');Object.assign(state,{username:repo.owner,email:original.identity.email,password:original.identity.password});
 const results:any[]=[];const savePrivate=async()=>{const minimal={...(state.cookie?{cookie:state.cookie}:{}),...(state.csrf?{csrf:state.csrf}:{}),requestIds:state.requestIds};const st=await lstat(PRIVATE);if(st.isSymbolicLink()||!st.isFile()||(st.mode&0o777)!==0o600)throw new Error('PRIVATE_PERMISSIONS');await writeFile(PRIVATE,JSON.stringify(minimal),{mode:0o600});await chmod(PRIVATE,0o600);};
 const record=async(x:any)=>{results.push(x);await writeFile(RECEIPT,JSON.stringify({origin:ORIGIN,provenance:'native',results,repository:{owner:repo.owner,name:repo.name,id:repo.id,source:repo.source}},null,2)+'\n',{mode:0o600});};
 const result=await executeFoundation(state,repo,fetch,record,savePrivate);
 if(await readFile(ORIGINAL,'utf8')!==raw)throw new Error('ORIGINAL_PRIVATE_STATE_CHANGED');
 await writeFile(RECEIPT,JSON.stringify({origin:ORIGIN,provenance:'native',results,...result,originalPrivateStateUnchanged:true},null,2)+'\n',{mode:0o600});await savePrivate();
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{const s=(e as any)?.safe;process.stderr.write(JSON.stringify(s??{code:typeof (e as any)?.message==='string'&&/^[A-Z_]+$/.test((e as any).message)?(e as any).message:'FAILED'})+'\n');process.exitCode=1;});
