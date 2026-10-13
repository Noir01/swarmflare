import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { CompositionRequest, CompositionResult, PublishedRevision } from '../contracts/index.js';
import type { SourceReceipt, DurableCompositionRequest } from '../contracts/source.js';

export class GitRunnerError extends Error { constructor(public readonly code: string, message: string, public readonly details?: unknown) { super(message); this.name = 'GitRunnerError'; } }
const receipt=(ref:string,commitOid:string,treeOid:string):SourceReceipt=>({backend:'local-git',ref,commitOid,treeOid});
export async function readSourceReceipt(repository:string,ref:string):Promise<SourceReceipt> { const repo=assertLocalBare(repository); if(!/^refs\/agent\/(seeds\/[A-Za-z0-9_-]+|revisions\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+|views\/[A-Za-z0-9_-]+)$/.test(ref)) throw new GitRunnerError('INVALID_REF','Invalid source receipt ref'); const commitOid=run(repo,['rev-parse','--verify',ref]); assertCommit(repo,commitOid); return receipt(ref,commitOid,run(repo,['rev-parse',`${commitOid}^{tree}`])); }
export async function publishSeed(repository:string,remote:string,seedId:string,source:{commitOid:string;treeOid:string}):Promise<SourceReceipt> { if(!idOk(seedId)) throw new GitRunnerError('INVALID_REF','Invalid seed ID'); const src=resolve(repository),target=assertLocalBare(remote),ref=`refs/agent/seeds/${seedId}`; assertSafeLocalConfig(src); assertCommit(src,source.commitOid); assertTreeSafe(src,source.commitOid); if(run(src,['rev-parse',`${source.commitOid}^{tree}`])!==source.treeOid) throw new GitRunnerError('TREE_MISMATCH','Seed tree does not match source'); let old:string|undefined; try{old=run(target,['rev-parse','--verify',ref]);}catch{} if(old&&old!==source.commitOid) throw new GitRunnerError('IMMUTABLE_REF','Seed ref already differs'); if(!old){git(['fetch','--quiet',src,source.commitOid],target); try{git(['update-ref',ref,source.commitOid,'0000000000000000000000000000000000000000'],target);}catch{} } const result=await readSourceReceipt(target,ref); if(result.commitOid!==source.commitOid||result.treeOid!==source.treeOid)throw new GitRunnerError('IMMUTABLE_REF','Seed ref raced to a different source'); return result; }
const env = { PATH: process.env.PATH || '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0', GIT_CONFIG_PARAMETERS: '', GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', GIT_ALLOW_PROTOCOL: 'file' };
function git(args: string[], cwd?: string): string { try { return execFileSync('git', [...(cwd ? ['-C', cwd] : []), '-c','core.hooksPath=/dev/null','-c','credential.helper=','-c','protocol.ext.allow=never','-c','protocol.file.allow=always','-c','core.fsmonitor=false',...args], { encoding:'utf8',env,timeout:15000,maxBuffer:34*1024*1024,stdio:['ignore','pipe','pipe'] }).trim(); } catch (e) { const x=e as {status?:number}; throw new GitRunnerError('GIT_COMMAND_FAILED', `Git ${args[0] ?? 'operation'} failed`, {command:args[0],status:x.status}); } }
function run(repo: string, args: string[]): string { return git(args,repo); }
function assertSafeLocalConfig(repository:string):void {
 const gitDir=resolve(run(repository,['rev-parse','--absolute-git-dir']));
 const commonDir=resolve(repository,run(repository,['rev-parse','--git-common-dir']));
 const files=[...new Set([resolve(commonDir,'config'),resolve(gitDir,'config')])];
 for(const config of files) {
  if(!existsSync(config)) continue;
  let keys:string[];
  try { keys=execFileSync('git',['config','--no-includes','--file',config,'--name-only','--list'],{encoding:'utf8',env,timeout:15000,stdio:['ignore','pipe','pipe']}).split(/\r?\n/).filter(Boolean); }
  catch(e) {
   const status=(e as {status?:number}).status;
   if(status===1) keys=[]; else throw new GitRunnerError('UNSAFE_LOCAL_CONFIG','Could not safely parse local Git configuration');
  }
  for(const key of keys) {
   const full=key.toLowerCase();
   if(/^(?:credential\.|filter\.|uploadpack\.|include\.|includeif\.|submodule\.)/.test(full)||/^(?:core\.(?:hookspath|fsmonitor|sshcommand)|diff\..*(?:external|textconv)|merge\..*\.driver|extensions\.(?:worktreeconfig|objectformat|compatobjectformat|partialclone|refstorage))$/.test(full))
    throw new GitRunnerError('UNSAFE_LOCAL_CONFIG',`Unsafe local Git configuration: ${full}`);
  }
 }
}

const validOid=(s:string)=>/^[0-9a-f]{40}$/.test(s);
function assertOid(s:string,label:string):void { if(!validOid(s)) throw new GitRunnerError('INVALID_OID',`${label} must be a full 40-character lowercase Git object ID`); }
function assertLocalBare(path:string):string { if(/^(https?|ssh|git):/i.test(path)||path.includes('@')) throw new GitRunnerError('UNSAFE_REMOTE','Only local filesystem repositories are supported'); const p=resolve(path); if(run(p,['rev-parse','--is-bare-repository'])!=='true') throw new GitRunnerError('NOT_BARE','Repository must be a local bare Git repository'); assertSafeLocalConfig(p); return p; }
function assertCommit(repo:string,oid:string):void { assertOid(oid,'commitOid'); if(run(repo,['cat-file','-t',oid])!=='commit') throw new GitRunnerError('MISSING_OBJECT',`Missing commit ${oid}`); }
function assertTreeSafe(repo:string,commit:string):void { const lines=run(repo,['ls-tree','-r','-z','--full-tree',commit]).split('\0').filter(Boolean); for(const line of lines){ const m=/^(\d{6}) (blob|commit) ([0-9a-f]{40})\t(.*)$/.exec(line); if(!m||m[1]==='160000'||m[2]!=='blob'||(m[1]!=='100644'&&m[1]!=='100755')) throw new GitRunnerError('UNSAFE_TREE',`Unsupported tree entry in ${commit}`); const p=m[4]; if(!p||p.startsWith('/')||p.split('/').some(x=>!x||x==='.'||x==='..'||x==='.git')) throw new GitRunnerError('UNSAFE_PATH',`Unsafe path in ${commit}`); const size=Number(run(repo,['cat-file','-s',m[3]])); if(!Number.isSafeInteger(size)||size>32*1024*1024) throw new GitRunnerError('BLOB_TOO_LARGE',`Blob exceeds 32 MiB at ${p}`); if(run(repo,['cat-file','blob',m[3]]).startsWith('version https://git-lfs.github.com/spec/v1\n')) throw new GitRunnerError('UNSUPPORTED_LFS',`LFS pointer at ${p}`); } }
const idOk=(s:string)=>/^[A-Za-z0-9_-]{1,120}$/.test(s);
function refName(r:PublishedRevision):string { if(!idOk(r.changeId)||!idOk(r.revisionId)) throw new GitRunnerError('INVALID_REF','Revision IDs contain unsupported characters'); return `refs/agent/revisions/${r.changeId}/${r.revisionId}`; }
function validateRevision(repo:string,r:PublishedRevision):void { assertCommit(repo,r.commitOid); assertOid(r.baseCommitOid,'baseCommitOid'); assertOid(r.treeOid,'treeOid'); const parents=run(repo,['rev-list','--parents','-n','1',r.commitOid]).split(/\s+/).slice(1); if(parents.length!==1||parents[0]!==r.baseCommitOid) throw new GitRunnerError('INVALID_DELTA',`Revision ${r.changeId}/${r.revisionId} must be a single-parent delta against its declared base`); if(run(repo,['rev-parse',`${r.commitOid}^{tree}`])!==r.treeOid) throw new GitRunnerError('TREE_MISMATCH',`Declared tree does not match ${r.commitOid}`); assertTreeSafe(repo,r.commitOid); }
export async function publishRevision(repository:string,remote:string,revision:PublishedRevision):Promise<void> {
 const source=resolve(repository), target=assertLocalBare(remote), ref=refName(revision); assertSafeLocalConfig(source); validateRevision(source,revision);
 let existing:string|undefined; try { existing=run(target,['rev-parse','--verify',ref]); } catch { existing=undefined; }
 if(existing) { if(existing!==revision.commitOid) throw new GitRunnerError('IMMUTABLE_REF','Revision ref already points to a different object'); return; }
 try { git(['fetch','--quiet',source,revision.commitOid],target); git(['update-ref',ref,revision.commitOid,'0000000000000000000000000000000000000000'],target); }
 catch(e) { let current:string|undefined; try { current=run(target,['rev-parse','--verify',ref]); } catch {} if(current===revision.commitOid) return; if(current) throw new GitRunnerError('IMMUTABLE_REF','Revision ref already points to a different object'); if(e instanceof GitRunnerError) throw e; throw new GitRunnerError('PUBLISH_FAILED',`Could not publish immutable ref ${ref}`); }
 const readback=run(target,['rev-parse',ref]); if(readback!==revision.commitOid) throw new GitRunnerError('PUBLISH_MISMATCH',`Published ref ${ref} did not read back the source commit`);
 validateRevision(target,revision);
}
export async function composeView(request:CompositionRequest):Promise<CompositionResult> {
 if(Array.isArray(request.revisions)&&request.revisions.length>100) throw new GitRunnerError('REVISION_LIMIT','A composition may contain at most 100 revisions');
 const repo=assertLocalBare(request.repository), baseline=request.baselineOid; assertCommit(repo,baseline); assertTreeSafe(repo,baseline);
 if(!Array.isArray(request.revisions)||request.revisions.length===0) throw new GitRunnerError('EMPTY_VIEW','At least one revision is required');
 const byKey=new Map<string,PublishedRevision>();
 for(const r of request.revisions){const key=`${r.changeId}/${r.revisionId}`;if(byKey.has(key))throw new GitRunnerError('DUPLICATE_REVISION',`Duplicate revision ${key}`);byKey.set(key,r); validateRevision(repo,r); if(run(repo,['rev-parse',refName(r)])!==r.commitOid) throw new GitRunnerError('UNPUBLISHED_REVISION',`Revision ${key} is not pinned at its immutable publication ref`);}
 const ordered:PublishedRevision[]=[], state=new Map<string,number>();
 function visit(r:PublishedRevision,stack:string[]):void { const key=`${r.changeId}/${r.revisionId}`, s=state.get(key)||0; if(s===1)throw new GitRunnerError('DEPENDENCY_CYCLE',`Dependency cycle: ${[...stack,key].join(' -> ')}`); if(s===2)return; state.set(key,1); for(const d of r.dependencies){const dep=byKey.get(`${d.changeId}/${d.revisionId}`);if(!dep)throw new GitRunnerError('MISSING_DEPENDENCY',`Missing dependency ${d.changeId}/${d.revisionId} required by ${key}`); visit(dep,[...stack,key]);} state.set(key,2); ordered.push(r); }
 for(const r of request.revisions)visit(r,[]);
 const closureTrees=new Map<string,string>([['',run(repo,['rev-parse',`${baseline}^{tree}`])]]), destinationParent=resolve(request.destination,'..');
 for(const r of ordered){const closure:PublishedRevision[]=[], seen=new Set<string>(); const collect=(x:PublishedRevision)=>{for(const d of x.dependencies){const dep=byKey.get(`${d.changeId}/${d.revisionId}`)!;const k=`${dep.changeId}/${dep.revisionId}`;if(!seen.has(k)){collect(dep);seen.add(k);closure.push(dep);}}};collect(r); const key=closure.map(x=>`${x.changeId}/${x.revisionId}`).sort().join('\0');
  if(!closureTrees.has(key)){if(closureTrees.size>=257)throw new GitRunnerError('DEPENDENCY_LIMIT','Too many distinct dependency closures');const included=new Set(closure.map(x=>`${x.changeId}/${x.revisionId}`)),scratch=`${destinationParent}/.git-runner-check-${randomUUID()}`;try{git(['clone','--quiet','--no-checkout',repo,scratch]);run(scratch,['checkout','--quiet','--detach',baseline]);for(const dep of ordered.filter(x=>included.has(`${x.changeId}/${x.revisionId}`))){try{git(['-c','user.name=Git Runner','-c','user.email=git-runner@localhost','-c','commit.gpgSign=false','cherry-pick',dep.commitOid],scratch);}catch{throw new GitRunnerError('BASE_MISMATCH',`Dependency closure cannot be materialized for ${r.changeId}/${r.revisionId}`);}}closureTrees.set(key,run(scratch,['rev-parse','HEAD^{tree}']));}finally{rmSync(scratch,{recursive:true,force:true});}}
  if(r.baseCommitOid!==baseline&&run(repo,['rev-parse',`${r.baseCommitOid}^{tree}`])!==closureTrees.get(key))throw new GitRunnerError('BASE_MISMATCH',`Declared base for ${r.changeId}/${r.revisionId} is not baseline or the full materialized dependency closure`);
 }
 const dest=resolve(request.destination); if(existsSync(dest))throw new GitRunnerError('DESTINATION_EXISTS','Composition destination must not already exist'); mkdirSync(resolve(dest,'..'),{recursive:true});
 try {
  git(['clone','--quiet','--no-checkout',repo,dest]);
  run(dest,['checkout','--quiet','--detach',baseline]);
  for(const r of ordered){ try { git(['-c','user.name=Git Runner','-c','user.email=git-runner@localhost','-c','commit.gpgSign=false','cherry-pick',r.commitOid],dest); }
   catch(e){const paths=run(dest,['diff','--name-only','--diff-filter=U']).split('\n').filter(Boolean);throw new GitRunnerError('GIT_CONFLICT',`Cherry-pick conflict for ${r.changeId}/${r.revisionId}; paths: ${paths.join(', ')||'(unknown)'}`,{changeId:r.changeId,revisionId:r.revisionId,paths,nextOwner:r.owner});} }
  const commitOid=run(dest,['rev-parse','HEAD']),treeOid=run(dest,['rev-parse','HEAD^{tree}']); assertTreeSafe(dest,commitOid);
  return {commitOid,treeOid,orderedRevisions:ordered.map(r=>({changeId:r.changeId,revisionId:r.revisionId}))};
 } catch(e) {rmSync(dest,{recursive:true,force:true});throw e;}
}

export async function composeAndPublishView(request:DurableCompositionRequest):Promise<SourceReceipt> {
 const repo=assertLocalBare(request.repository); if(!idOk(request.viewId))throw new GitRunnerError('INVALID_REF','Invalid view ID');
 const ref=`refs/agent/views/${request.viewId}`, identityRef=`refs/agent/view-identities/${request.viewId}`;
 const identity=createHash('sha256').update(JSON.stringify({baselineOid:request.baselineOid,revisions:request.revisions})).digest('hex');
 const state=()=>{let i:string|undefined,c:string|undefined;try{i=run(repo,['rev-parse','--verify',identityRef]);}catch{}try{c=run(repo,['rev-parse','--verify',ref]);}catch{}return {i,c};};
 const check=(initial:{i?:string;c?:string})=>{let s=initial;for(let attempt=0;attempt<4;attempt++){if(s.i&&s.i!==identityObject)throw new GitRunnerError('VIEW_IDENTITY_MISMATCH','View ID was already used with different inputs');if(!s.c||s.i)return s;s=state();}if(s.i&&s.i!==identityObject)throw new GitRunnerError('VIEW_IDENTITY_MISMATCH','View ID was already used with different inputs');if(s.c&&!s.i)throw new GitRunnerError('VIEW_IDENTITY_MISMATCH','View ref exists without matching input identity');return s;};
 const identityObject=execFileSync('git',['-C',repo,'-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','hash-object','-w','--stdin'],{input:identity,encoding:'utf8',env,timeout:15000,stdio:['pipe','pipe','pipe']}).trim();
 let current=check(state());
 if(!current.c){
  const scratch=`${resolve(request.destination)}.candidate-${randomUUID()}`;
  try {
   const result=await composeView({repository:repo,destination:scratch,baselineOid:request.baselineOid,revisions:request.revisions});
   git(['fetch','--quiet',scratch,result.commitOid],repo);
   current=check(state());
   if(!current.c){
    const identityUpdate=current.i?`update ${identityRef} ${identityObject} ${current.i}`:`create ${identityRef} ${identityObject}`;
    const transaction=`start\n${identityUpdate}\ncreate ${ref} ${result.commitOid}\nprepare\ncommit\n`;
    try { execFileSync('git',['-C',repo,'-c','core.hooksPath=/dev/null','-c','credential.helper=','-c','protocol.ext.allow=never','-c','protocol.file.allow=always','-c','core.fsmonitor=false','update-ref','--stdin'],{input:transaction,encoding:'utf8',env,timeout:15000,maxBuffer:1024*1024,stdio:['pipe','pipe','pipe']}); }
    catch { current=check(state());if(!current.c||!current.i)throw new GitRunnerError('VIEW_IDENTITY_MISMATCH','Concurrent View publication failed or used different inputs'); }
   }
  } finally {rmSync(scratch,{recursive:true,force:true});}
 }
 current=check(state());if(!current.c||!current.i)throw new GitRunnerError('VIEW_IDENTITY_MISMATCH','View identity and ref were not published together');
 const result=await readSourceReceipt(repo,ref);
 const destination=resolve(request.destination);
 if(existsSync(destination)){if(run(destination,['rev-parse','HEAD'])!==result.commitOid)throw new GitRunnerError('DESTINATION_EXISTS','Existing destination does not match durable View');return result;}
 mkdirSync(resolve(destination,'..'),{recursive:true});git(['clone','--quiet','--no-checkout',repo,destination]);run(destination,['checkout','--quiet','--detach',result.commitOid]);if(run(destination,['rev-parse','HEAD'])!==result.commitOid)throw new GitRunnerError('PUBLISH_MISMATCH','Destination differs from durable View ref');return result;
}
