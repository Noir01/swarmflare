import { ArtifactsSourceStore } from '../../../../packages/artifacts-source/index';

type Repo = { info(): Promise<{remote:string}>; createToken(scope:'read'|'write',ttl:number):Promise<{id:string;plaintext:string;expiresAt:string}>; revokeToken(id:string):Promise<boolean>; [Symbol.dispose]():void };
type ArtifactsEnv = { ARTIFACTS?: { get(name: string): Promise<Repo> }; ARTIFACTS_SOURCE_CONFIG?: string; PLATFORM?: { idFromName(name: string): unknown; get(id: unknown): { fetch(input: string, init: RequestInit): Promise<Response> } } };

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

export async function resolveArtifactsSourceStore(env:ArtifactsEnv,projectId:string):Promise<ArtifactsSourceStore> {
  if (!env.PLATFORM) return createArtifactsSourceStore(env,projectId);
  let response:Response;
  try { const id=env.PLATFORM.idFromName('swarmflare-platform-v1'); response=await env.PLATFORM.get(id).fetch('https://platform.internal/api/platform/internal/source-config',{method:'POST',headers:{'content-type':'application/json','x-swarmflare-internal':'project-worker'},body:JSON.stringify({projectId})}); }
  catch { throw new Error('ARTIFACTS_SOURCE_UNAVAILABLE'); }
  let value:unknown; try { value=await response.json(); } catch { throw new Error('ARTIFACTS_SOURCE_UNAVAILABLE'); }
  if(response.status===404&&value&&typeof value==='object'&&(value as any).code==='PROJECT_UNMAPPED') return createArtifactsSourceStore(env,projectId);
  if(!response.ok||!value||typeof value!=='object'||!('config' in value))throw new Error('ARTIFACTS_SOURCE_UNAVAILABLE');
  const config=(value as {config?:unknown}).config;
  if(!config||typeof config!=='object'||Array.isArray(config))throw new Error('ARTIFACTS_SOURCE_UNAVAILABLE');
  const c=config as Record<string,unknown>;
  if(Object.keys(c).sort().join(',')!=='allowWrites,projectId,remote,repository'||c.projectId!==projectId||typeof c.repository!=='string'||!c.repository||typeof c.remote!=='string'||!c.remote||c.allowWrites!==true)throw new Error('ARTIFACTS_SOURCE_UNAVAILABLE');
  return createArtifactsSourceStore({...env,ARTIFACTS_SOURCE_CONFIG:JSON.stringify(c)},projectId);
}
