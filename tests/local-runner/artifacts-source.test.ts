import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportGitPack } from '../../packages/git-runner/export-pack.js';
import { runSourceJob } from '../../packages/local-runner/index.js';

const roots: string[] = [];
const scratch = () => { const p = mkdtempSync(join(tmpdir(), 'artifacts-source-')); roots.push(p); return p; };
afterEach(() => { vi.restoreAllMocks(); for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

describe('Artifacts source runner', () => {
  it('exports only a bounded exact commit pack and refuses oversized pack output', async () => {
    const root = scratch(), repo = join(root, 'repo'); mkdirSync(repo); execFileSync('git', ['init', '-q', repo]);
    git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.invalid');
    writeFileSync(join(repo, 'a'), 'hello'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'one');
    const oid = git(repo, 'rev-parse', 'HEAD');
    const pack = await exportGitPack(repo, oid);
    expect(Buffer.from(pack, 'base64').subarray(0, 4).toString()).toBe('PACK');
    expect(Buffer.from(pack, 'base64').byteLength).toBeLessThanOrEqual(36_000);
    expect(async () => exportGitPack(repo, oid, 1)).rejects.toThrow(/limit/i);
  });

  it('publishes an Artifacts source job through the dedicated endpoint after local publication', async () => {
    const root = scratch(), source = join(root, 'source'), remote = join(root, 'remote.git'); mkdirSync(source);
    execFileSync('git', ['init', '-q', source]); git(source, 'config', 'user.name', 'Test'); git(source, 'config', 'user.email', 'test@example.invalid');
    writeFileSync(join(source, 'a'), 'hello'); git(source, 'add', '.'); git(source, 'commit', '-qm', 'one');
    const commitOid = git(source, 'rev-parse', 'HEAD'), treeOid = git(source, 'rev-parse', 'HEAD^{tree}');
    execFileSync('git', ['init', '--bare', '-q', remote]);
    const leased = { id: 'job1', version: 1, owner: 'system', data: { input: { kind: 'seed', seedId: 'seed1', source: { commitOid, treeOid } }, status: 'leased', attemptId: 'attempt1', runnerId: 'runner', leaseExpiresAt: Date.now() + 30_000, receipt: null, error: null } };
    const client = { claimSourceJob: vi.fn().mockResolvedValue(leased), publishArtifactsSourceJob: vi.fn().mockImplementation(async (_id, envelope) => ({ ...leased, data: { ...leased.data, status: 'completed', receipt: { backend: 'artifacts-git', ref: 'refs/agent/seeds/seed1', commitOid, treeOid } } })), completeSourceJob: vi.fn() };
    const result = await runSourceJob(client as never, { remote, workspaceRoot: root, resolveRepository: () => source, requestId: 'artifacts', sourceBackend: 'artifacts-git' });
    expect(result?.data.status).toBe('completed');
    expect(client.publishArtifactsSourceJob).toHaveBeenCalledOnce();
    expect(client.publishArtifactsSourceJob.mock.calls[0]?.[1].payload).toMatchObject({ attemptId: 'attempt1', commitOid, treeOid, packBase64: expect.any(String) });
    expect(client.completeSourceJob).not.toHaveBeenCalled();
  });
});
