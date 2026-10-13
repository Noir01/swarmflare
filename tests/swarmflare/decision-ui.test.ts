import { describe, expect, it } from 'vitest';
import { repositoryHtml } from '../../apps/swarmflare/repository';
import { siteScript } from '../../apps/swarmflare/site';

const base: any = {
  repository: { owner: 'ada', name: 'repo', projectId: 'project-1' }, canManage: true,
  baseline: { version: 3, commitOid: 'a'.repeat(40), treeOid: 'b'.repeat(40) },
  candidate: {
    id: 'view-1', title: 'Reviewed candidate', status: 'runnable',
    resource: { id: 'view-1', version: 4, data: { status: 'runnable', manifestDigest: 'c'.repeat(64), manifest: { contractVersion: 2, policyVersion: 3, orderedRevisions: [{ changeId: 'change-1', revisionId: 'revision-1' }] }, receipt: { backend: 'artifacts-git', ref: 'refs/agent/views/view-1', commitOid: 'd'.repeat(40), treeOid: 'e'.repeat(40) } } },
    readiness: { ready: true, blockers: [], applicability: { projectId: 'project-1', viewId: 'view-1', manifestDigest: 'c'.repeat(64), composedCommitOid: 'd'.repeat(40), treeOid: 'e'.repeat(40), contractVersion: 2, policyVersion: 3, checkSuiteDigest: 'f'.repeat(64) }, sequence: 17 },
    sourceVerification: { data: { viewId: 'view-1', receipt: { backend: 'artifacts-git', ref: 'refs/agent/views/view-1', commitOid: 'd'.repeat(40), treeOid: 'e'.repeat(40) }, verifiedAt: Date.now() } },
    changesById: { 'change-1': { id: 'change-1', owner: 'agent-1', data: { title: 'Add pagination', revisions: [{ revisionId: 'revision-1', obligationIds: ['obligation-1'] }] } } },
    contract: { data: { outcome: 'Improve paging', obligations: [{ id: 'obligation-1', description: 'Keep cursor stable' }] } }, findings: []
  }
};

describe('candidate decision UI', () => {
  it('shows a reviewed snapshot only to the owner when ready, baselined, and source-verified', () => {
    const html = repositoryHtml(base);
    expect(html).toContain('Confirm reviewed snapshot');
    expect(html).toContain('Passing checks are evidence, not a guarantee');
    expect(html).toContain('name="reviewed"');
    expect(html).toContain('Add pagination');
    for (const model of [
      { ...base, canManage: false }, { ...base, baseline: null },
      { ...base, candidate: { ...base.candidate, readiness: { ready: false, blockers: [{ message: 'Missing review' }] } } },
      { ...base, candidate: { ...base.candidate, sourceVerification: { data: { viewId: 'view-1', receipt: base.candidate.resource.data.receipt, verifiedAt: 1 } } } },
      { ...base, candidate: { ...base.candidate, sourceVerification: { data: { viewId: 'view-1', receipt: { ...base.candidate.resource.data.receipt, commitOid: '9'.repeat(40) }, verifiedAt: Date.now() } } } },
      { ...base, candidate: { ...base.candidate, sourceVerification: { data: { viewId: 'view-1', receipt: base.candidate.resource.data.receipt, verifiedAt: Date.now() + 1000 } } } },
      { ...base, candidate: { ...base.candidate, readiness: { ...base.candidate.readiness, ready: false } } },
      { ...base, canManage: false },
      { ...base, candidate: { ...base.candidate, sourceVerification: null } }
    ]) expect(repositoryHtml(model)).not.toContain('Confirm reviewed snapshot');
  });
  it('escapes source labels and keeps raw identity data collapsed', () => {
    const change = base.candidate.changesById['change-1'];
    const html = repositoryHtml({ ...base, candidate: { ...base.candidate, changesById: { 'change-1': { ...change, data: { ...change.data, title: '<script>x</script>' } } } } });
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('<details><summary>Technical identifiers</summary>');
  });
  it('uses separate explicit confirmation and acceptance clicks with fresh snapshot checks and exact returned token fields', () => {
    expect(siteScript).toContain("button.confirm-candidate");
    expect(siteScript).toContain("button.accept-candidate");
    expect(siteScript).toContain("'/source-verification'");
    expect(siteScript).toContain('expectedBaselineVersion:b.version');
    expect(siteScript).toContain('readinessSequence:readiness.sequence');
    expect(siteScript).toContain('confirmationId:conf.id');
    expect(siteScript).toContain('ap.checkSuiteDigest!==snapshot.checkSuiteDigest');
    expect(siteScript).toContain('JSON.stringify(verified.receipt)!==JSON.stringify(receipt)');
    expect(siteScript).toContain("button.dataset.confirmation=''");
    expect(siteScript).not.toContain('localStorage');
    expect(siteScript).not.toContain('sessionStorage');
  });
});
