import { afterEach, expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceClient } from '../../packages/client';
import { runSourceJob } from '../../packages/local-runner';
import { runViewDemoSuite } from '../../packages/local-runner/checks';
import { demoSuiteDigest } from '../../packages/git-runner/checks/demo-suite';
import { readSourceReceipt } from '../../packages/git-runner';

let runtime:Miniflare|undefined, scratch:string|undefined;
afterEach(async()=>{await runtime?.dispose();runtime=undefined;if(scratch)await rm(scratch,{recursive:true,force:true});scratch=undefined;});

// Real local HTTP, Git and sandbox test, NOT a concurrent-agent or browser demo.
it('persists actual seed API failure and fixed fixture success on distinct pinned Git Views',async()=>{
 scratch=await mkdtemp(join(tmpdir(),'demo-api-lifecycle-'));
 const source=join(scratch,'source'),remote=join(scratch,'remote.git'),workspaceRoot=join(scratch,'work');
 await mkdir(source);execFileSync('git',['init','-q',source]);execFileSync('git',['init','--bare','-q',remote]);
 const git=(...args:string[])=>execFileSync('git',['-C',source,...args],{encoding:'utf8'}).trim();
 git('config','user.name','Synthetic Demo Oracle Test');git('config','user.email','local@example.invalid');
 await writeFile(join(source,'baseline.txt'),'local fixture\n');git('add','.');git('commit','-qm','seed baseline');
 const baseCommitOid=git('rev-parse','HEAD'),baseTreeOid=git('rev-parse','HEAD^{tree}');
 const bundle=await build({entryPoints:['apps/worker/src/index.ts'],bundle:true,platform:'browser',format:'esm',write:false,external:['cloudflare:workers']});
 const roles=['human','contributor','runner'] as const;
 const credentials=roles.map(role=>({id:role,role,projectId:'demo-api-lifecycle',tokenHash:createHash('sha256').update(`synthetic-${role}`).digest('hex'),expiresAt:Date.now()+300_000}));
 runtime=new Miniflare(convertV4MiniflareOptions({name:'demo-api-test',modules:true,script:bundle.outputFiles[0]!.text,compatibilityDate:'2026-08-01',durableObjects:{PROJECTS:{className:'Project',useSQLite:true}},bindings:{AUTH_CREDENTIALS:JSON.stringify(credentials)},host:'127.0.0.1',port:0}));
 const baseUrl=(await runtime.ready).toString();
 const client=(role:string)=>new WorkspaceClient({baseUrl,projectId:'demo-api-lifecycle',token:`synthetic-${role}`,maxRequests:150,deadline:60_000});
 const human=client('human'),author=client('contributor'),runner=client('runner');
 const obligationIds=['legacy-response','pagination-order','cursor-validation','tenant-isolation'];
 const proposal=await human.createProposal({requestId:'proposal',payload:{outcome:'Evaluate pinned demo API behavior',constraints:[],obligations:obligationIds.map(id=>({id,description:id,acceptanceExamples:[]})),requiredCheckIds:['mandatory-demo-api'],unresolvedQuestions:[]}}) as {id:string};
 await human.approveProposal(proposal.id,{requestId:'approve',expectedVersion:0,payload:{}});
 await human.configurePolicy({requestId:'policy',expectedVersion:0,payload:{contractVersion:1,checkSuiteDigest:demoSuiteDigest(),harnessVersion:'json-oracle-v1',checks:[{id:'mandatory-demo-api',obligationIds}],requireIndependentReview:true,sourceBackend:'local-git'}});
 await human.initializeBaseline({requestId:'initialize',expectedVersion:0,payload:{commitOid:baseCommitOid,treeOid:baseTreeOid}});
 await runSourceJob(runner,{remote,workspaceRoot,resolveRepository:()=>source,requestId:'seed-job'});
 const baseline=await human.baseline();
 const change=await author.createChange({requestId:'change',payload:{title:'Demo API fixture',obligationIds}});
 const seed=await readFile('demo/seed/index.ts','utf8');
 await mkdir(join(source,'demo/seed'),{recursive:true});await writeFile(join(source,'demo/seed/index.ts'),seed);git('add','.');git('commit','-qm','original approved demo source');
 const publish=async(name:string)=>{
   const revision=await author.publishRevision(change.id,{requestId:`revision-${name}`,payload:{baseCommitOid,commitOid:git('rev-parse','HEAD'),treeOid:git('rev-parse','HEAD^{tree}'),obligationIds,decisionRevisions:[],dependencies:[]}});
   await runSourceJob(runner,{remote,workspaceRoot,resolveRepository:()=>source,requestId:`publish-${name}`});
   const view=await author.createView({requestId:`view-${name}`,payload:{baseVersion:1,baseCommitOid,contractVersion:1,policyVersion:1,orderedRevisions:[{changeId:change.id,revisionId:revision.id}],excludedChangeIds:[],decisionRevisions:[],compositionVersion:1}});
   await runSourceJob(runner,{remote,workspaceRoot,resolveRepository:()=>remote,requestId:`compose-${name}`});
   return human.view(view.id);
 };
 const original=await publish('original');
 const failed=await runViewDemoSuite(runner,{remote,workspaceRoot,viewId:original.id,projectId:'demo-api-lifecycle',requestId:'check-original'});
 expect(failed).toHaveLength(1);expect(failed[0]!.data.result).toBe('failed');
 expect(failed[0]!.data.execution.status).toBe('exited');expect(failed[0]!.data.execution.exitCode).toBe(0);
 expect(await human.checks(original.id)).toEqual(failed);
 expect(failed[0]!.data.applicability).toMatchObject({viewId:original.id,composedCommitOid:original.data.receipt!.commitOid,treeOid:original.data.receipt!.treeOid,checkSuiteDigest:demoSuiteDigest()});
 expect((await human.readiness(original.id)).blockers.map(x=>x.code)).toContain('CHECK_FAILED');
 const originalRef=await readSourceReceipt(remote,original.data.receipt!.ref);
 // This explicit pagination fixture tests the oracle, not an autonomous implementation claim.
 const start=seed.indexOf('export function createProjectListHandler()'),end=seed.indexOf('export async function handleSeedRequest');
 expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start);
 const handler=`export function createProjectListHandler() { return async (request: Request) => {
 const u=new URL(request.url), tenant=u.searchParams.get('tenant');
 if(request.method!=='GET'||u.pathname!=='/api/projects')return Response.json({error:'not_found'},{status:404});
 if(tenant!=='tenant-a'&&tenant!=='tenant-b')return Response.json({error:'unknown_tenant'},{status:400});
 const rows=listProjects(tenant),raw=u.searchParams.get('limit'),cursor=u.searchParams.get('cursor');
 if(raw===null){if(cursor!==null)return Response.json({error:'invalid_cursor'},{status:400});return Response.json(rows);}
 if(!/^[1-9][0-9]*$/.test(raw)||Number(raw)>50)return Response.json({error:'invalid_limit'},{status:400});
 let offset=0;
 if(cursor!==null){try{const c=JSON.parse(Buffer.from(cursor,'base64url').toString());if(c.tenant!==tenant||!Number.isInteger(c.offset)||c.offset<0||c.offset>=rows.length)throw new Error();offset=c.offset;}catch{return Response.json({error:'invalid_cursor'},{status:400});}}
 const items=rows.slice(offset,offset+Number(raw)),next=offset+items.length;
 return Response.json({items,nextCursor:next<rows.length?Buffer.from(JSON.stringify({tenant,offset:next})).toString('base64url'):null});
 };}\n\n`;
 git('checkout','-q','--detach',baseCommitOid);git('checkout','-qb','fixed-fixture');
 await mkdir(join(source,'demo/seed'),{recursive:true});await writeFile(join(source,'demo/seed/index.ts'),seed.slice(0,start)+handler+seed.slice(end));git('add','.');git('commit','-qm','pagination oracle positive fixture');
 const replacement=await publish('fixed');
 const passed=await runViewDemoSuite(runner,{remote,workspaceRoot,viewId:replacement.id,projectId:'demo-api-lifecycle',requestId:'check-fixed'});
 expect(passed[0]!.data.result,JSON.stringify(passed[0]!.data.execution)).toBe('passed');
 expect(await human.checks(replacement.id)).toEqual(passed);expect(await human.checks(original.id)).toEqual(failed);
 expect(await readSourceReceipt(remote,originalRef.ref)).toEqual(originalRef);
 expect(await readSourceReceipt(remote,replacement.data.receipt!.ref)).toEqual(replacement.data.receipt);
 expect(await human.baseline()).toEqual(baseline);
 expect((await human.readiness(replacement.id)).blockers.map(x=>x.code)).toContain('REVIEW_MISSING');
},60_000);
