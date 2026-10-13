import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSourceReceipt } from '../../packages/git-runner/index.js';
import { buildReviewArtifact } from '../../packages/local-runner/review-artifact.js';

let scratch: string | undefined;
let server: Server | undefined;
afterEach(async () => { if (server) await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; if (scratch) await rm(scratch, { recursive: true, force: true }); scratch = undefined; });

it('builds and reads back a bounded diff pinned to real baseline and candidate refs', async () => {
  scratch = await mkdtemp(join(tmpdir(), 'review-artifact-'));
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
  const repo = join(scratch, 'repo'), remote = join(scratch, 'remote.git'); await mkdir(repo); execFileSync('git', ['init', '-q', repo]);
  git(repo, 'config', 'user.name', 'Synthetic Test'); git(repo, 'config', 'user.email', 'test@example.invalid');
  await writeFile(join(repo, 'file.txt'), 'before\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base');
  const baselineCommit = git(repo, 'rev-parse', 'HEAD'), baselineTree = git(repo, 'rev-parse', 'HEAD^{tree}');
  await writeFile(join(repo, 'file.txt'), 'after\n'); git(repo, 'commit', '-qam', 'candidate');
  const candidateCommit = git(repo, 'rev-parse', 'HEAD'), candidateTree = git(repo, 'rev-parse', 'HEAD^{tree}');
  execFileSync('git', ['init', '--bare', '-q', remote]);
  git(repo, 'push', remote, `${baselineCommit}:refs/agent/seeds/base`, `${candidateCommit}:refs/agent/views/view_1`);
  const baseline = { version: 1, commitOid: baselineCommit, treeOid: baselineTree, receipt: { backend: 'local-git', ref: 'refs/agent/seeds/base', commitOid: baselineCommit, treeOid: baselineTree } };
  const view = { id: 'view_1', data: { status: 'runnable', manifestDigest: 'a'.repeat(64), receipt: { backend: 'local-git', ref: 'refs/agent/views/view_1', commitOid: candidateCommit, treeOid: candidateTree }, manifest: { baseVersion: 1, baseCommitOid: baselineCommit, contractVersion: 1, policyVersion: 1 } } };
  let stored: any;
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const url = new URL(request.url!, 'http://127.0.0.1');
    const data = url.pathname === '/baseline' ? baseline : url.pathname === '/view' ? view : url.pathname === '/artifact' ? stored : null;
    if (request.method === 'POST' && url.pathname === '/artifact') stored = { id: 'artifact1', data: JSON.parse(Buffer.concat(chunks).toString()).payload };
    const result = request.method === 'POST' ? stored : data;
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(result));
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('test server did not bind');
  const requestJson = async (path: string, method = 'GET', body?: unknown) => { const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return response.json(); };
  const readiness = { viewId: 'view_1', ready: true, applicability: { projectId: 'synthetic', viewId: 'view_1', manifestDigest: 'a'.repeat(64), composedCommitOid: candidateCommit, treeOid: candidateTree, contractVersion: 1, policyVersion: 1, checkSuiteDigest: 'c'.repeat(64) }, blockers: [], findingIds: [], reviewIds: [] };
  const client = { projectId: 'synthetic', baseline: () => requestJson('/baseline'), view: () => requestJson('/view'), readiness: async () => readiness,
    recordReviewArtifact: (_id: string, envelope: any) => requestJson('/artifact', 'POST', envelope), reviewArtifact: () => requestJson('/artifact'), views: async () => [view] } as any;
  const result = await buildReviewArtifact(client, { remote, workspaceRoot: scratch, viewId: 'view_1' });
  expect(result.data.diff.patch).toContain('-before'); expect(result.data.diff.patch).toContain('+after');
  expect(result.data.diff.files).toEqual(['file.txt']); expect(result.data.diff.truncated).toBe(false);
  expect(result.data.applicability).toMatchObject({ viewId: 'view_1', composedCommitOid: candidateCommit, treeOid: candidateTree });
  expect(result).toEqual(stored);
});

it('refuses a missing accepted baseline before source access or upload', async () => {
  scratch = await mkdtemp(join(tmpdir(), 'review-artifact-refusal-'));
  const remote = join(scratch, 'remote.git'); execFileSync('git', ['init', '--bare', '-q', remote]);
  const client = { baseline: async () => null } as any;
  await expect(buildReviewArtifact(client, { remote, workspaceRoot: scratch, viewId: 'missing' })).rejects.toThrow();
});

it('refuses unsafe repository diff configuration before artifact upload', async () => {
  scratch = await mkdtemp(join(tmpdir(), 'review-artifact-extdiff-'));
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
  const repo = join(scratch, 'repo'), remote = join(scratch, 'remote.git'), marker = join(scratch, 'host-command-ran'); await mkdir(repo); execFileSync('git', ['init', '-q', repo]);
  git(repo, 'config', 'user.name', 'Synthetic Test'); git(repo, 'config', 'user.email', 'test@example.invalid');
  await writeFile(join(repo, '.gitattributes'), '*.txt diff=hostile\n'); await writeFile(join(repo, 'file.txt'), 'before\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base');
  const baselineCommit = git(repo, 'rev-parse', 'HEAD'), baselineTree = git(repo, 'rev-parse', 'HEAD^{tree}');
  await writeFile(join(repo, 'file.txt'), 'after\n'); git(repo, 'commit', '-qam', 'candidate');
  const candidateCommit = git(repo, 'rev-parse', 'HEAD'), candidateTree = git(repo, 'rev-parse', 'HEAD^{tree}');
  execFileSync('git', ['init', '--bare', '-q', remote]); git(repo, 'push', remote, `${baselineCommit}:refs/agent/seeds/base`, `${candidateCommit}:refs/agent/views/hostile`);
  execFileSync('git', ['--git-dir', remote, 'config', 'diff.hostile.external', `touch ${marker}`]);
  const baseline = { version: 1, commitOid: baselineCommit, treeOid: baselineTree, receipt: { backend: 'local-git', ref: 'refs/agent/seeds/base', commitOid: baselineCommit, treeOid: baselineTree } };
  const view = { id: 'hostile', data: { status: 'runnable', manifestDigest: 'd'.repeat(64), receipt: { backend: 'local-git', ref: 'refs/agent/views/hostile', commitOid: candidateCommit, treeOid: candidateTree }, manifest: { baseVersion: 1, baseCommitOid: baselineCommit, contractVersion: 1, policyVersion: 1 } } };
  let stored: any;
  const readiness = { viewId: 'hostile', ready: true, applicability: { projectId: 'synthetic', viewId: 'hostile', manifestDigest: 'd'.repeat(64), composedCommitOid: candidateCommit, treeOid: candidateTree, contractVersion: 1, policyVersion: 1, checkSuiteDigest: 'c'.repeat(64) }, blockers: [], findingIds: [], reviewIds: [] };
  const client = { projectId: 'synthetic', baseline: async () => baseline, view: async () => view, readiness: async () => readiness,
    recordReviewArtifact: async (_: string, envelope: any) => stored = { id: 'hostile-artifact', data: envelope.payload }, reviewArtifact: async () => stored } as any;
  await expect(buildReviewArtifact(client, { remote, workspaceRoot: scratch, viewId: 'hostile' })).rejects.toThrow(/Unsafe local Git configuration/);
  expect(stored).toBeUndefined();
  await expect(import('node:fs/promises').then(fs => fs.access(marker))).rejects.toThrow();
});

it('caps changed paths and patch bytes and marks the diff truncated', async () => {
  scratch = await mkdtemp(join(tmpdir(), 'review-artifact-bounds-'));
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
  const repo = join(scratch, 'repo'), remote = join(scratch, 'remote.git'); await mkdir(repo); execFileSync('git', ['init', '-q', repo]);
  git(repo, 'config', 'user.name', 'Synthetic Test'); git(repo, 'config', 'user.email', 'test@example.invalid');
  await writeFile(join(repo, 'base.txt'), 'base\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base');
  const baseCommit = git(repo, 'rev-parse', 'HEAD'), baseTree = git(repo, 'rev-parse', 'HEAD^{tree}');
  for (let i = 0; i < 101; i++) await writeFile(join(repo, `file-${String(i).padStart(3, '0')}.txt`), `${String(i).padEnd(200, 'x')}\n`);
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'large candidate');
  const candidateCommit = git(repo, 'rev-parse', 'HEAD'), candidateTree = git(repo, 'rev-parse', 'HEAD^{tree}');
  execFileSync('git', ['init', '--bare', '-q', remote]); git(repo, 'push', remote, `${baseCommit}:refs/agent/seeds/base`, `${candidateCommit}:refs/agent/views/bounded`);
  const baseline = { version: 1, commitOid: baseCommit, treeOid: baseTree, receipt: { backend: 'local-git', ref: 'refs/agent/seeds/base', commitOid: baseCommit, treeOid: baseTree } };
  const view = { id: 'bounded', data: { status: 'runnable', manifestDigest: 'b'.repeat(64), receipt: { backend: 'local-git', ref: 'refs/agent/views/bounded', commitOid: candidateCommit, treeOid: candidateTree }, manifest: { baseVersion: 1, baseCommitOid: baseCommit, contractVersion: 1, policyVersion: 1 } } };
  let stored: any;
  const readiness = { viewId: 'bounded', ready: true, applicability: { projectId: 'synthetic', viewId: 'bounded', manifestDigest: 'b'.repeat(64), composedCommitOid: candidateCommit, treeOid: candidateTree, contractVersion: 1, policyVersion: 1, checkSuiteDigest: 'c'.repeat(64) }, blockers: [], findingIds: [], reviewIds: [] };
  const client = { projectId: 'synthetic', baseline: async () => baseline, view: async () => view, readiness: async () => readiness,
    recordReviewArtifact: async (_: string, envelope: any) => stored = { id: 'bounded-artifact', data: envelope.payload }, reviewArtifact: async () => stored } as any;
  const result = await buildReviewArtifact(client, { remote, workspaceRoot: scratch, viewId: 'bounded' });
  expect(result.data.diff.files).toHaveLength(100); expect(result.data.diff.truncated).toBe(true);
  expect(result.data.diff.patch.length).toBeLessThanOrEqual(16_000);
});
