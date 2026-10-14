import { execFile as execFileCb } from 'node:child_process';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';

const execFile = promisify(execFileCb);
const oid = /^[0-9a-f]{40}$/;
const literal = (source: string, name: string): { value: string; start: number; end: number } => {
  const re = new RegExp(`export\\s+const\\s+${name}\\s*=\\s*("(?:\\\\.|[^"\\\\])*")\\s*;`);
  const match = re.exec(source);
  if (!match || match.index === undefined) throw new Error(`Unsupported ${name} export; expected a JSON string literal`);
  return { value: JSON.parse(match[1]!) as string, start: match.index, end: match.index + match[0].length };
};
const git = async (dir: string, ...args: string[]) => (await execFile('git', ['-C', dir, ...args], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
const run = async (dir: string, ...args: string[]) => { await execFile('git', ['-C', dir, ...args], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }); };

const replacementHtml = (html: string) => html.replace(/<button[^>]*id="next-page"[^>]*>[^<]*<\/button>/,'').replace('</ul>', '</ul><button id="previous-page" type="button" disabled>Previous</button><button id="next-page" type="button" disabled>Next</button>');
const replacementScript = `const tenant=document.querySelector('#tenant'),list=document.querySelector('#projects'),status=document.querySelector('#status'),previous=document.querySelector('#previous-page'),next=document.querySelector('#next-page');
let generation=0, activeTenant=tenant.value, cursor=null, currentCursor=null, history=[];
function buttons(loading){previous.disabled=loading||history.length===0;next.disabled=loading||!cursor}
async function load(requestedCursor, tenantAtStart=tenant.value, own=++generation){activeTenant=tenantAtStart;buttons(true);status.textContent='Loading…';const q=new URLSearchParams({tenant:tenantAtStart,limit:'2'});if(requestedCursor!==null)q.set('cursor',requestedCursor);try{const response=await fetch('/api/projects?'+q);if(!response.ok)throw new Error('Request failed');const data=await response.json();if(own!==generation||tenantAtStart!==tenant.value||tenantAtStart!==activeTenant)return;list.replaceChildren(...data.items.map(p=>{const li=document.createElement('li');li.dataset.projectId=p.id;li.textContent=p.name;return li}));currentCursor=requestedCursor;cursor=data.nextCursor;status.textContent=data.items.length+' projects';buttons(false)}catch{if(own!==generation||tenantAtStart!==tenant.value||tenantAtStart!==activeTenant)return;list.replaceChildren();cursor=null;status.textContent='Could not load projects';buttons(false)}}
tenant.addEventListener('change',()=>{generation++;activeTenant=tenant.value;cursor=null;currentCursor=null;history=[];list.replaceChildren();void load(null,activeTenant,generation)});
next.addEventListener('click',()=>{if(cursor===null)return;history.push(currentCursor);void load(cursor)});
previous.addEventListener('click',()=>{if(!history.length)return;void load(history.pop())});
void load(null);`;

export async function buildTenantRepair(input: { cache: string; viewCommitOid: string; baselineCommitOid: string; workDirectory: string }): Promise<{ commitOid: string; treeOid: string }> {
  if (!oid.test(input.viewCommitOid) || !oid.test(input.baselineCommitOid)) throw new Error('Commit inputs must be exact lowercase 40-character Git object IDs');
  const cache = resolve(input.cache), work = resolve(input.workDirectory);
  if (cache === work || work.startsWith(cache + '/')) throw new Error('Work directory must be separate from the immutable cache');
  const entries = await readdir(work);
  if (entries.length) throw new Error('Work directory must be empty');
  const actualView = (await execFile('git', [`--git-dir=${cache}`, 'rev-parse', `${input.viewCommitOid}^{commit}`])).stdout.trim();
  if (actualView !== input.viewCommitOid) throw new Error('View commit did not resolve exactly');
  const actualBaseline = (await execFile('git', [`--git-dir=${cache}`, 'rev-parse', `${input.baselineCommitOid}^{commit}`])).stdout.trim();
  if (actualBaseline !== input.baselineCommitOid) throw new Error('Baseline commit did not resolve exactly');
  await run(work, 'init');
  await run(work, 'remote', 'add', 'cache', cache);
  await run(work, 'fetch', '--no-tags', 'cache', input.viewCommitOid, input.baselineCommitOid);
  await run(work, 'checkout', '--detach', input.viewCommitOid);
  const file = join(work, 'demo/seed/index.ts');
  const source = await readFile(file, 'utf8');
  const html = literal(source, 'html'), script = literal(source, 'clientScript');
  const patchedHtml = replacementHtml(html.value);
  if (!patchedHtml.includes('id="previous-page"') || !patchedHtml.includes('id="next-page"')) throw new Error('Seed HTML has no supported project-list insertion point');
  const pieces = [{ ...html, text: JSON.stringify(patchedHtml) }, { ...script, text: JSON.stringify(replacementScript) }].sort((a, b) => b.start - a.start);
  let patched = source;
  for (const part of pieces) patched = patched.slice(0, part.start) + patched.slice(part.start, part.end).replace(/"(?:\\.|[^"\\])*"/, part.text) + patched.slice(part.end);
  await writeFile(file, patched);
  await run(work, 'reset', '--soft', input.baselineCommitOid);
  await run(work, 'add', '--', 'demo/seed/index.ts');
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null', GIT_CONFIG_KEY_1: 'commit.gpgsign', GIT_CONFIG_VALUE_1: 'false', GIT_AUTHOR_NAME: 'Fixture Owner', GIT_AUTHOR_EMAIL: 'fixture-owner@example.invalid', GIT_COMMITTER_NAME: 'Fixture Owner', GIT_COMMITTER_EMAIL: 'fixture-owner@example.invalid' };
  await execFile('git', ['-C', work, '-c', 'user.name=Fixture Owner', '-c', 'user.email=fixture-owner@example.invalid', 'commit', '--no-gpg-sign', '-m', 'Repair tenant-switch race and pagination navigation'], { env, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
  const commitOid = await git(work, 'rev-parse', 'HEAD'), treeOid = await git(work, 'rev-parse', 'HEAD^{tree}'), parent = await git(work, 'rev-parse', 'HEAD^');
  if (parent !== input.baselineCommitOid || commitOid === input.viewCommitOid) throw new Error('Repair commit does not have the exact baseline parent');
  return { commitOid, treeOid };
}

export const tenantRepairClientScript = replacementScript;
