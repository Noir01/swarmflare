export function workspaceEndpoint(baseUrl: string, allowedOrigin?: string): string {
  let base: URL;
  try { base = new URL(baseUrl); } catch { throw new Error('WORKSPACE_BASE_URL must be a valid URL'); }
  const isLoopback = base.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(base.hostname) &&
    !base.username && !base.password && !base.search && !base.hash && ['', '/'].includes(base.pathname);
  if (isLoopback && !allowedOrigin) return base.toString();
  if (!allowedOrigin) throw new Error('WORKSPACE_BASE_URL must be plain HTTP on a loopback host unless WORKSPACE_ALLOWED_ORIGIN is set');
  let approved: URL;
  try { approved = new URL(allowedOrigin); } catch { throw new Error('WORKSPACE_ALLOWED_ORIGIN must be an exact HTTPS origin'); }
  const validOrigin = approved.protocol === 'https:' && /^https:\/\/(?:[a-z0-9-]+\.){1,2}workers\.dev$/i.test(allowedOrigin) && approved.origin === allowedOrigin && !approved.username && !approved.password && approved.pathname === '/' && !approved.search && !approved.hash;
  if (!validOrigin) throw new Error('WORKSPACE_ALLOWED_ORIGIN must be an exact HTTPS *.workers.dev origin without port, path, userinfo, query or fragment');
  if (base.origin !== approved.origin || base.protocol !== 'https:' || base.pathname !== '/' || base.search || base.hash || base.username || base.password) throw new Error('WORKSPACE_BASE_URL origin must exactly match WORKSPACE_ALLOWED_ORIGIN and contain no path, userinfo, query or fragment');
  return base.toString();
}
