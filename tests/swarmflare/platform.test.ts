import { afterEach, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
let runtime: Miniflare | undefined;
afterEach(async()=>{await runtime?.dispose();runtime=undefined});
it('authenticates, enforces CSRF, and revokes sessions in SQLite DO',async()=>{
 const bundle=await build({stdin:{contents:"export {Platform} from './apps/worker/src/platform/index'; export {Project} from './apps/worker/src/project/index';",resolveDir:process.cwd(),sourcefile:'platform-test-entry.ts',loader:'ts'},bundle:true,platform:'browser',format:'esm',write:false,external:['cloudflare:workers']});runtime=new Miniflare(convertV4MiniflareOptions({name:'platform-test',modules:true,script:bundle.outputFiles[0]!.text,compatibilityDate:'2026-08-01',durableObjects:{PLATFORM:{className:'Platform',useSQLite:true},PROJECTS:{className:'Project',useSQLite:true}},host:'127.0.0.1',port:0}));const origin=new URL((await runtime.ready).toString()).origin,ns:any=await runtime.getDurableObjectNamespace('PLATFORM'),stub=ns.get(ns.idFromName('test'));
 const call=(path:string,method='GET',body?:unknown,cookie?:string,csrf?:string,orig=origin)=>stub.fetch(origin+'/api/platform'+path,{method,headers:{...(body===undefined?{}:{'content-type':'application/json'}),origin:orig,...(cookie?{cookie}:{}),...(csrf?{'x-csrf-token':csrf}:{})},body:body===undefined?undefined:JSON.stringify(body)});
 expect((await call('/auth/signup','POST',{username:'noir',email:'n@example.test',password:'secret'})).status).toBe(201);expect((await call('/auth/signup','POST',{username:'noir',email:'x@example.test',password:'secret'})).status).toBe(409);
 const login=await call('/auth/login','POST',{login:'n@example.test',password:'secret'});expect(login.status).toBe(200);const csrf=(await login.json() as any).csrf,cookie=login.headers.get('set-cookie')!.split(';')[0]!;
 expect((await call('/auth/session','GET',undefined,cookie)).status).toBe(200);expect((await call('/repos','POST',{name:'repo-one'},cookie)).status).toBe(403);expect((await call('/repos','POST',{name:'repo-one'},cookie,csrf,'https://attacker.test')).status).toBe(403);
 expect((await call('/auth/logout','POST',{},cookie,csrf)).status).toBe(200);expect(await (await call('/auth/session','GET',undefined,cookie)).json()).toEqual({user:null});
});
