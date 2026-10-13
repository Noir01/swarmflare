import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, isAbsolute } from 'node:path';
import { WorkspaceClient } from '../../packages/client/index.js';
import { readSourceReceipt } from '../../packages/git-runner/index.js';

const clean=(v:unknown,secrets:string[]):unknown=>{
 if(typeof v==='string'){let s=v;for(const secret of secrets)if(secret)s=s.split(secret).join('[REDACTED]');return s;}
 if(Array.isArray(v))return v.map(x=>clean(x,secrets));
 if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,/token|password|credential|authorization|secret/i.test(k)?'[REDACTED]':clean(x,secrets)]));
 return v;
};
const obj=(v:unknown):Record<string,any>=>v&&typeof v==='object'?v as Record<string,any>:{};
const fail=(message:string):never=>{throw new Error(message);};

export async function buildTrace(rootArg:string,outputArg:string):Promise<Record<string,unknown>>{
 const root=resolve(rootArg), output=resolve(outputArg);
 if(!isAbsolute(rootArg)||!isAbsolute(outputArg)||!(output===root||output.startsWith(root+'/')))fail('ROOT and OUTPUT must be absolute; OUTPUT must be inside ROOT');
 const manifest=JSON.parse(await readFile(resolve(root,'manifest.json'),'utf8'));
 const runner=JSON.parse(await readFile(resolve(root,'private/runner.json'),'utf8'));
 const remote=resolve(manifest.remote), workspaceRoot=resolve(manifest.workspaceRoot);
 if(runner.projectId!==manifest.projectId||runner.baseUrl!==manifest.baseUrl)fail('runner config does not match manifest');
 const runnerUrl=new URL(runner.baseUrl);
 if(!['127.0.0.1','::1','localhost'].includes(runnerUrl.hostname)||!['http:','https:'].includes(runnerUrl.protocol))fail('runner URL must be literal loopback');
 if(!isAbsolute(manifest.remote)||/^[a-z][a-z0-9+.-]*:\/\//i.test(manifest.remote)||runner.repository!==manifest.remote)fail('runner repository must match an absolute local Git path');
 const secrets=[runner.token,...Object.values(manifest.actors??{}).flatMap((a:any)=>typeof a?.token==='string'?[a.token]:[])];
 for(const role of ['api','ui','adversary','reviewer'])try{const cfg=JSON.parse(await readFile(resolve(root,`actors/${role}.json`),'utf8'));if(typeof cfg.token==='string')secrets.push(cfg.token);}catch{}
 const client=new WorkspaceClient({baseUrl:runner.baseUrl,projectId:runner.projectId,token:runner.token,maxRequests:1000,deadline:180_000});
 const errors:unknown[]=[]; let context:unknown=null,baseline:unknown=null,events:any[]=[]; let truncated=false;
 try{context=await client.context();}catch(e){errors.push({source:'context',error:String(e)});}
 try{baseline=await client.baseline();}catch(e){errors.push({source:'baseline',error:String(e)});}
 let cursor:string|undefined;
 while(events.length<1000){
  try{
   const page=obj(await client.events({cursor,limit:Math.min(100,1000-events.length)}));
   const rows=Array.isArray(page.events)?page.events:[]; events.push(...rows);
   const next=page.nextCursor;
   if(next===null||next===undefined)break;
   if(typeof next!=='string'||next===cursor){errors.push({source:'events',error:'invalid or repeated pagination cursor'});break;}
   cursor=next;
  }catch(e){errors.push({source:'events',error:String(e)});break;}
 }
 if(events.length===1000&&cursor!==undefined)truncated=true;
 const resources:Record<string,any>={changes:{},revisions:{},views:{},decisions:{},findings:{}};
 const refs:{id:string;kind:string;resource:any}[]=[];
 const ids:Record<string,Set<string>>={changes:new Set(),views:new Set(),decisions:new Set(),findings:new Set()};
 for(const ev of events){const id=typeof ev?.resourceId==='string'?ev.resourceId:'';if(!id)continue;switch(ev.action){case 'change.create': ids.changes.add(id);break;case 'view.create': ids.views.add(id);break;case 'decision.create': ids.decisions.add(id);break;case 'finding.create': ids.findings.add(id);break;}}
 const contextDecisions=obj(context).decisions;
 for(const decision of Array.isArray(contextDecisions)?contextDecisions:Object.values(obj(contextDecisions)))if(typeof decision?.id==='string')ids.decisions.add(decision.id);
 for(const f of Array.isArray(obj(context).findings)?obj(context).findings as any[]:[])if(typeof f?.id==='string')ids.findings.add(f.id);
 try{for(const f of await client.findings())ids.findings.add(f.id);}catch(e){errors.push({source:'findings',error:String(e)});}
 for(const [kind,method] of [['changes','change'],['views','view'],['decisions','decision'],['findings','finding']] as const)for(const id of ids[kind])try{const resource=kind==='decisions'?await client.decision(id):kind==='findings'?await client.finding(id):await (client as any)[method](id);resources[kind][id]=resource;refs.push({id,kind,resource});}catch(e){errors.push({source:`${kind}/${id}`,error:String(e)});}
 // Changes contain revision records; record those even when only embedded in the Change.
 for(const c of Object.values(resources.changes) as any[])for(const r of c?.data?.revisions??[]){if(r?.revisionId)resources.revisions[r.revisionId]=r;}
 const views=Object.values(resources.views) as any[];
 const evidence:Record<string,unknown>={checks:{},reviews:{},readiness:{},sourceVerification:{},updates:{}};
 for(const v of views){const id=v.id; for(const [name,fn] of Object.entries({checks:()=>client.checks(id),reviews:()=>client.reviews(id),readiness:()=>client.readiness(id),sourceVerification:()=>client.sourceVerification(id),updates:()=>client.viewUpdates(id)}))try{(evidence[name] as any)[id]=await fn();}catch(e){errors.push({source:`${name}/${id}`,error:String(e)});}}
 const reviewArtifacts:Record<string,unknown>={};
 for(const v of views.slice(0,100)){const id=v.id;try{const artifact=await client.reviewArtifact(id);if(!artifact){reviewArtifacts[id]=null;continue;}const d=artifact.data,html=d.preview?.html;reviewArtifacts[id]={id:artifact.id,version:artifact.version,owner:artifact.owner,applicability:d.applicability,baseline:d.baseline,diff:{patch:{sha256:createHash('sha256').update(d.diff.patch,'utf8').digest('hex'),byteCount:Buffer.byteLength(d.diff.patch,'utf8')},files:d.diff.files,truncated:d.diff.truncated},preview:d.preview?{supported:d.preview.supported,expiresAt:d.preview.expiresAt,status:d.preview.expiresAt<=Date.now()?'expired':'fresh',...(typeof html==='string'?{html:{sha256:createHash('sha256').update(html,'utf8').digest('hex'),byteCount:Buffer.byteLength(html,'utf8')}}:{})}:null};}catch(e){errors.push({source:`reviewArtifact/${id}`,error:String(e)});}}
 if(views.length>100)errors.push({source:'reviewArtifacts',error:'review artifact lookup limited to first 100 Views'});
 const receipts:any[]=[];
 const addReceipt=(receipt:any,source:string)=>{if(receipt?.backend==='local-git'&&typeof receipt.ref==='string')receipts.push({receipt,source});};
 addReceipt((baseline as any)?.receipt,'baseline');
 for(const c of Object.values(resources.changes) as any[])for(const r of c?.data?.revisions??[])addReceipt(r.receipt,`revision/${r.revisionId}`);
 for(const v of views)addReceipt(v?.data?.receipt,`view/${v.id}`);
 const verified:any[]=[];
 for(const {receipt,source} of receipts){try{const actual=await readSourceReceipt(remote,receipt.ref);const ok=actual.commitOid===receipt.commitOid&&actual.treeOid===receipt.treeOid;verified.push({source,expected:receipt,actual,verified:ok,...(!ok?{error:'receipt differs from local bare Git'}:{})});}catch(e){verified.push({source,expected:receipt,verified:false,error:String(e)});}}
 const observations={context,baseline,events,eventsTruncated:truncated,claims:obj(context).claims??[],decisions:obj(context).decisions??[],findings:obj(context).findings??[],resources,evidence,reviewArtifacts,sourceReceipts:verified,git:{remote,workspaceRoot,receiptErrors:verified.filter(x=>!x.verified)}};
 const gates=[{gate:'live-agent activity',satisfied:false,reason:'Trace records platform actors/actions only; actor IDs and reports do not prove real-agent activity.'},{gate:'complete event history',satisfied:!truncated&&errors.every((x:any)=>x.source!=='events'),reason:truncated?'Event capture reached the 1000-event bound.':(errors.find((x:any)=>x.source==='events') as any)?.error??'Captured event pages ended.'},{gate:'all source receipts verified',satisfied:verified.length>0&&verified.every(x=>x.verified),reason:verified.length?'Verification reflects local bare Git readback.':'No source receipts were discovered.'}];
 const document={format:'local-live-trace-v1',generatedAt:new Date().toISOString(),scope:{projectId:manifest.projectId,baseUrl:manifest.baseUrl,root,remote,workspaceRoot},observations:clean(observations,secrets),productDemoGates:gates,errors:clean(errors,secrets),note:'Observations are read-only evidence, not product acceptance or proof of autonomous agent activity.'};
 await writeFile(output,JSON.stringify(clean(document,secrets),null,2)+'\n',{mode:0o600});
 return document;
}

if(process.argv[1]&&resolve(process.argv[1])===resolve(new URL(import.meta.url).pathname)){
 const [root,output,...extra]=process.argv.slice(2);
 if(!root||!output||extra.length){process.stderr.write('Usage: npx tsx demo/live/trace.ts ROOT OUTPUT\n');process.exitCode=2;}
 else void buildTrace(root,output).then(()=>process.stdout.write(JSON.stringify({written:resolve(output)})+'\n')).catch(e=>{process.stderr.write(`${e instanceof Error?e.message:'Trace failed'}\n`);process.exitCode=1;});
}
