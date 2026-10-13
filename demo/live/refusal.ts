import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { WorkspaceClient } from '../../packages/client/index.js';
import { validateBaseUrl } from './actor.js';

const within = (root:string,path:string) => { const r=relative(root,path); return r===''||(!r.startsWith(`..${process.platform==='win32'?'\\':'/'}`)&&r!=='..'&&!isAbsolute(r)); };
const client=(c:{baseUrl:string;projectId:string;token:string})=>new WorkspaceClient({baseUrl:validateBaseUrl(c.baseUrl),projectId:c.projectId,token:c.token,maxRequests:30,deadline:30_000});

async function collectEvents(api:WorkspaceClient):Promise<{events:any[];cursor:number}> {
 const events:any[]=[]; let cursor=0;
 for await (const page of api.eventPages({limit:100,maxPages:100})) {
  for(const event of page as any[]) if(typeof event.sequence==='number') { events.push(event); cursor=Math.max(cursor,event.sequence); }
 }
 return {events,cursor};
}

export async function runRefusalProbe(rootArg:string,viewId:string,outputArg:string) {
 const root=await realpath(resolve(rootArg)); const output=resolve(outputArg);
 if(!within(root,output)||output===root) throw new Error('OUTPUT must be a file within ROOT');
 const rootInfo=await stat(root);if(!rootInfo.isDirectory())throw new Error('ROOT must be a directory');
 if(!/^[A-Za-z0-9_-]{1,120}$/.test(viewId))throw new Error('VIEWID must be a valid ID');
 const config=JSON.parse(await readFile(resolve(root,'actors/api.json'),'utf8')) as {baseUrl:string;projectId:string;token:string};
 const api=client(config);
 const [view,baseline,readiness,eventSnapshotBefore]=await Promise.all([api.view(viewId),api.baseline(),api.readiness(viewId),collectEvents(api)]);
 if(!baseline) throw new Error('actual baseline is missing');
 if(!readiness.applicability||readiness.sequence===undefined)throw new Error('readiness has no exact applicability/sequence for schema-valid authorization probe');
 const payload={applicability:readiness.applicability,expectedBaselineVersion:baseline.version,expectedBaselineCommitOid:baseline.commitOid,readinessSequence:readiness.sequence,confirm:true as const};
 const capture=async(fn:()=>Promise<unknown>)=>{try{await fn();return {status:null,code:'UNEXPECTED_SUCCESS'};}catch(e){const x=e as {status?:unknown;code?:unknown};return {status:typeof x.status==='number'?x.status:null,code:typeof x.code==='string'?x.code:'UNKNOWN'};}};
 const confirmation=await capture(()=>api.confirmView(viewId,{requestId:`unauth-confirm-${Date.now()}`,payload}));
 const acceptance=await capture(()=>api.acceptView({requestId:`unauth-accept-${Date.now()}`,payload:{confirmationId:'synthetic-forbidden-probe',applicability:readiness.applicability!,expectedBaselineVersion:baseline.version,expectedBaselineCommitOid:baseline.commitOid,readinessSequence:readiness.sequence!}}));
 const [baselineAfter,eventSnapshotAfter,viewAfter]=await Promise.all([api.baseline(),collectEvents(api),api.view(viewId)]);
 const eventDelta=eventSnapshotAfter.events.filter((e:any)=>typeof e.sequence==='number'&&e.sequence>eventSnapshotBefore.cursor);
 const result={kind:'unauthorized-contributor-refusal-probe',authorization:'NOT authorized human refusal or acceptance; no human credential used',viewId,viewStatus:view.data.status,readiness:{ready:readiness.ready,sequence:readiness.sequence??null,hasApplicability:!!readiness.applicability},attempts:{confirm:confirmation,accept:acceptance},verified:{bothServerForbidden:confirmation.status===403&&confirmation.code==='FORBIDDEN'&&acceptance.status===403&&acceptance.code==='FORBIDDEN',baselineUnchanged:JSON.stringify(baselineAfter)===JSON.stringify(baseline),viewUnchanged:JSON.stringify(viewAfter)===JSON.stringify(view),noAcceptanceEvents:!eventDelta.some((e:any)=>String(e.action??'').startsWith('acceptance.'))},baseline:{beforeVersion:baseline.version,afterVersion:baselineAfter?.version??null},acceptanceEventDeltaCount:eventDelta.filter((e:any)=>String(e.action??'').startsWith('acceptance.')).length};
 await writeFile(output,JSON.stringify(result,null,2)+'\n',{mode:0o600});return result;
}

async function main(){const args=process.argv.slice(2);if(args.length!==3)throw new Error('usage: refusal.ts ROOT VIEWID OUTPUT');const result=await runRefusalProbe(args[0]!,args[1]!,args[2]!);process.stdout.write(JSON.stringify(result)+'\n');if(!result.verified.bothServerForbidden||!result.verified.baselineUnchanged||!result.verified.viewUnchanged||!result.verified.noAcceptanceEvents)process.exitCode=2;}
if(process.argv[1]&&resolve(process.argv[1])===resolve(new URL(import.meta.url).pathname))main().catch(e=>{process.stderr.write(JSON.stringify({error:e instanceof Error?e.message:'refusal probe failed'})+'\n');process.exitCode=1;});
