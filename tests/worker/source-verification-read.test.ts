import { expect, it } from 'vitest';
import { acceptanceFixture } from './acceptance-fixture';
import worker from '../../apps/worker/src/index';


it('reads absent, present, and updated source verification without mutating sequence', async () => {
 const f=await acceptanceFixture();
 const read=()=>f.ok('human',`/views/${f.view.id}/source-verification`);
 const before=(await f.request('human','/events')).body;
 expect(await read()).toBeNull();
 expect((await f.request('human','/events')).body).toMatchObject({sequence:before.sequence});
 const first=await f.verify();
 expect(await read()).toEqual(first);
 const second=await f.verify();
 expect(second.id).toBe(first.id);
 expect(second.version).toBe(first.version+1);
 expect(second.data.verifiedAt).toBeGreaterThanOrEqual(first.data.verifiedAt);
 expect(await read()).toEqual(second);
 const events=(await f.request('human','/events')).body;
 expect(events.sequence).toBeGreaterThan(before.sequence);
 const afterRead=(await f.request('human','/events')).body;
 expect(afterRead).toEqual(events);
});

it('requires authentication and same-project membership', async () => {
 const f=await acceptanceFixture(),path=`https://local/api/v1/projects/${f.projectId}/views/${f.view.id}/source-verification`;
 const unauthorized=await worker.fetch(new Request(path),{...({} as Env),AUTH_CREDENTIALS:'[]'});
 expect(unauthorized.status).toBe(401);
 const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('fixture-only-human'))),b=>b.toString(16).padStart(2,'0')).join('');
 const cross=await worker.fetch(new Request(`https://local/api/v1/projects/other-project/views/${f.view.id}/source-verification`,{headers:{authorization:'Bearer fixture-only-human'}}),{...({} as Env),AUTH_CREDENTIALS:JSON.stringify([{id:'human',role:'human',projectId:f.projectId,expiresAt:Date.now()+600_000,tokenHash:hash}])});
 expect(cross.status).toBe(403);
});

it('returns 404 for an unknown View', async () => {
 const f=await acceptanceFixture();
 expect((await f.request('human','/views/unknown-view/source-verification')).status).toBe(404);
});
