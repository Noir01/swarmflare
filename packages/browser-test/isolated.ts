import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

async function resolveExecutable(name: string): Promise<string> {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try { return await realpath(candidate); } catch { /* try next PATH entry */ }
  }
  throw new Error(`Cannot locate ${name} on PATH`);
}

type Message = { id?: number; method?: string; params?: any; result?: any; error?: { message?: string }; sessionId?: string };
type Handler = (params: any, sessionId?: string) => void;

export async function launchIsolatedBrowser(options: { timeoutMs?: number } = {}) {
  const enteredAt = Date.now();
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) throw new RangeError('timeoutMs must be 100..60000');
  const deadline = enteredAt + timeoutMs;
  const [chromiumPath, bwrapPath, fontPath] = await Promise.all([resolveExecutable('chromium'), resolveExecutable('bwrap'), resolveExecutable('fc-match')]);
  const fontResult = await new Promise<string>((resolve, reject) => {
    const lookup = spawn(fontPath, ['-f', '%{file}', 'sans-serif'], { stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: '/nix/store' } });
    let output = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const fail = (error: Error) => { if (settled) return; settled = true; clearTimeout(timer); reject(error); };
    let lookupClosed = false;
    lookup.once('close', () => { lookupClosed = true; });
    const join = () => new Promise<void>(done => {
      if (lookupClosed || lookup.pid === undefined) { done(); return; }
      const hard = setTimeout(() => { lookup.kill('SIGKILL'); }, 150);
      const finish = () => { clearTimeout(hard); done(); };
      lookup.once('close', finish);
      lookup.once('error', finish);
    });
    const expire = () => { if (settled) return; settled = true; lookup.kill('SIGTERM'); void join().then(() => reject(new Error('Font lookup timed out'))); };
    timer = setTimeout(expire, Math.max(1, Math.min(2000, deadline - Date.now())));
    lookup.stdout?.on('data', chunk => {
      output += String(chunk);
      if (Buffer.byteLength(output) > 4096 && !settled) {
        settled = true;
        clearTimeout(timer);
        lookup.kill('SIGTERM');
        void join().then(() => reject(new Error('Font lookup output exceeded 4 KiB')));
      }
    });
    lookup.once('error', error => fail(error));
    lookup.once('close', code => {
      if (settled) return;
      if (code === 0 && output.startsWith('/nix/store/') && !output.includes('..') && !/[<>"'&]/.test(output)) { settled = true; clearTimeout(timer); resolve(output); }
      else fail(new Error('Could not resolve canonical sans-serif font inside /nix/store'));
    });
  });
  const fontDir = dirname(fontResult);
  const fontConfigDir = await mkdtemp(join(tmpdir(), 'isolated-browser-fontconfig-'));
  const fontConfig = join(fontConfigDir, 'fonts.conf');
  const xmlDir = fontDir.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  await writeFile(fontConfig, `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>${xmlDir}</dir><cachedir>/tmp/fontconfig-cache</cachedir></fontconfig>`);
  const profile = '/tmp/chromium-profile';

  const env: NodeJS.ProcessEnv = { PATH: '/nix/store', HOME: '/tmp', TMPDIR: '/tmp', FONTCONFIG_FILE: '/etc/fonts/fonts.conf', LANG: process.env.LANG ?? 'C.UTF-8', LC_ALL: process.env.LC_ALL };
  const args = [
    '--unshare-all', '--die-with-parent', '--ro-bind', '/nix/store', '/nix/store',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/run', '--dir', '/etc', '--dir', '/etc/fonts', '--ro-bind', fontConfig, '/etc/fonts/fonts.conf',
    '--chdir', '/tmp', '--', chromiumPath,
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps',
    '--remote-debugging-pipe', `--user-data-dir=${profile}`, 'about:blank',
  ];
  let child: ChildProcess;
  child = spawn(bwrapPath, args, { detached: false, env, stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4000); });
  child.stderr?.on('error', () => {});
  let closed = false;
  let childClosed = false;
  let cleanupPromise: Promise<void> | undefined;
  let seq = 0;
  let input = '';
  let close: () => Promise<void>;
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const handlers = new Map<string, Set<Handler>>();
  const rejectPending = (error: Error) => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); };
  const state = () => `pid=${child.pid ?? 'none'} exit=${child.exitCode} signal=${child.signalCode} stderr=${stderr || '(empty)'}`;
  const readStream = child.stdio[4] as NodeJS.ReadableStream | null;
  const writeStream = child.stdio[3] as NodeJS.WritableStream | null;
  if (!readStream || !writeStream || typeof writeStream.write !== 'function') {
    child.kill('SIGKILL');
    await new Promise<void>(resolve => child.once('close', () => resolve()));
    await rm(fontConfigDir, { recursive: true, force: true });
    throw new Error(`Chromium CDP pipe descriptors unavailable; ${state()}`);
  }
  readStream.on('data', (chunk: Buffer | string) => {
    input += String(chunk);
    if (input.length > 8 * 1024 * 1024) { void close(); return; }
    let end: number;
    while ((end = input.indexOf('\0')) >= 0) {
      const frame = input.slice(0, end); input = input.slice(end + 1);
      let message: Message;
      try { message = JSON.parse(frame) as Message; } catch { void close(); return; }
      if (message.id !== undefined) {
        const item = pending.get(message.id);
        if (!item) continue;
        pending.delete(message.id); clearTimeout(item.timer);
        if (message.error) item.reject(new Error(message.error.message ?? 'CDP error')); else item.resolve(message.result);
      } else if (message.method) {
        for (const handler of handlers.get(message.method) ?? []) {
          try { handler(message.params, message.sessionId); } catch { /* handlers are isolated from protocol dispatch */ }
        }
      }
    }
  });
  readStream.on('error', () => { if (!closed) { closed = true; rejectPending(new Error(`CDP read pipe failed; ${state()}`)); } });
  writeStream.on('error', () => { if (!closed) { closed = true; rejectPending(new Error(`CDP write pipe failed; ${state()}`)); } });
  child.on('error', () => { closed = true; rejectPending(new Error(`Chromium child process failed; ${state()}`)); });
  child.once('close', () => { childClosed = true; });
  child.once('exit', () => { closed = true; rejectPending(new Error(`Isolated Chromium exited; ${state()}`)); });

  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> => {
    if (closed || child.exitCode !== null || child.signalCode !== null) return Promise.reject(new Error('Isolated Chromium is closed'));
    const id = ++seq;
    const message = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) });
    return new Promise((resolve, reject) => {
      const delay = Math.max(1, Math.min(5000, deadline - Date.now()));
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}; ${state()}`)); }, delay);
      pending.set(id, { resolve, reject, timer });
      try { writeStream.write(`${message}\0`); }
      catch (error) { pending.delete(id); clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))); }
    });
  };
  const on = (method: string, handler: Handler) => {
    const set = handlers.get(method) ?? new Set<Handler>(); set.add(handler); handlers.set(method, set);
    return () => { set.delete(handler); if (set.size === 0) handlers.delete(method); };
  };
  close = () => cleanupPromise ??= (async () => {
    closed = true;
    rejectPending(new Error('Isolated Chromium closed'));
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    if (child.pid !== undefined && !childClosed) await new Promise<void>(resolve => {
      let settled = false;
      const done = () => { if (settled) return; settled = true; clearTimeout(timer); child.off('close', done); resolve(); };
      const timer = setTimeout(() => { child.kill('SIGKILL'); }, 1500);
      child.once('close', done);
    });
    else if (child.pid === undefined) await new Promise<void>(resolve => child.once('close', resolve));
    clearTimeout(overall);
    await rm(fontConfigDir, { recursive: true, force: true });
  })();
  const overall = setTimeout(() => { void close(); }, timeoutMs);
  overall.unref();
  child.once('exit', () => clearTimeout(overall));
  try {
    const readyBy = Math.min(deadline - 100, Date.now() + 10_000);
    let ready = false;
    let lastProbeError: unknown;
    while (Date.now() < readyBy) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`bubblewrap/Chromium exited at startup; ${state()}`);
      try {
        await send('Browser.getVersion');
        ready = true;
        break;
      } catch (error) {
        lastProbeError = error;
        await new Promise(resolve => setTimeout(resolve, Math.min(40, Math.max(1, readyBy - Date.now()))));
      }
    }
    if (!ready) throw new Error(`Timed out waiting for isolated Chromium Browser.getVersion readiness; ${String(lastProbeError)}; ${state()}`);
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Page.enable', {}, sessionId);
    await send('Runtime.enable', {}, sessionId);
    const parentCgroup = (await import('node:fs/promises')).readFile(`/proc/${process.pid}/cgroup`, 'utf8').then(value => value.trim().split('\n').sort());
    const childCgroup = (await import('node:fs/promises')).readFile(`/proc/${child.pid}/cgroup`, 'utf8').then(value => value.trim().split('\n').sort());
    if (JSON.stringify(await childCgroup) !== JSON.stringify(await parentCgroup)) throw new Error(`bubblewrap escaped caller cgroup: ${await childCgroup}`);
    return { send, on, pageSessionId: sessionId as string, pid: child.pid!, close };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}
