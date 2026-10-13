import { it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import worker from '../../apps/worker/src/index';

const project='dash-test', token='synthetic-human-token', key='a'.repeat(64);
const hash=async(s:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))),b=>b.toString(16).padStart(2,'0')).join('');
async function bindings(role='human',projectId=project,keyValue:string|undefined=key){return {...env,AUTH_CREDENTIALS:JSON.stringify([{id:'human1',projectId,role,tokenHash:await hash(token),expiresAt:Date.now()+60000}]),DASHBOARD_SESSION_KEY:keyValue} as Env;}
function req(path:string,method='GET',headers:Record<string,string>={},body?:string){return new Request('https://local'+path,{method,headers,body});}
async function login(b:Env){return worker.fetch(req('/dashboard/session','POST',{Origin:'https://local','Content-Type':'application/json'},JSON.stringify({projectId:project,token})),b);}
it('issues an encrypted HttpOnly strict cookie without returning the bearer; rejects tampering and missing key',async()=>{
 const b=await bindings(),response=await login(b),cookie=response.headers.get('set-cookie')!;
 expect(response.status).toBe(200);expect(cookie).toContain('HttpOnly');expect(cookie).toContain('Secure');expect(cookie).toContain('SameSite=Strict');expect(cookie).toContain('Path=/');
 expect(JSON.stringify(await response.json())).not.toContain(token);
 const value=cookie.split(';')[0]!,tampered=value.slice(0,-1)+(value.endsWith('a')?'b':'a');
 expect((await worker.fetch(req('/dashboard/session','GET',{Cookie:tampered}),b)).status).toBe(401);
 expect((await login(await bindings('human',project,''))).status).toBe(503);
 expect((await login(await bindings('human',project,'A'.repeat(64)))).status).toBe(503);
});
it('requires human role, project match, same origin and CSRF before proxy mutations',async()=>{
 expect((await login(await bindings('contributor'))).status).toBe(403);
 expect((await login(await bindings('human','other-project'))).status).toBe(403);
 expect((await worker.fetch(req('/dashboard/session','POST',{Origin:'https://attacker.invalid','Content-Type':'application/json'},JSON.stringify({projectId:project,token})),await bindings())).status).toBe(403);
 const response=await login(await bindings()),cookie=response.headers.get('set-cookie')!.split(';')[0]!,meta=await response.json() as {csrf:string};
 const noCsrf=await worker.fetch(req('/dashboard/api/claims','POST',{Cookie:cookie,'Content-Type':'application/json',Origin:'https://local'},'{}'),await bindings());expect([noCsrf.status]).toContain(403);
 const wrongOrigin=await worker.fetch(req('/dashboard/api/claims','POST',{Cookie:cookie,'Content-Type':'application/json',Origin:'https://evil.invalid','X-CSRF-Token':meta.csrf},'{}'),await bindings());expect(wrongOrigin.status).toBe(403);
});
it('rejects cross-project and encoded traversal proxy requests',async()=>{
 const b=await bindings(),response=await login(b),cookie=response.headers.get('set-cookie')!.split(';')[0]!;
 expect((await worker.fetch(req('/dashboard/api/projects/other/context','GET',{Cookie:cookie}),b)).status).toBe(404);
 expect((await worker.fetch(req('/dashboard/api/%2e%2e/context','GET',{Cookie:cookie}),b)).status).not.toBe(200);
});
it('rejects malformed credential configuration and strict login shapes',async()=>{
 const b=await bindings();
 expect((await login({...b,AUTH_CREDENTIALS:'[]'} as Env)).status).toBe(401);
 expect((await worker.fetch(req('/dashboard/session','POST',{Origin:'https://local','Content-Type':'application/json'},JSON.stringify({projectId:project,token,extra:true})),b)).status).toBe(400);
 expect((await worker.fetch(req('/dashboard/session','POST',{Origin:'https://local','Content-Type':'application/json'},JSON.stringify({projectId:project,token})),{...b,AUTH_CREDENTIALS:'bad'} as Env)).status).toBe(401);
 const duplicate=JSON.stringify([{id:'human1',projectId:project,role:'human',tokenHash:await hash(token),expiresAt:Date.now()+60000},{id:'human1',projectId:project,role:'human',tokenHash:await hash('other'),expiresAt:Date.now()+60000}]);
 expect((await worker.fetch(req('/dashboard/session','POST',{Origin:'https://local','Content-Type':'application/json'},JSON.stringify({projectId:project,token})),{...b,AUTH_CREDENTIALS:duplicate} as Env)).status).toBe(401);
 expect((await worker.fetch(req('/dashboard','POST'),b)).status).toBe(405);
});
it('persists sessions, revokes on logout, and blocks cookie replay',async()=>{
 const b=await bindings(),response=await login(b),cookie=response.headers.get('set-cookie')!.split(';')[0]!,meta=await response.json() as {csrf:string};
 const before=await (await worker.fetch(req('/dashboard/api/context','GET',{Cookie:cookie}),b)).json() as {sequence:number};
 expect((await worker.fetch(req('/dashboard/session','GET',{Cookie:cookie}),b)).status).toBe(200);
 const after=await (await worker.fetch(req('/dashboard/api/context','GET',{Cookie:cookie}),b)).json() as {sequence:number};expect(after.sequence).toBe(before.sequence);
 const logout=await worker.fetch(req('/dashboard/logout','POST',{Cookie:cookie,Origin:'https://local','X-CSRF-Token':meta.csrf}),b);
 expect(logout.status).toBe(200);
 expect((await worker.fetch(req('/dashboard/session','GET',{Cookie:cookie}),b)).status).toBe(401);
});
it('rechecks credential expiry and revocation and allows safe decision reads',async()=>{
 const b=await bindings(),response=await login(b),cookie=response.headers.get('set-cookie')!.split(';')[0]!;
 expect((await worker.fetch(req('/dashboard/api/context','GET',{Cookie:cookie}),b)).status).toBe(200);
 expect((await worker.fetch(req('/dashboard/api/decisions/example','GET',{Cookie:cookie}),b)).status).toBe(404);
 const expired={...b,AUTH_CREDENTIALS:JSON.stringify([{id:'human1',projectId:project,role:'human',tokenHash:await hash(token),expiresAt:Date.now()-1}])} as Env;
 expect((await worker.fetch(req('/dashboard/session','GET',{Cookie:cookie}),expired)).status).toBe(401);
 expect((await worker.fetch(req('/dashboard/api/context','GET',{Cookie:cookie}),{...b,AUTH_CREDENTIALS:'[]'} as Env)).status).toBe(401);
});
it('keeps session CRUD internal to the trusted dashboard worker',async()=>{
 const b=await bindings(),raw=await worker.fetch(req(`/api/v1/projects/${project}/internal/dashboard-sessions`,'POST',{Authorization:`Bearer ${token}`,'x-dashboard-action':'create','x-dashboard-session':JSON.stringify({sessionIdHash:'a'.repeat(64),expiresAt:Date.now()+60000})}),b);
 expect(raw.status).toBe(404);
 const response=await login(b),cookie=response.headers.get('set-cookie')!.split(';')[0]!,meta=await response.json() as {csrf:string};
 const proxy=await worker.fetch(req('/dashboard/api/internal/dashboard-sessions','POST',{Cookie:cookie,Origin:'https://local','X-CSRF-Token':meta.csrf,'Content-Type':'application/json','x-dashboard-action':'create','x-dashboard-session':JSON.stringify({sessionIdHash:'b'.repeat(64),expiresAt:Date.now()+60000})},'{}'),b);
 expect(proxy.status).toBe(404);
 expect((await worker.fetch(req('/dashboard/session','GET',{Cookie:cookie}),b)).status).toBe(200);
 const logout=await worker.fetch(req('/dashboard/logout','POST',{Cookie:cookie,Origin:'https://local','X-CSRF-Token':meta.csrf}),b);
 expect(logout.status).toBe(200);
});