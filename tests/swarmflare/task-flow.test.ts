import { describe, expect, it } from 'vitest';
import { site } from '../../apps/worker/src/http/site';

describe('task proposal vertical path', () => {
  it('persists a human-submitted proposal and exposes it as pending on SSR reload', async () => {
    const proposals: any[] = [];
    const project = { idFromName: (name: string) => name, get: () => ({ fetch: async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === '/context') return Response.json({ resource: { contract: null, claims: [] } });
      if (path === '/proposals') return Response.json({ resource: proposals });
      if (path === '/views') return Response.json({ resource: [] });
      if (path === '/events') return Response.json({ resource: { events: [] } });
      if (path === '/contracts/proposals' && request.method === 'POST') {
        const payload = await request.json() as any;
        const proposal = { id: 'proposal-1', version: 1, owner: 'human-1', data: { ...payload.payload, status: 'proposed' } };
        proposals.push(proposal);
        return Response.json({ resource: proposal }, { status: 201 });
      }
      return Response.json({ resource: [] });
    } }) };
    const platform = { idFromName: (name: string) => name, get: () => ({ fetch: async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith('/auth/session')) return Response.json({ user: { username: 'ada', id: 'human-1' }, csrf: 'csrf-token' });
      if (url.pathname.endsWith('/internal/authorize-project')) return Response.json({ actor: { id: 'human-1', projectId: 'project-1', role: 'human', kind: 'human' } });
      if (url.pathname.endsWith('/repos/ada/notes')) return Response.json({ repository: { id: 'repo-1', owner: 'ada', name: 'notes', projectId: 'project-1', status: 'ready' } });
      if (url.pathname.endsWith('/source')) return Response.json({ entries: [] });
      return Response.json({});
    } }) };
    const env = { PLATFORM: platform, PROJECTS: project } as any;
    const payload = { requestId: 'request-1', payload: { outcome: 'Add CSV export', constraints: ['Keep existing API'], obligations: [{ id: 'csv', description: 'Export rows as CSV', acceptanceExamples: ['header included'] }], requiredCheckIds: ['csv-check'], unresolvedQuestions: [] } };
    const submitted = await site(new Request('https://swarmflare.test/api/swarmflare/repos/ada/notes/proposals', { method: 'POST', headers: { origin: 'https://swarmflare.test', 'x-csrf-token': 'csrf-token', 'content-type': 'application/json' }, body: JSON.stringify(payload) }), env);
    expect(submitted.status).toBe(201);
    const page = await site(new Request('https://swarmflare.test/ada/notes/tasks'), env);
    const html = await page.text();
    expect(html).toContain('Add CSV export');
    expect(html).toContain('Proposed · awaiting human approval');
    expect(html).not.toContain('Current approved task</h2><div class="readme-body"><p>Add CSV export');
  });
});
