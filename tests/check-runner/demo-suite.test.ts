import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { demoSuiteDigest, runDemoSuite } from '../../packages/git-runner/checks/demo-suite.js';
import { checkReceiptSchema } from '../../packages/contracts/evidence.js';

const applicability = {
  projectId: 'demo-project', viewId: 'demo-view', manifestDigest: 'a'.repeat(64),
  composedCommitOid: 'b'.repeat(40), treeOid: 'c'.repeat(40), contractVersion: 1,
  policyVersion: 1, checkSuiteDigest: demoSuiteDigest(),
};

async function fixture(source: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'demo-oracle-fixture-'));
  await mkdir(join(root, 'demo/seed'), { recursive: true });
  await writeFile(join(root, 'demo/seed/index.ts'), source);
  return root;
}

describe('trusted demo API oracle', () => {
  it('pins the oracle and its parser in the suite digest', () => {
    expect(demoSuiteDigest()).toMatch(/^[a-f0-9]{64}$/);
    expect(demoSuiteDigest()).toBe(demoSuiteDigest());
  });

  it('rejects candidate-forged passing assertion output followed by process exit', async () => {
    const root = await fixture(`
console.log(JSON.stringify({assertions:Array.from({length:7},(_,i)=>({name:String(i),passed:true}))}));
process.exit(0);
export function createProjectListHandler() { return async () => Response.json([]); }
`);
    try {
      const receipts = await runDemoSuite({ candidateDirectory: root, applicability });
      expect(receipts[0]?.result).toBe('failed');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects a deliberately broken pagination implementation from executed assertions', async () => {
    const root = await fixture(`
export function createProjectListHandler() {
 return async (request: Request) => {
  const url = new URL(request.url);
  if (!url.searchParams.has('limit')) return Response.json([{id:'a1',tenantId:'tenant-a'}]);
  return Response.json({items:[{id:'a1',tenantId:'tenant-a'}],nextCursor:null});
 };
}`);
    try {
      const receipts = await runDemoSuite({ candidateDirectory: root, applicability });
      expect(receipts).toHaveLength(1);
      expect(receipts[0]?.result).toBe('failed');
      expect(receipts[0]?.obligationIds).toContain('tenant-isolation');
      expect(receipts.every((receipt) => receipt.execution.status === 'exited')).toBe(true);
      expect(receipts.every((receipt) => receipt.execution.exitCode === 0)).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('passes a minimal implementation satisfying the pinned API cases', async () => {
    const root = await fixture(`
const records = [
 {id:'a-project-01', name:'Tenant A: Atlas', tenantId:'tenant-a', createdAt:'2025-01-03T12:00:00.000Z'},
 {id:'a-project-02', name:'Tenant A: Beacon', tenantId:'tenant-a', createdAt:'2025-01-02T12:00:00.000Z'},
 {id:'a-project-03', name:'Tenant A: Cedar', tenantId:'tenant-a', createdAt:'2025-01-02T12:00:00.000Z'},
 {id:'b-project-01', name:'Tenant B: Delta', tenantId:'tenant-b', createdAt:'2025-01-04T12:00:00.000Z'},
 {id:'b-project-02', name:'Tenant B: Echo', tenantId:'tenant-b', createdAt:'2025-01-02T12:00:00.000Z'}
];
function ordered(tenant) { return records.filter(x => x.tenantId === tenant).sort((a,b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)); }
export function createProjectListHandler() { return async request => {
 const u = new URL(request.url), tenant = u.searchParams.get('tenant');
 if (request.method !== 'GET' || u.pathname !== '/api/projects') return Response.json({error:'not_found'},{status:404});
 if (u.searchParams.has('cursor') && !u.searchParams.has('limit')) return Response.json({error:'invalid_cursor'},{status:400});
 if (!['tenant-a','tenant-b'].includes(tenant)) return Response.json({error:'unknown_tenant'},{status:400});
 const all = ordered(tenant), limitText = u.searchParams.get('limit');
 if (limitText === null) return Response.json(all);
 const limit = Number(limitText);
 if (!Number.isInteger(limit) || limit < 1 || limit > 50) return Response.json({error:'invalid_limit'},{status:400});
 const raw = u.searchParams.get('cursor'); let offset = 0;
 if (raw !== null) { try { const c = JSON.parse(Buffer.from(raw,'base64url').toString()); if (c.tenant !== tenant || !Number.isInteger(c.offset) || c.offset < 0) throw 0; offset = c.offset; } catch { return Response.json({error:'invalid_cursor'},{status:400}); } }
 if (offset > all.length) return Response.json({error:'invalid_cursor'},{status:400});
 const items = all.slice(offset, offset + limit), next = offset + items.length;
 return Response.json({items, nextCursor: next < all.length ? Buffer.from(JSON.stringify({tenant,offset:next})).toString('base64url') : null});
}; }
`);
    try {
      const receipts = await runDemoSuite({ candidateDirectory: root, applicability });
      expect(receipts).toHaveLength(1);
      expect(receipts[0]?.result, JSON.stringify(receipts)).toBe('passed');
      expect(receipts[0]?.execution.exitCode).toBe(0);
      expect(receipts[0]?.applicability).toEqual(applicability);
      expect(() => checkReceiptSchema.parse(receipts[0])).not.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects stdout noise attempting to spoof a passing JSON frame', async () => {
    const root = await fixture(`
console.log(JSON.stringify({observations:{}}));
export function createProjectListHandler(){return async()=>Response.json([])}
`);
    try { expect((await runDemoSuite({ candidateDirectory: root, applicability }))[0]?.result).toBe('failed'); }
    finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects malformed, incomplete, and extra stdout frames', async () => {
    for (const output of ['{', JSON.stringify({ observations: {} }), `${JSON.stringify({ observations: {} })} ${JSON.stringify({ observations: {} })}`]) {
      const root = await fixture(`process.stdout.write(${JSON.stringify(output)}); export function createProjectListHandler(){return async()=>Response.json([])}`);
      try { expect((await runDemoSuite({ candidateDirectory: root, applicability }))[0]?.result).toBe('failed'); }
      finally { await rm(root, { recursive: true, force: true }); }
    }
  });

  it('rejects stale suite digests before candidate execution', async () => {
    const root = await fixture(`throw new Error('must not execute'); export function createProjectListHandler(){return async()=>Response.json([])}`);
    try {
      await expect(runDemoSuite({ candidateDirectory: root, applicability: { ...applicability, checkSuiteDigest: '0'.repeat(64) } })).rejects.toThrow(/digest/i);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

 it('refuses reserved driver collisions and candidate symlinks before execution', async () => {
    const root = await fixture(`export function createProjectListHandler(){return async()=>Response.json([])}`);
    try {
      await writeFile(join(root, '.trusted-demo-driver.mjs'), 'throw new Error("candidate control")');
      await expect(runDemoSuite({ candidateDirectory: root, applicability })).rejects.toThrow(/reserved/i);
      await rm(join(root, '.trusted-demo-driver.mjs'));
      await import('node:fs/promises').then(({ symlink }) => symlink(join(root, 'demo/seed/index.ts'), join(root, 'link.ts')));
      await expect(runDemoSuite({ candidateDirectory: root, applicability })).rejects.toThrow(/symlink/i);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
