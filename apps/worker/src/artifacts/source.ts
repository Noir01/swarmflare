import { ArtifactsSourceStore } from '../../../../packages/artifacts-source/index';

type Repo = { info(): Promise<{remote:string}>; createToken(scope:'read'|'write',ttl:number):Promise<{id:string;plaintext:string;expiresAt:string}>; revokeToken(id:string):Promise<boolean>; [Symbol.dispose]():void };
type ArtifactsEnv = { ARTIFACTS?: { get(name: string): Promise<Repo> }; ARTIFACTS_SOURCE_CONFIG?: string };

export function createArtifactsSourceStore(env:ArtifactsEnv,projectId:string):ArtifactsSourceStore {
  let config:unknown;
  try { config=JSON.parse(env.ARTIFACTS_SOURCE_CONFIG??'null'); } catch { throw new Error('ARTIFACTS_SOURCE_UNAVAILABLE'); }
  if(!config||typeof config!=='object')throw new Error('ARTIFACTS_SOURCE_UNAVAILABLE');
  const c=config as Record<string,unknown>;
  if(!env.ARTIFACTS||c.projectId!==projectId||typeof c.repository!=='string'||!c.repository||typeof c.remote!=='string'||c.allowWrites!==true)throw new Error('ARTIFACTS_SOURCE_UNAVAILABLE');
  const withRepo = async <T>(operation:(repo:Repo)=>Promise<T>):Promise<T> => {
    const repo = await env.ARTIFACTS!.get(c.repository as string);
    try { return await operation(repo); }
    finally { repo[Symbol.dispose](); }
  };
  return new ArtifactsSourceStore({repo:{info:()=>withRepo(repo=>repo.info()),createToken:(scope,ttl)=>withRepo(repo=>repo.createToken(scope,ttl)),revokeToken:id=>withRepo(repo=>repo.revokeToken(id))},remote:c.remote,allowWrites:true});
}
