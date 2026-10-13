import { afterEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { repositoryHtml } from '../../apps/swarmflare/repository';
import { launchLocalBrowser } from '../../packages/browser-test/index';

let server: Server | undefined;
let browser: Awaited<ReturnType<typeof launchLocalBrowser>> | undefined;
afterEach(async () => { await browser?.close(); browser = undefined; if (server?.listening) await new Promise<void>(r => server!.close(() => r())); server = undefined; });

const candidate = {
  id: 'view-local-37', title: 'Add pagination controls', status: 'Ready for review',
  contract: { data: { outcome: 'Users can move between result pages', constraints: ['Preserve the current query'], obligations: [{ id: 'page', description: 'Preserve the current query', acceptanceExamples: [] }], requiredCheckIds: ['unit-tests'], unresolvedQuestions: [] } },
  view: { commitOid: 'a'.repeat(40), treeOid: 'b'.repeat(40) }, readiness: { ready: true },
  checks: [{ data: { checkId: 'unit tests', result: 'passed' } }], findings: [], artifact: { data: { diff: { files: ['src/pagination.ts'], patch: 'diff --git a/src/pagination.ts b/src/pagination.ts\n+export const pageSize = 20;', truncated: false }, preview: null } },
};
const model = { repository: { owner: 'sample-owner', name: 'pagination-demo', description: 'A small example repository for reviewing changes.', status: 'Ready' }, entries: [{ name: 'src', kind: 'directory' }, { name: 'README.md', kind: 'file' }], readme: '# Pagination demo\nBrowse and review a proposed change.', candidates: [candidate], candidate, selectedTab: 'Code', fixture: true };

it('renders safely and exposes repository and candidate navigation', () => {
  const html = repositoryHtml({ ...model, repository: { ...model.repository, description: '<img src=x onerror=alert(1)>' }, candidate: { ...candidate, title: '<script>bad()</script>' } });
  expect(html).toContain('pagination-demo');
  expect(html).toContain('Candidates');
  expect(html).toContain('Files changed');
  expect(html).toContain('Checks');
  expect(html).not.toContain('<img src=x');
  expect(html).not.toContain('<script>bad()');
});

it('navigates the representative repository and candidate in Chromium and captures evidence', async () => {
  server = createServer((req, res) => {
    const candidateMode = req.url?.includes('/candidates/view-local-37');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    const selectedTab = new URL(req.url || '/', 'http://localhost').searchParams.get('tab') || (candidateMode ? 'Files changed' : 'Code');
    const isCandidates = req.url?.endsWith('/candidates');
    const pageModel = candidateMode ? { ...model, selectedTab } : isCandidates ? { ...model, candidate: undefined, selectedTab: 'Candidates' } : { ...model, candidate: undefined, selectedTab: 'Code' };
    res.end(repositoryHtml(pageModel));
  });
  await new Promise<void>(r => server!.listen(0, '127.0.0.1', r));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No local HTTP address');
  const origin = `http://127.0.0.1:${address.port}`;
  await mkdir(resolve('reports/evaluation/continuous37-representative'), { recursive: true });
  browser = await launchLocalBrowser({ timeoutMs: 60_000 });
  const navigate = async (url: string) => {
    await browser!.send('Page.navigate', { url }, browser!.pageSessionId);
    await new Promise(r => setTimeout(r, 250));
  };
  const evaluate = async (expression: string) => (await browser!.send('Runtime.evaluate', { expression, returnByValue: true }, browser!.pageSessionId)).result.value;
  const capture = async (name: string) => {
    const result = await browser!.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, browser!.pageSessionId);
    await writeFile(resolve(`reports/evaluation/continuous37-representative/${name}.png`), Buffer.from(result.data, 'base64'));
  };
  await browser!.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, browser!.pageSessionId);
  const repoUrl = `${origin}/sample-owner/pagination-demo`;
  await navigate(repoUrl); await capture('repository');
  expect(await evaluate('document.title')).toContain('pagination-demo');
  expect(await evaluate("document.body.innerText.includes('Code') && document.body.innerText.includes('Candidates')")).toBe(true);
  await navigate(await evaluate("[...document.querySelectorAll('a')].find(a=>a.textContent.trim()==='Candidates').href"));
  await navigate(await evaluate("[...document.querySelectorAll('a')].find(a=>a.textContent.includes('Add pagination controls')).href"));
  await capture('candidate');
  expect(await evaluate("document.body.innerText.includes('Files changed') && document.body.innerText.includes('Checks')")).toBe(true);
  const filesUrl = await evaluate('location.href');
  await navigate(await evaluate("[...document.querySelectorAll('a')].find(a=>a.textContent.trim()==='Checks').href"));
  expect(await evaluate("document.body.innerText.includes('unit tests') && document.body.innerText.includes('passed')")).toBe(true);
  const navigation = { repository: { url: repoUrl, title: await evaluate('document.title'), text: 'Code -> Candidates -> Add pagination controls' }, candidateFiles: { url: filesUrl, title: await evaluate('document.title'), text: 'Files changed' }, candidateChecks: { url: await evaluate('location.href'), title: await evaluate('document.title'), text: await evaluate('document.body.innerText') } };
  await writeFile(resolve('reports/evaluation/continuous37-representative/navigation.json'), JSON.stringify(navigation, null, 2));
}, 60_000);
