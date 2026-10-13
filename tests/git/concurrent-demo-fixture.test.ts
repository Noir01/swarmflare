import { expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runConcurrentContributors, writeConcurrentSeed, writeRepairedUi } from '../fixtures/concurrent-demo';

it('writes explicitly synthetic split seed and repaired pagination UI fixtures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'concurrent-demo-fixture-'));
  try {
    await writeConcurrentSeed(directory);
    const index = await readFile(join(directory, 'demo/seed/index.ts'), 'utf8');
    const api = await readFile(join(directory, 'demo/seed/api.ts'), 'utf8');
    const ui = await readFile(join(directory, 'demo/seed/ui.ts'), 'utf8');
    expect(index).toContain("from './api.ts'");
    expect(index).toContain("from './ui.ts'");
    expect(api).toContain('Response.json(records.filter');
    expect(ui).toContain('Project list seed');
    expect(ui).toContain("select.addEventListener('change', loadProjects)");
    await writeRepairedUi(directory);
    const repaired = await readFile(join(directory, 'demo/seed/ui.ts'), 'utf8');
    expect(repaired).toContain("tenant.addEventListener('change',()=>load(true))");
    expect(repaired).toContain('nextCursor');
    expect(repaired).not.toBe(ui);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('releases and joins both children when the loopback API is unavailable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'concurrent-demo-closed-loopback-'));
  try {
    const api = join(directory, 'api'), ui = join(directory, 'ui');
    await mkdir(api); await mkdir(ui);
    const started = Date.now();
    await expect(runConcurrentContributors({ root: directory, baseUrl: 'http://127.0.0.1:1', projectId: 'closed-loopback', baseCommitOid: '0'.repeat(40), apiDirectory: api, uiDirectory: ui, apiToken: 'synthetic-api', uiToken: 'synthetic-ui' })).rejects.toBeTruthy();
    expect(Date.now() - started).toBeLessThan(12_000);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
