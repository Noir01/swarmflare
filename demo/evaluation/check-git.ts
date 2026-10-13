import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { applicabilitySchema } from '../../packages/contracts/index.js';
import { runMandatoryDemoSuite, mandatoryDemoSuiteDigest } from '../../packages/git-runner/checks/mandatory-demo-suite.js';

const exec = promisify(execFile);
const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0', GIT_CONFIG_PARAMETERS: '', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'file', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1' };
async function git(directory: string, args: string[], encoding: 'utf8' | 'buffer' = 'utf8'): Promise<string | Buffer> {
  const result = await exec('git', ['-C', directory, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', '-c', 'diff.external=', '-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.clean=', ...args], { env, timeout: 5000, maxBuffer: 32 * 1024 * 1024, encoding });
  return result.stdout as string | Buffer;
}
const maxFiles = 1000, maxTotal = 20 * 1024 * 1024, maxBlob = 4 * 1024 * 1024, maxDepth = 32;
async function binding(directory: string) {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('candidateDirectory must be a local directory');
  const root = (await git(directory, ['rev-parse', '--show-toplevel']) as string).trim();
  if (resolve(root) !== resolve(directory)) throw new Error('candidateDirectory must be the Git worktree root');
  const commitOid = (await git(directory, ['rev-parse', '--verify', 'HEAD^{commit}']) as string).trim();
  const treeOid = (await git(directory, ['rev-parse', '--verify', 'HEAD^{tree}']) as string).trim();
  if (!/^[0-9a-f]{40}$/.test(commitOid) || !/^[0-9a-f]{40}$/.test(treeOid)) throw new Error('invalid Git object ID');
  const listing = await git(directory, ['ls-tree', '-r', '-z', '--full-tree', treeOid], 'buffer') as Buffer;
  const files = new Map<string, { oid: string; bytes: Buffer; mode: string }>(); let committedTotal = 0;
  let listingText: string;
  try { listingText = new TextDecoder('utf-8', { fatal: true }).decode(listing); } catch { throw new Error('Git tree contains invalid UTF-8 path'); }
  for (const record of listingText.split('\0').filter(Boolean)) {
    const match = record.match(/^(100644|100755|120000|160000) blob ([0-9a-f]{40})\t([\s\S]+)$/);
    if (!match || match[1] === '120000' || match[1] === '160000') throw new Error('Git tree contains unsupported mode or unsafe path');
    const [, mode, oid, path] = match;
    if (!path || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..' || part === '.git') || path.includes('\\')) throw new Error('Git tree contains unsafe path');
    if (files.size >= maxFiles) throw new Error('Git tree exceeds file bound');
    const bytes = await git(directory, ['cat-file', 'blob', oid], 'buffer') as Buffer;
    if (bytes.length > maxBlob || (committedTotal += bytes.length) > maxTotal) throw new Error('Git tree exceeds byte bound');
    files.set(path, { oid, bytes, mode });
  }
  // Compare literal worktree bytes and names: ignores and index flags are irrelevant.
  const seen = new Set<string>();
  let worktreeTotal = 0;
  async function walk(dir: string, prefix = '', depth = 0): Promise<void> {
    if (depth > maxDepth) throw new Error('candidate exceeds worktree depth bound');
    for (const name of await readdir(dir, { encoding: 'buffer' })) {
      const decoded = name.toString('utf8');
      if (!Buffer.from(decoded, 'utf8').equals(name)) throw new Error('candidate contains invalid UTF-8 path');
      const textName = decoded;
      if (!prefix && textName === '.git') continue;
      const path = prefix ? `${prefix}/${textName}` : textName, full = join(dir, textName), st = await lstat(full);
      if (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile())) throw new Error('candidate contains symlink or non-regular path');
      if (st.isDirectory()) { await walk(full, path, depth + 1); continue; }
      if (seen.size >= maxFiles || st.size > maxBlob || (worktreeTotal += st.size) > maxTotal) throw new Error('candidate exceeds worktree file or byte bound');
      const expected = files.get(path);
      if (!expected || st.size !== expected.bytes.length || !(await readFile(full)).equals(expected.bytes)) throw new Error('candidate Git worktree is not clean: bytes differ from committed tree (including ignored or untracked source)');
      seen.add(path);
    }
  }
  await walk(directory);
  if (seen.size !== files.size) throw new Error('candidate worktree is missing committed source');
  return { commitOid, treeOid, files };
}
export async function checkGitCandidate(options: { candidateDirectory: string; outputPath: string; projectId: string; viewId: string }) {
  if (!isAbsolute(options.candidateDirectory) || !isAbsolute(options.outputPath) || options.candidateDirectory.includes('://') || options.outputPath.includes('://') || !/^[A-Za-z0-9_-]{1,120}$/.test(options.projectId) || !/^[A-Za-z0-9_-]{1,120}$/.test(options.viewId)) throw new Error('invalid candidate binding arguments');
  const candidateDirectory = resolve(options.candidateDirectory), outputPath = resolve(options.outputPath);
  const outputRelative = relative(candidateDirectory, outputPath);
  if (outputRelative === '' || (!outputRelative.startsWith(`..${sep}`) && outputRelative !== '..' && !isAbsolute(outputRelative))) throw new Error('outputPath must be outside the candidate directory');
  const before = await binding(candidateDirectory);
  const manifestDigest = createHash('sha256').update(JSON.stringify({ projectId: options.projectId, viewId: options.viewId, commitOid: before.commitOid, treeOid: before.treeOid })).digest('hex');
  const applicability = applicabilitySchema.parse({ projectId: options.projectId, viewId: options.viewId, manifestDigest, composedCommitOid: before.commitOid, treeOid: before.treeOid, contractVersion: 1, policyVersion: 1, checkSuiteDigest: mandatoryDemoSuiteDigest() });
  const materialized = await mkdtemp(join(tmpdir(), 'git-baseline-materialized-'));
  let checks;
  try {
    for (const [path, entry] of before.files) { const target = join(materialized, path); await mkdir(join(target, '..'), { recursive: true }); await writeFile(target, entry.bytes, { mode: entry.mode === '100755' ? 0o555 : 0o444, flag: 'wx' }); }
    checks = await runMandatoryDemoSuite({ candidateDirectory: materialized, applicability });
  } finally { await rm(materialized, { recursive: true, force: true }); }
  const after = await binding(candidateDirectory);
  if (before.commitOid !== after.commitOid || before.treeOid !== after.treeOid) throw new Error('candidate Git binding changed while checks ran');
  const allPassed = checks.length > 0 && checks.every(check => check.result === 'passed' && check.execution.status === 'exited' && check.execution.exitCode === 0);
  const document = { format: 'git-baseline-check-v1', generatedAt: new Date().toISOString(), projectId: options.projectId, viewId: options.viewId, source: { commitOid: before.commitOid, treeOid: before.treeOid, bindingMethod: 'bounded-git-tree-blob-materialization-v1' }, checkSuiteDigest: mandatoryDemoSuiteDigest(), checks, allPassed };
  await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return document;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || !isAbsolute(args[0] ?? '') || !isAbsolute(args[1] ?? '')) {
    console.error('usage: check-git <absolute-candidateDirectory> <absolute-outputPath> <projectId> <viewId>'); process.exitCode = 2;
  } else {
    try { const document = await checkGitCandidate({ candidateDirectory: args[0]!, outputPath: args[1]!, projectId: args[2]!, viewId: args[3]! }); console.log(JSON.stringify(document)); if (!document.allPassed) process.exitCode = 1; }
    catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
  }
}
