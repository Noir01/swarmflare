import { z } from 'zod';
import { demoPolicyManifest } from '../generated/demo-policy.js';

type Stub = { fetch(request: RequestInfo | URL, init?: RequestInit): Promise<Response> };
type Namespace = { idFromName(name: string): unknown; get(id: unknown): Stub };
type Env = { PLATFORM: Namespace; PROJECTS: Namespace };
const envelope = z.object({ requestId: z.string().uuid(), expectedVersion: z.number().int().nonnegative(), contractVersion: z.number().int().min(1) }).strict();
const ownerPattern = /^[a-z0-9-]{3,32}$/;
const namePattern = /^[a-z0-9-]{3,64}$/;
const json = (status: number, code: string, message: string) => Response.json({ code, message }, { status, headers: { 'Cache-Control': 'no-store' } });
const timeoutFetch = (stub: Stub, request: Request) => Promise.race([stub.fetch(request), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))]);

export function demoPolicyModel(contractData: unknown): { supported: boolean; template: typeof demoPolicyManifest } {
  const expected = demoPolicyManifest.contract;
  if (!contractData || typeof contractData !== 'object') return { supported: false, template: demoPolicyManifest };
  const data = contractData as { obligations?: unknown; requiredCheckIds?: unknown };
  const ids = Array.isArray(data.obligations) ? data.obligations.map(item => item && typeof item === 'object' ? (item as { id?: unknown }).id : undefined) : null;
  return { supported: JSON.stringify(ids) === JSON.stringify(expected.obligations.map(x => x.id)) && JSON.stringify(data.requiredCheckIds) === JSON.stringify(expected.requiredCheckIds), template: demoPolicyManifest };
}
async function readBody(request: Request): Promise<unknown> {
  const reader = request.body?.getReader(); if (!reader) return null;
  const chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 8192) { await reader.cancel(); throw new RangeError(); } chunks.push(value); } } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
const internalHeaders = (extra?: HeadersInit) => { const h = new Headers(extra); h.set('content-type', 'application/json'); return h; };
export async function repositoryPolicy(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === '/api/swarmflare/demo-policy') return request.method === 'GET' ? Response.json({supported:true,...demoPolicyManifest}, { headers: { 'Cache-Control': 'no-store' } }) : json(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
  const route = url.pathname.match(/^\/api\/swarmflare\/repos\/([^/]+)\/([^/]+)\/policy$/); if (!route) return null;
  if (request.method !== 'POST') return json(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
  let owner: string, name: string;
  try { owner = decodeURIComponent(route[1]!); name = decodeURIComponent(route[2]!); } catch { return json(400, 'INVALID_REQUEST', 'Invalid repository path'); }
  if (!ownerPattern.test(owner) || !namePattern.test(name) || encodeURIComponent(owner) !== route[1] || encodeURIComponent(name) !== route[2]) return json(400, 'INVALID_REQUEST', 'Invalid repository path');
  if (request.headers.get('origin') !== url.origin) return json(403, 'FORBIDDEN', 'Same-origin owner request required');
  let input: z.infer<typeof envelope>;
  try { const parsed = envelope.safeParse(await readBody(request)); if (!parsed.success) return json(400, 'INVALID_REQUEST', 'Invalid policy request'); input = parsed.data; }
  catch (e) { return json(e instanceof RangeError ? 413 : 400, e instanceof RangeError ? 'PAYLOAD_TOO_LARGE' : 'INVALID_REQUEST', 'Invalid policy request'); }
  const platform = env.PLATFORM.get(env.PLATFORM.idFromName('swarmflare-platform-v1')); let catalog: any, projectId: string;
  try {
    const response = await timeoutFetch(platform, new Request(`${url.origin}/api/platform/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, { headers: { accept: 'application/json' } }));
    if (!response.ok) return json(response.status === 404 ? 404 : 503, response.status === 404 ? 'NOT_FOUND' : 'UNAVAILABLE', 'Repository source unavailable');
    catalog = await response.json(); projectId = catalog?.repository?.projectId;
    if (typeof projectId !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(projectId) || catalog.repository.owner !== owner || catalog.repository.name !== name || catalog.repository.status !== 'ready' || typeof catalog.repository.ownerId !== 'string') return json(409, 'SOURCE_NOT_READY', 'Repository source is not ready');
  } catch { return json(503, 'UNAVAILABLE', 'Repository source unavailable'); }
  const authHeaders = internalHeaders(); authHeaders.set('x-swarmflare-internal', 'platform-worker');
  for (const key of ['cookie', 'origin', 'x-csrf-token', 'authorization']) { const value = request.headers.get(key); if (value) authHeaders.set(key, value); }
  let authorized: any;
  try {
    const auth = await timeoutFetch(platform, new Request(`${url.origin}/api/platform/internal/authorize-project`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ projectId, method: 'POST', path: '/policy' }) })); authorized = await auth.json();
    if (!auth.ok || authorized?.actor?.kind !== 'human' || authorized.actor.role !== 'human' || authorized.actor.projectId !== projectId || authorized.actor.id !== catalog.repository.ownerId || authorized.repository?.owner !== owner || authorized.repository?.name !== name) return json(403, 'FORBIDDEN', 'Authenticated repository owner required');
  } catch { return json(503, 'UNAVAILABLE', 'Authorization service unavailable'); }
  const project = env.PROJECTS.get(env.PROJECTS.idFromName(projectId)), actor = { id: authorized.actor.id, projectId, role: 'human' };
  const projectRequest = (path: string, method: string, body?: unknown) => new Request(`https://project.internal${path}`, { method, headers: internalHeaders({ 'x-project-id': projectId, 'x-actor': JSON.stringify(actor) }), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    const [ctxResponse, currentResponse, contractResponse] = await Promise.all([timeoutFetch(project, projectRequest('/context', 'GET')), timeoutFetch(project, projectRequest('/policy', 'GET')), timeoutFetch(project, projectRequest(`/contracts/${input.contractVersion}`, 'GET'))]);
    if (!ctxResponse.ok || !currentResponse.ok) return json(503, 'UNAVAILABLE', 'Project policy state unavailable');
    const context = (await ctxResponse.json() as any)?.resource, current = (await currentResponse.json() as any)?.resource;
    if (context?.contract?.version !== input.contractVersion) return json(409, 'CONTRACT_STALE', 'Contract version must be current');
    if (!contractResponse.ok) return json(409, 'CONTRACT_STALE', 'Contract version is unavailable');
    const contract = (await contractResponse.json() as any)?.resource;
    if (!demoPolicyModel(contract?.data).supported) return json(409, 'UNSUPPORTED_CONTRACT', 'Contract does not match the supported demo obligations and checks');
    const actualVersion = current?.version ?? 0; if (actualVersion !== input.expectedVersion) return json(409, 'VERSION_CONFLICT', 'Stale policy version');
    const policy = { contractVersion: input.contractVersion, ...demoPolicyManifest.policyTemplate };
    const configured = await timeoutFetch(project, projectRequest('/policy', 'POST', { requestId: input.requestId, expectedVersion: input.expectedVersion, payload: policy })), result = await configured.json() as any;
    if (!configured.ok) return json(configured.status, result?.code ?? 'POLICY_FAILED', 'Policy was not accepted');
    const readbackResponse = await timeoutFetch(project, projectRequest('/policy', 'GET')), readback = (await readbackResponse.json() as any)?.resource;
    if (!readbackResponse.ok || readback?.version !== input.expectedVersion + 1 || JSON.stringify(readback.data) !== JSON.stringify(policy)) return json(503, 'READBACK_FAILED', 'Configured policy readback did not match');
    return Response.json({ policy: readback, status: 'configured' }, { headers: { 'Cache-Control': 'no-store' } });
  } catch { return json(503, 'POLICY_FAILED', 'Policy configuration could not be verified'); }
}
