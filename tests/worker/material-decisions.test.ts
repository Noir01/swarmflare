import { describe, expect, it } from 'vitest';
import { acceptanceFixture } from './acceptance-fixture';

describe('human material decision resolution',()=>{
 const setup=async(participants=['alice','human'])=>{
  const f=await acceptanceFixture();
  const d=await f.ok('human','/decisions',{question:'Clarify material requirement',obligationIds:['obligation'],participants,material:true});
  const input={kind:'clarification',contractVersion:1,note:'Keep approved requirement unchanged.'};
  return {f,d,input};
 };
 const ready=async(f:any,d:any)=>{
  await f.ok('alice',`/decisions/${d.id}/responses`,{body:'I agree',acknowledge:true});
  await f.ok('human',`/decisions/${d.id}/responses`,{body:'I agree',acknowledge:true});
  await f.ok('alice',`/decisions/${d.id}/agree`,{});
  return f.ok('human',`/decisions/${d.id}/agree`,{});
 };
 it('requires explicit acknowledgements, exact human CAS and current contract; clears resolution after response change',async()=>{
  const f=await acceptanceFixture();
  const d=await f.ok('human','/decisions',{question:'Clarify material requirement',obligationIds:['obligation'],participants:['alice','human'],material:true});
  const input={kind:'clarification',contractVersion:1,note:'Keep approved requirement unchanged.'};
  expect((await f.request('human',`/decisions/${d.id}/resolve`,input,1)).status).toBe(409);
  await f.ok('alice',`/decisions/${d.id}/responses`,{body:'I agree',acknowledge:true});
  await f.ok('human',`/decisions/${d.id}/responses`,{body:'I agree',acknowledge:true});
  await f.ok('alice',`/decisions/${d.id}/agree`,{});
  const agreed=await f.ok('human',`/decisions/${d.id}/agree`,{});
  expect(agreed.data.status).toBe('needs-human');
  expect((await f.request('alice',`/decisions/${d.id}/resolve`,input,agreed.version)).status).toBe(403);
  expect((await f.request('human',`/decisions/${d.id}/resolve`,input,agreed.version-1)).status).toBe(409);
  const resolved=await f.ok('human',`/decisions/${d.id}/resolve`,input,agreed.version,'resolve-human');
  expect(resolved.data.humanResolution).toMatchObject({actorId:'human',kind:'clarification',contractVersion:1});
  expect((await f.request('human',`/decisions/${d.id}/resolve`,input,resolved.version,'resolve-again')).status).toBe(409);
  const changed=await f.ok('alice',`/decisions/${d.id}/responses`,{body:'Changed answer',acknowledge:true});
  expect(changed.data).toMatchObject({status:'open',humanResolution:null,agreements:[]});
 });
 it('cannot resolve until every participant has an acknowledged response and agreement',async()=>{
  const {f,d,input}=await setup();
  await f.ok('alice',`/decisions/${d.id}/responses`,{body:'I agree',acknowledge:true});
  await f.ok('alice',`/decisions/${d.id}/agree`,{});
  const attempt=await f.request('human',`/decisions/${d.id}/resolve`,input,3);
  expect(attempt.status).toBe(409);
  expect(attempt.body.code).toBe('DECISION_NOT_RESOLVABLE');
 });
 it('rejects stale decision and stale approved contract versions',async()=>{
  const {f,d,input}=await setup();
  const agreed=await ready(f,d);
  expect((await f.request('human',`/decisions/${d.id}/resolve`,input,agreed.version-1)).status).toBe(409);
  const proposal=await f.ok('human','/contracts/proposals',{...f.contract,outcome:'Updated fixture contract'});
  await f.ok('human',`/contracts/${proposal.id}/approve`,{},1);
  const stale=await f.request('human',`/decisions/${d.id}/resolve`,input,agreed.version);
  expect(stale.status).toBe(409);
  expect(stale.body.code).toBe('CONTRACT_STALE');
 });
 it('requires a newly approved contract version for contract-update',async()=>{
  const {f,d}=await setup();
  const agreed=await ready(f,d);
  expect((await f.request('human',`/decisions/${d.id}/resolve`,{kind:'contract-update',contractVersion:1,note:'Update requirement'},agreed.version)).body.code).toBe('CONTRACT_UPDATE_REQUIRED');
  const proposal=await f.ok('human','/contracts/proposals',{...f.contract,outcome:'Updated fixture contract'});
  await f.ok('human',`/contracts/${proposal.id}/approve`,{},1);
  const resolved=await f.ok('human',`/decisions/${d.id}/resolve`,{kind:'contract-update',contractVersion:2,note:'Approved new requirement'},agreed.version,'contract-update');
  expect(resolved.data.humanResolution).toMatchObject({kind:'contract-update',contractVersion:2});
 });
 it('retries an identical resolution idempotently and preserves clarification contract',async()=>{
  const {f,d,input}=await setup();
  const agreed=await ready(f,d);
  const first=await f.ok('human',`/decisions/${d.id}/resolve`,input,agreed.version,'same-resolution');
  const retry=await f.ok('human',`/decisions/${d.id}/resolve`,input,agreed.version,'same-resolution');
  expect(retry).toEqual(first);
  expect((await f.ok('human','/contracts/1')).data).toEqual(f.contract);
 });
 it('makes readiness blocked when an otherwise agreed resolution pins an old contract',async()=>{
  const {f,d,input}=await setup();
  const agreed=await ready(f,d);
  const resolved=await f.ok('human',`/decisions/${d.id}/resolve`,input,agreed.version,'resolve-for-stale-readiness');
  const proposal=await f.ok('human','/contracts/proposals',{...f.contract,outcome:'Updated fixture contract'});
  await f.ok('human',`/contracts/${proposal.id}/approve`,{},1);
  const readiness=await f.ok('human',`/views/${f.view.id}/readiness`);
  expect(readiness.ready).toBe(false);
  expect(readiness.blockers.map((x:any)=>x.code)).toContain('DECISION_RESOLUTION_STALE');
  expect(resolved.data.humanResolution.contractVersion).toBe(1);
 });
});
