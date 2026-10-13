import { it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';

const actor=(id:string,role:string)=>({id,projectId:'feedback-proj',role});
const req=(path:string,method='GET',body?:unknown,who=actor('alice','contributor'))=>new Request(`https://internal${path}`,{method,headers:{'x-actor':JSON.stringify(who),'x-project-id':'feedback-proj',...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
let name='';beforeEach(()=>{name=crypto.randomUUID();});const stub=()=>env.PROJECTS.get(env.PROJECTS.idFromName(name));
const envelope=(requestId:string,payload:unknown)=>({requestId,payload});

it('lists persisted feedback, exposes fail-closed readiness and denies runner-authored findings',async()=>{
 const s=stub();
 const before=await s.fetch(req('/findings'));expect(before.status).toBe(200);expect((await before.json() as any).resource).toEqual([]);
 const finding={viewId:'view',manifestDigest:'a'.repeat(64),composedCommitOid:'a'.repeat(40),treeOid:'b'.repeat(40),contractVersion:1,policyVersion:1,obligationIds:['o1'],affectedChangeIds:['change'],paths:['src/a.ts'],expected:'expected',observed:'observed',nextOwner:'alice'};
 const denied=await s.fetch(req('/findings','POST',envelope('runner-finding',finding),actor('runner','runner')));expect(denied.status).toBe(403);
 const missing=await s.fetch(req('/views/no-view/readiness'));expect(missing.status).toBe(404);
 const ctx=await s.fetch(req('/context'));expect((await ctx.json() as any).resource.findings).toEqual([]);
});

it('does not resolve a finding from a review or caller claim',async()=>{
 const s=stub();
 const contributor=await s.fetch(req('/findings/no-finding/resolve','POST',envelope('resolve-contributor',{viewId:'view',note:'review passed'})));
 expect(contributor.status).toBe(403);expect((await contributor.json() as any).code).toBe('FORBIDDEN');
 const reviewer=await s.fetch(req('/findings/no-finding/resolve','POST',envelope('resolve-reviewer',{viewId:'view',note:'review passed'}),actor('reviewer','reviewer')));
 expect(reviewer.status).toBe(404);expect((await reviewer.json() as any).code).toBe('NOT_FOUND');
});
