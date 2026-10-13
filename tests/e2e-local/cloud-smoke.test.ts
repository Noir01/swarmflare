import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseConfig, runPhase, validateReceiptPair } from '../../demo/cloud/smoke.js';

let root:string|undefined; const originalFetch=globalThis.fetch;
afterEach(async()=>{globalThis.fetch=originalFetch;vi.restoreAllMocks();if(root){await rm(root,{recursive:true,force:true});root=undefined;}});
function config(receiptPath:string){return parseConfig(JSON.stringify({baseUrl:'https://git-collaboration-demo-c29.sriva140.workers.dev',projectId:'demo-project',runnerToken:'runner-secret-test',contributorToken:'contributor-secret-test',seedRepository:'/tmp/seed',revisionRepository:'/tmp/revision',remote:'/tmp/cache.git',workspaceRoot:'/tmp/work',receiptPath,approvedOrigin:'https://git-collaboration-demo-c29.sriva140.workers.dev'}));}
it('validates exact configuration and the approved endpoint before constructing clients',()=>{
 const c=config('/tmp/receipt.json');expect(c.projectId).toBe('demo-project');expect(c.baseUrl).toBe(c.approvedOrigin);
 expect(()=>parseConfig(JSON.stringify({...c,approvedOrigin:'https://other.sriva140.workers.dev'}))).toThrow(/exactly match/);
 expect(()=>parseConfig(JSON.stringify({...c,extra:'ignored'}))).toThrow(/exactly/);
 expect(()=>parseConfig(JSON.stringify({...c,runnerToken:''}))).toThrow(/runnerToken/);
});
it('runs bootstrap phase with a single exact runner-only request and persists sanitized IDs',async()=>{
 root=await mkdtemp(join(tmpdir(),'cloud-smoke-'));const path=join(root,'receipt.json');let captured:Request|undefined;
 globalThis.fetch=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{captured=new Request(input,init);return Response.json({apiVersion:1,resource:{status:'pending-seed-publication',seedJob:{id:'job_1',data:{status:'queued',input:{kind:'seed',seedId:'seed_1',source:{commitOid:'a'.repeat(40),treeOid:'b'.repeat(40)}}}}}});}) as typeof fetch;
 await runPhase('bootstrap',config(path));expect(captured?.url).toBe('https://git-collaboration-demo-c29.sriva140.workers.dev/api/v1/projects/demo-project/demo/bootstrap');expect(captured?.method).toBe('POST');expect(captured?.redirect).toBe('error');expect(captured?.headers.get('authorization')).toBe('Bearer runner-secret-test');expect(await captured?.text()).toBe(JSON.stringify({requestId:'cloud-bootstrap',payload:{}}));
 const saved=JSON.parse(await readFile(path,'utf8'));expect(saved).toEqual({projectId:'demo-project',seed:{jobId:'job_1',seedId:'seed_1',commitOid:'a'.repeat(40),treeOid:'b'.repeat(40),ref:'refs/agent/seeds/seed_1'}});expect(JSON.stringify(saved)).not.toContain('secret');
});
it('rejects unsupported phase without sending a request',async()=>{const c=config('/tmp/no-receipt');await expect(runPhase('bogus' as never,c)).rejects.toThrow(/phase must be/);});
it('keeps remote source and local-cache receipt identities distinct while requiring the exact same tuple',()=>{
 const tuple={ref:'refs/agent/seeds/seed_1',commitOid:'a'.repeat(40),treeOid:'b'.repeat(40)};
 const remoteSourceReceipt={backend:'artifacts-git',...tuple},localCacheReceipt={backend:'local-git',...tuple};
 expect(()=>validateReceiptPair(remoteSourceReceipt,localCacheReceipt)).not.toThrow();
 expect(remoteSourceReceipt.backend).toBe('artifacts-git');expect(localCacheReceipt.backend).toBe('local-git');
 expect(()=>validateReceiptPair(remoteSourceReceipt,{...localCacheReceipt,treeOid:'c'.repeat(40)})).toThrow(/exact source tuple/);
 expect(()=>validateReceiptPair({...remoteSourceReceipt,backend:'local-git'},localCacheReceipt)).toThrow(/exact source tuple/);
});
