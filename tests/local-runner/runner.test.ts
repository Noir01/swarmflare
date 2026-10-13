import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SourceJob } from '../../packages/contracts/source.js';
import { runSourceJob } from '../../packages/local-runner/index.js';

const roots: string[] = [];
const scratch = () => { const path = mkdtempSync(join(tmpdir(), 'local-runner-')); roots.push(path); return path; };
afterEach(() => { vi.restoreAllMocks(); for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const job = (input: SourceJob['data']['input']): SourceJob => ({ id: 'job1', version: 1, owner: 'system', data: { input, status: 'leased', attemptId: 'attempt1', runnerId: 'runner', leaseExpiresAt: Date.now() + 30_000, receipt: null, error: null } });
const client = (source: SourceJob) => ({ claimSourceJob: vi.fn().mockResolvedValue(source), completeSourceJob: vi.fn().mockImplementation(async (_id, envelope) => ({ ...source, data: { ...source.data, status: envelope.payload.ok ? 'completed' : 'failed', receipt: envelope.payload.ok ? envelope.payload.receipt : null } })) });

describe('runSourceJob', () => {
  it('retries the same request after transient completion failure without submitting a failed job', async () => {
    const root = scratch(), source = join(root, 'source'), remote = join(root, 'remote.git');
    mkdirSync(source); execFileSync('git', ['init', '-q', source]); git(source, 'config', 'user.name', 'Test'); git(source, 'config', 'user.email', 'test@example.invalid');
    writeFileSync(join(source, 'file.txt'), 'seed'); git(source, 'add', '.'); git(source, 'commit', '-qm', 'seed');
    const commitOid = git(source, 'rev-parse', 'HEAD'), treeOid = git(source, 'rev-parse', 'HEAD^{tree}');
    execFileSync('git', ['init', '--bare', '-q', remote]);
    const sourceJob = job({ kind: 'seed', seedId: 'retry-seed', source: { commitOid, treeOid } });
    let completions = 0;
    const c = { claimSourceJob: vi.fn().mockResolvedValue(sourceJob), completeSourceJob: vi.fn().mockImplementation(async (_id, envelope) => {
      completions++;
      if (completions === 1) throw Object.assign(new Error('sensitive remote detail'), { code: 'TEMPORARY' });
      return { ...sourceJob, data: { ...sourceJob.data, status: 'completed', receipt: envelope.payload.receipt } };
    }) };
    const options = { remote, workspaceRoot: root, resolveRepository: () => source, requestId: 'retry-run' };
    await expect(runSourceJob(c as never, options)).rejects.toThrow('sensitive remote detail');
    expect(c.completeSourceJob.mock.calls[0]?.[1].payload.ok).toBe(true);
    const result = await runSourceJob(c as never, options);
    expect(result?.data.status).toBe('completed');
    expect(c.claimSourceJob).toHaveBeenCalledTimes(2);
    expect(c.claimSourceJob.mock.calls[0]?.[0].requestId).toBe(c.claimSourceJob.mock.calls[1]?.[0].requestId);
    expect(c.completeSourceJob.mock.calls.map((call) => call[1].requestId)).toEqual(['retry-run-attempt1-complete', 'retry-run-attempt1-complete']);
    expect(git(remote, 'rev-parse', 'refs/agent/seeds/retry-seed')).toBe(commitOid);
  });

  it('returns null for an empty queue and rejects malformed or unleased jobs', async () => {
    const c = { claimSourceJob: vi.fn().mockResolvedValue(null), completeSourceJob: vi.fn() };
    expect(await runSourceJob(c as never, { remote: '', workspaceRoot: '', resolveRepository: () => '', requestId: 'empty' })).toBeNull();
    for (const invalid of [{ id: 'bad' }, { ...job({ kind: 'seed', seedId: 'x', source: { commitOid: 'bad', treeOid: 'bad' } }), data: { ...job({ kind: 'seed', seedId: 'x', source: { commitOid: 'bad', treeOid: 'bad' } }).data, status: 'queued' } }]) {
      const invalidClient = { claimSourceJob: vi.fn().mockResolvedValue(invalid), completeSourceJob: vi.fn() };
      await expect(runSourceJob(invalidClient as never, { remote: '', workspaceRoot: '', resolveRepository: () => '', requestId: 'invalid' })).rejects.toThrow();
      expect(invalidClient.completeSourceJob).not.toHaveBeenCalled();
    }
  });

  it('rejects request IDs that leave no room for completion suffix before claiming', async () => {
    const c = { claimSourceJob: vi.fn(), completeSourceJob: vi.fn() };
    await expect(runSourceJob(c as never, { remote: '', workspaceRoot: '', resolveRepository: () => '', requestId: 'x'.repeat(120) })).rejects.toThrow();
    expect(c.claimSourceJob).not.toHaveBeenCalled();
  });

  it('seeds the authoritative bare repository and completes with its read-back receipt', async () => {
    const root = scratch(), source = join(root, 'source'), remote = join(root, 'remote.git');
    mkdirSync(source); execFileSync('git', ['init', '-q', source]); git(source, 'config', 'user.name', 'Test'); git(source, 'config', 'user.email', 'test@example.invalid');
    writeFileSync(join(source, 'file.txt'), 'seed'); git(source, 'add', '.'); git(source, 'commit', '-qm', 'seed');
    const commitOid = git(source, 'rev-parse', 'HEAD'), treeOid = git(source, 'rev-parse', 'HEAD^{tree}');
    execFileSync('git', ['init', '--bare', '-q', remote]);
    const c = client(job({ kind: 'seed', seedId: 'seed1', source: { commitOid, treeOid } }));
    const result = await runSourceJob(c as never, { remote, workspaceRoot: root, resolveRepository: () => source, requestId: 'run1' });
    expect(result?.data.status).toBe('completed');
    expect(c.completeSourceJob.mock.calls[0]?.[1].payload.receipt).toMatchObject({ backend: 'local-git', commitOid, treeOid, ref: 'refs/agent/seeds/seed1' });
  });

  it('publishes a revision and composes a View into the bare repository', async () => {
    const root = scratch(), source = join(root, 'source'), remote = join(root, 'remote.git');
    mkdirSync(source); execFileSync('git', ['init', '-q', source]); git(source, 'config', 'user.name', 'Test'); git(source, 'config', 'user.email', 'test@example.invalid');
    writeFileSync(join(source, 'base.txt'), 'base'); git(source, 'add', '.'); git(source, 'commit', '-qm', 'base');
    const baseCommitOid = git(source, 'rev-parse', 'HEAD'), baseTreeOid = git(source, 'rev-parse', 'HEAD^{tree}');
    writeFileSync(join(source, 'change.txt'), 'change'); git(source, 'add', '.'); git(source, 'commit', '-qm', 'change');
    const commitOid = git(source, 'rev-parse', 'HEAD'), treeOid = git(source, 'rev-parse', 'HEAD^{tree}');
    execFileSync('git', ['init', '--bare', '-q', remote]);
    const seedClient = client(job({ kind: 'seed', seedId: 'seed2', source: { commitOid: baseCommitOid, treeOid: baseTreeOid } }));
    await runSourceJob(seedClient as never, { remote, workspaceRoot: root, resolveRepository: () => source, requestId: 'seed-run' });
    const revision = { changeId: 'change2', revisionId: 'revision2', owner: 'alice', baseCommitOid, commitOid, treeOid, obligationIds: ['obligation1'], decisionRevisions: [], dependencies: [] };
    const publicationClient = client(job({ kind: 'publication', revision }));
    const published = await runSourceJob(publicationClient as never, { remote, workspaceRoot: root, resolveRepository: () => source, requestId: 'publish-run' });
    expect(published?.data.status).toBe('completed');
    expect(publicationClient.completeSourceJob.mock.calls[0]?.[1].payload.receipt).toMatchObject({ ref: 'refs/agent/revisions/change2/revision2', commitOid, treeOid });
    const manifest = { baseVersion: 1, baseCommitOid, contractVersion: 1, policyVersion: 1, orderedRevisions: [{ changeId: 'change2', revisionId: 'revision2' }], excludedChangeIds: [], decisionRevisions: [], compositionVersion: 1 };
    const manifestDigest = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
    const compositionJob = job({ kind: 'composition', viewId: 'view2', manifest, manifestDigest, revisions: [revision] });
    const compositionClient = client(compositionJob);
    const composed = await runSourceJob(compositionClient as never, { remote, workspaceRoot: root, resolveRepository: () => { throw new Error('composition uses the authoritative bare repository'); }, requestId: 'compose-run' });
    expect(composed?.data.status, JSON.stringify(compositionClient.completeSourceJob.mock.calls[0]?.[1].payload)).toBe('completed');
    const receipt = compositionClient.completeSourceJob.mock.calls[0]?.[1].payload.receipt;
    expect(receipt).toMatchObject({ backend: 'local-git', ref: 'refs/agent/views/view2' });
    expect(git(remote, 'show', `${receipt.commitOid}:change.txt`)).toBe('change');
  });

  it('preserves a dirty pre-existing composition destination when composition rejects it', async () => {
    const root = scratch(), remote = join(root, 'remote.git'), source = join(root, 'source'), destination = join(root, 'views', 'view1');
    mkdirSync(source); execFileSync('git', ['init', '-q', source]); git(source, 'config', 'user.name', 'Test'); git(source, 'config', 'user.email', 'test@example.invalid');
    writeFileSync(join(source, 'file.txt'), 'base'); git(source, 'add', '.'); git(source, 'commit', '-qm', 'base');
    const baseCommitOid = git(source, 'rev-parse', 'HEAD'), treeOid = git(source, 'rev-parse', 'HEAD^{tree}');
    execFileSync('git', ['init', '--bare', '-q', remote]);
    mkdirSync(destination, { recursive: true }); writeFileSync(join(destination, 'dirty.txt'), 'keep me');
    const revision = { changeId: 'change1', revisionId: 'revision1', owner: 'alice', baseCommitOid, commitOid: baseCommitOid, treeOid, obligationIds: ['obligation1'], decisionRevisions: [], dependencies: [] };
    const sourceJob = job({ kind: 'composition', viewId: 'view1', manifest: { baseVersion: 1, baseCommitOid, contractVersion: 1, policyVersion: 1, orderedRevisions: [{ changeId: 'change1', revisionId: 'revision1' }], excludedChangeIds: [], decisionRevisions: [], compositionVersion: 1 }, manifestDigest: 'a'.repeat(64), revisions: [revision] });
    const c = client(sourceJob);
    const result = await runSourceJob(c as never, { remote, workspaceRoot: root, resolveRepository: () => { throw new Error('composition must not resolve arbitrary source input'); }, requestId: 'run2' });
    expect(result?.data.status).toBe('failed');
    expect(readFileSync(join(destination, 'dirty.txt'), 'utf8')).toBe('keep me');
    expect(c.completeSourceJob.mock.calls[0]?.[1].payload).toMatchObject({ ok: false });
  });
});
