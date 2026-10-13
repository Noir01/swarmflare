import { afterEach, expect, it } from 'vitest';
import { access, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchLocalBrowser } from '../../packages/browser-test/index';

const browsers: Array<Awaited<ReturnType<typeof launchLocalBrowser>>> = [];
afterEach(async () => { await Promise.all(browsers.splice(0).map(browser => browser.close())); });
const cgroup = async (pid: number) => (await readFile(`/proc/${pid}/cgroup`, 'utf8')).trim().split('\n').sort();
const descendants = async (pid: number): Promise<number[]> => {
  const children = await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8').catch(() => '');
  const direct = children.trim().split(/\s+/).filter(Boolean).map(Number);
  return [...direct, ...(await Promise.all(direct.map(descendants))).flat()];
};
const profileGone = async (path: string) => access(path).then(() => false, () => true);

it('runs real Chromium DOM evaluation in the caller cgroup and cleans up on close', async () => {
  const browser = await launchLocalBrowser({ timeoutMs: 15_000 }); browsers.push(browser);
  expect(await cgroup(browser.pid)).toEqual(await cgroup(process.pid));
  for (const pid of await descendants(browser.pid)) expect(await cgroup(pid)).toEqual(await cgroup(process.pid));
  const { result } = await browser.send('Runtime.evaluate', { expression: `(() => { document.body.innerHTML='<main id="actual">dashboard</main>'; return {text:document.querySelector('#actual').textContent, tag:document.querySelector('#actual').tagName}; })()`, returnByValue: true }, browser.pageSessionId);
  expect(result.value).toEqual({ text: 'dashboard', tag: 'MAIN' });
  const pid = browser.pid;
  await browser.close();
  await expect(readFile(`/proc/${pid}/stat`, 'utf8')).rejects.toThrow();
  expect(await profileGone(browser.profilePath)).toBe(true);
  await expect(browser.send('Browser.getVersion')).rejects.toThrow(/closed/i);
});

it('kills Chromium and rejects commands when the harness timeout expires', async () => {
  const browser = await launchLocalBrowser({ timeoutMs: 2500 });
  const pid = browser.pid;
  await new Promise(resolve => setTimeout(resolve, 3000));
  await expect(browser.send('Browser.getVersion')).rejects.toThrow(/closed/i);
  await expect(readFile(`/proc/${pid}/stat`, 'utf8')).rejects.toThrow();
  await browser.close();
  expect(await profileGone(browser.profilePath)).toBe(true);
});

it('allows a navigation to complete after the short control-command timeout', async () => {
  const server = createServer((_request, response) => {
    setTimeout(() => { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<main id="slow">loaded</main>'); }, 5200);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected an ephemeral HTTP port');
  const browser = await launchLocalBrowser({ timeoutMs: 15_000 }); browsers.push(browser);
  try {
    await browser.send('Page.navigate', { url: `http://127.0.0.1:${address.port}/slow` }, browser.pageSessionId);
    let loaded = false;
    const deadline = Date.now() + 5000;
    while (!loaded && Date.now() < deadline) {
      const { result } = await browser.send('Runtime.evaluate', { expression: "document.getElementById('slow')?.textContent === 'loaded'", returnByValue: true }, browser.pageSessionId);
      loaded = result.value === true;
      if (!loaded) await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(loaded).toBe(true);
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it('bounds a navigation that never receives an HTTP response by the browser lifetime', async () => {
  const server = createServer(() => { /* Hold the response open until the browser is stopped. */ });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected an ephemeral HTTP port');
  const browser = await launchLocalBrowser({ timeoutMs: 8000 }); browsers.push(browser);
  const pid = browser.pid;
  const started = Date.now();
  try {
    await expect(browser.send('Page.navigate', { url: `http://127.0.0.1:${address.port}/hang` }, browser.pageSessionId)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(11_000);
    await browser.close();
    await expect(readFile(`/proc/${pid}/stat`, 'utf8')).rejects.toThrow();
    expect(await profileGone(browser.profilePath)).toBe(true);
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
