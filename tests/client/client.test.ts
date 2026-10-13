import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { WorkspaceClient } from '../../packages/client/index';

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r())))); });
async function serve(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void) {
  const server = createServer(handler); servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('no address');
  return `http://127.0.0.1:${address.port}`;
}
const context = {contract:null,baseline:null,claims:[],decisions:[],findings:[],nextCursor:null};
const ok = (resource: unknown, version = 1) => ({apiVersion:1,resource,sequence:version,version});

describe('WorkspaceClient local HTTP integration', () => {
  it('validates context envelope and retains ETag for conditional read', async () => {
    const seen: string[] = [];
    const baseUrl = await serve((req,res) => { seen.push(req.headers['if-none-match'] ?? ''); res.setHeader('etag','"ctx-1"'); if(req.headers['if-none-match']==='"ctx-1"'){res.statusCode=304;res.end();return;} res.end(JSON.stringify(ok(context))); });
    const client = new WorkspaceClient({baseUrl,projectId:'p1',token:'secret'});
    expect(await client.context()).toEqual(context);
    expect(await client.context()).toEqual(context);
    expect(seen).toEqual(['','"ctx-1"']);
  });
  it('validates mutation input/output, sends bearer and never logs it', async () => {
    let body = ''; let authorization = '';
    const baseUrl = await serve((req,res) => { authorization = String(req.headers.authorization); req.on('data',b=>body+=b); req.on('end',()=>res.end(JSON.stringify(ok({id:'c1',version:1,owner:'u',data:{}})))); });
    const client = new WorkspaceClient({baseUrl,projectId:'p1',token:'secret'});
    await client.mutate('POST','/claims',{requestId:'r1',expectedVersion:0,payload:{obligationIds:['o1'],areas:['api']}});
    expect(authorization).toBe('Bearer secret'); expect(JSON.parse(body).requestId).toBe('r1'); expect(JSON.parse(body).expectedVersion).toBe(0); expect(body).not.toContain('secret');
  });
  it('rejects malformed server envelopes and bounds request count', async () => {
    const baseUrl = await serve((_req,res)=>res.end('{"apiVersion":2}'));
    const client = new WorkspaceClient({baseUrl,projectId:'p1',token:'x',maxRequests:1});
    await expect(client.context()).rejects.toThrow();
    await expect(client.context()).rejects.toThrow(/request limit/i);
  });
  it('paginates events with opaque cursor and retries GET only with >=5s injectable delay', async () => {
    let calls = 0; const delays:number[]=[];
    const baseUrl = await serve((req,res) => { calls++; if(calls===1){res.statusCode=503;res.end('{}');return;} res.end(JSON.stringify(ok({events:[],nextCursor:null}))); });
    const client = new WorkspaceClient({baseUrl,projectId:'p1',token:'x',sleep:async ms=>{delays.push(ms);}});
    await client.events({cursor:'opaque',limit:10}); expect(calls).toBe(2); expect(delays[0]).toBeGreaterThanOrEqual(5000);
  });
  it('does not retry mutations and rejects non-contract routes or oversized payloads before sending', async () => {
    let calls=0;
    const baseUrl=await serve((_req,res)=>{calls++;res.statusCode=503;res.end(JSON.stringify({code:'UNAVAILABLE',message:'down'}));});
    const client=new WorkspaceClient({baseUrl,projectId:'p1',token:'x',sleep:async()=>{throw new Error('must not sleep');}});
    await expect(client.mutate('POST','/claims',{requestId:'r1',payload:{x:1}})).rejects.toThrow();
    expect(calls).toBe(1);
    await expect(client.mutate('POST','/deployments',{requestId:'r2',payload:{}})).rejects.toThrow(/unsupported frozen API mutation/);
    await expect(client.mutate('POST','/claims',{requestId:'r3',payload:{blob:'x'.repeat(70_000)}})).rejects.toThrow(/64 KiB/);
    expect(calls).toBe(1);
  });
  it('follows opaque event cursors with a hard page bound', async () => {
    const queries:string[]=[];
    const baseUrl=await serve((req,res)=>{const url=new URL(req.url??'/', 'http://localhost');queries.push(url.searchParams.get('cursor')??'');const next=queries.length===1?'c2':null;res.end(JSON.stringify(ok({events:[queries.length],nextCursor:next})));});
    const client=new WorkspaceClient({baseUrl,projectId:'p1',token:'x'});
    const pages=[]; for await(const page of client.eventPages({limit:2,maxPages:3})) pages.push(page);
    expect(pages).toEqual([[1],[2]]); expect(queries).toEqual(['','c2']);
  });

  it('rejects unsafe URL components and non-contract project identifiers', () => {
    for (const baseUrl of ['http://user:pass@example.test', 'http://@example.test', 'http://example.test/?x=1', 'http://example.test/?', 'http://example.test/#fragment', 'http://example.test/#']) {
      expect(() => new WorkspaceClient({baseUrl,projectId:'p1',token:'x'})).toThrow();
    }
    expect(() => new WorkspaceClient({baseUrl:'http://example.test',projectId:'bad/id',token:'x'})).toThrow();
  });

  it('accepts expectedVersion zero and sends it unchanged on proposal approval', async () => {
    let requestBody: any;
    const baseUrl=await serve((req,res)=>{let text='';req.on('data',chunk=>text+=chunk);req.on('end',()=>{requestBody=JSON.parse(text);res.end(JSON.stringify(ok({id:'pr1'})));});});
    const client=new WorkspaceClient({baseUrl,projectId:'p1',token:'x'});
    await client.approveProposal('pr1',{requestId:'approve1',payload:{}});
    expect(requestBody.expectedVersion).toBe(0);
  });

  it('rejects an unexpected generic 304 rather than returning undefined', async () => {
    const baseUrl=await serve((_req,res)=>{res.statusCode=304;res.end();});
    const client=new WorkspaceClient({baseUrl,projectId:'p1',token:'x'});
    await expect(client.get('/baseline')).rejects.toThrow(/304/);
  });

  it('rejects cyclic event cursors', async () => {
    const baseUrl=await serve((_req,res)=>res.end(JSON.stringify(ok({events:[],nextCursor:'loop'}))));
    const client=new WorkspaceClient({baseUrl,projectId:'p1',token:'x'});
    await expect(async()=>{for await(const _page of client.eventPages({maxPages:5})) {}}).rejects.toThrow(/cursor/i);
  });

  it('retries bounded GET responses without leaving their body unread', async () => {
    let calls=0; const delays:number[]=[];
    const baseUrl=await serve((_req,res)=>{calls++;if(calls===1){res.statusCode=503;res.end('x'.repeat(1000));return;}res.end(JSON.stringify(ok(context)));});
    const client=new WorkspaceClient({baseUrl,projectId:'p1',token:'x',sleep:async ms=>{delays.push(ms);}});
    await client.context();
    expect(calls).toBe(2); expect(delays).toEqual([5000]);
  });

  it('does not return a 304 context without a previously cached context', async () => {
    const baseUrl=await serve((_req,res)=>{res.statusCode=304;res.end();});
    const client=new WorkspaceClient({baseUrl,projectId:'p1',token:'x'});
    await expect(client.context()).rejects.toThrow(/304/);
  });

  it('uses redirect:error and enforces the request deadline while reading', async () => {
    let redirectMode='';
    const client=new WorkspaceClient({baseUrl:'http://127.0.0.1:1',projectId:'p1',token:'x',deadline:50,fetch:async(_input,init)=>{redirectMode=String(init?.redirect);return await new Promise<Response>((_resolve,reject)=>init?.signal?.addEventListener('abort',()=>reject(new Error('aborted'))));}});
    await expect(client.get('/baseline')).rejects.toThrow();
    expect(redirectMode).toBe('error');
  });

  it('cancels an oversized response indicated by content-length', async () => {
    const baseUrl=await serve((_req,res)=>{res.setHeader('content-length','65537');res.end('');});
    const client=new WorkspaceClient({baseUrl,projectId:'p1',token:'x'});
    await expect(client.get('/baseline')).rejects.toThrow(/64 KiB/);
  });

  it('exposes typed source lifecycle methods with strict validation and exact routes', async () => {
    const seen:string[]=[];
    const baseUrl=await serve((req,res)=>{seen.push(`${req.method} ${req.url}`); let text='';req.on('data',b=>text+=b);req.on('end',()=>res.end(JSON.stringify(ok(null))));});
    const client=new WorkspaceClient({baseUrl,projectId:'p1',token:'x'});
    await expect(client.initializeBaseline({requestId:'seed1',expectedVersion:0,payload:{commitOid:'a'.repeat(40),treeOid:'b'.repeat(40)}})).rejects.toThrow();
    expect(seen).toEqual(['POST /api/v1/projects/p1/baseline/initialize']);
    await expect(client.viewUpdates('bad/id')).rejects.toThrow();
  });

  it('validates feedback anchors before fetch and uses exact typed routes', async () => {
    const seen:string[]=[];
    const baseUrl=await serve((req,res)=>{seen.push(`${req.method} ${req.url}`);res.end(JSON.stringify(ok([])));});
    const client=new WorkspaceClient({baseUrl,projectId:'p1',token:'x'});
    await expect(client.findings()).resolves.toEqual([]);
    await expect(client.finding('../bad')).rejects.toThrow();
    expect(seen).toEqual(['GET /api/v1/projects/p1/findings']);
  });

  it('rejects invalid typed acceptance input before sending', async () => {
    let calls = 0;
    const baseUrl = await serve((_req, res) => { calls++; res.end(JSON.stringify(ok(null))); });
    const client = new WorkspaceClient({baseUrl, projectId:'p1', token:'x'});
    await expect(client.acceptView({requestId:'invalid-acceptance', payload:{}})).rejects.toThrow();
    expect(calls).toBe(0);
  });
});
