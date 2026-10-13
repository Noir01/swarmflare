import { z } from 'zod';
import { applicabilitySchema, id, oid, version } from './index';

export const reviewArtifactInput = z.object({
  applicability: applicabilitySchema,
  baseline: z.object({ version, commitOid: oid, treeOid: oid }).strict(),
  diff: z.object({ patch: z.string().max(16000), files: z.array(z.string().min(1).max(500).refine(p => !/[\x00-\x1f\x7f]/.test(p) && !p.startsWith('/') && !p.split('/').some(s => !s || s === '.' || s === '..' || s.toLowerCase() === '.git') && !p.includes('\\'), 'Unsafe path')).max(100), truncated: z.boolean() }).strict(),
  preview: z.object({ supported: z.literal('project-list-demo-v1'), html: z.string().max(32000), expiresAt: z.number().int().safe() }).strict().nullable(),
}).strict();
export const reviewArtifactResourceSchema = z.object({ id, version, owner: id, data: reviewArtifactInput }).strict();
export type ReviewArtifactInput = z.infer<typeof reviewArtifactInput>;
export type ReviewArtifactResource = z.infer<typeof reviewArtifactResourceSchema>;