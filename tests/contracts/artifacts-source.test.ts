import { describe, expect, it } from 'vitest';
import { artifactsSourceReceiptSchema, durableSourceReceiptSchema, jobCompleteInput, jobPublishInput, sourceReceiptSchema } from '../../packages/contracts/source';
import { sourceVerificationInput } from '../../packages/contracts/acceptance';

const tuple={commitOid:'a'.repeat(40),treeOid:'b'.repeat(40),ref:'refs/agent/views/view'};
describe('durable source contracts',()=>{
 it('distinguishes local-only legacy receipts from durable Artifacts receipts',()=>{
  const local={backend:'local-git',...tuple},remote={backend:'artifacts-git',...tuple};
  expect(sourceReceiptSchema.safeParse(remote).success).toBe(false);
  expect(jobCompleteInput.safeParse({attemptId:'attempt',ok:true,receipt:remote}).success).toBe(false);
  expect(artifactsSourceReceiptSchema.parse(remote)).toEqual(remote);
  expect(durableSourceReceiptSchema.parse(remote)).toEqual(remote);
  expect(sourceVerificationInput.parse({receipt:remote})).toEqual({receipt:remote});
  expect(durableSourceReceiptSchema.parse(local)).toEqual(local);
 });
 it('bounds canonical publish pack envelope and requires exact fields',()=>{
  const valid={attemptId:'attempt',commitOid:tuple.commitOid,treeOid:tuple.treeOid,packBase64:'AA==',manifestDigest:'c'.repeat(64)};
  expect(jobPublishInput.parse(valid)).toEqual(valid);
  expect(jobPublishInput.safeParse({...valid,repo:'caller-controlled'}).success).toBe(false);
  expect(jobPublishInput.safeParse({...valid,packBase64:'AA==\n'}).success).toBe(false);
  expect(jobPublishInput.safeParse({...valid,packBase64:'A'.repeat(48004)}).success).toBe(false);
 });
});
