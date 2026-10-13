import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceClient } from '../../packages/client';
import { startLocalWorkspace } from '../../apps/local/index';

let close: (()=>Promise<void>)|undefined, scratch: string|undefined;
afterEach(async()=>{await close?.();close=undefined;if(scratch)await rm(scratch,{recursive:true,force:true});scratch=undefined;});

it('creates/approves, persists exact contract and events across restart, and rejects runner approval',async()=>{
 scratch=await mkdtemp(join(tmpdir(),'workspace-local-'));
 const human='synthetic-human',runner='synthetic-runner',projectId='local-test';
 const authCredentials=JSON.stringify(['human','runner'].map(role=>({id:role,role,projectId,tokenHash:createHash('sha256').update(role==='human'?human:runner).digest('hex'),expiresAt:Date.now()+300_000})));
 const options={stateDirectory:join(scratch,'state'),authCredentials,dashboardSessionKey:'a'.repeat(64),runBudgetMs:20_000};
 let app=await startLocalWorkspace(options);close=app.close;
 const client=(token:string)=>new WorkspaceClient({baseUrl:app.url,projectId,token,maxRequests:30,deadline:5000});
 const owner=client(human),agent=client(runner);
 const proposal=await owner.createProposal({requestId:'proposal',payload:{outcome:'Local test',constraints:[],obligations:[{id:'test-obligation',description:'Test',acceptanceExamples:[]}],requiredCheckIds:['local-check'],unresolvedQuestions:[]}}) as {id:string};
 await owner.approveProposal(proposal.id,{requestId:'approve',expectedVersion:0,payload:{}});
 const contract=await owner.contract(1),events=await owner.events();
 await expect(agent.approveProposal(proposal.id,{requestId:'forbidden',expectedVersion:1,payload:{}})).rejects.toThrow();
 await app.close();await app.closed;await app.close();close=undefined;
 app=await startLocalWorkspace(options);close=app.close;
 const restarted=client(human);
 expect(await restarted.contract(1)).toEqual(contract);
 expect(await restarted.events()).toEqual(events);
 await app.close();await app.closed;close=undefined;
},60_000);

it('rejects invalid budgets, malformed or expired credentials, and weak keys individually before persistence',async()=>{
 const stateDirectory=join(await mkdtemp(join(tmpdir(),'workspace-invalid-')),'state');
 const validCredential=JSON.stringify([{id:'human',role:'human',projectId:'test',tokenHash:'a'.repeat(64),expiresAt:Date.now()+60_000}]);
 const base={stateDirectory,authCredentials:validCredential,dashboardSessionKey:'a'.repeat(64),runBudgetMs:1000};
 await expect(startLocalWorkspace({...base,runBudgetMs:0})).rejects.toThrow();
 await expect(startLocalWorkspace({...base,authCredentials:'not-json'})).rejects.toThrow();
 await expect(startLocalWorkspace({...base,authCredentials:JSON.stringify([{id:'human',role:'human',projectId:'test',tokenHash:'a'.repeat(64),expiresAt:Date.now()-1}])})).rejects.toThrow();
 await expect(startLocalWorkspace({...base,dashboardSessionKey:'a'.repeat(63)})).rejects.toThrow();
 await expect(import('node:fs/promises').then(fs=>fs.stat(stateDirectory))).rejects.toThrow();
});
