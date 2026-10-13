import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { probeTenantRace } from '../../demo/cloud/tenant-race.js';

const execFile = promisify(execFileCb);
const html = '<!doctype html><select id="tenant"><option value="tenant-a">A</option><option value="tenant-b">B</option></select><p id="status"></p><ul id="projects"></ul><script type="module" src="/app.js"></script>';
const oldScript = `const select=document.querySelector('#tenant'),list=document.querySelector('#projects'),status=document.querySelector('#status'); async function loadProjects(){const tenant=select.value; status.textContent='Loading'; try {const response=await fetch('/api/projects?tenant='+tenant); const result=await response.json(),projects=result.items; list.replaceChildren(...projects.map(p=>{const row=document.createElement('li');row.dataset.projectId=p.id;return row}));status.textContent=projects.length+' projects'}catch{list.replaceChildren();status.textContent='Could not load projects'}} select.addEventListener('change',loadProjects);loadProjects();`;
const repairedScript = `const select=document.querySelector('#tenant'),list=document.querySelector('#projects'),status=document.querySelector('#status');let generation=0; async function loadProjects(){const tenant=select.value, own=++generation; status.textContent='Loading'; try {const response=await fetch('/api/projects?tenant='+tenant); const result=await response.json(),projects=result.items; if(own!==generation)return; list.replaceChildren(...projects.map(p=>{const row=document.createElement('li');row.dataset.projectId=p.id;return row}));status.textContent=projects.length+' projects'}catch{if(own!==generation)return;list.replaceChildren();status.textContent='Could not load projects'}} select.addEventListener('change',loadProjects);loadProjects();`;

async function fixture(script: string) {
  const root = await mkdtemp(join(tmpdir(), 'tenant-race-git-'));
  const repository = join(root, 'repo.git');
  const work = join(root, 'work');
  await execFile('git', ['init', '--bare', repository]);
  await execFile('git', ['init', work]);
  await mkdir(join(work, 'demo/seed'), { recursive: true });
  await writeFile(join(work, 'demo/seed/index.ts'), `export const html = ${JSON.stringify(html)};\nexport const clientScript = ${JSON.stringify(script)};\n`);
  await execFile('git', ['-C', work, 'add', '.']);
  await execFile('git', ['-C', work, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']);
  await execFile('git', ['-C', work, 'push', repository, 'HEAD:refs/heads/main']);
  const { stdout } = await execFile('git', ['--git-dir', repository, 'rev-parse', 'refs/heads/main']);
  return { root, repository, commitOid: stdout.trim() };
}

describe('isolated exact-source tenant race probe', () => {
  it('demonstrates the stale A result with the original script and passes a generation-guard repair', async () => {
    const old = await fixture(oldScript);
    try {
      const result = await probeTenantRace({ repository: old.repository, commitOid: old.commitOid });
      expect(result.commitOid).toBe(old.commitOid);
      expect(result.passed).toBe(false);
      expect(result.cases[0]?.observed).toMatchObject({ tenant: 'tenant-b', ids: ['a-project'] });
    } finally { await rm(old.root, { recursive: true, force: true }); }

    const repaired = await fixture(repairedScript);
    try {
      const result = await probeTenantRace({ repository: repaired.repository, commitOid: repaired.commitOid });
      expect(result.commitOid).toBe(repaired.commitOid);
      expect(result.passed).toBe(true);
      expect(result.cases[0]?.observed).toMatchObject({ tenant: 'tenant-b', ids: ['b-project'] });
    } finally { await rm(repaired.root, { recursive: true, force: true }); }
  }, 120_000);

  it('refuses symbolic revisions and unsupported/non-JSON literal exports before browser execution', async () => {
    const invalid = await fixture(oldScript);
    try {
      await expect(probeTenantRace({ repository: invalid.repository, commitOid: 'main' })).rejects.toThrow(/exact lowercase 40-character/);
    } finally { await rm(invalid.root, { recursive: true, force: true }); }

    const malformed = await fixture(oldScript);
    try {
      const { stdout } = await execFile('git', ['--git-dir', malformed.repository, 'show', `${malformed.commitOid}:demo/seed/index.ts`]);
      const source = stdout.replace(`export const html = ${JSON.stringify(html)};`, 'export const html = getFixtureHtml();');
      const work = join(malformed.root, 'work');
      await writeFile(join(work, 'demo/seed/index.ts'), source);
      await execFile('git', ['-C', work, 'add', '.']);
      await execFile('git', ['-C', work, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'malformed']);
      await execFile('git', ['-C', work, 'push', '--force', malformed.repository, 'HEAD:refs/heads/main']);
      const { stdout: invalidOid } = await execFile('git', ['--git-dir', malformed.repository, 'rev-parse', 'refs/heads/main']);
      await expect(probeTenantRace({ repository: malformed.repository, commitOid: invalidOid.trim() })).rejects.toThrow(/Unsupported html export/);
    } finally { await rm(malformed.root, { recursive: true, force: true }); }
  });
});
