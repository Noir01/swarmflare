import { afterEach, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPack, hashObject, encodeTree, encodeCommit, parsePack } from '../../packages/git-transport/index.js';
import { sourceRef, type SourceJobInput } from '../../packages/contracts/source.js';

let scratch: string | undefined;
afterEach(async () => { if (scratch) await rm(scratch, { recursive: true, force: true }); scratch = undefined; });

it('exports the exact composed Git commit and tree as a self-contained pack (local cache fixture; not cloud proof)', async () => {
  scratch = await mkdtemp(join(tmpdir(), 'artifacts-source-cache-'));
  const repo = join(scratch, 'cache.git');
  execFileSync('git', ['init', '--bare', '-q', repo]);
  const blob = new TextEncoder().encode('combined source\n');
  const blobOid = await hashObject({ type: 'blob', data: blob });
  const tree = encodeTree([{ mode: '100644', name: 'combined.txt', sha: blobOid }]);
  const treeOid = await hashObject({ type: 'tree', data: tree });
  const ident = { name: 'Synthetic fixture', email: 'fixture@example.invalid', timestamp: 1, timezone: '+0000' };
  const commit = encodeCommit({ tree: treeOid, parents: [], author: ident, committer: ident, message: 'composed fixture\n' });
  const commitOid = await hashObject({ type: 'commit', data: commit });
  const pack = await buildPack([{ type: 'blob', data: blob }, { type: 'tree', data: tree }, { type: 'commit', data: commit }]);
  const input = { kind: 'composition', viewId: 'view_fixture', manifest: { baseVersion: 1, baseCommitOid: 'a'.repeat(40), contractVersion: 1, policyVersion: 1, orderedRevisions: [{ changeId: 'change_fixture', revisionId: 'revision_fixture' }], excludedChangeIds: [], decisionRevisions: [], compositionVersion: 1 }, manifestDigest: 'c'.repeat(64), revisions: [{ changeId: 'change_fixture', revisionId: 'revision_fixture', owner: 'alice_fixture', baseCommitOid: 'a'.repeat(40), commitOid, treeOid, obligationIds: ['source'], decisionRevisions: [], dependencies: [] }] } as SourceJobInput;
  const parsed = await parsePack(pack);
  expect(parsed.map(object => object.sha)).toEqual(expect.arrayContaining([blobOid, treeOid, commitOid]));
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', ['--git-dir', repo, 'index-pack', '--stdin'], { stdio: ['pipe', 'ignore', 'pipe'] });
    child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error(`git index-pack exited ${code}`))); child.stdin.end(pack);
  });
  const actualCommit = execFileSync('git', ['--git-dir', repo, 'rev-parse', commitOid], { encoding: 'utf8' }).trim();
  const actualTree = execFileSync('git', ['--git-dir', repo, 'show', '-s', '--format=%T', actualCommit], { encoding: 'utf8' }).trim();
  expect({ backend: 'artifacts-git', ref: sourceRef(input), commitOid: actualCommit, treeOid: actualTree }).toEqual({ backend: 'artifacts-git', ref: 'refs/agent/views/view_fixture', commitOid, treeOid });
  expect(execFileSync('git', ['--git-dir', repo, 'show', `${commitOid}:combined.txt`], { encoding: 'utf8' })).toBe('combined source\n');
});
