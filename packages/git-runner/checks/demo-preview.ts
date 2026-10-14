import { lstat, readdir, mkdtemp, mkdir, open, writeFile, chmod, rm, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runSandboxedNode } from './sandbox.js';

export interface DemoPreview { supported: 'project-list-demo-v1'; html: string; expiresAt: number }
const driverName = '.trusted-preview-driver.mjs';
const generationMs=30_000;
const deniedDirectories = new Set(['.git','.ssh','.aws','.config','.gnupg','.hermes','.npm']);
const deniedFile = /^(?:\.env(?:\..*)?|.*(?:credential|secret|private[-_]?key.*))$/i;
const driver = `
const {html,clientScript,createProjectListHandler}=await import('./demo/seed/index.ts');
const handler=createProjectListHandler(),records=[];
for(const tenant of ['tenant-a','tenant-b']){let cursor=null;const seen=new Set();let terminated=false;
 for(let page=0;page<6;page++){const u=new URL('http://demo.invalid/api/projects');u.searchParams.set('tenant',tenant);u.searchParams.set('limit','2');if(cursor!==null)u.searchParams.set('cursor',cursor);
  const response=await handler(new Request(u));const body=await response.text();records.push({url:u.href,status:response.status,body});if(response.status!==200)throw Error('supported pagination response rejected');
  const parsed=JSON.parse(body);if(!parsed||!Array.isArray(parsed.items)||parsed.items.length>2)throw Error('invalid bounded items');const next=parsed.nextCursor??null;
  if(next===null){terminated=true;break;}if(typeof next!=='string'||next.length>2048||seen.has(next)||page===5)throw Error('pagination did not terminate');seen.add(next);cursor=next;
 }
 if(!terminated)throw Error('pagination did not terminate');
}
process.stdout.write(JSON.stringify({html,clientScript,records}));`;
async function snapshot(src:string,dst:string,state:{files:number;bytes:number},depth=0):Promise<void>{
 if(depth>32)throw Error('Candidate snapshot depth exceeded');
 for(const name of await readdir(src)){
  if(deniedDirectories.has(name.toLowerCase())||deniedFile.test(name))continue;
  if(name===driverName)throw Error('Reserved preview driver collision');
  const from=join(src,name),to=join(dst,name),st=await lstat(from);
  if(st.isSymbolicLink())throw Error('Candidate contains a symlink');
  if(st.isDirectory()){await mkdir(to,{mode:0o755});await snapshot(from,to,state,depth+1);await chmod(to,0o555);continue;}
  if(!st.isFile())throw Error('Candidate contains non-regular source');
  if(++state.files>1000||st.size>4*1024*1024||state.bytes+st.size>20*1024*1024)throw Error('Candidate snapshot exceeds limits');
  const h=await open(from,constants.O_RDONLY|constants.O_NOFOLLOW);let bytes:Buffer;
  try{const fresh=await h.stat();if(!fresh.isFile()||fresh.ino!==st.ino||fresh.dev!==st.dev)throw Error('Candidate changed during snapshot');const chunks:Buffer[]=[];let total=0;while(true){const chunk=Buffer.alloc(65536);const {bytesRead}=await h.read(chunk,0,chunk.length,null);if(!bytesRead)break;total+=bytesRead;if(total>4*1024*1024||state.bytes+total>20*1024*1024)throw Error('Candidate snapshot exceeds limits');chunks.push(chunk.subarray(0,bytesRead));}bytes=Buffer.concat(chunks,total);}finally{await h.close();}
  state.bytes+=bytes.length;await mkdir(dirname(to),{recursive:true,mode:0o755});await writeFile(to,bytes,{mode:0o444});
 }
}
const run=async(candidateDirectory:string,args:string[],timeoutMs:number)=>{const r=await runSandboxedNode({candidateDirectory,entrypoint:driverName,args,timeoutMs,maxOutputBytes:32768});if(r.status!=='exited'||r.exitCode!==0)throw Error(`Candidate sandbox failed (${r.status}/${r.exitCode})`);return r.stdout;};
function safeJson(value:unknown):string{return JSON.stringify(value).replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/&/g,'\\u0026').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');}
export async function buildDemoPreview(options:{candidateDirectory:string;expiresAt:number}):Promise<DemoPreview>{
 const expiry=options.expiresAt;if(!Number.isSafeInteger(expiry)||expiry<=Date.now()||expiry>Date.now()+120_000)throw Error('Invalid preview expiry');
 const deadline=Date.now()+generationMs;const remaining=()=>{const ms=deadline-Date.now();if(ms<=0)throw Error('Preview generation timed out');return Math.min(3000,ms);};const entry=join(options.candidateDirectory,'demo/seed/index.ts');const rootStat=await lstat(options.candidateDirectory);if(rootStat.isSymbolicLink()||!rootStat.isDirectory())throw Error('Candidate directory must be a regular directory');
 const source=await realpath(options.candidateDirectory);const temp=await mkdtemp(join(tmpdir(),'demo-preview-'));
 try{
  const staged=join(temp,'candidate');await mkdir(staged,{mode:0o755});await snapshot(source,staged,{files:0,bytes:0});
  const es=await lstat(join(staged,'demo/seed/index.ts'));if(!es.isFile()||es.isSymbolicLink())throw Error('Candidate must provide demo/seed/index.ts');
  await writeFile(join(staged,driverName),driver,{mode:0o444});await chmod(staged,0o555);
  const output=await run(staged,[],remaining());if(Buffer.byteLength(output)>32768)throw Error('Candidate preview output exceeds 32768 bytes');
  const assets=JSON.parse(output) as {html:string;clientScript:string;records:Array<{url:string;status:number;body:string}>};
  if(typeof assets.html!=='string'||assets.html.length>12000||typeof assets.clientScript!=='string'||assets.clientScript.length>12000)throw Error('Candidate UI assets missing or too large');
  if(!Array.isArray(assets.records)||assets.records.length<2||assets.records.length>12)throw Error('Candidate records exceed bounds');
  let totalBodyBytes=0;const records:Array<[string,{status:number;body:string}]>=[];const seenKeys=new Set<string>();
  for(const record of assets.records){if(typeof record.url!=='string'||!Number.isInteger(record.status)||typeof record.body!=='string')throw Error('Malformed candidate response record');const u=new URL(record.url);if(u.origin!=='http://demo.invalid'||u.pathname!=='/api/projects'||[...u.searchParams.keys()].some(k=>!['tenant','limit','cursor'].includes(k))||u.searchParams.getAll('tenant').length!==1||u.searchParams.getAll('limit').length!==1||u.searchParams.get('limit')!=='2'||!['tenant-a','tenant-b'].includes(u.searchParams.get('tenant')!)||u.searchParams.getAll('cursor').length>1||[...u.searchParams.keys()].length!==(u.searchParams.has('cursor')?3:2))throw Error('Candidate response URL outside supported scope');
   const key=canonical(u);if(seenKeys.has(key))throw Error('Repeated candidate response URL');seenKeys.add(key);if(record.status!==200)throw Error('Candidate demo API rejected supported tenant pagination request');if(record.body.length>32768)throw Error('Candidate response too large');totalBodyBytes+=Buffer.byteLength(record.body);if(totalBodyBytes>32768)throw Error('Candidate responses exceed total bounds');const body=JSON.parse(record.body);if(!body||!Array.isArray(body.items)||body.items.length>2||body.nextCursor!=null&&(typeof body.nextCursor!=='string'||body.nextCursor.length>2048))throw Error('Invalid bounded candidate response');records.push([key,{status:record.status,body:record.body}]);}
  for(const tenant of ['tenant-a','tenant-b']){const count=records.filter(([key])=>new URL('http://demo.invalid'+key).searchParams.get('tenant')===tenant).length;if(count<1||count>6)throw Error('Tenant response count outside bounds');}
  const shim=`const __previewExpiry=${expiry};const __previewRecords=new Map(${safeJson(records)});const __previewExpired=()=>{if(Date.now()>=__previewExpiry){document.documentElement.innerHTML='<body>Preview expired</body>';return true}return false};const __previewTimer=setTimeout(__previewExpired,Math.max(0,__previewExpiry-Date.now()));window.fetch=async(input,init={})=>{if(__previewExpired())throw new Error('Preview expired');const request=input instanceof Request?input:null;const u=new URL(typeof input==='string'?input:input.url,location.href);const method=init.method??request?.method??'GET';if(u.origin!==location.origin||u.pathname!=='/api/projects'||method!=='GET')throw new Error('Offline preview request not recorded');const q=[...u.searchParams.entries()].sort(([a,av],[b,bv])=>a.localeCompare(b)||av.localeCompare(bv));if([...u.searchParams.keys()].some(k=>!['tenant','limit','cursor'].includes(k))||u.searchParams.getAll('tenant').length!==1||u.searchParams.getAll('limit').length!==1||u.searchParams.get('limit')!=='2'||!['tenant-a','tenant-b'].includes(u.searchParams.get('tenant'))||u.searchParams.getAll('cursor').length>1)throw new Error('Offline preview request not recorded');const key='/api/projects?'+new URLSearchParams(q).toString();const row=__previewRecords.get(key);if(!row)throw new Error('Offline preview request not recorded');return new Response(row.body,{status:row.status,headers:{'content-type':'application/json'}})};`;
  const csp="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; sandbox allow-scripts";
  const html=`<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><div style="padding:.4rem;background:#fff4cc">Offline response scope: recorded tenant-a and tenant-b project-list API responses only; other requests are rejected. This is not an arbitrary application preview. Expires ${new Date(expiry).toISOString()}.</div>${assets.html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi,'').replace(/<script\b[^>]*\bsrc=["'][^"']*["'][^>]*>\s*<\/script\s*>/gi,'')}<script>${shim}\n${assets.clientScript.replace(/<\/script/gi,'<\\/script')}</script>`;
  if(html.length>32000)throw Error('Preview HTML exceeds 32000 characters');return{supported:'project-list-demo-v1',html,expiresAt:expiry};
 }finally{const unlock=async(p:string):Promise<void>=>{try{await chmod(p,0o700);for(const n of await readdir(p)){const c=join(p,n);if((await lstat(c)).isDirectory())await unlock(c);else await chmod(c,0o600);}}catch{}};await unlock(temp);await rm(temp,{recursive:true,force:true});}
}
function canonical(url:URL):string{const entries=[...url.searchParams.entries()].sort(([a,av],[b,bv])=>a.localeCompare(b)||av.localeCompare(bv));return url.pathname+'?'+new URLSearchParams(entries).toString();}
