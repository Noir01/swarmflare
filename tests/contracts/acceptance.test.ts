import { describe, expect, it } from 'vitest';
import { policyInput, policyResourceSchema, confirmationInput, confirmationResourceSchema, acceptanceInput, acceptanceResourceSchema, sourceVerificationInput, sourceVerificationResourceSchema } from '../../packages/contracts/acceptance';

const oid = 'a'.repeat(40), digest = 'b'.repeat(64);
const applicability = { projectId:'p', viewId:'v', manifestDigest:digest, composedCommitOid:oid, treeOid:oid, contractVersion:1, policyVersion:1, checkSuiteDigest:digest };
const baseline = { version:1, commitOid:oid };
const receipt = { backend:'local-git' as const, commitOid:oid, treeOid:oid, ref:'refs/agent/views/v' };
describe('acceptance contracts',()=>{
 it('strictly validates policy and coverage uniqueness',()=>{
  const p={contractVersion:1,checkSuiteDigest:digest,harnessVersion:'json-oracle-v1',checks:[{id:'check',obligationIds:['o']}],requireIndependentReview:true,sourceBackend:'local-git'};
  expect(policyInput.parse(p)).toEqual(p); expect(policyInput.safeParse({...p,extra:true}).success).toBe(false);
  expect(policyInput.safeParse({...p,checks:[...p.checks,{id:'check',obligationIds:['x']}]}).success).toBe(false);
  expect(policyInput.safeParse({...p,checks:[{id:'check',obligationIds:['o','o']}]}).success).toBe(false);
 });
 it('validates confirmation/acceptance and source verification exact objects',()=>{
  const c={applicability,expectedBaselineVersion:1,expectedBaselineCommitOid:oid,readinessSequence:4,confirm:true};
  expect(confirmationInput.parse(c)).toEqual(c); expect(confirmationInput.safeParse({...c,confirm:false}).success).toBe(false);
  const {confirm:_confirm,...confirmationData}=c;
  expect(confirmationResourceSchema.safeParse({id:'c',version:1,owner:'h',data:{...confirmationData,expiresAt:1,used:false}}).success).toBe(true);
  const a={confirmationId:'c',applicability,expectedBaselineVersion:1,expectedBaselineCommitOid:oid,readinessSequence:5};
  expect(acceptanceInput.parse(a)).toEqual(a);
  expect(acceptanceResourceSchema.safeParse({id:'a',version:1,owner:'h',data:{applicability,confirmationId:'c',oldBaseline:{...baseline,treeOid:oid,receipt},newBaseline:{version:2,commitOid:oid,treeOid:oid,receipt},acceptedAt:new Date().toISOString()}}).success).toBe(true);
  expect(sourceVerificationInput.parse({receipt})).toEqual({receipt});
  expect(sourceVerificationResourceSchema.safeParse({id:'s',version:1,owner:'r',data:{viewId:'v',receipt,verifiedAt:1}}).success).toBe(true);
 });
});
