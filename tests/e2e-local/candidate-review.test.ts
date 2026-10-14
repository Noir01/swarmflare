import { describe, expect, it, vi } from 'vitest';
import { WorkspaceClient } from '../../packages/client/index.js';
import { demoPolicyManifest } from '../../apps/worker/src/generated/demo-policy.js';
import { recordIndependentReview, validateIndependentReview } from '../../demo/cloud/candidate-review.js';

const candidate = {
  projectId: 'project_1', viewId: 'view_1', policyVersion: 2,
  view: { commitOid: 'a'.repeat(40), treeOid: 'b'.repeat(40), ref: 'refs/agent/views/view_1' },
  findingIds: ['finding_1'],
};
const review = {
  viewId: candidate.viewId, commitOid: candidate.view.commitOid, treeOid: candidate.view.treeOid,
  policyVersion: candidate.policyVersion, verdict: 'passed' as const, findings: [],
  checkedObligations: demoPolicyManifest.contract.obligations.map((item) => item.id), summary: 'Mock exact-source review',
};

describe('independent candidate review', () => {
  it('accepts only a complete passing review anchored to the exact candidate', () => {
    expect(validateIndependentReview(candidate, review).review.verdict).toBe('passed');
    for (const invalid of [
      { ...review, verdict: 'failed' },
      { ...review, findings: ['finding'] },
      { ...review, viewId: 'view_other' },
      { ...review, commitOid: 'c'.repeat(40) },
      { ...review, policyVersion: 1 },
      { ...review, checkedObligations: review.checkedObligations.slice(1) },
      { ...review, checkedObligations: [...review.checkedObligations, review.checkedObligations[0]] },
      { ...review, checkedObligations: [...review.checkedObligations, 'unknown_obligation'] },
      { ...review, viewId: 'bad/id' },
    ]) expect(() => validateIndependentReview(candidate, invalid)).toThrow();
  });

  it('rejects failed/mismatched evidence before any API request or write', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = new WorkspaceClient({ baseUrl: 'https://example.test', projectId: candidate.projectId, token: 'mock-token', fetch: fetcher });
    const ports = { client, reviewerActorId: 'reviewer_1', requestKey: async () => 'key_1', readLocalSource: async () => ({ commitOid: candidate.view.commitOid, treeOid: candidate.view.treeOid }) };
    await expect(recordIndependentReview(ports, candidate, { ...review, verdict: 'failed' })).rejects.toThrow('REVIEW_NOT_PASSING');
    await expect(recordIndependentReview(ports, { ...candidate, view: { ...candidate.view, commitOid: 'bad' } }, review)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
