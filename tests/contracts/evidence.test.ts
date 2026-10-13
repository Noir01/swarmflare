import { describe, expect, it } from 'vitest';
import { checkReceiptSchema } from '../../packages/contracts/evidence';

const hash='a'.repeat(64), oid='b'.repeat(40);
const receipt={kind:'recorded-check',checkId:'check-1',obligationIds:['obl-1'],applicability:{projectId:'p',viewId:'v',manifestDigest:hash,composedCommitOid:oid,treeOid:oid,contractVersion:1,policyVersion:1,checkSuiteDigest:hash},harnessVersion:'json-oracle-v1',result:'passed',execution:{status:'exited',exitCode:0,stdout:'{}',stderr:'',startedAt:'2025-01-01T00:00:00.000Z',finishedAt:'2025-01-01T00:00:01.000Z',nodeVersion:'v22.1.0',stdoutDigest:hash,stderrDigest:hash}};
describe('recorded check receipt contract',()=>{
 it('accepts exact passed receipt schema',()=>expect(checkReceiptSchema.safeParse(receipt).success).toBe(true));
 it('rejects passed nonzero and unknown fields',()=>{expect(checkReceiptSchema.safeParse({...receipt,execution:{...receipt.execution,exitCode:1}}).success).toBe(false);expect(checkReceiptSchema.safeParse({...receipt,extra:true}).success).toBe(false);});
 it('bounds stdout and validates digest syntax',()=>{expect(checkReceiptSchema.safeParse({...receipt,execution:{...receipt.execution,stdout:'x'.repeat(65537)}}).success).toBe(false);expect(checkReceiptSchema.safeParse({...receipt,applicability:{...receipt.applicability,checkSuiteDigest:'bad'}}).success).toBe(false);});
 it('requires chronological timestamps and rejects passing interrupted or output-limited execution',()=>{
  expect(checkReceiptSchema.safeParse({...receipt,execution:{...receipt.execution,startedAt:'2025-01-01T00:00:02.000Z'}}).success).toBe(false);
  for(const execution of [{status:'exited',exitCode:1},{status:'timed-out',exitCode:null},{status:'output-limit',exitCode:null}]) expect(checkReceiptSchema.safeParse({...receipt,execution:{...receipt.execution,...execution}}).success).toBe(false);
  expect(checkReceiptSchema.safeParse({...receipt,result:'failed',execution:{...receipt.execution,status:'output-limit',exitCode:null,stdout:'x'.repeat(65537)}}).success).toBe(false);
 });
});