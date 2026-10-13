import { actorSchema, id } from '../../../../packages/contracts/index';
import { z } from 'zod';

const credentialSchema=z.object({id,projectId:id,role:z.enum(['human','contributor','reviewer','runner']),tokenHash:z.string().regex(/^[0-9a-f]{64}$/),expiresAt:z.number().int().finite()}).strict();
const credentialsSchema=z.array(credentialSchema).max(1000);
type Credential=z.infer<typeof credentialSchema>;
type AuthEnv=Env & {AUTH_CREDENTIALS?:string;DEMO_BOOTSTRAP_CONFIG?:string};
const json=(code:string,message:string,status:number)=>Response.json({code,message},{status});
const hex=(buffer:ArrayBuffer)=>Array.from(new Uint8Array(buffer),b=>b.toString(16).padStart(2,'0')).join('');
export function parseCredentials(raw:string|undefined):Credential[]|null{if(raw===undefined||new TextEncoder().encode(raw).byteLength>1048576)return null;try{const parsed=credentialsSchema.safeParse(JSON.parse(raw));if(!parsed.success)return null;const identities=new Set<string>(),hashes=new Set<string>();for(const c of parsed.data){const identity=JSON.stringify([c.projectId,c.id]);if(identities.has(identity)||hashes.has(c.tokenHash))return null;identities.add(identity);hashes.add(c.tokenHash);}return parsed.data;}catch{return null;}}
function routeAllowed(method:string,path:string):boolean{

 if(method==='GET'&&['/context','/events','/baseline'].includes(path))return true;
 if(method==='GET'&&path==='/views')return true;
 if(method==='GET'&&/^\/contracts\/\d+$/.test(path))return true;
 if(method==='GET'&&/^\/(changes|views)\/[^/]+$/.test(path))return true;
 if(method==='GET'&&/^\/changes\/[^/]+\/revisions$/.test(path))return true;
 if(method==='GET'&&/^\/revisions\/[^/]+$/.test(path))return true;
 if(method==='GET'&&/^\/views\/[^/]+\/updates$/.test(path))return true;
 if(method==='GET'&&/^\/runner\/jobs\/[^/]+$/.test(path))return true;
 if(method==='GET'&&path==='/baseline')return true;
 if(method==='GET'&&path==='/policy')return true;
 if(method==='GET'&&/^\/acceptances\/[^/]+$/.test(path))return true;
 if(method==='GET'&&path==='/findings')return true;
 if(method==='GET'&&/^\/findings\/[^/]+$/.test(path))return true;
 if(method==='GET'&&/^\/decisions\/[^/]+$/.test(path))return true;
 if(method==='GET'&&/^\/views\/[^/]+\/(readiness|reviews)$/.test(path))return true;
 if(method==='GET'&&/^\/views\/[^/]+\/checks$/.test(path))return true;
 if(method==='GET'&&/^\/views\/[^/]+\/source-verification$/.test(path))return true;
 if(method==='GET'&&/^\/views\/[^/]+\/review-artifact$/.test(path))return true;
 if(method==='POST'&&['/contracts/proposals','/claims','/changes','/decisions','/acceptances','/views','/findings'].includes(path))return true;
 if(method==='POST'&&['/baseline/initialize','/runner/claim'].includes(path))return true;
 if(method==='POST'&&/^\/demo\/bootstrap$/.test(path))return true;
 if(method==='POST'&&['/policy'].includes(path))return true;
 if(method==='POST'&&/^\/views\/[^/]+\/confirmations$/.test(path))return true;
 if(method==='POST'&&/^\/runner\/views\/[^/]+\/source-verifications$/.test(path))return true;
 if(method==='POST'&&/^\/changes\/[^/]+\/revisions$/.test(path))return true;
 if(method==='POST'&&/^\/runner\/jobs\/[^/]+\/complete$/.test(path))return true;
 if(method==='POST'&&/^\/runner\/jobs\/[^/]+\/publish-artifacts$/.test(path))return true;
 return (method==='POST'&&/^\/runner\/views\/[^/]+\/checks$/.test(path))||
  (method==='POST'&&/^\/runner\/views\/[^/]+\/review-artifacts$/.test(path))||
  (method==='POST'&&/^\/contracts\/[^/]+\/approve$/.test(path))||
  (method==='PATCH'&&/^\/claims\/[^/]+$/.test(path))||
  (method==='POST'&&/^\/claims\/[^/]+\/overlap-ack$/.test(path))||
  (method==='POST'&&/^\/decisions\/[^/]+\/(responses|agree)$/.test(path))||
  (method==='POST'&&/^\/decisions\/[^/]+\/resolve$/.test(path))||
  (method==='POST'&&/^\/findings\/[^/]+\/(owner|repair|resolve)$/.test(path))||
  (method==='POST'&&/^\/views\/[^/]+\/(checks|reviews)$/.test(path));
}
async function readBounded(request:Request):Promise<ArrayBuffer|null>{if(!request.body)return new ArrayBuffer(0);const reader=request.body.getReader(),chunks:Uint8Array[]=[];let size=0;try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>65536){await reader.cancel();return null;}chunks.push(value);}}catch{await reader.cancel();throw new Error('body-read');}const out=new Uint8Array(size);let offset=0;for(const chunk of chunks){out.set(chunk,offset);offset+=chunk.byteLength;}return out.buffer;}
export async function route(request:Request,env:AuthEnv):Promise<Response>{
 const url=new URL(request.url),match=url.pathname.match(/^\/api\/v1\/projects\/([^/]+)(\/.*)?$/);
 if(!match)return json('NOT_FOUND','Not found',404);
 let projectId:string;try{projectId=decodeURIComponent(match[1]!);}catch{return json('INVALID_REQUEST','Invalid project ID',400);}const canonical=id.safeParse(projectId);if(!canonical.success)return json('INVALID_REQUEST','Invalid project ID',400);if(encodeURIComponent(projectId)!==match[1])return json('INVALID_REQUEST','Noncanonical project ID',422);const suffix=match[2]??'/';
 const creds=parseCredentials(env.AUTH_CREDENTIALS);if(!creds)return json('UNAVAILABLE','Service unavailable',503);
 const authorization=request.headers.get('authorization')??'',bearer=authorization.match(/^Bearer ([^\s]+)$/);
 if(!bearer)return json('UNAUTHORIZED','Authentication required',401);
 const hash=hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(bearer[1]!)));
 const credential=creds.find(c=>c.tokenHash===hash&&c.expiresAt>Date.now());if(!credential)return json('UNAUTHORIZED','Authentication required',401);
 if(credential.projectId!==projectId)return json('FORBIDDEN','Project membership mismatch',403);
 const actor=actorSchema.parse({id:credential.id,projectId:credential.projectId,role:credential.role});
 if(!routeAllowed(request.method,suffix))return json('NOT_FOUND','Not found',404);
 let body:ArrayBuffer|null=null;if(request.method!=='GET'&&request.method!=='HEAD'){try{body=await readBounded(request);}catch{return json('INVALID_REQUEST','Unable to read request body',400);}if(body===null)return json('BODY_TOO_LARGE','Request body exceeds 64KiB',413);}
 const headers=new Headers();for(const name of ['content-type','if-none-match']){const value=request.headers.get(name);if(value)headers.set(name,value);}headers.set('x-actor',JSON.stringify(actor));headers.set('x-project-id',projectId);if(env.DEMO_BOOTSTRAP_CONFIG)headers.set('x-demo-bootstrap-config',env.DEMO_BOOTSTRAP_CONFIG);
 try{const id=env.PROJECTS.idFromName(projectId),stub=env.PROJECTS.get(id),forward=new Request(`https://project.internal${suffix}${url.search}`,{method:request.method,headers,body:body&&body.byteLength?body:undefined,redirect:'manual'});const response=await stub.fetch(forward);return new Response(response.body,{status:response.status,statusText:response.statusText,headers:response.headers});}catch{return json('UNAVAILABLE','Service unavailable',503);}
}
