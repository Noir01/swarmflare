import { afterEach, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { launchIsolatedBrowser } from '../../packages/browser-test/isolated.js';
import { repositoryHtml } from '../../apps/swarmflare/repository';
import { siteScript } from '../../apps/swarmflare/site';

let browser: Awaited<ReturnType<typeof launchIsolatedBrowser>> | undefined;
afterEach(async () => { await browser?.close(); browser = undefined; });
const receipt = { backend: 'artifacts-git', ref: 'refs/agent/views/view-decision', commitOid: 'd'.repeat(40), treeOid: 'e'.repeat(40) };
const applicability = { projectId: 'project-decision', viewId: 'view-decision', manifestDigest: 'c'.repeat(64), composedCommitOid: receipt.commitOid, treeOid: receipt.treeOid, contractVersion: 2, policyVersion: 3, checkSuiteDigest: 'f'.repeat(64) };
const model: any = { fixture: true, canManage: true, repository: { owner: 'synthetic-owner', name: 'decision-demo', projectId: 'project-decision', status: 'Ready' }, baseline: { version: 7, commitOid: 'a'.repeat(40), treeOid: 'b'.repeat(40) }, candidate: { id: 'view-decision', title: 'Reviewed synthetic candidate', status: 'runnable', resource: { id: 'view-decision', version: 4, data: { status: 'runnable', manifestDigest: applicability.manifestDigest, manifest: { contractVersion: 2, policyVersion: 3, orderedRevisions: [] }, receipt } }, readiness: { ready: true, sequence: 17, applicability, blockers: [] }, sourceVerification: { data: { viewId: 'view-decision', receipt, verifiedAt: Date.now() } }, changesById: {}, contract: { data: { outcome: 'Synthetic review' } }, findings: [] } };
const origin = 'http://127.0.0.1:39993';
const json = (obj: unknown) => JSON.stringify(obj);
async function open(overrides: { readiness?: any; verification?: any; baseline?: any; conflict?: boolean } = {}) {
  const writes: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
  const gets: string[] = [];
  browser = await launchIsolatedBrowser({ timeoutMs: 60_000 });
  const session = browser.pageSessionId;
  await browser.send('Fetch.enable', { patterns: [{ urlPattern: `${origin}/*`, requestStage: 'Request' }] }, session);
  const remove = browser.on('Fetch.requestPaused', (p: any, sid?: string) => {
    void (async () => {
      const u = new URL(p.request.url); let status = 200; let value: any = {};
      const reply = (v: any, code = 200) => { value = v; status = code; };
      if (u.pathname === '/assets/swarmflare.js') { value = siteScript; }
      else if (u.pathname === '/api/platform/auth/session') reply({ csrf: 'synthetic-csrf' });
      else if (u.pathname.startsWith('/api/v1/')) {
        if (p.request.method === 'POST') {
          const body = JSON.parse(p.request.postData || '{}'); writes.push({ url: u.pathname, body, headers: p.request.headers });
          if (u.pathname.endsWith('/confirmations')) reply({ resource: { id: 'confirmation-synthetic', data: { applicability, expectedBaselineVersion: 7, expectedBaselineCommitOid: 'a'.repeat(40), readinessSequence: 18, expiresAt: Date.now() + 60_000, used: false } }, sequence: 18 });
          else if (u.pathname.endsWith('/acceptances')) reply({ code: 'CONFLICT', message: 'Snapshot changed.' }, overrides.conflict ? 409 : 409);
          else reply({ code: 'UNEXPECTED' }, 404);
        } else {
          gets.push(u.pathname);
          if (u.pathname.endsWith('/readiness')) reply({ resource: overrides.readiness ?? { ready: true, sequence: 17, applicability, blockers: [] }, sequence: 17 });
          else if (u.pathname.endsWith('/source-verification')) reply({ resource: { data: overrides.verification ?? { viewId: 'view-decision', receipt, verifiedAt: Date.now() } }, sequence: 17 });
          else if (u.pathname.endsWith('/baseline')) reply({ resource: overrides.baseline ?? { version: 7, commitOid: 'a'.repeat(40), treeOid: 'b'.repeat(40) }, sequence: 17 });
          else if (u.pathname.endsWith('/views/view-decision')) reply({ resource: model.candidate.resource, sequence: 17 });
          else reply({ resource: null, sequence: 17 });
        }
      } else reply(repositoryHtml({ ...model, selectedTab: 'Conversation' } as any));
      await browser!.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: status, responseHeaders: [{ name: 'Content-Type', value: u.pathname.endsWith('.js') ? 'text/javascript' : u.pathname.startsWith('/api/') ? 'application/json' : 'text/html; charset=utf-8' }, { name: 'Access-Control-Allow-Origin', value: origin }, { name: 'Access-Control-Allow-Credentials', value: 'true' }, { name: 'Access-Control-Allow-Headers', value: 'content-type,x-csrf-token' }, { name: 'Access-Control-Allow-Methods', value: 'GET,POST,OPTIONS' }], body: Buffer.from(typeof value === 'string' ? value : json(value)).toString('base64') }, sid);
    })().catch(() => {});
  });
  await browser.send('Page.enable', {}, session);
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1100, deviceScaleFactor: 1, mobile: false }, session);
  await browser.send('Page.navigate', { url: `${origin}/ada/repo/candidates/view-decision` }, session);
  const evaluate = async (expression: string) => (await browser!.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session)).result.value;
  const poll = async (expression: string) => { for (let i = 0; i < 100; i++) { const value = await evaluate(expression); if (value) return value; await new Promise(r => setTimeout(r, 40)); } throw new Error(`UI poll timed out: ${expression}`); };
  await poll("document.querySelector('button.confirm-candidate')");
  const screenshot = async (name: string) => { await evaluate("document.querySelector('form[data-api=confirm-candidate]').scrollIntoView({block:'center'})"); const shot = await browser!.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, session); await mkdir(resolve('reports/evaluation/continuous45-decision-browser'), { recursive: true }); await writeFile(resolve(`reports/evaluation/continuous45-decision-browser/${name}.png`), Buffer.from(shot.data, 'base64')); };
  return { evaluate, poll, writes, gets, screenshot, remove };
}

it('requires checked review and two explicit clicks; pins returned sequence 18 and same-origin CSRF', async () => {
  const b = await open();
  expect(await b.evaluate("document.querySelector('button.accept-candidate').disabled")).toBe(true);
  await b.evaluate("document.querySelector('button.confirm-candidate').click()");
  await b.evaluate("new Promise(r=>setTimeout(r,30))"); expect(b.writes).toHaveLength(0);
  await b.evaluate("document.querySelector('input[name=reviewed]').click()"); await b.evaluate("document.querySelector('button.confirm-candidate').click()");
  await b.poll("document.querySelector('button.accept-candidate').disabled===false");
  expect(b.writes).toHaveLength(1); expect(b.writes[0]!.url).toContain('/confirmations');
  expect(Object.entries(b.writes[0]!.headers).find(([key]) => key.toLowerCase() === 'x-csrf-token')?.[1]).toBe('synthetic-csrf'); expect(Object.entries(b.writes[0]!.headers).find(([key]) => key.toLowerCase() === 'origin')?.[1]).toBe(origin);
  expect(b.writes[0]!.body.payload).toMatchObject({ applicability, expectedBaselineVersion: 7, expectedBaselineCommitOid: 'a'.repeat(40), readinessSequence: 17, confirm: true });
  await b.screenshot('positive'); await b.evaluate("document.querySelector('button.accept-candidate').click()"); await b.poll("document.querySelector('[data-accept-status]').textContent.includes('cleared')");
  expect(b.writes).toHaveLength(2); expect(b.writes[1]!.body.payload).toEqual({ confirmationId: 'confirmation-synthetic', applicability, expectedBaselineVersion: 7, expectedBaselineCommitOid: 'a'.repeat(40), readinessSequence: 18 });
  expect(await b.evaluate("document.querySelector('button.accept-candidate').disabled")).toBe(true); expect(await b.evaluate("document.querySelector('button.confirm-candidate').dataset.confirmation")).toBe('');
  await b.evaluate("new Promise(r=>setTimeout(r,200))"); expect(b.writes).toHaveLength(2);
}, 60_000);

it.each([
  ['baseline changed', { baseline: { version: 8, commitOid: '9'.repeat(40), treeOid: 'b'.repeat(40) } }],
  ['source verification stale', { verification: { viewId: 'view-decision', receipt, verifiedAt: Date.now() - 31_000 } }],
  ['source receipt changed', { verification: { viewId: 'view-decision', receipt: { ...receipt, commitOid: '9'.repeat(40) }, verifiedAt: Date.now() } }],
  ['readiness false', { readiness: { ready: false, sequence: 17, applicability, blockers: [{ message: 'not ready' }] } }]
] as const)('refuses confirmation when %s without requery or retry', async (_name, overrides) => {
  const b = await open(overrides as any); await b.evaluate("document.querySelector('input[name=reviewed]').click()"); await b.evaluate("document.querySelector('button.confirm-candidate').click()");
  await b.poll("document.querySelector('button.confirm-candidate').disabled===false");
  expect(b.writes).toHaveLength(0); expect(await b.evaluate("document.querySelector('button.accept-candidate').disabled")).toBe(true);
  const before = b.gets.length; await b.evaluate("new Promise(r=>setTimeout(r,250))"); expect(b.gets).toHaveLength(before); expect(b.writes).toHaveLength(0);
}, 60_000);

it('clears confirmation and disables acceptance after explicit acceptance conflict without retry', async () => {
  const b = await open({ conflict: true }); await b.evaluate("document.querySelector('input[name=reviewed]').click()"); await b.evaluate("document.querySelector('button.confirm-candidate').click()");
  await b.poll("document.querySelector('button.accept-candidate').disabled===false"); await b.screenshot('conflict-ready');
  await b.evaluate("document.querySelector('button.accept-candidate').click()"); await b.poll("document.querySelector('[data-accept-status]').textContent.includes('cleared')");
  expect(b.writes.map(w => w.url)).toHaveLength(2); expect(b.writes[1]!.url).toContain('/acceptances');
  expect(await b.evaluate("document.querySelector('button.accept-candidate').disabled")).toBe(true); expect(await b.evaluate("document.querySelector('button.confirm-candidate').dataset.confirmation")).toBe('');
  const before = b.writes.length; await b.evaluate("new Promise(r=>setTimeout(r,250))"); expect(b.writes).toHaveLength(before);
}, 60_000);
