import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { dashboardScript } from '../../apps/dashboard/index.js';

function renderHarness() {
  const start = dashboardScript.indexOf('async function renderReview(');
  let depth = 0, end = -1, quoted = '';
  for (let i = dashboardScript.indexOf('{', start); i < dashboardScript.length; i++) {
    const c = dashboardScript[i];
    if (quoted) { if (c === quoted && dashboardScript[i - 1] !== '\\') quoted = ''; continue; }
    if (c === '"' || c === "'" || c === '`') { quoted = c; continue; }
    if (c === '{') depth++;
    if (c === '}' && --depth === 0) { end = i + 1; break; }
  }
  const source = dashboardScript.slice(start, end);
  const helperStart = dashboardScript.indexOf('const checkKeys=');
  const helperEnd = dashboardScript.indexOf('\n', dashboardScript.indexOf('function sameArtifactSource', helperStart));
  const tupleHelpers = dashboardScript.slice(helperStart, helperEnd);
  const elements = new Map<string, any>();
  const document = { createElement: (tag: string) => ({ tag, textContent: '', children: [] as any[], append(...children: any[]) { this.children.push(...children); }, replaceChildren(...children: any[]) { this.children = children; } }), createTextNode: (text: string) => ({ textContent: text }) };
  for (const id of ['view-id', 'review-summary', 'review-artifact', 'try-preview', 'preview-host']) elements.set(id, { value: 'v1', textContent: '', children: [] as any[], disabled: false, append(...children: any[]) { this.children.push(...children); }, replaceChildren(...children: any[]) { this.children = children; } });
  const state = { inspectGeneration: 1, reviewChanges: [], baseline: { resource: { version: 7, commitOid: 'base-commit', treeOid: 'base-tree' } }, preview: null as any, previewTimer: null as any };
  const harness = runInNewContext(`${tupleHelpers}; (${source})`, { document, state, $: (id: string) => elements.get(id), setTimeout: () => 1, clearTimeout() {}, Date });
  const app: Record<string, any> = { projectId:'p', viewId:'v1', manifestDigest:'m', composedCommitOid:'c', treeOid:'t', contractVersion:1, policyVersion:2, checkSuiteDigest:'s' };
  const baseline: Record<string, any> = { version:7, commitOid:'base-commit', treeOid:'base-tree' };
  const artifact = (): any => ({ data: { applicability:{...app}, baseline:{...baseline}, diff:{ files:['src/a.ts'], patch:'valid diff' }, preview:{ supported:'project-list-demo-v1', html:'<main/>', expiresAt:Date.now()+60_000 } } });
  const render = (a = artifact()) => harness({ id:'v1', version:1, data:{status:'ready',manifest:{orderedRevisions:[]}} }, { applicability:app }, [], a, 1);
  return { render, app, baseline, artifact, elements, state };
}

describe('dashboard artifact source binding', () => {
  it('renders a diff only for an exact applicability and baseline match', async () => {
    const h = renderHarness();
    await h.render();
    expect(h.elements.get('review-artifact').children.map((x: any) => x.textContent).join(' ')).toContain('valid diff');
    expect(h.elements.get('try-preview').disabled).toBe(false);
  });

  it('rejects every mismatched applicability key and each baseline identity field', async () => {
    const h = renderHarness();
    for (const key of Object.keys(h.app)) {
      const candidate = h.artifact(); candidate.data.applicability[key] = `wrong-${key}`;
      await h.render(candidate);
      expect(h.elements.get('review-artifact').children.map((x: any) => x.textContent).join(' '), key).not.toContain('valid diff');
      expect(h.elements.get('try-preview').disabled, key).toBe(true);
    }
    for (const key of ['version', 'commitOid', 'treeOid']) {
      const candidate = h.artifact(); candidate.data.baseline[key] = key === 'version' ? 8 : `wrong-${key}`;
      await h.render(candidate);
      expect(h.elements.get('review-artifact').children.map((x: any) => x.textContent).join(' '), key).not.toContain('valid diff');
      expect(h.elements.get('try-preview').disabled, key).toBe(true);
    }
  });

  it('keeps a valid diff when preview data is null', async () => {
    const h = renderHarness(), candidate = h.artifact();
    candidate.data.preview = null;
    await h.render(candidate);
    expect(h.elements.get('review-artifact').children.map((x: any) => x.textContent).join(' ')).toContain('valid diff');
    expect(h.elements.get('try-preview').disabled).toBe(true);
  });
});
