import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { buildTenantRepair, tenantRepairClientScript } from '../../demo/cloud/repair-fixture.js';
import { probeTenantRace } from '../../demo/cloud/tenant-race.js';
import { launchIsolatedBrowser } from '../../packages/browser-test/isolated.js';
import { prepareRepository } from '../../demo/cloud/candidate-smoke.js';

const execFile = promisify(execFileCb);
let view = '', baseline = '', cache = '';
const git = async (repository: string, ...args: string[]) => (await execFile('git', [`--git-dir=${repository}`, ...args])).stdout.trim();
const workGit = async (repository: string, ...args: string[]) => (await execFile('git', ['-C', repository, ...args])).stdout.trim();
const oid = (value: string) => /^[0-9a-f]{40}$/.test(value);

async function browserNavigation(html: string) {
  const browser = await launchIsolatedBrowser({ timeoutMs: 55_000 });
  try {
    const session = browser.pageSessionId;
    const evaluate = async (expression: string, params: Record<string, unknown> = {}) => {
      const reply = await browser.send('Runtime.evaluate', { expression, ...params }, session);
      if (reply.exceptionDetails) throw new Error(JSON.stringify(reply.exceptionDetails));
      return reply;
    };
    await browser.send('Page.navigate', { url: 'about:blank' }, session);
    const frameId = (await browser.send('Page.getFrameTree', {}, session)).frameTree.frame.id;
    await browser.send('Page.setDocumentContent', { frameId, html: html.replace('<script type="module" src="/app.js"></script>', '') }, session);
    await new Promise(r => setTimeout(r, 50));
    await evaluate(`window.__pending=[];window.fetch=(url)=>new Promise(resolve=>__pending.push({url:String(url),resolve}))`);
    await evaluate(tenantRepairClientScript);
    const settle = async (index: number, payload: object) => {
      await evaluate(`__pending[${index}].resolve({ok:true,json:async()=>(${JSON.stringify(payload)})})`, { awaitPromise: true });
      await new Promise(r => setTimeout(r, 30));
    };
    const first = await evaluate(`JSON.stringify(__pending.map(x=>x.url))`, { returnByValue: true });
    const initial = JSON.parse(first.result.value as string) as string[];
    expect(initial).toHaveLength(1);
    await settle(0, { items: [{ id: 'page-1', name: 'Page one' }], nextCursor: 'cursor-2' });
    await evaluate(`document.querySelector('#next-page').click()`);
    const second = await evaluate(`JSON.stringify(__pending.map(x=>x.url))`, { returnByValue: true });
    const urls = JSON.parse(second.result.value as string) as string[];
    expect(urls[1]).toContain('cursor=cursor-2');
    await settle(1, { items: [{ id: 'page-2', name: 'Page two' }], nextCursor: 'cursor-3' });
    await evaluate(`document.querySelector('#previous-page').click()`);
    const third = await evaluate(`JSON.stringify(__pending.map(x=>x.url))`, { returnByValue: true });
    const urlsAfterPrevious = JSON.parse(third.result.value as string) as string[];
    expect(urlsAfterPrevious[2]).not.toContain('cursor=');
    await settle(2, { items: [{ id: 'page-1', name: 'Page one' }], nextCursor: 'cursor-2' });
    const state = await evaluate(`JSON.stringify({ids:[...document.querySelectorAll('#projects [data-project-id]')].map(x=>x.dataset.projectId),previous:document.querySelector('#previous-page').disabled,next:document.querySelector('#next-page').disabled})`, { returnByValue: true });
    expect(JSON.parse(state.result.value as string)).toEqual({ ids: ['page-1'], previous: true, next: false });
  } finally { await browser.close(); }
}

describe('native-source tenant repair fixture', () => {
  it('repairs exact imported source as a baseline-parented full delta and passes real isolated obligations', async () => {
    const fixtureRoot=await mkdtemp(join(tmpdir(),'repair-source-')),seed=join(fixtureRoot,'seed'),prepared=join(fixtureRoot,'prepared');cache=join(fixtureRoot,'cache.git');
    await execFile('git',['init','-q',seed]);await writeFile(join(seed,'README.md'),'Synthetic unchanged README\n');await execFile('git',['-C',seed,'add','README.md']);await execFile('git',['-C',seed,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','-qm','seed']);baseline=await workGit(seed,'rev-parse','HEAD');await execFile('git',['clone','--bare','-q',seed,cache]);const source=await prepareRepository(cache,prepared,baseline);view=source.commitOid;await execFile('git',['--git-dir='+cache,'fetch','-q',prepared,view+':refs/agent/views/b44d6d61-b502-40b2-b254-17e1669edc5f']);
    const originalRef = await git(cache, 'rev-parse', 'refs/agent/views/b44d6d61-b502-40b2-b254-17e1669edc5f');
    const originalTree = await git(cache, 'rev-parse', `${view}^{tree}`);
    const before = await git(cache, 'show', `${view}:demo/seed/index.ts`);
    const readmeBefore = await git(cache, 'show', `${view}:README.md`).catch(() => 'absent');
    const workDirectory = await mkdtemp(join(tmpdir(), 'tenant-repair-'));
    await rm(workDirectory, { recursive: true, force: true });
    await mkdir(workDirectory);
    try {
      const result = await buildTenantRepair({ cache, viewCommitOid: view, baselineCommitOid: baseline, workDirectory });
      expect(oid(result.commitOid)).toBe(true);
      expect(oid(result.treeOid)).toBe(true);
      expect(result.commitOid).not.toBe(view);
      expect(await workGit(workDirectory, 'rev-parse', 'HEAD^')).toBe(baseline);
      expect(await git(cache, 'rev-parse', 'refs/agent/views/b44d6d61-b502-40b2-b254-17e1669edc5f')).toBe(originalRef);
      expect(await git(cache, 'rev-parse', `${view}^{tree}`)).toBe(originalTree);
      const after = await workGit(workDirectory, 'show', `${result.commitOid}:demo/seed/index.ts`);
      expect(after).toContain('export const html=');
      expect(after).toContain('previous-page');
      const handlerBefore = before.slice(0, before.indexOf('export const html='));
      const handlerAfter = after.slice(0, after.indexOf('export const html='));
      expect(handlerAfter).toBe(handlerBefore);
      const readmeAfter = await workGit(workDirectory, 'show', `${result.commitOid}:README.md`).catch(() => 'absent');
      expect(readmeAfter).toBe(readmeBefore);
      expect(await workGit(workDirectory, 'diff-tree', '--no-commit-id', '--name-only', '-r', result.commitOid)).toBe('demo/seed/index.ts');
      const probeRepository = join(workDirectory, 'probe.git');
      await execFile('git', ['clone', '--bare', workDirectory, probeRepository]);
      const probe = await probeTenantRace({ repository: probeRepository, commitOid: result.commitOid });
      expect(probe.passed).toBe(true);
      await browserNavigation((await import('../../demo/cloud/repair-fixture.js')).tenantRepairClientScript.includes('previous-page') ? extractLiteral(after, 'html') : '');
    } finally { await rm(workDirectory, { recursive: true, force: true }); await rm(fixtureRoot,{recursive:true,force:true}); }
  }, 120_000);

  it('rejects malformed OIDs before touching caller work directory', async () => {
    const workDirectory = await mkdtemp(join(tmpdir(), 'tenant-repair-invalid-'));
    try { await expect(buildTenantRepair({ cache, viewCommitOid: 'main', baselineCommitOid: baseline, workDirectory })).rejects.toThrow(/lowercase 40-character/); }
    finally { await rm(workDirectory, { recursive: true, force: true }); }
  });
});

function extractLiteral(source: string, name: string): string {
  const match = source.match(new RegExp(`export\\s+const\\s+${name}\\s*=\\s*("(?:\\\\.|[^"\\\\])*")\\s*;`));
  if (!match) throw new Error(`Missing ${name} literal`);
  return JSON.parse(match[1]!) as string;
}
