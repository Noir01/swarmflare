import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join, relative, sep } from 'node:path';

const TREE_ROOTS = ['apps', 'packages', 'tests', 'demo'];
const ROOT_FILES = [
  'README.md', 'GITTIFACTS-REUSE.md', 'package.json', 'package-lock.json',
  'tsconfig.json', 'vitest.config.ts', 'vitest.worker.config.ts', 'worker-configuration.d.ts', 'wrangler.jsonc',
  'packages/git-transport/LICENSE', 'packages/artifacts-source/LICENSE',
];
const OPTIONAL_ROOT_FILES = ['REVIEW.md'];
const EXCLUDED_SEGMENTS = new Set(['.git', '.local', '.execution', 'node_modules', 'reports', 'coverage', 'dist', 'build', '.wrangler', '.worktrees', '__pycache__']);
const ALLOWED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.py', '.html', '.css', '.txt', '.yml', '.yaml', '.toml', '.jsonc']);
const ALLOWED_BASENAMES = new Set(['LICENSE', 'PROVENANCE.md']);
const SECRET_NAME = /(^\.env($|\.)|^\.dev\.vars($|\.)|credential|secret|token|private[-_]?key|\.pem$|\.key$)/i;
export const REUSED_GITTIFACTS_COMMIT = '5f06eb4a5e425fdc4796774e3bd4284a0056288b';

export interface SnapshotFile { path: string; size: number; sha256: string }
export interface SnapshotManifest {
  format: 'local-source-snapshot-v1';
  snapshotId: string;
  status: 'supported-local-not-cloud-accepted';
  source: { upstreamGittifactsCommit: string };
  files: SnapshotFile[];
}
export interface ReleaseSnapshot { archive: Buffer; manifest: SnapshotManifest }

function sha256(data: Buffer | string): string { return createHash('sha256').update(data).digest('hex'); }
function normalized(p: string): string { return p.split(sep).join('/'); }
function isExcludedPath(p: string): boolean {
  return p.split('/').some(segment => segment.startsWith('.') || EXCLUDED_SEGMENTS.has(segment) || SECRET_NAME.test(segment));
}

export function createReleaseSnapshot(repositoryRoot: string): ReleaseSnapshot {
  const rootInfo = lstatSync(repositoryRoot);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('Refusing non-directory or symlink repository root');
  const root = repositoryRoot;
  const paths = new Set<string>();
  const visit = (absolute: string) => {
    const path = normalized(relative(root, absolute));
    if (isExcludedPath(path)) return;
    const info = lstatSync(absolute);
    if (info.isSymbolicLink()) throw new Error(`Refusing symlink in source allowlist: ${path}`);
    if (info.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) visit(join(absolute, name));
    } else if (info.isFile() && (ALLOWED_EXTENSIONS.has(extname(path)) || ALLOWED_BASENAMES.has(basename(path)))) {
      if (path.includes('\n') || path.includes('\r')) throw new Error(`Unsupported newline in path: ${path}`);
      paths.add(path);
    }
  };
  for (const name of TREE_ROOTS) visit(join(root, name));
  for (const path of ROOT_FILES) {
    if (!isExcludedPath(path)) {
      const absolute = join(root, path);
      const info = lstatSync(absolute);
      if (info.isSymbolicLink()) throw new Error(`Refusing symlink in source allowlist: ${path}`);
      if (!info.isFile()) throw new Error(`Expected allowlisted file: ${path}`);
      paths.add(path);
    }
  }
  for (const path of ['REVIEW.md', 'wrangler.demo.jsonc', '.github/workflows/deploy-development.yml']) {
    const optionalFile = join(root, path);
    try {
      if(path.startsWith('.github/'))for(const directory of ['.github','.github/workflows']){
        const parent=lstatSync(join(root,directory));
        if(parent.isSymbolicLink()||!parent.isDirectory())throw new Error(`Refusing unsafe deployment workflow directory: ${directory}`);
      }
      const info = lstatSync(optionalFile);
      if (info.isSymbolicLink()) throw new Error(`Refusing symlink in optional root file: ${path}`);
      if (!info.isFile()) throw new Error(`Refusing non-file optional root document: ${path}`);
      paths.add(path);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const sortedPaths = [...paths].sort();
  const contents = new Map(sortedPaths.map(path => [path, readFileSync(join(root, path))]));
  const files = sortedPaths.map(path => { const data = contents.get(path)!; return { path, size: data.byteLength, sha256: sha256(data) }; });
  const snapshotId = sha256(JSON.stringify({ format: 'local-source-snapshot-v1', files, upstreamGittifactsCommit: REUSED_GITTIFACTS_COMMIT }));
  const manifest: SnapshotManifest = {
    format: 'local-source-snapshot-v1', snapshotId,
    status: 'supported-local-not-cloud-accepted',
    source: { upstreamGittifactsCommit: REUSED_GITTIFACTS_COMMIT }, files,
  };
  const staging = mkdtempSync(join(tmpdir(), 'release-snapshot-'));
  try {
    for (const path of sortedPaths) { const target = join(staging, path); mkdirSync(join(target, '..'), { recursive: true }); writeFileSync(target, contents.get(path)!, { mode: 0o644 }); }
    const archive = execFileSync('tar', [
      '--create', '--file=-', '--format=ustar', '--sort=name', '--mtime=@0',
      '--owner=0', '--group=0', '--numeric-owner', '--mode=0644', '--null', '--verbatim-files-from', '--files-from=-',
    ], { cwd: staging, input: Buffer.from(sortedPaths.map(path => `${path}\0`).join('')), maxBuffer: 512 * 1024 * 1024,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC' } });
    return { archive, manifest };
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
