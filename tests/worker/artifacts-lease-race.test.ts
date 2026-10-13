import { afterEach, expect, it, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { Project } from '../../apps/worker/src/project/index';
import { ArtifactsSourceStore } from '../../packages/artifacts-source/index';
import { sourceRef } from '../../packages/contracts/source';

afterEach(() => vi.restoreAllMocks());

async function withFixture<T>(run: (f: {
  request: (role: string, path: string, payload?: unknown, expectedVersion?: number) => Promise<{ status: number; body: any }>;
  ok: (role: string, path: string, payload?: unknown, expectedVersion?: number) => Promise<any>;
  policy: any; firstJob: any; path: string; payload: any;
  publishing: Promise<{ status: number; body: any }>;
  release: (value: { backend: 'artifacts-git'; ref: string; commitOid: string; treeOid: string }) => void;
  publish: any;
}) => Promise<T>) {
  const projectId = `artifacts-race-${crypto.randomUUID()}`;
  const remote = 'https://fixture.artifacts.cloudflare.net/git/demo/source.git';
  let release!: (value: { backend: 'artifacts-git'; ref: string; commitOid: string; treeOid: string }) => void;
  let entered!: () => void;
  const publicationStarted = new Promise<void>(resolve => { entered = resolve; });
  const publication = new Promise<{ backend: 'artifacts-git'; ref: string; commitOid: string; treeOid: string }>(resolve => { release = resolve; });
  const publish = vi.spyOn(ArtifactsSourceStore.prototype, 'publish').mockImplementation(async input => {
    entered();
    return publication;
  });
  const stub = env.PROJECTS.get(env.PROJECTS.idFromName(projectId));
  return runInDurableObject(stub, async (_instance, state) => {
    const project = new Project(state, { ...env,
      ARTIFACTS: { get: async () => { throw new Error('Fake store must not request real capabilities'); } },
      ARTIFACTS_SOURCE_CONFIG: JSON.stringify({ projectId, repository: 'demo/source', remote, allowWrites: true }),
    } as Env);
    const request = async (role: string, path: string, payload?: unknown, expectedVersion?: number) => {
      const response = await project.fetch(new Request(`https://internal${path}`, {
        method: payload === undefined ? 'GET' : 'POST',
        headers: { 'x-project-id': projectId, 'x-actor': JSON.stringify({ id: role, role, projectId }), 'content-type': 'application/json' },
        body: payload === undefined ? undefined : JSON.stringify({ requestId: crypto.randomUUID(), expectedVersion, payload }),
      }));
      return { status: response.status, body: await response.json() as any };
    };
    const ok = async (...args: Parameters<typeof request>) => {
      const result = await request(...args);
      expect(result.status, JSON.stringify(result.body)).toBeLessThan(300);
      return result.body.resource;
    };
    const proposal = await ok('human', '/contracts/proposals', {
      outcome: 'Lease-race source', constraints: [], obligations: [{ id: 'source', description: 'Exact source', acceptanceExamples: [] }], requiredCheckIds: ['check'], unresolvedQuestions: [],
    });
    await ok('human', `/contracts/${proposal.id}/approve`, {}, 0);
    const policy = { contractVersion: 1, checkSuiteDigest: 'd'.repeat(64), harnessVersion: 'json-oracle-v1', checks: [{ id: 'check', obligationIds: ['source'] }], requireIndependentReview: true, sourceBackend: 'artifacts-git' };
    await ok('human', '/policy', policy, 0);
    const baseline = await ok('human', '/baseline/initialize', { commitOid: 'a'.repeat(40), treeOid: 'b'.repeat(40) }, 0);
    expect(baseline.data.receipt).toBeNull();
    const firstJobResource = await ok('runner', '/runner/claim', { leaseSeconds: 30 });
    const firstJob = { ...firstJobResource.data, id: firstJobResource.id };
    expect(firstJob).toBeTruthy();
    const path = `/runner/jobs/${firstJob.id}/publish-artifacts`;
    const payload = { attemptId: firstJob.attemptId, commitOid: 'a'.repeat(40), treeOid: 'b'.repeat(40), packBase64: 'UEFDSw==' };
    let publishing: Promise<{ status: number; body: any }> | undefined;
    try {
      publishing = request('runner', path, payload);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const gate = await Promise.race([
        publicationStarted.then(() => 'entered' as const),
        publishing.then(() => 'finished' as const),
        new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), 2_000); }),
      ]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
      expect(gate, 'publication request must reach the gated source store before returning').toBe('entered');
      return await run({ request, ok, policy, firstJob, path, payload, publishing, release, publish });
    } finally {
      release({ backend: 'artifacts-git', ref: sourceRef(firstJob.input), commitOid: 'a'.repeat(40), treeOid: 'b'.repeat(40) });
      await publishing?.catch(() => undefined);
    }
  });
}

it('does not complete a stale seed job attempt after the lease is reassigned', async () => {
  const base = 2_000_000_000_000;
  let now = base;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  await withFixture(async f => {
    now += 31_000;
    const reassignedResource = await f.ok('runner', '/runner/claim', { leaseSeconds: 120 });
    const reassigned = reassignedResource.data;
    expect(reassignedResource.id).toBe(f.firstJob.id);
    expect(reassigned.attemptId).not.toBe(f.firstJob.attemptId);
    f.release({ backend: 'artifacts-git', ref: sourceRef(f.firstJob.input), commitOid: 'a'.repeat(40), treeOid: 'b'.repeat(40) });
    const stale = await f.publishing;
    expect(stale.status).toBe(409);
    expect(stale.body.resource).toBeUndefined();
    const current = await f.ok('runner', `/runner/jobs/${f.firstJob.id}`);
    expect(current.data.status).toBe('leased');
    expect(current.data.attemptId).toBe(reassigned.attemptId);
    expect(current.data.receipt).toBeNull();
    expect((await f.request('human', '/baseline')).body.resource).toBeNull();
    expect(f.publish).toHaveBeenCalledTimes(1);
  });
});

it('does not commit artifacts after the selected source backend changes during publication', async () => {
  await withFixture(async f => {
    const changedPolicy = { ...f.policy, sourceBackend: 'local-git' };
    await f.ok('human', '/policy', changedPolicy, 1);
    f.release({ backend: 'artifacts-git', ref: sourceRef(f.firstJob.input), commitOid: 'a'.repeat(40), treeOid: 'b'.repeat(40) });
    const stale = await f.publishing;
    expect(stale.status).toBe(409);
    expect(stale.body.resource).toBeUndefined();
    const current = await f.ok('runner', `/runner/jobs/${f.firstJob.id}`);
    expect(current.data.status).toBe('leased');
    expect(current.data.receipt).toBeNull();
    expect((await f.request('human', '/baseline')).body.resource).toBeNull();
    expect(f.publish).toHaveBeenCalledTimes(1);
  });
});
