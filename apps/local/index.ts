import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCredentials } from '../worker/src/http/router';

export type LocalWorkspaceOptions={stateDirectory:string;port?:number;authCredentials:string;dashboardSessionKey:string;runBudgetMs:number;signal?:AbortSignal};
export type LocalWorkspace={url:string;closed:Promise<void>;close():Promise<void>};
const MAX_BUDGET=1_800_000;
export async function startLocalWorkspace(options:LocalWorkspaceOptions):Promise<LocalWorkspace>{
 const started=Date.now();
 if(!options||typeof options.stateDirectory!=='string'||!options.stateDirectory.trim())throw new Error('Invalid local workspace configuration');
 if(options.port!==undefined&&(!Number.isInteger(options.port)||options.port<0||options.port>65535))throw new Error('Invalid local workspace configuration');
 if(typeof options.runBudgetMs!=='number'||!Number.isSafeInteger(options.runBudgetMs)||options.runBudgetMs<1||options.runBudgetMs>MAX_BUDGET)throw new Error('Invalid local workspace configuration');
 if(typeof options.dashboardSessionKey!=='string'||!/^[0-9a-f]{64}$/.test(options.dashboardSessionKey))throw new Error('Invalid local workspace configuration');
 const checkSignal=()=>{if(options.signal?.aborted)throw new Error('Local workspace startup aborted');};
 checkSignal();
 const credentials=parseCredentials(options.authCredentials);
 if(!credentials||credentials.length===0||credentials.some(c=>c.expiresAt<=Date.now()))throw new Error('Invalid local workspace credentials');
 let runtime:Miniflare|undefined,timer:ReturnType<typeof setTimeout>|undefined,closing:Promise<void>|undefined,finishClosed!:()=>void;
 const closed=new Promise<void>(resolve=>{finishClosed=resolve;});
 const close=()=>closing??=(async()=>{if(timer)clearTimeout(timer);try{await runtime?.dispose();}finally{finishClosed();}})();
 timer=setTimeout(()=>{void close().catch(()=>{});},options.runBudgetMs);
 try{
  const entry=resolve(fileURLToPath(new URL('../worker/src/index.ts',import.meta.url)));
  const bundle=await build({entryPoints:[entry],bundle:true,platform:'browser',format:'esm',write:false,external:['cloudflare:workers']});
  checkSignal();
  if(Date.now()-started>=options.runBudgetMs)throw new Error();
  await mkdir(resolve(options.stateDirectory),{recursive:true});
  checkSignal();
  if(options.runBudgetMs-(Date.now()-started)<=0)throw new Error();
  runtime=new Miniflare(convertV4MiniflareOptions({name:'local-workspace',modules:true,script:bundle.outputFiles[0]!.text,compatibilityDate:'2026-08-01',durableObjects:{PROJECTS:{className:'Project',useSQLite:true}},bindings:{AUTH_CREDENTIALS:options.authCredentials,DASHBOARD_SESSION_KEY:options.dashboardSessionKey},host:'127.0.0.1',port:options.port??0,resourcePersistencePath:resolve(options.stateDirectory),logRequests:false}));
  const url=(await runtime.ready).toString();checkSignal();if(Date.now()-started>=options.runBudgetMs||new URL(url).hostname!=='127.0.0.1')throw new Error();return {url,closed,close};
 }catch{await close().catch(()=>{});throw new Error('Unable to start local workspace');}
}

const help='Usage: npx tsx apps/local/index.ts --state <directory> --port <port> --run-seconds <seconds>\nRequires AUTH_CREDENTIALS and DASHBOARD_SESSION_KEY in the environment.\n';
async function main(){
 const startupAbort=new AbortController();let stopping=false,appDuringStartup:LocalWorkspace|undefined,signalClose:Promise<void>|undefined;
 const stop=()=>{stopping=true;startupAbort.abort();if(appDuringStartup)signalClose??=appDuringStartup.close().catch(()=>{process.exitCode=1;});};process.once('SIGINT',stop);process.once('SIGTERM',stop);
 const args=process.argv.slice(2);if(args.includes('--help')||args.includes('-h')){process.stdout.write(help);return;}
 const allowed=['--state','--port','--run-seconds'];const seen=new Set<string>();
 for(let i=0;i<args.length;i++){if(!allowed.includes(args[i]!)||seen.has(args[i]!)||!args[i+1]||args[i+1]!.startsWith('--')){process.stderr.write('Invalid local workspace arguments\n');process.exitCode=2;return;}seen.add(args[i]!);i++;}
 const value=(key:string)=>{const i=args.indexOf(key);return i>=0?args[i+1]:undefined;};
 const stateDirectory=value('--state'),portText=value('--port'),secondsText=value('--run-seconds');
 if(!stateDirectory||!portText||!secondsText||!process.env.AUTH_CREDENTIALS||!process.env.DASHBOARD_SESSION_KEY){process.stderr.write(help);process.exitCode=2;return;}
 const port=Number(portText),seconds=Number(secondsText);
 if(!Number.isInteger(port)||port<0||port>65535||!Number.isFinite(seconds)||seconds<=0||seconds>1800){process.stderr.write('Invalid local workspace configuration\n');process.exitCode=2;return;}
 let app:LocalWorkspace;try{app=await startLocalWorkspace({stateDirectory,port,authCredentials:process.env.AUTH_CREDENTIALS,dashboardSessionKey:process.env.DASHBOARD_SESSION_KEY,runBudgetMs:Math.ceil(seconds*1000),signal:startupAbort.signal});}catch{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);if(stopping)return;process.stderr.write('Unable to start local workspace\n');process.exitCode=1;return;}appDuringStartup=app;
 process.stdout.write(JSON.stringify({url:app.url,mode:'local-only',runBudgetMs:Math.ceil(seconds*1000)})+'\n');
 if(stopping)signalClose??=app.close().catch(()=>{process.exitCode=1;});
 await app.closed;process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
 if(signalClose)await signalClose;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))void main().catch(()=>{process.stderr.write('Local workspace stopped unexpectedly\n');process.exitCode=1;});
