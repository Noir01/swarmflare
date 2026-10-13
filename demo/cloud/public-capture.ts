import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { launchLocalBrowser } from '../../packages/browser-test/index';

// Read only the sanitized receipt, never a cookie/password/human credential.
const receipt = JSON.parse(await readFile(resolve('reports/evaluation/continuous40-platform-smoke.json'), 'utf8'));
const origin = 'https://git-collaboration-demo-c29.sriva140.workers.dev';
if (receipt.origin !== origin || receipt.imported?.status !== 'ready') throw Error('Verified native import receipt required');
const repository = receipt.imported;
const base = `/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
const directory = resolve('reports/evaluation/continuous41-native-browser');
await mkdir(directory, { recursive: true });
const browser = await launchLocalBrowser({ timeoutMs: 60000 });
const navigation: Array<{ path: string; title: string; readme: boolean }> = [];
try {
  const evaluate = async (expression: string) => (await browser.send('Runtime.evaluate', { expression, returnByValue: true }, browser.pageSessionId)).result.value;
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, browser.pageSessionId);
  const visit = async (path: string, screenshot: string) => {
    await browser.send('Page.navigate', { url: origin + path }, browser.pageSessionId);
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (await evaluate('document.readyState === "complete" && document.body.innerText.includes("Swarmflare")')) break;
      await new Promise(r => setTimeout(r, 50));
    }
    if (!await evaluate('document.body.innerText.includes("Swarmflare")')) throw Error('Native page unavailable');
    const captured = await browser.send('Page.captureScreenshot', { format: 'png' }, browser.pageSessionId);
    await writeFile(resolve(directory, screenshot + '.png'), Buffer.from(captured.data, 'base64'));
    navigation.push({ path, title: await evaluate('document.title'), readme: await evaluate('document.body.innerText.includes("Hello World!")') });
  };
  await visit('/', 'landing');
  await visit('/repositories', 'catalog');
  const link = await evaluate(`[...document.querySelectorAll('a')].find(a=>a.getAttribute('href')===${JSON.stringify(base)})?.getAttribute('href')`);
  if (link !== base) throw Error('Native catalog does not link the imported repository');
  await visit(link, 'repository');
  if (!navigation.at(-1)?.readme) throw Error('Native imported README not displayed');
  const candidates = await evaluate(`[...document.querySelectorAll('a')].find(a=>a.textContent.trim()==='Candidates')?.getAttribute('href')`);
  if (candidates !== base + '/candidates') throw Error('Repository navigation missing');
  await visit(candidates, 'candidates');
  if (!await evaluate('document.body.innerText.includes("No candidates yet")')) throw Error('New repository falsely reports candidate work');
  await writeFile(resolve(directory, 'navigation.json'), JSON.stringify({ provenance: 'Actual deployed public Swarmflare pages and native imported source. No login, credentials, human review or acceptance.', navigation }, null, 2));
  console.log(JSON.stringify({ screenshots: directory, navigation }, null, 2));
} finally { await browser.close(); }
