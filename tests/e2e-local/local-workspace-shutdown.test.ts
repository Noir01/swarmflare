import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startLocalWorkspace } from '../../apps/local/index';

it('closes on its run budget, resolves closed, refuses connections, and tolerates duplicate close',async()=>{
 const stateDirectory=await mkdtemp(join(tmpdir(),'workspace-shutdown-'));
 const token='synthetic-expiring-soon',authCredentials=JSON.stringify([{id:'human',role:'human',projectId:'shutdown-test',tokenHash:createHash('sha256').update(token).digest('hex'),expiresAt:Date.now()+60_000}]);
 // The budget includes esbuild/workerd startup; leave room for concurrent tests.
 const runBudgetMs=5000,started=Date.now();let app:Awaited<ReturnType<typeof startLocalWorkspace>>|undefined;
 try{
  app=await startLocalWorkspace({stateDirectory,authCredentials,dashboardSessionKey:'b'.repeat(64),runBudgetMs});
  await app.closed;await app.close();
  expect(Date.now()-started).toBeGreaterThanOrEqual(runBudgetMs);
  expect(Date.now()-started).toBeLessThan(runBudgetMs+3000);
  await expect(fetch(app.url,{signal:AbortSignal.timeout(1000)})).rejects.toThrow();
 }finally{await app?.close();await rm(stateDirectory,{recursive:true,force:true});}
});

it('rejects duplicate and unknown CLI flags without starting a workspace',async()=>{
 const entry=resolve('apps/local/index.ts');
 for(const args of [['--state','/tmp/x','--state','/tmp/y'],['--state','/tmp/x','--port','0','--run-seconds','10','--bogus','x']]){
  const result=await new Promise<{code:number|null;stderr:string}>((resolveResult,reject)=>{const child=spawn(process.execPath,['--import','tsx',entry,...args],{env:{...process.env,AUTH_CREDENTIALS:'[]',DASHBOARD_SESSION_KEY:'d'.repeat(64)},stdio:['ignore','ignore','pipe']});let stderr='';child.stderr.setEncoding('utf8').on('data',chunk=>stderr+=chunk);child.once('error',reject);child.once('close',code=>resolveResult({code,stderr}));});
  expect(result.code).toBe(2);expect(result.stderr).toContain('Invalid local workspace arguments');
 }
});

it('shuts down the spawned CLI and all captured descendants on SIGTERM',async()=>{
 const stateDirectory=await mkdtemp(join(tmpdir(),'workspace-cli-shutdown-'));
 const token='synthetic-cli-token',authCredentials=JSON.stringify([{id:'human',role:'human',projectId:'cli-shutdown',tokenHash:createHash('sha256').update(token).digest('hex'),expiresAt:Date.now()+120_000}]);
 const child=spawn(process.execPath,['--import','tsx',resolve('apps/local/index.ts'),'--state',stateDirectory,'--port','0','--run-seconds','120'],{env:{...process.env,AUTH_CREDENTIALS:authCredentials,DASHBOARD_SESSION_KEY:'e'.repeat(64)},stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';child.stdout.setEncoding('utf8').on('data',chunk=>stdout+=chunk);child.stderr.setEncoding('utf8').on('data',chunk=>stderr+=chunk);
 const deadline=Date.now()+30_000;let ready:{url:string;mode:string}|undefined;const captured=new Set<number>();const ownCgroup=(await readFile(`/proc/${process.pid}/cgroup`,'utf8')).trim();
 const descendants=async()=>{const parents=new Map<number,number>();for(const entry of await readdir('/proc')){if(!/^\d+$/.test(entry))continue;try{const stat=await readFile(`/proc/${entry}/stat`,'utf8');parents.set(Number(entry),Number(stat.slice(stat.lastIndexOf(')')+2).split(' ')[1]));}catch{}}
  const found=new Set<number>([child.pid!]);let changed=true;while(changed){changed=false;for(const [pid,ppid] of parents)if(found.has(ppid)&&!found.has(pid)){found.add(pid);changed=true;}}return [...found].filter(pid=>pid!==child.pid);};
 try{
  while(Date.now()<deadline&&!ready){for(const line of stdout.split('\n')){if(!line.trim())continue;try{const value=JSON.parse(line);if(typeof value.url==='string'&&value.mode==='local-only')ready=value;}catch{}}
   if(child.exitCode!==null)throw new Error(`CLI exited before readiness (${child.exitCode}): ${stderr}`);await delay(50);
  }
  expect(ready).toBeTruthy();const url=new URL(ready!.url);expect(url.hostname).toBe('127.0.0.1');expect(url.port).toMatch(/^\d+$/);
  for(const pid of await descendants()){captured.add(pid);expect((await readFile(`/proc/${pid}/cgroup`,'utf8')).trim()).toBe(ownCgroup);}
  expect(captured.size).toBeGreaterThan(0);child.kill('SIGTERM');
  const code=await Promise.race([new Promise<number|null>(done=>child.once('close',done)),delay(Math.max(1,deadline-Date.now())).then(()=>{throw new Error('CLI did not exit before 30-second deadline');})]);
  expect([0,143]).toContain(code);await expect(fetch(url,{signal:AbortSignal.timeout(1000)})).rejects.toThrow();
  for(const pid of captured)await expect(readFile(`/proc/${pid}/stat`,'utf8')).rejects.toThrow();
 }finally{if(child.exitCode===null){child.kill('SIGKILL');await new Promise<void>(resolveClose=>child.once('close',()=>resolveClose()));}await rm(stateDirectory,{recursive:true,force:true});}
},35_000);
