import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parsePhase, prepareRepository } from '../../demo/cloud/candidate-smoke.js';
import { preparedPaginatedDemo } from '../fixtures/paginated-demo.js';
let root:string|undefined;
afterEach(async()=>{if(root)await rm(root,{recursive:true,force:true});root=undefined;});
const run=(...args:string[])=>execFileSync('git',args,{encoding:'utf8',stdio:['ignore','pipe','ignore'],env:{PATH:process.env.PATH,HOME:'/nonexistent',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_AUTHOR_NAME:'fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'}}).trim();
it('accepts only explicit bounded candidate phases',()=>{for(const p of ['prepare','revision','view','checks'])expect(parsePhase(p)).toBe(p);for(const p of ['accept','confirm','repair','https://example.test',undefined])expect(()=>parsePhase(p)).toThrow('INVALID_PHASE');});
it('creates a real full single-parent trusted fixture against the exact baseline and retains original bytes',async()=>{
 root=await mkdtemp(join(tmpdir(),'candidate-prepare-'));const seed=join(root,'seed'),cache=join(root,'cache.git'),work=join(root,'work');run('init','-q',seed);await writeFile(join(seed,'README.md'),'Original native-style README\n');run('-C',seed,'add','README.md');run('-C',seed,'commit','-qm','seed');const baseline=run('-C',seed,'rev-parse','HEAD');run('clone','--bare','-q',seed,cache);const result=await prepareRepository(cache,work,baseline);expect(result.commitOid).not.toBe(baseline);expect(run('-C',work,'rev-parse','HEAD^')).toBe(baseline);expect(run('-C',work,'rev-parse','HEAD^{tree}')).toBe(result.treeOid);expect(await readFile(join(work,'README.md'),'utf8')).toBe('Original native-style README\n');expect(await readFile(join(work,'demo/seed/index.ts'),'utf8')).toBe(preparedPaginatedDemo+'\n');expect(run('--git-dir',cache,'rev-parse','HEAD')).toBe(baseline);await expect(prepareRepository(cache,work,baseline)).rejects.toThrow('WORK_ALREADY_EXISTS');
});
it('refuses malformed baseline identifiers before creating a repository',async()=>{root=await mkdtemp(join(tmpdir(),'candidate-invalid-'));await expect(prepareRepository(join(root,'cache'),join(root,'work'),'A'.repeat(40))).rejects.toThrow('INVALID_BASELINE');});
