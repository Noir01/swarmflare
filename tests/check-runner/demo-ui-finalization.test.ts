import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { demoUiSuiteDigest, runDemoUiSuite } from '../../packages/git-runner/checks/demo-ui-suite.js';
import { buildPaginatedDemo, paginatedClientScript, preparedPaginatedDemo } from '../fixtures/paginated-demo.js';

const applicability = { projectId: 'demo-project', viewId: 'demo-view', manifestDigest: 'a'.repeat(64), composedCommitOid: 'b'.repeat(40), treeOid: 'c'.repeat(40), contractVersion: 1, policyVersion: 1, checkSuiteDigest: demoUiSuiteDigest() };
async function run(source: string) {
  const root = await mkdtemp(join(tmpdir(), 'demo-ui-finalize-'));
  await mkdir(join(root, 'demo/seed'), { recursive: true });
  await writeFile(join(root, 'demo/seed/index.ts'), source);
  try { return (await runDemoUiSuite({ candidateDirectory: root, applicability }))[0]!; }
  finally { await rm(root, { recursive: true, force: true }); }
}

describe('demo UI finalization', () => {
  it('keeps the successful six-event run and emits complete valid bounded JSON', async () => {
    const receipt = await run(preparedPaginatedDemo);
    expect(receipt.result).toBe('passed');
    expect(() => JSON.parse(receipt.execution.stdout)).not.toThrow();
    expect(Buffer.byteLength(receipt.execution.stdout)).toBeLessThanOrEqual(32768);
    expect(JSON.parse(receipt.execution.stdout).facts.events).toHaveLength(6);
  }, 45000);

  it('records an unknown route accepted by the final tenant load before selecting the result', async () => {
    const script = `const originalFetch=fetch;let apiCalls=0;fetch=async(...args)=>{const response=await originalFetch(...args);if(String(args[0]).startsWith('/api/projects?')&&++apiCalls===6)void originalFetch('/unknown-route').catch(()=>{});return response};${paginatedClientScript}`;
    const receipt = await run(buildPaginatedDemo(script));
    expect(receipt.result).toBe('failed');
    const facts = JSON.parse(receipt.execution.stdout).facts;
    expect(facts.failures.join(' ')).toMatch(/Unknown UI route blocked/);
    expect(facts.requests.some((request: { url: string }) => request.url.endsWith('/unknown-route'))).toBe(true);
  }, 45000);
});
