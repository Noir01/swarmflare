import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDemoSuite, demoSuiteDigest } from '../../packages/git-runner/checks/demo-suite.js';

let root: string | undefined;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = undefined; });

it('executes the trusted mandatory demo API oracle against a read-only local source snapshot', async () => {
  root = await mkdtemp(join(tmpdir(), 'demo-check-e2e-'));
  const candidate = join(root, 'candidate');
  await mkdir(join(candidate, 'demo/seed'), { recursive: true });
  // Prepared positive fixture, not a contribution to the actual agent demo.
  const seed = await readFile('demo/seed/index.ts', 'utf8');
  const start = seed.indexOf('export function createProjectListHandler()');
  const end = seed.indexOf('export async function handleSeedRequest');
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const handler = `export function createProjectListHandler() { return async (request: Request) => {
    const u = new URL(request.url), tenant = u.searchParams.get('tenant');
    if (request.method !== 'GET' || u.pathname !== '/api/projects') return Response.json({error:'not_found'}, {status:404});
    if (tenant !== 'tenant-a' && tenant !== 'tenant-b') return Response.json({error:'unknown_tenant'}, {status:400});
    const rows = listProjects(tenant), raw = u.searchParams.get('limit'), cursor = u.searchParams.get('cursor');
    if (raw === null) return cursor === null ? Response.json(rows) : Response.json({error:'invalid_cursor'}, {status:400});
    if (!/^[1-9][0-9]*$/.test(raw) || Number(raw) > 50) return Response.json({error:'invalid_limit'}, {status:400});
    let offset = 0;
    if (cursor !== null) { try { const c = JSON.parse(Buffer.from(cursor,'base64url').toString());
      if (c.tenant !== tenant || !Number.isInteger(c.offset) || c.offset < 0 || c.offset >= rows.length) throw new Error();
      offset = c.offset;
    } catch { return Response.json({error:'invalid_cursor'}, {status:400}); } }
    const items = rows.slice(offset, offset + Number(raw)), next = offset + items.length;
    return Response.json({items, nextCursor:next < rows.length ? Buffer.from(JSON.stringify({tenant,offset:next})).toString('base64url') : null});
  };}\n`;
  await writeFile(join(candidate, 'demo/seed/index.ts'), seed.slice(0, start) + handler + seed.slice(end));
  const result = await runDemoSuite({ candidateDirectory: candidate, applicability: {
    projectId: 'local-e2e', viewId: '00000000-0000-4000-8000-000000000001', manifestDigest: 'a'.repeat(64),
    composedCommitOid: 'b'.repeat(40), treeOid: 'c'.repeat(40), contractVersion: 1, policyVersion: 1,
    checkSuiteDigest: demoSuiteDigest(),
  }});
  expect(result).toHaveLength(1);
  expect(result[0]!.result).toBe('passed');
  expect(await readFile(join(candidate, 'demo/seed/index.ts'), 'utf8')).toContain('createProjectListHandler');
});
