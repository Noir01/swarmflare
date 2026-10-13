import type { Actor } from '../../../../packages/contracts/index';

type Context={storage:{sql:{exec(query:string,...values:unknown[]):{toArray():any[]}}}};
export function dashboardSession(ctx:Context,actor:Actor,request:Request):Response {
 if(actor.role!=='human'||request.method!=='POST')return Response.json({code:'NOT_FOUND',message:'Not found'},{status:404});
 ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS dashboard_sessions (session_id_hash TEXT PRIMARY KEY,owner TEXT NOT NULL,expires_at INTEGER NOT NULL)');
 ctx.storage.sql.exec('DELETE FROM dashboard_sessions WHERE expires_at<=?',Date.now());
 let data:any;try{data=JSON.parse(request.headers.get('x-dashboard-session')??'null');}catch{return Response.json({code:'INVALID_REQUEST',message:'Invalid request'},{status:400});}
 if(!data||Object.keys(data).sort().join(',')!=='expiresAt,sessionIdHash'||typeof data.sessionIdHash!=='string'||!/^[0-9a-f]{64}$/.test(data.sessionIdHash)||!Number.isSafeInteger(data.expiresAt)||data.expiresAt<=Date.now()||data.expiresAt>Date.now()+900000)return Response.json({code:'INVALID_REQUEST',message:'Invalid request'},{status:400});
 if(request.headers.get('x-dashboard-action')==='create')ctx.storage.sql.exec('INSERT OR REPLACE INTO dashboard_sessions(session_id_hash,owner,expires_at) VALUES(?,?,?)',data.sessionIdHash,actor.id,data.expiresAt);
 else if(request.headers.get('x-dashboard-action')==='check'){const rows=ctx.storage.sql.exec('SELECT owner,expires_at FROM dashboard_sessions WHERE session_id_hash=?',data.sessionIdHash).toArray();if(rows[0]?.owner!==actor.id||rows[0]?.expires_at!==data.expiresAt||rows[0]?.expires_at<=Date.now())return Response.json({code:'UNAUTHORIZED',message:'Authentication required'},{status:401});}
 else if(request.headers.get('x-dashboard-action')==='revoke'){const rows=ctx.storage.sql.exec('SELECT owner,expires_at FROM dashboard_sessions WHERE session_id_hash=?',data.sessionIdHash).toArray();if(rows[0]?.owner!==actor.id||rows[0]?.expires_at!==data.expiresAt)return Response.json({code:'UNAUTHORIZED',message:'Authentication required'},{status:401});ctx.storage.sql.exec('DELETE FROM dashboard_sessions WHERE session_id_hash=? AND owner=? AND expires_at=?',data.sessionIdHash,actor.id,data.expiresAt);}
 else return Response.json({code:'NOT_FOUND',message:'Not found'},{status:404});
 return Response.json({ok:true},{headers:{'Cache-Control':'no-store'}});
}