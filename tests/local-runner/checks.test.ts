import { describe, expect, it } from 'vitest';
import { WorkspaceClient } from '../../packages/client/index.js';
import { checkReceiptSchema } from '../../packages/contracts/evidence.js';

const receipt = {
  kind: 'recorded-check', checkId: 'smoke', obligationIds: ['obligation'],
  applicability: { projectId: 'project', viewId: 'view', manifestDigest: 'a'.repeat(64), composedCommitOid: 'b'.repeat(40), treeOid: 'c'.repeat(40), contractVersion: 1, policyVersion: 1, checkSuiteDigest: 'd'.repeat(64) },
  harnessVersion: 'json-oracle-v1', result: 'failed',
  execution: { status: 'timed-out', exitCode: null, stdout: '', stderr: 'timeout', startedAt: '2026-10-08T00:00:00.000Z', finishedAt: '2026-10-08T00:00:03.000Z', nodeVersion: 'v22.0.0', stdoutDigest: 'e'.repeat(64), stderrDigest: 'f'.repeat(64) },
};

describe('recorded evidence client', () => {
  it('parses frozen receipts and binds methods to the view route', async () => {
    expect(checkReceiptSchema.parse(receipt)).toEqual(receipt);
    const calls: string[] = [];
    const client = new WorkspaceClient({ baseUrl: 'https://local', projectId: 'project', token: 'runner', fetch: async (input, init) => {
      calls.push(`${init?.method} ${new URL(String(input)).pathname}`);
      const resource = init?.method === 'GET' ? [] : { id: 'check', version: 1, owner: 'runner', data: receipt };
      return new Response(JSON.stringify({ apiVersion: 1, resource, sequence: 1, version: 1 }), { headers: { 'content-type': 'application/json' } });
    }});
    expect(await client.recordCheck('view', { requestId: 'record-check-1', payload: receipt })).toMatchObject({ id: 'check', data: receipt });
    expect(await client.checks('view')).toEqual([]);
    expect(calls).toEqual(['POST /api/v1/projects/project/runner/views/view/checks', 'GET /api/v1/projects/project/views/view/checks']);
    await expect(client.recordCheck('different-view', { requestId: 'record-check-2', payload: receipt })).rejects.toThrow(/viewId/);
  });
});
