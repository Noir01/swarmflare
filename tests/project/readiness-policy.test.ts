import { describe, expect, it } from 'vitest';
import { evaluateReadiness } from '../../apps/worker/src/project/readiness';

const oid='a'.repeat(40), digest='b'.repeat(64), applicability={projectId:'p',viewId:'v',manifestDigest:digest,composedCommitOid:oid,treeOid:oid,contractVersion:1,policyVersion:1,checkSuiteDigest:digest};
const view:any={id:'v',version:1,owner:'h',data:{manifest:{baseVersion:1,baseCommitOid:oid,contractVersion:1,policyVersion:1,orderedRevisions:[{changeId:'c',revisionId:'r'}],decisionRevisions:[]},manifestDigest:digest,status:'runnable',receipt:{backend:'local-git',ref:'refs/agent/views/v',commitOid:oid,treeOid:oid}}};
const baseline:any={version:1,commitOid:oid}; const contract:any={version:1,data:{requiredCheckIds:['lint'],obligations:[{id:'o'}],unresolvedQuestions:[]}};
const policy:any={id:'p',version:1,owner:'h',data:{contractVersion:1,checkSuiteDigest:digest,harnessVersion:'json-oracle-v1',checks:[{id:'lint',obligationIds:['o']}],requireIndependentReview:true,sourceBackend:'local-git'}};
const change:any={id:'c',owner:'author',data:{revisions:[{revisionId:'r',status:'published',commitOid:oid,treeOid:oid,receipt:{backend:'local-git',commitOid:oid,treeOid:oid,ref:'refs/agent/revisions/c/r'},obligationIds:['o'],dependencies:[],decisionRevisions:[]}]}};
const review:any={id:'rev',owner:'reviewer',data:{viewId:'v',manifestDigest:digest,composedCommitOid:oid,treeOid:oid,contractVersion:1,policyVersion:1,checkSuiteDigest:digest,obligationIds:['o'],verdict:'passed'}};
const check:any={id:'ch',data:{checkId:'lint',result:'passed',obligationIds:['o'],applicability,harnessVersion:'json-oracle-v1'}};
const base:any={projectId:'p',sequence:3,view,baseline,contract,policy,changes:[change],findings:[],reviews:[review],checks:[check],claims:[],decisions:[]};
describe('policy readiness',()=>{
 it('fails closed without policy, missing suite checks, mismatched suite, and author review',()=>{
  expect(evaluateReadiness({...base,policy:null}).blockers.map(x=>x.code)).toContain('EVIDENCE_MISSING');
  expect(evaluateReadiness({...base,checks:[]}).ready).toBe(false);
  expect(evaluateReadiness({...base,checks:[{...check,data:{...check.data,applicability:{...applicability,checkSuiteDigest:'c'.repeat(64)}}}]}).ready).toBe(false);
  expect(evaluateReadiness({...base,reviews:[{...review,owner:'author'}]}).ready).toBe(false);
 });
 it('requires obligation coverage and fails on unknown dependencies or unresolved decisions',()=>{
  expect(evaluateReadiness({...base,policy:{...policy,data:{...policy.data,checks:[{id:'lint',obligationIds:['other']}]}}}).ready).toBe(false);
  expect(evaluateReadiness({...base,changes:[{...change,data:{revisions:[{revisionId:'r',obligationIds:['o'],dependencies:[{changeId:'missing',revisionId:'x'}],decisionRevisions:[]}]}}]}).ready).toBe(false);
  expect(evaluateReadiness({...base,decisions:[{id:'d',data:{status:'open',obligationIds:['o']}}]}).ready).toBe(false);
 });
 it('rejects applicable failed checks, non-required check IDs, and unknown selected obligations',()=>{
  expect(evaluateReadiness({...base,checks:[{...check,data:{...check.data,result:'failed'}}]}).blockers.map(x=>x.code)).toContain('CHECK_FAILED');
  expect(evaluateReadiness({...base,checks:[{...check,data:{...check.data,checkId:'other'}}]}).ready).toBe(false);
  expect(evaluateReadiness({...base,reviews:[{...review,owner:'author',data:{...review.data,verdict:'failed'}}]}).blockers.map(x=>x.code)).toContain('REVIEW_FAILED');
  const unknown={...change,data:{revisions:[{...change.data.revisions[0],obligationIds:['unknown']}]}};
  expect(evaluateReadiness({...base,changes:[unknown]}).blockers.map(x=>x.code)).toContain('OBLIGATION_UNKNOWN');
 });
 it('rejects needs-human decisions and one-sided overlap acknowledgements',()=>{
  expect(evaluateReadiness({...base,decisions:[{id:'d',data:{status:'needs-human'}}]}).ready).toBe(false);
  const a={id:'a',data:{areas:['same'],overlapAcknowledgements:[{otherClaimId:'b'}]}};
  const b={id:'b',data:{areas:['same'],overlapAcknowledgements:[]}};
  expect(evaluateReadiness({...base,claims:[a,b]}).blockers.map(x=>x.code)).toContain('CLAIM_OVERLAP');
 });
 it('requires each manifest-pinned decision revision to be current and agreed',()=>{
  const pinned={...base,view:{...view,data:{...view.data,manifest:{...view.data.manifest,decisionRevisions:[{decisionId:'d',version:2}]}}},decisions:[{id:'d',version:1,data:{status:'agreed'}}]};
  expect(evaluateReadiness(pinned).blockers.map(x=>x.code)).toContain('DECISION_UNKNOWN');
 });
 it('requires dependency closure and dependency-first topological order',()=>{
  const dependency={id:'d',owner:'other',data:{revisions:[{revisionId:'rd',status:'published',commitOid:oid,treeOid:oid,receipt:{backend:'local-git',commitOid:oid,treeOid:oid,ref:'refs/agent/revisions/d/rd'},obligationIds:['o'],dependencies:[],decisionRevisions:[]}]}};
  const consumer={id:'c',owner:'author',data:{revisions:[{...change.data.revisions[0],dependencies:[{changeId:'d',revisionId:'rd'}]}]}};
  const bad={...base,changes:[consumer,dependency],view:{...view,data:{...view.data,manifest:{...view.data.manifest,orderedRevisions:[{changeId:'c',revisionId:'r'},{changeId:'d',revisionId:'rd'}]}}}};
  expect(evaluateReadiness(bad).blockers.map(x=>x.code)).toContain('DEPENDENCY_ORDER');
  expect(evaluateReadiness({...bad,view:{...bad.view,data:{...bad.view.data,manifest:{...bad.view.data.manifest,orderedRevisions:[{changeId:'c',revisionId:'r'}]}}}}).blockers.map(x=>x.code)).toContain('DEPENDENCY_UNKNOWN');
 });
 it('binds evidence and policy coverage to exact configured required checks per obligation',()=>{
  const two={...contract,data:{...contract.data,requiredCheckIds:['lint','security'],obligations:[{id:'o'},{id:'o2'}]}};
  const policyTwo={...policy,data:{...policy.data,checks:[{id:'lint',obligationIds:['o']},{id:'security',obligationIds:['o2']}]}};
  const checkTwo={...check,data:{...check.data,checkId:'security',obligationIds:['o2']}};
  const reviewTwo={...review,data:{...review.data,obligationIds:['o2']}};
  const badCheck={...check,data:{...check.data,checkId:'lint',obligationIds:['o2']}};
  expect(evaluateReadiness({...base,contract:two,policy:policyTwo,checks:[badCheck,checkTwo],reviews:[review,reviewTwo]}).blockers.map(x=>x.code)).toContain('EVIDENCE_MISSING');
  expect(evaluateReadiness({...base,contract:two,policy:{...policyTwo,data:{...policyTwo.data,checks:[{id:'lint',obligationIds:['o']},{id:'security',obligationIds:['o']}] }},checks:[check,checkTwo],reviews:[review,reviewTwo]}).blockers.map(x=>x.code)).toContain('POLICY_OBLIGATION_UNCOVERED');
 });
 it('keeps resolved findings blocked outside the exact resolution applicability',()=>{
  const finding:any={id:'f',data:{status:'resolved',viewId:'v0',affectedChangeIds:['c'],obligationIds:['o'],resolutionEvidence:{applicability,resolverId:'reviewer',checkIds:['ch'],reviewIds:['rev'],resolvedAt:'2026-01-01T00:00:00.000Z'}}};
  expect(evaluateReadiness({...base,findings:[finding]}).findingIds).not.toContain('f');
  expect(evaluateReadiness({...base,findings:[finding],view:{...view,id:'other'}}).blockers.map(x=>x.code)).toContain('FINDING_RESOLUTION_STALE');
  expect(evaluateReadiness({...base,findings:[finding],view:{...view,data:{...view.data,manifestDigest:'c'.repeat(64)}}}).blockers.map(x=>x.code)).toContain('FINDING_RESOLUTION_STALE');
 });
});
