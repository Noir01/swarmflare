import { lstat, readFile, writeFile } from 'node:fs/promises';
import { ORIGIN, validateFixture } from './foundation-smoke.js';
import { PROJECT_ID } from './native-checkout.js';

// Explicit operator-only synthetic fixture; never accepts human credentials.
async function secret(path:string){const s=await lstat(path);if(s.isSymbolicLink()||!s.isFile()||(s.mode&0o077)!==0)throw Error('PRIVATE_PERMISSIONS');return JSON.parse(await readFile(path,'utf8'));}
let calls=0;const deadline=Date.now()+60000;const results:any[]=[];
async function call(path:string,method='GET',body?:unknown,headers:Record<string,string>={},expected=200){if(++calls>20||Date.now()>deadline||!path.startsWith('/api/'))throw Error('BUDGET');const r=await fetch(ORIGIN+path,{method,redirect:'error',signal:AbortSignal.timeout(10000),headers:{origin:ORIGIN,'content-type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});results.push({path,method,status:r.status});if(r.status!==expected)throw Error('RENEW_REFUSED');return{data:await r.json() as any,response:r};}
async function main(){
 const originalPath='.local/cloud-cont40/platform-smoke-private.json',originalBytes=await readFile(originalPath),original=await secret(originalPath),repo=validateFixture(original.identity,JSON.parse(await readFile('reports/evaluation/continuous40-platform-smoke.json','utf8')));
 if(repo.projectId!==PROJECT_ID)throw Error('SCOPE_INVALID');const catalog=(await call('/api/platform/repos/'+repo.owner+'/'+repo.name)).data.repository;
 if(catalog.id!==repo.id||JSON.stringify(catalog.source)!==JSON.stringify(repo.source))throw Error('SOURCE_CHANGED');
 const states=[{path:'.local/cloud-cont47/candidate-private.json',field:'grant',role:'contributor'},{path:'.local/cloud-cont47/feedback-private.json',field:'reviewer',role:'reviewer'}];let cookie='',csrf='';const renewed:any[]=[];
 try{const login=await call('/api/platform/auth/login','POST',{login:original.identity.email,password:original.identity.password});cookie=login.response.headers.get('set-cookie')?.split(';')[0]??'';csrf=login.data.csrf;if(!cookie||!csrf||login.data.user?.username!==repo.owner)throw Error('SESSION_SCOPE');
 for(const entry of states){const state=await secret(entry.path),grant=state[entry.field];if(!grant||! /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(grant.id)||! /^[a-f0-9]{64}$/.test(grant.token))throw Error('GRANT_INVALID');
 const value=(await call('/api/platform/repos/'+repo.owner+'/'+repo.name+'/agents/'+grant.id+'/renew','POST',{expiresInSeconds:900},{cookie,'x-csrf-token':csrf})).data;
 if(value.grant?.id!==grant.id||value.grant.role!==entry.role||! /^[a-f0-9]{64}$/.test(value.token)||value.token===grant.token||value.grant.expiresAt<=Date.now()||value.grant.expiresAt>Date.now()+901000)throw Error('RENEW_SCOPE');
 state[entry.field]={id:grant.id,token:value.token,expiresAt:value.grant.expiresAt};await writeFile(entry.path,JSON.stringify(state),{mode:0o600});
 const session=(await call('/api/platform/agent/session','GET',undefined,{authorization:'Bearer '+value.token})).data;if(session.actor?.id!==grant.id||session.actor.role!==entry.role||session.actor.projectId!==PROJECT_ID||session.repository?.id!==repo.id)throw Error('RENEW_READBACK');
 await call('/api/platform/agent/session','GET',undefined,{authorization:'Bearer '+grant.token},401);renewed.push({id:grant.id,role:entry.role,actorPreserved:true,oldTokenRefused:true});
 }
 }finally{if(cookie){await call('/api/platform/auth/logout','POST',{}, {cookie,'x-csrf-token':csrf});if((await call('/api/platform/auth/session')).data.user!==null)throw Error('LOGOUT_FAILED');}}
 const actual=(await call('/api/platform/repos/'+repo.owner+'/'+repo.name)).data.repository;if(JSON.stringify(actual.source)!==JSON.stringify(repo.source)||!(await readFile(originalPath)).equals(originalBytes))throw Error('PRESERVATION_FAILED');
 await writeFile('reports/evaluation/continuous48-native-renewal.json',JSON.stringify({provenance:'Actual owner-authorized synthetic fixture grant rotation; same contributor/reviewer actor and scope, no human action.',projectId:PROJECT_ID,renewed,results,sourceUnchanged:true,originalPrivateFixtureUnchanged:true,acceptancePerformed:false},null,2));console.log(JSON.stringify({projectId:PROJECT_ID,renewed,sourceUnchanged:true}));
}
main().catch(()=>{console.error('NATIVE_RENEWAL_FAILED');process.exitCode=1;});
