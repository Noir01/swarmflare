import { z } from 'zod';
export const API_VERSION = 1 as const;
export const id = z.string().min(1).max(120).regex(/^[a-zA-Z0-9_-]+$/);
export const oid = z.string().regex(/^[0-9a-f]{40}$/);
export const digest = z.string().regex(/^[0-9a-f]{64}$/);
export const version = z.number().int().positive();
const ids = z.array(id).min(1).max(100);
export const actorSchema = z.object({id,projectId:id,role:z.enum(['human','contributor','reviewer','runner'])}).strict();
export type Actor = z.infer<typeof actorSchema>;
export const mutation = <T extends z.ZodType>(payload:T) => z.object({requestId:id,expectedVersion:z.number().int().nonnegative().optional(),payload}).strict();
export const obligationSchema = z.object({id,description:z.string().min(1).max(2000),acceptanceExamples:z.array(z.string().max(2000)).max(20)}).strict();
export const contractInput = z.object({outcome:z.string().min(1).max(4000),constraints:z.array(z.string().max(2000)).max(50),obligations:z.array(obligationSchema).min(1).max(100),requiredCheckIds:ids,unresolvedQuestions:z.array(z.string().max(2000)).max(50)}).strict();
export const claimInput = z.object({obligationIds:ids,areas:z.array(z.string().min(1).max(200)).min(1).max(50),status:z.enum(['working','waiting','blocked','ready','done']).default('working')}).strict();
export const claimPatchInput = z.object({status:z.enum(['working','waiting','blocked','ready','done'])}).strict();
export const overlapAckInput = z.object({otherClaimId:id,resolution:z.enum(['coordinate','split','alternatives'])}).strict();
export const decisionInput = z.object({question:z.string().min(1).max(4000),obligationIds:ids,participants:ids,interfaces:z.array(z.string().max(200)).max(50).default([]),material:z.boolean().default(false)}).strict();
export const decisionResponseInput = z.object({body:z.string().min(1).max(4000),acknowledge:z.boolean()}).strict();
export const decisionAgreeInput = z.object({}).strict();
export const revisionRef = z.object({changeId:id,revisionId:id}).strict();
export const decisionRef = z.object({decisionId:id,version}).strict();
export const changeInput = z.object({title:z.string().min(1).max(200),obligationIds:ids}).strict();
const uniqueChanges = (refs: {changeId:string}[]) => new Set(refs.map(ref=>ref.changeId)).size === refs.length;
export const revisionInput = z.object({baseCommitOid:oid,commitOid:oid,treeOid:oid,obligationIds:ids,decisionRevisions:z.array(decisionRef).max(100),dependencies:z.array(revisionRef).max(100).refine(uniqueChanges, 'Only one exact revision per dependency Change')}).strict();
export const viewInput = z.object({baseVersion:version,baseCommitOid:oid,contractVersion:version,policyVersion:version,orderedRevisions:z.array(revisionRef).min(1).max(100).refine(uniqueChanges, 'Only one exact revision per Change'),excludedChangeIds:z.array(id).max(100),decisionRevisions:z.array(decisionRef).max(100),compositionVersion:version}).strict();
export const applicabilitySchema = z.object({projectId:id,viewId:id,manifestDigest:digest,composedCommitOid:oid,treeOid:oid,contractVersion:version,policyVersion:version,checkSuiteDigest:digest}).strict();
export type Applicability = z.infer<typeof applicabilitySchema>;
export type ClaimInput = z.infer<typeof claimInput>;
export type DecisionInput = z.infer<typeof decisionInput>;
export type RevisionInput = z.infer<typeof revisionInput>;
export type ViewInput = z.infer<typeof viewInput>;
export type ContractInput = z.infer<typeof contractInput>;
export interface Resource<T = unknown> { id:string; version:number; owner:string; data:T }
export interface ApiResponse<T = unknown> {apiVersion:1; resource:T; sequence:number; version:number}
export interface ApiError {code:string;message:string;details?:unknown;requestId?:string}
export interface Context {contract:Resource<ContractInput>|null; baseline:{version:number;commitOid:string}|null;claims:Resource<ClaimInput>[];decisions:Resource<DecisionInput & {status:'open'|'agreed'|'needs-human';responses:{actorId:string;body:string;acknowledge:boolean}[]}>[];findings:Resource[];nextCursor:string|null}
export const responseSchema = z.object({apiVersion:z.literal(1),resource:z.unknown(),sequence:z.number().int().nonnegative(),version:z.number().int().nonnegative()}).strict();
export const errorSchema = z.object({code:z.string(),message:z.string(),details:z.unknown().optional(),requestId:z.string().optional()}).strict();
export const contextSchema = z.object({contract:z.unknown().nullable(),baseline:z.object({version,commitOid:oid}).nullable(),claims:z.array(z.unknown()),decisions:z.array(z.unknown()),findings:z.array(z.unknown()),nextCursor:z.string().nullable()}).strict();
// Git port: implementation uses actual local Git; remote qualification is separate.
export interface PublishedRevision extends RevisionInput {changeId:string;revisionId:string;owner:string}
export interface CompositionRequest {repository:string; destination:string; baselineOid:string; revisions:PublishedRevision[]}
export interface CompositionResult {commitOid:string;treeOid:string;orderedRevisions:{changeId:string;revisionId:string}[]}
