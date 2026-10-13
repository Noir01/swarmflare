import { lstat, mkdir, mkdtemp, readdir, open, realpath, writeFile, chmod, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runSandboxedNode, type SandboxExecution } from './sandbox.js';
import { applicabilitySchema, type Applicability } from '../../contracts/index.js';
import { trustedSourceArtifactDigest } from './trusted-source-digest.js';

const driverName = '.trusted-demo-driver.mjs';
const harnessVersion = 'json-oracle-v1' as const;
const checkId = 'mandatory-demo-api';
const obligationIds = ['legacy-response', 'pagination-order', 'cursor-validation', 'tenant-isolation'];
const deniedDirectories = new Set(['.git', '.ssh', '.aws', '.config', '.gnupg', '.hermes', '.npm']);
const deniedFile = /^(?:\.env(?:\..*)?|.*(?:credential|secret|private[-_]?key).*)$/i;
const oracleCases = [
  { name: 'legacyA', query: '?tenant=tenant-a' },
  { name: 'legacyB', query: '?tenant=tenant-b' },
  { name: 'firstPage', query: '?tenant=tenant-a&limit=2' },
  { name: 'secondPage', cursorFrom: 'firstPage', query: '?tenant=tenant-a&limit=2&cursor=' },
  { name: 'substituted', cursorFrom: 'firstPage', query: '?tenant=tenant-b&limit=2&cursor=' },
  { name: 'tenantB', query: '?tenant=tenant-b&limit=2' },
  { name: 'maxPage', query: '?tenant=tenant-a&limit=50' },
  ...['-1', '0', '1.5', '51', '', 'wat'].map((limit) => ({ name: `invalidLimit-${limit === '' ? 'empty' : limit}`, query: `?tenant=tenant-a&limit=${limit}` })),
  { name: 'malformed', query: '?tenant=tenant-a&limit=2&cursor=%%%' },
  { name: 'badCursor', query: '?tenant=tenant-a&limit=2&cursor=not-a-cursor' },
  { name: 'cursorWithoutLimit', cursorFrom: 'firstPage', query: '?tenant=tenant-a&cursor=' },
  { name: 'unknownTenant', query: '?tenant=unknown&limit=2' },
  { name: 'wrongMethod', method: 'POST', query: '?tenant=tenant-a' },
  { name: 'wrongPath', path: '/api/not-projects', query: '?tenant=tenant-a' },
];
const expected = [
  { id: 'a-project-01', name: 'Tenant A: Atlas', tenantId: 'tenant-a', createdAt: '2025-01-03T12:00:00.000Z' },
  { id: 'a-project-02', name: 'Tenant A: Beacon', tenantId: 'tenant-a', createdAt: '2025-01-02T12:00:00.000Z' },
  { id: 'a-project-03', name: 'Tenant A: Cedar', tenantId: 'tenant-a', createdAt: '2025-01-02T12:00:00.000Z' },
];
const expectedByTenant = {
  'tenant-a': expected,
  'tenant-b': [
    { id: 'b-project-01', name: 'Tenant B: Delta', tenantId: 'tenant-b', createdAt: '2025-01-04T12:00:00.000Z' },
    { id: 'b-project-02', name: 'Tenant B: Echo', tenantId: 'tenant-b', createdAt: '2025-01-02T12:00:00.000Z' },
  ],
};
const driver = `
const NativeRequest = Request;
const writeOutput = process.stdout.write.bind(process.stdout);
const stringifyJson = JSON.stringify.bind(JSON);
const encode = encodeURIComponent;
const { createProjectListHandler } = await import('./demo/seed/index.ts');
const handler = createProjectListHandler();
const observations = {};
async function observe(name, query, method='GET', path='/api/projects') {
  try { const response = await handler(new NativeRequest('http://localhost' + path + query, {method})); observations[name] = { status: response.status, body: await response.text() }; }
  catch (error) { observations[name] = { error: String(error?.message ?? error) }; }
}
await observe('legacyA', '?tenant=tenant-a');
await observe('legacyB', '?tenant=tenant-b');
await observe('firstPage', '?tenant=tenant-a&limit=2');
let cursor = '';
try { cursor = JSON.parse(observations.firstPage.body).nextCursor ?? ''; } catch {}
await observe('secondPage', '?tenant=tenant-a&limit=2&cursor=' + encode(cursor));
await observe('substituted', '?tenant=tenant-b&limit=2&cursor=' + encode(cursor));
await observe('tenantB', '?tenant=tenant-b&limit=2');
await observe('maxPage', '?tenant=tenant-a&limit=50');
for (const [name, limit] of [['invalidLimit--1','-1'],['invalidLimit-0','0'],['invalidLimit-1.5','1.5'],['invalidLimit-51','51'],['invalidLimit-empty',''],['invalidLimit-wat','wat']]) await observe(name, '?tenant=tenant-a&limit=' + limit);
await observe('malformed', '?tenant=tenant-a&limit=2&cursor=%%%');
await observe('badCursor', '?tenant=tenant-a&limit=2&cursor=not-a-cursor');
await observe('cursorWithoutLimit', '?tenant=tenant-a&cursor=' + encode(cursor));
await observe('unknownTenant', '?tenant=unknown&limit=2');
await observe('wrongMethod', '?tenant=tenant-a', 'POST');
await observe('wrongPath', '?tenant=tenant-a', 'GET', '/api/not-projects');
// Exhaust limit=1 traversal; order (including ties) is independently checked by the host.
const traversal=[]; let pageCursor='';
for(let i=0;i<10;i++){const q='?tenant=tenant-a&limit=1'+(pageCursor?'&cursor='+encode(pageCursor):'');await observe('traversal'+i,q);const o=JSON.parse(observations['traversal'+i].body);if(o.items?.length!==1)break;traversal.push(...o.items);if(o.nextCursor===null)break;pageCursor=o.nextCursor;}
observations.traversal={status:200,body:JSON.stringify(traversal)};
writeOutput(stringifyJson({ observations }));
`;

export interface DemoCheckReceipt {
  kind: 'recorded-check'; checkId: string; obligationIds: string[]; applicability: Applicability; harnessVersion: typeof harnessVersion;
  result: 'passed' | 'failed'; execution: SandboxExecution;
}

async function copyCandidate(source: string, destination: string, state: { files: number; bytes: number }, depth = 0): Promise<void> {
  if (depth > 32) throw new Error('Candidate exceeds maximum snapshot depth');
  for (const name of await readdir(source)) {
    if (deniedDirectories.has(name.toLowerCase()) || deniedFile.test(name)) continue;
    if (name === driverName) throw new Error('Candidate collides with reserved trusted demo driver');
    const from = join(source, name), to = join(destination, name), st = await lstat(from);
    if (st.isSymbolicLink()) throw new Error('Candidate contains a symlink');
    if (st.isDirectory()) { await mkdir(to, { mode: 0o755 }); await copyCandidate(from, to, state, depth + 1); await chmod(to, 0o555); }
    else if (st.isFile()) {
      if (++state.files > 1000 || st.size > 4 * 1024 * 1024 || state.bytes + st.size > 20 * 1024 * 1024) throw new Error('Candidate exceeds snapshot size limits');
      const handle = await open(from, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes: Buffer;
      try {
        const fresh = await handle.stat();
        if (!fresh.isFile() || fresh.ino !== st.ino || fresh.dev !== st.dev) throw new Error('Candidate changed during snapshot');
        const chunks: Buffer[] = []; let total = 0;
        while (true) {
          const chunk = Buffer.alloc(64 * 1024);
          const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
          if (bytesRead === 0) break;
          total += bytesRead;
          if (total > 4 * 1024 * 1024 || state.bytes + total > 20 * 1024 * 1024) throw new Error('Candidate exceeds snapshot size limits');
          chunks.push(chunk.subarray(0, bytesRead));
        }
        bytes = Buffer.concat(chunks, total);
      } finally { await handle.close(); }
      state.bytes += bytes.length;
      await mkdir(dirname(to), { recursive: true, mode: 0o755 }); await writeFile(to, bytes, { mode: 0o444 });
    } else throw new Error('Candidate contains a non-regular file');
  }
}

export function demoSuiteDigest(): string { return trustedSourceArtifactDigest(new URL('./demo-suite.ts', import.meta.url)); }

function evaluateOracle(execution: SandboxExecution): boolean {
  if (execution.status !== 'exited' || execution.exitCode !== 0 || execution.stdout.length > 8192) return false;
  try {
    const parsed = JSON.parse(execution.stdout) as { observations: Record<string, { status?: number; body?: string; error?: string }> };
    if (!parsed || Object.keys(parsed).length !== 1 || !parsed.observations || Object.keys(parsed.observations).length !== 23) return false;
    const observations = parsed.observations;
    const body = (name: string): { status: number; value: any } => {
      const result = observations[name];
      if (!result || result.error || typeof result.body !== 'string' || !Number.isInteger(result.status)) throw new Error('missing observation');
      return { status: result.status!, value: JSON.parse(result.body) };
    };
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const legacyA = body('legacyA'), legacyB = body('legacyB'), first = body('firstPage'), second = body('secondPage');
    const maxPage = body('maxPage'), tenantB = body('tenantB'), traversal = body('traversal');
    const invalid = ['invalidLimit--1','invalidLimit-0','invalidLimit-1.5','invalidLimit-51','invalidLimit-empty','invalidLimit-wat'];
    const errors = ['malformed','badCursor','substituted','cursorWithoutLimit','unknownTenant'];
    return legacyA.status === 200 && same(legacyA.value, expectedByTenant['tenant-a']) &&
      legacyB.status === 200 && same(legacyB.value, expectedByTenant['tenant-b']) &&
      first.status === 200 && same(first.value.items, expected.slice(0, 2)) && typeof first.value.nextCursor === 'string' &&
      second.status === 200 && same(second.value.items, expected.slice(2)) && second.value.nextCursor === null &&
      maxPage.status === 200 && same(maxPage.value.items, expected) && maxPage.value.nextCursor === null &&
      tenantB.status === 200 && same(tenantB.value.items, expectedByTenant['tenant-b']) && tenantB.value.nextCursor === null &&
      invalid.every((name) => body(name).status === 400) && errors.every((name) => body(name).status === 400) &&
      body('wrongMethod').status === 404 && body('wrongPath').status === 404 &&
      traversal.status === 200 && same(traversal.value, expected) && traversal.value.length === expected.length &&
      [0, 1, 2].every((i) => body(`traversal${i}`).status === 200 && body(`traversal${i}`).value.items?.length === 1 &&
        same(body(`traversal${i}`).value.items[0], expected[i]) &&
        (i < 2 ? typeof body(`traversal${i}`).value.nextCursor === 'string' && body(`traversal${i}`).value.nextCursor !== (i === 0 ? '' : body(`traversal${i - 1}`).value.nextCursor) : body(`traversal${i}`).value.nextCursor === null));
  } catch { return false; }
}

export async function runDemoSuite(options: { candidateDirectory: string; applicability: Applicability }): Promise<DemoCheckReceipt[]> {
  const applicability = applicabilitySchema.parse(options.applicability);
  if (applicability.checkSuiteDigest !== demoSuiteDigest()) throw new Error('Applicability check suite digest does not match trusted demo suite');
  const source = await realpath(options.candidateDirectory);
  const root = await mkdtemp(join(tmpdir(), 'git-runner-demo-stage-'));
  try {
    const srcStat = await lstat(options.candidateDirectory);
    if (srcStat.isSymbolicLink()) throw new Error('Candidate directory must not be a symlink');
    const staged = join(root, 'candidate'); await mkdir(staged, { mode: 0o755 });
    await copyCandidate(source, staged, { files: 0, bytes: 0 });
    const entry = join(staged, 'demo/seed/index.ts');
    const entryStat = await lstat(entry);
    if (!entryStat.isFile() || entryStat.isSymbolicLink()) throw new Error('Candidate must provide regular demo/seed/index.ts');
    await writeFile(join(staged, driverName), driver, { mode: 0o444 });
    await chmod(staged, 0o555);
    const execution = await runSandboxedNode({ candidateDirectory: staged, entrypoint: driverName, timeoutMs: 5000, maxOutputBytes: 8192 });
    const passed = evaluateOracle(execution);
    return [{ kind: 'recorded-check', checkId, obligationIds: [...obligationIds], applicability, harnessVersion, result: passed ? 'passed' : 'failed', execution }];
  } finally {
    const unlock = async (path: string): Promise<void> => {
      try {
        await chmod(path, 0o700);
        for (const name of await readdir(path)) {
          const child = join(path, name);
          if ((await lstat(child)).isDirectory()) await unlock(child);
          else await chmod(child, 0o600);
        }
      } catch { /* best-effort cleanup */ }
    };
    await unlock(root);
    await rm(root, { recursive: true, force: true });
  }
}
