import { describe, expect, it } from 'vitest';
import { WorkspaceClient } from '../../packages/client/index';

describe('material decision client routes',()=>{
 it('uses frozen detail and human resolution endpoints and validates payload',async()=>{
  const seen:string[]=[];
  const client=new WorkspaceClient({baseUrl:'https://workspace.test',projectId:'p1',token:'fixture',fetch:async(input,init)=>{seen.push(`${init?.method} ${new URL(String(input)).pathname}`);return Response.json({apiVersion:1,resource:{id:'d1'},sequence:1,version:1});}});
  await client.decision('d1');
  await client.resolveDecision('d1',{requestId:'resolve1',expectedVersion:2,payload:{kind:'clarification',contractVersion:1,note:'Human clarification'}});
  await expect(client.resolveDecision('d1',{requestId:'bad',payload:{kind:'clarification',contractVersion:1,note:''}})).rejects.toThrow();
  await expect(client.resolveDecision('d1',{requestId:'bad-version',expectedVersion:2,payload:{kind:'clarification',contractVersion:0,note:'Human clarification'}})).rejects.toThrow();
  expect(seen).toEqual(['GET /api/v1/projects/p1/decisions/d1','POST /api/v1/projects/p1/decisions/d1/resolve']);
 });
});
