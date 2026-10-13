import { afterEach, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchIsolatedBrowser } from '../../packages/browser-test/isolated';

const browsers: Array<Awaited<ReturnType<typeof launchIsolatedBrowser>>> = [];
afterEach(async () => { await Promise.all(browsers.splice(0).map(browser => browser.close())); });
const cgroup = async (pid: number) => (await readFile(`/proc/${pid}/cgroup`, 'utf8')).trim().split('\n').sort();
const descendants = async (pid: number): Promise<number[]> => {
  const children = await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8').catch(() => '');
  const direct = children.trim().split(/\s+/).filter(Boolean).map(Number);
  return [...direct, ...(await Promise.all(direct.map(descendants))).flat()];
};

it('evaluates real DOM in a bubblewrap-isolated browser and reaps namespace processes', async () => {
  const browser = await launchIsolatedBrowser({ timeoutMs: 20_000 }); browsers.push(browser);
  expect(await cgroup(browser.pid)).toEqual(await cgroup(process.pid));
  for (const pid of await descendants(browser.pid)) expect(await cgroup(pid)).toEqual(await cgroup(process.pid));
  const { result } = await browser.send('Runtime.evaluate', {
    expression: `(() => { document.body.innerHTML='<main id="actual">isolated</main>'; return {text:document.querySelector('#actual').textContent,tag:document.querySelector('#actual').tagName}; })()`,
    returnByValue: true,
  }, browser.pageSessionId);
  expect(result.value).toEqual({ text: 'isolated', tag: 'MAIN' });
  const dataUrl = `data:text/html,${encodeURIComponent('<!doctype html><html><body><label for="choice">Choose one</label><select id="choice"><option>Rendered option</option></select><button>Rendered button</button></body></html>')}`;
  await browser.send('Page.navigate', { url: dataUrl }, browser.pageSessionId);
  await browser.send('Runtime.evaluate', { expression: 'document.fonts.ready.then(()=>true)', awaitPromise: true, returnByValue: true }, browser.pageSessionId);
  const { result: rendered } = await browser.send('Runtime.evaluate', { expression: `({ select:document.querySelector('select').getBoundingClientRect().width, button:document.querySelector('button').getBoundingClientRect().width, text:document.body.innerText })`, returnByValue: true }, browser.pageSessionId);
  expect(rendered.value.text).toContain('Rendered option');
  expect(rendered.value.select).toBeGreaterThan(0);
  expect(rendered.value.button).toBeGreaterThan(0);
  const screenshot = await browser.send('Page.captureScreenshot', { format: 'png' }, browser.pageSessionId);
  expect(screenshot.data.length).toBeGreaterThan(100);
  const pid = browser.pid;
  await browser.close();
  await expect(readFile(`/proc/${pid}/stat`, 'utf8')).rejects.toThrow();
});

it('has no host home or network access, and forwards CDP events', async () => {
  let hits = 0;
  const server = createServer((_request, response) => { hits++; response.end('host reachable'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('sentinel did not bind');
  try {
    const hostDir = await mkdtemp(join(tmpdir(), 'isolated-host-sentinel-'));
    const marker = `UNMOUNTED_HOST_MARKER_${crypto.randomUUID()}`;
    const hostFile = join(hostDir, 'secret-marker.txt');
    await writeFile(hostFile, marker);
    try {
    const browser = await launchIsolatedBrowser({ timeoutMs: 20_000 }); browsers.push(browser);
    const events: string[] = [];
    const unsubscribe = browser.on('Runtime.consoleAPICalled', () => events.push('console'));
    await browser.send('Runtime.evaluate', { expression: `console.log('event-check'); fetch('http://127.0.0.1:${address.port}/').then(()=>{throw Error('loopback unexpectedly reachable')},()=>true)`, awaitPromise: true }, browser.pageSessionId);
    expect(events).toContain('console');
    expect(hits).toBe(0);
    unsubscribe();
    await browser.send('Page.navigate', { url: `file://${hostFile}` }, browser.pageSessionId);
    const { result } = await browser.send('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true }, browser.pageSessionId);
    expect(String(result.value ?? '')).not.toContain(marker);
    } finally { await rm(hostDir, { recursive: true, force: true }); }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it('enforces the overall timeout and reaps the bubblewrap process', async () => {
  const browser = await launchIsolatedBrowser({ timeoutMs: 2500 });
  const pid = browser.pid;
  await new Promise(resolve => setTimeout(resolve, 3000));
  await expect(browser.send('Browser.getVersion')).rejects.toThrow(/closed/i);
  await expect(readFile(`/proc/${pid}/stat`, 'utf8')).rejects.toThrow();
  await browser.close();
});

it('joins concurrent close calls and removes its owned fontconfig directory', async () => {
  const prefix = 'isolated-browser-fontconfig-';
  const originalTmpdir = tmpdir();
  const previousTmpdir = process.env.TMPDIR;
  const isolatedTmpdir = await mkdtemp(join(originalTmpdir, 'isolated-browser-test-'));
  let browser: Awaited<ReturnType<typeof launchIsolatedBrowser>> | undefined;
  let pid: number | undefined;
  let owned: string[] = [];
  try {
    process.env.TMPDIR = isolatedTmpdir;
    const before = new Set((await readdir(isolatedTmpdir)).filter(name => name.startsWith(prefix)));
    browser = await launchIsolatedBrowser({ timeoutMs: 10_000 });
    pid = browser.pid;
    owned = (await readdir(isolatedTmpdir)).filter(name => name.startsWith(prefix) && !before.has(name));
    expect(owned).toHaveLength(1);
  } finally {
    try {
      if (browser) await Promise.all([browser.close(), browser.close(), browser.close()]);
    } finally {
      if (previousTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmpdir;
      try {
        if (pid !== undefined) await expect(readFile(`/proc/${pid}/stat`, 'utf8')).rejects.toThrow();
        for (const name of owned) await expect(readFile(join(isolatedTmpdir, name), 'utf8')).rejects.toThrow();
      } finally {
        await rm(isolatedTmpdir, { recursive: true, force: true });
        await expect(readFile(isolatedTmpdir, 'utf8')).rejects.toThrow();
      }
    }
  }
});

it('reaps each browser after repeated short-lived launches', async () => {
  const pids: number[] = [];
  for (let i = 0; i < 2; i++) {
    const browser = await launchIsolatedBrowser({ timeoutMs: 10_000 });
    pids.push(browser.pid);
    await browser.close();
  }
  for (const pid of pids) await expect(readFile(`/proc/${pid}/stat`, 'utf8')).rejects.toThrow();
});

it('starts parallel isolated browsers under launch contention and reaps both', async () => {
  for (let round = 0; round < 2; round++) {
    const launched = await Promise.all([launchIsolatedBrowser({ timeoutMs: 15_000 }), launchIsolatedBrowser({ timeoutMs: 15_000 })]);
    const pids = launched.map(browser => browser.pid);
    try {
      expect(new Set(pids).size).toBe(2);
      for (const browser of launched) {
        const { result } = await browser.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true }, browser.pageSessionId);
        expect(result.value).toBe('about:blank');
      }
    } finally {
      await Promise.all(launched.map(browser => browser.close()));
    }
    for (const pid of pids) await expect(readFile(`/proc/${pid}/stat`, 'utf8')).rejects.toThrow();
  }
});
