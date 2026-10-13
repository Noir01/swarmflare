import { it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import worker from '../../apps/worker/src/index';

it('keeps feedback routes behind the existing Worker authentication boundary',async()=>{
 for(const path of ['/findings','/findings/00000000-0000-4000-8000-000000000000','/views/00000000-0000-4000-8000-000000000000/readiness','/views/00000000-0000-4000-8000-000000000000/reviews']){
  const response=await worker.fetch(new Request(`https://local/api/v1/projects/feedback-proj${path}`),{...env,AUTH_CREDENTIALS:'[]'});
  expect(response.status,path).toBe(401);
 }
});
