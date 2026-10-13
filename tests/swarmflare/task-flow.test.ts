import { describe, expect, it } from 'vitest';
import { site } from '../../apps/worker/src/http/site';

describe('task proposal vertical path', () => {
  it('persists a human-submitted proposal and exposes it as pending on SSR reload', async () => {
    const proposals: any[] = [];
    const project = { idFromName: (name: string) => name, get: () => ({ fetch: async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === '/context') return Response.json({ resource: { contract: null, claims: [] } });
      if (path === '/baseline' || path === '/policy') return Response.json({ resource: null });
      if (path === '/proposals') return Response.json({ resource: proposals });
      if (path === '/views') return Response.json({ resource: [] });
      if (path === '/events') return Response.json({ resource: { events: [] } });
      if (path === '/contracts/proposals' && request.method === 'POST') {
        const payload = await request.json() as any;
        const proposal = { id: 'proposal-1', version: 1, owner: 'human-1', data: { ...payload.payload, status: 'proposed' } };
        proposals.push(proposal);
        return Response.json({ resource: proposal }, { status: 201 });
      }
      return Response.json({ resource: [] });
    } }) };
    const platform = { idFromName: (name: string) => name, get: () => ({ fetch: async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith('/auth/session')) return Response.json({ user: { username: 'ada', id: 'human-1' }, csrf: 'csrf-token' });
      if (url.pathname.endsWith('/internal/authorize-project')) return Response.json({ actor: { id: 'human-1', projectId: 'project-1', role: 'human', kind: 'human' } });
      if (url.pathname.endsWith('/repos/ada/notes')) return Response.json({ repository: { id: 'repo-1', owner: 'ada', name: 'notes', projectId: 'project-1', status: 'ready' } });
      if (url.pathname.endsWith('/source')) return Response.json({ commitOid: 'a'.repeat(40), treeOid: 'b'.repeat(40), entries: [] });
      return Response.json({});
    } }) };
    const env = { PLATFORM: platform, PROJECTS: project } as any;
    const payload = { requestId: 'request-1', payload: { outcome: 'Add CSV export', constraints: ['Keep existing API'], obligations: [{ id: 'csv', description: 'Export rows as CSV', acceptanceExamples: ['header included'] }], requiredCheckIds: ['csv-check'], unresolvedQuestions: [] } };
    const submitted = await site(new Request('https://swarmflare.test/api/swarmflare/repos/ada/notes/proposals', { method: 'POST', headers: { origin: 'https://swarmflare.test', 'x-csrf-token': 'csrf-token', 'content-type': 'application/json' }, body: JSON.stringify(payload) }), env);
    expect(submitted.status).toBe(201);
    const page = await site(new Request('https://swarmflare.test/ada/notes/tasks'), env);
    const html = await page.text();
    expect(html).toContain('Add CSV export');
    expect(html).toContain('Proposed · awaiting human approval');
    expect(html).toContain('Export rows as CSV');
    expect(html).toContain('header included');
    expect(html).toContain('required-checks');
    expect(html).toContain('data-api="task-approval"');
    expect(html).not.toContain('Current approved task</h2><div class="readme-body"><p>Add CSV export');
  });
  it('renders full proposal and a version-bound approval control only for the repository owner', async () => {
    const proposals=[{id:'proposal-<1>',version:3,data:{status:'proposed',outcome:'<img src=x onerror=alert(1)>',constraints:['No unsafe HTML'],obligations:[{id:'task',description:'Do work',acceptanceExamples:['Example']}],requiredCheckIds:['check-a'],unresolvedQuestions:['Question?']}}];
    const project={idFromName:(name:string)=>name,get:()=>({fetch:async(request:Request)=>{const path=new URL(request.url).pathname;if(path==='/context')return Response.json({resource:{contract:{id:'contract-1',version:7,data:{outcome:'Approved existing task'}},claims:[]}});if(path==='/proposals')return Response.json({resource:proposals});if(path==='/views')return Response.json({resource:[]});if(path==='/events')return Response.json({resource:{events:[]}});if(path==='/baseline'||path==='/policy')return Response.json({resource:null});return Response.json({resource:[]})}})};
    const platform={idFromName:(name:string)=>name,get:()=>({fetch:async(request:Request)=>{const path=new URL(request.url).pathname;if(path.endsWith('/auth/session'))return Response.json({user:{username:'ada'},csrf:'csrf'});if(path.endsWith('/repos/ada/notes'))return Response.json({repository:{id:'r',owner:'ada',name:'notes',projectId:'p'}});if(path.endsWith('/source'))return Response.json({commitOid:'a'.repeat(40),treeOid:'b'.repeat(40)});return Response.json({})}})};
    const env={PROJECTS:project,PLATFORM:platform} as any;
    let response=await site(new Request('https://swarmflare.test/ada/notes/tasks'),env),body=await response.text();
    expect(body).toContain('data-contract-version="7"');expect(body).toContain('data-proposal-id="proposal-&lt;1&gt;"');expect(body).toContain('&lt;img src=x onerror=alert(1)&gt;');expect(body).not.toContain('<img src=x');expect(body).toContain('Approved existing task');
    response=await site(new Request('https://swarmflare.test/ada/notes/tasks'),{...env,PLATFORM:{...platform,get:()=>({fetch:async(request:Request)=>{const path=new URL(request.url).pathname;if(path.endsWith('/auth/session'))return Response.json({user:{username:'bob'}});if(path.endsWith('/repos/ada/notes'))return Response.json({repository:{id:'r',owner:'ada',name:'notes',projectId:'p'}});if(path.endsWith('/source'))return Response.json({});return Response.json({})}})}} as any);body=await response.text();expect(body).not.toContain('data-api="task-approval"');expect(body).not.toContain('data-api="initialize-baseline"');
  });
  it('forwards owner approval through the trusted bridge and refuses invalid baseline envelopes', async () => {
    const authorized:string[]=[];const mutations:any[]=[];
    const platform={idFromName:(name:string)=>name,get:()=>({fetch:async(input:RequestInfo|URL,init?:RequestInit)=>{const request=input instanceof Request?input:new Request(input,init);const url=new URL(request.url);if(url.pathname.endsWith('/internal/authorize-project')){authorized.push(request.headers.get('x-csrf-token')||'');return Response.json({actor:{id:'owner',projectId:'p1',role:'human',kind:'human'}})}if(url.pathname.endsWith('/repos/ada/notes'))return Response.json({repository:{projectId:'p1'}});return Response.json({})}})};
    const projects={idFromName:(name:string)=>name,get:()=>({fetch:async(input:RequestInfo|URL,init?:RequestInit)=>{const request=input instanceof Request?input:new Request(input,init);mutations.push({path:new URL(request.url).pathname,actor:request.headers.get('x-actor'),body:await request.json()});return Response.json({resource:{ok:true}},{status:201})}})};
    const env={PLATFORM:platform,PROJECTS:projects} as any;
    const headers={origin:'https://swarmflare.test','x-csrf-token':'csrf','content-type':'application/json'};
    let response=await site(new Request('https://swarmflare.test/api/v1/projects/p1/contracts/proposal-1/approve',{method:'POST',headers,body:JSON.stringify({requestId:'r1',expectedVersion:4,payload:{}})}),env);
    expect(response.status).toBe(201);
    response=await site(new Request('https://swarmflare.test/api/swarmflare/repos/ada/notes/baseline/initialize',{method:'POST',headers,body:JSON.stringify({requestId:'r2',expectedVersion:0,payload:{commitOid:'a'.repeat(40),treeOid:'b'.repeat(40)}})}),env);
    expect(response.status).toBe(400);expect(mutations.map(x=>x.path)).toEqual(['/contracts/proposal-1/approve']);expect(mutations[0].body).toEqual({requestId:'r1',expectedVersion:4,payload:{}});expect(JSON.parse(mutations[0].actor).role).toBe('human');expect(authorized).toEqual(['csrf']);
  });
});
