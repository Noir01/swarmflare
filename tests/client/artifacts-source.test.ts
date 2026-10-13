import { describe, expect, it, vi } from 'vitest';
import { WorkspaceClient } from '../../packages/client/index.js';

describe('Artifacts source client route', () => {
  it('sends the frozen publish-artifacts mutation route and parses the job', async () => {
    const resource = { id: 'job1', version: 2, owner: 'system', data: { input: { kind: 'seed', seedId: 's1', source: { commitOid: 'a'.repeat(40), treeOid: 'b'.repeat(40) } }, status: 'completed', attemptId: 'attempt1', runnerId: 'runner', leaseExpiresAt: 0, receipt: { backend: 'artifacts-git', ref: 'refs/agent/seeds/s1', commitOid: 'a'.repeat(40), treeOid: 'b'.repeat(40) }, error: null } };
    const fetcher = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) => new Response(JSON.stringify({ apiVersion: 1, resource, sequence: 1, version: 2 }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const client = new WorkspaceClient({ baseUrl: 'http://127.0.0.1', projectId: 'project1', token: 'secret', fetch: fetcher as typeof fetch });
    const result = await client.publishArtifactsSourceJob('job1', { requestId: 'publish1', payload: { attemptId: 'attempt1', commitOid: 'a'.repeat(40), treeOid: 'b'.repeat(40), packBase64: 'UEFDSw==' } });
    expect(result.data.receipt?.backend).toBe('artifacts-git');
    expect(fetcher.mock.calls[0]?.[0]).toBe('http://127.0.0.1/api/v1/projects/project1/runner/jobs/job1/publish-artifacts');
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).payload.packBase64).toBe('UEFDSw==');
  });
});
