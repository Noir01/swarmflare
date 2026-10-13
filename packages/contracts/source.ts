import { z } from 'zod';
import { id, oid, digest, version, revisionInput, viewInput, changeInput, type PublishedRevision } from './index';

// Local source lifecycle. A local-git receipt is NEVER remote Artifacts evidence.
export const seedInput = z.object({ commitOid: oid, treeOid: oid }).strict();
export const sourceReceiptSchema = z.object({
  backend: z.literal('local-git'), commitOid: oid, treeOid: oid,
  ref: z.string().regex(/^refs\/agent\/(seeds\/[A-Za-z0-9_-]+|revisions\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+|views\/[A-Za-z0-9_-]+)$/),
}).strict();
export const artifactsSourceReceiptSchema = z.object({backend:z.literal('artifacts-git'),commitOid:oid,treeOid:oid,ref:z.string().regex(/^refs\/agent\/(seeds\/[A-Za-z0-9_-]+|revisions\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+|views\/[A-Za-z0-9_-]+)$/)}).strict();
export const durableSourceReceiptSchema=z.discriminatedUnion('backend',[sourceReceiptSchema,artifactsSourceReceiptSchema]);
export const revisionDataSchema = revisionInput.extend({ changeId:id, revisionId:id, owner:id, jobId:id,
  status:z.enum(['reserved','published','failed']), receipt:durableSourceReceiptSchema.nullable(), error:z.string().max(200).nullable() }).strict();
export const changeDataSchema = changeInput.extend({ latestRevisionId:id.nullable(), revisions:z.array(revisionDataSchema).max(100) }).strict();
export const viewDataSchema = z.object({ manifest:viewInput, manifestDigest:digest, jobId:id,
  status:z.enum(['queued','runnable','failed']), receipt:durableSourceReceiptSchema.nullable(), error:z.string().max(200).nullable() }).strict();
export const baselineSchema = z.object({ version, commitOid:oid, treeOid:oid, receipt:durableSourceReceiptSchema }).strict();
const publishedRevisionSchema = revisionInput.extend({ changeId:id, revisionId:id, owner:id }).strict();
export const jobInputSchema = z.discriminatedUnion('kind', [
  z.object({kind:z.literal('seed'), seedId:id, source:seedInput}).strict(),
  z.object({kind:z.literal('publication'), revision:publishedRevisionSchema}).strict(),
  z.object({kind:z.literal('composition'), viewId:id, manifest:viewInput, manifestDigest:digest, revisions:z.array(publishedRevisionSchema).min(1).max(100)}).strict(),
]);
export const jobDataSchema = z.object({ input:jobInputSchema, status:z.enum(['queued','leased','completed','failed']),
  attemptId:id.nullable(), runnerId:id.nullable(), leaseExpiresAt:z.number().int().nonnegative().nullable(),
  receipt:durableSourceReceiptSchema.nullable(), error:z.string().max(200).nullable() }).strict();
export const jobClaimInput = z.object({ leaseSeconds:z.number().int().min(10).max(120) }).strict();
export const jobCompleteInput = z.discriminatedUnion('ok', [
  z.object({attemptId:id,ok:z.literal(true),receipt:sourceReceiptSchema}).strict(),
  z.object({attemptId:id,ok:z.literal(false),error:z.string().min(1).max(200).regex(/^[A-Z0-9_]+$/)}).strict(),
]);
export const jobPublishInput=z.object({attemptId:id,commitOid:oid,treeOid:oid,packBase64:z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/).max(48000),manifestDigest:digest.optional()}).strict();
export const resourceOf = <T extends z.ZodType>(data:T) => z.object({id,version,owner:id,data}).strict();
export const jobResourceSchema=resourceOf(jobDataSchema);
export const revisionResourceSchema=resourceOf(revisionDataSchema);
export const changeResourceSchema=resourceOf(changeDataSchema);
export const viewResourceSchema=resourceOf(viewDataSchema);
export type SourceReceipt=z.infer<typeof sourceReceiptSchema>;
export type ArtifactsSourceReceipt=z.infer<typeof artifactsSourceReceiptSchema>;
export type DurableSourceReceipt=z.infer<typeof durableSourceReceiptSchema>;
export type SourceJob=z.infer<typeof jobResourceSchema>;
export type SourceJobInput=z.infer<typeof jobInputSchema>;
export type RevisionResource=z.infer<typeof revisionResourceSchema>;
export type ChangeResource=z.infer<typeof changeResourceSchema>;
export type ViewResource=z.infer<typeof viewResourceSchema>;
export type JobCompletion=z.infer<typeof jobCompleteInput>;
export type JobPublishInput=z.infer<typeof jobPublishInput>;
// Immutable source refs are derived from server-generated IDs, never caller paths.
export function sourceRef(input:SourceJobInput):string {
  if(input.kind==='seed')return `refs/agent/seeds/${input.seedId}`;
  if(input.kind==='publication')return `refs/agent/revisions/${input.revision.changeId}/${input.revision.revisionId}`;
  return `refs/agent/views/${input.viewId}`;
}
export interface DurableCompositionRequest {
  repository:string; destination:string; baselineOid:string; revisions:PublishedRevision[]; viewId:string;
}
