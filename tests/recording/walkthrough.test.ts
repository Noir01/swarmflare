import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inputPaths, renderPage, SLIDE_SECONDS, validateEvidence, VIDEO_SECONDS } from '../../demo/recording/walkthrough';

const temporary: string[] = [];
const validEvidence = () => {
  const base = { commitOid: 'base-commit', treeOid: 'base-tree', version: 1, receipt: { commitOid: 'base-commit', treeOid: 'base-tree' } };
  const readiness = { viewId: 'view-new', ready: true, blockers: [], findingIds: [], reviewIds: ['review-new'], applicability: { viewId: 'view-new', manifestDigest: 'manifest', composedCommitOid: 'commit-new', treeOid: 'tree-new', checkSuiteDigest: 'checks-digest' } };
  const review = { id: 'review-new', data: { verdict: 'passed', viewId: 'view-new', composedCommitOid: 'commit-new', treeOid: 'tree-new', manifestDigest: 'manifest', checkSuiteDigest: 'checks-digest' } };
  const original = { viewId: 'view-old', manifestDigest: 'old-manifest', composedCommitOid: 'commit-old', treeOid: 'old-tree', contractVersion: 1, policyVersion: 1 };
  const finding = { id: 'finding-1', data: { ...original, status: 'resolved', repairs: [{ changeId: 'repair-1' }], resolutionEvidence: { applicability: { ...readiness.applicability }, resolverId: 'reviewer', checkIds: ['api', 'ui'], reviewIds: ['review-new'], resolvedAt: '2026-01-01T00:00:00.000Z' } } };
  const capture = { label: 'AUTOMATED LOCAL FIXTURE — SYNTHETIC TEST DATA', captures: ['task', 'candidate', 'evidence', 'preview', 'feedback'].map(name => ({ name, file: `${name}.png`, sha256: 'a'.repeat(64) })) };
  return {
    [inputPaths[0]]: { ready: false, applicability: { composedCommitOid: 'commit-old' } },
    [inputPaths[1]]: [{ data: { verdict: 'failed' } }],
    [inputPaths[2]]: { id: 'finding-1', data: { ...original, status: 'open' } },
    [inputPaths[3]]: { ...base },
    [inputPaths[4]]: { passed: false, cases: [{ passed: false, observed: { tenant: 'tenant-b', ids: ['old-item'] } }] },
    [inputPaths[5]]: { id: 'finding-1', data: { ...original, status: 'repair-proposed' } },
    [inputPaths[6]]: { id: 'finding-1', data: { ...original, status: 'open' } },
    [inputPaths[7]]: { hash: 'commit-new', treeHash: 'tree-new', message: 'synthetic repair' },
    [inputPaths[8]]: { phase: 'checks', replacementViewId: 'view-new', baselineUnchanged: true, reviewArtifactId: 'artifact-1', checks: [{ checkId: 'mandatory-demo-api', result: 'passed' }, { checkId: 'mandatory-demo-ui', result: 'passed' }] },
    [inputPaths[9]]: [review],
    [inputPaths[10]]: finding,
    [inputPaths[11]]: readiness,
    [inputPaths[12]]: { ...base },
    [inputPaths[13]]: { commitOid: 'commit-new', treeOid: 'tree-new', passed: true, cases: [{ passed: true }] },
    [inputPaths[14]]: capture,
  };
};

afterEach(async () => { await Promise.all(temporary.splice(0).map(p => rm(p, { recursive: true, force: true }))); });

describe('walkthrough pure helpers', () => {
  it('validates explicitly synthetic receipt samples without reading reports', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'walkthrough-synthetic-'));
    temporary.push(dir);
    const sample = validEvidence();
    const file = join(dir, 'synthetic.json');
    await writeFile(file, JSON.stringify(sample));
    expect(validateEvidence(JSON.parse(await (await import('node:fs/promises')).readFile(file, 'utf8'))).composedRace.passed).toBe(true);
  });

  it('cross-validates review, checks, finding and baseline applicability', () => {
    const sample = validEvidence();
    sample[inputPaths[9]][0].data.treeOid = 'wrong-tree';
    expect(() => validateEvidence(sample)).toThrow(/review applicability/);
  });

  it('requires the composed race receipt to match exact commit and tree', () => {
    const sample = validEvidence();
    sample[inputPaths[13]].treeOid = 'wrong-tree';
    expect(() => validateEvidence(sample)).toThrow(/composed race probe/);
  });

  it('requires resolution applicability to match exact ready and review tuple', () => {
    const sample = validEvidence();
    sample[inputPaths[10]].data.resolutionEvidence.applicability.treeOid = 'other-tree';
    expect(() => validateEvidence(sample)).toThrow(/resolution evidence/);
  });

  it('rejects resolution evidence for a different replacement View', () => {
    const sample = validEvidence();
    sample[inputPaths[10]].data.resolutionEvidence.applicability.viewId = 'other-view';
    expect(() => validateEvidence(sample)).toThrow(/resolution evidence/);
  });

  it('rejects mutation of the immutable original finding anchor', () => {
    const sample = validEvidence();
    sample[inputPaths[10]].data.treeOid = 'mutated-original-tree';
    expect(() => validateEvidence(sample)).toThrow(/original finding anchor/);
  });

  it('rejects traversing and duplicate capture filenames or names', () => {
    const traversal = validEvidence();
    traversal[inputPaths[14]].captures[0].file = '../secret.png';
    expect(() => validateEvidence(traversal)).toThrow(/unsafe fixture capture path/);
    const duplicate = validEvidence();
    duplicate[inputPaths[14]].captures[1].file = 'task.png';
    expect(() => validateEvidence(duplicate)).toThrow(/duplicate fixture capture filename/);
  });

  it('escapes interpolated text once, preserves ampersands as entities, and embeds only supplied data URIs', () => {
    const html = renderPage('<title>', 'A & B < C', 'tag "quoted"', 0, 'data:image/png;base64,AA==');
    expect(html).toContain('&lt;title&gt;');
    expect(html).toContain('A &amp; B &lt; C');
    expect(html).toContain('data:image/png;base64,AA==');
    expect(html).not.toContain('file://');
  });

  it('defines eight chapters whose explicit plan is 320 seconds', () => {
    expect(8 * SLIDE_SECONDS).toBe(VIDEO_SECONDS);
    expect(VIDEO_SECONDS).toBe(320);
  });
});
