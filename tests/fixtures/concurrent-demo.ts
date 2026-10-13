import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { html, clientScript } from '../../demo/seed/index';
import { plainHtml, paginatedClientScript } from './paginated-demo';

const exec = promisify(execFile);
const apiObligations = ['legacy-response', 'pagination-order', 'cursor-validation', 'tenant-isolation'];
const uiObligations = ['ui-navigation', 'ui-tenant-switch'];

export async function writeConcurrentSeed(directory: string): Promise<void> {
  await mkdir(join(directory, 'demo/seed'), { recursive: true });
  await writeFile(join(directory, 'demo/seed/index.ts'), `export { createProjectListHandler } from './api.ts';\nexport { html, clientScript } from './ui.ts';\n`);
  await writeFile(join(directory, 'demo/seed/api.ts'), `const records=[{id:'a-project-01',name:'Tenant A: Atlas',tenantId:'tenant-a',createdAt:'2025-01-03T12:00:00.000Z'},{id:'a-project-02',name:'Tenant A: Beacon',tenantId:'tenant-a',createdAt:'2025-01-02T12:00:00.000Z'},{id:'a-project-03',name:'Tenant A: Cedar',tenantId:'tenant-a',createdAt:'2025-01-02T12:00:00.000Z'},{id:'b-project-01',name:'Tenant B: Delta',tenantId:'tenant-b',createdAt:'2025-01-04T12:00:00.000Z'},{id:'b-project-02',name:'Tenant B: Echo',tenantId:'tenant-b',createdAt:'2025-01-02T12:00:00.000Z'}];\nexport function createProjectListHandler(){return async(request:Request)=>{const u=new URL(request.url),tenant=u.searchParams.get('tenant');if(request.method!=='GET'||u.pathname!=='/api/projects')return Response.json({error:'not_found'},{status:404});if(tenant!=='tenant-a'&&tenant!=='tenant-b')return Response.json({error:'unknown_tenant'},{status:400});return Response.json(records.filter(p=>p.tenantId===tenant));}}\n`);
  await writeFile(join(directory, 'demo/seed/ui.ts'), `export const html=${JSON.stringify(html)};\nexport const clientScript=${JSON.stringify(clientScript)};\n`);
}

export async function writeRepairedUi(directory: string): Promise<void> {
  await writeFile(join(directory, 'demo/seed/ui.ts'), `export const html=${JSON.stringify(plainHtml)};\nexport const clientScript=${JSON.stringify(paginatedClientScript)};\n`);
}

export interface ConcurrentContributorResult { actor: 'api'|'ui'; changeId:string; revisionId:string; commitOid:string; treeOid:string; startedAt:number; finishedAt:number; pid:number; cgroup:string }
export async function runConcurrentContributors(options:{root:string;baseUrl:string;projectId:string;baseCommitOid:string;apiDirectory:string;uiDirectory:string;apiToken:string;uiToken:string}):Promise<ConcurrentContributorResult[]> {
  const barrier=join(options.root,'.concurrent-demo-barrier'); await mkdir(barrier,{recursive:true});
  const helperUrl=pathToFileURL(join(process.cwd(),'packages/client/index.ts')).href;
  const fixtureUrl=pathToFileURL(join(process.cwd(),'tests/fixtures/paginated-demo.ts')).href;
  const worker = `
import { WorkspaceClient } from ${JSON.stringify(helperUrl)};
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
const o = JSON.parse(process.env.WORKER_OPTIONS);
const git = (...args) => execFileSync('git', ['-C', o.directory, ...args], { encoding: 'utf8' }).trim();
const client = new WorkspaceClient({ baseUrl:o.baseUrl, projectId:o.projectId, token:o.token, maxRequests:50, deadline:25000 });
const obligations = o.actor === 'api' ? ['legacy-response','pagination-order','cursor-validation','tenant-isolation'] : ['ui-navigation','ui-tenant-switch'];
const startedAt = Date.now();
await client.createClaim({ requestId:o.actor+'-claim', payload:{ status:'working', areas:[o.actor==='api'?'demo/seed/api.ts':'demo/seed/ui.ts'], obligationIds:obligations } });
const change = await client.createChange({ requestId:o.actor+'-change', payload:{ title:'Synthetic '+o.actor+' contributor fixture', obligationIds:obligations } });
await writeFile(join(o.barrier, o.actor+'.ready'), 'ready');
while (true) { try { await readFile(join(o.barrier,'go')); break; } catch { if (Date.now()-startedAt > 15000) throw Error('barrier timeout'); await new Promise(r=>setTimeout(r,20)); } }
if (o.actor === 'api') {
  const source = await readFile(join(o.directory,'demo/seed/api.ts'),'utf8');
  const seed = await readFile(join(o.directory,'demo/seed/index.ts'),'utf8');
  const { paginatedHandler, records } = await import(${JSON.stringify(fixtureUrl)});
  if (!seed.includes("from './api.ts'") || !source) throw Error('unexpected seed split');
  const handler = paginatedHandler.replace('export function createProjectListHandler(){return async request=>','export function createProjectListHandler(){return async (request:Request)=>');
  await writeFile(join(o.directory,'demo/seed/api.ts'), records+'\\n'+handler+'\\n');
} else {
  const { plainHtml, paginatedClientScript } = await import(${JSON.stringify(fixtureUrl)});
  const broken = paginatedClientScript.replace("tenant.addEventListener('change',()=>load(true))", "tenant.addEventListener('change',()=>load(false))");
  await writeFile(join(o.directory,'demo/seed/ui.ts'), 'export const html='+JSON.stringify(plainHtml)+';'+String.fromCharCode(10)+'export const clientScript='+JSON.stringify(broken)+';'+String.fromCharCode(10));
}
git('add','demo/seed/'+(o.actor==='api'?'api.ts':'ui.ts'));
git('commit','-m','Synthetic '+o.actor+' contributor fixture');
const commitOid=git('rev-parse','HEAD'), treeOid=git('rev-parse','HEAD^{tree}');
const revision=await client.publishRevision(change.id,{requestId:o.actor+'-revision',payload:{baseCommitOid:o.baseCommitOid,commitOid,treeOid,obligationIds:obligations,decisionRevisions:[],dependencies:[]}});
console.log(JSON.stringify({actor:o.actor,changeId:change.id,revisionId:revision.id,commitOid,treeOid,startedAt,finishedAt:Date.now(),pid:process.pid,cgroup:(await readFile('/proc/self/cgroup','utf8')).trim()}));`;
  const run = async(actor:'api'|'ui',directory:string,token:string):Promise<ConcurrentContributorResult>=>{
    const args={actor,directory,token,baseUrl:options.baseUrl,projectId:options.projectId,baseCommitOid:options.baseCommitOid,barrier};
    const p=exec(process.execPath,['--import','tsx','--input-type=module','-e',worker],{cwd:process.cwd(),env:{...process.env,WORKER_OPTIONS:JSON.stringify(args)},timeout:25000});
    const {stdout}=await p; return JSON.parse(stdout.trim().split('\n').at(-1)!) as ConcurrentContributorResult;
  };
  const children=[run('api',options.apiDirectory,options.apiToken),run('ui',options.uiDirectory,options.uiToken)];
  const settled=children.map(p=>p.then(value=>({status:'fulfilled' as const,value}),reason=>({status:'rejected' as const,reason})));
  const deadline=Date.now()+16000;
  try {
    while (true) {
      const event=await Promise.race([...settled.map((promise,index)=>promise.then(outcome=>({index,outcome}))), new Promise<null>(resolve=>setTimeout(()=>resolve(null),20))]);
      if (event?.outcome.status==='rejected') throw event.outcome.reason;
      let apiReady=false, uiReady=false;
      try { await access(join(barrier,'api.ready')); apiReady=true; } catch {}
      try { await access(join(barrier,'ui.ready')); uiReady=true; } catch {}
      if (apiReady && uiReady) break;
      if (Date.now()>=deadline) throw new Error(`Concurrent contributors did not reach barrier within 16000ms (api=${apiReady}, ui=${uiReady})`);
      await new Promise(r=>setTimeout(r,20));
    }
    await writeFile(join(barrier,'go'),'go');
    const outcomes=await Promise.all(settled);
    const failure=outcomes.find(x=>x.status==='rejected');
    if (failure?.status==='rejected') throw failure.reason;
    return outcomes.map(x=>x.status==='fulfilled'?x.value:undefined) as ConcurrentContributorResult[];
  } catch(error) {
    await writeFile(join(barrier,'go'),'go').catch(()=>{});
    await Promise.all(settled);
    throw error;
  }
}
