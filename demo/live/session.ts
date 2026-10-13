import { randomBytes, createHash } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, join } from 'node:path';
import { startLocalWorkspace } from '../../apps/local/index.js';
import { WorkspaceClient } from '../../packages/client/index.js';
import { runSourceJob } from '../../packages/local-runner/index.js';
import { runViewMandatoryDemoSuite } from '../../packages/local-runner/checks.js';

const exec = promisify(execFile);
const projectId='continuous11-live';
const roles=['api','ui','adversary','reviewer'] as const;
type Role=typeof roles[number];
type Config={baseUrl:string;projectId:string;token:string;actorId:string;repository:string};
const writePrivate=async(path:string,data:unknown)=>{await writeFile(path,JSON.stringify(data)+'\n',{mode:0o600});await chmod(path,0o600);};
const git=async(cwd:string,...args:string[])=> (await exec('git',['-C',cwd,...args],{timeout:20_000})).stdout.trim();
const client=(c:Config)=>new WorkspaceClient({baseUrl:c.baseUrl,projectId:c.projectId,token:c.token,maxRequests:100,deadline:60_000});
async function config(root:string,name:string):Promise<Config>{return JSON.parse(await readFile(join(root,'private',name+'.json'),'utf8')) as Config;}
async function emit(value:unknown){process.stdout.write(JSON.stringify(value)+'\n');}
function orderSelectedChanges(changes:any[]):any[]{
 if(changes.length>100)throw Error('too many selected revisions');
 const byKey=new Map<string,any>();for(const change of changes){const key=`${change.changeId}/${change.revisionId}`;if(byKey.has(key))throw Error(`duplicate selected revision: ${key}`);byKey.set(key,change);}
 const state=new Map<string,number>(),ordered:any[]=[];
 const visit=(change:any,stack:string[])=>{const key=`${change.changeId}/${change.revisionId}`,s=state.get(key)??0;if(s===1)throw Error(`dependency cycle: ${[...stack,key].join(' -> ')}`);if(s===2)return;state.set(key,1);
  for(const dep of change.data.dependencies??[]){const selected=byKey.get(`${dep.changeId}/${dep.revisionId}`);if(!selected)throw Error(`missing or mismatched selected dependency ${dep.changeId}/${dep.revisionId} required by ${key}`);visit(selected,[...stack,key]);}
  state.set(key,2);ordered.push(change);
 };
 for(const change of changes)visit(change,[]);return ordered;
}
async function start(rootArg:string,secondsArg:string){
 const root=resolve(rootArg),seconds=Number(secondsArg); if(!Number.isFinite(seconds)||seconds<=0||seconds>1800)throw Error('SECONDS must be >0 and <=1800');
 await mkdir(root,{recursive:true,mode:0o700});await chmod(root,0o700);for(const d of ['private','actors','repos','seed','work']){await mkdir(join(root,d),{recursive:true,mode:0o700});await chmod(join(root,d),0o700);}
 const sessionPath=join(root,'private','session.json');let prior:any=null;try{prior=JSON.parse(await readFile(sessionPath,'utf8'));}catch{}
 const tokens:Record<string,string>=prior?.tokens??Object.fromEntries([...roles,'runner'].map(r=>[r,randomBytes(32).toString('hex')]));
 const dashboardSessionKey=prior?.dashboardSessionKey??randomBytes(32).toString('hex');
 const humanToken=prior?undefined:randomBytes(32).toString('hex');
 const creds=Object.entries({...tokens,...(humanToken?{human:humanToken}:{})}).map(([r,token])=>({id:r==='human'?'demo-human':r==='runner'?'demo-runner':r,role:r==='human'?'human':r==='runner'?'runner':r==='reviewer'?'reviewer':'contributor',projectId,tokenHash:createHash('sha256').update(token).digest('hex'),expiresAt:Date.now()+1_800_000}));
 let app:Awaited<ReturnType<typeof startLocalWorkspace>>|undefined;
 const stop=()=>{void app?.close();};process.once('SIGTERM',stop);process.once('SIGINT',stop);
 try {
 app=await startLocalWorkspace({stateDirectory:join(root,'state'),authCredentials:JSON.stringify(creds),dashboardSessionKey,runBudgetMs:Math.ceil(seconds*1000)});
 const remote=join(root,'remote.git'),seedRepo=join(root,'seed'),workspaceRoot=join(root,'work');
 if(!prior){await exec('git',['init','--bare','-q',remote]);await exec('git',['init','-q',seedRepo]);await git(seedRepo,'config','user.name','Synthetic Seed');await git(seedRepo,'config','user.email','seed@example.invalid');
  for(const file of ['index.ts','api.ts','ui.ts']){const source=join(process.cwd(),'demo','seed',file);try{const data=await readFile(source,'utf8');await mkdir(join(seedRepo,'demo','seed'),{recursive:true});await writeFile(join(seedRepo,'demo','seed',file),data);}catch{}}
  await git(seedRepo,'add','.');await git(seedRepo,'commit','-qm','approved legacy demo seed');
 }
 const commitOid=await git(seedRepo,'rev-parse','HEAD'),treeOid=await git(seedRepo,'rev-parse','HEAD^{tree}');
 const baseUrl=app.url;
 if(!prior){
  // Existing approved setup logic is exercised through its published CLI in the setup command path.
  const { stdout }=await exec(process.execPath,['--import','tsx',resolve('apps/setup/index.ts'),JSON.stringify({requestId:'live-setup',commitOid,treeOid})],{timeout:40_000,env:{...process.env,WORKSPACE_BASE_URL:baseUrl,WORKSPACE_PROJECT_ID:projectId,WORKSPACE_TOKEN:humanToken}}); const result=JSON.parse(stdout);
  const runner:Config={baseUrl,projectId,token:tokens.runner,actorId:'demo-runner',repository:remote};
  const r=client(runner);await runSourceJob(r,{remote,workspaceRoot,requestId:'live-seed',resolveRepository:()=>seedRepo});
  const job=await r.sourceJob(result.pendingSeedJobId); if(job.data.status!=='completed')throw Error('seed publication did not complete');
  await git(seedRepo,'remote','add','live',remote).catch(()=>{});for(const role of roles){const repo=join(root,'repos',role);await exec('git',['clone','-q',seedRepo,repo]);await git(repo,'config','user.name',`Synthetic ${role}`);await git(repo,'config','user.email',`${role}@example.invalid`);}
  const manifest={baseUrl,projectId,baseCommitOid:commitOid,baseTreeOid:treeOid,remote,workspaceRoot,actors:Object.fromEntries(roles.map(role=>[role,{id:role,repository:join(root,'repos',role)}]))};await writeFile(join(root,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o644});
 }
 for(const role of roles){const actorId=role;const cfg={baseUrl,projectId,token:tokens[role],actorId,repository:join(root,'repos',role)};await writePrivate(join(root,'actors',role+'.json'),cfg);}
 const runnerConfig={baseUrl,projectId,token:tokens.runner,actorId:'demo-runner',repository:remote};await writePrivate(join(root,'private','runner.json'),runnerConfig);
 const publicManifest=JSON.parse(await readFile(join(root,'manifest.json'),'utf8'));publicManifest.baseUrl=baseUrl;await writeFile(join(root,'manifest.json'),JSON.stringify(publicManifest,null,2)+'\n',{mode:0o644});
 await writePrivate(sessionPath,{tokens,dashboardSessionKey,projectId});
 await emit({url:app.url,root,mode:'local-only',boundedSeconds:seconds});await app.closed;
 } finally {process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);await app?.close();}
}
async function run(command:string,root:string,arg?:string){const runner=await config(root,'runner');const api=client(runner);const manifest=JSON.parse(await readFile(join(root,'manifest.json'),'utf8'));
 const resolveRepository=(input:any)=>{if(input.kind==='seed')return manifest.actors.api.repository;if(input.kind==='publication'){const actor=Object.values(manifest.actors).find((x:any)=>x.id===input.revision.owner) as any;if(!actor)throw Error(`unknown publication owner: ${input.revision.owner}`);return actor.repository;}return manifest.remote;};
 if(command==='drain'){const result=await runSourceJob(api,{remote:manifest.remote,workspaceRoot:manifest.workspaceRoot,requestId:`live-drain-${Date.now()}`,resolveRepository});return emit(result);}
 if(command==='checks'){const result=await runViewMandatoryDemoSuite(api,{remote:manifest.remote,workspaceRoot:manifest.workspaceRoot,projectId,viewId:arg!,requestId:`live-check-${Date.now()}`});return emit(result);}
 if(command==='compose'){const ids=new Set<string>();for await(const rawPage of api.eventPages({limit:100,maxPages:10})){const page=rawPage as any[];for(const item of page){const event:any=item;if(event.action==='change.create'&&event.resourceId)ids.add(event.resourceId);}}
 const changes:any[]=[],excluded:string[]=[];for(const id of ids){try{const ch=await api.change(id);if(ch.data.latestRevisionId){const rev=await api.revision(ch.data.latestRevisionId);if(rev.data.status==='published')changes.push({changeId:id,revisionId:rev.id,owner:rev.owner,data:rev.data});else excluded.push(id);}else excluded.push(id);}catch{excluded.push(id);}}
 if(!changes.length)throw Error('no published changes available');const context:any=await api.context(),policy=await api.policy(),baseline=await api.baseline();if(!baseline||!policy)throw Error('baseline and policy are required');
 const decisionRevisions=context.decisions.filter((d:any)=>d.data?.status==='agreed').map((d:any)=>({decisionId:d.id,version:d.version}));
 const ordered=orderSelectedChanges(changes);const manifestInput={baseVersion:baseline.version,baseCommitOid:baseline.commitOid,contractVersion:context.contract.version,policyVersion:policy.version,orderedRevisions:ordered.map(x=>({changeId:x.changeId,revisionId:x.revisionId})),excludedChangeIds:excluded,decisionRevisions,compositionVersion:1};const contributorConfig=JSON.parse(await readFile(join(root,'actors','api.json'),'utf8')) as Config;const contributor=client(contributorConfig);const created=await contributor.createView({requestId:`live-compose-${Date.now()}`,payload:manifestInput});const result=await runSourceJob(api,{remote:manifest.remote,workspaceRoot:manifest.workspaceRoot,requestId:`live-compose-drain-${Date.now()}`,resolveRepository});const view=await contributor.view(created.id);if(view.id!==created.id||view.data.status!=='runnable')throw Error('exact view readback is not runnable');return emit({view,result});}
 throw Error('unknown command');}
async function main(){const [command,...args]=process.argv.slice(2);if(command==='start')return start(args[0]!,args[1]!);if(['drain','compose','checks'].includes(command!))return run(command!,resolve(args[0]!),args[1]);throw Error('Usage: session.ts start ROOT SECONDS | drain ROOT | compose ROOT | checks ROOT VIEWID');}
main().catch(e=>{process.stderr.write(JSON.stringify({error:e instanceof Error?e.message:'session failed'})+'\n');process.exitCode=1;});
