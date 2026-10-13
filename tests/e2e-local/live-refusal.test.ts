import { afterEach, expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceClient } from '../../packages/client/index.js';
import { runSourceJob } from '../../packages/local-runner/index.js';
import { runRefusalProbe } from '../../demo/live/refusal.js';

let runtime:Miniflare|undefined;let scratch:string|undefined;
afterEach(async()=>{await runtime?.dispose();runtime=undefined;if(scratch)await rm(scratch,{recursive:true,force:true});scratch=undefined;});

it('gets server-side FORBIDDEN on exact schema-valid contributor confirmation and acceptance attempts without mutation',async()=>{
 scratch=await mkdtemp(join(tmpdir(),'live-refusal-'));const root=join(scratch,'session');await mkdir(join(root,'actors'),{recursive:true});
 const projectId='live-refusal-test',tokens={human:'synthetic-refusal-human',contributor:'synthetic-refusal-contributor',runner:'synthetic-refusal-runner'};
 const credentials=Object.entries(tokens).map(([role,token])=>({id:role,role,projectId,tokenHash:createHash('sha256').update(token).digest('hex'),expiresAt:Date.now()+300_000}));
 const bundle=await build({entryPoints:['apps/worker/src/index.ts'],bundle:true,platform:'browser',format:'esm',write:false,external:['cloudflare:workers']});
 runtime=new Miniflare(convertV4MiniflareOptions({name:projectId,modules:true,script:bundle.outputFiles[0]!.text,compatibilityDate:'2026-08-01',durableObjects:{PROJECTS:{className:'Project',useSQLite:true}},bindings:{AUTH_CREDENTIALS:JSON.stringify(credentials)},host:'127.0.0.1',port:0}));
 const baseUrl=(await runtime.ready).toString();const human=new WorkspaceClient({baseUrl,projectId,token:tokens.human,maxRequests:50,deadline:30_000});const contributor=new WorkspaceClient({baseUrl,projectId,token:tokens.contributor,maxRequests:50,deadline:30_000});const runner=new WorkspaceClient({baseUrl,projectId,token:tokens.runner,maxRequests:50,deadline:30_000});
 const proposal=await human.createProposal({requestId:'refusal-proposal',payload:{outcome:'Unauthorized refusal probe fixture',constraints:[],obligations:[{id:'refusal-obligation',description:'Fixture obligation',acceptanceExamples:[]}],requiredCheckIds:['refusal-check'],unresolvedQuestions:[]}}) as {id:string};
 await human.approveProposal(proposal.id,{requestId:'refusal-approve',payload:{}});
 await human.configurePolicy({requestId:'refusal-policy',expectedVersion:0,payload:{contractVersion:1,checkSuiteDigest:'0'.repeat(64),harnessVersion:'json-oracle-v1',checks:[{id:'refusal-check',obligationIds:['refusal-obligation']}],requireIndependentReview:true,sourceBackend:'local-git'}});
 const git=await import('node:child_process');const source=join(scratch,'source');await mkdir(source);git.execFileSync('git',['init','-q',source]);git.execFileSync('git',['-C',source,'config','user.name','Fixture']);git.execFileSync('git',['-C',source,'config','user.email','fixture@example.invalid']);await writeFile(join(source,'base.txt'),'fixture\n');git.execFileSync('git',['-C',source,'add','.']);git.execFileSync('git',['-C',source,'commit','-qm','fixture']);
 const gitAt=(...args:string[])=>git.execFileSync('git',['-C',source,...args],{encoding:'utf8'}).trim();
 const commitOid=gitAt('rev-parse','HEAD'),treeOid=gitAt('rev-parse','HEAD^{tree}');
 await human.initializeBaseline({requestId:'refusal-baseline',expectedVersion:0,payload:{commitOid,treeOid}});
 const remote=join(scratch,'remote.git');git.execFileSync('git',['init','--bare','-q',remote]);await runSourceJob(runner,{remote,workspaceRoot:join(scratch,'work'),resolveRepository:()=>source,requestId:'refusal-seed'});
 const change=await contributor.createChange({requestId:'refusal-change',payload:{title:'Refusal fixture',obligationIds:['refusal-obligation']}});
 await writeFile(join(source,'child.txt'),'real child commit\n');gitAt('add','.');gitAt('commit','-qm','real child revision');
 const revisionCommitOid=gitAt('rev-parse','HEAD'),revisionTreeOid=gitAt('rev-parse','HEAD^{tree}');
 expect(gitAt('rev-parse','HEAD^')).toBe(commitOid);expect(revisionCommitOid).not.toBe(commitOid);expect(revisionTreeOid).not.toBe(treeOid);
 const revision=await contributor.publishRevision(change.id,{requestId:'refusal-revision',payload:{baseCommitOid:commitOid,commitOid:revisionCommitOid,treeOid:revisionTreeOid,obligationIds:['refusal-obligation'],decisionRevisions:[],dependencies:[]}});
 const published=await runSourceJob(runner,{remote,workspaceRoot:join(scratch,'work'),resolveRepository:()=>source,requestId:'refusal-publish'});expect(published?.data.status).toBe('completed');
 const view=await contributor.createView({requestId:'refusal-view',expectedVersion:0,payload:{baseVersion:1,baseCommitOid:commitOid,contractVersion:1,policyVersion:1,orderedRevisions:[{changeId:change.id,revisionId:revision.id}],excludedChangeIds:[],decisionRevisions:[],compositionVersion:1}});
 await runSourceJob(runner,{remote,workspaceRoot:join(scratch,'work'),resolveRepository:()=>remote,requestId:'refusal-compose'});
 await writeFile(join(root,'actors','api.json'),JSON.stringify({baseUrl,projectId,token:tokens.contributor,actorId:'contributor',repository:source}));
 const output=join(root,'refusal.json');const result=await runRefusalProbe(root,view.id,output);
 expect(result.attempts).toEqual({confirm:{status:403,code:'FORBIDDEN'},accept:{status:403,code:'FORBIDDEN'}});
 expect(result.acceptanceEventDeltaCount).toBe(0);
 expect(result.verified).toEqual({bothServerForbidden:true,baselineUnchanged:true,viewUnchanged:true,noAcceptanceEvents:true});
 expect((await readFile(output,'utf8'))).not.toContain(tokens.contributor);
 expect(result.authorization).toContain('NOT authorized human refusal or acceptance');
},60_000);

it('detects an acceptance event by its monotonic sequence cursor',()=>{
 const before=[{sequence:10,action:'view.updated'}],after=[...before,{sequence:11,action:'acceptance.created'}];
 const delta=after.filter(event=>event.sequence>before.at(-1)!.sequence);
 expect(delta.map(event=>event.action)).toEqual(['acceptance.created']);
});
