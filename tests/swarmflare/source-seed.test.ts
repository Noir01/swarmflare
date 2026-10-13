import { expect, it, vi } from 'vitest';
import { fetchSeedPack } from '../../apps/worker/src/platform/source-seed';

// Synthetic provider faults; no native/cloud token qualification.
const config={projectId:'project-1',repository:'sf-repo-1',remote:'https://fixture.artifacts.cloudflare.net/git/default/sf-repo-1.git',allowWrites:true as const};
it('revokes a malformed provider token by its actual value before failing closed',async()=>{
 const revokeToken=vi.fn(async()=>true),dispose=vi.fn();
 const binding={get:async()=>({info:async()=>({remote:config.remote}),createToken:async()=>({plaintext:'invalid-fixture-token',expiresAt:new Date().toISOString()}),revokeToken,[Symbol.dispose]:dispose})} as any;
 await expect(fetchSeedPack(binding,config,'project-1','a'.repeat(40),'b'.repeat(40))).rejects.toThrow('SOURCE_UNAVAILABLE');
 expect(revokeToken).toHaveBeenCalledWith('invalid-fixture-token');expect(dispose).toHaveBeenCalledOnce();
});
it('reports cleanup failure rather than returning a pack after refused revocation',async()=>{
 const binding={get:async()=>({info:async()=>({remote:config.remote}),createToken:async()=>({plaintext:'invalid-fixture-token',expiresAt:new Date().toISOString()}),revokeToken:async()=>false,[Symbol.dispose](){}})} as any;
 await expect(fetchSeedPack(binding,config,'project-1','a'.repeat(40),'b'.repeat(40))).rejects.toThrow('SOURCE_TOKEN_CLEANUP_FAILED');
});
