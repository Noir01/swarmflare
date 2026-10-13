import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Applicability } from '../../packages/contracts/index.js';
import { jsonSuiteDigest, runJsonSuite, type JsonCheckDefinition } from '../../packages/git-runner/checks/json-suite.js';

const baseApplicability = {
  projectId: 'project', viewId: 'view', manifestDigest: 'a'.repeat(64), composedCommitOid: 'b'.repeat(40),
  treeOid: 'c'.repeat(40), contractVersion: 1, policyVersion: 1, checkSuiteDigest: 'd'.repeat(64),
} satisfies Applicability;
const check: JsonCheckDefinition = {
  id: 'json-result', obligationIds: ['obligation-1'], entrypoint: 'main.js', expected: { answer: 42, nested: [true, null] },
};

async function run(script: string, checks: readonly JsonCheckDefinition[] = [check]) {
  const candidateDirectory = await mkdtemp(join(tmpdir(), 'json-suite-test-'));
  await writeFile(join(candidateDirectory, 'main.js'), script);
  try {
    return await runJsonSuite({ candidateDirectory, checks, applicability: { ...baseApplicability, checkSuiteDigest: jsonSuiteDigest(checks) } });
  } finally { await rm(candidateDirectory, { recursive: true, force: true }); }
}

describe('trusted JSON check suite', () => {
  it('passes when a real candidate prints the exact expected JSON data', async () => {
    const [receipt] = await run("console.log(JSON.stringify({answer: 42, nested: [true, null]}));");
    expect(receipt).toMatchObject({ kind: 'recorded-check', checkId: 'json-result', result: 'passed', execution: { status: 'exited', exitCode: 0 } });
  });
  it('fails incorrect data even with exit zero', async () => {
    const [receipt] = await run("console.log(JSON.stringify({answer: 41, nested: [true, null]}));");
    expect(receipt.result).toBe('failed');
  });
  it('fails empty output and a candidate-claimed passed flag', async () => {
    const [empty] = await run('process.exit(0);');
    const [fake] = await run("console.log(JSON.stringify({passed: true}));");
    expect(empty.result).toBe('failed'); expect(fake.result).toBe('failed');
  });
  it('fails malformed or multiple JSON values', async () => {
    const [malformed] = await run("console.log('{');");
    const [multiple] = await run("console.log('{\\\"answer\\\":42,\\\"nested\\\":[true,null]}'); console.log('null');");
    expect(malformed.result).toBe('failed'); expect(multiple.result).toBe('failed');
  });
  it('fails timed-out candidates', async () => {
    const [receipt] = await run('while (true) {}');
    expect(receipt.result).toBe('failed'); expect(receipt.execution.status).toBe('timed-out');
  });
  it('fails nonzero exits and output-limit executions', async () => {
    const [nonzero] = await run("console.log(JSON.stringify({answer: 42, nested: [true, null]})); process.exitCode = 1;");
    const [limited] = await run("console.log('x'.repeat(20000));");
    expect(nonzero.result).toBe('failed');
    expect(limited.result).toBe('failed'); expect(limited.execution.status).toBe('output-limit');
  });
  it('passes script arguments after the entrypoint', async () => {
    const checks = [{ ...check, args: ['42'] }];
    const [receipt] = await run("console.log(JSON.stringify({answer: Number(process.argv[2]), nested: [true, null]}));", checks);
    expect(receipt.result).toBe('passed');
  });
  it('rejects a stale suite digest before executing candidate code', async () => {
    const candidateDirectory = await mkdtemp(join(tmpdir(), 'json-suite-stale-'));
    try {
      await writeFile(join(candidateDirectory, 'main.js'), "throw new Error('must not execute');");
      await expect(runJsonSuite({ candidateDirectory, checks: [check], applicability: baseApplicability })).rejects.toThrow(/digest/i);
    } finally { await rm(candidateDirectory, { recursive: true, force: true }); }
  });
  it('canonicalizes object field order in the suite digest', () => {
    const reordered = { ...check, expected: { nested: [true, null], answer: 42 } };
    expect(jsonSuiteDigest([check])).toBe(jsonSuiteDigest([reordered]));
  });
});
