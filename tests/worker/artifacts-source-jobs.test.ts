import { expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { sourceRef, jobResourceSchema } from '../../packages/contracts/source';

const actors={human:{id:'human',role:'human'},runner:{id:'runner',role:'runner'}} as const;
function fixture(){const projectId=`artifacts-job-${crypto.randomUUID()}`,stub=env.PROJECTS.get(env.PROJECTS.idFromName(projectId));const request=async(actor:keyof typeof actors,path:string,payload?:unknown,requestId:string=crypto.randomUUID(),expectedVersion?:number)=>{const response=await stub.fetch(new Request(`https://local${path}`,{method:payload===undefined?'GET':'POST',headers:{'x-project-id':projectId,'x-actor':JSON.stringify({...actors[actor],projectId}),'content-type':'application/json'},body:payload===undefined?undefined:JSON.stringify({requestId,expectedVersion,payload})}));return{status:response.status,body:await response.json() as any};};return{request};}

it('keeps successful legacy completion from bypassing selected Artifacts backend',async()=>{
 const f=fixture(),oid='a'.repeat(40),tree='b'.repeat(40);
 const proposal=await f.request('human','/contracts/proposals',{outcome:'Source',constraints:[],obligations:[{id:'o',description:'source',acceptanceExamples:[]}],requiredCheckIds:['check'],unresolvedQuestions:[]});
 expect((await f.request('human',`/contracts/${proposal.body.resource.id}/approve`,{},'approve',0)).status).toBe(201);
 expect((await f.request('human','/baseline/initialize',{commitOid:oid,treeOid:tree},'seed',0)).status).toBe(201);
 const seed=jobResourceSchema.parse((await f.request('runner','/runner/claim',{leaseSeconds:30},'claim')).body.resource);
 expect((await f.request('runner',`/runner/jobs/${seed.id}/complete`,{attemptId:seed.data.attemptId,ok:true,receipt:{backend:'local-git',commitOid:oid,treeOid:tree,ref:sourceRef(seed.data.input)}},'seed-complete')).status).toBe(201);
 const policy={contractVersion:1,checkSuiteDigest:'c'.repeat(64),harnessVersion:'json-oracle-v1',checks:[{id:'check',obligationIds:['o']}],requireIndependentReview:true,sourceBackend:'artifacts-git'};
 expect((await f.request('human','/policy',policy,'policy',0)).status).toBe(201);
 const denied=await f.request('runner',`/runner/jobs/${seed.id}/complete`,{attemptId:seed.data.attemptId,ok:true,receipt:{backend:'local-git',commitOid:oid,treeOid:tree,ref:sourceRef(seed.data.input)}},'bypass');
 expect(denied.status).toBe(409);expect(denied.body.code).toBe('SOURCE_BACKEND_MISMATCH');
});

it('rejects caller-supplied receipt fields on publish-artifacts route',async()=>{
 const f=fixture();const denied=await f.request('human','/runner/jobs/not-a-job/publish-artifacts',{attemptId:crypto.randomUUID(),commitOid:'a'.repeat(40),treeOid:'b'.repeat(40),packBase64:'AA==',manifestDigest:'c'.repeat(64),receipt:{backend:'artifacts-git'}});
 expect(denied.status).toBe(422);
});
