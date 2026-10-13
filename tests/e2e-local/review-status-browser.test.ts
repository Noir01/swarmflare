import { afterEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { dashboardHtml, dashboardScript } from '../../apps/dashboard/index';
import { launchLocalBrowser } from '../../packages/browser-test/index';

let server: Server | undefined;
let browser: Awaited<ReturnType<typeof launchLocalBrowser>> | undefined;
afterEach(async () => { await browser?.close(); browser = undefined; await new Promise<void>(resolve => server?.close(() => resolve()) ?? resolve()); server = undefined; });

it('renders status evidence and candidate states in the real dashboard script (synthetic rendering fixture)', async () => {
  const app = { projectId: 'fixture-project', viewId: 'view-runnable', manifestDigest: '1'.repeat(64), composedCommitOid: 'c'.repeat(40), treeOid: 'd'.repeat(40), contractVersion: 1, policyVersion: 2, checkSuiteDigest: '2'.repeat(64) };
  const contract = { version: 1, data: { outcome: 'Synthetic rendering fixture', obligations: [{ id: 'ob-a', description: 'First requirement' }, { id: 'ob-b', description: 'Second requirement' }], requiredCheckIds: ['check-pass', 'check-fail', 'check-missing'] } };
  const checkKeys = ['projectId', 'viewId', 'manifestDigest', 'composedCommitOid', 'treeOid', 'contractVersion', 'policyVersion', 'checkSuiteDigest'] as const;
  const reviewKeys = ['viewId', 'manifestDigest', 'composedCommitOid', 'treeOid', 'contractVersion', 'policyVersion', 'checkSuiteDigest'] as const;
  const staleValue = (key: string) => key === 'contractVersion' || key === 'policyVersion' ? 99 : key === 'manifestDigest' || key === 'checkSuiteDigest' ? 'f'.repeat(64) : key === 'composedCommitOid' || key === 'treeOid' ? 'f'.repeat(40) : `stale-${key}`;
  const records = [
    { id: 'check-p', version: 1, data: { applicability: app, checkId: 'check-pass', obligationIds: ['ob-a'], harnessVersion: 'json-oracle-v1', result: 'passed' } },
    { id: 'check-f', version: 1, data: { applicability: app, checkId: 'check-fail', obligationIds: ['ob-a'], harnessVersion: 'json-oracle-v1', result: 'failed' } },
    ...checkKeys.map(key => ({ id: `check-stale-${key}`, version: 1, data: { applicability: { ...app, [key]: staleValue(key) }, checkId: 'check-pass', obligationIds: ['ob-a'], harnessVersion: 'json-oracle-v1', result: 'passed' } })),
  ];
  const reviews = [{ id: 'review-good', version: 1, data: { ...reviewsTuple(app), obligationIds: ['ob-a', 'ob-b'], verdict: 'passed', findings: [] } }, ...reviewKeys.map(key => ({ id: `review-stale-${key}`, version: 1, data: { ...reviewsTuple(app), [key]: staleValue(key), obligationIds: ['ob-a', 'ob-b'], verdict: 'passed', findings: [] } }))];
  const candidates = ['runnable', 'queued', 'failed'].map((status, i) => ({ id: `view-${status}`, version: 1, data: { status, manifest: { orderedRevisions: [] } } }));
  const resolutionKeys = checkKeys;
  const staleResolutionIds = resolutionKeys.map(key => `finding-stale-resolution-${key}`);
  const ready = { viewId: app.viewId, ready: false, sequence: 1, applicability: app, findingIds: ['finding-open', ...staleResolutionIds], blockers: [{ code: 'FINDING_OPEN', message: 'Active issue', findingId: 'finding-open' }], coverage: [{ obligationId: 'ob-a', checkIds: ['check-pass'], reviewIds: ['review-good'] }, { obligationId: 'ob-b', checkIds: [], reviewIds: ['review-good'] }] };
  const findings = [
    { id: 'finding-open', version: 1, data: { status: 'open', summary: 'Active blocker', obligationIds: ['ob-a'], ...app } },
    ...resolutionKeys.map(key => ({ id: `finding-stale-resolution-${key}`, version: 1, data: { status: 'resolved', summary: 'Stale resolution', obligationIds: ['ob-a'], ...app, resolutionEvidence: { applicability: { ...app, [key]: staleValue(key) } } } })),
    { id: 'finding-resolved-history', version: 1, data: { status: 'resolved', summary: 'Correctly cleared', resolution: 'Verified resolution', obligationIds: ['ob-b'], viewId: 'view-old', manifestDigest: app.manifestDigest, composedCommitOid: app.composedCommitOid, treeOid: 'e'.repeat(40), contractVersion: app.contractVersion, policyVersion: app.policyVersion, resolutionEvidence: { applicability: app } } },
  ];
  const response = (resource: unknown) => JSON.stringify({ resource });
  server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost'); res.setHeader('content-type', 'application/json');
    if (url.pathname === '/dashboard') { res.setHeader('content-type', 'text/html'); res.end(dashboardHtml); return; }
    if (url.pathname === '/dashboard/app.js') { res.setHeader('content-type', 'text/javascript'); res.end(dashboardScript); return; }
    if (url.pathname === '/dashboard/session' && req.method === 'GET') { res.statusCode = 401; res.end('{}'); return; }
    if (url.pathname === '/dashboard/session' && req.method === 'POST') { res.end(JSON.stringify({ csrf: 'synthetic-csrf' })); return; }
    const path = url.pathname.replace('/dashboard/api', '');
    const values: Record<string, unknown> = {
      '/context': { contract, claims: [], decisions: [], findings },
      '/views': candidates,
      '/views/view-runnable': candidates[0], '/views/view-queued': candidates[1], '/views/view-failed': candidates[2],
      '/views/view-runnable/readiness': ready, '/views/view-runnable/checks': records, '/views/view-runnable/reviews': reviews,
      '/baseline': { version: 1, commitOid: 'a'.repeat(40), treeOid: 'b'.repeat(40) },
      '/policy': { data: { checks: [{ id: 'check-pass', obligationIds: ['ob-a', 'ob-b'] }, { id: 'check-fail', obligationIds: ['ob-a'] }, { id: 'check-missing', obligationIds: ['ob-a', 'ob-b'] }], harnessVersion: 'json-oracle-v1', checkSuiteDigest: app.checkSuiteDigest } },
      '/views/view-runnable/review-artifact': null,
      '/findings': findings,
    };
    const value = values[path];
    if (path.includes('/changes/')) { res.end(response({ id: path.split('/').pop(), owner: 'contributor', data: { title: 'Synthetic change' } })); return; }
    res.end(response(value === undefined ? {} : value));
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No local test server address');
  browser = await launchLocalBrowser({ timeoutMs: 20_000 }); await browser.send('Page.enable', {}, browser.pageSessionId);
  await browser.send('Page.navigate', { url: `http://127.0.0.1:${address.port}/dashboard` }, browser.pageSessionId);
  const evaluate = async (expression: string) => (await browser!.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, browser!.pageSessionId)).result.value;
  const wait = async (expr: string) => { const end = Date.now() + 8000; while (Date.now() < end) { if (await evaluate(expr)) return; await new Promise(r => setTimeout(r, 50)); } throw new Error(`Timed out ${expr}`); };
  await wait(`document.getElementById('login-submit')?.disabled===false`);
  await evaluate(`document.getElementById('project-id').value='fixture-project';document.getElementById('human-token').value='synthetic-only';document.getElementById('login-form').requestSubmit()`);
  await wait(`!document.getElementById('workspace').classList.contains('hidden')`);
  await wait(`document.getElementById('view-id').value==='view-runnable' && document.getElementById('feedback-pending').innerText.includes('finding-open')`);
  const evidence = await evaluate(`document.getElementById('requirement-summary').textContent`);
  expect(evidence).toContain('Check check-pass: passed'); expect(evidence).toContain('Check check-fail: failed'); expect(evidence).toContain('Check check-missing: missing');
  expect(evidence).toContain('Independent review: passed');
  expect(evidence).not.toContain('review-stale-'); expect(evidence).not.toContain('check-stale-');
  const anchors = await evaluate(`(()=>{const as=[...document.querySelectorAll('#requirement-summary a[href^="#"]')];return {ids:as.map(a=>a.getAttribute('href')),targets:as.map(a=>!!document.getElementById(decodeURIComponent(a.getAttribute('href').slice(1))))}})()`);
  expect(new Set(anchors.ids).size).toBe(anchors.ids.length); expect(anchors.targets.every(Boolean)).toBe(true);
  const candidateText = await evaluate(`document.getElementById('candidate-list').innerText`);
  expect(candidateText).toContain('runnable'); expect(candidateText).toContain('queued'); expect(candidateText).toContain('failed'); expect(candidateText).not.toContain('not marked runnable');
  const pending = await evaluate(`document.getElementById('feedback-pending').innerText`);
  const history = await evaluate(`document.getElementById('feedback-history').innerText`);
  expect(pending).toContain('finding-open');
  expect(history).toContain('finding-resolved-history');
  expect(history).not.toContain('finding-stale-resolution-');
  for (const id of staleResolutionIds) expect(pending).toContain(id);
  expect(pending).not.toContain('finding-resolved-history');
});

function reviewsTuple(app: Record<string, unknown>) { const { projectId: _projectId, ...review } = app; return review; }
