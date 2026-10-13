import { describe, expect, it } from 'vitest';
import { findingInput, findingDataSchema, findingResourceSchema, repairInput, resolveInput, reviewInput, reviewDataSchema, reviewResourceSchema, readinessSchema, findingsListSchema } from '../../packages/contracts/feedback';

const anchor = { viewId: 'view1', manifestDigest: 'd'.repeat(64), composedCommitOid: 'a'.repeat(40), treeOid: 'b'.repeat(40), contractVersion: 1, policyVersion: 2 };
const finding = { ...anchor, obligationIds: ['tenant'], affectedChangeIds: ['ui'], paths: ['src/list.ts'], expected: 'is isolated', observed: 'leaks rows', nextOwner: 'repairer' };
const review = { ...anchor, obligationIds: ['tenant'], summary: 'Inspected candidate and checks.', verdict: 'failed' as const, findings: ['finding1'] };

describe('feedback contracts', () => {
  it('accepts exact finding and review evidence anchors', () => {
    expect(findingInput.parse(finding)).toEqual(finding);
    expect(reviewInput.parse(review)).toEqual(review);
    expect(findingDataSchema.parse({ ...finding, status: 'open' })).toMatchObject({ repairs: [], resolution: null });
    expect(reviewDataSchema.parse(review)).toEqual(review);
  });
  it('rejects extra keys and malformed required inputs', () => {
    expect(findingInput.safeParse({ ...finding, reporter: 'spoofed' }).success).toBe(false);
    expect(reviewInput.safeParse({ ...review, extra: true }).success).toBe(false);
    expect(findingInput.safeParse({ ...finding, obligationIds: [] }).success).toBe(false);
    expect(repairInput.safeParse({ revisions: [] }).success).toBe(false);
    expect(resolveInput.safeParse({ viewId: 'view1', note: '' }).success).toBe(false);
  });
  it('rejects unsafe relative paths', () => {
    for (const path of ['../secret', 'src/../secret', '.git/config', '/etc/passwd', 'src/\u0000file', 'src\\file']) {
      expect(findingInput.safeParse({ ...finding, paths: [path] }).success, path).toBe(false);
    }
  });
  it('enforces unique repair Change IDs and standard resource/list shapes', () => {
    expect(repairInput.safeParse({ revisions: [{ changeId: 'ui', revisionId: 'r1' }, { changeId: 'ui', revisionId: 'r2' }] }).success).toBe(false);
    expect(findingResourceSchema.safeParse({ id: 'f1', version: 1, owner: 'owner', data: { ...finding, status: 'open' } }).success).toBe(true);
    expect(reviewResourceSchema.safeParse({ id: 'r1', version: 1, owner: 'reviewer', data: review }).success).toBe(true);
    expect(findingsListSchema.safeParse([{ id: 'f1', version: 1, owner: 'owner', data: { ...finding, status: 'open' } }]).success).toBe(true);
  });
  it('validates readiness blockers without implying check evidence', () => {
    expect(readinessSchema.safeParse({ viewId: 'view1', ready: false, blockers: [{ code: 'EVIDENCE_MISSING', message: 'Fresh evidence required.' }], findingIds: ['f1'], reviewIds: [] }).success).toBe(true);
    expect(readinessSchema.safeParse({ viewId: 'view1', ready: true, blockers: [], findingIds: [], reviewIds: [], checksPassed: true }).success).toBe(false);
  });
});
