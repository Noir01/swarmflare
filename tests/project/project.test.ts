import { it, expect, beforeEach } from 'vitest';
import { env, evictDurableObject } from 'cloudflare:test';

const actor = (id: string, role = 'contributor') => ({ id, projectId: 'proj', role });
const request = (path: string, method = 'GET', body?: unknown, who = actor('alice')) => new Request(`https://internal${path}`, { method, headers: { 'x-actor': JSON.stringify(who), 'x-project-id': 'proj', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
let projectName = '';
beforeEach(() => { projectName = crypto.randomUUID(); });
const stub = () => env.PROJECTS.get(env.PROJECTS.idFromName(projectName));
const envelope = (requestId: string, payload: unknown, expectedVersion?: number) => ({ requestId, ...(expectedVersion === undefined ? {} : { expectedVersion }), payload });
const contract = { outcome:'Deliver safely', constraints:[], obligations:[{id:'o1',description:'Keep state',acceptanceExamples:[]}], requiredCheckIds:['check'], unresolvedQuestions:[] };

it('approves proposals as immutable contract versions with CAS', async () => {
 const s=stub(); const created=await s.fetch(request('/contracts/proposals','POST',envelope('p1',contract))); expect(created.status).toBe(201); const {resource}=await created.json() as any;
 const denied=await s.fetch(request(`/contracts/${resource.id}/approve`,'POST',envelope('a1',{},0),actor('agent'))); await denied.text(); expect(denied.status).toBe(403);
 const approved=await s.fetch(request(`/contracts/${resource.id}/approve`,'POST',envelope('a2',{},0),actor('human','human'))); expect(approved.status).toBe(201); const body=await approved.json() as any; expect(body.resource.version).toBe(1);
 const context=await (await s.fetch(request('/context'))).json() as any; expect(context.resource.contract).toEqual(body.resource); expect(context.resource.baseline).toBeNull(); expect(Object.keys(context.resource).sort()).toEqual(['baseline','claims','contract','decisions','findings','nextCursor'].sort());
});

it('scopes actors, idempotency preconditions, and returns frozen event envelope', async () => {
 const s=stub();
 const forbidden=await s.fetch(request('/claims','POST',envelope('forbidden',{obligationIds:['o1'],areas:['api']}),{id:'outsider',projectId:'elsewhere',role:'contributor'})); await forbidden.text(); expect(forbidden.status).toBe(403);
 const payload={obligationIds:['o1'],areas:['api']}; const [a,b]=await Promise.all([s.fetch(request('/claims','POST',envelope('c2',payload))),s.fetch(request('/claims','POST',envelope('c3',payload),actor('bob')))]);
 expect([a.status,b.status]).toEqual([201,201]); const aBody=await a.json() as any; const bBody=await b.json() as any;
 const dup=await s.fetch(request('/claims','POST',envelope('c2',payload))); expect(dup.status).toBe(201); await dup.text();
 const mismatch=await s.fetch(request('/claims','POST',envelope('c2',{...payload,areas:['ui']}))); expect(mismatch.status).toBe(409); await mismatch.text();
 const casMismatch=await s.fetch(request('/claims','POST',envelope('c2',payload,1))); expect(casMismatch.status).toBe(409); await casMismatch.text();
 const eventsResponse=await s.fetch(request('/events?limit=100')); const events=await eventsResponse.json() as any; expect(events.resource.events.length).toBeGreaterThanOrEqual(2); expect(events.resource.events[0].sequence).toBeLessThan(events.resource.events.at(-1).sequence); expect(events.resource.nextCursor).toBeNull();
 const read=await s.fetch(request('/context')); expect(read.headers.get('etag')).toBeTruthy(); await read.text();
 expect(aBody.resource.id).not.toBe(bBody.resource.id);
});

it('keeps acceptance unavailable to agents and fail-closed for humans', async () => {
 const s=stub(), body={requestId:'accept',payload:{}};
 const agent=await s.fetch(request('/acceptances','POST',body,actor('agent')));
 await agent.text(); expect(agent.status).toBe(403);
 const human=await s.fetch(request('/acceptances','POST',body,actor('human','human')));
 expect(human.status).toBe(409);
 expect((await human.json() as any).code).toBe('EVIDENCE_MISSING');
});

it('persists events across isolated Durable Object eviction', async () => {
 const s=stub();
 const created=await s.fetch(request('/claims','POST',envelope('eviction-claim',{obligationIds:['o1'],areas:['api']})));
 await created.text();
 const before=await s.fetch(request('/events?limit=100'));
 const beforeBody=await before.json() as any;
 await evictDurableObject(s);
 const after=await s.fetch(request('/events?limit=100'));
 const afterBody=await after.json() as any;
 expect(afterBody.resource.events).toEqual(beforeBody.resource.events);
}, 30000);

it('approves a contract only against the exact current version and keeps versions immutable', async () => {
 const s=stub();
 const proposal=async (requestId:string,outcome:string)=>{const r=await s.fetch(request('/contracts/proposals','POST',envelope(requestId,{...contract,outcome})));return (await r.json() as any).resource;};
 const p1=await proposal('cas-p1','first');
 const before=await (await s.fetch(request('/context'))).json() as any;
 const currentVersion=before.resource.contract?.version??0;
 const [left,right]=await Promise.all([
  s.fetch(request(`/contracts/${p1.id}/approve`,'POST',envelope('cas-a1',{},currentVersion),actor('human','human'))),
  s.fetch(request(`/contracts/${p1.id}/approve`,'POST',envelope('cas-a2',{},currentVersion),actor('human2','human')))
 ]);
 expect([left.status,right.status].sort()).toEqual([201,409]);
 await Promise.all([left.clone().text(),right.clone().text()]);
 const success=left.status===201?left:right;
 const approved=await success.json() as any;
 expect(approved.resource.data).toEqual({...contract,outcome:'first'});
 const p2=await proposal('cas-p2','second');
 const next=await s.fetch(request(`/contracts/${p2.id}/approve`,'POST',envelope('cas-a3',{},currentVersion+1),actor('human','human')));
 expect(next.status).toBe(201);
 const nextBody=await next.json() as any;
 expect(nextBody.resource.data).toEqual({...contract,outcome:'second'});
 const latest=await (await s.fetch(request('/context'))).json() as any;
 expect(latest.resource.contract).toEqual(nextBody.resource);
 const missing=await s.fetch(request(`/contracts/${p2.id}/approve`,'POST',envelope('cas-missing',{},undefined),actor('human','human')));
 await missing.text(); expect(missing.status).toBe(409);
 const stale=await s.fetch(request(`/contracts/${p2.id}/approve`,'POST',envelope('cas-stale',{},currentVersion),actor('human','human')));
 await stale.text(); expect(stale.status).toBe(409);
 const old=await s.fetch(request('/contracts/1'));
 expect((await old.json() as any).resource.data).toEqual({...contract,outcome:'first'});
 const invalid=await s.fetch(request('/contracts/proposals','POST',envelope('proposal-extra',{...contract,status:'proposed'})));
 await invalid.text(); expect(invalid.status).toBe(422);
});

it('binds idempotency to target identity and does not cache failed mutations', async () => {
 const s=stub(), payload={obligationIds:['o1'],areas:['api']};
 const startEvents=(await (await s.fetch(request('/events'))).json() as any).resource.events.length;
 const first=await s.fetch(request('/claims','POST',envelope('target-key',payload)));
 const firstBody=await first.json() as any;
 const second=await s.fetch(request('/claims','POST',envelope('other-claim',payload)));
 const secondBody=await second.json() as any;
 const firstUpdate=await s.fetch(request(`/claims/${firstBody.resource.id}`,'PATCH',envelope('shared-target-key',{status:'ready'})));
 const firstUpdateBody=await firstUpdate.json() as any;
 const collision=await s.fetch(request(`/claims/${secondBody.resource.id}`,'PATCH',envelope('shared-target-key',{status:'ready'})));
 await collision.text();
 expect(collision.status).toBe(409);
 const missing=await s.fetch(request('/claims/not-a-claim/overlap-ack','POST',envelope('bad-target',{otherClaimId:'other',resolution:'coordinate'})));
 await missing.text();
 expect(missing.status).toBe(404);
 const events=await (await s.fetch(request('/events'))).json() as any;
 expect(events.resource.events).toHaveLength(startEvents+3);
 const replay=await s.fetch(request(`/claims/${firstBody.resource.id}`,'PATCH',envelope('shared-target-key',{status:'ready'})));
 expect(await replay.json()).toEqual(firstUpdateBody);
});

it('invalidates prior agreement when a participant changes their response', async () => {
 const s=stub();
 const created=await s.fetch(request('/decisions','POST',envelope('decision-create',{question:'Use API?',obligationIds:['o1'],participants:['alice'],material:false})));
 const decision=(await created.json() as any).resource;
 const response=await s.fetch(request(`/decisions/${decision.id}/responses`,'POST',envelope('decision-response',{body:'yes',acknowledge:true})));
 const responseBody=await response.json() as any;
 const agreed=await s.fetch(request(`/decisions/${decision.id}/agree`,'POST',envelope('decision-agree',{})));
 expect((await agreed.json() as any).resource.data.status).toBe('agreed');
 const changed=await s.fetch(request(`/decisions/${decision.id}/responses`,'POST',envelope('decision-response-change',{body:'no',acknowledge:true})));
 const changedBody=await changed.json() as any;
 expect(changedBody.resource.data.status).toBe('open');
 expect(changedBody.resource.data.agreements).toEqual([]);
 expect(responseBody.resource.data.responses[0].body).toBe('yes');
});

it('requires a distinct existing claim in a shared area for overlap acknowledgement', async () => {
 const s=stub(), payload={obligationIds:['o1'],areas:['api']};
 const created=await s.fetch(request('/claims','POST',envelope('overlap-claim',payload)));
 const claimId=(await created.json() as any).resource.id;
 const nonexistent=await s.fetch(request(`/claims/${claimId}/overlap-ack`,'POST',envelope('overlap-missing',{otherClaimId:'missing',resolution:'coordinate'})));
 await nonexistent.text(); expect(nonexistent.status).toBe(404);
 const self=await s.fetch(request(`/claims/${claimId}/overlap-ack`,'POST',envelope('overlap-self',{otherClaimId:claimId,resolution:'coordinate'})));
 await self.text(); expect(self.status).toBe(422);
 const other=await s.fetch(request('/claims','POST',envelope('overlap-other',payload),actor('bob')));
 const otherBody=await other.json() as any;
 const otherId=otherBody.resource.id;
 const ack=await s.fetch(request(`/claims/${claimId}/overlap-ack`,'POST',envelope('overlap-valid',{otherClaimId:otherId,resolution:'coordinate'})));
 expect(ack.status).toBe(201);
 await ack.text();
});

it('supports exact context ETags and rejects non-decimal event cursors', async () => {
 const s=stub(), initial=await s.fetch(request('/context'));
 const tag=initial.headers.get('etag'); await initial.text();
 const conditional=await s.fetch(new Request('https://internal/context',{headers:{'x-actor':JSON.stringify(actor('alice')),'x-project-id':'proj','if-none-match':tag!}}));
 expect(conditional.status).toBe(304); await conditional.text();
 for (const cursor of ['-1','1.5','1e2','abc','']) {
  const response=await s.fetch(request(`/events?cursor=${encodeURIComponent(cursor)}`));
  await response.text(); expect(response.status).toBe(422);
 }
});
