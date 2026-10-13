import { execFile } from 'node:child_process';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { WorkspaceClient } from '../client/index.js';
import type { DurableSourceReceipt } from '../contracts/source.js';
import { readSourceReceipt } from '../git-runner/index.js';
import { buildDemoPreview } from '../git-runner/checks/demo-preview.js';


const exec = promisify(execFile);
type Receipt = Awaited<ReturnType<typeof readSourceReceipt>>;
const sameReceipt = (a: Receipt | DurableSourceReceipt, b: Receipt | DurableSourceReceipt) => a.ref === b.ref && a.commitOid === b.commitOid && a.treeOid === b.treeOid;
const gitEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0', GIT_CONFIG_PARAMETERS: '', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'file' };
const safePath = (path: string) => !!path && path.length <= 500 && !path.startsWith('/') && !path.includes('\\') && path.split('/').every(part => !!part && part !== '.' && part !== '..' && part !== '.git');

export async function buildReviewArtifact(client: WorkspaceClient, options: { remote: string; workspaceRoot: string; viewId: string }) {
  const viewId = options.viewId;
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(viewId)) throw new Error('invalid View ID');
  if (!client.baseline || !client.reviewArtifact || !client.recordReviewArtifact) throw new Error('review artifact API unavailable');
  const baseline = await client.baseline();
  if (!baseline) throw new Error('accepted baseline unavailable');
  const baselineReceipt = await readSourceReceipt(options.remote, baseline.receipt.ref);
  if (!sameReceipt(baselineReceipt, baseline.receipt) || baselineReceipt.commitOid !== baseline.commitOid || baselineReceipt.treeOid !== baseline.treeOid) throw new Error('accepted baseline source receipt mismatch');
  const view = await client.view(viewId);
  if (view.data.status !== 'runnable' || !view.data.receipt) throw new Error('candidate View unavailable');
  const expectedRef = `refs/agent/views/${viewId}`;
  if (view.data.receipt.ref !== expectedRef) throw new Error('candidate source ref mismatch');
  const candidateReceipt = await readSourceReceipt(options.remote, expectedRef);
  if (!sameReceipt(candidateReceipt, view.data.receipt)) throw new Error('candidate source receipt mismatch');
  if (view.data.manifest.baseVersion !== baseline.version || view.data.manifest.baseCommitOid !== baseline.commitOid) throw new Error('candidate is not pinned to the accepted baseline');
  if (!client.readiness) throw new Error('current readiness API unavailable');
  const readiness = await client.readiness(viewId);
  const applicability = readiness.applicability;
  if (!applicability || applicability.projectId !== client.projectId || applicability.viewId !== viewId || applicability.manifestDigest !== view.data.manifestDigest || applicability.composedCommitOid !== candidateReceipt.commitOid || applicability.treeOid !== candidateReceipt.treeOid || applicability.contractVersion !== view.data.manifest.contractVersion || applicability.policyVersion !== view.data.manifest.policyVersion) throw new Error('current policy applicability does not match candidate View');

  const workRoot = await mkdtemp(join(resolve(options.workspaceRoot), '.review-artifact-'));
  try {
    const candidateDirectory = join(workRoot, 'candidate');
    await exec('git', ['-c','core.hooksPath=/dev/null','-c','credential.helper=','-c','protocol.ext.allow=never','-c','protocol.file.allow=always','clone','--quiet','--no-checkout',resolve(options.remote),candidateDirectory], { env: gitEnv, timeout: 15_000, maxBuffer: 1_000_000 });
    await exec('git', ['-C', candidateDirectory,'checkout','--quiet','--detach',candidateReceipt.commitOid], { env: gitEnv, timeout: 15_000, maxBuffer: 1_000_000 });
    const checkedOut = await exec('git', ['-C', candidateDirectory,'rev-parse','HEAD^{tree}'], { env: gitEnv, timeout: 5_000, maxBuffer: 1024 });
    if (checkedOut.stdout.trim() !== candidateReceipt.treeOid) throw new Error('materialized candidate tree mismatch');

    const diff = await exec('git', ['-C', resolve(options.remote), '-c','diff.external=','-c','core.quotePath=true','diff','--no-ext-diff','--no-textconv','--no-color','--no-renames','--src-prefix=a/','--dst-prefix=b/',baselineReceipt.commitOid,candidateReceipt.commitOid,'--'], { env: gitEnv, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
    const rawPatch = diff.stdout;
    const names = await exec('git', ['-C', resolve(options.remote),'diff-tree','--no-commit-id','--name-only','-r','-z','--no-renames',baselineReceipt.commitOid,candidateReceipt.commitOid], { env: gitEnv, timeout: 5_000, maxBuffer: 1024 * 1024 });
    const rawPaths = names.stdout.split('\0').filter(Boolean);
    if (rawPaths.some(path => !safePath(path))) throw new Error('unsafe source path in diff');
    const files = rawPaths.slice(0, 100);
    let patch = rawPatch.replace(/^Binary files .* differ$/gm, '[binary file changed; contents omitted]');
    let truncated = rawPaths.length > files.length || rawPatch.length > 16_000;
    if (patch.length > 16_000) patch = `${patch.slice(0, 15_970)}\n[diff truncated]`;

    let preview = null;
    let supportedDemo = false;
    try { const stat = await lstat(join(candidateDirectory, 'demo/seed/index.ts')); supportedDemo = stat.isFile() && !stat.isSymbolicLink(); } catch { supportedDemo = false; }
    if (supportedDemo) {
      const expiresAt = Date.now() + 110_000; // Leave clock-skew headroom under the server's 120s maximum.
      try {
        const built = await buildDemoPreview({ candidateDirectory, expiresAt });
        preview = { ...built, expiresAt };
      } catch (error) { throw new Error(`supported demo preview failed: ${error instanceof Error ? error.message : 'unknown error'}`); }
    }
    const payload = {
      applicability,
      baseline: { version: baseline.version, commitOid: baseline.commitOid, treeOid: baseline.treeOid },
      diff: { patch, files, truncated }, preview,
    };
    const serialized = JSON.stringify(payload);
    if (Buffer.byteLength(serialized, 'utf8') > 64 * 1024 || patch.length > 16_000 || files.length > 100) throw new Error('review artifact exceeds transport bounds');
    const baselineAfter = await client.baseline();
    if (!baselineAfter || baselineAfter.version !== baseline.version || baselineAfter.commitOid !== baseline.commitOid || baselineAfter.treeOid !== baseline.treeOid || !sameReceipt(baselineAfter.receipt, baseline.receipt)) throw new Error('accepted baseline changed while building review artifact');
    const sourceAfter = await readSourceReceipt(options.remote, expectedRef);
    if (!sameReceipt(sourceAfter, candidateReceipt)) throw new Error('candidate source changed while building review artifact');
    const recorded = await client.recordReviewArtifact(viewId, { requestId: `review-artifact-${viewId}-${randomUUID()}`, payload });
    const readback = await client.reviewArtifact(viewId);
    if (!readback || JSON.stringify(readback) !== JSON.stringify(recorded)) throw new Error('review artifact readback mismatch');
    return readback;
  } finally { await rm(workRoot, { recursive: true, force: true }); }
}
