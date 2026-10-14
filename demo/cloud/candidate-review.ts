import { z } from 'zod';
import { demoPolicyManifest } from '../../apps/worker/src/generated/demo-policy.js';
import { id, oid, version } from '../../packages/contracts/index.js';
import { reviewInput, reviewResourceSchema, findingResourceSchema, readinessSchema } from '../../packages/contracts/feedback.js';
import { WorkspaceClient } from '../../packages/client/index.js';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSourceReceipt } from '../../packages/git-runner/index.js';
import { ORIGIN } from './foundation-smoke.js';
import { PROJECT_ID } from './native-checkout.js';

const obligations: string[] = demoPolicyManifest.contract.obligations.map((item) => item.id);
const candidateSchema = z.object({
  projectId: id, viewId: id, policyVersion: version,
  view: z.object({ commitOid: oid, treeOid: oid, ref: z.string().min(1) }).strict(),
  findingIds: z.array(id).min(1).max(100),
}).strict();
const reviewSchema = z.object({
  viewId: id, commitOid: oid, treeOid: oid, policyVersion: version,
  verdict: z.enum(['passed', 'failed']), findings: z.array(z.unknown()),
  checkedObligations: z.array(id), summary: z.string().min(1).max(4000),
}).strict();
export type IndependentCandidate = z.infer<typeof candidateSchema>;
export type IndependentReview = z.infer<typeof reviewSchema>;

export function validateIndependentReview(candidate: unknown, review: unknown): { candidate: IndependentCandidate; review: IndependentReview } {
  const c = candidateSchema.parse(candidate), r = reviewSchema.parse(review);
  if (r.viewId !== c.viewId || r.commitOid !== c.view.commitOid || r.treeOid !== c.view.treeOid || r.policyVersion !== c.policyVersion) throw new Error('REVIEW_ANCHOR_MISMATCH');
  if (c.view.ref !== `refs/agent/views/${c.viewId}` || new Set(c.findingIds).size !== c.findingIds.length) throw new Error('CANDIDATE_SCOPE_MISMATCH');
  if (r.verdict !== 'passed' || r.findings.length !== 0) throw new Error('REVIEW_NOT_PASSING');
  if (new Set(r.checkedObligations).size !== r.checkedObligations.length || r.checkedObligations.length !== obligations.length || obligations.some((item) => !r.checkedObligations.includes(item))) throw new Error('REVIEW_OBLIGATIONS_INCOMPLETE');
  return { candidate: c, review: r };
}

export interface IndependentReviewPorts {
  client: WorkspaceClient;
  reviewerActorId: string;
  requestKey: (key: string) => Promise<string>;
  readLocalSource: (ref: string) => Promise<{ commitOid: string; treeOid: string }>;
  preserveViewIds?: string[];
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
};

/** Persists a trusted operator review through a separately provisioned reviewer client. */
export async function recordIndependentReview(ports: IndependentReviewPorts, candidateInput: unknown, reviewInputValue: unknown) {
  const { candidate, review } = validateIndependentReview(candidateInput, reviewInputValue);
  const client = ports.client;
  if (client.projectId !== candidate.projectId || !id.safeParse(ports.reviewerActorId).success) throw new Error('REVIEWER_SCOPE_MISMATCH');
  const [view, policy, baseline, checks, priorReviews, context, findings, originalViews] = await Promise.all([
    client.view(candidate.viewId), client.policy(), client.baseline(), client.checks(candidate.viewId), client.reviews(candidate.viewId),
    client.context(), Promise.all(candidate.findingIds.map((findingId) => client.finding(findingId))),
    ports.preserveViewIds ? Promise.all(ports.preserveViewIds.map((viewId) => client.view(viewId))) : Promise.resolve([]),
  ]);
  if (!view.data.receipt || view.data.receipt.commitOid !== candidate.view.commitOid || view.data.receipt.treeOid !== candidate.view.treeOid || view.data.receipt.ref !== candidate.view.ref || view.data.manifest.policyVersion !== candidate.policyVersion) throw new Error('VIEW_CHANGED');
  const local = await ports.readLocalSource(candidate.view.ref);
  if (local.commitOid !== candidate.view.commitOid || local.treeOid !== candidate.view.treeOid) throw new Error('LOCAL_SOURCE_MISMATCH');
  const expectedPolicy = { contractVersion: view.data.manifest.contractVersion, ...demoPolicyManifest.policyTemplate };
  if (!policy || policy.version !== candidate.policyVersion || canonical(policy.data) !== canonical(expectedPolicy) || policy.data.checkSuiteDigest !== demoPolicyManifest.policyTemplate.checkSuiteDigest) throw new Error('POLICY_MISMATCH');
  if (!baseline || baseline.version !== context.baseline?.version || baseline.commitOid !== context.baseline?.commitOid || baseline.receipt.backend !== 'artifacts-git') throw new Error('BASELINE_MISMATCH');
  if (baseline.version !== view.data.manifest.baseVersion || baseline.commitOid !== view.data.manifest.baseCommitOid) throw new Error('BASELINE_MISMATCH');
  if (!context.contract || context.contract.version !== view.data.manifest.contractVersion || canonical(context.contract.data) !== canonical(demoPolicyManifest.contract)) throw new Error('CONTRACT_MISMATCH');
  const authors = new Set((await Promise.all(view.data.manifest.orderedRevisions.map((revision) => client.change(revision.changeId)))).map((change) => change.owner));
  if (authors.has(ports.reviewerActorId)) throw new Error('REVIEWER_AUTHORITY_MISMATCH');
  const app = { projectId: candidate.projectId, viewId: view.id, manifestDigest: view.data.manifestDigest, composedCommitOid: candidate.view.commitOid, treeOid: candidate.view.treeOid, contractVersion: view.data.manifest.contractVersion, policyVersion: candidate.policyVersion, checkSuiteDigest: policy.data.checkSuiteDigest };
  // Findings cite the failed ORIGINAL source; resolutions cite this replacement.
  const findingViews = await Promise.all(findings.map(finding => client.view(finding.data.viewId)));
  for (let i=0;i<findings.length;i++) {
    const finding=findings[i]!, original=findingViews[i]!;
    if(finding.id!==candidate.findingIds[i] || original.data.receipt?.commitOid!==finding.data.composedCommitOid || original.data.receipt?.treeOid!==finding.data.treeOid || original.data.manifestDigest!==finding.data.manifestDigest || original.data.manifest.contractVersion!==finding.data.contractVersion || original.data.manifest.policyVersion!==finding.data.policyVersion || !finding.data.obligationIds.every(id=>obligations.includes(id))) throw new Error('FINDING_SCOPE_MISMATCH');
    const latest = new Map(finding.data.repairs.map(ref=>[ref.changeId,ref.revisionId]));
    if(!latest.size || [...latest].some(([changeId,revisionId])=>!view.data.manifest.orderedRevisions.some(ref=>ref.changeId===changeId&&ref.revisionId===revisionId))) throw new Error('LINKED_REPAIR_MISMATCH');
  }
  const approved = obligations;
  const allowedChecks = new Map<string, readonly string[]>(demoPolicyManifest.policyTemplate.checks.map((check) => [check.id, check.obligationIds]));
  if (checks.some((check) => check.data.applicability.viewId === view.id && check.data.applicability.composedCommitOid === candidate.view.commitOid && check.data.result === 'failed')) throw new Error('APPLICABLE_CHECK_FAILED');
  const passedChecks = checks.filter((check) => check.data.result === 'passed' && canonical(check.data.applicability) === canonical(app) && allowedChecks.has(check.data.checkId) && check.data.harnessVersion === 'json-oracle-v1' && canonical(check.data.obligationIds) === canonical(allowedChecks.get(check.data.checkId)));
  if (new Set(passedChecks.map((check) => check.data.checkId)).size !== allowedChecks.size || [...allowedChecks.keys()].some((id) => !passedChecks.some((check) => check.data.checkId === id))) throw new Error('APPLICABLE_CHECKS_INCOMPLETE');
  const anchor = { viewId: view.id, manifestDigest: view.data.manifestDigest, composedCommitOid: candidate.view.commitOid, treeOid: candidate.view.treeOid, contractVersion: view.data.manifest.contractVersion, policyVersion: candidate.policyVersion, checkSuiteDigest: policy.data.checkSuiteDigest };
  const expectedReview = reviewInput.parse({ ...anchor, obligationIds: approved, summary: `Actual independent Luna exact-source review: ${review.summary}`, verdict: 'passed', findings: [] });
  let recorded = priorReviews.find((item) => item.owner === ports.reviewerActorId && canonical(item.data) === canonical(expectedReview));
  if (!recorded) recorded = await client.reviewView(view.id, { requestId: await ports.requestKey('independent-review'), payload: expectedReview });
  const reviewReadback = (await client.reviews(view.id)).find((item) => item.id === recorded!.id);
  if (!reviewReadback || !same(reviewReadback, recorded) || reviewReadback.owner !== ports.reviewerActorId || canonical(reviewReadback.data) !== canonical(expectedReview)) throw new Error('REVIEW_READBACK_MISMATCH');
  for (const findingId of candidate.findingIds) {
    let finding = await client.finding(findingId);
    if (finding.data.status === 'resolved' && canonical(finding.data.resolutionEvidence?.applicability) === canonical(app)) continue;
    const resolved = await client.resolveFinding(findingId, { requestId: await ports.requestKey(`resolve-${findingId}-v${finding.version}`), expectedVersion: finding.version, payload: { viewId: view.id, note: 'Independent exact-source review passed with all required applicable checks.' } });
    finding = findingResourceSchema.parse(await client.finding(findingId));
    if (!same(finding, resolved) || finding.data.status !== 'resolved' || canonical(finding.data.resolutionEvidence?.applicability) !== canonical(app)) throw new Error('FINDING_READBACK_MISMATCH');
  }
  const readiness = readinessSchema.parse(await client.readiness(view.id));
  if (!readiness.ready) throw new Error('NATIVE_READINESS_FALSE');
  if (!same(await client.baseline(), baseline)) throw new Error('BASELINE_CHANGED');
  for(let i=0;i<findingViews.length;i++) if(!same(await client.view(findingViews[i]!.id),findingViews[i]))throw new Error('ORIGINAL_VIEW_CHANGED');
  if (ports.preserveViewIds) for (let i=0;i<ports.preserveViewIds.length;i++) if (!same(await client.view(ports.preserveViewIds[i]), originalViews[i])) throw new Error('ORIGINAL_VIEW_CHANGED');
  return { review: reviewResourceSchema.parse(reviewReadback), findings: await Promise.all(candidate.findingIds.map(id=>client.finding(id))), readiness, baselineUnchanged: true, originalViewsUnchanged: true };
}

// Explicit operator-only synthetic fixture. No account login or human credential.
export async function runNativeIndependentReview() {
  const secret = async(path:string)=>{const s=await lstat(path);if(s.isSymbolicLink()||!s.isFile()||(s.mode&0o077)!==0)throw Error('PRIVATE_PERMISSIONS');return JSON.parse(await readFile(path,'utf8'));};
  const receipt=JSON.parse(await readFile('reports/evaluation/continuous49-native-cursor.json','utf8'));
  const modelReview=JSON.parse(await readFile('reports/workers/continuous49-independent-review-result.json','utf8'));
  if(receipt.projectId!==PROJECT_ID)throw Error('PROJECT_SCOPE_MISMATCH');
  const candidate={projectId:receipt.projectId,viewId:receipt.viewId,policyVersion:receipt.policyVersion,view:{commitOid:receipt.view?.commitOid,treeOid:receipt.view?.treeOid,ref:receipt.view?.ref},findingIds:receipt.findingIds};
  const review={viewId:modelReview.viewId,commitOid:modelReview.commitOid,treeOid:modelReview.treeOid,policyVersion:modelReview.policyVersion,verdict:modelReview.verdict,findings:modelReview.findings,checkedObligations:modelReview.checkedObligations,summary:modelReview.summary};
  validateIndependentReview(candidate,review);
  const feedback=await secret('.local/cloud-cont47/feedback-private.json'),grant=feedback.reviewer;
  if(!grant||!Number.isSafeInteger(grant.expiresAt)||grant.expiresAt<=Date.now()||!id.safeParse(grant.id).success||! /^[a-f0-9]{64}$/.test(grant.token))throw Error('REVIEWER_GRANT_INVALID');
  const root=resolve('.local/cloud-cont50');await mkdir(root,{recursive:true,mode:0o700});const dir=await lstat(root);if(dir.isSymbolicLink()||!dir.isDirectory()||(dir.mode&0o077)!==0)throw Error('PRIVATE_PERMISSIONS');
  const file=resolve(root,'review-private.json');let state:any;try{state=await secret(file);}catch(e:any){if(e.code!=='ENOENT')throw e;state={projectId:PROJECT_ID,ids:{}};await writeFile(file,JSON.stringify(state),{mode:0o600,flag:'wx'});}if(state.projectId!==PROJECT_ID||!state.ids)throw Error('STATE_SCOPE');
  const requestKey=async(name:string)=>{state.ids[name]??=randomUUID();await writeFile(file,JSON.stringify(state),{mode:0o600});return state.ids[name];};
  const calls:any[]=[];let count=0;const deadline=Date.now()+90000;
  const fetcher:typeof fetch=async(u,init)=>{const url=new URL(String(u));if(url.origin!==ORIGIN||++count>40||Date.now()>deadline)throw Error('REQUEST_BUDGET');const r=await fetch(u,{...init,redirect:'error',signal:AbortSignal.timeout(10000)});calls.push({path:url.pathname,method:init?.method??'GET',status:r.status});return r;};
  const response=await fetcher(ORIGIN+'/api/platform/agent/session',{headers:{authorization:'Bearer '+grant.token}});if(!response.ok)throw Error('REVIEWER_SESSION_INVALID');const session=await response.json() as any;
  if(session.actor?.id!==grant.id||session.actor.projectId!==PROJECT_ID||session.actor.role!=='reviewer'||session.repository?.id!==PROJECT_ID||! /^smoke-[a-f0-9]{20}$/.test(session.repository.owner)||! /^probe-[a-f0-9]{10}$/.test(session.repository.name))throw Error('REVIEWER_SCOPE_MISMATCH');
  const client=new WorkspaceClient({baseUrl:ORIGIN,projectId:PROJECT_ID,token:grant.token,fetch:fetcher,maxRequests:40,deadline:90000});
  const result=await recordIndependentReview({client,reviewerActorId:grant.id,requestKey,readLocalSource:ref=>readSourceReceipt('.local/cloud-cont47/cache.git',ref),preserveViewIds:['b44d6d61-b502-40b2-b254-17e1669edc5f','5a4896b9-24b0-4fe2-9b91-d1d036f4975b','05483124-a4d1-4096-8b4c-05e05962f218']},candidate,review);
  await writeFile('reports/evaluation/continuous50-native-review-resolution.json',JSON.stringify({provenance:'Actual native reviewer resume, supplied independent model source verdict and current evidence validated, exact mutation readbacks; no human decision. Model provenance is operator-supplied, not server attestation.',...result,calls,acceptancePerformed:false},null,2));
  return{viewId:result.readiness.viewId,reviewId:result.review.id,ready:result.readiness.ready,resourceWrites:calls.filter(x=>x.method!=='GET').length,baselineUnchanged:true,acceptancePerformed:false};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))runNativeIndependentReview().then(x=>console.log(JSON.stringify(x))).catch(e=>{console.error(JSON.stringify({code:typeof e.message==='string'&&/^[A-Z_]{1,64}$/.test(e.message)?e.message:'REVIEW_FAILED',status:e.status??e.statusCode,apiCode:typeof e.code==='string'&&/^[A-Z_]{1,64}$/.test(e.code)?e.code:undefined}));process.exitCode=1;});
