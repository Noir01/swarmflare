import type { SourceJob, SourceReceipt } from '../contracts/source.js';
import { jobResourceSchema, sourceReceiptSchema } from '../contracts/source.js';
import { sourceRef } from '../contracts/source.js';
import { composeAndPublishView, publishRevision, publishSeed, readSourceReceipt } from '../git-runner/index.js';
import { exportGitPack } from '../git-runner/export-pack.js';
import type { WorkspaceClient } from '../client/index.js';

export interface RunSourceJobOptions {
  remote: string;
  workspaceRoot: string;
  resolveRepository: (input: SourceJob['data']['input']) => Promise<string> | string;
  requestId: string;
  leaseSeconds?: number;
  sourceBackend?: 'local-git' | 'artifacts-git';
}

const safeError = (error: unknown): string => {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,200}$/.test(code) ? code : 'RUNNER_FAILED';
};

export async function runSourceJob(client: WorkspaceClient, options: RunSourceJobOptions): Promise<SourceJob | null> {
  if (options.requestId.length > 120 - 1 - 36 - '-complete'.length) throw new Error('Invalid source runner request ID');
  const job = await client.claimSourceJob({ requestId: `${options.requestId}-claim`, payload: { leaseSeconds: options.leaseSeconds ?? 30 } });
  if (job === null) return null;
  const validJob = jobResourceSchema.parse(job);
  if (validJob.data.status !== 'leased' || !validJob.data.attemptId) throw new Error('Invalid leased source job');
  const input = validJob.data.input;
  const completionId = `${options.requestId}-${validJob.data.attemptId}`;
  let receipt: SourceReceipt;
  try {

    if (input.kind === 'seed') {
      const repository = await options.resolveRepository(input);
      await publishSeed(repository, options.remote, input.seedId, input.source);
      receipt = await readSourceReceipt(options.remote, sourceRef(input));
      if (receipt.commitOid !== input.source.commitOid || receipt.treeOid !== input.source.treeOid) throw Object.assign(new Error(), { code: 'SEED_READBACK_MISMATCH' });
    } else if (input.kind === 'publication') {
      const repository = await options.resolveRepository(input);
      const revision = input.revision;
      await publishRevision(repository, options.remote, revision);
      receipt = await readSourceReceipt(options.remote, sourceRef(input));
      if (receipt.commitOid !== revision.commitOid || receipt.treeOid !== revision.treeOid) throw Object.assign(new Error(), { code: 'PUBLICATION_READBACK_MISMATCH' });
    } else {
      const repository = options.remote;
      const destination = `${options.workspaceRoot}/views/${input.viewId}`;
      const published = input.revisions.map(({ changeId, revisionId, owner, ...r }) => ({ ...r, changeId, revisionId, owner }));
      try {
        receipt = await composeAndPublishView({ repository, destination, baselineOid: input.manifest.baseCommitOid, revisions: published, viewId: input.viewId });
      } catch (error) {
        throw error;
      }
      const readback = await readSourceReceipt(repository, sourceRef(input));
      if (receipt.commitOid !== readback.commitOid || receipt.treeOid !== readback.treeOid) throw Object.assign(new Error(), { code: 'COMPOSITION_READBACK_MISMATCH' });
      receipt = readback;
    }
    sourceReceiptSchema.parse(receipt);
  } catch (error) {
    const failureId = `${completionId}-failed`;
    try {
      return await client.completeSourceJob(validJob.id, { requestId: failureId, payload: { attemptId: validJob.data.attemptId!, ok: false, error: safeError(error) } });
    } catch {
      throw error;
    }
  }
  if (options.sourceBackend === 'artifacts-git') {
    let packBase64: string;
    try {
      packBase64 = await exportGitPack(options.remote, receipt.commitOid);
    } catch (error) {
      try { return await client.completeSourceJob(validJob.id, { requestId: `${completionId}-failed`, payload: { attemptId: validJob.data.attemptId!, ok: false, error: safeError(error) } }); }
      catch { throw error; }
    }
    return await client.publishArtifactsSourceJob(validJob.id, { requestId: `${completionId}-publish`, payload: {
      attemptId: validJob.data.attemptId!, commitOid: receipt.commitOid, treeOid: receipt.treeOid, packBase64,
      ...(input.kind === 'composition' ? { manifestDigest: input.manifestDigest } : {}),
    } });
  }
  return await client.completeSourceJob(validJob.id, { requestId: `${completionId}-complete`, payload: { attemptId: validJob.data.attemptId!, ok: true, receipt } });
}
