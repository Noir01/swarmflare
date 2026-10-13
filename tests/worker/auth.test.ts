import { it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import worker from '../../apps/worker/src/index';
const token='auth-test-token';
const hex=(b:ArrayBuffer)=>Array.from(new Uint8Array(b),x=>x.toString(16).padStart(2,'0')).join('');
async function credentials(expiresAt=Date.now()+60000){return JSON.stringify([{id:'user',projectId:'auth-test',role:'contributor',tokenHash:hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))),expiresAt}]);}
async function fetchWith(config:string|undefined,path='/api/v1/projects/auth-test/context',init:RequestInit={}){return worker.fetch(new Request(`https://local${path}`,init),{...env,AUTH_CREDENTIALS:config} as Env);}
it('rejects expired credentials and malformed credential configuration without leaking details',async()=>{
 const expired=await fetchWith(await credentials(Date.now()-1),undefined, {headers:{Authorization:`Bearer ${token}`}});expect(expired.status).toBe(401);await expired.text();
 const malformed=await fetchWith('{secretly malformed',undefined,{headers:{Authorization:`Bearer ${token}`}});expect(malformed.status).toBe(503);expect(await malformed.text()).not.toContain('secretly');
});
it('bounds streamed body and rejects unsupported routes and public health',async()=>{
 const config=await credentials();
 const oversized=await fetchWith(config,'/api/v1/projects/auth-test/claims',{method:'POST',headers:{Authorization:`Bearer ${token}`},body:'x'.repeat(65537)});expect(oversized.status).toBe(413);await oversized.text();
 const unknown=await fetchWith(config,'/api/v1/projects/auth-test/nope',{headers:{Authorization:`Bearer ${token}`}});expect(unknown.status).toBe(404);await unknown.text();
 const health=await fetchWith(config,'/health');expect(health.status).toBe(404);await health.text();
});
it('sanitizes malformed encoded project IDs and rejects noncanonical IDs',async()=>{
 const config=await credentials();
 const malformed=await fetchWith(config,'/api/v1/projects/%ZZ/context',{headers:{Authorization:'Bearer '+token}});
 expect(malformed.status).toBe(400);expect(await malformed.json()).toEqual({code:'INVALID_REQUEST',message:'Invalid project ID'});
 const encoded=await fetchWith(config,'/api/v1/projects/%61uth-test/context',{headers:{Authorization:'Bearer '+token}});
 expect(encoded.status).toBe(422);expect(await encoded.json()).toEqual({code:'INVALID_REQUEST',message:'Noncanonical project ID'});
});
it('fails closed on duplicate token hashes and scopes actor identity by project',async()=>{
 const tokenHash=hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)));
 const otherHash=hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('other-token')));
 const row=(id:string,projectId:string,role:'human'|'contributor',hash=tokenHash)=>({id,projectId,role,tokenHash:hash,expiresAt:Date.now()+60000});
 const duplicate=await fetchWith(JSON.stringify([row('human','auth-test','human'),row('contributor','auth-test','contributor')]),undefined,{headers:{Authorization:'Bearer '+token}});
 expect(duplicate.status).toBe(503);expect(await duplicate.json()).toEqual({code:'UNAVAILABLE',message:'Service unavailable'});
 const scoped=await fetchWith(JSON.stringify([row('same','auth-test','contributor'),row('same','other-project','contributor',otherHash)]),undefined,{headers:{Authorization:'Bearer '+token}});
 expect(scoped.status).toBe(200);await scoped.text();
});