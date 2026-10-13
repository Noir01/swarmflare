import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { startLocalWorkspace } from '../../apps/local/index';
import { WorkspaceClient } from '../../packages/client/index';

const token = 'setup-recovery-human';
const projectId = 'setup-recovery';
const command = (arg: string, url: string) => new Promise<{code:number|null;stdout:string;stderr:string}>((resolveRun, reject) => {
  const child = spawn(process.execPath, ['--import', 'tsx', resolve('apps/setup/index.ts'), arg], { env: { ...process.env, WORKSPACE_BASE_URL:url, WORKSPACE_PROJECT_ID:projectId, WORKSPACE_TOKEN:token }, stdio:['ignore','pipe','pipe'] });
  let stdout='', stderr='', settled=false;
  const timer=setTimeout(()=>child.kill('SIGKILL'), 12_000);
  child.stdout.setEncoding('utf8').on('data', chunk=>stdout+=chunk); child.stderr.setEncoding('utf8').on('data', chunk=>stderr+=chunk);
  child.once('error', e=>{if(!settled){settled=true;clearTimeout(timer);reject(e);}});
  child.once('close', code=>{clearTimeout(timer);if(!settled){settled=true;resolveRun({code,stdout,stderr});}});
});

for (const boundary of ['proposal','approval','policy','seed'] as const) {
  it(`recovers setup after the committed ${boundary} response is dropped`, async () => {
    const root=await mkdtemp(join(tmpdir(),'setup-recovery-')); await mkdir(join(root,'state'));
    const credentials=JSON.stringify([{id:'human',projectId,role:'human',tokenHash:createHash('sha256').update(token).digest('hex'),expiresAt:Date.now()+300_000},{id:'runner',projectId,role:'runner',tokenHash:createHash('sha256').update('setup-recovery-runner').digest('hex'),expiresAt:Date.now()+300_000}]);
    let app: Awaited<ReturnType<typeof startLocalWorkspace>>|undefined; let proxy:Server|undefined;
    const closeProxy=async()=>{if(proxy?.listening) await new Promise<void>((res,rej)=>proxy!.close(e=>e?rej(e):res()));};
    try {
      app=await startLocalWorkspace({stateDirectory:join(root,'state'),authCredentials:credentials,dashboardSessionKey:'e'.repeat(64),runBudgetMs:60_000});
      const direct=new WorkspaceClient({baseUrl:app.url,projectId,token,deadline:10_000});
      const runner=new WorkspaceClient({baseUrl:app.url,projectId,token:'setup-recovery-runner',deadline:10_000});
      const source=join(root,'source'); await mkdir(source);
      // Valid deterministic OIDs for the queued seed metadata; no source is published by setup.
      const commitOid='a'.repeat(40), treeOid='b'.repeat(40);
      let dropped=0;
      proxy=createServer((incoming,outgoing)=>{
        const target=new URL(incoming.url??'/',app!.url);
        const upstream=httpRequest(target,{method:incoming.method,headers:incoming.headers},response=>{
          const chunks:Buffer[]=[]; response.on('data',chunk=>chunks.push(Buffer.from(chunk)));
          response.on('end',()=>{
            const path=target.pathname;
            const match=boundary==='proposal'?incoming.method==='POST'&&path.endsWith('/contracts/proposals'):
              boundary==='approval'?incoming.method==='POST'&&/\/contracts\/[^/]+\/approve$/.test(path):
              boundary==='policy'?incoming.method==='POST'&&path.endsWith('/policy'):
              incoming.method==='POST'&&path.endsWith('/baseline/initialize');
            if(match && response.statusCode!>=200 && response.statusCode!<300 && dropped===0){dropped++;outgoing.destroy();return;}
            outgoing.writeHead(response.statusCode??502,response.headers); outgoing.end(Buffer.concat(chunks));
          });
        });
        upstream.on('error',e=>{if(!outgoing.destroyed)outgoing.destroy(e);}); incoming.pipe(upstream);
      });
      await new Promise<void>((res,rej)=>{proxy!.once('error',rej);proxy!.listen(0,'127.0.0.1',res);});
      const address=proxy.address(); if(!address||typeof address==='string')throw new Error('proxy failed to bind');
      const arg=JSON.stringify({requestId:'same-setup-id',commitOid,treeOid}); const url=`http://127.0.0.1:${address.port}`;
      const before=await direct.events({limit:100}) as {events:Array<{action:string;resourceId:string}>};
      const failed=await command(arg,url); expect(failed.code).toBe(1); expect(dropped).toBe(1);
      // Retry is identical and mutation request IDs replay the committed boundary.
      const retry=await command(arg,url); expect(retry.code).toBe(0); expect(JSON.parse(retry.stdout)).toMatchObject({contractVersion:1,policyVersion:1,commitOid,treeOid});
      const result=JSON.parse(retry.stdout) as {contractId:string;pendingSeedJobId:string};
      const contract=await runner.contract(1) as {version:number;data:Record<string,unknown>};
      expect(contract.version).toBe(1);
      expect(contract.data).toMatchObject({outcome:'Deliver the approved demo with verifiable API behavior and usable tenant-aware UI navigation.',requiredCheckIds:['mandatory-demo-api','mandatory-demo-ui']});
      expect((await runner.policy())?.data).toMatchObject({contractVersion:1,requireIndependentReview:true,sourceBackend:'local-git'});
      expect((await runner.sourceJob(result.pendingSeedJobId)).data).toMatchObject({status:'queued',input:{kind:'seed',source:{commitOid,treeOid}}});
      expect(await runner.baseline()).toBeNull();
      const after=await direct.events({limit:100}) as {events:Array<{action:string;resourceId:string}>};
      const mutations=after.events.filter(e=>['contract.propose','contract.approve','policy.configure','baseline.initialize'].includes(e.action));
      const prior=before.events.filter(e=>['contract.propose','contract.approve','policy.configure','baseline.initialize'].includes(e.action));
      expect(mutations.length-prior.length).toBe(4);
      for(const action of ['contract.propose','contract.approve','policy.configure','baseline.initialize']) expect(mutations.filter(e=>e.action===action)).toHaveLength(1);
    } finally { await closeProxy().catch(()=>{}); await app?.close(); await rm(root,{recursive:true,force:true}); }
  },70_000);
}

it('rejects a newer current human contract before any setup mutation',async()=>{
  const root=await mkdtemp(join(tmpdir(),'setup-current-contract-'));
  const credentials=JSON.stringify([{id:'human',projectId,role:'human',tokenHash:createHash('sha256').update(token).digest('hex'),expiresAt:Date.now()+300_000}]);
  let app:Awaited<ReturnType<typeof startLocalWorkspace>>|undefined;
  try {
    app=await startLocalWorkspace({stateDirectory:join(root,'state'),authCredentials:credentials,dashboardSessionKey:'f'.repeat(64),runBudgetMs:30_000});
    const client=new WorkspaceClient({baseUrl:app.url,projectId,token,deadline:10_000});
    const input={outcome:'newer human contract',constraints:[],obligations:[{id:'human-work',description:'Human-approved work',acceptanceExamples:[]}],requiredCheckIds:['human-check'],unresolvedQuestions:[]};
    const first=await client.createProposal({requestId:'human-v1',payload:input}) as {id:string}; await client.approveProposal(first.id,{requestId:'human-v1-approve',payload:{}});
    const second=await client.createProposal({requestId:'human-v2',payload:{...input,outcome:'newest human contract'}}) as {id:string}; await client.approveProposal(second.id,{requestId:'human-v2-approve',expectedVersion:1,payload:{}});
    const before=await client.events({limit:100});
    const oid='c'.repeat(40);
    const result=await command(JSON.stringify({requestId:'blocked-setup',commitOid:oid,treeOid:'d'.repeat(40)}),app.url);
    expect(result.code).toBe(1); expect(result.stderr).toContain('incompatible preexisting contract');
    expect(await client.context()).toMatchObject({contract:{version:2,data:{outcome:'newest human contract'}}});
    expect(await client.events({limit:100})).toEqual(before); expect(await client.policy()).toBeNull(); expect(await client.baseline()).toBeNull();
  } finally { await app?.close(); await rm(root,{recursive:true,force:true}); }
},50_000);
