import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observePage } from '../../demo/live/page-observation.js';
import { buildPaginatedDemo, paginatedClientScript } from '../fixtures/paginated-demo.js';

async function sourceRepo(source: string, extra?: (work: string, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'page-observation-test-'));
  const bare = join(root, 'remote.git');
  execFileSync('git', ['init', '--bare', bare], { stdio: 'ignore' });
  const work = join(root, 'work'); await mkdir(join(work, 'demo/seed'), { recursive: true });
  execFileSync('git', ['init', work], { stdio: 'ignore' });
  await writeFile(join(work, 'demo/seed/index.ts'), source);
  await extra?.(work, root);
  execFileSync('git', ['-C', work, 'add', '.']);
  execFileSync('git', ['-C', work, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture'], { stdio: 'ignore' });
  const oid = execFileSync('git', ['-C', work, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  execFileSync('git', ['-C', bare, 'fetch', work, `${oid}:refs/agent/views/test-view`], { stdio: 'ignore' });
  return { root, bare, output: join(root, 'observed.json') };
}

describe('diagnostic page observation', () => {
  it('records the actual distinct second page DOM from a paginated fixture', async () => {
    const repo = await sourceRepo(buildPaginatedDemo());
    try {
      const result = await observePage(repo.bare, 'test-view', repo.output);
      expect(result.observations.firstPage.ids).toEqual(['a-project-01', 'a-project-02']);
      expect(result.observations.secondPage.ids).toEqual(['a-project-03']);
      expect(result.observations.secondPage.ids).not.toEqual(result.observations.firstPage.ids);
      expect(JSON.parse(await readFile(repo.output, 'utf8')).diagnosticOnly).toBe(true);
    } finally { await rm(repo.root, { recursive: true, force: true }); }
  }, 35000);
  it('shows append behavior retaining first-page rows after Next', async () => {
    const appendScript = paginatedClientScript.replace('list.replaceChildren();for(const p of d.items)', 'for(const p of d.items)');
    expect(appendScript).not.toBe(paginatedClientScript);
    const repo = await sourceRepo(buildPaginatedDemo(appendScript));
    try {
      const result = await observePage(repo.bare, 'test-view', repo.output);
      expect(result.observations.secondPage.ids).toEqual(['a-project-01', 'a-project-02', 'a-project-03']);
      expect(result.observations.secondPage.ids).not.toEqual(result.observations.firstPage.ids);
    } finally { await rm(repo.root, { recursive: true, force: true }); }
  }, 35000);

  it('rejects a tracked driver symlink without modifying its outside target', async () => {
    const repo = await sourceRepo(buildPaginatedDemo(), async (work, root) => {
      const outside = join(root, 'outside-driver-target');
      await writeFile(outside, 'unchanged');
      await symlink(outside, join(work, '.page-observation-driver.mjs'));
    });
    try {
      const outside = join(repo.root, 'outside-driver-target');
      await expect(observePage(repo.bare, 'test-view', repo.output)).rejects.toThrow(/symlink|non-regular/i);
      expect(await readFile(outside, 'utf8')).toBe('unchanged');
    } finally { await rm(repo.root, { recursive: true, force: true }); }
  });

  it('rejects oversized tracked blobs before materialization', async () => {
    const repo = await sourceRepo(buildPaginatedDemo(), async work => {
      await writeFile(join(work, 'oversized.bin'), Buffer.alloc(4 * 1024 * 1024 + 1));
    });
    try {
      await expect(observePage(repo.bare, 'test-view', repo.output)).rejects.toThrow(/size limit/i);
    } finally { await rm(repo.root, { recursive: true, force: true }); }
  });
});
