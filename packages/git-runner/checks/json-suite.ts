import { createHash } from 'node:crypto';
import { applicabilitySchema, type Applicability } from '../../contracts/index.js';
import { runSandboxedNode, type SandboxExecution } from './sandbox.js';

export interface JsonCheckDefinition {
  id: string;
  obligationIds: string[];
  entrypoint: string;
  args?: string[];
  expected: unknown;
}

export interface JsonCheckReceipt {
  kind: 'recorded-check';
  checkId: string;
  obligationIds: string[];
  applicability: Applicability;
  harnessVersion: 'json-oracle-v1';
  result: 'passed' | 'failed';
  execution: SandboxExecution;
}

const harnessVersion = 'json-oracle-v1' as const;
const maxSerializedBytes = 128 * 1024;
const idPattern = /^[A-Za-z0-9_-]{1,120}$/;

function normalizeJson(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object') throw new Error('Check definitions must contain only finite JSON values');
  if (ancestors.has(value)) throw new Error('Check definitions cannot contain cycles');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) if (!Object.hasOwn(value, i)) throw new Error('Sparse arrays are not valid JSON definitions');
      return value.map(item => normalizeJson(item, ancestors));
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new Error('Check definitions must use plain JSON objects');
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value).sort()) result[key] = normalizeJson((value as Record<string, unknown>)[key], ancestors);
    return result;
  } finally { ancestors.delete(value); }
}

function validateChecks(checks: readonly JsonCheckDefinition[]): unknown[] {
  if (!Array.isArray(checks) || checks.length < 1 || checks.length > 10) throw new Error('JSON suite must contain 1..10 checks');
  const ids = new Set<string>();
  const allObligations = new Set<string>();
  const normalized = checks.map(check => {
    if (!check || typeof check !== 'object' || typeof check.id !== 'string' || !idPattern.test(check.id) || ids.has(check.id)) throw new Error('Check IDs must be unique bounded identifiers');
    ids.add(check.id);
    if (!Array.isArray(check.obligationIds) || check.obligationIds.length < 1 || check.obligationIds.length > 100) throw new Error('Each check requires 1..100 obligation IDs');
    for (const id of check.obligationIds) {
      if (typeof id !== 'string' || !idPattern.test(id) || allObligations.has(id)) throw new Error('Obligation IDs must be unique bounded identifiers across the suite');
      allObligations.add(id);
    }
    if (typeof check.entrypoint !== 'string' || !check.entrypoint || check.entrypoint.length > 256 || check.entrypoint.startsWith('/') || check.entrypoint.split(/[\\/]/).some((part: string) => !part || part === '.' || part === '..') || check.entrypoint.includes('\\')) throw new Error('Invalid relative entrypoint');
    if (check.args !== undefined && (!Array.isArray(check.args) || check.args.length > 32 || check.args.some((arg: string) => typeof arg !== 'string' || arg.length > 2048 || arg.includes('\0')))) throw new Error('Arguments exceed suite bounds');
    return normalizeJson({ id: check.id, obligationIds: check.obligationIds, entrypoint: check.entrypoint, ...(check.args === undefined ? {} : { args: check.args }), expected: check.expected });
  });
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > maxSerializedBytes) throw new Error('JSON suite definitions exceed size bound');
  return normalized;
}

export function jsonSuiteDigest(checks: readonly JsonCheckDefinition[]): string {
  return createHash('sha256').update(JSON.stringify({ harnessVersion, checks: validateChecks(checks) })).digest('hex');
}

export async function runJsonSuite(options: {
  candidateDirectory: string;
  applicability: Applicability;
  checks: readonly JsonCheckDefinition[];
}): Promise<JsonCheckReceipt[]> {
  const applicability = applicabilitySchema.parse(options.applicability);
  const normalizedChecks = validateChecks(options.checks);
  const digest = createHash('sha256').update(JSON.stringify({ harnessVersion, checks: normalizedChecks })).digest('hex');
  if (applicability.checkSuiteDigest !== digest) throw new Error('Applicability check suite digest does not match trusted JSON suite');
  const receipts: JsonCheckReceipt[] = [];
  for (let i = 0; i < options.checks.length; i++) {
    const check = options.checks[i]!;
    const execution = await runSandboxedNode({ candidateDirectory: options.candidateDirectory, entrypoint: check.entrypoint, ...(check.args === undefined ? {} : { args: check.args }) });
    let passed = false;
    if (execution.status === 'exited' && execution.exitCode === 0 && execution.stdout.length > 0) {
      try {
        const actual = normalizeJson(JSON.parse(execution.stdout));
        passed = JSON.stringify(actual) === JSON.stringify((normalizedChecks[i] as { expected: unknown }).expected);
      } catch { passed = false; }
    }
    receipts.push({ kind: 'recorded-check', checkId: check.id, obligationIds: [...check.obligationIds], applicability, harnessVersion, result: passed ? 'passed' : 'failed', execution });
  }
  return receipts;
}
