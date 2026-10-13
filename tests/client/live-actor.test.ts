import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';

import { childBudgetMs, invoke, validateConfig } from '../../demo/live/actor';


const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
async function setup(baseUrl:string, role='api', token='role-secret') {
 const root=await mkdtemp(join(tmpdir(),'live-actor-'));roots.push(root);await mkdir(join(root,'actors'));
 await writeFile(join(root,'actors',`${role}.json`),JSON.stringify({baseUrl,projectId:'project_1',token,actorId:role,repository:'/checkout'}));return root;
}

it('forwards context and ordinary mutation as the role config token',async()=>{
 const seen:Array<{method:string;url:string;authorization:string|undefined;body:string}>=[];
 const server=createServer(async(req,res)=>{let body='';for await(const part of req)body+=part;seen.push({method:req.method!,url:req.url!,authorization:req.headers.authorization,body});res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({apiVersion:1,sequence:1,version:1,resource:req.url?.endsWith('/context')?{contract:null,baseline:null,claims:[],decisions:[],findings:[],nextCursor:null}:{id:'claim-1',version:1,data:{}}}));});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 try {const address=server.address();if(!address||typeof address==='string')throw Error('bind failed');const root=await setup(`http://127.0.0.1:${address.port}`);
  const context=await invoke(root,'api','context');expect(context.code,context.stderr).toBe(0);expect(JSON.parse(context.stdout)).toMatchObject({contract:null});
  const payload={requestId:'claim1',payload:{obligationIds:['api-obligation'],areas:['API files']}};const mutation=await invoke(root,'api','claim',JSON.stringify(payload));expect(mutation.code,mutation.stderr).toBe(0);
  expect(seen.map(x=>x.url)).toEqual(['/api/v1/projects/project_1/context','/api/v1/projects/project_1/claims']);expect(seen[1]!.method).toBe('POST');expect(seen[1]!.authorization).toBe('Bearer role-secret');expect(JSON.parse(seen[1]!.body)).toMatchObject(payload);
  expect(context.stdout+mutation.stdout).not.toContain('role-secret');
 } finally {await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));}
});

it('rejects forbidden roles, human/runner mutations, malformed config and nonloopback before networking',async()=>{
 const root=await setup('http://127.0.0.1:1');
 await expect(invoke(root,'human','context')).rejects.toThrow(/role/);
 await expect(invoke(root,'runner','context')).rejects.toThrow(/role/);
 await expect(invoke(root,'api','approve-proposal','{}')).rejects.toThrow(/human-only/);
 await expect(invoke(root,'api','source-job-claim')).rejects.toThrow(/available/);
 await expect(invoke(root,'api','mutate',JSON.stringify({method:'GET',path:'/context'}))).rejects.toThrow(/available/);
 await expect(invoke(root,'api','resolve-decision','{}')).rejects.toThrow(/human-only/);
 await writeFile(join(root,'actors','api.json'),JSON.stringify({baseUrl:'https://example.com',projectId:'project_1',token:'secret',actorId:'api',repository:'/checkout'}));
 await expect(invoke(root,'api','context')).rejects.toThrow(/loopback/);
 await writeFile(join(root,'actors','api.json'),JSON.stringify({baseUrl:'http://127.0.0.1',projectId:'bad/id',token:'secret',actorId:'api',repository:'/checkout'}));
 await expect(invoke(root,'api','context')).rejects.toThrow(/valid IDs/);
});

it('enforces the bounded child deadline and sanitizes child errors',async()=>{
 expect(childBudgetMs).toBeLessThanOrEqual(60_000);
 const server=createServer((_req,res)=>{res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({apiVersion:1,error:{code:'BAD_REQUEST',message:'invalid input very-secret-token'}}));});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 try {const address=server.address();if(!address||typeof address==='string')throw Error('bind failed');const root=await setup(`http://127.0.0.1:${address.port}`,'api','very-secret-token');
  const result=await invoke(root,'api','context');expect(result.code).not.toBe(0);expect(result.stderr).not.toContain('very-secret-token');expect(result.stderr).not.toContain('WORKSPACE_TOKEN');expect(result.stderr).toContain('HTTP 400');
 } finally {await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));}
},20_000);

it('shows executable role help shapes without advertising decision reads',async()=>{
 const result=await invoke('/missing','reviewer','--help');expect(result.code).toBe(0);expect(result.stdout).toContain('revision-publish {"id":"...","mutation"');expect(result.stdout).toContain('context (includes decisions)');expect(result.stdout).toContain('decision {"requestId":"...","payload"');expect(result.stdout).not.toMatch(/Read:[^\n]*decision \{"id"/);expect(result.stdout).toContain('"revisions":[{"changeId":"...","revisionId":"..."}]');expect(result.stdout).toContain('"changeId":"...","revisionId":"..."');expect(result.stdout).toContain('payload":{"viewId":"...","note":"..."}');expect(result.stdout).toContain('manifestDigest');expect(result.stdout).toContain('composedCommitOid');expect(result.stdout).not.toMatch(/\b(mutate|approve-proposal|source-job-claim|confirm-view)\b/);
 await expect(invoke('/missing','invalid','--help')).rejects.toThrow(/role/);
});

it('forwards exact JSON from a file and rejects unsafe inputs',async()=>{
 const seen:string[]=[];const server=createServer(async(req,res)=>{let body='';for await(const part of req)body+=part;seen.push(body);res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({apiVersion:1,error:{code:'EXPECTED_TEST_RESPONSE',message:'request captured'}}));});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 try {const address=server.address();if(!address||typeof address==='string')throw Error('bind failed');const root=await setup(`http://127.0.0.1:${address.port}`);const work=await mkdtemp(join(tmpdir(),'actor-input-'));roots.push(work);
 const payload={id:'change_1',mutation:{requestId:'stable-1',expectedVersion:4,payload:{baseCommitOid:'a'.repeat(40),commitOid:'b'.repeat(40),treeOid:'c'.repeat(40),obligationIds:['api-obligation'],decisionRevisions:[],dependencies:[]}}};await writeFile(join(work,'payload.json'),JSON.stringify(payload));const result=await invoke(root,'api','revision-publish',`@${join(work,'payload.json')}`);expect(result.code).not.toBe(0);expect(JSON.parse(seen[0]!)).toEqual(payload.mutation);
 await writeFile(join(work,'bad.json'),'{');await expect(invoke(root,'api','revision-publish',`@${join(work,'bad.json')}`)).rejects.toThrow(/JSON input/);
 await writeFile(join(work,'large.json'),' '.repeat(65537));await expect(invoke(root,'api','revision-publish',`@${join(work,'large.json')}`)).rejects.toThrow(/64 KiB/);
 await writeFile(join(work,'trailing.json'),'{} invalid');await expect(invoke(root,'api','revision-publish',`@${join(work,'trailing.json')}`)).rejects.toThrow(/JSON input/);
 await mkdir(join(work,'directory'));await expect(invoke(root,'api','revision-publish',`@${join(work,'directory')}`)).rejects.toThrow(/regular file/);
 await symlink('payload.json',join(work,'link.json'));await expect(invoke(root,'api','revision-publish',`@${join(work,'link.json')}`)).rejects.toThrow(/regular file/);
 await expect(invoke(root,'api','mutate','@missing')).rejects.toThrow(/available/);
 } finally {await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));}
});

it('waits for timed-out child close and sanitizes token echoes in stdout',async()=>{
 const server=createServer(()=>{});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 try {const address=server.address();if(!address||typeof address==='string')throw Error('bind failed');const root=await setup(`http://127.0.0.1:${address.port}`,'api','timeout-secret');
  const result=await invoke(root,'api','context',undefined,100);
  expect(result.code).toBe(124);expect(result.stdout).not.toContain('timeout-secret');
 } finally {await new Promise<void>(r=>server.close(()=>r()));}
});

it('opts into one exact approved Workers origin while retaining loopback defaults',async()=>{
 const local={baseUrl:'http://127.0.0.1:8787',projectId:'project_1',token:'secret',actorId:'api',repository:'/checkout'};
 expect(validateConfig(local).baseUrl).toBe(local.baseUrl);
 const origin='https://worker.account.workers.dev';
 expect(validateConfig({...local,baseUrl:origin,approvedOrigin:origin})).toMatchObject({baseUrl:origin,approvedOrigin:origin});
 expect(()=>validateConfig({...local,baseUrl:origin})).toThrow();
 expect(()=>validateConfig({...local,baseUrl:'https://other.account.workers.dev',approvedOrigin:origin})).toThrow();
 expect(()=>validateConfig({...local,baseUrl:'https://worker.account.workers.dev/path',approvedOrigin:origin})).toThrow();
 expect(()=>validateConfig({...local,approvedOrigin:'https://worker.account.workers.dev/path'})).toThrow();
 expect(()=>validateConfig({...local,approvedOrigin:origin,unexpected:true})).toThrow(/unexpected or missing/);
});
