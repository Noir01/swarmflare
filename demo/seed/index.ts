export interface Project {
  readonly id: string;
  readonly name: string;
  readonly tenantId: string;
  readonly createdAt: string;
}

export const projects: readonly Project[] = Object.freeze([
  Object.freeze({ id: 'a-project-01', name: 'Tenant A: Atlas', tenantId: 'tenant-a', createdAt: '2025-01-03T12:00:00.000Z' }),
  Object.freeze({ id: 'a-project-02', name: 'Tenant A: Beacon', tenantId: 'tenant-a', createdAt: '2025-01-02T12:00:00.000Z' }),
  Object.freeze({ id: 'a-project-03', name: 'Tenant A: Cedar', tenantId: 'tenant-a', createdAt: '2025-01-02T12:00:00.000Z' }),
  Object.freeze({ id: 'b-project-01', name: 'Tenant B: Delta', tenantId: 'tenant-b', createdAt: '2025-01-04T12:00:00.000Z' }),
  Object.freeze({ id: 'b-project-02', name: 'Tenant B: Echo', tenantId: 'tenant-b', createdAt: '2025-01-02T12:00:00.000Z' }),
]);

export function listProjects(tenantId: string): Project[] {
  return projects
    .filter((project) => project.tenantId === tenantId)
    .slice()
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

export function renderProjectList(items: readonly Project[]): string {
  return `<ul>${items.map((project) => `<li data-project-id="${escapeHtml(project.id)}"><strong>${escapeHtml(project.name)}</strong> <time>${escapeHtml(project.createdAt)}</time></li>`).join('')}</ul>`;
}

export function createProjectListHandler(): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    if (request.method !== 'GET' || url.pathname !== '/api/projects') {
      return Response.json({ error: 'not_found' }, { status: 404 });
    }
    const tenantId = url.searchParams.get('tenant');
    if (tenantId !== 'tenant-a' && tenantId !== 'tenant-b') {
      return Response.json({ error: 'unknown_tenant' }, { status: 400 });
    }
    // Keep the original array response for legacy clients; filter before every response.
    return Response.json(listProjects(tenantId));
  };
}

export async function handleSeedRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/api/projects') return createProjectListHandler()(request);
  if (request.method === 'GET' && url.pathname === '/') {
    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
  if (request.method === 'GET' && url.pathname === '/app.js') {
    return new Response(clientScript, { headers: { 'content-type': 'text/javascript; charset=utf-8' } });
  }
  return Response.json({ error: 'not_found' }, { status: 404 });
}

export const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Project list seed</title>
<style>body{font:16px system-ui,sans-serif;max-width:48rem;margin:3rem auto;padding:0 1rem;color:#18212b}select{font:inherit;padding:.4rem}li{padding:.6rem 0}time{color:#596777;margin-left:.5rem}</style></head>
<body><h1>Projects</h1><label for="tenant">Synthetic tenant </label><select id="tenant"><option value="tenant-a">Tenant A</option><option value="tenant-b">Tenant B</option></select>
<p id="status" aria-live="polite">Loading…</p><ul id="projects"></ul><script type="module" src="/app.js"></script></body></html>`;

export const clientScript = `const select = document.querySelector('#tenant');
const list = document.querySelector('#projects');
const status = document.querySelector('#status');
async function loadProjects() {
  const tenant = select.value;
  status.textContent = 'Loading…';
  try {
    const response = await fetch('/api/projects?tenant=' + encodeURIComponent(tenant));
    if (!response.ok) throw new Error('Request failed');
    const projects = await response.json();
    // Replace rows on every tenant change; never reuse prior results or cursor state.
    list.replaceChildren(...projects.map((project) => {
      const row = document.createElement('li');
      const name = document.createElement('strong');
      name.textContent = project.name;
      const time = document.createElement('time');
      time.textContent = project.createdAt;
      row.append(name, ' ', time);
      return row;
    }));
    status.textContent = projects.length + ' projects';
  } catch {
    list.replaceChildren();
    status.textContent = 'Could not load projects';
  }
}
select.addEventListener('change', loadProjects);
loadProjects();`;
