import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

export async function buildCursorRepair({ cache, viewCommitOid, baselineCommitOid, workDirectory }: {
  cache: string;
  viewCommitOid: string;
  baselineCommitOid: string;
  workDirectory: string;
}): Promise<{ commitOid: string; treeOid: string }> {
  try { await lstat(workDirectory); throw new Error('Work directory already exists'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (!/^[0-9a-f]{40}$/.test(viewCommitOid) || !/^[0-9a-f]{40}$/.test(baselineCommitOid)) throw new Error('Commit inputs must be exact lowercase 40-character Git object IDs');
  const temp = await mkdtemp(join(tmpdir(), 'cursor-repair-'));
  try {
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null', GIT_CONFIG_KEY_1: 'commit.gpgsign', GIT_CONFIG_VALUE_1: 'false', GIT_AUTHOR_NAME: 'Synthetic Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Synthetic Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
    const run = async (...args: string[]) => (await execFileAsync('git', ['--git-dir', cache, ...args], { env })).stdout.trim();
    if (await run('rev-parse', `${viewCommitOid}^{commit}`) !== viewCommitOid || await run('rev-parse', `${baselineCommitOid}^{commit}`) !== baselineCommitOid) throw new Error('Commit inputs must resolve exactly');
    const source = (await execFileAsync('git', ['--git-dir', cache, 'show', `${viewCommitOid}:demo/seed/index.ts`], { env })).stdout;
    if ((source.match(/const records=/g) ?? []).length !== 1) throw new Error('Expected exactly one records declaration');
    const rewritten = source.replace('const records=', "import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';\n\nconst records=");
    const start = rewritten.indexOf('export function createProjectListHandler()');
    const end = rewritten.indexOf('\nexport const html', start);
    if (start < 0 || end < 0) throw new Error('Expected handler boundaries missing');
    const handler = `export function createProjectListHandler(){const key=randomBytes(32);return async request=>{const u=new URL(request.url),tenant=u.searchParams.get('tenant');if(request.method!=='GET'||u.pathname!=='/api/projects')return Response.json({error:'not_found'},{status:404});if(tenant!=='tenant-a'&&tenant!=='tenant-b')return Response.json({error:'unknown_tenant'},{status:400});const all=records.filter(p=>p.tenantId===tenant).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||a.id.localeCompare(b.id)),raw=u.searchParams.get('limit'),cursor=u.searchParams.get('cursor');if(raw===null){if(cursor!==null)return Response.json({error:'invalid_cursor'},{status:400});return Response.json(all)}if(!/^[1-9][0-9]*$/.test(raw)||Number(raw)>50)return Response.json({error:'invalid_limit'},{status:400});let offset=0;if(cursor!==null){try{if(!/^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]{43}$/.test(cursor))throw new Error();const [payload,signature]=cursor.split('.'),text=Buffer.from(payload,'base64url').toString('utf8');if(Buffer.from(text).toString('base64url')!==payload)throw new Error();const expected=createHmac('sha256',key).update(payload).digest(),actual=Buffer.from(signature,'base64url');if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw new Error();const decoded=JSON.parse(text);if(!decoded||Object.keys(decoded).length!==2||decoded.tenant!==tenant||!Number.isSafeInteger(decoded.offset)||decoded.offset<0||decoded.offset>=all.length||JSON.stringify({tenant:decoded.tenant,offset:decoded.offset})!==text)throw new Error();offset=decoded.offset}catch{return Response.json({error:'invalid_cursor'},{status:400})}}const items=all.slice(offset,offset+Number(raw)),next=offset+items.length,payload=Buffer.from(JSON.stringify({tenant,offset:next})).toString('base64url');return Response.json({items,nextCursor:next<all.length?payload+'.'+createHmac('sha256',key).update(payload).digest('base64url'):null})}}`;
    const output = rewritten.slice(0, start) + handler + rewritten.slice(end);
    const repo = join(temp, 'repo');
    await execFileAsync('git', ['clone', '--quiet', '--no-hardlinks', cache, repo], { env });
    await execFileAsync('git', ['-C', repo, 'checkout', '--quiet', '--detach', viewCommitOid], { env });
    await execFileAsync('git', ['-C', repo, 'reset', '--quiet', '--soft', baselineCommitOid], { env });

    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(join(repo, 'demo/seed'), { recursive: true });
    await writeFile(join(repo, 'demo/seed/index.ts'), output);
    await execFileAsync('git', ['-C', repo, 'add', '--', 'demo/seed/index.ts'], { env });
    const treeOid = (await execFileAsync('git', ['-C', repo, 'write-tree'], { env })).stdout.trim();
    const commitOid = (await execFileAsync('git', ['-C', repo, 'commit-tree', treeOid, '-p', baselineCommitOid, '-m', 'Repair cursor authentication'], { env })).stdout.trim();
    await execFileAsync('git', ['-C', repo, 'checkout', '--quiet', '--detach', commitOid], { env });
    const { cp } = await import('node:fs/promises');
    await cp(repo, workDirectory, { recursive: true, errorOnExist: true, force: false });
    return { commitOid, treeOid };
  } finally { await rm(temp, { recursive: true, force: true }); }
}