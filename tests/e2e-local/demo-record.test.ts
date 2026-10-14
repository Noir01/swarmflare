import { describe, expect, it } from 'vitest';
import { CAPTURE_ORDER, CHAPTERS, CHAPTER_SECONDS, PROJECT_ID, TREE, COMMIT, VIEW_ID, validateScope } from '../../demo/cloud/record-demo.js';

const repo = { id: PROJECT_ID, projectId: PROJECT_ID, status: 'ready', owner: 'smoke-0123456789abcdefabcd', name: 'probe-0123456789' };
const candidate = { projectId: PROJECT_ID, viewId: VIEW_ID, source: { treeOid: TREE }, view: { treeOid: TREE, commitOid: COMMIT, ref: `refs/agent/views/${VIEW_ID}` } };

describe('public browser recording scope', () => {
  it('accepts only the exact immutable fixture tuple and synthetic repo identifiers', () => {
    expect(validateScope(repo, candidate)).toEqual({ owner: repo.owner, name: repo.name, projectId: PROJECT_ID, viewId: VIEW_ID, commitOid: COMMIT, treeOid: TREE });
    for (const bad of [
      { ...candidate, viewId: 'B727454B-A7A1-4B8C-ABE6-04A2459BD5EA' },
      { ...candidate, source: { treeOid: 'b3aa432744d82309c46308ea92784a8b6584da3e' } },
      { ...candidate, view: { ...candidate.view, commitOid: 'f1e87cd12d5069d54ec23ec772a8031786fd95eF' } },
      { ...candidate, view: { ...candidate.view, ref: `refs/agent/views/${VIEW_ID.toUpperCase()}` } },
    ]) expect(() => validateScope(repo, bad)).toThrow('PUBLIC_FIXTURE_SCOPE_INVALID');
    expect(() => validateScope({ ...repo, owner: '../private' }, candidate)).toThrow('PUBLIC_FIXTURE_SCOPE_INVALID');
    expect(() => validateScope({ ...repo, name: 'probe-ABCDEF1234' }, candidate)).toThrow('PUBLIC_FIXTURE_SCOPE_INVALID');
  });
  it('fixes seven bounded chapters and preview-first capture for expiry safety', () => {
    expect(CHAPTERS).toEqual(['landing', 'tutorial', 'repository-readme', 'task-failure-history', 'ready-checks-diff', 'preview', 'connect-agent']);
    expect(CAPTURE_ORDER[0]).toBe('preview');
    expect(new Set(CAPTURE_ORDER)).toEqual(new Set(CHAPTERS));
    expect(CHAPTER_SECONDS).toBe(45);
    expect(CHAPTERS.length * 60).toBeLessThanOrEqual(7 * 60);
  });
});
