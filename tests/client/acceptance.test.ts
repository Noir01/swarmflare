import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceClient } from '../../packages/client/index.js';
import { verifyViewSource } from '../../packages/local-runner/checks.js';
import type { ViewResource } from '../../packages/contracts/source.js';
import type { Applicability } from '../../packages/contracts/index.js';

const applicability: Applicability = { projectId: 'p1', viewId: 'view1', manifestDigest: 'c'.repeat(64), composedCommitOid: 'a'.repeat(40), treeOid: 'b'.repeat(40), contractVersion: 1, policyVersion: 1, checkSuiteDigest: 'd'.repeat(64) };
const receipt = { backend: 'local-git' as const, ref: 'refs/agent/views/view1', commitOid: 'a'.repeat(40), treeOid: 'b'.repeat(40) };
const viewResource = (sourceReceipt = receipt): ViewResource => ({ id: 'view1', version: 1, owner: 'human', data: { manifest: { baseVersion: 1, baseCommitOid: 'a'.repeat(40), contractVersion: 1, policyVersion: 1, orderedRevisions: [{ changeId: 'change1', revisionId: 'revision1' }], excludedChangeIds: [], decisionRevisions: [], compositionVersion: 1 }, manifestDigest: 'c'.repeat(64), jobId: 'job1', status: 'runnable', receipt: sourceReceipt, error: null } });
const envelope = (payload: unknown) => ({ requestId: 'acceptance-1', payload });
const response = (resource: unknown) => new Response(JSON.stringify({ apiVersion: 1, resource, sequence: 1, version: 1 }), { headers: { 'content-type': 'application/json' } });

describe('typed local acceptance client seam', () => {
  it('uses typed exact routes and validates typed request and response data', async () => {
    const seen: string[] = [];
    const policy = { id: 'policy1', version: 1, owner: 'human', data: { contractVersion: 1, checkSuiteDigest: 'a'.repeat(64), harnessVersion: 'json-oracle-v1', checks: [{ id: 'check', obligationIds: ['o1'] }], requireIndependentReview: true, sourceBackend: 'local-git' as const } };
    const confirmation = { id: 'confirmation1', version: 1, owner: 'human', data: { applicability, expectedBaselineVersion: 1, expectedBaselineCommitOid: 'a'.repeat(40), readinessSequence: 1, expiresAt: Date.now() + 10000, used: false } };
    const acceptance = { id: 'acceptance1', version: 1, owner: 'human', data: { applicability, confirmationId: 'confirmation1', oldBaseline: { version: 1, commitOid: 'a'.repeat(40), treeOid: 'b'.repeat(40), receipt }, newBaseline: { version: 2, commitOid: 'a'.repeat(40), treeOid: 'b'.repeat(40), receipt }, acceptedAt: new Date().toISOString() } };
    const client = new WorkspaceClient({ baseUrl: 'https://local.test', projectId: 'p1', token: 'synthetic-test-only', fetch: async (input, init) => {
      const url = new URL(String(input)); seen.push(`${init?.method} ${url.pathname}`);
      if (init?.method === 'POST') expect(JSON.parse(String(init.body)).payload).toBeTruthy();
      if (url.pathname.endsWith('/policy') && init?.method === 'GET') return response(policy);
      if (url.pathname.endsWith('/policy')) return response(policy);
      if (url.pathname.includes('/confirmations')) return response(confirmation);
      if (url.pathname === '/api/v1/projects/p1/acceptances') return response(acceptance);
      if (url.pathname.endsWith('/acceptances/acceptance1')) return response(acceptance);
      throw new Error(`unexpected route ${url.pathname}`);
    }});
    await client.policy();
    await client.configurePolicy(envelope(policy.data));
    await client.confirmView('view1', envelope({ applicability, expectedBaselineVersion: 1, expectedBaselineCommitOid: 'a'.repeat(40), readinessSequence: 1, confirm: true }));
    await client.acceptView(envelope({ confirmationId: 'confirmation1', applicability, expectedBaselineVersion: 1, expectedBaselineCommitOid: 'a'.repeat(40), readinessSequence: 2 }));
    await client.acceptance('acceptance1');
    expect(seen.map(item => item.replace('/api/v1/projects/p1', ''))).toEqual(['GET /policy', 'POST /policy', 'POST /views/view1/confirmations', 'POST /acceptances', 'GET /acceptances/acceptance1']);
    const before = seen.length;
    await expect(client.acceptView(envelope({ confirmationId: 'confirmation1', applicability: {}, expectedBaselineVersion: 1, expectedBaselineCommitOid: 'a'.repeat(40), readinessSequence: 2 }))).rejects.toThrow();
    expect(seen).toHaveLength(before);
  });

  it('verifies the actual bare Git ref before runner attestation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'acceptance-client-'));
    try {
      const source = join(root, 'source'), remote = join(root, 'remote.git');
      await mkdir(source); execFileSync('git', ['init', '-q', source]);
      execFileSync('git', ['-C', source, 'config', 'user.name', 'Synthetic Test']); execFileSync('git', ['-C', source, 'config', 'user.email', 'test@example.invalid']);
      await writeFile(join(source, 'file.txt'), 'synthetic\n'); execFileSync('git', ['-C', source, 'add', '.']); execFileSync('git', ['-C', source, 'commit', '-qm', 'test']);
      const commitOid = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      const treeOid = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
      const actualReceipt = { ...receipt, commitOid, treeOid };
      const actualView = viewResource(actualReceipt);
      execFileSync('git', ['init', '--bare', '-q', remote]);
      const calls: string[] = [];
      const client = new WorkspaceClient({ baseUrl: 'https://local.test', projectId: 'p1', token: 'synthetic-test-only', fetch: async (input, init) => {
        const url = new URL(String(input)); calls.push(`${init?.method} ${url.pathname}`);
        if (url.pathname.endsWith('/views/view1')) return response(actualView);
        expect(url.pathname).toContain('/source-verifications');
        return response({ id: 'verification1', version: 1, owner: 'runner', data: { viewId: 'view1', receipt: actualReceipt, verifiedAt: Date.now() } });
      }});
      await expect(verifyViewSource(client, { remote, viewId: 'view1', requestId: 'missing' })).rejects.toThrow();
      expect(calls.filter(x => x.includes('/source-verifications'))).toHaveLength(0);
      execFileSync('git', ['-C', source, 'push', remote, 'HEAD:refs/agent/views/view1']);
      const verified = await verifyViewSource(client, { remote, viewId: 'view1', requestId: 'valid' });
      expect(verified.data.receipt).toEqual(actualReceipt);
      expect(calls.filter(x => x.includes('/source-verifications'))).toHaveLength(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
