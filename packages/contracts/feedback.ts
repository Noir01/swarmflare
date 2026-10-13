import { z } from 'zod';
import { applicabilitySchema, digest, id, oid, revisionRef, version } from './index';

const nonemptyIds = z.array(id).min(1).max(100);
const relativePath = z.string().min(1).max(4096).refine((path) => {
  if (path.startsWith('/') || path.includes('\\') || /[\u0000-\u001f\u007f]/.test(path)) return false;
  const segments = path.split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..' && segment.toLowerCase() !== '.git');
}, 'Expected a safe relative path');

const evidenceAnchor = {
  viewId: id,
  manifestDigest: digest,
  composedCommitOid: oid,
  treeOid: oid,
  contractVersion: version,
  policyVersion: version,
};

export const findingInput = z.object({
  ...evidenceAnchor,
  obligationIds: nonemptyIds,
  affectedChangeIds: nonemptyIds,
  paths: z.array(relativePath).max(100),
  expected: z.string().min(1).max(4000),
  observed: z.string().min(1).max(4000),
  nextOwner: id,
}).strict();

export const findingDataSchema = findingInput.extend({
  status: z.enum(['open', 'repair-proposed', 'resolved']),
  repairs: z.array(revisionRef).max(100).default([]),
  resolution: z.string().max(4000).nullable().default(null),
  ownerCorrections: z.array(z.object({ previousOwner: id, nextOwner: id, actorId: id, note: z.string().min(1).max(4000) }).strict()).max(10).optional(),
  resolutionEvidence: z.object({ applicability: applicabilitySchema, resolverId: id, checkIds: z.array(id), reviewIds: z.array(id), resolvedAt: z.string().datetime() }).strict().nullable().optional(),
}).strict();

const resourceSchema = <T extends z.ZodType>(data: T) => z.object({ id, version, owner: id, data }).strict();
export const findingResourceSchema = resourceSchema(findingDataSchema);

export const repairInput = z.object({
  revisions: z.array(revisionRef).min(1).max(100).refine(
    (revisions) => new Set(revisions.map(({ changeId }) => changeId)).size === revisions.length,
    'Only one exact revision per Change',
  ),
}).strict();

export const findingOwnerCorrectionInput = z.object({ nextOwner: id, note: z.string().min(1).max(4000) }).strict();

export const resolveInput = z.object({ viewId: id, note: z.string().min(1).max(4000) }).strict();

export const reviewInput = z.object({
  ...evidenceAnchor,
  checkSuiteDigest: digest.optional(),
  obligationIds: nonemptyIds,
  summary: z.string().min(1).max(4000),
  verdict: z.enum(['passed', 'failed']),
  findings: z.array(id).max(100),
}).strict();
export const reviewDataSchema = reviewInput;
export const reviewResourceSchema = resourceSchema(reviewDataSchema);

export const readinessSchema = z.object({
  viewId: id,
  ready: z.boolean(),
  sequence: z.number().int().nonnegative().optional(),
  applicability: z.object({ projectId:id, viewId:id, manifestDigest:digest, composedCommitOid:oid, treeOid:oid, contractVersion:version, policyVersion:version, checkSuiteDigest:digest }).strict().nullable().optional(),
  coverage: z.array(z.object({ obligationId:id, changeIds:z.array(id), checkIds:z.array(id), reviewIds:z.array(id) }).strict()).optional(),
  blockers: z.array(z.object({
    code: z.string(),
    resourceId: id.optional(),
    message: z.string(),
    nextOwner: id.optional(),
  }).strict()),
  findingIds: z.array(id),
  reviewIds: z.array(id),
}).strict();
export const findingsListSchema = z.array(findingResourceSchema);

export type FindingInput = z.infer<typeof findingInput>;
export type FindingResource = z.infer<typeof findingResourceSchema>;
export type ReviewInput = z.infer<typeof reviewInput>;
export type ReviewResource = z.infer<typeof reviewResourceSchema>;
export type Readiness = z.infer<typeof readinessSchema>;
