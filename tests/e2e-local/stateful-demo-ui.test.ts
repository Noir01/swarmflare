import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { demoUiSuiteDigest, runDemoUiSuite } from '../../packages/git-runner/checks/demo-ui-suite.js';
import { buildCursorRepair } from '../../demo/cloud/cursor-repair.js';
import { buildTenantRepair } from '../../demo/cloud/repair-fixture.js';
import { prepareRepository } from '../../demo/cloud/candidate-smoke.js';

let root = '', work = '';
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'false', GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: '/dev/null', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'] }).trim();

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'stateful-demo-ui-'));
  const cache = join(root, 'cache.git'), seed = join(root, 'seed'); work = join(root, 'materialized');
  await mkdir(seed); git('init', seed); await writeFile(join(seed, 'README.md'), 'Synthetic baseline\n');
  git('-C', seed, 'add', '.'); git('-C', seed, 'commit', '-qm', 'Synthetic baseline');
  const base = git('-C', seed, 'rev-parse', 'HEAD'); git('clone', '--bare', seed, cache);
  const prepared = await prepareRepository(cache, join(root, 'prepared'), base);
  git('--git-dir='+cache, 'fetch', join(root, 'prepared'), prepared.commitOid);
  const uiWork = join(root, 'ui'); await mkdir(uiWork);
  const ui = await buildTenantRepair({ cache, viewCommitOid: prepared.commitOid, baselineCommitOid: base, workDirectory: uiWork });
  git('--git-dir='+cache, 'fetch', join(root, 'ui'), ui.commitOid);
  await buildCursorRepair({ cache, viewCommitOid: ui.commitOid, baselineCommitOid: base, workDirectory: work });
});
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

it('records stateful tenant pagination in one handler and replays the actual responses in the UI', async () => {
  const applicability = { projectId: 'local-demo', viewId: 'stateful-ui', manifestDigest: 'a'.repeat(64), composedCommitOid: git('-C', work, 'rev-parse', 'HEAD'), treeOid: git('-C', work, 'rev-parse', 'HEAD^{tree}'), contractVersion: 1, policyVersion: 1, checkSuiteDigest: demoUiSuiteDigest() };
  const [receipt] = await runDemoUiSuite({ candidateDirectory: work, applicability });
  expect(receipt?.result, receipt?.execution.stdout).toBe('passed');
  const output = JSON.parse(receipt!.execution.stdout);
  expect(output.facts.events).toHaveLength(6);
  expect(output.facts.events[1].status).toBe(200);
  expect(output.facts.events[1].tenant).toBe('tenant-a');
  expect(output.facts.events[1].cursor).toBe(output.facts.events[0].nextCursor);
});
