import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { launchIsolatedBrowser } from '../../packages/browser-test/isolated.js';

const execFile = promisify(execFileCb);
type ProbeResult = { commitOid: string; treeOid: string; passed: boolean; cases: { name: string; passed: boolean; observed: unknown }[] };

function literal(source: string, name: string): string {
  const match = source.match(new RegExp(`export\\s+const\\s+${name}\\s*=\\s*("(?:\\\\.|[^"\\\\])*")\\s*;`));
  if (!match) throw new Error(`Unsupported ${name} export; expected a JSON string literal`);
  return JSON.parse(match[1]!);
}

async function git(repository: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFile('git', [`--git-dir=${repository}`, ...args], { timeout: 5000, maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

export async function probeTenantRace(input: { repository: string; commitOid: string }): Promise<ProbeResult> {
  if (!/^[0-9a-f]{40}$/.test(input.commitOid)) throw new Error('Commit must be an exact lowercase 40-character Git object ID');
  const commitOid = await git(input.repository, 'rev-parse', `${input.commitOid}^{commit}`);
  if (commitOid !== input.commitOid) throw new Error('Commit input did not resolve to that exact commit');
  const treeOid = await git(input.repository, 'rev-parse', `${commitOid}^{tree}`);
  const result: ProbeResult = { commitOid, treeOid, passed: false, cases: [] };

  const source = (await git(input.repository, 'show', `${commitOid}:demo/seed/index.ts`));
  const html = literal(source, 'html');
  const script = literal(source, 'clientScript');
  if (!html.includes('/app.js') || !script.includes("fetch('/api/projects?")) throw new Error('Fixture shape is unsupported');
  const browser = await launchIsolatedBrowser({ timeoutMs: 55_000 });
  try {
    const session = browser.pageSessionId;
    const evaluate = async (expression: string, params: Record<string, unknown> = {}) => {
      const reply = await browser.send('Runtime.evaluate', { expression, ...params }, session);
      if (reply.exceptionDetails) throw new Error(`Isolated browser evaluation failed: ${JSON.stringify(reply.exceptionDetails)}`);
      return reply;
    };
    await browser.send('Page.navigate', { url: 'about:blank' }, session);
    await browser.send('Page.setDocumentContent', { frameId: (await browser.send('Page.getFrameTree', {}, session)).frameTree.frame.id, html: html.replace('<script type="module" src="/app.js"></script>', '') }, session);
    await new Promise(resolve => setTimeout(resolve, 50));
    const setup = `window.__pending=[];window.fetch=(url)=>new Promise(resolve=>window.__pending.push({url:String(url),resolve}));`;
    await evaluate(setup);
    await evaluate(script);
    await evaluate(`document.querySelector('#tenant').value='tenant-b';document.querySelector('#tenant').dispatchEvent(new Event('change'));`);
    const pending = await evaluate(`JSON.stringify(__pending.map(x=>x.url))`, { returnByValue: true });
    const urls = JSON.parse(pending.result.value) as string[];
    const b = urls.findIndex(x => x.includes('tenant=tenant-b'));
    const a = urls.findIndex(x => x.includes('tenant=tenant-a'));
    if (a < 0 || b < 0) throw new Error('Expected concurrent tenant A and B requests');
    const data = (id: string, name: string) => JSON.stringify({ items: [{ id, name }], nextCursor: null });
    const resolveAt = (index: number, payload: string) => evaluate(`__pending[${index}].resolve({ok:true,json:async()=>(${payload})})`, { awaitPromise: true });
    await resolveAt(b, data('b-project', 'Tenant B project'));
    await new Promise(resolve => setTimeout(resolve, 30));
    await resolveAt(a, data('a-project', 'Tenant A project'));
    await new Promise(resolve => setTimeout(resolve, 50));
    const observed = await evaluate(`JSON.stringify({tenant:document.querySelector('#tenant').value,ids:[...document.querySelectorAll('#projects [data-project-id]')].map(x=>x.dataset.projectId),status:document.querySelector('#status').textContent})`, { returnByValue: true });
    const state = JSON.parse(observed.result.value);
    const passed = state.tenant === 'tenant-b' && state.ids.length === 1 && state.ids[0] === 'b-project';
    result.cases.push({ name: 'late tenant-A response cannot overwrite tenant B', passed, observed: state });
    result.passed = passed;
    return result;
  } finally { await browser.close(); }
}

if (process.argv[1]?.endsWith('/tenant-race.ts')) {
  const [, , repository, commit] = process.argv;
  if (!repository || !commit || process.argv.length !== 4) { process.stderr.write('Usage: node --import tsx demo/cloud/tenant-race.ts REPOSITORY COMMIT\n'); process.exitCode = 2; }
  else void probeTenantRace({ repository, commitOid: commit }).then(result => { process.stdout.write(`${JSON.stringify(result)}\n`); if (!result.passed) process.exitCode = 1; }).catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}