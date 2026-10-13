import { afterEach, expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceClient } from '../../packages/client/index';
import { runSourceJob } from '../../packages/local-runner/index';
import { runViewJsonSuite } from '../../packages/local-runner/checks';
import { readSourceReceipt } from '../../packages/git-runner/index';

let runtime: Miniflare | undefined;
let scratch: string | undefined;
afterEach(async () => {
  await runtime?.dispose(); runtime = undefined;
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = undefined;
});

it('seeds baseline and publishes independent source branches through authenticated HTTP and actual Git', async () => {
  scratch = await mkdtemp(join(tmpdir(), 'source-e2e-'));
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
  const source = join(scratch, 'source'), remote = join(scratch, 'remote.git');
  await mkdir(source);
  execFileSync('git', ['init', '-q', source]);
  git(source, 'config', 'user.name', 'Local Test'); git(source, 'config', 'user.email', 'local@example.invalid');
  await writeFile(join(source, 'baseline.txt'), 'baseline\n'); git(source, 'add', '.'); git(source, 'commit', '-qm', 'baseline');
  const commitOid = git(source, 'rev-parse', 'HEAD'), treeOid = git(source, 'rev-parse', 'HEAD^{tree}');
  execFileSync('git', ['init', '--bare', '-q', remote]);

  const bundle = await build({ entryPoints: ['apps/worker/src/index.ts'], bundle: true, platform: 'browser', format: 'esm', write: false, external: ['cloudflare:workers'] });
  const credentials = [
    { id: 'human', role: 'human', token: 'local-human' },
    { id: 'human-resolver', role: 'human', token: 'local-human-resolver' },
    { id: 'alice', role: 'contributor', token: 'local-alice' },
    { id: 'bob', role: 'contributor', token: 'local-bob' },
    { id: 'reviewer', role: 'reviewer', token: 'local-reviewer' },
    { id: 'runner', role: 'runner', token: 'local-runner' },
  ].map(({ id, role, token }) => ({ id, projectId: 'local-e2e', role, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: Date.now() + 300_000 }));
  runtime = new Miniflare(convertV4MiniflareOptions({ name: 'source-test', modules: true, script: bundle.outputFiles[0]!.text, compatibilityDate: '2026-08-01', durableObjects: { PROJECTS: { className: 'Project', useSQLite: true } }, bindings: { AUTH_CREDENTIALS: JSON.stringify(credentials) }, host: '127.0.0.1', port: 0 }));
  const baseUrl = await runtime.ready;
  const client = (token: string) => new WorkspaceClient({ baseUrl: baseUrl.toString(), projectId: 'local-e2e', token, maxRequests: 200, deadline: 60_000 });
  const human = client('local-human'), resolver = client('local-human-resolver'), alice = client('local-alice'), bob = client('local-bob'), reviewer = client('local-reviewer'), runner = client('local-runner');

  await expect(human.initializeBaseline({ requestId: 'seed-too-early', expectedVersion: 0, payload: { commitOid, treeOid } })).rejects.toMatchObject({ status: 409 });
  const proposal = await human.createProposal({ requestId: 'proposal-1', payload: { outcome: 'Publish local source changes', constraints: [], obligations: [{ id: 'source-obligation', description: 'Support local source changes', acceptanceExamples: [] }], requiredCheckIds: ['local-check'], unresolvedQuestions: [] } });
  await expect(alice.approveProposal((proposal as { id: string }).id, { requestId: 'approve-denied', payload: {} })).rejects.toMatchObject({ status: 403 });
  await human.approveProposal((proposal as { id: string }).id, { requestId: 'approve-1', payload: {} });

  const decision = await human.createDecision({ requestId: 'decision-create', payload: { question: 'Which exact source revisions should be composed?', obligationIds: ['source-obligation'], participants: ['alice', 'bob'], material: false } }) as { id: string };
  await alice.respondDecision(decision.id, { requestId: 'decision-alice-response', payload: { body: 'Use the published Alice and Bob revisions.', acknowledge: true } });
  await bob.respondDecision(decision.id, { requestId: 'decision-bob-response', payload: { body: 'Agreed: pin both exact revisions.', acknowledge: true } });
  await alice.agreeDecision(decision.id, { requestId: 'decision-alice-agree', payload: {} });
  const agreement = await bob.agreeDecision(decision.id, { requestId: 'decision-bob-agree', payload: {} }) as { version: number };
  const decisionRevision = { decisionId: decision.id, version: agreement.version };

  const initialized = await human.initializeBaseline({ requestId: 'seed-1', expectedVersion: 0, payload: { commitOid, treeOid } });
  expect(initialized.data.input.kind).toBe('seed');
  expect(await alice.claimSourceJob({ requestId: 'claim-denied', payload: { leaseSeconds: 30 } }).catch((e: { status?: number }) => e)).toMatchObject({ status: 403 });
  const seeded = await runSourceJob(runner, { remote, workspaceRoot: join(scratch, 'workspace'), resolveRepository: () => source, requestId: 'seed-run' });
  expect(seeded?.data.status).toBe('completed');
  expect(await human.baseline()).toMatchObject({ commitOid, treeOid, receipt: { ref: `refs/agent/seeds/${initialized.data.input.kind === 'seed' ? initialized.data.input.seedId : ''}` } });
  const seedReceipt = await readSourceReceipt(remote, `refs/agent/seeds/${initialized.data.input.kind === 'seed' ? initialized.data.input.seedId : ''}`);
  expect(seedReceipt).toMatchObject({ commitOid, treeOid });

  const makeBranch = async (name: string, filename: string, contents: string) => {
    const dir = join(scratch!, name); execFileSync('git', ['clone', '-q', source, dir]);
    git(dir, 'checkout', '-qb', name); git(dir, 'config', 'user.name', 'Local Test'); git(dir, 'config', 'user.email', 'local@example.invalid');
    await writeFile(join(dir, filename), contents); git(dir, 'add', '.'); git(dir, 'commit', '-qm', name);
    return { dir, commitOid: git(dir, 'rev-parse', 'HEAD'), treeOid: git(dir, 'rev-parse', 'HEAD^{tree}') };
  };
  const branches = await Promise.all([makeBranch('alice-branch', 'alice.txt', 'alice change\n'), makeBranch('bob-branch', 'bob.txt', 'bob change\n')]);
  await writeFile(join(branches[0]!.dir, 'probe.mjs'), 'console.log(JSON.stringify({version:1}));\n');
  git(branches[0]!.dir, 'add', '.'); git(branches[0]!.dir, 'commit', '--amend', '-qm', 'alice branch with probe');
  branches[0]!.commitOid = git(branches[0]!.dir, 'rev-parse', 'HEAD'); branches[0]!.treeOid = git(branches[0]!.dir, 'rev-parse', 'HEAD^{tree}');
  const changes = await Promise.all([
    alice.createChange({ requestId: 'change-alice', payload: { title: 'Alice source change', obligationIds: ['source-obligation'] } }),
    bob.createChange({ requestId: 'change-bob', payload: { title: 'Bob source change', obligationIds: ['source-obligation'] } }),
  ]);
  expect(changes[0]!.owner).toBe('alice'); expect(changes[1]!.owner).toBe('bob');
  for (let index = 0; index < changes.length; index++) {
    const change = changes[index]!, branch = branches[index]!;
    const revision = await (index === 0 ? alice : bob).publishRevision(change.id, { requestId: `revision-${index}`, payload: { baseCommitOid: commitOid, commitOid: branch.commitOid, treeOid: branch.treeOid, obligationIds: ['source-obligation'], decisionRevisions: [decisionRevision], dependencies: [] } });
    expect(revision.data.status).toBe('reserved');
    const published = await runSourceJob(runner, { remote, workspaceRoot: join(scratch, 'workspace'), resolveRepository: () => branch.dir, requestId: `publication-${index}` });
    expect(published?.data.status).toBe('completed');
    const readback = await readSourceReceipt(remote, `refs/agent/revisions/${change.id}/${revision.id}`);
    expect(readback).toMatchObject({ commitOid: branch.commitOid, treeOid: branch.treeOid });
    expect(await (index === 0 ? alice : bob).revision(revision.id)).toMatchObject({ data: { status: 'published', receipt: readback } });
    expect((await (index === 0 ? alice : bob).change(change.id)).data.latestRevisionId).toBe(revision.id);
  }
  const publishedRevisions = await Promise.all(changes.map(async change => {
    const latestRevisionId = (await human.change(change.id)).data.latestRevisionId!;
    return human.revision(latestRevisionId);
  }));
  const manifest = {
    baseVersion: 1, baseCommitOid: commitOid, contractVersion: 1, policyVersion: 1,
    orderedRevisions: publishedRevisions.map(revision => ({ changeId: revision.data.changeId, revisionId: revision.data.revisionId })),
    excludedChangeIds: [], decisionRevisions: [decisionRevision], compositionVersion: 1,
  };
  const view = await human.createView({ requestId: 'view-create-first', expectedVersion: 0, payload: manifest });
  expect(view.data.manifest).toEqual(manifest);
  expect(view.data.status).toBe('queued');
  const composition = await runSourceJob(runner, { remote, workspaceRoot: join(scratch, 'workspace'), resolveRepository: () => remote, requestId: 'view-run-first' });
  expect(composition?.data.status).toBe('completed');
  expect(composition?.data.input.kind).toBe('composition');
  const firstView = await human.view(view.id);
  expect(firstView.data.status).toBe('runnable');
  expect(firstView.data.manifest).toEqual(manifest);
  expect(firstView.data.receipt?.ref).toBe(`refs/agent/views/${view.id}`);
  const jsonChecks = [{ id: 'local-check', obligationIds: ['source-obligation'], entrypoint: 'probe.mjs', expected: { version: 2 } }];
  const firstCheckRun = await runViewJsonSuite(runner, { remote, workspaceRoot: join(scratch, 'workspace'), viewId: view.id, projectId: 'local-e2e', checks: jsonChecks, requestId: 'check-first' });
  expect(firstCheckRun).toHaveLength(1);
  expect(firstCheckRun[0]!.data).toMatchObject({ result: 'failed', checkId: 'local-check', applicability: { viewId: view.id } });
  const firstChecks = await human.checks(view.id);
  expect(firstChecks).toEqual(firstCheckRun);
  expect(firstChecks[0]!.owner).toBe('runner');
  const absent = await human.finding('00000000-0000-4000-8000-000000000000').catch((error: { status?: number }) => error);
  expect(absent).toMatchObject({ status: 404 });
  const readinessBefore = await human.readiness(view.id);
  expect(readinessBefore.blockers.map(blocker => blocker.code)).toContain('EVIDENCE_MISSING');
  const anchor = { viewId: view.id, manifestDigest: firstView.data.manifestDigest!, composedCommitOid: firstView.data.receipt!.commitOid, treeOid: firstView.data.receipt!.treeOid, contractVersion: 1, policyVersion: 1 };
  const findingEnvelope = { requestId: 'finding-source-defect', payload: { ...anchor, obligationIds: ['source-obligation'], affectedChangeIds: [changes[0]!.id], paths: ['probe.mjs'], expected: 'The independent JSON check returns version 2', observed: firstChecks[0]!.data.execution.stdout, nextOwner: 'alice' } };
  const invalidAnchor = await human.createFinding({ ...findingEnvelope, requestId: 'finding-wrong-anchor', payload: { ...findingEnvelope.payload, treeOid: commitOid } }).catch((error: { status?: number }) => error);
  expect(invalidAnchor).toMatchObject({ status: 422 });
  expect(await runner.createFinding({ ...findingEnvelope, requestId: 'finding-runner-denied' }).catch((error: { status?: number }) => error)).toMatchObject({ status: 403 });
  const finding = await human.createFinding(findingEnvelope);
  expect(finding.data).toMatchObject({ status: 'open', paths: ['probe.mjs'], nextOwner: 'alice' });
  expect(await alice.context()).toMatchObject({ findings: [expect.objectContaining({ id: finding.id })] });
  expect(await alice.findings()).toEqual([finding]);
  expect(await alice.finding(finding.id)).toEqual(finding);
  const forbiddenRepair = await bob.proposeRepair(finding.id, { requestId: 'repair-wrong-owner', payload: { revisions: [{ changeId: changes[0]!.id, revisionId: publishedRevisions[0]!.data.revisionId }] } }).catch((error: { status?: number }) => error);
  expect(forbiddenRepair).toMatchObject({ status: 403 });
  const reviewPayload = { ...anchor, obligationIds: ['source-obligation'], summary: 'Independent review claim', verdict: 'passed' as const, findings: [finding.id] };
  await expect(reviewer.reviewView(view.id, { requestId: 'review-path-mismatch', payload: { ...reviewPayload, viewId: '00000000-0000-4000-8000-000000000001' } })).rejects.toThrow(TypeError);
  const passedReview = await reviewer.reviewView(view.id, { requestId: 'review-passed', payload: reviewPayload });
  const failedReview = await reviewer.reviewView(view.id, { requestId: 'review-failed', payload: { ...reviewPayload, summary: 'Independent failed review claim', verdict: 'failed' } });
  expect(await human.reviews(view.id)).toEqual([passedReview, failedReview]);
  expect((await human.readiness(view.id)).blockers.map(blocker => blocker.code)).toEqual(expect.arrayContaining(['EVIDENCE_MISSING', 'FINDING_OPEN', 'REVIEW_FAILED']));
  const firstRef = await readSourceReceipt(remote, `refs/agent/views/${view.id}`);
  const candidate = join(scratch, 'workspace', 'views', view.id);
  expect(git(candidate, 'rev-parse', 'HEAD')).toBe(firstRef.commitOid);
  expect(await readFile(join(candidate, 'alice.txt'), 'utf8')).toBe('alice change\n');
  expect(await readFile(join(candidate, 'bob.txt'), 'utf8')).toBe('bob change\n');
  await writeFile(join(candidate, 'alice.txt'), 'local dirty edit\n');
  const dirtyCopy = join(scratch, 'dirty-candidate.txt');
  await writeFile(dirtyCopy, await readFile(join(candidate, 'alice.txt')));
  const oldDirtyBytes = await readFile(dirtyCopy);
  expect(await readFile(join(candidate, 'alice.txt'))).toEqual(oldDirtyBytes);
  const oldRef = await readSourceReceipt(remote, firstView.data.receipt!.ref);

  const aliceChange = changes[0]!;
  const updated = await makeBranch('alice-updated', 'alice.txt', 'alice updated\n');
  await writeFile(join(updated.dir, 'probe.mjs'), 'console.log(JSON.stringify({version:2}));\n');
  git(updated.dir, 'add', '.'); git(updated.dir, 'commit', '--amend', '-qm', 'alice updated probe');
  updated.commitOid = git(updated.dir, 'rev-parse', 'HEAD'); updated.treeOid = git(updated.dir, 'rev-parse', 'HEAD^{tree}');
  const newer = await alice.publishRevision(aliceChange.id, { requestId: 'revision-alice-updated', payload: { baseCommitOid: commitOid, commitOid: updated.commitOid, treeOid: updated.treeOid, obligationIds: ['source-obligation'], decisionRevisions: [decisionRevision], dependencies: [] } });
  expect(newer.data.status).toBe('reserved');
  await runSourceJob(runner, { remote, workspaceRoot: join(scratch, 'workspace'), resolveRepository: () => updated.dir, requestId: 'publication-alice-updated' });
  const repair = await alice.proposeRepair(finding.id, { requestId: 'repair-alice', payload: { revisions: [{ changeId: aliceChange.id, revisionId: newer.id }] } });
  expect(repair.data).toMatchObject({ status: 'repair-proposed', repairs: [{ changeId: aliceChange.id, revisionId: newer.id }] });
  expect(await alice.resolveFinding(finding.id, { requestId: 'resolve-contributor-denied', payload: { viewId: view.id, note: 'Peer fix observed' } }).catch((error: { status?: number }) => error)).toMatchObject({ status: 403 });
  expect(await resolver.resolveFinding(finding.id, { requestId: 'resolve-human-no-checks', payload: { viewId: view.id, note: 'Fix reviewed' } }).catch((error: { status?: number }) => error)).toMatchObject({ status: 409 });
  expect(await human.viewUpdates(view.id)).toMatchObject({ viewId: view.id, baselineChanged: false, revisions: [
    { changeId: aliceChange.id, pinnedRevisionId: publishedRevisions[0]!.data.revisionId, latestRevisionId: newer.data.revisionId },
    { changeId: changes[1]!.id, pinnedRevisionId: publishedRevisions[1]!.data.revisionId, latestRevisionId: publishedRevisions[1]!.data.revisionId },
  ] });

  const updatedManifest = { ...manifest, orderedRevisions: [{ changeId: aliceChange.id, revisionId: newer.data.revisionId }, manifest.orderedRevisions[1]!] };
  const updatedView = await human.createView({ requestId: 'view-create-updated', expectedVersion: 0, payload: updatedManifest });
  expect(updatedView.data.manifest).toEqual(updatedManifest);
  await runSourceJob(runner, { remote, workspaceRoot: join(scratch, 'workspace'), resolveRepository: () => remote, requestId: 'view-run-updated' });
  const updatedReceipt = (await human.view(updatedView.id)).data.receipt!;
  const repairedCheckRun = await runViewJsonSuite(runner, { remote, workspaceRoot: join(scratch, 'workspace'), viewId: updatedView.id, projectId: 'local-e2e', checks: jsonChecks, requestId: 'check-repaired' });
  expect(repairedCheckRun).toHaveLength(1);
  expect(repairedCheckRun[0]!.data).toMatchObject({ result: 'passed', checkId: 'local-check', applicability: { viewId: updatedView.id } });
  expect(await human.checks(updatedView.id)).toEqual(repairedCheckRun);
  expect(await human.checks(view.id)).toEqual(firstChecks);
  expect((await human.checks(view.id))[0]!.data.result).toBe('failed');
  expect((await human.readiness(updatedView.id)).blockers.map(blocker => blocker.code)).toContain('EVIDENCE_MISSING');
  const rawHumanAcceptance = await fetch(`${baseUrl}api/v1/projects/local-e2e/acceptances`, { method: 'POST', headers: { Authorization: 'Bearer local-human-resolver', 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: 'raw-accept-no-policy', payload: { viewId: updatedView.id } }) });
  expect(rawHumanAcceptance.status).toBe(409);
  expect(await rawHumanAcceptance.json()).toMatchObject({ code: 'EVIDENCE_MISSING' });
  const rawAgentAcceptance = await fetch(`${baseUrl}api/v1/projects/local-e2e/acceptances`, { method: 'POST', headers: { Authorization: 'Bearer local-alice', 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: 'raw-agent-accept-denied', payload: { viewId: updatedView.id } }) });
  expect(rawAgentAcceptance.status).toBe(403);
  expect(await rawAgentAcceptance.json()).toMatchObject({ code: 'FORBIDDEN' });
  expect((await human.readiness(updatedView.id)).findingIds).toContain(finding.id);
  expect((await human.readiness(view.id)).findingIds).toContain(finding.id);
  expect(await readFile(join(scratch, 'workspace', 'views', updatedView.id, 'alice.txt'), 'utf8')).toBe('alice updated\n');
  expect(await readFile(dirtyCopy)).toEqual(oldDirtyBytes);
  expect(await readFile(join(candidate, 'alice.txt'))).toEqual(oldDirtyBytes);
  expect(await readSourceReceipt(remote, oldRef.ref)).toEqual(oldRef);
  expect(git(candidate, 'rev-parse', 'HEAD')).toBe(firstRef.commitOid);
  expect(await readSourceReceipt(remote, updatedReceipt.ref)).toEqual(updatedReceipt);

  const conflictingBranches = await Promise.all([
    makeBranch('conflict-alice', 'shared-conflict.txt', 'alice version\n'),
    makeBranch('conflict-bob', 'shared-conflict.txt', 'bob version\n'),
  ]);
  const conflictingChanges = await Promise.all([
    alice.createChange({ requestId: 'change-conflict-alice', payload: { title: 'Alice conflicting change', obligationIds: ['source-obligation'] } }),
    bob.createChange({ requestId: 'change-conflict-bob', payload: { title: 'Bob conflicting change', obligationIds: ['source-obligation'] } }),
  ]);
  const conflictingRevisionIds: string[] = [];
  for (let index = 0; index < conflictingChanges.length; index++) {
    const change = conflictingChanges[index]!, branch = conflictingBranches[index]!, contributor = index === 0 ? alice : bob;
    const revision = await contributor.publishRevision(change.id, { requestId: `revision-conflict-${index}`, payload: { baseCommitOid: commitOid, commitOid: branch.commitOid, treeOid: branch.treeOid, obligationIds: ['source-obligation'], decisionRevisions: [decisionRevision], dependencies: [] } });
    conflictingRevisionIds.push(revision.id);
    const publication = await runSourceJob(runner, { remote, workspaceRoot: join(scratch, 'workspace'), resolveRepository: () => branch.dir, requestId: `publication-conflict-${index}` });
    expect(publication?.data.status).toBe('completed');
  }
  const conflictManifest = { ...manifest, orderedRevisions: conflictingChanges.map((change, index) => ({ changeId: change.id, revisionId: conflictingRevisionIds[index]! })), excludedChangeIds: changes.map(change => change.id) };
  const conflictView = await human.createView({ requestId: 'view-create-conflict', expectedVersion: 0, payload: conflictManifest });
  const conflictRun = await runSourceJob(runner, { remote, workspaceRoot: join(scratch, 'workspace'), resolveRepository: () => remote, requestId: 'view-run-conflict' });
  expect(conflictRun?.data.status).toBe('failed');
  expect(conflictRun?.data.error).toBe('GIT_CONFLICT');
  expect(await human.view(conflictView.id)).toMatchObject({ data: { status: 'failed', receipt: null, error: 'GIT_CONFLICT' } });
  expect(await human.context()).toMatchObject({ baseline: { commitOid, version: 1 } });
  expect(await runSourceJob(runner, { remote, workspaceRoot: join(scratch, 'workspace'), resolveRepository: () => remote, requestId: 'view-run-conflict-retry' })).toBeNull();
  expect(await reviewer.createChange({ requestId: 'reviewer-change', payload: { title: 'Forbidden', obligationIds: ['source-obligation'] } }).catch((e: { status?: number }) => e)).toMatchObject({ status: 403 });
  expect(await human.context()).toMatchObject({ baseline: { commitOid, version: 1 } });
  expect(await human.initializeBaseline({ requestId: 'seed-human-conflict', expectedVersion: 0, payload: { commitOid, treeOid } }).catch((e: { status?: number }) => e)).toMatchObject({ status: 409 });
}, 60_000);
