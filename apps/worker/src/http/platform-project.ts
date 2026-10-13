type Namespace = { idFromName(name: string): DurableObjectId; get(id: DurableObjectId): { fetch(request: RequestInfo | URL, init?: RequestInit): Promise<Response> } };
type Env = { PLATFORM: Namespace; PROJECTS: Namespace };

const json = (value: unknown, status = 403) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
async function boundedBody(request: Request): Promise<ArrayBuffer> {
  const reader = request.body?.getReader();
  if (!reader) return new ArrayBuffer(0);
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65536) { await reader.cancel(); throw new RangeError('request body too large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes.buffer;
}
const publicReads = new Set([
  '/baseline', '/policy', '/context', '/events', '/findings', '/views', '/proposals',
]);
const isPublicRead = (method: string, path: string) => method === 'GET' && (
  publicReads.has(path) || /^\/(?:views|changes|revisions|findings|decisions|contracts)\/[A-Za-z0-9_-]+$/.test(path)
  || /^\/views\/[A-Za-z0-9_-]+\/(?:updates|readiness|reviews|checks|source-verification|review-artifact)$/.test(path)
  || /^\/changes\/[A-Za-z0-9_-]+\/revisions$/.test(path)
);
const isAgentRoute = (method: string, path: string) => (
  (method === 'POST' && (path === '/changes' || path === '/claims' || path === '/decisions' || path === '/views'
  || path === '/findings' || path === '/contracts/proposals'
  || /^\/changes\/[A-Za-z0-9_-]+\/revisions$/.test(path)
  || /^\/claims\/[A-Za-z0-9_-]+$/.test(path)
  || /^\/claims\/[A-Za-z0-9_-]+\/overlap-ack$/.test(path)
  || /^\/views\/[A-Za-z0-9_-]+\/reviews$/.test(path)
  || /^\/findings\/[A-Za-z0-9_-]+\/(?:repair|resolve)$/.test(path)
  || /^\/decisions\/[A-Za-z0-9_-]+\/(?:responses|agree)$/.test(path))
  || (method === 'PATCH' && /^\/claims\/[A-Za-z0-9_-]+$/.test(path))
));
const humanOnly = (method: string, path: string) => method === 'POST' && (
  path === '/acceptances' || path === '/baseline/initialize'
  || /^\/contracts\/[^/]+\/approve$/.test(path)
  || /^\/views\/[A-Za-z0-9_-]+\/confirmations$/.test(path)
  || /^\/decisions\/[A-Za-z0-9_-]+\/resolve$/.test(path)
);
const isServiceRunnerRoute = (method: string, path: string) =>
  (method === 'GET' && (isPublicRead(method, path) || /^\/runner\/jobs\/[A-Za-z0-9_-]+$/.test(path)))
  || (method === 'POST' && (path === '/runner/claim' || /^\/runner\/jobs\/[A-Za-z0-9_-]+\/(?:publish-artifacts|complete)$/.test(path) || /^\/runner\/views\/[A-Za-z0-9_-]+\/(?:checks|source-verifications|review-artifacts)$/.test(path)));
const knownProjectRoute = (method: string, path: string) => {
  if (method === 'GET') return isPublicRead(method, path) || /^\/runner\/jobs\/[A-Za-z0-9_-]+$/.test(path) || /^\/acceptances\/[A-Za-z0-9_-]+$/.test(path);
  if (method === 'POST') return path === '/baseline/initialize' || path === '/policy' || path === '/contracts/proposals' || path === '/runner/claim'
    || path === '/claims' || path === '/decisions' || path === '/views' || path === '/changes' || path === '/findings'
    || path === '/acceptances' || /^\/views\/[A-Za-z0-9_-]+\/confirmations$/.test(path)
    || /^\/changes\/[A-Za-z0-9_-]+\/revisions$/.test(path)
    || /^\/views\/[A-Za-z0-9_-]+\/reviews$/.test(path)
    || /^\/runner\/jobs\/[A-Za-z0-9_-]+\/(?:complete|publish-artifacts)$/.test(path)
    || /^\/runner\/views\/[A-Za-z0-9_-]+\/(?:checks|source-verifications|review-artifacts)$/.test(path)
    || /^\/findings\/[A-Za-z0-9_-]+\/(?:owner|repair|resolve)$/.test(path)
    || /^\/decisions\/[A-Za-z0-9_-]+\/(?:responses|agree|resolve)$/.test(path)
    || /^\/claims\/[A-Za-z0-9_-]+\/overlap-ack$/.test(path)
    || /^\/contracts\/[^/]+\/approve$/.test(path);
  if (method === 'PATCH') return /^\/claims\/[A-Za-z0-9_-]+$/.test(path);
  return false;
};

export async function platformProjectRoute(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)(\/.*)?$/);
  if (!match) return null;
  let projectId: string;
  try { projectId = decodeURIComponent(match[1]!); } catch { return json({ code: 'INVALID_REQUEST', message: 'Invalid project ID' }, 400); }
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(projectId)) return json({ code: 'INVALID_REQUEST', message: 'Invalid project ID' }, 400);
  if (encodeURIComponent(projectId) !== match[1]) return json({ code: 'INVALID_REQUEST', message: 'Noncanonical project ID' }, 422);
  const path = match[2] || '/';

  const authHeaders = new Headers();
  authHeaders.set('content-type', 'application/json');
  authHeaders.set('x-swarmflare-internal', 'platform-worker');
  for (const name of ['cookie', 'origin', 'x-csrf-token', 'authorization']) {
    const value = request.headers.get(name);
    if (value) authHeaders.set(name, value);
  }
  const platformId = env.PLATFORM.idFromName('swarmflare-platform-v1');
  let authResponse: Response;
  let decision: { code?: string; actor?: { id: string; projectId: string; role: string; kind: string } };
  try {
    authResponse = await env.PLATFORM.get(platformId).fetch(`${url.origin}/internal/authorize-project`, {
      method: 'POST', headers: authHeaders,
      body: JSON.stringify({ projectId, method: request.method, path }),
    });
    decision = await authResponse.json() as typeof decision;
  } catch { return json({ code: 'UNAVAILABLE', message: 'Service unavailable' }, 503); }
  if (!authResponse.ok) {
    if (authResponse.status === 404 && decision.code === 'PROJECT_UNMAPPED') return null;
    return json({ code: decision.code ?? 'FORBIDDEN', message: 'Project access denied' }, authResponse.status);
  }
  if (path.startsWith('/internal/')) return json({ code: 'NOT_FOUND', message: 'Not found' }, 404);
  if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(request.method)) return json({ code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' }, 405);
  if (!knownProjectRoute(request.method, path)) return json({ code: 'NOT_FOUND', message: 'Unknown project route' }, 404);
  if (request.method === 'GET' && !isPublicRead(request.method, path) && !(decision.actor?.kind === 'service-runner' && /^\/runner\/jobs\/[A-Za-z0-9_-]+$/.test(path))) return json({ code: 'FORBIDDEN', message: 'Project resource is not publicly readable' });
  if (!decision.actor || decision.actor.projectId !== projectId) return json({ code: 'FORBIDDEN', message: 'Project access denied' });
  const actor = decision.actor;
  if (humanOnly(request.method, path) && actor.kind !== 'human') return json({ code: 'FORBIDDEN', message: 'Human actor required' });
  if (actor.kind === 'agent' && !isAgentRoute(request.method, path)) return json({ code: 'FORBIDDEN', message: 'Agent route is not permitted' });
  if (actor.kind === 'service-runner' && (actor.role !== 'runner' || !isServiceRunnerRoute(request.method, path))) return json({ code: 'FORBIDDEN', message: 'Runner route is not permitted' });
  if (actor.kind === 'public' && !isPublicRead(request.method, path)) return json({ code: 'FORBIDDEN', message: 'Public route is read-only' });
  if (actor.kind === 'human' && request.method !== 'GET' && !request.headers.get('origin')) return json({ code: 'CSRF', message: 'Origin required' }, 403);

  let body: ArrayBuffer | undefined;
  try { if (request.method !== 'GET' && request.method !== 'HEAD') body = await boundedBody(request); }
  catch { return json({ code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' }, 413); }
  const headers = new Headers();
  headers.set('content-type', request.headers.get('content-type') ?? 'application/json');
  headers.set('x-project-id', projectId);
  headers.set('x-actor', JSON.stringify({ id: actor.id, projectId, role: actor.role }));
  let response: Response;
  try {
    response = await env.PROJECTS.get(env.PROJECTS.idFromName(projectId)).fetch(`https://project.internal${path}${url.search}`, {
      method: request.method, headers, body,
    });
  } catch { return json({ code: 'UNAVAILABLE', message: 'Service unavailable' }, 503); }
  const outHeaders = new Headers(response.headers);
  outHeaders.set('Cache-Control', 'no-store');
  outHeaders.delete('set-cookie');
  return new Response(response.body, { status: response.status, headers: outHeaders });
}
