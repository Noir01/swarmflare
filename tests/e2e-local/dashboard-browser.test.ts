import { afterEach, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { sourceRef } from '../../packages/contracts/source';
import { launchLocalBrowser } from '../../packages/browser-test/index';

let runtime: Miniflare | undefined;
let browser: Awaited<ReturnType<typeof launchLocalBrowser>> | undefined;
afterEach(async () => { await browser?.close(); browser = undefined; await runtime?.dispose(); runtime = undefined; });

it('inspects synthetic acceptance evidence through the real localhost dashboard', async () => {
  const projectId = 'dashboard-browser-synthetic';
  const tokens = { human: 'human-synthetic-only', contributor: 'contributor-synthetic-only', reviewer: 'reviewer-synthetic-only', runner: 'runner-synthetic-only' };
  const roles = Object.keys(tokens) as Array<keyof typeof tokens>;
  const credentials = roles.map(id => ({ id, projectId, role: id, tokenHash: createHash('sha256').update(tokens[id]).digest('hex'), expiresAt: Date.now() + 300_000 }));
  const key = 'a'.repeat(64);
  const bundle = await build({ entryPoints: ['apps/worker/src/index.ts'], bundle: true, platform: 'browser', format: 'esm', write: false, external: ['cloudflare:workers'] });
  runtime = new Miniflare(convertV4MiniflareOptions({ name: 'dashboard-browser-synthetic', modules: true, script: bundle.outputFiles[0]!.text, compatibilityDate: '2026-08-01', durableObjects: { PROJECTS: { className: 'Project', useSQLite: true } }, bindings: { AUTH_CREDENTIALS: JSON.stringify(credentials), DASHBOARD_SESSION_KEY: key }, host: '127.0.0.1', port: 0 }));
  const base = await runtime.ready;
  const origin = new URL(base.toString()).origin;
  const request = async (actor: keyof typeof tokens, path: string, payload?: unknown, expectedVersion?: number) => {
    const response = await fetch(new URL(`/api/v1/projects/${projectId}${path}`, origin), { method: payload === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${tokens[actor]}`, ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: payload === undefined ? undefined : JSON.stringify(payload) });
    const body = await response.json() as any;
    if (!response.ok) throw new Error(`${actor} ${path}: ${response.status} ${JSON.stringify(body)}`);
    return body.resource;
  };
  const env = (payload: unknown, expectedVersion?: number) => ({ requestId: crypto.randomUUID(), ...(expectedVersion === undefined ? {} : { expectedVersion }), payload });
  const outcome = '<img src=x onerror="window.dashboardXss=1"> synthetic pagination task';
  const proposal = await request('human', '/contracts/proposals', env({ outcome, constraints: ['Synthetic metadata only'], obligations: [{ id: 'page', description: 'Pagination behavior', acceptanceExamples: [] }], requiredCheckIds: ['page-check'], unresolvedQuestions: [] }));
  await request('human', `/contracts/${proposal.id}/approve`, env({}, 0));
  const policy = { contractVersion: 1, checkSuiteDigest: 'd'.repeat(64), harnessVersion: 'json-oracle-v1', checks: [{ id: 'page-check', obligationIds: ['page'] }], requireIndependentReview: true, sourceBackend: 'local-git' };
  await request('human', '/policy', env(policy, 0));
  await request('human', '/baseline/initialize', env({ commitOid: 'a'.repeat(40), treeOid: 'b'.repeat(40) }, 0));
  const claim = await request('runner', '/runner/claim', env({ leaseSeconds: 120 }));
  const sourceReceipt = { backend: 'local-git', commitOid: 'a'.repeat(40), treeOid: 'b'.repeat(40), ref: sourceRef(claim.data.input) };
  await request('runner', `/runner/jobs/${claim.id}/complete`, env({ attemptId: claim.data.attemptId, ok: true, receipt: sourceReceipt }));
  const baseline = await request('human', '/baseline');
  const change = await request('contributor', '/changes', env({ title: 'Synthetic pagination contribution', obligationIds: ['page'] }));
  const revision = await request('contributor', `/changes/${change.id}/revisions`, env({ baseCommitOid: baseline.commitOid, commitOid: 'c'.repeat(40), treeOid: 'e'.repeat(40), obligationIds: ['page'], decisionRevisions: [], dependencies: [] }));
  const publish = await request('runner', '/runner/claim', env({ leaseSeconds: 120 }));
  await request('runner', `/runner/jobs/${publish.id}/complete`, env({ attemptId: publish.data.attemptId, ok: true, receipt: { ...sourceReceipt, commitOid: 'c'.repeat(40), treeOid: 'e'.repeat(40), ref: sourceRef(publish.data.input) } }));
  const manifest = { baseVersion: baseline.version, baseCommitOid: baseline.commitOid, contractVersion: 1, policyVersion: 1, orderedRevisions: [{ changeId: change.id, revisionId: revision.id }], excludedChangeIds: [], decisionRevisions: [], compositionVersion: 1 };
  const queued = await request('contributor', '/views', env(manifest));
  const compose = await request('runner', '/runner/claim', env({ leaseSeconds: 120 }));
  const composedReceipt = { backend: 'local-git', commitOid: 'f'.repeat(40), treeOid: '9'.repeat(40), ref: sourceRef(compose.data.input) };
  await request('runner', `/runner/jobs/${compose.id}/complete`, env({ attemptId: compose.data.attemptId, ok: true, receipt: composedReceipt }));
  const view = await request('human', `/views/${queued.id}`);
  const applicability = { projectId, viewId: view.id, manifestDigest: view.data.manifestDigest, composedCommitOid: composedReceipt.commitOid, treeOid: composedReceipt.treeOid, contractVersion: 1, policyVersion: 1, checkSuiteDigest: policy.checkSuiteDigest };
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');

  const viewId = queued.id;

  // Browser launches are gated on the concurrently-owned cleanEnv safety changes.
  // This assertion deliberately prevents starting Chromium before DBUS removal and
  // the immediate cgroup guard have landed in the harness.
  const harness = await import('node:fs/promises').then(fs => fs.readFile(new URL('../../packages/browser-test/index.ts', import.meta.url), 'utf8'));
  expect(harness).toMatch(/DBUS_SESSION_BUS_ADDRESS:\s*'disabled:'/);
  expect(harness).toMatch(/cgroup/);
  browser = await launchLocalBrowser({ timeoutMs: 20_000 });
  await browser.send('Page.enable', {}, browser.pageSessionId);
  await browser.send('Page.navigate', { url: new URL('/dashboard', origin).toString() }, browser.pageSessionId);
  const evaluate = async (expression: string) => (await browser!.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, browser!.pageSessionId)).result.value;
  const waitFor = async (condition: string) => {
    const until = Date.now() + 5000;
    while (Date.now() < until) { if (await evaluate(condition)) return; await new Promise(resolve => setTimeout(resolve, 40)); }
    throw new Error(`Timed out waiting for dashboard condition: ${condition}; status=${await evaluate(`document.getElementById('status')?.textContent||''`)}`);
  };
  await waitFor(`!!document.getElementById('login-form')`);
  await waitFor(`document.getElementById('login-submit')?.disabled===false`);
  expect(await evaluate(`document.getElementById('human-token').type`)).toBe('password');
  await evaluate(`(async()=>{const r=await fetch('/dashboard/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({projectId:${JSON.stringify(projectId)},token:${JSON.stringify(tokens.contributor)}})});return r.status})()`);
  expect(await evaluate(`(async()=>{const r=await fetch('/dashboard/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({projectId:${JSON.stringify(projectId)},token:${JSON.stringify(tokens.contributor)}})});return r.status})()`)).toBe(403);
  await evaluate(`document.getElementById('project-id').value=${JSON.stringify(projectId)};document.getElementById('human-token').value=${JSON.stringify(tokens.human)};document.getElementById('login-form').requestSubmit()`);
  await waitFor(`!document.getElementById('workspace').classList.contains('hidden')`);
  expect(await evaluate(`location.href.includes(${JSON.stringify(tokens.human)})`)).toBe(false);
  await waitFor(`document.getElementById('task-outcome').textContent.includes('synthetic pagination task')`);
  expect(await evaluate(`({cleared:document.getElementById('human-token').value==='',stored:localStorage.length===0&&sessionStorage.length===0,escaped:document.getElementById('task-outcome').textContent.includes('<img'),injected:window.dashboardXss===1})`)).toEqual({ cleared: true, stored: true, escaped: true, injected: false });
  await evaluate(`document.getElementById('view-id').value=${JSON.stringify(viewId)};document.getElementById('inspect-view').click()`);
  await waitFor(`document.getElementById('status').textContent.includes('View is not ready.')`);
  expect(await evaluate(`({confirmDisabled:document.getElementById('confirmation-button').disabled,acceptDisabled:document.getElementById('accept-button').disabled,blockers:document.getElementById('blockers').textContent})`)).toMatchObject({ confirmDisabled: true, acceptDisabled: true });
  expect(await evaluate(`document.getElementById('blockers').textContent.includes('EVIDENCE_MISSING')`)).toBe(true);
  expect(await evaluate(`document.getElementById('blockers').textContent.includes('REVIEW_MISSING')`)).toBe(true);
  await request('runner', `/runner/views/${view.id}/checks`, env({ kind: 'recorded-check', checkId: 'page-check', obligationIds: ['page'], applicability, harnessVersion: 'json-oracle-v1', result: 'passed', execution: { status: 'exited', exitCode: 0, stdout: '', stderr: '', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), nodeVersion: 'synthetic-fixture', stdoutDigest: hash(''), stderrDigest: hash('') } }));
  await request('reviewer', `/views/${view.id}/reviews`, env({ viewId: view.id, manifestDigest: applicability.manifestDigest, composedCommitOid: applicability.composedCommitOid, treeOid: applicability.treeOid, contractVersion: 1, policyVersion: 1, checkSuiteDigest: policy.checkSuiteDigest, obligationIds: ['page'], summary: 'Synthetic review fixture', verdict: 'passed', findings: [] }));
  await request('runner', `/runner/views/${view.id}/source-verifications`, env({ receipt: composedReceipt }));
  await evaluate(`document.getElementById('refresh').click()`);
  await waitFor(`document.getElementById('task-outcome').textContent.includes('synthetic pagination task')`);
  await evaluate(`document.getElementById('view-id').value=${JSON.stringify(viewId)};document.getElementById('inspect-view').click()`);
  await waitFor(`document.getElementById('confirmation-button').disabled===false`);
  expect(await evaluate(`document.getElementById('baseline-tuple').textContent.includes(${JSON.stringify(baseline.commitOid)})`)).toBe(true);
  await evaluate(`document.getElementById('confirmation-button').click()`);
  await waitFor(`document.getElementById('accept-button').disabled===false`);
  await request('human', '/claims', env({ obligationIds: ['page'], areas: ['dashboard-browser-isolated-area'], status: 'working' }));
  await evaluate(`document.getElementById('accept-button').click()`);
  await waitFor(`document.getElementById('accept-button').disabled===true`);
  await waitFor(`document.getElementById('status').textContent.includes('Refresh and inspect again before acting.')`);
  expect(await request('human', '/baseline')).toMatchObject({ commitOid: baseline.commitOid, treeOid: baseline.treeOid, version: baseline.version });
  expect(await evaluate(`document.getElementById('confirmation-button').disabled`)).toBe(true);
  await evaluate(`document.getElementById('refresh').click()`);
  await waitFor(`document.getElementById('task-outcome').textContent.includes('synthetic pagination task')`);
  await evaluate(`document.getElementById('view-id').value=${JSON.stringify(viewId)};document.getElementById('inspect-view').click()`);
  await waitFor(`document.getElementById('confirmation-button').disabled===false`);
  await evaluate(`document.getElementById('confirmation-button').click()`);
  await waitFor(`document.getElementById('accept-button').disabled===false`);
  await evaluate(`document.getElementById('accept-button').click()`);
  await waitFor(`document.getElementById('status').textContent.includes('Accepted and verified exact baseline tuple')`);
  const finalBaseline = await request('human', '/baseline');
  expect(finalBaseline).toMatchObject({ commitOid: composedReceipt.commitOid, treeOid: composedReceipt.treeOid });
  await evaluate(`document.getElementById('logout-button').click()`);
  await waitFor(`document.getElementById('workspace').classList.contains('hidden')`);
}, 60_000);
