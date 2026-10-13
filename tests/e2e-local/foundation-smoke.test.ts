import { describe,it,expect } from 'vitest';
import { demoPolicyManifest } from '../../apps/worker/src/generated/demo-policy.js';
import { executeFoundation, fixedUrl, validateFixture } from '../../demo/cloud/foundation-smoke.js';
const repo:any={id:'fc34f086-87da-4067-a648-484af2297bd7',projectId:'fc34f086-87da-4067-a648-484af2297bd7',owner:'smoke-9533f8a31ce845178420',name:'probe-99e908cb73',status:'ready',source:{ref:'refs/heads/main',commitOid:'a'.repeat(40),treeOid:'b'.repeat(40)}};
const ident={username:repo.owner,email:'smoke-9533f8a31ce845178420aaaaaaaaaaaaaaaa@example.test',password:'synthetic-password-never-real'};
function fixture(conflict=false){
 const state:any={...ident,requestIds:{},results:[]}, calls:string[]=[];let contract:any=null,policy:any=null,baseline:any=null,proposal:any=null;
 const fetcher:typeof fetch=async(input,init={})=>{const u=new URL(String(input)),p=u.pathname,m=init.method??'GET';calls.push(`${m} ${p}`);let data:any={},status=200;
 if(p===`/api/platform/repos/${repo.owner}/${repo.name}`)data={repository:repo,ignoredFutureField:'native DTO allows added fields'};
 else if(p.endsWith('/source'))data={commitOid:repo.source.commitOid,treeOid:repo.source.treeOid,entries:[],readme:'Synthetic README'};
 else if(p==='/api/platform/auth/login'){data={csrf:'csrf'};return Response.json(data,{status,headers:{'set-cookie':'session=synthetic; Path=/'}});}
 else if(p==='/api/platform/auth/session')data={user:init.headers instanceof Headers&&init.headers.get('cookie')?{username:repo.owner}:null};
 else if(p==='/api/platform/auth/logout')data={ok:true};
 else if(p==='/api/swarmflare/demo-policy')data={supported:true,...demoPolicyManifest};
 else if(p.endsWith('/context'))data={resource:{contract:conflict?{id:'existing',version:1,owner:repo.owner,data:{...demoPolicyManifest.contract,outcome:'conflict'}}:contract,baseline:baseline?{version:1,commitOid:baseline.commitOid}:null}};
 else if(p.endsWith('/baseline')&&m==='GET')data={resource:baseline};
 else if(p.endsWith('/policy')&&m==='GET')data={resource:policy};
 else if(p.endsWith('/proposals')&&m==='GET')data={resource:proposal?[proposal]:[]};
 else if(p.endsWith('/contracts/proposals')){proposal={id:'proposal_1',version:1,data:{...JSON.parse(String(init.body)).payload,status:'proposed'}};data={resource:proposal};status=201;}
 else if(p.endsWith('/contracts/proposal_1/approve')){contract={id:'contract_1',version:1,owner:repo.owner,data:Object.fromEntries(Object.entries(proposal.data).filter(([k])=>k!=='status'))};proposal.data.status='approved';proposal.version++;data={resource:contract};status=201;}
 else if(p.endsWith('/policy')&&m==='POST'){policy={id:'policy_1',version:1,data:{contractVersion:1,...demoPolicyManifest.policyTemplate}};data={policy,status:'configured'};}
 else if(p.endsWith('/baseline/initialize')){const receipt={backend:'artifacts-git',ref:'refs/agent/seeds/seed_123',commitOid:repo.source.commitOid,treeOid:repo.source.treeOid};baseline={version:1,commitOid:repo.source.commitOid,treeOid:repo.source.treeOid,receipt};data={baseline,job:{id:'job_1',data:{input:{kind:'seed',source:{commitOid:repo.source.commitOid,treeOid:repo.source.treeOid}},status:'completed',receipt}} ,status:'initialized'};}
 else {status=404;data={code:'NOT_FOUND'};}
 return Response.json(data,{status});};
 return {state,calls,fetcher};
}
describe('foundation smoke safety and qualification',()=>{
 it('accepts exact synthetic generated identity and actual created repository receipt',()=>{const receipt={origin:'https://git-collaboration-demo-c29.sriva140.workers.dev',phase:'logout',created:repo};expect(validateFixture(ident,receipt)).toEqual(repo);expect(()=>validateFixture({...ident,username:'aniruddh'},receipt)).toThrow('SYNTHETIC_IDENTITY_INVALID');expect(()=>validateFixture({...ident,email:'smoke-9533f8a31ce845178420@example.test'},receipt)).toThrow('SYNTHETIC_IDENTITY_INVALID');expect(()=>validateFixture(ident,{...receipt,created:{...repo,owner:'someone-else'}})).toThrow('CREATED_REPOSITORY_INVALID');expect(fixedUrl('/repos/login')).toBe('https://git-collaboration-demo-c29.sriva140.workers.dev/api/platform/repos/login');expect(fixedUrl(`/api/v1/projects/${repo.projectId}/context`)).toContain(`/api/v1/projects/${repo.projectId}/context`);expect(()=>fixedUrl('//evil.test')).toThrow();});
 it('uses real platform/project routes and observed 201 approval plus exact policy and immutable seed baseline',async()=>{const f=fixture();const out=await executeFoundation(f.state,repo,f.fetcher);expect(out.status).toBe('prepared-metadata-only');expect(out.baseline.receiptRef).toBe('refs/agent/seeds/seed_123');expect(f.calls).toContain(`GET /api/platform/repos/${repo.owner}/${repo.name}`);expect(f.calls).toContain(`POST /api/v1/projects/${repo.projectId}/contracts/proposal_1/approve`);expect(f.calls.some(x=>x.includes('/acceptances'))).toBe(false);expect(f.calls.filter(x=>x.includes('/contracts/proposals')).length).toBe(1);expect(f.calls.at(-1)).toContain('/auth/session');expect(f.state.cookie).toBeUndefined();});
 it('refuses incompatible existing resources before resource mutations',async()=>{const f=fixture(true);await expect(executeFoundation(f.state,repo,f.fetcher)).rejects.toThrow('EXISTING_RESOURCE_CONFLICT');expect(f.calls.some(x=>x.startsWith('POST ')&&(x.includes('/contracts/proposals')||x.endsWith('/policy')||x.endsWith('/baseline/initialize')))).toBe(false);});
 it('resumes only the exact completed fixture without duplicating resource mutations',async()=>{const f=fixture();await executeFoundation(f.state,repo,f.fetcher);const before=f.calls.filter(x=>x.startsWith('POST ')&&!x.includes('/auth/')).length;await executeFoundation(f.state,repo,f.fetcher);expect(f.calls.filter(x=>x.startsWith('POST ')&&!x.includes('/auth/'))).toHaveLength(before);});
 it('redacts response bodies and error text from safe failure',async()=>{const state:any={...ident,requestIds:{},results:[]};const fetcher:typeof fetch=async()=>Response.json({code:'FORBIDDEN',message:'password secret leak'}, {status:403});await expect(executeFoundation(state,repo,fetcher)).rejects.toMatchObject({safe:{code:'FORBIDDEN',status:403}});});
});
