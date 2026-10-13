import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkGitCandidate } from '../../demo/evaluation/check-git.js';
let root = '';
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ''; });
async function fixture() {
  root = await mkdtemp(join(tmpdir(), 'check-git-test-'));
  const candidateDirectory = join(root, 'candidate'); await mkdir(candidateDirectory);
  const git = (args: string[]) => execFileSync('git', ['-C', candidateDirectory, ...args], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: 'ignore' });
  git(['init', '-q']); git(['config', 'user.email', 'fixture@example.invalid']); git(['config', 'user.name', 'Fixture']);
  await mkdir(join(candidateDirectory, 'demo/seed'), { recursive: true });
  await writeFile(join(candidateDirectory, 'demo/seed/index.ts'), "export function createProjectListHandler(){return async (request:Request)=>{return new Response('[]')}}; export const html='<select id=\"tenant\"></select><button id=\"next-page\"></button><div id=\"projects\"></div><div id=\"status\"></div>'; export const clientScript='';");
  git(['add', '.']); git(['commit', '-qm', 'synthetic test fixture']);
  return { candidateDirectory, outputPath: join(root, 'result.json') };
}
describe('checkGitCandidate', () => {
  it('binds receipts to exact OIDs and reads back actual failed receipts from a labelled synthetic fixture', async () => {
    const input = await fixture();
    const result = await checkGitCandidate({ ...input, projectId: 'project-test', viewId: 'view-test' });
    const saved = JSON.parse(await readFile(input.outputPath, 'utf8'));
    expect(result.source.commitOid).toMatch(/^[0-9a-f]{40}$/); expect(result.source.treeOid).toMatch(/^[0-9a-f]{40}$/);
    expect(saved).toEqual(result); expect(result.checks).toHaveLength(2);
    expect(result.checks.every(check => check.result === 'failed')).toBe(true); expect(result.allPassed).toBe(false);
    expect(result.checks.every(check => check.execution.stdout.length > 0 || check.execution.stderr.length > 0)).toBe(true);
  });
  it('rejects staged/modified and untracked bytes before output', async () => {
    const input = await fixture(); await writeFile(join(input.candidateDirectory, 'untracked.ts'), 'not committed');
    await expect(checkGitCandidate({ ...input, projectId: 'p', viewId: 'v' })).rejects.toThrow(/not clean/);
    await rm(join(input.candidateDirectory, 'untracked.ts')); await writeFile(join(input.candidateDirectory, 'demo/seed/index.ts'), 'dirty');
    await expect(checkGitCandidate({ ...input, projectId: 'p', viewId: 'v' })).rejects.toThrow(/not clean/);
    await expect(readFile(input.outputPath)).rejects.toThrow();
  });
  it('rejects ignored and assume-unchanged worktree bytes despite clean status', async () => {
    const input = await fixture();
    await writeFile(join(input.candidateDirectory, '.gitignore'), 'hidden.ts\n');
    execFileSync('git', ['-C', input.candidateDirectory, 'add', '.gitignore']); execFileSync('git', ['-C', input.candidateDirectory, 'commit', '-qm', 'ignore fixture']);
    await writeFile(join(input.candidateDirectory, 'hidden.ts'), 'ignored');
    await expect(checkGitCandidate({ ...input, projectId: 'p', viewId: 'v' })).rejects.toThrow(/not clean/);
    await rm(join(input.candidateDirectory, 'hidden.ts'));
    execFileSync('git', ['-C', input.candidateDirectory, 'update-index', '--assume-unchanged', 'demo/seed/index.ts']);
    await writeFile(join(input.candidateDirectory, 'demo/seed/index.ts'), 'changed while assume-unchanged');
    await expect(checkGitCandidate({ ...input, projectId: 'p', viewId: 'v' })).rejects.toThrow(/not clean/);
  });
  it('records bounded committed-tree materialization and strict 40-character OIDs', async () => {
    const input = await fixture();
    const result = await checkGitCandidate({ ...input, projectId: 'p', viewId: 'v' });
    expect(result.source.commitOid).toMatch(/^[0-9a-f]{40}$/); expect(result.source.treeOid).toMatch(/^[0-9a-f]{40}$/);
    expect(result.source.bindingMethod).toBe('bounded-git-tree-blob-materialization-v1');
  });
  it('runs checks for a clean committed tree above 10 MiB but below the 20 MiB bound', async () => {
    const input = await fixture();
    for (let i = 0; i < 3; i++) await writeFile(join(input.candidateDirectory, `blob-${i}.bin`), Buffer.alloc(4 * 1024 * 1024, i));
    execFileSync('git', ['-C', input.candidateDirectory, 'add', '.']);
    execFileSync('git', ['-C', input.candidateDirectory, 'commit', '-qm', 'large bounded fixture']);
    const result = await checkGitCandidate({ ...input, projectId: 'p', viewId: 'v' });
    expect(result.checks).toHaveLength(2);
    expect(result.checks.every(check => check.result === 'failed')).toBe(true);
    expect(result.allPassed).toBe(false);
    expect(JSON.parse(await readFile(input.outputPath, 'utf8'))).toEqual(result);
  });
  it('ignores Git replacement refs when binding the receipt to HEAD', async () => {
    const input = await fixture();
    const git = (args: string[]) => execFileSync('git', ['-C', input.candidateDirectory, ...args], { encoding: 'utf8' }).trim();
    const original = git(['rev-parse', 'HEAD']);
    await writeFile(join(input.candidateDirectory, 'replacement.txt'), 'replacement commit content');
    execFileSync('git', ['-C', input.candidateDirectory, 'add', '.']);
    execFileSync('git', ['-C', input.candidateDirectory, 'commit', '-qm', 'replacement fixture']);
    const replacement = git(['rev-parse', 'HEAD']);
    execFileSync('git', ['-C', input.candidateDirectory, 'checkout', '-q', original]);
    execFileSync('git', ['-C', input.candidateDirectory, 'replace', original, replacement]);
    const result = await checkGitCandidate({ ...input, projectId: 'p', viewId: 'v' });
    expect(result.source.commitOid).toBe(original);
  });
  it('rejects non-root paths and invalid identities', async () => {
    const input = await fixture();
    await expect(checkGitCandidate({ ...input, candidateDirectory: join(input.candidateDirectory, 'demo'), projectId: 'p', viewId: 'v' })).rejects.toThrow(/worktree root/);
    await expect(checkGitCandidate({ ...input, projectId: '../p', viewId: 'v' })).rejects.toThrow(/invalid candidate binding/);
  });
  it('rejects relative and URL-style paths before creating a receipt', async () => {
    const input = await fixture();
    await expect(checkGitCandidate({ ...input, candidateDirectory: 'relative', projectId: 'p', viewId: 'v' })).rejects.toThrow(/invalid candidate binding/);
    await expect(checkGitCandidate({ ...input, outputPath: 'file:///tmp/result', projectId: 'p', viewId: 'v' })).rejects.toThrow(/invalid candidate binding/);
    await expect(readFile(input.outputPath)).rejects.toThrow();
  });
  it('rejects unsafe symlink paths before creating a receipt', async () => {
    const input = await fixture();
    await symlink('/etc/passwd', join(input.candidateDirectory, 'outside-link'));
    await expect(checkGitCandidate({ ...input, projectId: 'p', viewId: 'v' })).rejects.toThrow(/symlink/);
    await expect(readFile(input.outputPath)).rejects.toThrow();
  });
});
