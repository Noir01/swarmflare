import { expect, it } from 'vitest';
import { spawn, execFile as execFileCb, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WorkspaceClient } from '../../packages/client/index.js';

const entry=resolve('demo/live/session.ts');
const execFile=promisify(execFileCb);
async function git(cwd:string,...args:string[]){return (await execFile('git',['-C',cwd,...args])).stdout.trim();}
async function command(root:string,name:string){const {stdout}=await execFile(process.execPath,['--import','tsx',entry,name,root],{cwd:process.cwd(),timeout:60_000});return JSON.parse(stdout);}
async function launch(root:string,seconds='90'):Promise<{child:ChildProcess;ready:Promise<any>}>{
 const child=spawn(process.execPath,['--import','tsx',entry,'start',root,seconds],{cwd:process.cwd(),stdio:['ignore','pipe','pipe']});
 let out='',err='';child.stdout?.setEncoding('utf8');child.stderr?.setEncoding('utf8');child.stderr?.on('data',x=>err+=x);
 const ready=new Promise<any>((resolveReady,reject)=>{const timer=setTimeout(()=>reject(new Error(`session startup timeout: ${err}`)),100_000);child.stdout?.on('data',(chunk:string)=>{out+=chunk;const line=out.split('\n').find(Boolean);if(line){clearTimeout(timer);try{resolveReady(JSON.parse(line));}catch(e){reject(e);}}});child.once('close',code=>{clearTimeout(timer);reject(new Error(`session exited ${code}: ${err}`));});});return {child,ready};
}
async function stop(child:ChildProcess){if(child.exitCode!==null)return;child.kill('SIGTERM');await new Promise<void>((resolveStop,reject)=>{const t=setTimeout(()=>reject(new Error('session did not stop')),15_000);child.once('close',()=>{clearTimeout(t);resolveStop();});});}

it('starts approved local session, preserves baseline on restart, and shuts down cleanly',async()=>{
 const root=await mkdtemp(join(tmpdir(),'continuous11-live-'));let child:ChildProcess|undefined;
 try{
  let session=await launch(root);child=session.child;const first=await session.ready;expect(first.mode).toBe('local-only');
  const manifest=JSON.parse(await readFile(join(root,'manifest.json'),'utf8'));expect(Object.keys(manifest.actors).sort()).toEqual(['adversary','api','reviewer','ui']);
  expect((await stat(root)).mode&0o777).toBe(0o700);expect((await stat(join(root,'private','runner.json'))).mode&0o777).toBe(0o600);
  const actor=JSON.parse(await readFile(join(root,'actors','api.json'),'utf8'));expect(actor.token).not.toBe(JSON.parse(await readFile(join(root,'private','session.json'),'utf8')).tokens.human);
  const runner=JSON.parse(await readFile(join(root,'private','runner.json'),'utf8'));
  const api=new WorkspaceClient({baseUrl:first.url,projectId:runner.projectId,token:runner.token,maxRequests:10,deadline:20_000});
  const baseline=await api.baseline();expect(baseline?.version).toBe(1);expect(baseline?.receipt.backend).toBe('local-git');
  const contributor=JSON.parse(await readFile(join(root,'actors','api.json'),'utf8'));
  const author=new WorkspaceClient({baseUrl:first.url,projectId:contributor.projectId,token:contributor.token,maxRequests:30,deadline:20_000});
  const repo=contributor.repository;await writeFile(join(repo,'live-session-proof.txt'),'parent source\n');await git(repo,'add','.');await git(repo,'commit','-qm','live parent publication');
  const parentCommit=await git(repo,'rev-parse','HEAD'),parentTree=await git(repo,'rev-parse','HEAD^{tree}');
  const change=await author.createChange({requestId:'live-proof-change',payload:{title:'Live compose parent',obligationIds:['legacy-response']}});
  const revision=await author.publishRevision(change.id,{requestId:'live-proof-revision',payload:{baseCommitOid:baseline!.commitOid,commitOid:parentCommit,treeOid:parentTree,obligationIds:['legacy-response'],decisionRevisions:[],dependencies:[]}});
  expect((await command(root,'drain'))?.data?.status).toBe('completed');
  await writeFile(join(repo,'live-session-proof.txt'),'parent source\ndependent repair source\n');await git(repo,'add','.');await git(repo,'commit','-qm','live dependent repair');
  const repairCommit=await git(repo,'rev-parse','HEAD'),repairTree=await git(repo,'rev-parse','HEAD^{tree}');
  const repair=await author.createChange({requestId:'live-repair-change',payload:{title:'Live compose repair',obligationIds:['legacy-response']}});
  const repairRevision=await author.publishRevision(repair.id,{requestId:'live-repair-revision',payload:{baseCommitOid:parentCommit,commitOid:repairCommit,treeOid:repairTree,obligationIds:['legacy-response'],decisionRevisions:[],dependencies:[{changeId:change.id,revisionId:revision.id}]}});
  const drained=await command(root,'drain');expect(drained?.data?.status).toBe('completed');
  const composed=await command(root,'compose');expect(composed.view.data.status).toBe('runnable');expect(composed.view.data.manifest.orderedRevisions).toEqual([{changeId:change.id,revisionId:revision.id},{changeId:repair.id,revisionId:repairRevision.id}]);expect(composed.result.data.status).toBe('completed');expect(composed.result.data.receipt.backend).toBe('local-git');
  expect(await git(repo,'--git-dir',join(root,'remote.git'),'show',`${composed.result.data.receipt.commitOid}:live-session-proof.txt`)).toBe('parent source\ndependent repair source');
  await stop(child);
  session=await launch(root);child=session.child;const second=await session.ready;expect(second.url).not.toBe(first.url);
  const fresh=JSON.parse(await readFile(join(root,'private','runner.json'),'utf8'));expect(fresh.baseUrl).toBe(second.url);
  const readback=new WorkspaceClient({baseUrl:second.url,projectId:fresh.projectId,token:fresh.token,maxRequests:10,deadline:20_000});expect(await readback.baseline()).toEqual(baseline);
  await stop(child);child=undefined;
 }finally{if(child)await stop(child).catch(()=>{});await rm(root,{recursive:true,force:true});}
},180_000);
