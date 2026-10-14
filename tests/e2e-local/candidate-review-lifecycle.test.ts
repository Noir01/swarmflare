import { expect,it } from 'vitest';
import { WorkspaceClient } from '../../packages/client/index.js';
import { demoPolicyManifest } from '../../apps/worker/src/generated/demo-policy.js';
import { recordIndependentReview } from '../../demo/cloud/candidate-review.js';
// Synthetic API ports: no private cache, token, or native evidence is used.
const candidate={projectId:'project_1',viewId:'view_1',policyVersion:2,view:{commitOid:'a'.repeat(40),treeOid:'b'.repeat(40),ref:'refs/agent/views/view_1'},findingIds:['finding_1']};
const review={viewId:candidate.viewId,commitOid:candidate.view.commitOid,treeOid:candidate.view.treeOid,policyVersion:2,verdict:'passed',findings:[],checkedObligations:demoPolicyManifest.contract.obligations.map(x=>x.id),summary:'Mock exact-source review'};
function lifecycle(resumed=false){
 const clone=<T>(x:T):T=>JSON.parse(JSON.stringify(x));
 const baseline={version:1,commitOid:'d'.repeat(40),treeOid:'e'.repeat(40),receipt:{backend:'artifacts-git',ref:'refs/agent/seeds/base',commitOid:'d'.repeat(40),treeOid:'e'.repeat(40)}};
 const manifest={baseVersion:1,baseCommitOid:baseline.commitOid,contractVersion:1,policyVersion:2,orderedRevisions:[{changeId:'change_1',revisionId:'revision_1'}],excludedChangeIds:[],decisionRevisions:[],compositionVersion:1};
 const view={id:candidate.viewId,version:2,owner:'contributor_1',data:{manifest,manifestDigest:'f'.repeat(64),status:'runnable',receipt:{backend:'artifacts-git',...candidate.view},jobId:'job_1',error:null}};
 const original=clone(view);original.id='old_view';original.data.manifest.policyVersion=1;original.data.manifestDigest='7'.repeat(64);original.data.receipt={backend:'artifacts-git',ref:'refs/agent/views/old_view',commitOid:'c'.repeat(40),treeOid:'9'.repeat(40)};
 const policy:any={id:'policy',version:2,owner:'owner',data:{contractVersion:1,...clone(demoPolicyManifest.policyTemplate)}};
 const app={projectId:candidate.projectId,viewId:view.id,manifestDigest:view.data.manifestDigest,composedCommitOid:candidate.view.commitOid,treeOid:candidate.view.treeOid,contractVersion:1,policyVersion:2,checkSuiteDigest:policy.data.checkSuiteDigest};
 const expected={viewId:view.id,manifestDigest:app.manifestDigest,composedCommitOid:app.composedCommitOid,treeOid:app.treeOid,contractVersion:1,policyVersion:2,checkSuiteDigest:app.checkSuiteDigest,obligationIds:review.checkedObligations,summary:'Actual independent Luna exact-source review: '+review.summary,verdict:'passed',findings:[]};
 let recorded:any=resumed?{id:'review_1',version:1,owner:'reviewer_1',data:expected}:undefined;
 let finding:any={id:'finding_1',version:3,owner:'reviewer_1',data:{viewId:original.id,manifestDigest:original.data.manifestDigest,composedCommitOid:original.data.receipt.commitOid,treeOid:original.data.receipt.treeOid,contractVersion:1,policyVersion:1,obligationIds:['cursor-validation'],affectedChangeIds:['change_1'],paths:['demo/seed/index.ts'],expected:'Reject tampering',observed:'Old source accepts tampering',nextOwner:'contributor_1',status:'repair-proposed',repairs:[{changeId:'change_1',revisionId:'revision_1'}],resolution:null,resolutionEvidence:null}};
 const evidence=()=>({applicability:app,resolverId:'reviewer_1',checkIds:['check_api','check_ui'],reviewIds:['review_1'],resolvedAt:'2026-10-14T00:00:00.000Z'});
 if(resumed){finding.data.status='resolved';finding.data.resolutionEvidence=evidence();finding.data.resolution='Reviewed';}
 const writes:any[]=[];const source={commitOid:candidate.view.commitOid,treeOid:candidate.view.treeOid};
 const checks:any[]=policy.data.checks.map((check:any,i:number)=>({id:'check_'+i,version:1,owner:'runner',data:{checkId:check.id,obligationIds:check.obligationIds,applicability:app,harnessVersion:'json-oracle-v1',result:'passed'}}));
 const client:any={projectId:candidate.projectId,view:async(id:string)=>clone(id===view.id?view:original),policy:async()=>clone(policy),baseline:async()=>clone(baseline),checks:async()=>clone(checks),reviews:async()=>recorded?[clone(recorded)]:[],context:async()=>({baseline:clone(baseline),contract:{id:'contract',version:1,owner:'owner',data:clone(demoPolicyManifest.contract)}}),change:async()=>({owner:'contributor_1'}),finding:async()=>clone(finding),
  reviewView:async(_id:string,input:any)=>{writes.push({kind:'review',input});recorded={id:'review_1',version:1,owner:'reviewer_1',data:clone(input.payload)};return clone(recorded);},
  resolveFinding:async(_id:string,input:any)=>{writes.push({kind:'resolve',input});finding={...finding,version:finding.version+1,data:{...finding.data,status:'resolved',resolution:'Reviewed',resolutionEvidence:evidence()}};return clone(finding);},
  readiness:async()=>({viewId:view.id,ready:true,sequence:1,applicability:app,coverage:[],blockers:[],findingIds:[],reviewIds:['review_1']})};
 const keys:string[]=[];const ports={client:client as WorkspaceClient,reviewerActorId:'reviewer_1',preserveViewIds:[original.id],requestKey:async(name:string)=>{keys.push(name);return 'request_'+keys.length;},readLocalSource:async()=>source};
 return{ports,client,writes,keys,policy,checks,source,view,original,baseline,app,setFinding:(value:any)=>{finding=value;},getFinding:()=>clone(finding),setReview:(value:any)=>{recorded=value;}};
}
it('records and resolves original-source findings against a replacement with exact readbacks',async()=>{
 const f=lifecycle();const result=await recordIndependentReview(f.ports,candidate,review);
 expect(result.readiness.ready).toBe(true);expect(result.baselineUnchanged).toBe(true);expect(result.originalViewsUnchanged).toBe(true);
 expect(f.writes.map(x=>x.kind)).toEqual(['review','resolve']);expect(f.keys).toEqual(['independent-review','resolve-finding_1-v3']);
 expect(f.writes[0].input.payload.composedCommitOid).toBe(candidate.view.commitOid);expect(f.writes[0].input.payload.obligationIds).toEqual(review.checkedObligations);
 expect(f.writes[1].input).toMatchObject({expectedVersion:3,payload:{viewId:candidate.viewId}});expect(result.findings[0]!.data.resolutionEvidence!.applicability).toEqual(f.app);
});
it('resumes exact review and resolution without any writes or reserved keys',async()=>{const f=lifecycle(true);expect((await recordIndependentReview(f.ports,candidate,review)).readiness.ready).toBe(true);expect(f.writes).toEqual([]);expect(f.keys).toEqual([]);});
it('refuses wrong source, policy, check IDs, author authority and unlinked repair before writes',async()=>{
 for(const alter of [(f:ReturnType<typeof lifecycle>)=>{f.source.commitOid='0'.repeat(40);},(f:ReturnType<typeof lifecycle>)=>{f.policy.data.checkSuiteDigest='0'.repeat(64);},(f:ReturnType<typeof lifecycle>)=>{f.checks[0].data.checkId='invented-check';},(f:ReturnType<typeof lifecycle>)=>{f.ports.reviewerActorId='contributor_1';},(f:ReturnType<typeof lifecycle>)=>{const x=f.getFinding();x.data.repairs=[];f.setFinding(x);}]){const f=lifecycle();alter(f);await expect(recordIndependentReview(f.ports,candidate,review)).rejects.toThrow();expect(f.writes).toEqual([]);}
});
it('refuses false producer readback, readiness or baseline preservation',async()=>{
 const wrong=lifecycle();const write=wrong.client.reviewView;wrong.client.reviewView=async(...args:any[])=>{const result=await write(...args);wrong.setReview({...result,owner:'different_reviewer'});return result;};await expect(recordIndependentReview(wrong.ports,candidate,review)).rejects.toThrow('REVIEW_READBACK_MISMATCH');
 const unready=lifecycle(true);unready.client.readiness=async()=>({viewId:candidate.viewId,ready:false,blockers:[{code:'FINDING_OPEN',message:'Still open'}],findingIds:['finding_1'],reviewIds:['review_1']});await expect(recordIndependentReview(unready.ports,candidate,review)).rejects.toThrow('NATIVE_READINESS_FALSE');
 const changed=lifecycle(true);let n=0;changed.client.baseline=async()=>n++===0?structuredClone(changed.baseline):{...changed.baseline,version:2};await expect(recordIndependentReview(changed.ports,candidate,review)).rejects.toThrow('BASELINE_CHANGED');
});
