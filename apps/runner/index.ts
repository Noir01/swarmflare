import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { WorkspaceClient } from '../../packages/client/index.js';
import { workspaceEndpoint } from '../../packages/client/endpoint.js';
import { runSourceJob } from '../../packages/local-runner/index.js';
import { runViewMandatoryDemoSuite, verifyViewSource } from '../../packages/local-runner/checks.js';
import { buildReviewArtifact } from '../../packages/local-runner/review-artifact.js';

const usage = `Single-operation local runner (no polling):
  source-job '{"remote":"/path/to/bare.git","workspaceRoot":"/path/to/work","seedRepository":"/path/to/seed","repositories":{"actor-id":"/path/to/repo"},"requestId":"run-1","sourceBackend":"local-git|artifacts-git"}'
  mandatory-checks '{"remote":"/path/to/bare.git","workspaceRoot":"/path/to/work","viewId":"view-id","requestId":"run-2"}'
  review-artifact '{"remote":"/path/to/bare.git","workspaceRoot":"/path/to/work","viewId":"view-id"}'
  verify-source '{"remote":"/path/to/bare.git","viewId":"view-id","requestId":"run-3"}'
Requires WORKSPACE_BASE_URL, WORKSPACE_PROJECT_ID and WORKSPACE_TOKEN. Remote metadata requires WORKSPACE_ALLOWED_ORIGIN to exactly match an HTTPS *.workers.dev origin.`;

function localPath(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || /^(?:[a-z][a-z0-9+.-]*:|\\\\)/i.test(value)) throw new Error(`${label} must be a local filesystem path`);
  return resolve(value);
}

function validId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(value)) throw new Error(`${label} is invalid`);
  return value;
}
async function main(): Promise<void> {
  const [command, raw] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h' || command === 'help') { process.stdout.write(`${usage}\n`); return; }
  if (!['source-job','mandatory-checks','verify-source','review-artifact'].includes(command)) throw new Error('unknown command; use --help');
  if (!raw) throw new Error('command requires one JSON argument');
  let input: any;
  try { input = JSON.parse(raw); } catch { throw new Error('argument must be valid JSON'); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('argument must be a JSON object');
  const base = process.env.WORKSPACE_BASE_URL;
  const projectId = process.env.WORKSPACE_PROJECT_ID;
  const token = process.env.WORKSPACE_TOKEN;
  if (!base || !projectId || !token) throw new Error('WORKSPACE_BASE_URL, WORKSPACE_PROJECT_ID and WORKSPACE_TOKEN are required');
  const url = workspaceEndpoint(base, process.env.WORKSPACE_ALLOWED_ORIGIN);
  validId(projectId, 'WORKSPACE_PROJECT_ID');
  if (token.length > 4096) throw new Error('WORKSPACE_TOKEN is invalid');
  const remote = localPath(input.remote, 'remote');
  const workspaceRoot = command === 'verify-source' ? undefined : localPath(input.workspaceRoot, 'workspaceRoot');
  const requestId = command === 'review-artifact' ? undefined : validId(input.requestId, 'requestId');
  const sourceBackend = input.sourceBackend ?? 'local-git';
  if (command === 'source-job' && !['local-git', 'artifacts-git'].includes(sourceBackend)) throw new Error('sourceBackend must be local-git or artifacts-git');
  const viewId = command === 'source-job' ? undefined : validId(input.viewId, 'viewId');
  const repositories = new Map<string,string>();
  let seedRepository: string | undefined;
  if (command === 'source-job') {
    if (!input.repositories || typeof input.repositories !== 'object' || Array.isArray(input.repositories)) throw new Error('repositories must map actor IDs to local paths');
    for (const [owner, path] of Object.entries(input.repositories)) repositories.set(validId(owner, 'repository owner'), localPath(path, `repository ${owner}`));
    if (input.seedRepository !== undefined) seedRepository = localPath(input.seedRepository, 'seedRepository');
    if (repositories.size > 100) throw new Error('too many repository mappings');
    await Promise.all([remote, workspaceRoot!, ...repositories.values(), ...(seedRepository ? [seedRepository] : [])].map(path => access(path)));
  } else if (command === 'review-artifact') {
    await Promise.all([remote, workspaceRoot!].map(path => access(path)));
  } else {
    await access(remote);
    if (workspaceRoot) await access(workspaceRoot);
  }
  const client = new WorkspaceClient({ baseUrl: url, projectId, token, maxRequests: 100, deadline: 60_000 });
  let result: unknown;
  if (command === 'source-job') {
    result = await runSourceJob(client, { remote, workspaceRoot: workspaceRoot!, requestId: requestId!, resolveRepository: input => {
      if (input.kind === 'composition') return remote;
      if (input.kind === 'seed') {
        if (!seedRepository) throw new Error('SEED_REPOSITORY_REQUIRED');
        return seedRepository;
      }
      const repository = repositories.get(input.revision.owner);
      if (!repository) throw new Error('UNKNOWN_REVISION_OWNER');
      return repository;
    }, sourceBackend });
    const job = result as { data?: { status?: string } } | null;
    if (job?.data?.status === 'failed') { process.stdout.write(`${JSON.stringify(job).replaceAll(token, '[REDACTED]')}\n`); process.exitCode = 1; return; }
  } else if (command === 'mandatory-checks') {
    result = await runViewMandatoryDemoSuite(client, { remote, workspaceRoot: workspaceRoot!, projectId, viewId: viewId!, requestId: requestId! });
    const checks = result as Array<{ data?: { result?: string } }>;
    if (checks.some(check => check.data?.result !== 'passed')) process.exitCode = 1;
  } else if (command === 'review-artifact') {
    const artifact = await buildReviewArtifact(client, { remote, workspaceRoot: workspaceRoot!, viewId: viewId! });
    const preview = artifact.data.preview;
    result = { id: artifact.id, version: artifact.version, viewId: artifact.data.applicability.viewId,
      projectId: artifact.data.applicability.projectId, manifestDigest: artifact.data.applicability.manifestDigest,
      composedCommitOid: artifact.data.applicability.composedCommitOid, treeOid: artifact.data.applicability.treeOid,
      contractVersion: artifact.data.applicability.contractVersion, policyVersion: artifact.data.applicability.policyVersion,
      baseline: artifact.data.baseline,
      diff: { files: artifact.data.diff.files.length, truncated: artifact.data.diff.truncated, patchBytes: Buffer.byteLength(artifact.data.diff.patch) },
      preview: preview ? { supported: preview.supported, expiresAt: preview.expiresAt } : null };
  } else result = await verifyViewSource(client, { remote, viewId: viewId!, requestId: requestId! });
  process.stdout.write(`${JSON.stringify(result).replaceAll(token, '[REDACTED]')}\n`);
}
main().catch(error => { const token = process.env.WORKSPACE_TOKEN; const message = error instanceof Error ? error.message : 'runner failed'; process.stderr.write(`${JSON.stringify({ error: token ? message.replaceAll(token, '[REDACTED]') : message })}\n`); process.exitCode = 1; });
