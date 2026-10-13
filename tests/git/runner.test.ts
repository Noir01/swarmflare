import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PublishedRevision } from '../../packages/contracts/index.js';
import { composeAndPublishView, composeView, publishRevision, publishSeed, readSourceReceipt } from '../../packages/git-runner/index.js';

const roots: string[] = [];
const execFileAsync = promisify(execFile);
const scratch = () => { const base = process.env.TMPDIR || join(process.cwd(), '.local'); mkdirSync(base, { recursive: true }); const p = mkdtempSync(join(base, 'git-runner-')); roots.push(p); return p; };
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } }).trim();
const init = (dir: string) => { mkdirSync(dir, { recursive: true }); git(dir, 'init', '-q'); git(dir, 'config', 'user.name', 'Test'); git(dir, 'config', 'user.email', 'test@example.invalid'); };
const commit = (dir: string, message: string) => { git(dir, 'add', '-A'); git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', message); return git(dir, 'rev-parse', 'HEAD'); };
const rev = (changeId: string, revisionId: string, baseCommitOid: string, commitOid: string, treeOid: string, dependencies: PublishedRevision[] = []): PublishedRevision => ({ changeId, revisionId, owner: 'test', baseCommitOid, commitOid, treeOid, obligationIds: ['obl'], decisionRevisions: [], dependencies: dependencies.map(x => ({ changeId: x.changeId, revisionId: x.revisionId })) });

describe('real Git runner', () => {
 it('publishes immutable refs, fetches exact source identity, and composes exact tree', async () => {
  const root = scratch(), bare = join(root, 'remote.git'), work = join(root, 'work'), clone = join(root, 'clone');
  execFileSync('git', ['init', '--bare', '-q', bare]); init(work); writeFileSync(join(work, 'base.txt'), 'base\n'); const base = commit(work, 'base'); git(work, 'remote', 'add', 'origin', bare); git(work, 'push', '-q', 'origin', 'HEAD:refs/heads/main'); execFileSync('git',['--git-dir',bare,'symbolic-ref','HEAD','refs/heads/main']);
  writeFileSync(join(work, 'feature.txt'), 'feature\n'); const commitOid = commit(work, 'feature'), treeOid = git(work, 'rev-parse', 'HEAD^{tree}');
  const r = rev('change', 'r1', base, commitOid, treeOid); await publishRevision(work, bare, r);
  execFileSync('git', ['clone', '-q', bare, clone]); expect(git(clone, 'rev-parse', 'refs/heads/main')).toBe(base); expect(git(clone, 'cat-file', '-e', `${commitOid}^{commit}`)).toBe('');
  const out = join(root, 'view'); const result = await composeView({ repository: bare, destination: out, baselineOid: base, revisions: [r] });
  expect(result.commitOid).toMatch(/^[0-9a-f]{40}$/); expect(result.treeOid).toBe(treeOid); expect(result.orderedRevisions).toEqual([{ changeId: 'change', revisionId: 'r1' }]);
 });
 it('orders dependency closure, rejects mismatch/cycles, and keeps dirty source copies untouched', async () => {
  const root = scratch(), bare = join(root, 'bare'), work = join(root, 'src'); execFileSync('git', ['init', '--bare', '-q', bare]); init(work); writeFileSync(join(work, 'base'), '0'); const base = commit(work, 'base');
  writeFileSync(join(work, 'one'), '1'); const c1 = commit(work, 'one'), t1 = git(work, 'rev-parse', 'HEAD^{tree}'); const a = rev('a','a1',base,c1,t1);
  writeFileSync(join(work, 'two'), '2'); const c2 = commit(work, 'two'), t2 = git(work, 'rev-parse', 'HEAD^{tree}'); const b = rev('b','b1',c1,c2,t2,[a]); await publishRevision(work,bare,a); await publishRevision(work,bare,b);
  writeFileSync(join(work,'dirty'),'keep'); const dirtyBefore = readFileSync(join(work,'dirty'),'utf8'); const result = await composeView({ repository: bare, destination: join(root,'view'), baselineOid: base, revisions: [b,a] });
  expect(result.orderedRevisions.map(x=>x.changeId)).toEqual(['a','b']); expect(readFileSync(join(work,'dirty'),'utf8')).toBe(dirtyBefore);
  await expect(composeView({ repository: bare, destination: join(root,'bad'), baselineOid: base, revisions: [{...b, baseCommitOid: base},a] })).rejects.toThrow();
  const cycleA = {...a, dependencies:[{changeId:'b',revisionId:'b1'}]}; await expect(composeView({ repository: bare, destination: join(root,'cycle'), baselineOid: base, revisions:[cycleA,b] })).rejects.toThrow(/cycle/i);
 });
 it('reports genuine cherry-pick conflicts and removes partial destination', async () => {
  const root=scratch(), bare=join(root,'bare'), work=join(root,'src'); execFileSync('git',['init','--bare','-q',bare]); init(work); writeFileSync(join(work,'x'),'base\n'); const base=commit(work,'base');
  git(work,'checkout','-qb','side'); writeFileSync(join(work,'x'),'side\n'); const sc=commit(work,'side'), st=git(work,'rev-parse','HEAD^{tree}'); git(work,'checkout','-q','master'); writeFileSync(join(work,'x'),'main\n'); commit(work,'main'); const mc=git(work,'rev-parse','HEAD'), mt=git(work,'rev-parse','HEAD^{tree}');
  const first=rev('main','m',base,mc,mt), second=rev('side','s',base,sc,st); await publishRevision(work,bare,first); await publishRevision(work,bare,second);
  const dest=join(root,'fail'); await expect(composeView({repository:bare,destination:dest,baselineOid:base,revisions:[first,second]})).rejects.toMatchObject({code:'GIT_CONFLICT'});
  expect(()=>readFileSync(join(dest,'.git'))).toThrow(); expect(readFileSync(join(work,'x'),'utf8')).toBe('main\n');
 });
 it('composes two isolated concurrent branches without changing either old copy', async () => {
  const root=scratch(), bare=join(root,'bare'), seed=join(root,'seed'), left=join(root,'left'), right=join(root,'right');
  execFileSync('git',['init','--bare','-q',bare]); init(seed); writeFileSync(join(seed,'base'),'base'); const base=commit(seed,'base'); git(seed,'push','-q',bare,`${base}:refs/heads/base`); execFileSync('git',['--git-dir',bare,'symbolic-ref','HEAD','refs/heads/base']);
  execFileSync('git',['clone','-q',bare,left]); execFileSync('git',['clone','-q',bare,right]);
  for(const p of [left,right]) { git(p,'config','user.name','Test'); git(p,'config','user.email','test@example.invalid'); }
  writeFileSync(join(left,'left.txt'),'left'); const lc=commit(left,'left'); const lt=git(left,'rev-parse','HEAD^{tree}');
  writeFileSync(join(right,'right.txt'),'right'); const rc=commit(right,'right'); const rt=git(right,'rev-parse','HEAD^{tree}');

  const a=rev('left','r1',base,lc,lt), b=rev('right','r1',base,rc,rt); await publishRevision(left,bare,a); await publishRevision(right,bare,b);
  writeFileSync(join(left,'uncommitted'),'preserve-left'); writeFileSync(join(right,'uncommitted'),'preserve-right');
  const result=await composeView({repository:bare,destination:join(root,'combined'),baselineOid:base,revisions:[b,a]});
  expect(result.orderedRevisions.map(x=>x.changeId)).toEqual(['right','left']);
  expect(readFileSync(join(left,'uncommitted'),'utf8')).toBe('preserve-left'); expect(readFileSync(join(right,'uncommitted'),'utf8')).toBe('preserve-right');
  expect(readFileSync(join(root,'combined','left.txt'),'utf8')).toBe('left'); expect(readFileSync(join(root,'combined','right.txt'),'utf8')).toBe('right');
 });
 it('accepts a repair based on the full materialized dependency closure only', async () => {
  const root=scratch(), bare=join(root,'bare'), work=join(root,'src'); execFileSync('git',['init','--bare','-q',bare]); init(work); writeFileSync(join(work,'base'),'base'); const base=commit(work,'base');
  writeFileSync(join(work,'a'),'a'); const ac=commit(work,'a'), at=git(work,'rev-parse','HEAD^{tree}'), a=rev('a','a1',base,ac,at); await publishRevision(work,bare,a);
  git(work,'checkout','-q','--detach',base); writeFileSync(join(work,'b'),'b'); const bc=commit(work,'b'), bt=git(work,'rev-parse','HEAD^{tree}'), b=rev('b','b1',base,bc,bt); await publishRevision(work,bare,b);
  const combined=join(root,'combined'); await composeView({repository:bare,destination:combined,baselineOid:base,revisions:[a,b]});
  writeFileSync(join(combined,'repair'),'fixed'); const rc=commit(combined,'repair'), rt=git(combined,'rev-parse','HEAD^{tree}');
  const repair=rev('repair','r1',git(combined,'rev-parse','HEAD^'),rc,rt,[a,b]); await publishRevision(combined,bare,repair);
  writeFileSync(join(work,'dirty'),'preserve');
  const result=await composeView({repository:bare,destination:join(root,'final'),baselineOid:base,revisions:[repair,a,b]});
  expect(result.orderedRevisions.map(x=>x.changeId)).toEqual(['a','b','repair']);
  for(const f of ['a','b','repair']) expect(readFileSync(join(root,'final',f),'utf8')).toBe(f==='repair'?'fixed':f);
  expect(readFileSync(join(work,'dirty'),'utf8')).toBe('preserve');
  const justA=join(root,'just-a'); execFileSync('git',['clone','-q',bare,justA]); git(justA,'checkout','-q','--detach',ac); git(justA,'config','user.name','Test'); git(justA,'config','user.email','test@example.invalid'); writeFileSync(join(justA,'repair'),'fixed'); const wrongCommit=commit(justA,'wrong repair'), wrongTree=git(justA,'rev-parse','HEAD^{tree}');
  const wrong=rev('wrong','r1',ac,wrongCommit,wrongTree,[a,b]); await publishRevision(justA,bare,wrong);
  await expect(composeView({repository:bare,destination:join(root,'bad-closure'),baselineOid:base,revisions:[a,b,wrong]})).rejects.toMatchObject({code:'BASE_MISMATCH'});
 });
 it('uses create-if-absent publication so a later descendant cannot replace an existing ref', async () => {
  const root=scratch(), bare=join(root,'bare'), work=join(root,'src'); execFileSync('git',['init','--bare','-q',bare]); init(work); writeFileSync(join(work,'base'),'base'); const base=commit(work,'base');
  writeFileSync(join(work,'one'),'1'); const first=commit(work,'one'), t1=git(work,'rev-parse','HEAD^{tree}'); const a=rev('same','r1',base,first,t1);
  writeFileSync(join(work,'two'),'2'); const second=commit(work,'two'), t2=git(work,'rev-parse','HEAD^{tree}'); const b=rev('same','r1',first,second,t2);
  const script=`import {publishRevision} from ${JSON.stringify(new URL('../../packages/git-runner/index.ts', import.meta.url).href)}; const [repository,remote,revision]=JSON.parse(process.argv[1]); await publishRevision(repository,remote,revision);`;
  const outcomes=await Promise.allSettled([a,b].map(revision=>execFileAsync(process.execPath,['--import','tsx','--input-type=module','-e',script,JSON.stringify([work,bare,revision])],{cwd:process.cwd(),timeout:30000})));
  expect(outcomes.filter(x=>x.status==='fulfilled')).toHaveLength(1);
  const winner=git(bare,'rev-parse','refs/agent/revisions/same/r1'); expect([first,second]).toContain(winner);
  const winningRevision=winner===first?a:b; await expect(publishRevision(work,bare,winningRevision)).resolves.toBeUndefined();
  await expect(publishRevision(work,bare,winner===first?b:a)).rejects.toMatchObject({code:'IMMUTABLE_REF'});
 });
 it('does not execute configured ref hooks or filters while publishing or composing', async () => {
  const root=scratch(), bare=join(root,'bare'), work=join(root,'src'), marker=join(root,'executed'); execFileSync('git',['init','--bare','-q',bare]); init(work);
  mkdirSync(join(root,'hooks')); writeFileSync(join(root,'hooks','reference-transaction'),`#!/bin/sh\nprintf hook >> '${marker}'\n`); execFileSync('chmod',['+x',join(root,'hooks','reference-transaction')]); git(bare,'config','core.hooksPath',join(root,'hooks'));
  git(work,'config','uploadpack.packObjectsHook',`sh -c 'printf uploadpack >> "${marker}"'`);
  git(work,'config','filter.evil.smudge',`sh -c 'printf filter >> "${marker}"; cat'`); git(work,'config','filter.evil.clean','cat');
  writeFileSync(join(work,'.gitattributes'),'payload filter=evil\n'); writeFileSync(join(work,'payload'),'safe'); const base=commit(work,'base');
  writeFileSync(join(work,'change'),'x'); const oid=commit(work,'change'), tree=git(work,'rev-parse','HEAD^{tree}'), r=rev('safe','r1',base,oid,tree);
  await expect(publishRevision(work,bare,r)).rejects.toMatchObject({code:'UNSAFE_LOCAL_CONFIG'});
  expect(existsSync(marker)).toBe(false);
 });
 it('rejects dangerous source and target local config before Git actions', async () => {
  const root=scratch(), bare=join(root,'bare'), work=join(root,'src'), marker=join(root,'executed');
  execFileSync('git',['init','--bare','-q',bare]); init(work); writeFileSync(join(work,'base'),'base'); const base=commit(work,'base');
  writeFileSync(join(work,'feature'),'feature'); const oid=commit(work,'feature'), tree=git(work,'rev-parse','HEAD^{tree}'), r=rev('danger','r1',base,oid,tree);
  const hook=join(root,'evil-hook'); writeFileSync(hook,`#!/bin/sh\nprintf ran >> '${marker}'\n`); execFileSync('chmod',['+x',hook]);
  git(work,'config','include.path',join(root,'included.conf')); writeFileSync(join(root,'included.conf'),`[core]\n hooksPath = ${join(root,'hooks')}\n`);
  await expect(publishRevision(work,bare,r)).rejects.toMatchObject({code:'UNSAFE_LOCAL_CONFIG'});
  git(work,'config','--unset','include.path');
  git(bare,'config','uploadpack.packObjectsHook',hook);
  await expect(publishSeed(work,bare,'seed',{commitOid:base,treeOid:git(work,'rev-parse',`${base}^{tree}`)})).rejects.toMatchObject({code:'UNSAFE_LOCAL_CONFIG'});
  git(bare,'config','--unset','uploadpack.packObjectsHook');
  git(work,'config','credential.helper',`!${hook}`);
  await expect(publishRevision(work,bare,r)).rejects.toMatchObject({code:'UNSAFE_LOCAL_CONFIG'});
  git(work,'config','--unset','credential.helper');
  git(work,'config','core.sshCommand',`sh -c 'printf ssh >> "${marker}"'`);
  await expect(publishRevision(work,bare,r)).rejects.toMatchObject({code:'UNSAFE_LOCAL_CONFIG'});
  expect(existsSync(marker)).toBe(false);
 });
 it('checks linked-worktree common config and preserves safe linked-worktree publication', async () => {
  const root=scratch(), bare=join(root,'bare'), main=join(root,'main'), linked=join(root,'linked'), marker=join(root,'ran');
  execFileSync('git',['init','--bare','-q',bare]); init(main); writeFileSync(join(main,'base'),'base'); const base=commit(main,'base');
  git(main,'worktree','add','-q','-b','linked',linked);
  writeFileSync(join(linked,'feature'),'feature'); const oid=commit(linked,'feature'), tree=git(linked,'rev-parse','HEAD^{tree}'), r=rev('linked','r1',base,oid,tree);
  await expect(publishRevision(linked,bare,r)).resolves.toBeUndefined();
  const config=join(main,'.git','config'), before=readFileSync(config,'utf8');
  for (const entry of [`[uploadpack] packObjectsHook = sh -c 'printf ran >> "${marker}"' # comment`, `[filter "evil"] smudge = sh -c 'printf ran >> "${marker}"'`]) {
   writeFileSync(config,`${before}\n${entry}\n`);
   await expect(publishRevision(linked,bare,{...r,revisionId:entry.includes('uploadpack')?'upload':'filter'})).rejects.toMatchObject({code:'UNSAFE_LOCAL_CONFIG'});
   expect(existsSync(marker)).toBe(false);
  }
 });
 it('rejects unsupported worktree-specific Git configuration before publication', async () => {
  const root=scratch(), bare=join(root,'bare'), main=join(root,'main'), linked=join(root,'linked');
  execFileSync('git',['init','--bare','-q',bare]); init(main); writeFileSync(join(main,'base'),'base'); const base=commit(main,'base');
  git(main,'worktree','add','-q','-b','linked',linked); const common=join(main,'.git','config');
  git(main,'config','extensions.worktreeConfig','true');
  git(main,'config','--worktree','credential.helper','evil');
  writeFileSync(join(linked,'feature'),'feature'); const oid=commit(linked,'feature'), tree=git(linked,'rev-parse','HEAD^{tree}'), r=rev('worktree-config','r1',base,oid,tree);
  await expect(publishRevision(linked,bare,r)).rejects.toMatchObject({code:'UNSAFE_LOCAL_CONFIG'});
  expect(readFileSync(common,'utf8').toLowerCase()).toContain('worktreeconfig');
 });
 it('ignores inherited Git config injection variables and still suppresses configured hooks', async () => {
  const root=scratch(), bare=join(root,'bare'), work=join(root,'src'), marker=join(root,'injected'); execFileSync('git',['init','--bare','-q',bare]); init(work);
  const hook=join(root,'injected-hook'); writeFileSync(hook,`#!/bin/sh\nprintf injected >> '${marker}'\n`); execFileSync('chmod',['+x',hook]);
  writeFileSync(join(work,'base'),'base'); const base=commit(work,'base'); writeFileSync(join(work,'feature'),'feature'); const oid=commit(work,'feature'), tree=git(work,'rev-parse','HEAD^{tree}'); const r=rev('injection','r1',base,oid,tree); await publishRevision(work,bare,r);
  const previous={count:process.env.GIT_CONFIG_COUNT,key:process.env.GIT_CONFIG_KEY_0,value:process.env.GIT_CONFIG_VALUE_0,parameters:process.env.GIT_CONFIG_PARAMETERS};
  try {
   process.env.GIT_CONFIG_COUNT='1'; process.env.GIT_CONFIG_KEY_0='core.hooksPath'; process.env.GIT_CONFIG_VALUE_0=join(root,'hooks'); process.env.GIT_CONFIG_PARAMETERS=`'core.hooksPath=${join(root,'hooks')}'`;
   mkdirSync(join(root,'hooks')); writeFileSync(join(root,'hooks','reference-transaction'),`#!/bin/sh\nprintf inherited >> '${marker}'\n`); execFileSync('chmod',['+x',join(root,'hooks','reference-transaction')]);
   await composeView({repository:bare,destination:join(root,'view'),baselineOid:base,revisions:[r]});
  } finally {
   for(const [key,value] of Object.entries({GIT_CONFIG_COUNT:previous.count,GIT_CONFIG_KEY_0:previous.key,GIT_CONFIG_VALUE_0:previous.value,GIT_CONFIG_PARAMETERS:previous.parameters})) { if(value===undefined) delete process.env[key]; else process.env[key]=value; }
  }
  expect(existsSync(marker)).toBe(false);
 });
 it('rejects composition inputs over 100 revisions before inspecting revision objects', async () => {
  const root=scratch(), bare=join(root,'bare'), work=join(root,'src'); execFileSync('git',['init','--bare','-q',bare]); init(work); writeFileSync(join(work,'base'),'base'); const base=commit(work,'base');
  const invalid=Array.from({length:101},(_,i)=>rev(`c${i}`,'r1',base,'0'.repeat(40),'0'.repeat(40)));
  await expect(composeView({repository:bare,destination:join(root,'view'),baselineOid:base,revisions:invalid})).rejects.toMatchObject({code:'REVISION_LIMIT'});
 });
 it('atomically publishes retry-stable View identity and preserves an existing copy', async () => {
  const root=scratch(), bare=join(root,'bare'), work=join(root,'src'); execFileSync('git',['init','--bare','-q',bare]); init(work);
  writeFileSync(join(work,'base'),'base'); const base=commit(work,'base'); writeFileSync(join(work,'feature'),'feature'); const oid=commit(work,'feature'), tree=git(work,'rev-parse','HEAD^{tree}');
  const r=rev('view-change','r1',base,oid,tree); await publishRevision(work,bare,r);
  const request={repository:bare,destination:join(root,'view1'),baselineOid:base,revisions:[r],viewId:'view1'};
  const first=await composeAndPublishView(request); expect(await readSourceReceipt(bare,first.ref)).toEqual(first);
  const identity=git(bare,'rev-parse','refs/agent/view-identities/view1'); expect(git(bare,'cat-file','blob',identity)).toMatch(/^[0-9a-f]{64}$/);
  writeFileSync(join(request.destination,'dirty'),'preserve'); expect(await composeAndPublishView({...request,destination:join(root,'view2')})).toEqual(first);
  expect(await composeAndPublishView(request)).toEqual(first); expect(readFileSync(join(request.destination,'dirty'),'utf8')).toBe('preserve');
  await expect(composeAndPublishView({...request,revisions:[]})).rejects.toMatchObject({code:'VIEW_IDENTITY_MISMATCH'});
 });
 it('concurrent identical View requests converge on one durable result', async () => {
  const root=scratch(), bare=join(root,'bare'), work=join(root,'src'); execFileSync('git',['init','--bare','-q',bare]); init(work);
  writeFileSync(join(work,'base'),'base'); const base=commit(work,'base'); writeFileSync(join(work,'feature'),'feature'); const oid=commit(work,'feature'), tree=git(work,'rev-parse','HEAD^{tree}');
  const r=rev('parallel','r1',base,oid,tree); await publishRevision(work,bare,r); const common={repository:bare,baselineOid:base,revisions:[r],viewId:'parallel'};
  const script=`import {composeAndPublishView} from ${JSON.stringify(new URL('../../packages/git-runner/index.ts', import.meta.url).href)}; const request=JSON.parse(process.argv[1]); console.log(JSON.stringify(await composeAndPublishView(request)));`;
  const results=await Promise.all(Array.from({length:8},(_,i)=>join(root,`parallel-${i}`)).map(async destination=>JSON.parse((await execFileAsync(process.execPath,['--import','tsx','--input-type=module','-e',script,JSON.stringify({...common,destination})],{cwd:process.cwd(),timeout:30000})).stdout.trim())));
  expect(results[0]).toEqual(results[1]); expect(await readSourceReceipt(bare,results[0].ref)).toEqual(results[0]);
  for(const result of results) expect(result).toEqual(results[0]);
 });
 it('rejects an orphan durable View ref without creating a destination', async () => {
  const root=scratch(), bare=join(root,'bare'), work=join(root,'src'), destination=join(root,'orphan-destination'); execFileSync('git',['init','--bare','-q',bare]); init(work);
  writeFileSync(join(work,'base'),'base'); const base=commit(work,'base'); writeFileSync(join(work,'feature'),'feature'); const oid=commit(work,'feature'), tree=git(work,'rev-parse','HEAD^{tree}');
  const r=rev('orphan','r1',base,oid,tree); await publishRevision(work,bare,r); git(bare,'update-ref','refs/agent/views/orphan',base);
  await expect(composeAndPublishView({repository:bare,destination,baselineOid:base,revisions:[r],viewId:'orphan'})).rejects.toMatchObject({code:'VIEW_IDENTITY_MISMATCH'});
  expect(existsSync(destination)).toBe(false); expect(git(bare,'rev-parse','refs/agent/views/orphan')).toBe(base);
 });
 it('keeps a View ID immutable when different inputs publish concurrently', async () => {
  const root=scratch(), bare=join(root,'bare'), work=join(root,'src'); execFileSync('git',['init','--bare','-q',bare]); init(work);
  writeFileSync(join(work,'base'),'base'); const base=commit(work,'base'); writeFileSync(join(work,'first'),'first'); const first=commit(work,'first'), firstTree=git(work,'rev-parse','HEAD^{tree}');
  git(work,'checkout','-q','--detach',base); writeFileSync(join(work,'second'),'second'); const second=commit(work,'second'), secondTree=git(work,'rev-parse','HEAD^{tree}');
  const a=rev('view-a','r1',base,first,firstTree), b=rev('view-b','r1',base,second,secondTree); await publishRevision(work,bare,a); await publishRevision(work,bare,b);
  const script=`import {composeAndPublishView} from ${JSON.stringify(new URL('../../packages/git-runner/index.ts', import.meta.url).href)}; const request=JSON.parse(process.argv[1]); await composeAndPublishView(request);`;
  const outcomes=await Promise.allSettled([[a,'different-a'],[b,'different-b']].map(([revision,destination])=>execFileAsync(process.execPath,['--import','tsx','--input-type=module','-e',script,JSON.stringify({repository:bare,destination:join(root,String(destination)),baselineOid:base,revisions:[revision],viewId:'immutable-race'})],{cwd:process.cwd(),timeout:30000})));
  expect(outcomes.filter(x=>x.status==='fulfilled')).toHaveLength(1); expect(outcomes.filter(x=>x.status==='rejected')).toHaveLength(1);
  const identityOid=git(bare,'rev-parse','refs/agent/view-identities/immutable-race'), identity=git(bare,'cat-file','blob',identityOid);
  expect([a,b].map(revision=>createHash('sha256').update(JSON.stringify({baselineOid:base,revisions:[revision]})).digest('hex'))).toContain(identity);
 });
 it('publishes a seed and verifies its exact receipt by readback', async () => {
  const root=scratch(), bare=join(root,'bare'), work=join(root,'src'); execFileSync('git',['init','--bare','-q',bare]); init(work);
  writeFileSync(join(work,'base'),'base'); const commitOid=commit(work,'base'), treeOid=git(work,'rev-parse','HEAD^{tree}');
  const published=await publishSeed(work,bare,'seed1',{commitOid,treeOid}); expect(await readSourceReceipt(bare,published.ref)).toEqual(published);
 });
 it('rejects blobs larger than 32 MiB before publication', async () => {
  const root=scratch(), bare=join(root,'bare'), work=join(root,'src'); execFileSync('git',['init','--bare','-q',bare]); init(work); writeFileSync(join(work,'base'),'base'); commit(work,'base');
  writeFileSync(join(work,'large.bin'),Buffer.alloc(32*1024*1024+1,1)); const oid=commit(work,'oversized'), tree=git(work,'rev-parse','HEAD^{tree}');
  const r=rev('large','r1',git(work,'rev-parse','HEAD^'),oid,tree);
  await expect(publishRevision(work,bare,r)).rejects.toMatchObject({code:'BLOB_TOO_LARGE'});
  expect(()=>git(bare,'rev-parse','refs/agent/revisions/large/r1')).toThrow();
 });
});
