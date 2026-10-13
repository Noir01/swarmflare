import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { WorkspaceClient } from '../../packages/client/index.js';
import { verifyViewSource } from '../../packages/local-runner/checks.js';
import { validateBaseUrl, validateConfig } from './actor.js';

const exec = promisify(execFile);
const MAX_API_REQUESTS = 20;
const API_BUDGET_MS = 30_000;
const gitEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'file' };

function safeError(): Error { return new Error('live source verification failed; check local runner configuration and source state'); }

export async function verifyLiveSource(root: string, viewId: string, output: string) {
  let token = '';
  let stage = 'configuration';
  try {
    if (!/^[A-Za-z0-9_-]{1,120}$/.test(viewId)) throw safeError();
    const sessionRoot = await realpath(resolve(root));
    const outputPath = resolve(output);
    const outputRelative = relative(sessionRoot, outputPath);
    if (!isAbsolute(outputPath) || !outputRelative || outputRelative.startsWith('..') || outputRelative.includes('/..')) throw safeError();
    const outputParent = await realpath(dirname(outputPath));
    const parentRelative = relative(sessionRoot, outputParent);
    if (parentRelative.startsWith('..') || parentRelative.includes('/..')) throw safeError();
    try { await lstat(outputPath); throw safeError(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const parsed: unknown = JSON.parse(await readFile(resolve(sessionRoot, 'private/runner.json'), 'utf8'));
    const config = validateConfig(parsed);
    token = config.token;
    const manifest = JSON.parse(await readFile(resolve(sessionRoot, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    if (config.actorId !== 'demo-runner' || config.projectId !== manifest.projectId || validateBaseUrl(manifest.baseUrl) !== config.baseUrl || resolve(config.repository) !== resolve(sessionRoot, 'remote.git') || resolve(String(manifest.remote)) !== resolve(sessionRoot, 'remote.git')) throw safeError();
    const remote = await realpath(resolve(sessionRoot, 'remote.git'));
    if (remote !== resolve(sessionRoot, 'remote.git')) throw safeError();
    const git = await exec('git', ['-C', remote, 'rev-parse', '--is-bare-repository'], { env: gitEnv, timeout: 3000, maxBuffer: 1024 });
    if (git.stdout.trim() !== 'true') throw safeError();
    const client = new WorkspaceClient({ baseUrl: config.baseUrl, projectId: config.projectId, token, maxRequests: MAX_API_REQUESTS, deadline: API_BUDGET_MS });
    const baselineBefore = await client.baseline();
    stage = 'source-verification';
    if (!baselineBefore) throw safeError();
    const recorded = await verifyViewSource(client, { remote, viewId, requestId: `live-source-${Date.now()}` });
    stage = 'source-record-readback';
    const readback = await client.sourceVerification(viewId);
    const baselineAfter = await client.baseline();
    const readiness = await client.readiness(viewId);
    if (!readback || JSON.stringify(readback) !== JSON.stringify(recorded) || JSON.stringify(baselineBefore) !== JSON.stringify(baselineAfter)) throw safeError();
    const result = { kind: 'trusted-local-source-verification', viewId, verification: readback, baselineUnchanged: true, readiness: { ready: readiness.ready, blockers: readiness.blockers }, verified: true };
    const serialized = JSON.stringify(result, null, 2) + '\n';
    if (token && serialized.includes(token)) throw safeError();
    const handle = await open(outputPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(serialized, 'utf8'); } catch (error) { await handle.close(); const { unlink } = await import('node:fs/promises'); await unlink(outputPath).catch(() => {}); throw error; }
    await handle.close();
    return result;
  } catch {
    throw new Error(`live source verification failed at ${stage}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 3) throw safeError();
  const result = await verifyLiveSource(args[0]!, args[1]!, args[2]!);
  process.stdout.write(JSON.stringify(result) + '\n');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main().catch(() => { process.stderr.write('live source verification failed\n'); process.exitCode = 1; });
}
