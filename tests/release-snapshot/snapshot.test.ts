import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, rmSync, readdirSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { createReleaseSnapshot } from '../../packages/release-snapshot/index.js';

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'snapshot-test-'));
  roots.push(root);
  mkdirSync(join(root, 'apps/demo'), { recursive: true });
  mkdirSync(join(root, 'packages/core'), { recursive: true });
  mkdirSync(join(root, 'tests'), { recursive: true });
  mkdirSync(join(root, 'demo/runbook'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"scripts":{"test":"ok"}}\n');
  writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
  writeFileSync(join(root, 'tsconfig.json'), '{}\n');
  writeFileSync(join(root, 'apps/demo/main.ts'), 'export const value = 42;\n');
  writeFileSync(join(root, 'apps/demo/run fixture.mjs'), 'console.log("snapshot-runnable");\n');
  writeFileSync(join(root, 'packages/core/index.ts'), 'export {};\n');
  writeFileSync(join(root, 'tests/core.test.ts'), 'import { expect } from "vitest";\n');
  writeFileSync(join(root, 'demo/runbook/local.md'), 'Run locally.\n');
  for (const file of ['README.md', 'GITTIFACTS-REUSE.md', 'vitest.config.ts', 'vitest.worker.config.ts', 'worker-configuration.d.ts', 'wrangler.jsonc']) writeFileSync(join(root, file), 'fixture\n');
  mkdirSync(join(root, 'packages/git-transport'), { recursive: true });
  mkdirSync(join(root, 'packages/artifacts-source'), { recursive: true });
  writeFileSync(join(root, 'packages/git-transport/LICENSE'), 'MIT notice\n');
  writeFileSync(join(root, 'packages/artifacts-source/LICENSE'), 'MIT notice\n');
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('local release snapshot', () => {
  it('includes the public deployment workflow but not private GitHub state', () => {
    const root=fixture();mkdirSync(join(root,'.github/workflows'),{recursive:true});
    writeFileSync(join(root,'.github/workflows/deploy-development.yml'),'name: Deploy Swarmflare development\n');
    writeFileSync(join(root,'.github/credential.json'),'DO_NOT_PACKAGE');
    const paths=createReleaseSnapshot(root).manifest.files.map(f=>f.path);
    expect(paths).toContain('.github/workflows/deploy-development.yml');
    expect(paths).not.toContain('.github/credential.json');
  });

  it('is deterministic, content-addressed, excludes state/secrets and extracts to runnable source', () => {
    const root = fixture();
    mkdirSync(join(root, '.local')); writeFileSync(join(root, '.local/secret'), 'DO_NOT_READ');
    mkdirSync(join(root, '.execution')); writeFileSync(join(root, '.execution/state.json'), '{}');
    mkdirSync(join(root, 'node_modules/pkg'), { recursive: true }); writeFileSync(join(root, 'node_modules/pkg/index.js'), 'bad');
    mkdirSync(join(root, 'reports/workers'), { recursive: true }); writeFileSync(join(root, 'reports/workers/private.md'), 'bad');
    writeFileSync(join(root, '.env'), 'bad');
    writeFileSync(join(root, 'apps/demo/.dev.vars'), 'SECRET_SENTINEL');
    writeFileSync(join(root, 'apps/demo/unexpected.bin'), Buffer.from([0, 255, 0]));
    mkdirSync(join(root, 'demo/live'), { recursive: true });
    writeFileSync(join(root, 'demo/live/phase.pyc'), Buffer.from([1, 2, 3]));
    mkdirSync(join(root, 'apps/demo/.hidden')); symlinkSync('/etc/passwd', join(root, 'apps/demo/.hidden/outside.ts'));
    writeFileSync(join(root, 'apps/demo/name\\with-backslash.ts'), 'export {};\n');
    const a = createReleaseSnapshot(root);
    const b = createReleaseSnapshot(root);
    expect(a.archive.equals(b.archive)).toBe(true);
    expect(a.manifest.snapshotId).toBe(b.manifest.snapshotId);
    expect(a.manifest.status).toBe('supported-local-not-cloud-accepted');
    expect(a.manifest.files.some(f => f.path === 'package-lock.json')).toBe(true);
    expect(a.manifest.files.some(f => f.sha256.length !== 64 || f.size < 0)).toBe(false);
    const before = a.manifest.snapshotId;
    writeFileSync(join(root, 'apps/demo/main.ts'), 'export const value = 43;\n');
    expect(createReleaseSnapshot(root).manifest.snapshotId).not.toBe(before);
    const out = join(root, 'extracted'); mkdirSync(out);
    const extracted = spawnSync('tar', ['-xf', '-', '-C', out], { input: a.archive });
    expect(extracted.status).toBe(0);
    const extractedFiles: string[] = [];
    const walk = (dir: string) => { for (const name of readdirSync(dir)) { const file = join(dir, name); if (lstatSync(file).isDirectory()) walk(file); else extractedFiles.push(file.slice(out.length + 1)); } };
    walk(out);
    expect(extractedFiles.sort()).toEqual(a.manifest.files.map(f => f.path).sort());
    for (const f of a.manifest.files) { const bytes = readFileSync(join(out, f.path)); expect(bytes.byteLength).toBe(f.size); expect(createHash('sha256').update(bytes).digest('hex')).toBe(f.sha256); }
    const run = spawnSync(process.execPath, [join(out, 'apps/demo/run fixture.mjs')], { encoding: 'utf8' });
    expect(run.status).toBe(0); expect(run.stdout.trim()).toBe('snapshot-runnable');
    expect(readFileSync(join(out, 'apps/demo/main.ts'), 'utf8')).toContain('42');
    expect(readFileSync(join(out, 'package.json'), 'utf8')).toContain('"test"');
    expect(a.manifest.files.map(f => f.path).join('\n')).not.toMatch(/\.local|\.execution|node_modules|reports|\.env/);
    expect(a.archive.includes(Buffer.from('DO_NOT_READ'))).toBe(false);
    expect(a.archive.includes(Buffer.from('SECRET_SENTINEL'))).toBe(false);
    expect(a.manifest.files.some(f => /\.pyc$|unexpected\.bin|\.dev\.vars/.test(f.path))).toBe(false);
    expect(a.manifest.files.some(f => f.path.includes('name\\with-backslash.ts'))).toBe(true);
  });

  it('optionally includes the root demo Wrangler config deterministically without packaging private state', () => {
    const root = fixture();
    const absent = createReleaseSnapshot(root);
    expect(absent.manifest.files.some(f => f.path === 'wrangler.demo.jsonc')).toBe(false);

    writeFileSync(join(root, 'wrangler.demo.jsonc'), '{"name":"bounded-demo","main":"apps/demo/main.ts"}\n');
    mkdirSync(join(root, '.wrangler'), { recursive: true });
    writeFileSync(join(root, '.wrangler/state.json'), 'PRIVATE_WRANGLER_STATE_SENTINEL');
    mkdirSync(join(root, '.local'), { recursive: true });
    writeFileSync(join(root, '.local/private-config.json'), 'PRIVATE_CONFIG_SENTINEL');
    const first = createReleaseSnapshot(root);
    const second = createReleaseSnapshot(root);
    expect(first.manifest.files.some(f => f.path === 'wrangler.demo.jsonc')).toBe(true);
    expect(first.archive.equals(second.archive)).toBe(true);
    expect(first.manifest.snapshotId).toBe(second.manifest.snapshotId);
    expect(first.archive.includes(Buffer.from('bounded-demo'))).toBe(true);
    expect(first.archive.includes(Buffer.from('PRIVATE_WRANGLER_STATE_SENTINEL'))).toBe(false);
    expect(first.archive.includes(Buffer.from('PRIVATE_CONFIG_SENTINEL'))).toBe(false);
    expect(first.manifest.status).toBe('supported-local-not-cloud-accepted');
  });

  it('rejects a symlink at the optional root demo Wrangler config path', () => {
    const root = fixture();
    const outside = join(root, 'outside.jsonc');
    writeFileSync(outside, '{"private":"not packaged"}');
    symlinkSync(outside, join(root, 'wrangler.demo.jsonc'));
    expect(() => createReleaseSnapshot(root)).toThrow(/symlink/i);
  });

  it('rejects symlinks in the source allowlist', () => {
    const root = fixture();
    symlinkSync('/etc/passwd', join(root, 'apps/demo/linked.ts'));
    expect(() => createReleaseSnapshot(root)).toThrow(/symlink/i);
  });

  it('rejects a symlink repository root', () => {
    const root = fixture(); const link = `${root}-link`; roots.push(link); symlinkSync(root, link);
    expect(() => createReleaseSnapshot(link)).toThrow(/symlink repository root/i);
  });
});
