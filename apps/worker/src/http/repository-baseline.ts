import { z } from "zod";
import { baselineSchema, jobResourceSchema } from "../../../../packages/contracts/source.js";
import type { PlatformArtifactsBinding } from "../platform/repository-source.js";
import { fetchSeedPack, validSeedConfig } from "../platform/source-seed.js";

type Stub = { fetch(request: RequestInfo | URL, init?: RequestInit): Promise<Response> };
type Namespace = { idFromName(name: string): unknown; get(id: unknown): Stub };
type Env = { PLATFORM: Namespace; PROJECTS: Namespace; ARTIFACTS?: PlatformArtifactsBinding };
const envelope = z.object({ requestId: z.string().uuid(), expectedVersion: z.literal(0), payload: z.object({ commitOid: z.string().regex(/^[0-9a-f]{40}$/), treeOid: z.string().regex(/^[0-9a-f]{40}$/) }).strict() }).strict();
const ownerPattern = /^[a-z0-9-]{3,32}$/;
const namePattern = /^[a-z0-9-]{3,64}$/;
const json = (status: number, code: string, message: string) => Response.json({ code, message }, { status, headers: { "Cache-Control": "no-store" } });
const timeoutFetch = async (stub: Stub, request: Request): Promise<Response> => Promise.race([stub.fetch(request), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000))]);
async function readBody(request: Request): Promise<unknown> {
  const reader = request.body?.getReader(); if (!reader) return null;
  const chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 8192) { await reader.cancel(); throw new RangeError(); } chunks.push(value); } }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
function internalHeaders(extra?: HeadersInit): Headers { const headers = new Headers(extra); headers.set("content-type", "application/json"); return headers; }

/** Handles the owner-only, catalog-pinned baseline initialization API. */
export async function repositoryBaseline(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const route = url.pathname.match(/^\/api\/swarmflare\/repos\/([^/]+)\/([^/]+)\/baseline\/initialize$/);
  if (!route) return null;
  if (request.method !== "POST") return json(405, "METHOD_NOT_ALLOWED", "Method not allowed");
  let owner: string, name: string;
  try { owner = decodeURIComponent(route[1]!); name = decodeURIComponent(route[2]!); } catch { return json(400, "INVALID_REQUEST", "Invalid repository path"); }
  if (!ownerPattern.test(owner) || !namePattern.test(name) || encodeURIComponent(owner) !== route[1] || encodeURIComponent(name) !== route[2]) return json(400, "INVALID_REQUEST", "Invalid repository path");
  if (request.headers.get("origin") !== url.origin) return json(403, "FORBIDDEN", "Same-origin owner request required");
  let input: z.infer<typeof envelope>;
  try { const body = await readBody(request); const parsed = envelope.safeParse(body); if (!parsed.success) return json(400, "INVALID_REQUEST", "Invalid baseline request"); input = parsed.data; }
  catch (error) { return json(error instanceof RangeError ? 413 : 400, error instanceof RangeError ? "PAYLOAD_TOO_LARGE" : "INVALID_REQUEST", "Invalid baseline request"); }
  const platformId = env.PLATFORM.idFromName("swarmflare-platform-v1"), platform = env.PLATFORM.get(platformId);
  const publicUrl = `${url.origin}/api/platform/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  let catalog: any, projectId: string;
  try {
    const response = await timeoutFetch(platform, new Request(publicUrl, { headers: { accept: "application/json" } }));
    if (!response.ok) return json(response.status === 404 ? 404 : 503, response.status === 404 ? "NOT_FOUND" : "UNAVAILABLE", "Repository source unavailable");
    catalog = await response.json(); projectId = catalog?.repository?.projectId;
    if (typeof projectId !== "string" || catalog.repository.owner !== owner || catalog.repository.name !== name || catalog.repository.status !== "ready" || !/^[A-Za-z0-9_-]{1,120}$/.test(projectId) || typeof catalog.repository.id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(catalog.repository.id) || typeof catalog.repository.ownerId !== "string") return json(409, "SOURCE_NOT_READY", "Repository source is not ready");
    const source = catalog.repository.source;
    if (!source || !/^refs\/heads\/(?:main|master)$/.test(source.ref) || source.commitOid !== input.payload.commitOid || source.treeOid !== input.payload.treeOid) return json(409, "SOURCE_MISMATCH", "Requested source does not match the verified repository tuple");
  } catch { return json(503, "UNAVAILABLE", "Repository source unavailable"); }
  const authHeaders = internalHeaders(); authHeaders.set("x-swarmflare-internal", "platform-worker");
  for (const key of ["cookie", "origin", "x-csrf-token", "authorization"]) { const value = request.headers.get(key); if (value) authHeaders.set(key, value); }
  let authorized: any;
  try {
    const auth = await timeoutFetch(platform, new Request(`${url.origin}/api/platform/internal/authorize-project`, { method: "POST", headers: authHeaders, body: JSON.stringify({ projectId, method: "POST", path: "/baseline/initialize" }) }));
    authorized = await auth.json();
    if (!auth.ok || authorized?.actor?.kind !== "human" || authorized.actor.role !== "human" || authorized.actor.projectId !== projectId || authorized.actor.id !== catalog.repository.ownerId || authorized.repository?.owner !== owner || authorized.repository?.name !== name) return json(403, "FORBIDDEN", "Authenticated repository owner required");
  } catch { return json(503, "UNAVAILABLE", "Authorization service unavailable"); }
  const actor = { id: authorized.actor.id, projectId, role: "human" };
  const project = env.PROJECTS.get(env.PROJECTS.idFromName(projectId));
  const projectRequest = (path: string, method: string, body?: unknown, who = actor) => new Request(`https://project.internal${path}`, { method, headers: internalHeaders({ "x-project-id": projectId, "x-actor": JSON.stringify(who) }), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const readBaseline = async () => {
    const response = await timeoutFetch(project, projectRequest("/baseline", "GET"));
    if (!response.ok) throw new Error("readback");
    const parsed = await response.json() as any;
    return parsed?.resource ? baselineSchema.parse(parsed.resource) : null;
  };
  try {
    const previous = await readBaseline();
    if (previous) {
      if (previous.commitOid !== input.payload.commitOid || previous.treeOid !== input.payload.treeOid) return json(409, "BASELINE_CONFLICT", "A different baseline is already installed");
      const replay = await timeoutFetch(project, projectRequest("/baseline/initialize", "POST", input));
      const replayBody = await replay.json() as any;
      const originalJob = jobResourceSchema.safeParse(replayBody?.resource);
      if (!replay.ok || !originalJob.success || originalJob.data.data.input.kind !== "seed" || originalJob.data.data.input.source.commitOid !== input.payload.commitOid || originalJob.data.data.input.source.treeOid !== input.payload.treeOid) return json(409, "BASELINE_CONFLICT", "Baseline request does not match the original seed job");
      const seedActor = { id: `service-seed-${catalog.repository.id}`, projectId, role: "runner" };
      const readJob = await timeoutFetch(project, projectRequest(`/runner/jobs/${encodeURIComponent(originalJob.data.id)}`, "GET", undefined, seedActor));
      const currentJob = jobResourceSchema.safeParse((await readJob.json() as any)?.resource);
      if (!readJob.ok || !currentJob.success || currentJob.data.id !== originalJob.data.id || currentJob.data.data.input.kind !== "seed" || currentJob.data.data.status !== "completed" || currentJob.data.data.input.source.commitOid !== input.payload.commitOid || currentJob.data.data.input.source.treeOid !== input.payload.treeOid || currentJob.data.data.receipt?.backend !== "artifacts-git" || currentJob.data.data.receipt.commitOid !== input.payload.commitOid || currentJob.data.data.receipt.treeOid !== input.payload.treeOid) return json(409, "BASELINE_CONFLICT", "Original baseline seed job is not completed");
      return Response.json({ baseline: previous, job: currentJob.data, status: "initialized" }, { headers: { "Cache-Control": "no-store" } });
    }
    const configHeaders = internalHeaders(); configHeaders.set("x-swarmflare-internal", "project-worker");
    const configResponse = await timeoutFetch(platform, new Request(`${url.origin}/api/platform/internal/source-config`, { method: "POST", headers: configHeaders, body: JSON.stringify({ projectId }) }));
    const configBody = await configResponse.json() as any;
    if (!configResponse.ok || !validSeedConfig(configBody?.config, projectId) || configBody.config.repository !== `sf-${catalog.repository.id}`) return json(503, "SOURCE_UNAVAILABLE", "Repository source configuration unavailable");
    const initialize = await timeoutFetch(project, projectRequest("/baseline/initialize", "POST", input));
    const initBody = await initialize.json() as any;
    if (!initialize.ok) return json(initialize.status, initBody?.code ?? "INITIALIZATION_FAILED", "Baseline initialization was not accepted");
    const initialJob = jobResourceSchema.safeParse(initBody?.resource);
    if (!initialJob.success || initialJob.data.data.input.kind !== "seed" || initialJob.data.data.status !== "queued" || initialJob.data.data.input.source.commitOid !== input.payload.commitOid || initialJob.data.data.input.source.treeOid !== input.payload.treeOid) return json(409, "JOB_MISMATCH", "Project returned an unexpected seed job");
    const seedJobId = initialJob.data.id;
    const seedActor = { id: `service-seed-${catalog.repository.id}`, projectId, role: "runner" };
    const claimEnvelope = { requestId: `${input.requestId}-claim`, payload: { leaseSeconds: 30 } };
    const claimResponse = await timeoutFetch(project, projectRequest("/runner/claim", "POST", claimEnvelope, seedActor));
    const claimBody = await claimResponse.json() as any;
    const claimed = jobResourceSchema.safeParse(claimBody?.resource);
    if (!claimResponse.ok || !claimed.success || claimed.data.id !== seedJobId || claimed.data.data.status !== "leased" || claimed.data.data.runnerId !== seedActor.id || claimed.data.data.input.kind !== "seed" || claimed.data.data.input.source.commitOid !== input.payload.commitOid || claimed.data.data.input.source.treeOid !== input.payload.treeOid || !claimed.data.data.attemptId || !claimed.data.data.leaseExpiresAt || claimed.data.data.leaseExpiresAt <= Date.now()) return json(409, "JOB_MISMATCH", "Seed job could not be safely claimed");
    const packBase64 = await fetchSeedPack(env.ARTIFACTS, configBody.config, projectId, input.payload.commitOid, input.payload.treeOid);
    const publishBody = { requestId: `${input.requestId}-publish`, payload: { attemptId: claimed.data.data.attemptId, commitOid: input.payload.commitOid, treeOid: input.payload.treeOid, packBase64 } };
    const publishResponse = await timeoutFetch(project, projectRequest(`/internal/seed-jobs/${encodeURIComponent(seedJobId)}/publish-artifacts`, "POST", publishBody, seedActor));
    const published = await publishResponse.json() as any;
    const completed = jobResourceSchema.safeParse(published?.resource);
    if (!publishResponse.ok || !completed.success || completed.data.id !== seedJobId || completed.data.data.status !== "completed" || completed.data.data.input.kind !== "seed" || completed.data.data.input.source.commitOid !== input.payload.commitOid || completed.data.data.input.source.treeOid !== input.payload.treeOid || completed.data.data.receipt?.backend !== "artifacts-git" || completed.data.data.receipt.commitOid !== input.payload.commitOid || completed.data.data.receipt.treeOid !== input.payload.treeOid) return json(409, "PUBLICATION_FAILED", "Baseline publication did not complete with the requested source");
    const baseline = await readBaseline();
    if (!baseline || baseline.commitOid !== input.payload.commitOid || baseline.treeOid !== input.payload.treeOid || baseline.receipt.backend !== "artifacts-git" || baseline.receipt.ref !== completed.data.data.receipt.ref) return json(503, "READBACK_FAILED", "Baseline readback did not match the published source");
    return Response.json({ baseline, job: completed.data, status: "initialized" }, { headers: { "Cache-Control": "no-store" } });
  } catch { return json(503, "INITIALIZATION_FAILED", "Baseline initialization could not be verified"); }
}
