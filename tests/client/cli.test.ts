import { afterEach, expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';

const exec=promisify(execFile);
let runtime:Miniflare|undefined;
afterEach(async()=>{await runtime?.dispose();runtime=undefined;});
const cli=async(args:string[],env:NodeJS.ProcessEnv={})=>exec('npx',['tsx','apps/cli/index.ts',...args],{env:{...process.env,...env,NO_COLOR:'1'}});

it('prints complete help without credentials and safely reports malformed input',async()=>{
 const {stdout}=await cli(['--help'],{WORKSPACE_TOKEN:undefined,WORKSPACE_PROJECT_ID:undefined,WORKSPACE_BASE_URL:undefined});
 expect(stdout).toContain('approve-proposal');expect(stdout).toContain('resolve-decision');expect(stdout).toContain('source-verification');expect(stdout).toContain('Mutation envelope:');expect(stdout).toContain('Never pass human credentials/secrets to agents.');
 await expect(cli(['configure-policy','{bad'],{WORKSPACE_BASE_URL:'http://127.0.0.1',WORKSPACE_PROJECT_ID:'cli-test',WORKSPACE_TOKEN:'secret-test'})).rejects.toMatchObject({stderr:expect.not.stringContaining('secret-test')});
});

it('reads source verification by view ID without mutating',async()=>{
 const requests:Array<{method:string|undefined;url:string|undefined}>=[];
 const server=createServer((req,res)=>{requests.push({method:req.method,url:req.url});res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({apiVersion:1,sequence:1,version:1,resource:null}));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try {
  const address=server.address(); if(!address||typeof address==='string') throw new Error('test server did not bind');
  const env={WORKSPACE_BASE_URL:`http://127.0.0.1:${address.port}`,WORKSPACE_PROJECT_ID:'cli-test',WORKSPACE_TOKEN:'cli-token'};
  const result=await cli(['source-verification',JSON.stringify({id:'view-1'})],env);
  expect(JSON.parse(result.stdout)).toBeNull();
  expect(requests).toEqual([{method:'GET',url:'/api/v1/projects/cli-test/views/view-1/source-verification'}]);
  await expect(cli(['source-verification',JSON.stringify({id:'bad/id'})],env)).rejects.toMatchObject({stderr:expect.stringContaining('must match pattern')});
  expect(requests).toHaveLength(1);
 } finally { await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())); }
});

it('routes explicit commands through authenticated Worker HTTP and server role checks',async()=>{
 const bundle=await build({entryPoints:['apps/worker/src/index.ts'],bundle:true,platform:'browser',format:'esm',write:false,external:['cloudflare:workers']});
 const roles=['human','contributor'] as const;
 const credentials=roles.map(role=>({id:role,role,projectId:'cli-test',tokenHash:createHash('sha256').update(`cli-${role}`).digest('hex'),expiresAt:Date.now()+300_000}));
 runtime=new Miniflare(convertV4MiniflareOptions({name:'cli-test',modules:true,script:bundle.outputFiles[0]!.text,compatibilityDate:'2026-08-01',durableObjects:{PROJECTS:{className:'Project',useSQLite:true}},bindings:{AUTH_CREDENTIALS:JSON.stringify(credentials)},host:'127.0.0.1',port:0}));
 const baseUrl=(await runtime.ready).toString();
 const env=(role:string)=>({WORKSPACE_BASE_URL:baseUrl,WORKSPACE_PROJECT_ID:'cli-test',WORKSPACE_TOKEN:`cli-${role}`});
 const context=await cli(['context'],env('contributor'));
 expect(JSON.parse(context.stdout)).toMatchObject({contract:null,baseline:null,claims:[],decisions:[],findings:[],nextCursor:null});
 const proposal=await cli(['proposal',JSON.stringify({requestId:'cli-proposal',payload:{outcome:'CLI integration',constraints:[],obligations:[{id:'cli-obligation',description:'Verify CLI',acceptanceExamples:[]}],requiredCheckIds:['cli-check'],unresolvedQuestions:[]}})],env('human'));
 const proposalId=JSON.parse(proposal.stdout).id as string;
 await cli(['approve-proposal',JSON.stringify({id:proposalId,mutation:{requestId:'cli-approve',expectedVersion:0,payload:{}}})],env('human'));
 const input=JSON.stringify({requestId:'cli-policy',expectedVersion:0,payload:{contractVersion:1,checkSuiteDigest:'a'.repeat(64),harnessVersion:'json-oracle-v1',checks:[{id:'cli-check',obligationIds:['cli-obligation']}],requireIndependentReview:true,sourceBackend:'local-git'}});
 const configured=await cli(['configure-policy',input],env('human'));
 expect(JSON.parse(configured.stdout)).toMatchObject({data:{contractVersion:1,checks:[{id:'cli-check'}]}});
 const policy=await cli(['policy'],env('human'));
 expect(JSON.parse(policy.stdout)).toMatchObject({id:expect.any(String),data:{contractVersion:1}});
 await expect(cli(['configure-policy',JSON.stringify({requestId:'forbidden',expectedVersion:0,payload:JSON.parse(input).payload})],env('contributor'))).rejects.toMatchObject({stderr:expect.stringContaining('FORBIDDEN')});
});
