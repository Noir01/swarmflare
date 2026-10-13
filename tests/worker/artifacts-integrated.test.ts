import { afterEach, expect, it, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { Project } from '../../apps/worker/src/project/index';
import { ArtifactsSourceStore } from '../../packages/artifacts-source/index';
import { sourceRef } from '../../packages/contracts/source';

// Coordinator integration oracle: real HTTP/SQLite Project, fake source-store boundary.
// Protocol/object correctness is separately exercised against real local Git.
// Nothing here qualifies remote Artifacts or constitutes human acceptance.
afterEach(() => vi.restoreAllMocks());
it('publishes seed, revision and composed View then independently verifies the source', async () => {
  const projectId = `artifacts-integrated-${crypto.randomUUID()}`;
  const remote = 'https://fixture.artifacts.cloudflare.net/git/demo/source.git';
  const source = new Map<string, { backend: 'artifacts-git'; ref: string; commitOid: string; treeOid: string }>();
  const publish = vi.spyOn(ArtifactsSourceStore.prototype, 'publish').mockImplementation(async input => {
    const receipt = { backend: 'artifacts-git' as const, ref: sourceRef(input.input), commitOid: input.commitOid, treeOid: input.treeOid };
    source.set(receipt.ref, receipt);
    return receipt;
  });
  const read = vi.spyOn(ArtifactsSourceStore.prototype, 'read').mockImplementation(async expected => {
    const receipt = source.get(expected.ref);
    if (!receipt || receipt.commitOid !== expected.commitOid || receipt.treeOid !== expected.treeOid) throw new Error('SOURCE_READBACK_MISMATCH');
    return receipt;
  });
  const stub = env.PROJECTS.get(env.PROJECTS.idFromName(projectId));
  await runInDurableObject(stub, async (_instance, state) => {
    const configured = new Project(state, { ...env,
      ARTIFACTS: { get: async () => { throw new Error('Fake store boundary must not request real capabilities'); } },
      ARTIFACTS_SOURCE_CONFIG: JSON.stringify({ projectId, repository: 'demo/source', remote, allowWrites: true }),
    } as Env);
    const request = async (role: string, path: string, payload?: unknown, expectedVersion?: number, requestId = crypto.randomUUID() as string) => {
      const response = await configured.fetch(new Request(`https://internal${path}`, {
        method: payload === undefined ? 'GET' : 'POST',
        headers: { 'x-project-id': projectId, 'x-actor': JSON.stringify({ id: role, role, projectId }), 'content-type': 'application/json' },
        body: payload === undefined ? undefined : JSON.stringify({ requestId, expectedVersion, payload }),
      }));
      return { status: response.status, body: await response.json() as any };
    };
    const ok = async (...args: Parameters<typeof request>) => {
      const response = await request(...args);
      expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
      return response.body.resource;
    };
    const proposal = await ok('human', '/contracts/proposals', {
      outcome: 'Synthetic Artifacts source lifecycle', constraints: [],
      obligations: [{ id: 'source', description: 'Exact source', acceptanceExamples: [] }], requiredCheckIds: ['check'], unresolvedQuestions: [],
    });
    await ok('human', `/contracts/${proposal.id}/approve`, {}, 0);
    await ok('human', '/policy', { contractVersion: 1, checkSuiteDigest: 'd'.repeat(64), harnessVersion: 'json-oracle-v1', checks: [{ id: 'check', obligationIds: ['source'] }], requireIndependentReview: true, sourceBackend: 'artifacts-git' }, 0);
    const complete = async (commitOid: string, treeOid: string) => {
      const job = await ok('runner', '/runner/claim', { leaseSeconds: 120 });
      const payload = { attemptId: job.data.attemptId, commitOid, treeOid, packBase64: 'UEFDSw==', ...(job.data.input.kind === 'composition' ? { manifestDigest: job.data.input.manifestDigest } : {}) };
      const path = `/runner/jobs/${job.id}/publish-artifacts`, requestId = crypto.randomUUID();
      const result = await request('runner', path, payload, undefined, requestId);
      expect(result.status, JSON.stringify(result.body)).toBe(201);
      expect(result.body.resource.data.status).toBe('completed');
      expect(result.body.resource.data.receipt.backend).toBe('artifacts-git');
      const calls = publish.mock.calls.length;
      expect(await request('runner', path, payload, undefined, requestId)).toEqual(result);
      expect(publish.mock.calls.length).toBe(calls);
      expect((await request('runner', path, { ...payload, treeOid: '9'.repeat(40) }, undefined, requestId)).status).toBe(409);
      return result.body.resource.data.receipt;
    };
    await ok('human', '/baseline/initialize', { commitOid: 'a'.repeat(40), treeOid: 'b'.repeat(40) }, 0);
    await complete('a'.repeat(40), 'b'.repeat(40));
    const baseline = await ok('human', '/baseline');
    expect(baseline.receipt.backend).toBe('artifacts-git');
    const change = await ok('contributor', '/changes', { title: 'Synthetic contribution', obligationIds: ['source'] });
    const revision = await ok('contributor', `/changes/${change.id}/revisions`, { baseCommitOid: baseline.commitOid, commitOid: 'c'.repeat(40), treeOid: 'e'.repeat(40), obligationIds: ['source'], decisionRevisions: [], dependencies: [] });
    await complete('c'.repeat(40), 'e'.repeat(40));
    const view = await ok('contributor', '/views', { baseVersion: 1, baseCommitOid: baseline.commitOid, contractVersion: 1, policyVersion: 1, orderedRevisions: [{ changeId: change.id, revisionId: revision.id }], excludedChangeIds: [], decisionRevisions: [], compositionVersion: 1 });
    const receipt = await complete('f'.repeat(40), 'e'.repeat(40));
    expect(receipt.ref).toBe(`refs/agent/views/${view.id}`);
    const runnable = await ok('human', `/views/${view.id}`);
    expect(runnable.data.status).toBe('runnable');
    expect(runnable.data.receipt).toEqual(receipt);
    const verification = await ok('runner', `/runner/views/${view.id}/source-verifications`, { receipt });
    expect(verification.data.receipt).toEqual(receipt);
    expect(read).toHaveBeenCalledWith({ ref: receipt.ref, commitOid: receipt.commitOid, treeOid: receipt.treeOid });
    source.delete(receipt.ref);
    expect((await request('runner', `/runner/views/${view.id}/source-verifications`, { receipt })).status).toBe(409);
    expect(await ok('human', `/views/${view.id}/source-verification`)).toEqual(verification);
    expect(await ok('human', '/baseline')).toEqual(baseline);
    expect(publish).toHaveBeenCalledTimes(3);
  });
});
