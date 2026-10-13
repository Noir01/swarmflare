import { describe, expect, it } from 'vitest';
import { dashboardHtml, dashboardScript } from '../../apps/dashboard/index.js';

describe('human review surface', () => {
  it('offers candidate discovery and readable task-first review regions', () => {
    for (const id of ['candidate-list', 'review-summary', 'review-artifact', 'preview-host', 'feedback-panel']) {
      expect(dashboardHtml).toContain(`id="${id}"`);
    }
    expect(dashboardScript).toContain("api('GET','/views')");
    expect(dashboardScript).toContain("'/review-artifact'");
    expect(dashboardScript).toContain("api('GET','/changes/'+encodeURIComponent");
    expect(dashboardScript).toContain('renderFeedback({view:');
    expect(dashboardScript).toContain('clearFeedback()');
  });

  it('uses safe DOM text, isolates supported previews, and pins async inspection', () => {
    expect(dashboardScript).toContain('textContent');
    expect(dashboardScript).toContain("setAttribute('sandbox','allow-scripts')");
    expect(dashboardScript).toContain("referrerPolicy='no-referrer'");
    expect(dashboardScript).toContain('inspectGeneration');
    expect(dashboardHtml).toContain('44px');
    expect(dashboardScript).not.toMatch(/innerHTML|allow-same-origin/);
  });

  it('pins included changes by changeId, displays owner metadata, and defers preview until clicked', () => {
    expect(dashboardScript).toContain("encodeURIComponent(ref.changeId)");
    expect(dashboardScript).toContain("change?.owner||'owner unavailable'");
    expect(dashboardScript).toContain("$('try-preview').addEventListener('click'");
    expect(dashboardScript).toContain('Number(state.preview?.expiresAt)');
    expect(dashboardScript).toContain("setAttribute('sandbox','allow-scripts')");
    expect(dashboardScript).toMatch(/loadContext\(\)[\s\S]*?await loadCandidates/);
    expect(dashboardScript).toContain('contextGeneration');
    expect(dashboardScript).toContain('discoveryGeneration');
    expect(dashboardHtml).toContain('<details><summary>Context and diagnostics</summary>');
    expect(dashboardHtml).toContain('<summary>Exact tuple and diagnostics</summary>');
  });

  it('renders requirement-linked evidence and readable blockers outside diagnostics', () => {
    expect(dashboardHtml).toContain('id="requirement-summary"');
    expect(dashboardScript).toContain("reviewKeys=['viewId','manifestDigest','composedCommitOid','treeOid','contractVersion','policyVersion','checkSuiteDigest']");
    expect(dashboardScript).toContain("findingKeys=['viewId','manifestDigest','composedCommitOid','treeOid','contractVersion','policyVersion']");
    expect(dashboardScript).toContain('renderRequirements(state.context?.contract');
    expect(dashboardScript).toContain('No active blockers.');
    expect(dashboardScript).not.toContain("JSON.stringify(value)");
    expect(dashboardScript).toContain('Independent review: ');
  });

  it('keeps evidence links resolvable and prevents historical evidence from reading as current status', () => {
    expect(dashboardScript).toContain("a.href='#'+anchor+'-'+encodeURIComponent(matching[0].id)");
    expect(dashboardScript).toContain("details.id=anchor+'-'+encodeURIComponent(c.id)");
    expect(dashboardScript).toContain("(failed?'failed':passed?'passed':'missing')");
    expect(dashboardScript).toContain('active blocker (including stale resolution); current blocker status is shown above.');
    expect(dashboardScript).toContain('historical resolved feedback record only.');
    expect(dashboardScript).toContain('No valid, unexpired supported project-list demo preview is available.');
  });

  it('fails closed during sign-in bootstrap and preserves change identity on missing fetches', () => {
    expect(dashboardHtml).toContain('<form id="login-form" method="post">');
    expect(dashboardHtml).toContain('id="login-submit" type="submit" disabled');
    expect(dashboardScript).toContain("loadSession().catch(e=>{if(e.message!=='Session expired. Sign in again.')status('Sign in to begin.');}).finally(()=>$('login-submit').disabled=false)");
    expect(dashboardScript).toContain("if($('login-submit').disabled)return");
    expect(dashboardScript).toContain("finally{$('login-submit').disabled=false;}");
    expect(dashboardScript).toContain("new Map((state.reviewChanges||[]).map(item=>[item.changeId,item.change]))");
    expect(dashboardScript).toContain("'Change details unavailable'");
    expect(dashboardScript).toContain('changes:(state.reviewChanges||[]).map(item=>item.change).filter(Boolean)');
  });

  it('expires previews without destroying the selected review or feedback draft', () => {
    expect(dashboardScript).toContain('function expirePreview()');
    expect(dashboardScript).toContain('setTimeout(()=>expirePreview(),remaining)');
    expect(dashboardScript).not.toContain('setTimeout(()=>invalidateView(),remaining)');
    expect(dashboardScript).toContain('function expirePreview(){');
    expect(dashboardScript).toContain("const message='Preview expired.");
    expect(dashboardScript).toContain("$('try-preview').addEventListener('click'");
    expect(dashboardScript).toContain("expirePreview();status('Preview expired.");
    expect(dashboardScript).toContain('clearConfirmation()');
  });

  it('labels candidates without relying on opaque IDs and explains artifact regeneration', () => {
    expect(dashboardHtml).toContain('Advanced: inspect by manual View ID');
    expect(dashboardScript).toContain('trusted local operator to regenerate the review-artifact');
    expect(dashboardScript).toContain('refreshing or inspecting does not regenerate it.');
  });

  it('projects assigned checks and active findings without treating passing coverage as the policy', () => {
    expect(dashboardScript).toContain("view.data?.status||'unknown'");
    expect(dashboardScript).not.toContain('not marked runnable');
    expect(dashboardScript).toContain('policy?.data?.checks||[]');
    expect(dashboardScript).toContain("c.data?.harnessVersion==='json-oracle-v1'");
    expect(dashboardScript).toContain("f.data.status==='resolved'");
    expect(dashboardScript).toContain("(coverage.reviewIds||[]).includes(x.id)");
    expect(dashboardScript).toContain('Reviews are project-scoped by API');
  });

  it('binds displayed source artifacts to the live readiness and baseline tuple', () => {
    expect(dashboardScript).toContain('sameArtifactSource(artifact,readiness.applicability,state.baseline?.resource)');
    expect(dashboardScript).toContain('Source diff and preview are unavailable; refresh and inspect again.');
  });
});
