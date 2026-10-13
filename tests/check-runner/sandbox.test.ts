import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSandboxedNode } from '../../packages/git-runner/checks/sandbox.js';

async function fixture(script: string) {
  const dir = await mkdtemp(join(tmpdir(), 'sandbox-test-'));
  await writeFile(join(dir, 'main.js'), script);
  return dir;
}

describe('runSandboxedNode', () => {
  it('runs a candidate with clean environment and hidden host files, read-only snapshot and no network', async () => {
    const previousSentinel = process.env.SANDBOX_SENTINEL;
    process.env.SANDBOX_SENTINEL = 'host-only-secret';
    const dir = await fixture(`import fs from 'node:fs';
const checks = [!process.env.SANDBOX_SENTINEL, !fs.existsSync('/home/noir/.config'), !fs.existsSync('/home/noir/git-collaboration'), !fs.existsSync('/candidate/main.js.tmp')];
let readonly = false; try { fs.writeFileSync('/candidate/main.js.tmp', 'x'); } catch { readonly = true; }
let networkDenied = false; try { await fetch('https://example.com'); } catch { networkDenied = true; }
console.log(JSON.stringify({checks, readonly, networkDenied}));
`);
    try {
      const result = await runSandboxedNode({ candidateDirectory: dir, entrypoint: 'main.js' });
      expect(result.status).toBe('exited');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('"checks":[true,true,true,true]');
      expect(result.stdout).toContain('"readonly":true');
      expect(result.stdout).toContain('"networkDenied":true');
    } finally {
      if (previousSentinel === undefined) delete process.env.SANDBOX_SENTINEL; else process.env.SANDBOX_SENTINEL = previousSentinel;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('preserves exit status and bounds captured output', async () => {
    const dir = await fixture("console.log('hello'); console.error('problem'); process.exitCode=7;");
    try {
      const result = await runSandboxedNode({ candidateDirectory: dir, entrypoint: 'main.js' });
      expect(result.status).toBe('exited'); expect(result.exitCode).toBe(7);
      expect(result.stdout).toContain('hello'); expect(result.stderr).toContain('problem');
      expect(result.stdoutDigest).toMatch(/^[a-f0-9]{64}$/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('treats args only as script arguments and enforces snapshot byte limits', async () => {
    const dir = await fixture("console.log(JSON.stringify(process.argv.slice(2)))");
    try {
      const result = await runSandboxedNode({ candidateDirectory: dir, entrypoint: 'main.js', args: ['-e', 'process.exit(42)'] });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('[\"-e\",\"process.exit(42)\"]');
      await writeFile(join(dir, '.env.local'), 'do-not-copy');
      await expect(runSandboxedNode({ candidateDirectory: dir, entrypoint: '.env.local' })).rejects.toThrow();
      await writeFile(join(dir, 'large.bin'), Buffer.alloc(4 * 1024 * 1024 + 1));
      await expect(runSandboxedNode({ candidateDirectory: dir, entrypoint: 'main.js' })).rejects.toThrow(/snapshot size/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('kills a looping candidate on timeout', async () => {
    const dir = await fixture('while (true) {}');
    try {
      const result = await runSandboxedNode({ candidateDirectory: dir, entrypoint: 'main.js', timeoutMs: 250 });
      expect(result.status).toBe('timed-out'); expect(result.exitCode).toBeNull();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('kills a flooding candidate at the output cap', async () => {
    const dir = await fixture("setInterval(() => console.log('x'.repeat(1024)), 1);");
    try {
      const result = await runSandboxedNode({ candidateDirectory: dir, entrypoint: 'main.js', maxOutputBytes: 1024 });
      expect(result.status).toBe('output-limit'); expect(Buffer.byteLength(result.stdout + result.stderr)).toBeLessThanOrEqual(1024);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('rejects unsafe entrypoints, invalid bounds, symlinks and credential directories', async () => {
    const dir = await fixture('process.exit(0)');
    try {
      await expect(runSandboxedNode({ candidateDirectory: dir, entrypoint: '../main.js' })).rejects.toThrow();
      await expect(runSandboxedNode({ candidateDirectory: dir, entrypoint: 'main.js', timeoutMs: 10001 })).rejects.toThrow();
      await mkdir(join(dir, '.ssh')); await writeFile(join(dir, '.ssh', 'secret'), 'sensitive');
      // Credentials are omitted from the snapshot, even if present in a candidate tree.
      const result = await runSandboxedNode({ candidateDirectory: dir, entrypoint: 'main.js' });
      expect(result.exitCode).toBe(0);
      expect(await readFile(join(dir, '.ssh', 'secret'), 'utf8')).toBe('sensitive');
      await writeFile(join(dir, 'link'), 'x'); await rm(join(dir, 'link')); await import('node:fs/promises').then(fs => fs.symlink('/etc/passwd', join(dir, 'link')));
      await expect(runSandboxedNode({ candidateDirectory: dir, entrypoint: 'main.js' })).rejects.toThrow(/symlink/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('distinguishes a normal candidate exit 127 from sandbox startup failure', async () => {
    const dir = await fixture('process.exit(127)');
    try {
      const result = await runSandboxedNode({ candidateDirectory: dir, entrypoint: 'main.js' });
      expect(result.status).toBe('exited'); expect(result.exitCode).toBe(127);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('rejects missing and setup-refusing sandbox executables without a child-pid handshake', async () => {
    const dir = await fixture('console.log(process.env.SANDBOX_SENTINEL ?? "absent")');
    const original = process.env.BWRAP_PATH;
    const sentinel = process.env.SANDBOX_SENTINEL;
    process.env.SANDBOX_SENTINEL = 'host-only-secret';
    try {
      process.env.BWRAP_PATH = join(dir, 'does-not-exist');
      await expect(runSandboxedNode({ candidateDirectory: dir, entrypoint: 'main.js' })).rejects.toThrow();
      const refusing = join(dir, 'refusing-bwrap');
      await writeFile(refusing, '#!/bin/sh\necho "setup refused" >&2\nexit 1\n'); await chmod(refusing, 0o755);
      process.env.BWRAP_PATH = refusing;
      await expect(runSandboxedNode({ candidateDirectory: dir, entrypoint: 'main.js' })).rejects.toThrow(/startup failed/);
    } finally {
      if (original === undefined) delete process.env.BWRAP_PATH; else process.env.BWRAP_PATH = original;
      if (sentinel === undefined) delete process.env.SANDBOX_SENTINEL; else process.env.SANDBOX_SENTINEL = sentinel;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('bounds a multibyte UTF-8 write by bytes, not characters', async () => {
    const dir = await fixture("process.stdout.write('€')");
    try {
      const result = await runSandboxedNode({ candidateDirectory: dir, entrypoint: 'main.js', maxOutputBytes: 1 });
      expect(result.status).toBe('output-limit');
      expect(Buffer.byteLength(result.stdout + result.stderr)).toBeLessThanOrEqual(1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('rejects invalid UTF-8 after valid JSON bytes instead of returning a passing receipt', async () => {
    const dir = await fixture("process.stdout.write(Buffer.concat([Buffer.from('{}'), Buffer.from([0xff])]))");
    try {
      await expect(runSandboxedNode({ candidateDirectory: dir, entrypoint: 'main.js' })).rejects.toThrow(/invalid UTF-8/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('joins a timed-out descendant tree and leaves no marker process behind', async () => {
    expect((await readdir('/proc')).filter(name => /^\d+$/.test(name))).toContain(String(process.pid));
    const marker = `sandbox-descendant-${process.pid}-${Date.now()}`;
    const dir = await fixture(`import { spawn } from 'node:child_process';\nspawn(process.execPath, ['-e', 'console.log("descendant-live");while(true){}', ${JSON.stringify(marker)}], {stdio:['ignore','inherit','inherit']});\nwhile(true){}`);
    const matchingPids = async () => {
      const pids: number[] = [];
      for (const name of await readdir('/proc')) {
        if (!/^\d+$/.test(name)) continue;
        try { if ((await readFile(`/proc/${name}/cmdline`)).includes(Buffer.from(marker))) pids.push(Number(name)); } catch {}
      }
      return pids;
    };
    try {
      const result = await runSandboxedNode({ candidateDirectory: dir, entrypoint: 'main.js', timeoutMs: 500 });
      expect(result.status).toBe('timed-out');
      expect(result.stdout).toContain('descendant-live');
      for (let i = 0; i < 20 && (await matchingPids()).length; i++) await new Promise(resolve => setTimeout(resolve, 25));
      expect(await matchingPids()).toEqual([]);
    } finally {
      for (const pid of await matchingPids()) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      await rm(dir, { recursive: true, force: true });
    }
  });
});
