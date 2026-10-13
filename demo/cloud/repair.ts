import { readFile, writeFile, mkdir, lstat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkspaceClient } from '../../packages/client/index.js';
import { runSourceJob } from '../../packages/local-runner/index.js';
import { verifyViewSource, runViewMandatoryDemoSuite } from '../../packages/local-runner/checks.js';
import { buildReviewArtifact } from '../../packages/local-runner/review-artifact.js';
import { readSourceReceipt } from '../../packages/git-runner/index.js';
import { parseConfig, validateReceiptPair } from './smoke.js';
import { randomUUID } from 'node:crypto';

type SmokeConfig=ReturnType<typeof parseConfig>;
type Phase='drain'|'compose'|'checks'|'refresh';
export type RepairConfig=SmokeConfig & {repairRepository:string;findingId:string;originalViewId:string;repairChangeId:string;repairRevisionId:string};
type Receipt={backend:string;ref:string;commitOid:string;treeOid:string};
type RepairState={projectId:string;baseline?:{version:number;commitOid:string;treeOid:string;ref:string};replacementViewId?:string;receipt?:Receipt;localCacheReceipt?:Receipt;sourceVerificationId?:string;checks?:Array<{checkId:string;result:string}>;reviewArtifactId?:string};
const phases:Phase[]=['drain','compose','checks','refresh'];
let secrets:string[]=[];
const id=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,120}$/.test(v);
export function isRecoveryClaimable(job:{data:{status:string;leaseExpiresAt:number|null}}){return job.data.status==='queued'||(job.data.status==='leased'&&job.data.leaseExpiresAt!==null&&job.data.leaseExpiresAt<=Date.now());}
function recoveryRequestId(phase:'drain'|'compose'){return `cloud-repair-${phase}-${Date.now()}-${randomUUID()}`;}
function localPath(v:unknown,k:string){if(typeof v!=='string'||!v||/^(?:[a-z][a-z0-9+.-]*:|\\\\)/i.test(v))throw Error(`${k} must be a local path`);return resolve(v);}
export function parseRepairConfig(raw:string):RepairConfig {
 let value:unknown;try{value=JSON.parse(raw)}catch{throw Error('config must be JSON')}
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('config must be an object');const x=value as Record<string,unknown>;
 const extra=['repairRepository','findingId','originalViewId','repairChangeId','repairRevisionId'];
 const smokeKeys=['baseUrl','projectId','runnerToken','contributorToken','seedRepository','revisionRepository','remote','workspaceRoot','receiptPath','approvedOrigin'];
 if(Object.keys(x).sort().join(',')!==[...smokeKeys,...extra].sort().join(','))throw Error('config must contain exactly the documented fields');
 const base={...x};for(const k of extra)delete base[k];const smoke=parseConfig(JSON.stringify(base));
 for(const k of ['findingId','originalViewId','repairChangeId','repairRevisionId'])if(!id(x[k]))throw Error(`${k} is invalid`);
 const repairRepository=localPath(x.repairRepository,'repairRepository');
 // The configured repair receipt is independent of the original smoke receipt path.
 const receiptPath=localPath(x.receiptPath,'receiptPath');
 return {...smoke,receiptPath,repairRepository,findingId:x.findingId as string,originalViewId:x.originalViewId as string,repairChangeId:x.repairChangeId as string,repairRevisionId:x.repairRevisionId as string};
}
function client(c:RepairConfig,token:string){return new WorkspaceClient({baseUrl:c.baseUrl,projectId:c.projectId,token,maxRequests:100,deadline:60_000});}
async function state(path:string,projectId:string):Promise<RepairState>{try{const s=JSON.parse(await readFile(path,'utf8')) as RepairState;if(s.projectId!==projectId)throw Error('repair receipt projectId mismatch');return s;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return {projectId};throw e;}}
async function save(path:string,s:RepairState){await mkdir(dirname(path),{recursive:true});await writeFile(path,JSON.stringify(s,null,2)+'\n',{mode:0o600});}
async function drain(c:RepairConfig,s:RepairState){
 const contributor=client(c,c.contributorToken),runner=client(c,c.runnerToken);
 const finding=await contributor.finding(c.findingId);if(!['open','repair-proposed'].includes(finding.data.status))throw Error('finding is not repairable');
 const rev=await contributor.revision(c.repairRevisionId);if(rev.data.changeId!==c.repairChangeId||rev.data.status==='failed')throw Error('repair revision is failed or belongs to a different change');
 let job=await runner.sourceJob(rev.data.jobId);
 if(job.data.status!=='completed'){
  if(rev.data.status!=='reserved'||!isRecoveryClaimable(job)||job.data.input.kind!=='publication'||job.data.input.revision.revisionId!==c.repairRevisionId||job.data.input.revision.changeId!==c.repairChangeId)throw Error('repair publication job is not queued or expired-leased for the exact reserved revision');
  await runSourceJob(runner,{remote:c.remote,workspaceRoot:c.workspaceRoot,requestId:recoveryRequestId('drain'),sourceBackend:'artifacts-git',resolveRepository:()=>c.repairRepository});
  job=await runner.sourceJob(rev.data.jobId);
 }
 if(!job||job.data.status!=='completed'||job.data.input.kind!=='publication'||job.data.input.revision.revisionId!==c.repairRevisionId||job.data.input.revision.changeId!==c.repairChangeId||job.data.receipt?.backend!=='artifacts-git'||job.data.receipt.ref!==`refs/agent/revisions/${c.repairChangeId}/${c.repairRevisionId}`||job.data.receipt.commitOid!==rev.data.commitOid||job.data.receipt.treeOid!==rev.data.treeOid)throw Error('repair publication job readback does not match the exact revision');
 const readback=await contributor.revision(c.repairRevisionId);if(readback.data.status!=='published'||readback.data.receipt?.ref!==job.data.receipt.ref||readback.data.receipt.commitOid!==job.data.receipt.commitOid||readback.data.receipt.treeOid!==job.data.receipt.treeOid)throw Error('repair revision publication readback mismatch');
 const local=await readSourceReceipt(c.remote,job.data.receipt.ref);validateReceiptPair(job.data.receipt,local);
 const current=await contributor.finding(c.findingId);
 if(current.data.status==='open')await contributor.proposeRepair(c.findingId,{requestId:'cloud-repair-propose',expectedVersion:current.version,payload:{revisions:[{changeId:c.repairChangeId,revisionId:c.repairRevisionId}]}});
 else if(!current.data.repairs.some(r=>r.changeId===c.repairChangeId&&r.revisionId===c.repairRevisionId))throw Error('existing repair proposal differs from configured exact revision');
 const proposed=await contributor.finding(c.findingId);if(proposed.data.status!=='repair-proposed'||!proposed.data.repairs.some(r=>r.changeId===c.repairChangeId&&r.revisionId===c.repairRevisionId))throw Error('repair proposal readback mismatch');
 s.receipt=job.data.receipt;s.localCacheReceipt=local;await save(c.receiptPath,s);console.log(JSON.stringify({phase:'drain',findingId:c.findingId,revisionId:c.repairRevisionId,remoteSourceReceipt:s.receipt,localCacheReceipt:local,repairProposed:true}));
}
async function compose(c:RepairConfig,s:RepairState){
 const api=client(c,c.contributorToken);const original=await api.view(c.originalViewId);const manifest=original.data.manifest;
 const base=await api.baseline();if(!base||base.version!==manifest.baseVersion||base.commitOid!==manifest.baseCommitOid)throw Error('current baseline differs from original View baseline; refusing replacement');
 const repair=await api.revision(c.repairRevisionId);if(repair.data.changeId!==c.repairChangeId||repair.data.status!=='published')throw Error('configured repair revision is not published');
 if(manifest.excludedChangeIds.includes(c.repairChangeId))throw Error('original View manifest excludes the configured repair change');
 const prior=manifest.orderedRevisions.filter(r=>r.changeId!==c.repairChangeId);const orderedRevisions=[...prior,{changeId:c.repairChangeId,revisionId:c.repairRevisionId}];
 const currentFinding=await api.finding(c.findingId);if(!currentFinding.data.repairs.some(r=>r.changeId===c.repairChangeId&&r.revisionId===c.repairRevisionId))throw Error('finding does not contain this exact repair proposal');
 const created=await api.createView({requestId:'cloud-repair-view',expectedVersion:0,payload:{...manifest,orderedRevisions}});
 let job=await client(c,c.runnerToken).sourceJob(created.data.jobId);
 if(job.data.status!=='completed'){
  const exactInput=job.data.input.kind==='composition'&&job.data.input.viewId===created.id&&JSON.stringify(created.data.manifest)===JSON.stringify({...manifest,orderedRevisions})&&JSON.stringify(job.data.input.manifest)===JSON.stringify(created.data.manifest)&&JSON.stringify(job.data.input.revisions.map(({changeId,revisionId})=>({changeId,revisionId})))===JSON.stringify(orderedRevisions);
  if(!isRecoveryClaimable(job)||!exactInput)throw Error('replacement composition job is not queued or expired-leased for the exact View manifest/revisions');
  await runSourceJob(client(c,c.runnerToken),{remote:c.remote,workspaceRoot:c.workspaceRoot,requestId:recoveryRequestId('compose'),sourceBackend:'artifacts-git',resolveRepository:()=>c.remote});
  job=await client(c,c.runnerToken).sourceJob(created.data.jobId);
 }
 if(job.data.status!=='completed'||job.data.input.kind!=='composition'||job.data.input.viewId!==created.id)throw Error('replacement composition job did not complete for the exact View');
 const replacement=await api.view(created.id);if(replacement.data.status!=='runnable'||replacement.data.receipt?.backend!=='artifacts-git'||replacement.data.receipt.commitOid!==job.data.receipt?.commitOid||replacement.data.receipt.treeOid!==job.data.receipt?.treeOid)throw Error('replacement View readback does not match composed source');
 const local=await readSourceReceipt(c.remote,replacement.data.receipt.ref);validateReceiptPair(replacement.data.receipt,local);
 const after=await api.baseline();if(!after||after.version!==base.version||after.commitOid!==base.commitOid||after.treeOid!==base.treeOid||after.receipt.ref!==base.receipt.ref)throw Error('baseline changed during repair composition');
 s.baseline={version:base.version,commitOid:base.commitOid,treeOid:base.treeOid,ref:base.receipt.ref};s.replacementViewId=created.id;s.receipt=replacement.data.receipt;s.localCacheReceipt=local;await save(c.receiptPath,s);console.log(JSON.stringify({phase:'compose',originalViewId:c.originalViewId,replacementViewId:created.id,remoteSourceReceipt:s.receipt,localCacheReceipt:local,baselineUnchanged:true}));
}
async function checks(c:RepairConfig,s:RepairState){if(!s.replacementViewId||!s.baseline)throw Error('checks phase requires compose phase');const runner=client(c,c.runnerToken);
 const requestId=()=>`cloud-repair-checks-${Date.now()}-${randomUUID()}`;
 const source=await verifyViewSource(runner,{remote:c.remote,viewId:s.replacementViewId,requestId:requestId()});
 if(!source.data.receipt||source.data.receipt.ref!==s.receipt?.ref||source.data.receipt.commitOid!==s.receipt.commitOid||source.data.receipt.treeOid!==s.receipt.treeOid)throw Error('replacement source verification is not exact');
 const result=await runViewMandatoryDemoSuite(runner,{remote:c.remote,workspaceRoot:c.workspaceRoot,viewId:s.replacementViewId,projectId:c.projectId,requestId:requestId()});if(result.some(x=>x.data.result!=='passed'))throw Error('mandatory demo check failure');
 const artifact=await buildReviewArtifact(runner,{remote:c.remote,workspaceRoot:c.workspaceRoot,viewId:s.replacementViewId});
 if(artifact.data.applicability.projectId!==c.projectId||artifact.data.applicability.viewId!==s.replacementViewId||artifact.data.applicability.composedCommitOid!==s.receipt.commitOid||artifact.data.applicability.treeOid!==s.receipt.treeOid)throw Error('review artifact applicability does not match the exact replacement source');
 const baseline=await runner.baseline();if(!baseline||baseline.version!==s.baseline.version||baseline.commitOid!==s.baseline.commitOid||baseline.treeOid!==s.baseline.treeOid||baseline.receipt.ref!==s.baseline.ref)throw Error('baseline changed during repair checks');
 s.sourceVerificationId=source.id;s.checks=result.map(x=>({checkId:x.data.checkId,result:x.data.result}));s.reviewArtifactId=artifact.id;await save(c.receiptPath,s);
 const metadata={phase:'checks',viewId:s.replacementViewId,replacementViewId:s.replacementViewId,commitOid:s.receipt.commitOid,treeOid:s.receipt.treeOid,sourceVerificationId:source.id,checks:result.map(x=>({id:x.id,checkId:x.data.checkId,result:x.data.result})),reviewArtifactId:artifact.id,previewExpiresAt:typeof artifact.data.preview?.expiresAt==='number'?artifact.data.preview.expiresAt:null,evidencePrepared:true,acceptancePerformed:false,baselineUnchanged:true};
 console.log(JSON.stringify(metadata));return metadata;
}
async function refresh(c:RepairConfig,s:RepairState){
 if(!s.replacementViewId||!s.baseline||!s.receipt)throw Error('refresh phase requires compose phase');
 const runner=client(c,c.runnerToken), view=await runner.view(s.replacementViewId);
 if(view.data.status!=='runnable'||!view.data.receipt||view.data.manifest.baseVersion!==s.baseline.version||view.data.manifest.baseCommitOid!==s.baseline.commitOid)throw Error('candidate source/baseline no longer matches composed state');
 const exact={projectId:c.projectId,viewId:view.id,manifestDigest:view.data.manifestDigest,composedCommitOid:view.data.receipt.commitOid,treeOid:view.data.receipt.treeOid,contractVersion:view.data.manifest.contractVersion,policyVersion:view.data.manifest.policyVersion};
 if(view.data.receipt.ref!==s.receipt.ref||view.data.receipt.commitOid!==s.receipt.commitOid||view.data.receipt.treeOid!==s.receipt.treeOid)throw Error('candidate source changed since compose');
 const before=await runner.baseline();if(!before||before.version!==s.baseline.version||before.commitOid!==s.baseline.commitOid||before.treeOid!==s.baseline.treeOid||before.receipt.ref!==s.baseline.ref)throw Error('baseline changed since compose');
 const policy=await runner.policy();if(!policy||policy.data.contractVersion!==exact.contractVersion)throw Error('current policy does not match candidate contract');
 const source=await verifyViewSource(runner,{remote:c.remote,viewId:view.id,requestId:`cloud-repair-refresh-${Date.now()}-${randomUUID()}`});
 if(!source.data.receipt||source.data.receipt.ref!==s.receipt.ref||source.data.receipt.commitOid!==s.receipt.commitOid||source.data.receipt.treeOid!==s.receipt.treeOid)throw Error('fresh source verification mismatch');
 const artifact=await buildReviewArtifact(runner,{remote:c.remote,workspaceRoot:c.workspaceRoot,viewId:view.id});
 const art=artifact.data.applicability;
 if(art.projectId!==exact.projectId||art.viewId!==exact.viewId||art.manifestDigest!==exact.manifestDigest||art.composedCommitOid!==exact.composedCommitOid||art.treeOid!==exact.treeOid||art.contractVersion!==exact.contractVersion||art.policyVersion!==exact.policyVersion)throw Error('review artifact applicability does not match exact candidate');
 const [recordedChecks,readiness]=await Promise.all([runner.checks(view.id),runner.readiness(view.id)]);
 const applicability=readiness.applicability;
 if(!applicability||Object.entries(exact).some(([k,v])=>applicability[k as keyof typeof applicability]!==v)||applicability.checkSuiteDigest!==policy?.data.checkSuiteDigest||art.checkSuiteDigest!==applicability.checkSuiteDigest)throw Error('current readiness/policy/artifact applicability mismatch');
 const checkIds=new Set(policy.data.checks.map(x=>x.id));
 const relevant=recordedChecks.filter(x=>checkIds.has(x.data.checkId));
 const tuple=(x:{data:{applicability:{projectId:string;viewId:string;manifestDigest:string;composedCommitOid:string;treeOid:string;contractVersion:number;policyVersion:number;checkSuiteDigest:string}}})=>Object.entries({...exact,checkSuiteDigest:applicability.checkSuiteDigest}).every(([k,v])=>x.data.applicability[k as keyof typeof x.data.applicability]===v);
 const historical=policy.data.checks.map(required=>{const matches=relevant.filter(x=>x.data.checkId===required.id&&tuple(x));return {checkId:required.id,result:matches.length?matches[0]!.data.result:'missing',status:'historically-recorded',applicable:matches.length>0,resourceId:matches[0]?.id??null};});
 const after=await runner.baseline();if(!after||after.version!==before.version||after.commitOid!==before.commitOid||after.treeOid!==before.treeOid||after.receipt.ref!==before.receipt.ref)throw Error('baseline changed during refresh');
 s.sourceVerificationId=source.id;s.reviewArtifactId=artifact.id;await save(c.receiptPath,s);
 const metadata={phase:'refresh',viewId:view.id,replacementViewId:view.id,commitOid:exact.composedCommitOid,treeOid:exact.treeOid,sourceVerificationId:source.id,sourceVerificationVersion:source.version,sourceVerifiedAt:source.data.verifiedAt,checks:historical,reviewArtifactId:artifact.id,reviewArtifactVersion:artifact.version,previewExpiresAt:typeof artifact.data.preview?.expiresAt==='number'?artifact.data.preview.expiresAt:null,readiness:{ready:readiness.ready,blockers:readiness.blockers},evidencePrepared:true,acceptancePerformed:false,baselineUnchanged:true};console.log(JSON.stringify(metadata));return metadata;
}
export async function runPhase(phase:Phase,c:RepairConfig){if(!phases.includes(phase))throw Error('phase must be drain|compose|checks|refresh');const s=await state(c.receiptPath,c.projectId);if(phase==='drain')await drain(c,s);else if(phase==='compose')await compose(c,s);else if(phase==='refresh')return refresh(c,s);else return checks(c,s);}
async function main(){const [phase,extra]=process.argv.slice(2);if(!phases.includes(phase as Phase)||extra)throw Error('usage: CLOUD_REPAIR_CONFIG_FILE=/private/path/config.json /home/noir/.local/state/nix/profile/bin/node --import tsx demo/cloud/repair.ts <drain|compose|checks|refresh>');const path=process.env.CLOUD_REPAIR_CONFIG_FILE;if(!path)throw Error('CLOUD_REPAIR_CONFIG_FILE is required');const st=await lstat(path);if(!st.isFile()||(st.mode&0o077)!==0)throw Error('config file must be a regular file accessible only to its owner');const c=parseRepairConfig(await readFile(path,'utf8'));secrets=[c.runnerToken,c.contributorToken];await runPhase(phase as Phase,c);}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{let message=e instanceof Error?e.message:'repair failed';for(const secret of secrets)message=message.replaceAll(secret,'[REDACTED]');process.stderr.write(`${JSON.stringify({error:message})}\n`);process.exitCode=1;});
