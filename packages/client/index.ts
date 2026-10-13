import {
  claimInput, claimPatchInput, contextSchema, decisionAgreeInput, decisionInput,
  decisionResponseInput, errorSchema, mutation, overlapAckInput, responseSchema,
  contractInput, type ApiResponse, type Context,
} from '../contracts/index';
import { z } from 'zod';
import { decisionResolutionInput } from '../contracts/decision';
import { seedInput, jobClaimInput, jobCompleteInput, jobPublishInput, baselineSchema, changeResourceSchema, revisionResourceSchema, viewResourceSchema, jobResourceSchema, type SourceJob, type JobPublishInput, type RevisionResource, type ChangeResource, type ViewResource } from '../contracts/source';
import { id, changeInput, revisionInput, viewInput } from '../contracts/index';
import { findingsListSchema, findingResourceSchema, findingInput, findingOwnerCorrectionInput, repairInput, resolveInput, reviewInput, reviewResourceSchema, readinessSchema, type FindingResource, type ReviewResource, type Readiness } from '../contracts/feedback';
import { checkReceiptSchema, checkResourceSchema, checksListSchema, type CheckResource } from '../contracts/evidence';
import { policyResourceSchema, policyInput, confirmationResourceSchema, confirmationInput, acceptanceResourceSchema, acceptanceInput, sourceVerificationResourceSchema, sourceVerificationInput, type PolicyResource, type AcceptanceResource, type ConfirmationResource, type SourceVerificationResource } from '../contracts/acceptance';
import { reviewArtifactInput, reviewArtifactResourceSchema, type ReviewArtifactInput, type ReviewArtifactResource } from '../contracts/review-artifact';

export interface WorkspaceClientOptions {
  baseUrl: string; projectId: string; token: string; fetch?: typeof fetch;
  maxRequests?: number; deadline?: number; sleep?: (milliseconds: number) => Promise<void>;
}
export interface MutationEnvelope<T=unknown> { requestId: string; expectedVersion?: number; payload: T }
const requestIdSchema = z.string().min(1).max(120).regex(/^[a-zA-Z0-9_-]+$/);
const eventQuery = z.object({cursor:z.string().max(500).optional(),limit:z.number().int().min(1).max(100).optional()}).strict();
const genericMutation = mutation(z.unknown());
const proposal = mutation(contractInput), claim = mutation(claimInput), claimPatch = mutation(claimPatchInput), overlap = mutation(overlapAckInput), decision = mutation(decisionInput), response = mutation(decisionResponseInput), agree = mutation(decisionAgreeInput);
const MAX_BODY = 64 * 1024;
const policyMutation = mutation(policyInput);
const confirmationMutation = mutation(confirmationInput);
const acceptanceMutation = mutation(acceptanceInput);
const sourceVerificationMutation = mutation(sourceVerificationInput);
const decisionResolutionMutation = mutation(decisionResolutionInput);
const delay = (ms:number) => new Promise<void>(resolve => setTimeout(resolve,ms));

export class WorkspaceClient {
  readonly projectId: string;
  private readonly root: string; private readonly auth: string; private readonly fetcher: typeof fetch;
  private readonly maxRequests: number; private readonly expiresAt: number; private readonly sleep: (ms:number)=>Promise<void>;
  private requests = 0; private contextEtag?: string; private contextCache?: Context;
  constructor(options: WorkspaceClientOptions) {
    if (!options.baseUrl || !options.projectId || !options.token) throw new TypeError('baseUrl, projectId and token are required');
    if (!Number.isInteger(options.maxRequests ?? 100) || (options.maxRequests ?? 100) < 1 || (options.maxRequests ?? 100) > 1000) throw new RangeError('maxRequests must be between 1 and 1000');
    if (options.deadline !== undefined && (!Number.isFinite(options.deadline) || options.deadline <= 0)) throw new RangeError('deadline must be a positive duration in milliseconds');
    const base = new URL(options.baseUrl); if (!['http:','https:'].includes(base.protocol)) throw new TypeError('baseUrl must use HTTP(S)');
    if (base.username || base.password || /^(?:https?):\/\/[^/?#]*@/i.test(options.baseUrl) || /[?#]/.test(options.baseUrl)) throw new TypeError('baseUrl must not contain userinfo, query, or fragment');
    if (!/^[A-Za-z0-9_-]{1,120}$/.test(options.projectId)) throw new TypeError('projectId must be a valid project id');
    this.projectId = options.projectId;
    this.root = `${base.toString().replace(/\/$/,'')}/api/v1/projects/${encodeURIComponent(options.projectId)}`;
    this.auth = `Bearer ${options.token}`; this.fetcher = options.fetch ?? fetch;
    this.maxRequests = options.maxRequests ?? 100; this.expiresAt = Date.now() + (options.deadline ?? 30_000); this.sleep = options.sleep ?? delay;
  }
  async context(): Promise<Context> {
    const headers: Record<string,string> = {}; if(this.contextEtag) headers['If-None-Match'] = this.contextEtag;
    const result = await this.request<Context>('GET','/context',undefined,undefined,contextSchema as z.ZodType<Context>,headers);
    if(result.notModified && this.contextCache) return this.contextCache;
    this.contextCache = result.resource; return result.resource;
  }
  async initializeBaseline(input:MutationEnvelope):Promise<SourceJob> { return this.sendMutation('POST','/baseline/initialize',input,mutation(seedInput),jobResourceSchema); }
  async baseline():Promise<z.infer<typeof baselineSchema>|null> { return (await this.request('GET','/baseline',undefined,undefined,baselineSchema.nullable())).resource; }
  async createChange(input:MutationEnvelope):Promise<ChangeResource> { return this.sendMutation('POST','/changes',input,mutation(changeInput),changeResourceSchema); }
  async change(changeId:string):Promise<ChangeResource> { return (await this.request('GET',`/changes/${id.parse(changeId)}`,undefined,undefined,changeResourceSchema)).resource; }
  async publishRevision(changeId:string,input:MutationEnvelope):Promise<RevisionResource> { return this.sendMutation('POST',`/changes/${id.parse(changeId)}/revisions`,input,mutation(revisionInput),revisionResourceSchema); }
  async revision(revisionId:string):Promise<RevisionResource> { return (await this.request('GET',`/revisions/${id.parse(revisionId)}`,undefined,undefined,revisionResourceSchema)).resource; }
  async createView(input:MutationEnvelope):Promise<ViewResource> { return this.sendMutation('POST','/views',input,mutation(viewInput),viewResourceSchema); }
  async view(viewId:string):Promise<ViewResource> { return (await this.request('GET',`/views/${id.parse(viewId)}`,undefined,undefined,viewResourceSchema)).resource; }
  async views(limit=50):Promise<ViewResource[]> { if(!Number.isInteger(limit)||limit<1||limit>100)throw new RangeError('limit must be between 1 and 100'); return (await this.request('GET',`/views?limit=${limit}`,undefined,undefined,z.array(viewResourceSchema))).resource; }
  async reviewArtifact(viewId:string):Promise<ReviewArtifactResource|null> { return (await this.request('GET',`/views/${id.parse(viewId)}/review-artifact`,undefined,undefined,reviewArtifactResourceSchema.nullable())).resource; }
  async recordReviewArtifact(viewId:string,input:MutationEnvelope<ReviewArtifactInput>):Promise<ReviewArtifactResource> { const p=mutation(reviewArtifactInput).parse(input);if(p.payload.applicability.viewId!==id.parse(viewId))throw new TypeError('review artifact viewId must match path');return this.sendMutation('POST',`/runner/views/${id.parse(viewId)}/review-artifacts`,input,mutation(reviewArtifactInput),reviewArtifactResourceSchema); }
  async findings():Promise<FindingResource[]> { return (await this.request('GET','/findings',undefined,undefined,findingsListSchema)).resource; }
  async finding(findingId:string):Promise<FindingResource> { return (await this.request('GET',`/findings/${id.parse(findingId)}`,undefined,undefined,findingResourceSchema)).resource; }
  async createFinding(input:MutationEnvelope):Promise<FindingResource> { return this.sendMutation('POST','/findings',input,mutation(findingInput),findingResourceSchema); }
  async assignFindingOwner(findingId:string,input:MutationEnvelope):Promise<FindingResource> { if(input.expectedVersion===undefined)throw new TypeError('expectedVersion is required for owner correction');return this.sendMutation('POST',`/findings/${id.parse(findingId)}/owner`,input,mutation(findingOwnerCorrectionInput),findingResourceSchema); }
  async proposeRepair(findingId:string,input:MutationEnvelope):Promise<FindingResource> { return this.sendMutation('POST',`/findings/${id.parse(findingId)}/repair`,input,mutation(repairInput),findingResourceSchema); }
  async resolveFinding(findingId:string,input:MutationEnvelope):Promise<FindingResource> { return this.sendMutation('POST',`/findings/${id.parse(findingId)}/resolve`,input,mutation(resolveInput),findingResourceSchema); }
  async reviewView(viewId:string,input:MutationEnvelope):Promise<ReviewResource> { const p=mutation(reviewInput).parse(input); if(p.payload.viewId!==id.parse(viewId)) throw new TypeError('review viewId must match path'); return this.sendMutation('POST',`/views/${id.parse(viewId)}/reviews`,input,mutation(reviewInput),reviewResourceSchema); }
  async reviews(viewId:string):Promise<ReviewResource[]> { return (await this.request('GET',`/views/${id.parse(viewId)}/reviews`,undefined,undefined,z.array(reviewResourceSchema))).resource; }
  async readiness(viewId:string):Promise<Readiness> { return (await this.request('GET',`/views/${id.parse(viewId)}/readiness`,undefined,undefined,readinessSchema)).resource; }
  async decision(decisionId:string):Promise<unknown> { return (await this.request('GET',`/decisions/${id.parse(decisionId)}`,undefined,undefined,z.unknown())).resource; }
  async resolveDecision(decisionId:string,input:MutationEnvelope):Promise<unknown> { return this.sendMutation('POST',`/decisions/${id.parse(decisionId)}/resolve`,input,decisionResolutionMutation); }
  async recordCheck(viewId:string,input:MutationEnvelope):Promise<CheckResource> { const p=mutation(checkReceiptSchema).parse(input); if(p.payload.applicability.viewId!==id.parse(viewId)) throw new TypeError('check viewId must match path'); return this.sendMutation('POST',`/runner/views/${id.parse(viewId)}/checks`,input,mutation(checkReceiptSchema),checkResourceSchema); }
  async checks(viewId:string):Promise<CheckResource[]> { return (await this.request('GET',`/views/${id.parse(viewId)}/checks`,undefined,undefined,checksListSchema)).resource; }
  async policy():Promise<PolicyResource|null> { return (await this.request('GET','/policy',undefined,undefined,policyResourceSchema.nullable())).resource; }
  async configurePolicy(input:MutationEnvelope):Promise<PolicyResource> { return this.sendMutation('POST','/policy',input,policyMutation,policyResourceSchema); }
  async confirmView(viewId:string,input:MutationEnvelope):Promise<ConfirmationResource> { return this.sendMutation('POST',`/views/${id.parse(viewId)}/confirmations`,input,confirmationMutation,confirmationResourceSchema); }
  async acceptView(input:MutationEnvelope):Promise<AcceptanceResource> { return this.sendMutation('POST','/acceptances',input,acceptanceMutation,acceptanceResourceSchema); }
  async acceptance(acceptanceId:string):Promise<AcceptanceResource> { return (await this.request('GET',`/acceptances/${id.parse(acceptanceId)}`,undefined,undefined,acceptanceResourceSchema)).resource; }
  async recordSourceVerification(viewId:string,input:MutationEnvelope):Promise<SourceVerificationResource> { const p=sourceVerificationMutation.parse(input); if(p.payload.receipt.ref!==`refs/agent/views/${id.parse(viewId)}`) throw new TypeError('source verification ref must match view ID'); return this.sendMutation('POST',`/runner/views/${id.parse(viewId)}/source-verifications`,input,sourceVerificationMutation,sourceVerificationResourceSchema); }
  async sourceVerification(viewId:string):Promise<SourceVerificationResource|null> { return (await this.request('GET',`/views/${id.parse(viewId)}/source-verification`,undefined,undefined,sourceVerificationResourceSchema.nullable())).resource; }
  async viewUpdates(viewId:string):Promise<unknown> { const schema=z.object({viewId:id,baselineChanged:z.boolean(),contractChanged:z.boolean(),revisions:z.array(z.object({changeId:id,pinnedRevisionId:id,latestRevisionId:id.nullable()}).strict())}).strict(); return (await this.request('GET',`/views/${id.parse(viewId)}/updates`,undefined,undefined,schema)).resource; }
  async claimSourceJob(input:MutationEnvelope):Promise<SourceJob|null> { return this.sendMutation('POST','/runner/claim',input,mutation(jobClaimInput),jobResourceSchema.nullable()); }
  async completeSourceJob(jobId:string,input:MutationEnvelope):Promise<SourceJob> { return this.sendMutation('POST',`/runner/jobs/${id.parse(jobId)}/complete`,input,mutation(jobCompleteInput),jobResourceSchema); }
  async publishArtifactsSourceJob(jobId:string,input:MutationEnvelope<JobPublishInput>):Promise<SourceJob> { return this.sendMutation('POST',`/runner/jobs/${id.parse(jobId)}/publish-artifacts`,input,mutation(jobPublishInput),jobResourceSchema); }
  async sourceJob(jobId:string):Promise<SourceJob> { return (await this.request('GET',`/runner/jobs/${id.parse(jobId)}`,undefined,undefined,jobResourceSchema)).resource; }
  async events(options: {cursor?:string;limit?:number} = {}): Promise<unknown> {
    const q = eventQuery.parse(options); const params = new URLSearchParams(); if(q.cursor!==undefined) params.set('cursor',q.cursor); if(q.limit!==undefined) params.set('limit',String(q.limit));
    return (await this.request('GET',`/events${params.size?'?'+params:''}`,undefined,undefined,z.unknown())).resource;
  }
  async *eventPages(options: {cursor?:string;limit?:number;maxPages?:number} = {}): AsyncGenerator<unknown> {
    const maxPages=options.maxPages??10; if(!Number.isInteger(maxPages)||maxPages<1||maxPages>100) throw new RangeError('maxPages must be between 1 and 100');
    let cursor=options.cursor; const seen=new Set<string>(); if(cursor!==undefined) seen.add(cursor);
    for(let page=0;page<maxPages;page++) {
      const result= z.object({events:z.array(z.unknown()),nextCursor:z.string().nullable()}).strict().parse(await this.events({cursor,limit:options.limit}));
      yield result.events; if(result.nextCursor===null) return;
      if(seen.has(result.nextCursor)) throw new Error('event pagination cursor cycle detected');
      seen.add(result.nextCursor); cursor=result.nextCursor;
    }
    throw new Error('event pagination page limit exceeded');
  }
  async contract(version:number): Promise<unknown> { if(!Number.isInteger(version)||version<1) throw new TypeError('version must be positive'); return (await this.request('GET',`/contracts/${version}`,undefined,undefined,z.unknown())).resource; }
  async createProposal(input: MutationEnvelope): Promise<unknown> { return this.sendMutation('POST','/contracts/proposals',input,proposal); }
  async createClaim(input: MutationEnvelope): Promise<unknown> { return this.sendMutation('POST','/claims',input,claim); }
  async updateClaim(id:string,input: MutationEnvelope): Promise<unknown> { return this.sendMutation('PATCH',`/claims/${encodeURIComponent(id)}`,input,claimPatch); }
  async acknowledgeOverlap(id:string,input: MutationEnvelope): Promise<unknown> { return this.sendMutation('POST',`/claims/${encodeURIComponent(id)}/overlap-ack`,input,overlap); }
  async createDecision(input: MutationEnvelope): Promise<unknown> { return this.sendMutation('POST','/decisions',input,decision); }
  async respondDecision(id:string,input: MutationEnvelope): Promise<unknown> { return this.sendMutation('POST',`/decisions/${encodeURIComponent(id)}/responses`,input,response); }
  async agreeDecision(id:string,input: MutationEnvelope): Promise<unknown> { return this.sendMutation('POST',`/decisions/${encodeURIComponent(id)}/agree`,input,agree); }
  /** Human-only route. The coordinator must provide a genuinely human credential; this client never creates or simulates one. */
  async approveProposal(id:string,input: MutationEnvelope): Promise<unknown> { return this.sendMutation('POST',`/contracts/${encodeURIComponent(id)}/approve`,{...input,expectedVersion:input.expectedVersion??0},mutation(z.object({}).strict())); }
  async get(path:string): Promise<unknown> { this.assertReadPath(path); return (await this.request('GET',path,undefined,undefined,z.unknown())).resource; }
  async mutate(method:'POST'|'PATCH',path:string,input:MutationEnvelope): Promise<unknown> { this.assertMutationPath(method,path); return this.sendMutation(method,path,input,genericMutation); }
  private async sendMutation<T>(method:'POST'|'PATCH',path:string,input:MutationEnvelope<T>, schema:z.ZodTypeAny, output:z.ZodTypeAny=z.unknown()): Promise<any> {
    this.assertMutationPath(method,path);
    const parsed = schema.parse(input) as {requestId:string;payload:unknown;expectedVersion?:number}; requestIdSchema.parse(parsed.requestId);
    const encoded=JSON.stringify(parsed); if(new TextEncoder().encode(encoded).byteLength>MAX_BODY) throw new Error('request body exceeds 64 KiB limit');
    return (await this.request(method,path,parsed,parsed.requestId,output)).resource;
  }
  private assertReadPath(path:string):void {
    if(!path.startsWith('/')||path.startsWith('//')) throw new TypeError('path must be a relative API path');
    if(!(/^\/(context|events|findings|baseline|policy)$/.test(path)||path==='/views'||/^\/decisions\/[A-Za-z0-9_-]+$/.test(path)||/^\/acceptances\/[A-Za-z0-9_-]+$/.test(path)||/^\/findings\/[A-Za-z0-9_-]+$/.test(path)||/^\/contracts\/[1-9][0-9]*$/.test(path)||/^\/(changes|views|revisions)\/[A-Za-z0-9_-]+$/.test(path)||/^\/views\/[A-Za-z0-9_-]+\/(updates|readiness|reviews|checks|source-verification|review-artifact)$/.test(path)||/^\/runner\/jobs\/[A-Za-z0-9_-]+$/.test(path))) throw new TypeError('unsupported frozen API read route');
  }
  private assertMutationPath(method:string,path:string):void {
    const allowed=(method==='POST'&&(/^\/policy$/.test(path)||/^\/acceptances$/.test(path)||/^\/views\/[A-Za-z0-9_-]+\/confirmations$/.test(path)||/^\/runner\/views\/[A-Za-z0-9_-]+\/(source-verifications|review-artifacts)$/.test(path)||/^\/baseline\/initialize$/.test(path)||/^\/runner\/claim$/.test(path)||/^\/runner\/jobs\/[A-Za-z0-9_-]+\/(complete|publish-artifacts)$/.test(path)||/^\/runner\/views\/[A-Za-z0-9_-]+\/checks$/.test(path)||/^\/contracts\/proposals$/.test(path)||/^\/contracts\/[A-Za-z0-9_-]+\/approve$/.test(path)||/^\/claims$/.test(path)||/^\/claims\/[A-Za-z0-9_-]+\/overlap-ack$/.test(path)||/^\/decisions$/.test(path)||/^\/decisions\/[A-Za-z0-9_-]+\/(responses|agree|resolve)$/.test(path)||/^\/changes$/.test(path)||/^\/changes\/[A-Za-z0-9_-]+\/revisions$/.test(path)||path==='/views'||/^\/findings$/.test(path)||/^\/findings\/[A-Za-z0-9_-]+\/(owner|repair|resolve)$/.test(path)||/^\/views\/[A-Za-z0-9_-]+\/reviews$/.test(path)))||(method==='PATCH'&&/^\/claims\/[A-Za-z0-9_-]+$/.test(path));
    if(!allowed) throw new TypeError('unsupported frozen API mutation route');
  }
  private async request<T>(method:string,path:string,body:unknown,requestId:string|undefined,resourceSchema:z.ZodType<T>,extraHeaders:Record<string,string> = {}):Promise<{resource:T;notModified:boolean}> {
    let attempt=0;
    for (;;) {
      if(Date.now()>=this.expiresAt) throw new Error('request deadline exceeded');
      if(this.requests>=this.maxRequests) throw new Error('request limit exceeded');
      this.requests++; attempt++;
      const remaining=this.expiresAt-Date.now(); const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),remaining);
      const headers:Record<string,string>={Authorization:this.auth,Accept:'application/json',...extraHeaders};
      if(body!==undefined) headers['Content-Type']='application/json';
      let res:Response;
      try { res=await this.fetcher(this.root+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:controller.signal,redirect:'error'}); }
      catch(e) { clearTimeout(timer); if(method==='GET'&&attempt<3&&Date.now()+5000<this.expiresAt) {await this.sleep(5000); continue;} throw e; }
      if(method==='GET' && (res.status===429||res.status>=500) && attempt<3 && Date.now()+5000<this.expiresAt) {
        try { await res.body?.cancel(); } finally { clearTimeout(timer); }
        await this.sleep(5000); continue;
      }
      if(res.status===304) { clearTimeout(timer); if(path==='/context' && this.contextCache) return {resource:undefined as T,notModified:true}; throw new Error('unexpected HTTP 304 response'); }
      let text='';
      try {
        const rawLength=res.headers.get('content-length'); const length=rawLength===null?0:Number(rawLength);
        if(rawLength!==null && (!Number.isSafeInteger(length)||length<0)) throw new Error('invalid response content-length');
        if(length>MAX_BODY) { await res.body?.cancel(); throw new Error('response body exceeds 64 KiB limit'); }
        const reader=res.body?.getReader(); if(reader) { const chunks:Uint8Array[]=[]; let bytes=0; for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>MAX_BODY){await reader.cancel();throw new Error('response body exceeds 64 KiB limit');}chunks.push(value);} const merged=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){merged.set(chunk,offset);offset+=chunk.byteLength;}text=new TextDecoder().decode(merged); }
      } finally { clearTimeout(timer); }
      let data:unknown; try { data=JSON.parse(text); } catch { throw new Error('server returned invalid JSON'); }
      if(!res.ok) { const parsed=errorSchema.safeParse(data); if(parsed.success) { const err=new Error(`${parsed.data.code}: ${parsed.data.message}`); Object.assign(err,{status:res.status,code:parsed.data.code,requestId:parsed.data.requestId}); throw err; } throw new Error(`HTTP ${res.status} with invalid error response`); }
      const envelope=responseSchema.parse(data) as ApiResponse;
      const resource=resourceSchema.parse(envelope.resource);
      if(path==='/context'&&res.headers.get('etag')) this.contextEtag=res.headers.get('etag')!;
      return {resource,notModified:false};
    }
  }
}
