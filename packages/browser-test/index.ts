import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolvePathExecutable } from './executable';

const cleanEnv = (profile: string): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH,
  HOME: profile,
  LANG: process.env.LANG ?? 'C.UTF-8',
  LC_ALL: process.env.LC_ALL,
  XDG_CONFIG_HOME: join(profile, 'config'),
  XDG_CACHE_HOME: join(profile, 'cache'),
  XDG_RUNTIME_DIR: join(profile, 'runtime'),
  DBUS_SESSION_BUS_ADDRESS: 'disabled:',
  DBUS_SYSTEM_BUS_ADDRESS: 'disabled:',
  TMPDIR: process.env.TMPDIR ?? tmpdir(),
});

type CdpResponse = { id?: number; result?: any; error?: { message?: string }; sessionId?: string; method?: string; params?: any };

export async function launchLocalBrowser(options: { timeoutMs?: number } = {}) {
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) throw new RangeError('timeoutMs must be 100..60000');
  const chromiumPath = await resolvePathExecutable('chromium');
  const profile = await mkdtemp(join(tmpdir(), 'local-chromium-'));
  const overallDeadline = Date.now() + timeoutMs;
  await Promise.all(['config', 'cache', 'runtime'].map(dir => mkdir(join(profile, dir), { mode: 0o700 })));
  const child: ChildProcess = spawn(chromiumPath, [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--disable-default-apps', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, 'about:blank',
  ], { detached: false, env: cleanEnv(profile), stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-3000); });
  const childErrors: string[] = [];
  child.on('error', error => { childErrors.push(error.message); });
  const childState = () => `pid=${child.pid ?? 'none'} exitCode=${child.exitCode} signalCode=${child.signalCode} stderr=${stderr || '(empty)'} childErrors=${childErrors.join(';') || '(none)'}`;
  let ws: WebSocket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let cleanupPromise: Promise<void> | undefined;
  let sendForCleanup: ((method: string, params?: Record<string, unknown>) => Promise<any>) | undefined;
  let seq = 0;
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const failPending = (error: Error) => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); } pending.clear(); };
  const cleanup = () => cleanupPromise ??= (async () => {
    if (timer) clearTimeout(timer);
    // Ask Chromium to shut down through CDP before tearing down its transport.
    if (sendForCleanup) await Promise.race([sendForCleanup('Browser.close').catch(() => {}), new Promise<void>(resolve => setTimeout(resolve, 1500))]);
    if (ws && ws.readyState < WebSocket.CLOSING) ws.close();
    closed = true;
    failPending(new Error('Local Chromium closed'));
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>(resolve => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        const exited = () => { clearTimeout(force); resolve(); };
        child.once('exit', exited);
        child.kill('SIGTERM');
        const force = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
          const reap = setInterval(() => {
            if (child.exitCode !== null || child.signalCode !== null) { clearInterval(reap); resolve(); }
          }, 25);
          setTimeout(() => { clearInterval(reap); resolve(); }, 1000).unref();
        }, 2500);
        force.unref();
      });
    }
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  })();
  timer = setTimeout(() => { void cleanup().catch(() => {}); }, timeoutMs);
  timer.unref();
  try {
    const portFile = join(profile, 'DevToolsActivePort');
    const deadline = Date.now() + Math.min(timeoutMs - 50, 10_000);
    let port = '';
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Chromium exited before CDP became ready: ${childState()}`);
      try { port = (await readFile(portFile, 'utf8')).split('\n')[0] ?? ''; if (port) break; } catch { /* wait for Chromium startup */ }
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    if (!port || !/^\d+$/.test(port)) throw new Error(`Timed out waiting for Chromium CDP port: ${childState()}`);
    const version = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) }).then(r => r.json()) as { webSocketDebuggerUrl: string };
    ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => { const remaining = Math.max(1, deadline - Date.now()); const timer = setTimeout(() => reject(new Error('Timed out opening CDP websocket')), remaining); ws!.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true }); ws!.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP websocket failed')); }, { once: true }); });

    ws.addEventListener('message', event => {
      let message: CdpResponse;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.id === undefined) {

        return;
      }
      const p = pending.get(message.id); if (!p) return;
      pending.delete(message.id); clearTimeout(p.timer);
      message.error ? p.reject(new Error(message.error.message ?? 'CDP error')) : p.resolve(message.result);
    });
    ws.addEventListener('close', () => failPending(new Error('CDP websocket closed')));
    const send = async (method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> => {
      if (closed || ws!.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Local Chromium is closed'));
      const id = ++seq;
      return new Promise((resolve, reject) => {
        const commandBudget = method === 'Page.navigate' ? overallDeadline - Date.now() : Math.min(5000, overallDeadline - Date.now());
        const requestTimer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}; ${childState()}`)); }, Math.max(1, commandBudget));
        pending.set(id, { resolve, reject, timer: requestTimer });
        ws!.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });

    };
    sendForCleanup = (method, params = {}) => send(method, params);
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Page.enable', {}, sessionId);

    await send('Runtime.enable', {}, sessionId);
    const childCgroup = (await readFile(`/proc/${child.pid}/cgroup`, 'utf8')).trim().split('\n').sort();
    const parentCgroup = (await readFile(`/proc/${process.pid}/cgroup`, 'utf8')).trim().split('\n').sort();
    if (JSON.stringify(childCgroup) !== JSON.stringify(parentCgroup)) throw new Error(`Chromium escaped caller cgroup: ${childCgroup.join(',')}`);
    return { send, pageSessionId: sessionId as string, pid: child.pid!, profilePath: profile, close: cleanup };
  } catch (error) {
    await cleanup().catch(() => {});
    throw error;
  }
}
