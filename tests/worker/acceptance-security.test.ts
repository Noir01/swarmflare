import { expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { acceptanceFixture } from './acceptance-fixture';

it('commits exactly one acceptance and returns its immutable receipt on concurrent retry',async()=>{
 const f=await acceptanceFixture(),confirmation=await f.confirm(),payload=f.acceptInput(confirmation);
 const results=await Promise.all([f.request('human','/acceptances',payload,undefined,'same-accept'),f.request('human','/acceptances',payload,undefined,'same-accept')]);
 expect(results.map(x=>x.status)).toEqual([201,201]);expect(results[1]!.body).toEqual(results[0]!.body);
 const accepted=results[0]!.body.resource;
 expect(await f.ok('human','/baseline')).toEqual(accepted.data.newBaseline);
 expect(accepted.data.newBaseline).toMatchObject({version:2,commitOid:f.receipt.commitOid,treeOid:f.receipt.treeOid});
 expect(await f.ok('human',`/acceptances/${accepted.id}`)).toEqual(accepted);
 expect((await f.request('human','/acceptances',{...payload,expectedBaselineVersion:2},undefined,'same-accept')).body.code).toBe('IDEMPOTENCY_CONFLICT');
 expect((await f.request('human','/acceptances',payload)).status).toBe(409);
 expect(await f.ok('human','/baseline')).toEqual(accepted.data.newBaseline);
});

it('binds human confirmation to actor and exact source, contract, policy, baseline and sequence',async()=>{
 const f=await acceptanceFixture(),confirmation=await f.confirm(),payload=f.acceptInput(confirmation);
 for(const actor of ['alice','reviewer','runner','otherHuman'] as const){expect((await f.request(actor,'/acceptances',payload)).status).toBe(actor==='otherHuman'?409:403);}
 const variants=[{...payload,expectedBaselineCommitOid:'0'.repeat(40)},{...payload,expectedBaselineVersion:2},{...payload,readinessSequence:payload.readinessSequence+1},...['manifestDigest','composedCommitOid','treeOid','checkSuiteDigest'].map(key=>({...payload,applicability:{...payload.applicability,[key]:'0'.repeat(key.endsWith('Digest')?64:40)}})),...['contractVersion','policyVersion'].map(key=>({...payload,applicability:{...payload.applicability,[key]:2}}))];
 for(const variant of variants){expect((await f.request('human','/acceptances',variant)).status).toBe(409);expect(await f.ok('human','/baseline')).toEqual(f.baseline);}
 expect((await f.request('human','/acceptances',payload)).status).toBe(201);
});

it('rejects acceptance when a finding wins after confirmation, without changing baseline',async()=>{
 const f=await acceptanceFixture(),confirmation=await f.confirm();
 const finding=await f.ok('reviewer','/findings',f.finding);
 expect((await f.request('human','/acceptances',f.acceptInput(confirmation))).status).toBe(409);
 expect(await f.ok('human','/baseline')).toEqual(f.baseline);
 expect((await f.ok('human',`/views/${f.view.id}/readiness`)).findingIds).toContain(finding.id);
});

it.each(['contract','policy'] as const)('invalidates prior confirmation when %s changes',async kind=>{
 const f=await acceptanceFixture(),confirmation=await f.confirm();
 if(kind==='policy')await f.ok('human','/policy',f.policy,1);
 else {const p=await f.ok('human','/contracts/proposals',f.contract);await f.ok('human',`/contracts/${p.id}/approve`,{},1);}
 expect((await f.request('human','/acceptances',f.acceptInput(confirmation))).status).toBe(409);
 expect(await f.ok('human','/baseline')).toEqual(f.baseline);
 expect((await f.ok('human',`/views/${f.view.id}/readiness`)).ready).toBe(false);
});

it.each(['confirmation','source-verification'] as const)('refuses expired %s using deterministic emulator storage clock fixture',async kind=>{
 const f=await acceptanceFixture(),confirmation=await f.confirm();
 const stub=env.PROJECTS.get(env.PROJECTS.idFromName(f.projectId));
 await runInDurableObject(stub,async (_instance,state)=>{
   const row=state.storage.sql.exec<{id:string,data:string}>('SELECT id,data FROM resources WHERE kind=?',kind).one();const data=JSON.parse(row.data);
   if(kind==='confirmation')data.expiresAt=Date.now()-1;else data.verifiedAt=Date.now()-30_001;
   state.storage.sql.exec('UPDATE resources SET data=? WHERE id=?',JSON.stringify(data),row.id);
 });
 expect((await f.request('human','/acceptances',f.acceptInput(confirmation))).status).toBe(409);
 expect(await f.ok('human','/baseline')).toEqual(f.baseline);
});

it('refuses wrong-suite evidence and nonrunner source attestations',async()=>{
 const f=await acceptanceFixture();
 expect((await f.request('runner',`/runner/views/${f.view.id}/checks`,{...f.check,applicability:{...f.applicability,checkSuiteDigest:'0'.repeat(64)}})).status).toBe(422);
 expect((await f.request('reviewer',`/views/${f.view.id}/reviews`,{...f.review,checkSuiteDigest:'0'.repeat(64)})).status).toBe(422);
 expect((await f.request('human',`/runner/views/${f.view.id}/source-verifications`,{receipt:f.receipt})).status).toBe(403);
 expect((await f.request('runner',`/runner/views/${f.view.id}/source-verifications`,{receipt:{...f.receipt,treeOid:'0'.repeat(40)}})).status).toBe(422);
 expect(await f.ok('human','/baseline')).toEqual(f.baseline);
});
