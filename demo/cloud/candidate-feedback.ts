import { randomUUID } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkspaceClient } from '../../packages/client/index.js';
import { ORIGIN, validateFixture } from './foundation-smoke.js';
import { demoPolicyManifest } from '../../apps/worker/src/generated/demo-policy.js';
const ROOT=resolve('.local/cloud-cont47'), PRIVATE=resolve(ROOT,'feedback-private.json');
const PROJECT='fc34f086-87da-4067-a648-484af2297bd7';
async function secret(path:string){const s=await lstat(path);if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o077)!==0)throw Error('PRIVATE_PERMISSIONS');return JSON.parse(await readFile(path,'utf8'));}
export async function failedReview(){
 const original=await secret('.local/cloud-cont40/platform-smoke-private.json'),safe=JSON.parse(await readFile('reports/evaluation/continuous40-platform-smoke.json','utf8')),repo=validateFixture(original.identity,safe),candidate=await secret(resolve(ROOT,'candidate-private.json'));
 if(repo.projectId!==PROJECT||candidate.projectId!==PROJECT||!candidate.viewId||!candidate.changeId)throw Error('SCOPE_INVALID');
 const review=JSON.parse(await readFile('reports/workers/continuous47-independent-review-result.json','utf8'));
 if(review.viewId!==candidate.viewId||review.commitOid!==candidate.view?.commitOid||review.treeOid!==candidate.view?.treeOid||review.verdict!=='failed')throw Error('REVIEW_SOURCE_INVALID');
 let state:any;try{state=await secret(PRIVATE);}catch(e:any){if(e.code!=='ENOENT')throw e;state={ids:{},findingIds:[]};await writeFile(PRIVATE,JSON.stringify(state),{mode:0o600,flag:'wx'});}
 const save=async()=>writeFile(PRIVATE,JSON.stringify(state),{mode:0o600});const key=async(n:string)=>{state.ids[n]??=randomUUID();await save();return state.ids[n];};
 let calls=0;const fetcher:typeof fetch=async(input,init)=>{if(++calls>30||new URL(String(input)).origin!==ORIGIN)throw Error('SCOPE_BUDGET');return fetch(input,{...init,redirect:'error',signal:AbortSignal.timeout(20000)});};
 const post=async(path:string,body:any,headers:any={},expected=200)=>{const r=await fetcher(ORIGIN+path,{method:'POST',headers:{origin:ORIGIN,'content-type':'application/json',...headers},body:JSON.stringify(body)});if(r.status!==expected)throw Object.assign(Error('HTTP_REFUSED'),{safe:{path,status:r.status}});return{data:await r.json() as any,response:r};};
 const actor=new WorkspaceClient({baseUrl:ORIGIN,projectId:PROJECT,token:candidate.grant.token,fetch:fetcher,maxRequests:30,deadline:60000});
 const view=await actor.view(candidate.viewId),change=await actor.change(candidate.changeId),baseline=await actor.baseline();if(!view.data.receipt||view.data.receipt.commitOid!==review.commitOid||view.data.receipt.treeOid!==review.treeOid)throw Error('VIEW_CHANGED');
 const anchor={viewId:view.id,manifestDigest:view.data.manifestDigest!,composedCommitOid:view.data.receipt.commitOid,treeOid:view.data.receipt.treeOid,contractVersion:1,policyVersion:1};
 let cookie='',csrf='';try{
 const login=await post('/api/platform/auth/login',{login:original.identity.email,password:original.identity.password});cookie=login.response.headers.get('set-cookie')?.split(';')[0]??'';csrf=login.data.csrf;if(!cookie||!csrf||login.data.user?.username!==repo.owner)throw Error('LOGIN_SCOPE');const headers={cookie,'x-csrf-token':csrf};
 if(!state.reviewer){const grant=(await post('/api/platform/repos/'+repo.owner+'/'+repo.name+'/agents',{role:'reviewer',expiresInSeconds:900},headers,201)).data;state.reviewer={token:grant.token,id:grant.grant.id,expiresAt:grant.grant.expiresAt};await save();}
 for(let i=0;i<review.findings.length;i++){if(state.findingIds[i])continue;const f=review.findings[i];const finding=(await post('/api/v1/projects/'+PROJECT+'/findings',{requestId:await key('finding-'+i),payload:{...anchor,obligationIds:f.obligationIds,affectedChangeIds:[change.id],paths:['demo/seed/index.ts'],expected:f.expected,observed:f.observed,nextOwner:change.owner}},headers,201)).data.resource;state.findingIds[i]=finding.id;await save();}
 }finally{if(cookie)await post('/api/platform/auth/logout',{}, {cookie,'x-csrf-token':csrf});}
 const reviewer=new WorkspaceClient({baseUrl:ORIGIN,projectId:PROJECT,token:state.reviewer.token,fetch:fetcher,maxRequests:30,deadline:60000});
 const recorded=await reviewer.reviewView(view.id,{requestId:await key('failed-review'),payload:{...anchor,checkSuiteDigest:demoPolicyManifest.policyTemplate.checkSuiteDigest,obligationIds:demoPolicyManifest.contract.obligations.map(o=>o.id),verdict:'failed',summary:'Actual independent Luna source review: '+review.summary,findings:state.findingIds}});
 const findings=await Promise.all(state.findingIds.map((id:string)=>reviewer.finding(id)));const ready=await reviewer.readiness(view.id);if(ready.ready||JSON.stringify(await reviewer.baseline())!==JSON.stringify(baseline))throw Error('READBACK_FAILED');
 await writeFile('reports/evaluation/continuous47-native-review.json',JSON.stringify({provenance:'Actual Luna independent exact-source review recorded through a separate native repository reviewer grant; actual findings and readbacks. No human acceptance.',viewId:view.id,reviewId:recorded.id,findingIds:state.findingIds,findings,readiness:ready,baselineUnchanged:true},null,2));return{viewId:view.id,reviewId:recorded.id,findingIds:state.findingIds,ready:ready.ready};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))failedReview().then(x=>console.log(JSON.stringify(x))).catch(e=>{console.error(JSON.stringify(e.safe??{code:/^[A-Z_]{1,64}$/.test(e.message)?e.message:'FAILED'}));process.exitCode=1;});
