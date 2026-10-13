import { z } from 'zod';
import { applicabilitySchema, digest, id, oid, version } from './index';
import { baselineSchema, durableSourceReceiptSchema } from './source';

const unique = (values: string[]) => new Set(values).size === values.length;
const ids = z.array(id).min(1).max(100).refine(unique, 'Values must be unique');
const resource = <T extends z.ZodType>(data: T) => z.object({ id, version, owner: id, data }).strict();
export const policyInput = z.object({
  contractVersion: version, checkSuiteDigest: digest, harnessVersion: z.literal('json-oracle-v1'),
  checks: z.array(z.object({ id, obligationIds: ids }).strict()).min(1).max(100)
    .refine(xs => unique(xs.map(x => x.id)), 'Check IDs must be unique'),
  requireIndependentReview: z.literal(true), sourceBackend: z.enum(['local-git','artifacts-git']),
}).strict();
export const policyResourceSchema = resource(policyInput);
export type PolicyResource = z.infer<typeof policyResourceSchema>;
export const confirmationInput = z.object({ applicability: applicabilitySchema, expectedBaselineVersion: version, expectedBaselineCommitOid: oid, readinessSequence: z.number().int().nonnegative(), confirm: z.literal(true) }).strict();
export const confirmationResourceSchema = resource(confirmationInput.omit({ confirm: true }).extend({ expiresAt: z.number().finite(), used: z.boolean() }));
export const acceptanceInput = z.object({ confirmationId:id, applicability:applicabilitySchema, expectedBaselineVersion:version, expectedBaselineCommitOid:oid, readinessSequence:z.number().int().nonnegative() }).strict();
export const acceptanceResourceSchema = resource(z.object({ applicability:applicabilitySchema, confirmationId:id, oldBaseline:baselineSchema, newBaseline:baselineSchema, acceptedAt:z.string().datetime() }).strict());
export const sourceVerificationInput = z.object({ receipt:durableSourceReceiptSchema }).strict();
export const sourceVerificationResourceSchema = resource(z.object({ viewId:id, receipt:durableSourceReceiptSchema, verifiedAt:z.number().finite() }).strict());
export type ConfirmationInput = z.infer<typeof confirmationInput>;
export type ConfirmationResource = z.infer<typeof confirmationResourceSchema>;
export type AcceptanceInput = z.infer<typeof acceptanceInput>;
export type AcceptanceResource = z.infer<typeof acceptanceResourceSchema>;
export type SourceVerificationInput = z.infer<typeof sourceVerificationInput>;
export type SourceVerificationResource = z.infer<typeof sourceVerificationResourceSchema>;
