import { expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import worker from '../../apps/worker/src/index';

import { acceptanceFixture } from './acceptance-fixture';

const dashboardToken=(projectId:string)=>`synthetic-preview-human-token-${projectId}`;
const hash=async(s:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))),b=>b.toString(16).padStart(2,'0')).join('');
const dashboardRequest=(path:string,headers:Record<string,string>={})=>new Request(`https://local${path}`,{headers});
async function dashboardBindings(projectId:string,extraProjects:string[]=[]){return {...env,AUTH_CREDENTIALS:JSON.stringify(await Promise.all([projectId,...extraProjects].map(async (id,i)=>({id:`preview-human-${i}`,projectId:id,role:'human',tokenHash:await hash(dashboardToken(id)),expiresAt:Date.now()+600_000})))),DASHBOARD_SESSION_KEY:'a'.repeat(64)} as Env;}
async function dashboardLogin(bindings:Env,projectId:string){const response=await worker.fetch(new Request('https://local/dashboard/session',{method:'POST',headers:{Origin:'https://local','Content-Type':'application/json'},body:JSON.stringify({projectId,token:dashboardToken(projectId)})}),bindings);const setCookie=response.headers.get('set-cookie');return {response,cookie:setCookie?.split(';')[0]??''};}

it('discovers Views newest-first with bounded limits and keeps artifact recording runner-only, exact and idempotent', async () => {
  const f=await acceptanceFixture();
  expect((await f.request('human','/views?limit=1')).body.resource).toEqual([f.view]);
  expect((await f.request('human','/views?limit=101')).status).toBe(422);
  const payload={applicability:f.applicability,baseline:{version:1,commitOid:f.baseline.commitOid,treeOid:f.baseline.treeOid},diff:{patch:'diff --git a/x b/x',files:['x'],truncated:false},preview:{supported:'project-list-demo-v1' as const,html:'<h1>offline</h1>',expiresAt:Date.now()+60_000}};
  const path=`/runner/views/${f.view.id}/review-artifacts`;
  expect((await f.request('alice',path,payload)).status).toBe(403);
  expect((await f.request('runner',path,{...payload,applicability:{...payload.applicability,projectId:'other'}})).status).toBe(422);
  expect((await f.request('runner',path,{...payload,baseline:{...payload.baseline,version:2}})).status).toBe(422);
  expect((await f.request('runner',path,{...payload,preview:{...payload.preview,expiresAt:Date.now()+121_000}})).status).toBe(422);
  const first=await f.request('runner',path,payload,undefined,'artifact-once');
  expect(first.status).toBe(201);
  expect(await f.request('runner',path,payload,undefined,'artifact-once')).toEqual(first);
  expect((await f.request('human',`/views/${f.view.id}/review-artifact`)).body.resource).toEqual(first.body.resource);
  expect((await f.request('runner',path,{...payload,diff:{...payload.diff,patch:'altered'}},undefined,'artifact-once')).status).toBe(409);
});

it('rejects oversized JSON and returns null after baseline advances',async()=>{
  const f=await acceptanceFixture();
  const payload={applicability:f.applicability,baseline:{version:1,commitOid:f.baseline.commitOid,treeOid:f.baseline.treeOid},diff:{patch:'x'.repeat(16001),files:[],truncated:false},preview:null};
  expect((await f.request('runner',`/runner/views/${f.view.id}/review-artifacts`,payload)).status).toBe(422);
  const valid={...payload,diff:{patch:'',files:[],truncated:false}};
  expect((await f.request('runner',`/runner/views/${f.view.id}/review-artifacts`,valid)).status).toBe(201);
  const confirmation=await f.confirm();
  const accepted=await f.ok('human','/acceptances',f.acceptInput(confirmation));
  expect(accepted.data.newBaseline.version).toBe(2);
  // Acceptance changes the current baseline; artifact reads fail closed.
  // Artifact review resource is retained historically but no longer applicable.
  expect((await f.request('human',`/views/${f.view.id}/review-artifact`)).body.resource).toBeNull();
});

it('serves only the authenticated project preview with an isolated CSP, and refuses unauthenticated or other-project reads',async()=>{
  const f=await acceptanceFixture(),expiresAt=Date.now()+60_000,html='<!doctype html><h1>synthetic preview exact body</h1>';
  const payload={applicability:f.applicability,baseline:{version:1,commitOid:f.baseline.commitOid,treeOid:f.baseline.treeOid},diff:{patch:'',files:[],truncated:false},preview:{supported:'project-list-demo-v1' as const,html,expiresAt}};
  expect((await f.request('runner',`/runner/views/${f.view.id}/review-artifacts`,payload,undefined,'preview-first')).status).toBe(201);
  const bindings=await dashboardBindings(f.projectId,['another-project']),{response:login,cookie}=await dashboardLogin(bindings,f.projectId);
  expect(login.status,await login.clone().text()).toBe(200);
  const path=`/dashboard/preview/${f.view.id}`;
  expect((await worker.fetch(dashboardRequest(path),bindings)).status).toBe(401);
  const preview=await worker.fetch(dashboardRequest(path,{Cookie:cookie}),bindings);
  expect(preview.status).toBe(200);expect(await preview.text()).toBe(html);
  const csp=preview.headers.get('content-security-policy')!;
  expect(csp).toContain('sandbox allow-scripts');expect(csp).not.toContain('allow-same-origin');expect(csp).toContain("connect-src 'none'");
  const other=await dashboardLogin(bindings,'another-project');
  expect(other.response.status).toBe(200);
  expect((await worker.fetch(dashboardRequest(path,{Cookie:other.cookie}),bindings)).status).toBe(404);
});

it('refreshes an artifact under a new request ID, refuses stale applicability, and retains expired diff while refusing its preview',async()=>{
  const f=await acceptanceFixture(),path=`/runner/views/${f.view.id}/review-artifacts`,baseline={version:1,commitOid:f.baseline.commitOid,treeOid:f.baseline.treeOid};
  const makePayload=(html:string,expiresAt:number,applicability=f.applicability)=>({applicability,baseline,diff:{patch:'',files:[],truncated:false},preview:{supported:'project-list-demo-v1' as const,html,expiresAt}});
  const first=await f.request('runner',path,makePayload('<h1>old</h1>',Date.now()+60_000),undefined,'preview-build-one');expect(first.status).toBe(201);
  const refreshed=await f.request('runner',path,makePayload('<h1>refreshed</h1>',Date.now()+90_000),undefined,'preview-build-two');expect(refreshed.status).toBe(201);
  expect(refreshed.body.resource.version).toBe(first.body.resource.version+1);
  expect(refreshed.body.resource.data.preview.html).toBe('<h1>refreshed</h1>');
  expect((await f.request('human',`/views/${f.view.id}/review-artifact`)).body.resource).toEqual(refreshed.body.resource);
  expect((await f.request('runner',path,makePayload('<h1>stale</h1>',Date.now()+60_000,{...f.applicability,manifestDigest:'0'.repeat(64)}),undefined,'preview-stale-applicability')).status).toBe(422);
  expect((await f.request('human',`/views/${f.view.id}/review-artifact`)).body.resource).toEqual(refreshed.body.resource);
  const expiring=await f.request('runner',path,makePayload('<h1>expired</h1>',Date.now()+3_000),undefined,'preview-expiring');expect(expiring.status,JSON.stringify(expiring.body)).toBe(201);
  const readable=await f.request('human',`/views/${f.view.id}/review-artifact`);
  expect(readable.body.resource.data.diff.patch).toBe('');
  // workerd's cached clock need not advance with a Node-side sleep. Make
  // only this emulator artifact expired, as in the acceptance clock fixtures.
  const stub=env.PROJECTS.get(env.PROJECTS.idFromName(f.projectId));
  await runInDurableObject(stub,async (_instance,state)=>{
    const row=state.storage.sql.exec<{id:string,data:string}>('SELECT id,data FROM resources WHERE id=?',expiring.body.resource.id).one();
    const data=JSON.parse(row.data);data.preview.expiresAt=Date.now()-1;
    state.storage.sql.exec('UPDATE resources SET data=? WHERE id=?',JSON.stringify(data),row.id);
  });
  const bindings=await dashboardBindings(f.projectId),{cookie}=await dashboardLogin(bindings,f.projectId);
  expect((await worker.fetch(dashboardRequest(`/dashboard/preview/${f.view.id}`,{Cookie:cookie}),bindings)).status).toBe(404);
});