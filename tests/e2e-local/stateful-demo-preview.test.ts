import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCursorRepair } from '../../demo/cloud/cursor-repair.js';
import { buildTenantRepair } from '../../demo/cloud/repair-fixture.js';
import { prepareRepository } from '../../demo/cloud/candidate-smoke.js';
import { buildDemoPreview } from '../../packages/git-runner/checks/demo-preview.js';
import { launchIsolatedBrowser } from '../../packages/browser-test/isolated.js';

let root = '';
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ''; });
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'false', GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: '/dev/null', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'] }).trim();

it('captures bounded signed-cursor pages from one real handler and replays exact offline URLs', async () => {
  root = await mkdtemp(join(tmpdir(), 'stateful-preview-'));
  const seed = join(root, 'seed'), cache = join(root, 'cache.git'); await mkdir(seed); git('init', seed);
  await writeFile(join(seed, 'README.md'), 'Synthetic baseline\n'); git('-C', seed, 'add', '.'); git('-C', seed, 'commit', '-qm', 'Synthetic baseline');
  const baseline = git('-C', seed, 'rev-parse', 'HEAD'); git('clone', '--bare', seed, cache);
  const prepared = await prepareRepository(cache, join(root, 'prepared'), baseline);
  git('--git-dir='+cache, 'fetch', join(root, 'prepared'), prepared.commitOid);
  const uiDir = join(root, 'ui'); await mkdir(uiDir);
  const ui = await buildTenantRepair({ cache, viewCommitOid: prepared.commitOid, baselineCommitOid: baseline, workDirectory: uiDir });
  git('--git-dir='+cache, 'fetch', join(root, 'ui'), ui.commitOid);
  const work = join(root, 'cursor-repair');
  const repaired = await buildCursorRepair({ cache, viewCommitOid: ui.commitOid, baselineCommitOid: baseline, workDirectory: work });
  expect(git('-C', work, 'rev-parse', 'HEAD')).toBe(repaired.commitOid);
  const source = await readFile(join(work, 'demo/seed/index.ts'), 'utf8');
  expect(source).toContain('createHmac');
  const artifact = await buildDemoPreview({ candidateDirectory: work, expiresAt: Date.now() + 60_000 });
  expect(artifact.supported).toBe('project-list-demo-v1');
  expect(artifact.html).toContain('a-project-03'); expect(artifact.html).toContain('b-project-02');
  expect(artifact.html).toContain('Offline response scope'); expect(artifact.html.length).toBeLessThanOrEqual(32000);
  expect(artifact.html).not.toContain('randomBytes(32)'); expect(artifact.html).not.toContain('createHmac');
  expect(artifact.html).toContain('Offline response scope');
});

it('renders signed pagination and previous-page state in an isolated browser', async () => {
  root = await mkdtemp(join(tmpdir(), 'stateful-preview-browser-'));
  const seed=join(root,'seed'),cache=join(root,'cache.git'); await mkdir(seed); git('init',seed); await writeFile(join(seed,'README.md'),'Synthetic baseline\n'); git('-C',seed,'add','.'); git('-C',seed,'commit','-qm','Synthetic baseline');
  const baseline=git('-C',seed,'rev-parse','HEAD'); git('clone','--bare',seed,cache); const prepared=await prepareRepository(cache,join(root,'prepared'),baseline); git('--git-dir='+cache,'fetch',join(root,'prepared'),prepared.commitOid);
  const uiDir=join(root,'ui'); await mkdir(uiDir); const ui=await buildTenantRepair({cache,viewCommitOid:prepared.commitOid,baselineCommitOid:baseline,workDirectory:uiDir}); git('--git-dir='+cache,'fetch',join(root,'ui'),ui.commitOid);
  const work=join(root,'cursor-repair'); await buildCursorRepair({cache,viewCommitOid:ui.commitOid,baselineCommitOid:baseline,workDirectory:work}); const artifact=await buildDemoPreview({candidateDirectory:work,expiresAt:Date.now()+60_000});
  const browser=await launchIsolatedBrowser({timeoutMs:15_000});
  try { const session=browser.pageSessionId; await browser.send('Fetch.enable',{patterns:[{urlPattern:'http://preview.invalid/*',requestStage:'Request'}]},session);
    const unsub=browser.on('Fetch.requestPaused',(p:any,sid?:string)=>{void browser.send('Fetch.fulfillRequest',{requestId:p.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'text/html; charset=utf-8'},{name:'Content-Security-Policy',value:"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; sandbox allow-scripts"}],body:Buffer.from(artifact.html).toString('base64')},sid).catch(()=>{});});
    await browser.send('Page.navigate',{url:'http://preview.invalid/'},session); const ids="[...document.querySelectorAll('[data-project-id]')].map(x=>x.dataset.projectId)";
    const poll=async(e:string)=>{for(let i=0;i<100;i++){const r=await browser.send('Runtime.evaluate',{expression:e,returnByValue:true},session);if(r.result?.value)return r.result.value;await new Promise(r=>setTimeout(r,50));}throw Error('Browser state timeout');};
    expect(await poll(`document.querySelectorAll('[data-project-id]').length===2&&${ids}`)).toEqual(['a-project-01','a-project-02']);
    await browser.send('Runtime.evaluate',{expression:"document.querySelector('#next-page').click()"},session); expect(await poll(`document.querySelectorAll('[data-project-id]').length===1&&${ids}`)).toEqual(['a-project-03']);
    await browser.send('Runtime.evaluate',{expression:"document.querySelector('#previous-page').click()"},session); expect(await poll(`document.querySelectorAll('[data-project-id]').length===2&&${ids}`)).toEqual(['a-project-01','a-project-02']);
    await browser.send('Runtime.evaluate',{expression:"const s=document.querySelector('#tenant');s.value='tenant-b';s.dispatchEvent(new Event('change',{bubbles:true}))"},session); expect(await poll(`document.querySelector('[data-project-id]')?.dataset.projectId==='b-project-01'&&${ids}`)).toEqual(['b-project-01','b-project-02']); unsub();
  } finally { await browser.close(); }
});
