import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import worker from '../../apps/worker/src/index';

describe('deployment-authorized demo bootstrap',()=>{
 const contract={outcome:'Deliver the approved demo with verifiable API behavior and usable tenant-aware UI navigation.',constraints:['Use the mandatory local API and UI demo suites; preserve tenant isolation.'],obligations:['legacy-response','pagination-order','cursor-validation','tenant-isolation','ui-navigation','ui-tenant-switch'].map(id=>({id,description:`Demonstrate ${id.replaceAll('-',' ')}.`,acceptanceExamples:[]})),requiredCheckIds:['mandatory-demo-api','mandatory-demo-ui'],unresolvedQuestions:[]};
 const policy={contractVersion:1,checkSuiteDigest:'a'.repeat(64),harnessVersion:'json-oracle-v1',checks:[{id:'mandatory-demo-api',obligationIds:['legacy-response','pagination-order','cursor-validation','tenant-isolation']},{id:'mandatory-demo-ui',obligationIds:['ui-navigation','ui-tenant-switch']}],requireIndependentReview:true,sourceBackend:'artifacts-git'};
 const config=(projectId:string,expiresAt=Date.now()+60000)=>JSON.stringify({projectId,expiresAt,contract,policy,seed:{commitOid:'a'.repeat(40),treeOid:'b'.repeat(40)}});
 it('refuses missing deployment configuration',async()=>{
  const projectId=`bootstrap-${crypto.randomUUID()}`,token='fixture-runner',hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))),b=>b.toString(16).padStart(2,'0')).join('');
  const bindings={...env,AUTH_CREDENTIALS:JSON.stringify([{id:'runner',projectId,role:'runner',expiresAt:Date.now()+60000,tokenHash:hash}])};
  const response=await worker.fetch(new Request(`https://local/api/v1/projects/${projectId}/demo/bootstrap`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({requestId:'boot',payload:{}})}),bindings);
  expect(response.status).toBe(404);
 });
 it('rejects expired/wrong-project config and contributor, then atomically queues and replays exact setup',async()=>{
  const projectId=`bootstrap-${crypto.randomUUID()}`,other=`bootstrap-${crypto.randomUUID()}`;
  const hash=async(token:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))),b=>b.toString(16).padStart(2,'0')).join('');
  const credentials=await Promise.all((['runner','contributor'] as const).map(async id=>({id,projectId,role:id as 'runner'|'contributor',expiresAt:Date.now()+60000,tokenHash:await hash(id)})));
  const bindings={...env,AUTH_CREDENTIALS:JSON.stringify(credentials)};
  const call=async(token:string,cfg:string,requestId='boot')=>{const r=await worker.fetch(new Request(`https://local/api/v1/projects/${projectId}/demo/bootstrap`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({requestId,payload:{}})}),{...bindings,DEMO_BOOTSTRAP_CONFIG:cfg} as any);return {status:r.status,body:await r.json() as any};};
  expect((await call('runner',config(projectId,Date.now()-1))).status).toBe(410);
  expect((await call('runner',config(other))).status).toBe(403);
  expect((await call('contributor',config(projectId))).status).toBe(403);
  const first=await call('runner',config(projectId));expect(first.status).toBe(201);
  expect(first.body.resource.status).toBe('pending-seed-publication');
  expect(first.body.resource.seedJob.data.status).toBe('queued');expect(first.body.resource.seedJob.data.input.kind).toBe('seed');
  expect(first.body.resource.contract.data.obligations.map((x:any)=>x.id)).toEqual(contract.obligations.map(x=>x.id));
  expect((await call('runner',config(projectId))).body).toEqual(first.body);
  expect((await call('runner',config(projectId),'different')).status).toBe(409);
  for(const [path,payload] of [['/policy',policy],['/baseline/initialize',{commitOid:'a'.repeat(40),treeOid:'b'.repeat(40)}],[`/contracts/${first.body.resource.proposal.id}/approve`,{}]] as const){
   const denied=await worker.fetch(new Request(`https://local/api/v1/projects/${projectId}${path}`,{method:'POST',headers:{authorization:'Bearer runner','content-type':'application/json'},body:JSON.stringify({requestId:crypto.randomUUID(),expectedVersion:0,payload})}),bindings);
   expect(denied.status).toBe(403);
  }
 });
});
