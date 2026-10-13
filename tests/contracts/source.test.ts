import { expect, it } from 'vitest';
import { viewInput, revisionInput } from '../../packages/contracts/index';
const ref = { changeId: 'api', revisionId: 'r1' };
const manifest = { baseVersion: 1, baseCommitOid: 'a'.repeat(40), contractVersion: 1, policyVersion: 1, orderedRevisions: [ref], excludedChangeIds: [], decisionRevisions: [], compositionVersion: 1 };
it('rejects duplicate or multiple revisions of one Change in an exact View', () => {
  expect(viewInput.safeParse({ ...manifest, orderedRevisions: [ref, ref] }).success).toBe(false);
  expect(viewInput.safeParse({ ...manifest, orderedRevisions: [ref, { ...ref, revisionId: 'r2' }] }).success).toBe(false);
  expect(viewInput.safeParse(manifest).success).toBe(true);
});
it('rejects duplicate dependency Changes instead of guessing a revision', () => {
  const revision = { baseCommitOid: 'a'.repeat(40), commitOid: 'b'.repeat(40), treeOid: 'c'.repeat(40), obligationIds: ['tenant'], decisionRevisions: [], dependencies: [ref, { ...ref, revisionId: 'r2' }] };
  expect(revisionInput.safeParse(revision).success).toBe(false);
});
