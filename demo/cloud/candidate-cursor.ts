import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkspaceClient } from '../../packages/client/index.js';
import { runSourceJob } from '../../packages/local-runner/index.js';
import { verifyViewSource, runViewMandatoryDemoSuite } from '../../packages/local-runner/checks.js';
import { buildReviewArtifact } from '../../packages/local-runner/review-artifact.js';
import { readSourceReceipt } from '../../packages/git-runner/index.js';
import { ORIGIN, validateFixture } from './foundation-smoke.js';
import { PROJECT_ID } from './native-checkout.js';
import { demoPolicyManifest } from '../../apps/worker/src/generated/demo-policy.js';
import type { FindingResource } from '../../packages/contracts/feedback.js';

const ROOT=resolve('.local/cloud-cont49'),CACHE=resolve('.local/cloud-cont47/cache.git'),FILE=resolve(ROOT,'candidate-private.json');
const REPORT='reports/evaluation/continuous49-native-cursor.json';
async function secret(p:string){const s=await lstat(p);if(s.isSymbolicLink()||!s.isFile()||(s.mode&0o077)!==0)throw Error('PRIVATE_PERMISSIONS');return JSON.parse(await readFile(p,'utf8'));}
const canonical=(x:any):any=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const equal=(a:unknown,b:unknown)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));

// Read current resource before reserving a new version-bound repair intent.
export async function linkRepairOnce(client:Pick<WorkspaceClient,'finding'|'proposeRepair'>,findingId:string,ref:{changeId:string;revisionId:string},key:(name:string)=>Promise<string>):Promise<FindingResource>{
 const finding=await client.finding(findingId);
 if(finding.data.status==='resolved'||finding.data.repairs.some(r=>r.changeId===ref.changeId&&r.revisionId===ref.revisionId))return finding;
 const linked=await client.proposeRepair(findingId,{requestId:await key('repair-'+findingId+'-v'+finding.version),expectedVersion:finding.version,payload:{revisions:[ref]}});
 const actual=await client.finding(findingId);if(!equal(actual,linked)||!actual.data.repairs.some(r=>r.changeId===ref.changeId&&r.revisionId===ref.revisionId))throw Error('REPAIR_READBACK');return actual;
}
export async function qualifyCursorCandidate(){
 const fixturePath='.local/cloud-cont40/platform-smoke-private.json',fixtureBytes=await readFile(fixturePath),fixture=await secret(fixturePath),repo=validateFixture(fixture.identity,JSON.parse(await readFile('reports/evaluation/continuous40-platform-smoke.json','utf8')));
 const initial=await secret('.local/cloud-cont47/candidate-private.json'),cursor=await secret('.local/cloud-cont47/cursor-private.json'),service=await secret('.local/cloud-cont44/runner-private.json');
 if(repo.projectId!==PROJECT_ID||initial.projectId!==PROJECT_ID||!initial.grant||initial.grant.expiresAt<=Date.now()||!cursor.revisionId||!cursor.viewId||!cursor.source||!cursor.findingIds?.length)throw Error('SCOPE_INVALID');
 await mkdir(ROOT,{recursive:true,mode:0o700});const dir=await lstat(ROOT);if(dir.isSymbolicLink()||!dir.isDirectory()||(dir.mode&0o077)!==0)throw Error('PRIVATE_PERMISSIONS');
 let state:any;try{state=await secret(FILE);}catch(e:any){if(e.code!=='ENOENT')throw e;state={ids:{},projectId:PROJECT_ID};await writeFile(FILE,JSON.stringify(state),{mode:0o600,flag:'wx'});}if(state.projectId!==PROJECT_ID)throw Error('STATE_SCOPE');
 const save=async()=>writeFile(FILE,JSON.stringify(state),{mode:0o600});const key=async(n:string)=>{state.ids[n]??=randomUUID();await save();return state.ids[n];};
 let count=0;const deadline=Date.now()+150000,calls:any[]=[];
 const fetcher:typeof fetch=async(u,options)=>{const url=new URL(String(u));if(url.origin!==ORIGIN||++count>60||Date.now()>deadline)throw Error('SCOPE_BUDGET');const r=await fetch(u,{...options,redirect:'error',signal:AbortSignal.timeout(20000)});calls.push({path:url.pathname,method:options?.method??'GET',status:r.status});await writeFile('reports/evaluation/continuous49-candidate-progress.json',JSON.stringify({calls},null,2));return r;};
 const call=async(path:string,options?:RequestInit)=>{const r=await fetcher(ORIGIN+path,options);if(!r.ok)throw Object.assign(Error('HTTP_REFUSED'),{status:r.status});return await r.json() as any;};
 const client=(token:string)=>new WorkspaceClient({baseUrl:ORIGIN,projectId:PROJECT_ID,token,fetch:fetcher,maxRequests:60,deadline:150000});const contributor=client(initial.grant.token);
 const catalog=(await call('/api/platform/repos/'+repo.owner+'/'+repo.name)).repository;if(catalog?.id!==repo.id||catalog.status!=='ready'||!equal(catalog.source,repo.source))throw Error('CATALOG_CHANGED');
 const baseline=await contributor.baseline(),policy=await contributor.policy(),context=await contributor.context(),revision=await contributor.revision(cursor.revisionId),old=await contributor.view(cursor.viewId);
 if(!baseline||baseline.version!==1||baseline.commitOid!==repo.source.commitOid||baseline.treeOid!==repo.source.treeOid||!policy||!equal(policy.data,{contractVersion:1,...demoPolicyManifest.policyTemplate})||context.contract?.version!==1||!equal(context.contract.data,demoPolicyManifest.contract)||revision.data.status!=='published'||revision.data.owner!==initial.grant.id||revision.data.changeId!==initial.changeId||revision.data.receipt?.commitOid!==cursor.source.commitOid||revision.data.receipt?.treeOid!==cursor.source.treeOid||old.data.receipt?.treeOid!==cursor.source.treeOid)throw Error('SOURCE_POLICY_CHANGED');
 state.policyVersion=policy.version;state.revisionId=revision.id;await save();
 for(const findingId of cursor.findingIds)await linkRepairOnce(contributor,findingId,{changeId:initial.changeId,revisionId:revision.id},key);
 const view=state.viewId?await contributor.view(state.viewId):await contributor.createView({requestId:await key('view'),payload:{...old.data.manifest,policyVersion:policy.version}});state.viewId=view.id;await save();
 if(view.data.manifest.policyVersion!==policy.version||!equal(view.data.manifest.orderedRevisions,[{changeId:initial.changeId,revisionId:revision.id}]))throw Error('VIEW_CHANGED');
 const issued=await call('/api/platform/runner/sessions',{method:'POST',headers:{authorization:'Bearer '+service.key,'content-type':'application/json'},body:JSON.stringify({projectId:PROJECT_ID,expiresInSeconds:120,maxOperations:60})});if(!/^sfr_[a-f0-9]{64}$/.test(issued.token))throw Error('RUNNER_INVALID');const runner=client(issued.token);
 if(view.data.status!=='runnable'){const job=await runSourceJob(runner,{remote:CACHE,workspaceRoot:ROOT,resolveRepository:()=>CACHE,requestId:await key('compose'),sourceBackend:'artifacts-git'});if(job?.data.status!=='completed'||job.data.input.kind!=='composition'||job.data.input.viewId!==view.id)throw Error('COMPOSITION_FAILED');}
 const actual=await contributor.view(view.id);if(actual.data.receipt?.backend!=='artifacts-git'||actual.data.receipt.treeOid!==cursor.source.treeOid)throw Error('SOURCE_READBACK');
 const native=await readSourceReceipt(CACHE,actual.data.receipt.ref);if(native.commitOid!==actual.data.receipt.commitOid||native.treeOid!==actual.data.receipt.treeOid)throw Error('CACHE_MISMATCH');
 await verifyViewSource(runner,{remote:CACHE,viewId:view.id,requestId:'cursor-verify-'+randomUUID()});
 let checks=await runner.checks(view.id);if(checks.some(c=>c.data.result==='failed'))throw Error('CHECKS_FAILED');
 if(!['mandatory-demo-api','mandatory-demo-ui'].every(id=>checks.some(c=>c.data.checkId===id&&c.data.result==='passed')))checks=await runViewMandatoryDemoSuite(runner,{remote:CACHE,workspaceRoot:ROOT,viewId:view.id,projectId:PROJECT_ID,requestId:await key('checks')});
 state.view=actual.data.receipt;state.checks=checks.map(c=>({checkId:c.data.checkId,result:c.data.result,id:c.id}));state.findingIds=cursor.findingIds;await save();
 if(state.checks.some((c:any)=>c.result!=='passed'))throw Error('CHECKS_FAILED');const artifact=await buildReviewArtifact(runner,{remote:CACHE,workspaceRoot:ROOT,viewId:view.id});state.artifactId=artifact.id;await save();
 if(!equal(await contributor.baseline(),baseline)||!equal(await contributor.view(old.id),old)||!equal((await call('/api/platform/repos/'+repo.owner+'/'+repo.name)).repository.source,repo.source)||!(await readFile(fixturePath)).equals(fixtureBytes))throw Error('PRESERVATION_FAILED');
 const result={provenance:'Actual native new-policy View of exact signed-cursor revision, actual mandatory suites and bounded one-handler recorded-response preview; independent review/resolution and human acceptance are separate.',projectId:PROJECT_ID,viewId:actual.id,revisionId:revision.id,policyVersion:policy.version,source:cursor.source,view:state.view,checks:state.checks,artifactId:state.artifactId,findingIds:state.findingIds,calls,baselineUnchanged:true,originalCursorViewUnchanged:true,sourceUnchanged:true,acceptancePerformed:false};await writeFile(REPORT,JSON.stringify(result,null,2));return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))qualifyCursorCandidate().then(x=>console.log(JSON.stringify(x))).catch(e=>{console.error(JSON.stringify({code:/^[A-Z_]{1,64}$/.test(e.message)?e.message:'CURSOR_FAILED',status:e.status??e.statusCode,apiCode:typeof e.code==='string'&&/^[A-Z_]{1,64}$/.test(e.code)?e.code:undefined}));process.exitCode=1;});
