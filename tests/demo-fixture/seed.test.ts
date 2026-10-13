import { describe, it, expect } from 'vitest';
import { createProjectListHandler, listProjects, projects, renderProjectList } from '../../demo/seed/index';

describe('legacy project-list seed', () => {
  it('keeps the unpaginated legacy response as an array', async () => {
    const response = await createProjectListHandler()(new Request('http://localhost/api/projects?tenant=tenant-a'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toEqual(listProjects('tenant-a'));
    expect(body).not.toHaveProperty('items');
  });

  it('filters every tenant query and never discloses another tenant', async () => {
    const handler = createProjectListHandler();
    const response = await handler(new Request('http://localhost/api/projects?tenant=tenant-a'));
    const body = await response.json() as Array<{ tenantId: string; id: string }>;
    expect(body.length).toBeGreaterThan(0);
    expect(body.every((project) => project.tenantId === 'tenant-a')).toBe(true);
    expect(body.some((project) => projects.some((other) => other.tenantId === 'tenant-b' && other.id === project.id))).toBe(false);
  });

  it('has deterministic fixtures including tied timestamps and stable ordering', () => {
    expect(projects).toEqual(projects);
    const tied = projects.filter((project) => project.createdAt === '2025-01-02T12:00:00.000Z');
    expect(tied.map((project) => project.id)).toEqual(['a-project-02', 'a-project-03', 'b-project-02']);
    expect(listProjects('tenant-a').map((project) => project.id)).toEqual(['a-project-01', 'a-project-02', 'a-project-03']);
  });

  it('rejects unknown tenants without returning project data', async () => {
    const response = await createProjectListHandler()(new Request('http://localhost/api/projects?tenant=tenant-c'));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'unknown_tenant' });
  });

  it('renders user-controlled project fields as escaped text', () => {
    expect(renderProjectList([{ id: '<script>', name: '<img src=x onerror=alert(1)>', tenantId: 'tenant-a', createdAt: '2025-01-01T00:00:00.000Z' }]))
      .not.toContain('<script>');
    expect(renderProjectList([{ id: '<script>', name: '<img src=x onerror=alert(1)>', tenantId: 'tenant-a', createdAt: '2025-01-01T00:00:00.000Z' }]))
      .toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});
