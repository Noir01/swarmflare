import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { checkReceiptSchema, type CheckResource } from '../contracts/evidence.js';
import type { PublishedRevision } from '../contracts/index.js';
import { sourceRef } from '../contracts/source.js';
import { composeAndPublishView, readSourceReceipt } from '../git-runner/index.js';
import { jsonSuiteDigest, runJsonSuite, type JsonCheckDefinition } from '../git-runner/checks/json-suite.js';
import { demoSuiteDigest, runDemoSuite } from '../git-runner/checks/demo-suite.js';
import { mandatoryDemoSuiteDigest, runMandatoryDemoSuite } from '../git-runner/checks/mandatory-demo-suite.js';
import type { WorkspaceClient } from '../client/index.js';

export interface RunViewJsonSuiteOptions {
  remote: string;
  workspaceRoot: string;
  viewId: string;
  projectId: string;
  checks: readonly JsonCheckDefinition[];
  requestId: string;
}

export async function verifyViewSource(client: WorkspaceClient, options: { remote: string; viewId: string; requestId: string }) {
  const view = await client.view(options.viewId);
  if (view.data.status !== 'runnable' || !view.data.receipt) throw new Error('View is not runnable with a source receipt');
  const localReceipt = await readSourceReceipt(options.remote, view.data.receipt.ref);
  if (localReceipt.ref !== view.data.receipt.ref || localReceipt.commitOid !== view.data.receipt.commitOid || localReceipt.treeOid !== view.data.receipt.treeOid) throw new Error('Published View source receipt mismatch');
  return client.recordSourceVerification(view.id, { requestId: options.requestId, payload: { receipt: view.data.receipt } });
}

export async function runViewJsonSuite(client: WorkspaceClient, options: RunViewJsonSuiteOptions): Promise<CheckResource[]> {
  if (client.projectId !== options.projectId) throw new Error('Runner projectId does not match client target');
  const view = await client.view(options.viewId);
  if (view.data.status !== 'runnable' || !view.data.receipt) throw new Error('View is not runnable with a source receipt');
  const manifest = view.data.manifest;
  const expectedRef = sourceRef({ kind: 'composition', viewId: view.id, manifest, manifestDigest: view.data.manifestDigest, revisions: [] });
  if (view.data.receipt.ref !== expectedRef) throw new Error('View receipt ref does not match its ID');
  const source = await readSourceReceipt(options.remote, expectedRef);
  if (source.commitOid !== view.data.receipt.commitOid || source.treeOid !== view.data.receipt.treeOid) throw new Error('Published View source receipt mismatch');
  if (options.checks.length < 1) throw new Error('JSON suite must not be empty');
  const revisions = await Promise.all(manifest.orderedRevisions.map(async ref => {
    const revision = await client.revision(ref.revisionId);
    const data = revision.data;
    if (data.changeId !== ref.changeId || data.revisionId !== ref.revisionId || data.status !== 'published' || !data.receipt) throw new Error('Pinned revision is unavailable or mismatched');
    const { changeId, revisionId, owner, jobId: _jobId, status: _status, receipt: _receipt, error: _error, ...published } = data;
    return { ...published, changeId, revisionId, owner } as PublishedRevision;
  }));
  const workspace = await mkdtemp(join(options.workspaceRoot, '.checks-'));
  try {
    const destination = join(workspace, 'candidate');
    const composed = await composeAndPublishView({ repository: options.remote, destination, baselineOid: manifest.baseCommitOid, revisions, viewId: view.id });
    if (composed.commitOid !== source.commitOid || composed.treeOid !== source.treeOid) throw new Error('Recomposition does not match the exact published View');
    const digest = jsonSuiteDigest(options.checks);
    const receipts = await runJsonSuite({ candidateDirectory: destination, checks: options.checks, applicability: {
      projectId: options.projectId, viewId: view.id, manifestDigest: view.data.manifestDigest,
      composedCommitOid: source.commitOid, treeOid: source.treeOid,
      contractVersion: manifest.contractVersion, policyVersion: manifest.policyVersion, checkSuiteDigest: digest,
    }});
    const resources: CheckResource[] = [];
    for (let index = 0; index < receipts.length; index++) {
      const receipt = receipts[index]!;
      const execution = receipt.execution;
      const payload = checkReceiptSchema.parse({ kind: receipt.kind, checkId: receipt.checkId, obligationIds: receipt.obligationIds, applicability: receipt.applicability, harnessVersion: receipt.harnessVersion, result: receipt.result, execution });
      resources.push(await client.recordCheck(view.id, { requestId: `${options.requestId}-${index}`, payload }));
    }
    return resources;
  } finally { await rm(workspace, { recursive: true, force: true }); }
}

export async function runViewMandatoryDemoSuite(client: WorkspaceClient, options: Omit<RunViewJsonSuiteOptions, 'checks'>): Promise<CheckResource[]> {
  if (client.projectId !== options.projectId) throw new Error('Runner projectId does not match client target');
  const view = await client.view(options.viewId);
  if (view.data.status !== 'runnable' || !view.data.receipt) throw new Error('View is not runnable with a source receipt');
  const manifest = view.data.manifest;
  const expectedRef = sourceRef({ kind: 'composition', viewId: view.id, manifest, manifestDigest: view.data.manifestDigest, revisions: [] });
  if (view.data.receipt.ref !== expectedRef) throw new Error('View receipt ref does not match its ID');
  const source = await readSourceReceipt(options.remote, expectedRef);
  if (source.commitOid !== view.data.receipt.commitOid || source.treeOid !== view.data.receipt.treeOid) throw new Error('Published View source receipt mismatch');
  const revisions = await Promise.all(manifest.orderedRevisions.map(async ref => {
    const revision = await client.revision(ref.revisionId);
    const data = revision.data;
    if (data.changeId !== ref.changeId || data.revisionId !== ref.revisionId || data.status !== 'published' || !data.receipt) throw new Error('Pinned revision is unavailable or mismatched');
    const { changeId, revisionId, owner, jobId: _jobId, status: _status, receipt: _receipt, error: _error, ...published } = data;
    return { ...published, changeId, revisionId, owner } as PublishedRevision;
  }));
  const workspace = await mkdtemp(join(options.workspaceRoot, '.checks-'));
  try {
    const destination = join(workspace, 'candidate');
    const composed = await composeAndPublishView({ repository: options.remote, destination, baselineOid: manifest.baseCommitOid, revisions, viewId: view.id });
    if (composed.commitOid !== source.commitOid || composed.treeOid !== source.treeOid) throw new Error('Recomposition does not match the exact published View');
    const receipts = await runMandatoryDemoSuite({ candidateDirectory: destination, applicability: {
      projectId: options.projectId, viewId: view.id, manifestDigest: view.data.manifestDigest,
      composedCommitOid: source.commitOid, treeOid: source.treeOid, contractVersion: manifest.contractVersion,
      policyVersion: manifest.policyVersion, checkSuiteDigest: mandatoryDemoSuiteDigest(),
    }});
    const resources: CheckResource[] = [];
    for (let index = 0; index < receipts.length; index++) {
      const receipt = receipts[index]!;
      const payload = checkReceiptSchema.parse({ kind: receipt.kind, checkId: receipt.checkId, obligationIds: receipt.obligationIds, applicability: receipt.applicability, harnessVersion: receipt.harnessVersion, result: receipt.result, execution: receipt.execution });
      resources.push(await client.recordCheck(view.id, { requestId: `${options.requestId}-${index}`, payload }));
    }
    return resources;
  } finally { await rm(workspace, { recursive: true, force: true }); }
}

export async function runViewDemoSuite(client: WorkspaceClient, options: Omit<RunViewJsonSuiteOptions, 'checks'>): Promise<CheckResource[]> {
  if (client.projectId !== options.projectId) throw new Error('Runner projectId does not match client target');
  const view = await client.view(options.viewId);
  if (view.data.status !== 'runnable' || !view.data.receipt) throw new Error('View is not runnable with a source receipt');
  const manifest = view.data.manifest;
  const expectedRef = sourceRef({ kind: 'composition', viewId: view.id, manifest, manifestDigest: view.data.manifestDigest, revisions: [] });
  if (view.data.receipt.ref !== expectedRef) throw new Error('View receipt ref does not match its ID');
  const source = await readSourceReceipt(options.remote, expectedRef);
  if (source.commitOid !== view.data.receipt.commitOid || source.treeOid !== view.data.receipt.treeOid) throw new Error('Published View source receipt mismatch');
  const revisions = await Promise.all(manifest.orderedRevisions.map(async ref => {
    const revision = await client.revision(ref.revisionId);
    const data = revision.data;
    if (data.changeId !== ref.changeId || data.revisionId !== ref.revisionId || data.status !== 'published' || !data.receipt) throw new Error('Pinned revision is unavailable or mismatched');
    const { changeId, revisionId, owner, jobId: _jobId, status: _status, receipt: _receipt, error: _error, ...published } = data;
    return { ...published, changeId, revisionId, owner } as PublishedRevision;
  }));
  const workspace = await mkdtemp(join(options.workspaceRoot, '.checks-'));
  try {
    const destination = join(workspace, 'candidate');
    const composed = await composeAndPublishView({ repository: options.remote, destination, baselineOid: manifest.baseCommitOid, revisions, viewId: view.id });
    if (composed.commitOid !== source.commitOid || composed.treeOid !== source.treeOid) throw new Error('Recomposition does not match the exact published View');
    const receipts = await runDemoSuite({ candidateDirectory: destination, applicability: {
      projectId: options.projectId, viewId: view.id, manifestDigest: view.data.manifestDigest,
      composedCommitOid: source.commitOid, treeOid: source.treeOid, contractVersion: manifest.contractVersion,
      policyVersion: manifest.policyVersion, checkSuiteDigest: demoSuiteDigest(),
    }});
    const resources: CheckResource[] = [];
    for (let index = 0; index < receipts.length; index++) {
      const receipt = receipts[index]!;
      const payload = checkReceiptSchema.parse({ kind: receipt.kind, checkId: receipt.checkId, obligationIds: receipt.obligationIds, applicability: receipt.applicability, harnessVersion: receipt.harnessVersion, result: receipt.result, execution: receipt.execution });
      resources.push(await client.recordCheck(view.id, { requestId: `${options.requestId}-${index}`, payload }));
    }
    return resources;
  } finally { await rm(workspace, { recursive: true, force: true }); }
}
