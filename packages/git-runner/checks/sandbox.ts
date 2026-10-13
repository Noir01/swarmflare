import { spawn } from 'node:child_process';
import { mkdtemp, lstat, readdir, mkdir, open, chmod, rm, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve, relative, sep, isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';

export interface SandboxExecution {
  status: 'exited' | 'timed-out' | 'output-limit';
  exitCode: number | null;
  stdout: string;
  stderr: string;
  startedAt: string;
  finishedAt: string;
  nodeVersion: string;
  stdoutDigest: string;
  stderrDigest: string;
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const denied = new Set(['.git', '.ssh', '.aws', '.config', '.gnupg', '.hermes', '.npm']);
const deniedFile = /^(?:\.env(?:\..*)?|.*(?:credential|secret|private[-_]?key).*)$/i;

async function copyTree(src: string, dst: string, root: string, state: { files: number; bytes: number }, depth = 0): Promise<void> {
  if (depth > 32) throw new Error('Candidate exceeds maximum snapshot depth');
  const stat = await lstat(src);
  if (stat.isSymbolicLink()) throw new Error('Candidate contains a symlink');
  if (stat.isDirectory()) {
    await mkdir(dst, { mode: 0o755 });
    for (const name of await readdir(src)) {
      if (denied.has(name.toLowerCase()) || deniedFile.test(name)) continue;
      await copyTree(join(src, name), join(dst, name), root, state, depth + 1);
    }
    await chmod(dst, 0o555);
  } else if (stat.isFile()) {
    await mkdir(dirname(dst), { recursive: true, mode: 0o555 });
    if (++state.files > 1000 || stat.size > 4 * 1024 * 1024 || state.bytes + stat.size > 20 * 1024 * 1024) throw new Error('Candidate exceeds snapshot size limits');
    const handle = await open(src, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const fresh = await handle.stat();
      if (!fresh.isFile() || fresh.ino !== stat.ino || fresh.dev !== stat.dev) throw new Error('Candidate changed during snapshot');
      const bytes = await handle.readFile();
      if (bytes.length > 4 * 1024 * 1024 || state.bytes + bytes.length > 20 * 1024 * 1024) throw new Error('Candidate exceeds snapshot size limits');
      state.bytes += bytes.length;
      await writeFile(dst, bytes, { mode: 0o600 });
    } finally { await handle.close(); }
    await chmod(dst, 0o444);
  } else throw new Error('Candidate contains a non-regular file');
  const rel = relative(root, dst);
  if (rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Candidate path escaped snapshot');
}

function decodeBounded(bytes: Buffer): string {
  for (let end = bytes.length; end >= 0; end--) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end)); } catch {}
  }
  return '';
}

export async function runSandboxedNode(options: {
  candidateDirectory: string; entrypoint: string; args?: string[]; timeoutMs?: number; maxOutputBytes?: number;
}): Promise<SandboxExecution> {
  const startedAt = new Date().toISOString();
  const timeout = options.timeoutMs ?? 3000;
  const maxBytes = options.maxOutputBytes ?? 16384;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 10000) throw new Error('timeoutMs must be 1..10000');
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 65536) throw new Error('maxOutputBytes must be 1..65536');
  const rel = options.entrypoint;
  if (!rel || /[\x00-\x1f\x7f]/.test(rel) || isAbsolute(rel) || rel.split(/[\\/]/).some(p => !p || p === '.' || p === '..') || rel.includes('\\') || rel.split('/').some(p => deniedFile.test(p) || denied.has(p.toLowerCase()))) throw new Error('Invalid relative entrypoint');
  const args = options.args ?? [];
  if (args.length > 32 || args.some(a => typeof a !== 'string' || a.length > 2048 || a.includes('\0'))) throw new Error('Arguments exceed sandbox bounds');
  const root = await mkdtemp(join(tmpdir(), 'git-runner-sandbox-'));
  let stdout = '', stderr = '';
  let outputBuffers: { stdout: Buffer[]; stderr: Buffer[] } = { stdout: [], stderr: [] };
  let status: SandboxExecution['status'] = 'exited';
  let exitCode: number | null = null;
  try {
    const candidate = resolve(options.candidateDirectory);
    const entry = resolve(candidate, rel);
    const from = relative(candidate, entry);
    if (from.startsWith(`..${sep}`) || from === '..' || isAbsolute(from)) throw new Error('Entrypoint escapes candidate directory');
    const canonicalCandidate = await realpath(candidate);
    const canonicalEntry = await realpath(entry);
    const canonicalRel = relative(canonicalCandidate, canonicalEntry);
    if (!canonicalRel || canonicalRel.startsWith(`..${sep}`) || isAbsolute(canonicalRel)) throw new Error('Entrypoint escapes candidate directory');
    await copyTree(candidate, join(root, 'candidate'), join(root, 'candidate'), { files: 0, bytes: 0 });
    const entryStat = await lstat(entry);
    if (!entryStat.isFile() || entryStat.isSymbolicLink()) throw new Error('Entrypoint must be a regular file');
    const node = process.execPath;
    if (!node.startsWith('/nix/store/')) throw new Error('Node executable is not in /nix/store');
    const bwrap = process.env.BWRAP_PATH ?? '/home/noir/.local/state/nix/profile/bin/bwrap';
    const { access } = await import('node:fs/promises');
    await access(bwrap);
    const command = [bwrap, '--unshare-all', '--die-with-parent', '--json-status-fd', '3', '--ro-bind', '/nix/store', '/nix/store', '--ro-bind', join(root, 'candidate'), '/candidate', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--chdir', '/candidate', '--clearenv', node, `/candidate/${rel}`, ...args];
    const result = await new Promise<{ code: number | null }>((resolvePromise, reject) => {
      const child = spawn(command[0]!, command.slice(1), { env: { PATH: '/nix/store' }, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
      let total = 0, settled = false, started = false, statusText = '', timer: ReturnType<typeof setTimeout>;
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      outputBuffers = { stdout: out, stderr: err };
      let stored = 0;
      const kill = () => { try { child.kill('SIGKILL'); } catch {} };
      const done = (v: { code: number | null } | Error) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (v instanceof Error) reject(v); else if (!started) reject(new Error('Sandbox startup failed')); else resolvePromise(v);
      };
      const append = (which: 'stdout' | 'stderr', chunk: Buffer) => {
        total += chunk.length;
        const room = Math.max(0, maxBytes - stored);
        const kept = chunk.subarray(0, room);
        stored += kept.length;
        (which === 'stdout' ? out : err).push(Buffer.from(kept));
        if (total > maxBytes) { status = 'output-limit'; kill(); }
      };
      child.stdout?.on('data', (c: Buffer) => append('stdout', c));
      child.stderr?.on('data', (c: Buffer) => append('stderr', c));
      child.stdio[3]?.on('data', (chunk: Buffer) => {
        statusText += chunk.toString('utf8');
        const lines = statusText.split('\n');
        statusText = lines.pop() ?? '';
        for (const line of lines) {
          try { const event = JSON.parse(line) as Record<string, unknown>; if (typeof event['child-pid'] === 'number') started = true; } catch {}
        }
      });
      child.on('error', e => done(e));
      child.on('close', code => done({ code }));
      timer = setTimeout(() => { status = 'timed-out'; kill(); }, timeout);
    });

    exitCode = status === 'exited' ? result.code : null;
    const decode = (chunks: Buffer[]) => {
      const bytes = Buffer.concat(chunks);
      try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch {
        if (status !== 'output-limit') throw new Error('Sandbox produced invalid UTF-8 output');
        return decodeBounded(bytes);
      }
    };
    // Decode only after child close, so malformed output is a bounded rejection,
    // never an asynchronous stream-handler exception that can pass an oracle.
    stdout = decode(outputBuffers.stdout); stderr = decode(outputBuffers.stderr);
  } finally {
    const unlock = async (path: string): Promise<void> => {
      try {
        await chmod(path, 0o700);
        for (const name of await readdir(path)) {
          const child = join(path, name);
          try { if ((await lstat(child)).isDirectory()) await unlock(child); else await chmod(child, 0o600); } catch {}
        }
      } catch {}
    };
    await unlock(root);
    await rm(root, { recursive: true, force: true });
  }
  return { status, exitCode, stdout, stderr, startedAt, finishedAt: new Date().toISOString(), nodeVersion: process.version, stdoutDigest: hash(stdout), stderrDigest: hash(stderr) };
}
