import { expect } from 'vitest';
import { env } from 'cloudflare:test';
import worker from '../../apps/worker/src/index';
import { sourceRef } from '../../packages/contracts/source';

// Emulator metadata fixture ONLY: source and execution receipts below are synthetic.
// Real Git/sandbox qualification belongs to tests/e2e-local/acceptance.test.ts.
export async function acceptanceFixture() {
  const projectId = `accept-security-${crypto.randomUUID()}`;
  const actors = { human: 'human', otherHuman: 'human', alice: 'contributor', reviewer: 'reviewer', runner: 'runner' } as const;
  const hash = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), b => b.toString(16).padStart(2, '0')).join('');
  const credentials = await Promise.all(Object.entries(actors).map(async ([id, role]) => ({id,role,projectId,expiresAt:Date.now()+600_000,tokenHash:await hash(`fixture-only-${id}`)})));
  const bindings = {...env, AUTH_CREDENTIALS:JSON.stringify(credentials)};
  const request = async (actor:keyof typeof actors,path:string,payload?:unknown,expectedVersion?:number,requestId:string=crypto.randomUUID()) => {
    const response=await worker.fetch(new Request(`https://local/api/v1/projects/${projectId}${path}`,{method:payload===undefined?'GET':'POST',headers:{authorization:`Bearer fixture-only-${actor}`,'content-type':'application/json'},body:payload===undefined?undefined:JSON.stringify({requestId,expectedVersion,payload})}),bindings);
    return {status:response.status,body:await response.json() as any};
  };
  const ok = async (...args:Parameters<typeof request>) => {const result=await request(...args);expect(result.status,JSON.stringify(result.body)).toBeLessThan(300);return result.body.resource;};
  const contract={outcome:'Synthetic acceptance security fixture',constraints:[],obligations:[{id:'obligation',description:'Fixture behavior',acceptanceExamples:[]}],requiredCheckIds:['check'],unresolvedQuestions:[]};
  const proposal=await ok('human','/contracts/proposals',contract);
  await ok('human',`/contracts/${proposal.id}/approve`,{},0);
  const policy={contractVersion:1,checkSuiteDigest:'d'.repeat(64),harnessVersion:'json-oracle-v1',checks:[{id:'check',obligationIds:['obligation']}],requireIndependentReview:true,sourceBackend:'local-git'};
  await ok('human','/policy',policy,0);
  const complete = async (commitOid:string,treeOid:string) => {
    const job=await ok('runner','/runner/claim',{leaseSeconds:120});
    const receipt={backend:'local-git',commitOid,treeOid,ref:sourceRef(job.data.input)};
    await ok('runner',`/runner/jobs/${job.id}/complete`,{attemptId:job.data.attemptId,ok:true,receipt});return receipt;
  };
  await ok('human','/baseline/initialize',{commitOid:'a'.repeat(40),treeOid:'b'.repeat(40)},0);
  await complete('a'.repeat(40),'b'.repeat(40));
  const baseline=await ok('human','/baseline');
  const change=await ok('alice','/changes',{title:'Fixture contribution',obligationIds:['obligation']});
  const revision=await ok('alice',`/changes/${change.id}/revisions`,{baseCommitOid:baseline.commitOid,commitOid:'c'.repeat(40),treeOid:'e'.repeat(40),obligationIds:['obligation'],decisionRevisions:[],dependencies:[]});
  await complete('c'.repeat(40),'e'.repeat(40));
  const manifest={baseVersion:1,baseCommitOid:baseline.commitOid,contractVersion:1,policyVersion:1,orderedRevisions:[{changeId:change.id,revisionId:revision.id}],excludedChangeIds:[],decisionRevisions:[],compositionVersion:1};
  const queued=await ok('alice','/views',manifest);
  const receipt=await complete('f'.repeat(40),'e'.repeat(40));
  const view=await ok('human',`/views/${queued.id}`);
  const applicability={projectId,viewId:view.id,manifestDigest:view.data.manifestDigest,composedCommitOid:receipt.commitOid,treeOid:receipt.treeOid,contractVersion:1,policyVersion:1,checkSuiteDigest:policy.checkSuiteDigest};
  const check={kind:'recorded-check',checkId:'check',obligationIds:['obligation'],applicability,harnessVersion:'json-oracle-v1',result:'passed',execution:{status:'exited',exitCode:0,stdout:'',stderr:'',startedAt:new Date().toISOString(),finishedAt:new Date().toISOString(),nodeVersion:'synthetic-fixture',stdoutDigest:await hash(''),stderrDigest:await hash('')}};
  await ok('runner',`/runner/views/${view.id}/checks`,check);
  const {projectId:_project,...anchor}=applicability;
  const review={...anchor,obligationIds:['obligation'],summary:'Synthetic review fixture',verdict:'passed',findings:[]};
  await ok('reviewer',`/views/${view.id}/reviews`,review);
  const verify=()=>ok('runner',`/runner/views/${view.id}/source-verifications`,{receipt});
  const confirm=async () => {await verify();const ready=await ok('human',`/views/${view.id}/readiness`);expect(ready.ready,JSON.stringify(ready)).toBe(true);return ok('human',`/views/${view.id}/confirmations`,{applicability,expectedBaselineVersion:baseline.version,expectedBaselineCommitOid:baseline.commitOid,readinessSequence:ready.sequence,confirm:true});};
  const acceptInput=(confirmation:any)=>({confirmationId:confirmation.id,applicability,expectedBaselineVersion:baseline.version,expectedBaselineCommitOid:baseline.commitOid,readinessSequence:confirmation.data.readinessSequence});
  const {checkSuiteDigest:_suite,...findingAnchor}=anchor;
  const finding={...findingAnchor,obligationIds:['obligation'],affectedChangeIds:[change.id],paths:['probe.mjs'],expected:'Fixture invariant',observed:'Fixture violation',nextOwner:'alice'};
  return {request,ok,projectId,baseline,policy,contract,view,change,revision,manifest,receipt,applicability,check,review,finding,confirm,verify,acceptInput};
}
