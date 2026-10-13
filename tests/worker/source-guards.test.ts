import { expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { sourceRef, jobResourceSchema, revisionResourceSchema } from '../../packages/contracts/source';

// Independent coordinator regressions: local SQLite, synthetic source receipts only.
const actors={human:{id:'human',role:'human'}, writer:{id:'writer',role:'contributor'}, runner:{id:'runner',role:'runner'}, otherRunner:{id:'other-runner',role:'runner'}} as const;
function fixture(){
 const projectId=`guards-${crypto.randomUUID()}`,stub=env.PROJECTS.get(env.PROJECTS.idFromName(projectId));
 const request=async(actor:keyof typeof actors,path:string,payload?:unknown,requestId:string=crypto.randomUUID(),expectedVersion?:number)=>{
  const response=await stub.fetch(new Request(`https://local${path}`,{method:payload===undefined?'GET':'POST',headers:{'x-project-id':projectId,'x-actor':JSON.stringify({...actors[actor],projectId}),'content-type':'application/json'},body:payload===undefined?undefined:JSON.stringify({requestId,expectedVersion,payload})}));
  return {status:response.status,body:await response.json() as any};
 };
 const prepare=async()=>{
  const p=await request('human','/contracts/proposals',{outcome:'Exact source',constraints:[],obligations:[{id:'source',description:'Exact source',acceptanceExamples:[]}],requiredCheckIds:['check'],unresolvedQuestions:[]});
  expect((await request('human',`/contracts/${p.body.resource.id}/approve`,{},'approve',0)).status).toBe(201);
 };
 return {request,prepare};
}
const seed={commitOid:'a'.repeat(40),treeOid:'b'.repeat(40)};
it('reserves one initial baseline even before source verification completes',async()=>{
 const f=fixture();await f.prepare();
 expect((await f.request('human','/baseline/initialize',seed,'first',0)).status).toBe(201);
 const duplicate=await f.request('human','/baseline/initialize',{...seed,commitOid:'c'.repeat(40)},'second',0);
 expect(duplicate.status).toBe(409);
 expect((await f.request('writer','/baseline')).body.resource).toBeNull();
});
it('replays the same job claim after queue state changes',async()=>{
 const f=fixture();await f.prepare();await f.request('human','/baseline/initialize',seed,'seed',0);
 const first=await f.request('runner','/runner/claim',{leaseSeconds:30},'claim');
 const again=await f.request('runner','/runner/claim',{leaseSeconds:30},'claim');
 expect(again.body).toEqual(first.body);
});
it('does not let another runner bypass attempt authorization on completed receipt replay',async()=>{
 const f=fixture();await f.prepare();await f.request('human','/baseline/initialize',seed,'seed',0);
 const claimed=jobResourceSchema.parse((await f.request('runner','/runner/claim',{leaseSeconds:30},'claim')).body.resource);
 const payload={attemptId:claimed.data.attemptId,ok:true,receipt:{backend:'local-git',...seed,ref:sourceRef(claimed.data.input)}};
 expect((await f.request('runner',`/runner/jobs/${claimed.id}/complete`,payload,'done')).status).toBe(201);
 expect((await f.request('otherRunner',`/runner/jobs/${claimed.id}/complete`,{...payload,attemptId:'forged'},'forged')).status).toBe(409);
 expect((await f.request('runner',`/runner/jobs/${claimed.id}/complete`,payload,'done')).status).toBe(201);
});
it('rejects mismatched seed receipts and returns the frozen revision resource on reservation',async()=>{
 const f=fixture();await f.prepare();await f.request('human','/baseline/initialize',seed,'seed',0);
 const claimed=jobResourceSchema.parse((await f.request('runner','/runner/claim',{leaseSeconds:30},'claim')).body.resource);
 const receipt={backend:'local-git',...seed,ref:sourceRef(claimed.data.input)};
 expect((await f.request('runner',`/runner/jobs/${claimed.id}/complete`,{attemptId:claimed.data.attemptId,ok:true,receipt:{...receipt,treeOid:'c'.repeat(40)}},'bad')).status).toBe(422);
 expect((await f.request('writer','/baseline')).body.resource).toBeNull();
 expect((await f.request('runner',`/runner/jobs/${claimed.id}/complete`,{attemptId:claimed.data.attemptId,ok:true,receipt},'done')).status).toBe(201);
 const change=(await f.request('writer','/changes',{title:'Change',obligationIds:['source']},'change')).body.resource;
 const reserved=await f.request('writer',`/changes/${change.id}/revisions`,{baseCommitOid:seed.commitOid,commitOid:'c'.repeat(40),treeOid:'d'.repeat(40),obligationIds:['source'],decisionRevisions:[],dependencies:[]},'revision');
 expect(reserved.status).toBe(201);
 expect(revisionResourceSchema.safeParse(reserved.body.resource).success).toBe(true);
});
