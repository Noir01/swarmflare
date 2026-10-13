import { readFile, lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { workspaceEndpoint } from '../../packages/client/endpoint.js';

const roles = new Set(['api', 'ui', 'adversary', 'reviewer']);
const humanOnly = new Set(['proposal', 'approve-proposal', 'configure-policy', 'confirm-view', 'accept-view', 'baseline-initialize', 'resolve-decision']);
const runnerOnly = new Set(['source-job-claim', 'source-job-complete', 'source-job']);
const cliCommands = new Set(['context','events','contract','claim','claim-update','overlap-ack','decision','decision-response','decision-agree','baseline','change-create','change','revision-publish','revision','view-create','view','view-updates','checks','findings','finding','finding-create','finding-owner','finding-repair','finding-resolve','review','readiness','reviews','policy','acceptance','source-verification','get']);
export const childBudgetMs = 35_000;
const actorHelp=`Live actor commands (role-scoped; no human or runner commands):
Read: context (includes decisions), events [JSON], contract {"version":1}, revision {"id":"..."}, view {"id":"..."}, findings, finding {"id":"..."}, policy, baseline, change {"id":"..."}, view-updates {"id":"..."}, checks {"id":"..."}, readiness {"id":"..."}, reviews {"id":"..."}, acceptance {"id":"..."}, source-verification {"id":"..."}, get {"path":"/frozen/read/path"}.
Create/respond: decision {"requestId":"...","payload":{...}} (creates one; read existing decisions from context); decision-response/decision-agree {"id":"...","mutation":{"requestId":"...","payload":{...}}}.
revision-publish {"id":"...","mutation":{"requestId":"...","payload":{...}}}; view-create {"requestId":"...","payload":{...}}; view {"id":"..."}; revision {"id":"..."}.
finding-owner {"id":"...","mutation":{"requestId":"...","expectedVersion":1,"payload":{"nextOwner":"...","note":"..."}}}; finding-repair {"id":"...","mutation":{"requestId":"...","expectedVersion":1,"payload":{"revisions":[{"changeId":"...","revisionId":"..."}]}}}; review {"id":"...","mutation":{"requestId":"...","expectedVersion":1,"payload":{"viewId":"...","manifestDigest":"...","composedCommitOid":"...","treeOid":"...","contractVersion":1,"policyVersion":1,"obligationIds":["..."],"summary":"...","verdict":"passed|failed","findings":[]}}}; finding-resolve {"id":"...","mutation":{"requestId":"...","expectedVersion":1,"payload":{"viewId":"...","note":"..."}}}.
Other allowed commands: claim, claim-update, overlap-ack, change-create, finding-create.
Supply one JSON argument directly or as @JSON_FILE (max 64 KiB; file is inert JSON).`;

async function readJsonArgument(raw:string):Promise<string> {
  if(!raw.startsWith('@')) { try { JSON.parse(raw); } catch { throw new Error('argument must be valid JSON'); } return raw; }
  const path=resolve(process.cwd(),raw.slice(1));
  let info; try { info=await lstat(path); } catch { throw new Error('JSON input file is unavailable or invalid'); }
  if(info.isSymbolicLink()||!info.isFile()||info.size>65536) throw new Error('JSON input file must be a regular file no larger than 64 KiB');
  let handle; try { handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK); const stat=await handle.stat(); if(!stat.isFile()) throw new Error(); const buffer=Buffer.alloc(65537); let bytesRead=0; while(bytesRead<buffer.length){const result=await handle.read(buffer,bytesRead,buffer.length-bytesRead,bytesRead); if(result.bytesRead===0) break; bytesRead+=result.bytesRead;} if(bytesRead>65536) throw new Error(); const text=buffer.subarray(0,bytesRead).toString('utf8'); JSON.parse(text); return text; } catch { throw new Error('JSON input file is unavailable or invalid'); } finally { await handle?.close(); }
}

export interface ActorConfig { baseUrl: string; approvedOrigin?: string; projectId: string; token: string; actorId: string; repository: string }

export function validateBaseUrl(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('role config baseUrl must be a literal loopback HTTP URL');
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('role config baseUrl must be a literal loopback HTTP URL'); }
  if (url.protocol !== 'http:' || !['127.0.0.1','[::1]','::1'].includes(url.hostname.toLowerCase()) || url.username || url.password || url.search || url.hash || !['','/'].includes(url.pathname) || /@/.test(raw)) throw new Error('role config baseUrl must be literal HTTP loopback without credentials, path, query, or fragment');
  return url.origin;
}

export function validateConfig(value: unknown): ActorConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('role config must be an object');
  const x=value as Record<string,unknown>;
  const keys=Object.keys(x).sort().join(',');
  if(keys!=='actorId,baseUrl,projectId,repository,token'&&keys!=='actorId,approvedOrigin,baseUrl,projectId,repository,token') throw new Error('role config has unexpected or missing fields');
  let baseUrl:string;
  if(x.approvedOrigin===undefined) baseUrl=validateBaseUrl(x.baseUrl);
  else {
    if(typeof x.approvedOrigin!=='string') throw new Error('role config approvedOrigin must be an exact HTTPS origin');
    try { workspaceEndpoint(x.baseUrl as string,x.approvedOrigin); baseUrl=x.approvedOrigin; }
    catch { throw new Error('role config baseUrl must exactly match its approved HTTPS *.workers.dev origin'); }
  }
  for(const key of ['projectId','actorId','token','repository'] as const) if(typeof x[key]!=='string'||!x[key]) throw new Error(`role config ${key} must be a non-empty string`);
  if(!/^[A-Za-z0-9_-]{1,120}$/.test(x.projectId as string)||!/^[A-Za-z0-9_-]{1,120}$/.test(x.actorId as string)) throw new Error('role config projectId and actorId must be valid IDs');
  if((x.token as string).length>4096 || (x.repository as string).length>4096) throw new Error('role config field exceeds limit');
  return {baseUrl,...(x.approvedOrigin===undefined?{}:{approvedOrigin:x.approvedOrigin as string}),projectId:x.projectId as string,token:x.token as string,actorId:x.actorId as string,repository:x.repository as string};
}

function safeMessage(text: string, token: string): string {
  const cleaned=text.split(token).join('[REDACTED]').replace(/Bearer\s+[^\s"']+/gi,'Bearer [REDACTED]');
  try { const data=JSON.parse(cleaned); if(data&&typeof data==='object'&&'error' in data) return JSON.stringify({error:String((data as {error:unknown}).error)}); } catch { /* normalized below */ }
  return JSON.stringify({error:cleaned.slice(0,4000)||'actor CLI failed'});
}

export async function invoke(root: string, role: string, command: string, raw?: string, budgetMs=childBudgetMs): Promise<{stdout:string;stderr:string;code:number}> {
  if(!roles.has(role)) throw new Error('role must be api, ui, adversary, or reviewer');
  if(command==='--help'||command==='-h'||command==='help') return {stdout:actorHelp+'\n',stderr:'',code:0};
  if(humanOnly.has(command)) throw new Error('human-only command refused');
  if(runnerOnly.has(command) || !cliCommands.has(command)) throw new Error('command is not available to live actors');
  let argument: unknown;
  if(raw!==undefined) { argument=await readJsonArgument(raw); }
  const configPath=resolve(root,'actors',`${role}.json`);
  let parsed: unknown;
  try { parsed=JSON.parse(await readFile(configPath,'utf8')); } catch { throw new Error('role config is unavailable or invalid JSON'); }
  const config=validateConfig(parsed);
  const cwd=process.cwd();
  const args=['--import','tsx',fileURLToPath(new URL('../../apps/cli/index.ts',import.meta.url)),command];
  if(raw!==undefined) args.push(argument as string);
  return await new Promise((resolvePromise)=>{
    const env={PATH:process.env.PATH??'',HOME:process.env.HOME??'',NO_COLOR:'1',WORKSPACE_BASE_URL:config.baseUrl,...(config.approvedOrigin?{WORKSPACE_ALLOWED_ORIGIN:config.approvedOrigin}:{}),WORKSPACE_PROJECT_ID:config.projectId,WORKSPACE_TOKEN:config.token};
    const child=spawn(process.execPath,args,{cwd,env,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='',settled=false;
    let timedOut=false, spawnError=false, termTimer:ReturnType<typeof setTimeout>|undefined;
    const timer=setTimeout(()=>{timedOut=true;child.kill('SIGTERM');termTimer=setTimeout(()=>child.kill('SIGKILL'),250);},budgetMs);
    const scrub=(text:string)=>text.split(config.token).join('[REDACTED]');
    child.stdout.setEncoding('utf8').on('data',(chunk:string)=>{stdout+=chunk;if(stdout.length>65536)child.kill('SIGTERM');});
    child.stderr.setEncoding('utf8').on('data',(chunk:string)=>{stderr+=chunk;if(stderr.length>65536)child.kill('SIGTERM');});
    child.once('error',()=>{spawnError=true;});
    child.once('close',(code)=>{if(settled)return;settled=true;clearTimeout(timer);if(termTimer)clearTimeout(termTimer);resolvePromise({stdout:scrub(stdout),stderr:timedOut?'':spawnError?safeMessage('unable to launch actor CLI',config.token):stderr?safeMessage(stderr,config.token):'',code:timedOut?124:spawnError?127:code??1});});
  });
}

async function main() {
  const [root,role,command,raw,...extra]=process.argv.slice(2);
  if(!root||!role||!command||extra.length) throw new Error('usage: actor.ts ROOT ROLE COMMAND [JSON]');
  const result=await invoke(root,role,command,raw);
  if(result.stdout) process.stdout.write(result.stdout);
  if(result.stderr) process.stderr.write(result.stderr.endsWith('\n')?result.stderr:`${result.stderr}\n`);
  process.exitCode=result.code;
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main().catch((error:unknown)=>{const message=error instanceof Error?error.message:'actor bridge failed';process.stderr.write(`${JSON.stringify({error:message})}\n`);process.exitCode=1;});
}
