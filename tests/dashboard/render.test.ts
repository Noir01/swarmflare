import { describe, expect, it } from 'vitest';
import { dashboardHtml, dashboardScript } from '../../apps/dashboard/index.js';

describe('human operations dashboard', () => {
  it('renders a static accessible operating surface with required controls', () => {
    for (const id of ['login-form','project-id','human-token','login-submit','view-id','inspect-view','task-outcome','blockers','confirmation-button','accept-button','status','logout-button','baseline-tuple','decision-id','decision-kind','decision-note','decision-lookup','decision-tuple','resolve-decision']) {
      expect(dashboardHtml).toContain(`id="${id}"`);
    }
    expect(dashboardHtml).toContain('type="password"');
    expect(dashboardHtml).toContain('OPERATE');
    expect(dashboardHtml).not.toMatch(/https?:\/\//);
  });

  it('uses same-origin APIs, keeps credentials transient, and renders untrusted values as text', () => {
    expect(dashboardScript).toContain("'/dashboard/session'");
    expect(dashboardScript).toContain("api('GET','/context')");
    expect(dashboardScript).toContain('textContent');
    expect(dashboardScript).not.toMatch(/localStorage|sessionStorage|innerHTML/);
    expect(dashboardScript).toContain('/confirmations');
    expect(dashboardScript).toContain('/acceptances');
    expect(dashboardScript).toContain('readinessSequence');
    expect(dashboardScript).toContain('expectedBaselineVersion');
    expect(dashboardScript).toContain('includedRevisions');
    expect(dashboardScript).toContain('excludedChangeIds');
    expect(dashboardScript).toContain('conf.data.readinessSequence');
    expect(dashboardScript).toContain('accepted.resource.data.newBaseline');
    expect(dashboardScript).toContain('function invalidateView()');
    expect(dashboardScript).toContain("'/decisions/'+encodeURIComponent(d.id)+'/resolve'");
    expect(dashboardScript).toContain('expectedVersion:d.version');
    expect(dashboardScript).toContain('payload:{kind,contractVersion,note}');
    expect(dashboardScript).toContain("d.data.status==='needs-human'");
    expect(dashboardScript).toContain("status('Accepted and verified exact baseline tuple '");
    expect(dashboardScript).not.toContain('resource.newBaseline');
  });
});
