import { WorkspaceClient } from '../../packages/client/index';
import { mandatoryDemoSuiteDigest } from '../../packages/git-runner/checks/mandatory-demo-suite';
import { contractInput } from '../../packages/contracts/index';
import { seedInput } from '../../packages/contracts/source';

const obligations = ['legacy-response', 'pagination-order', 'cursor-validation', 'tenant-isolation', 'ui-navigation', 'ui-tenant-switch'] as const;
const requiredCheckIds = ['mandatory-demo-api', 'mandatory-demo-ui'] as const;
const usage = 'Usage: npx tsx apps/setup/index.ts \'{"requestId":"setup-001","commitOid":"<40-hex-oid>","treeOid":"<40-hex-oid>","sourceBackend":"local-git"}\'\nsourceBackend is optional (local-git default) and may be artifacts-git. Requires WORKSPACE_BASE_URL, WORKSPACE_PROJECT_ID, WORKSPACE_TOKEN. Local loopback only.';

function parseBaseUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('WORKSPACE_BASE_URL must be an absolute local HTTP URL'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', '::1'].includes(host) || url.username || url.password || url.search || url.hash || url.pathname !== '/' && url.pathname !== '') {
    throw new Error('WORKSPACE_BASE_URL must be literal local HTTP loopback without credentials, path, query, or fragment');
  }
  return url.origin;
}

function validate(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('argument must be a JSON object');
  const x = input as Record<string, unknown>;
  if (Object.keys(x).some(key => !['requestId', 'commitOid', 'treeOid', 'sourceBackend'].includes(key)) ||
      !['commitOid', 'requestId', 'treeOid'].every(key => Object.hasOwn(x, key)))
    throw new Error('argument must contain requestId, commitOid and treeOid, with no other keys except optional sourceBackend');
  if (typeof x.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(x.requestId)) throw new Error('requestId must be 1-80 letters, digits, underscores or hyphens');
  const sourceBackend = x.sourceBackend === undefined ? 'local-git' : x.sourceBackend;
  if (sourceBackend !== 'local-git' && sourceBackend !== 'artifacts-git') throw new Error('sourceBackend must be local-git or artifacts-git');
  const source = seedInput.parse({ commitOid: x.commitOid, treeOid: x.treeOid });
  return { requestId: x.requestId, source, sourceBackend };
}

async function main() {
  const [raw, ...extra] = process.argv.slice(2);
  if (raw === '--help' || raw === '-h' || raw === 'help') { process.stdout.write(`${usage}\n`); return; }
  if (!raw || extra.length) throw new Error(usage);
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('argument must be valid JSON'); }
  const input = validate(parsed);
  const baseUrl = process.env.WORKSPACE_BASE_URL;
  const projectId = process.env.WORKSPACE_PROJECT_ID;
  const token = process.env.WORKSPACE_TOKEN;
  if (!baseUrl || !projectId || !token) throw new Error('WORKSPACE_BASE_URL, WORKSPACE_PROJECT_ID and WORKSPACE_TOKEN are required');
  const localBaseUrl = parseBaseUrl(baseUrl);
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(projectId)) throw new Error('WORKSPACE_PROJECT_ID must be a valid project ID');

  const client = new WorkspaceClient({ baseUrl: localBaseUrl, projectId, token, maxRequests: 30, deadline: 30_000 });
  const suffix = input.requestId;
  // Refuse incompatible state before the first mutation. Matching state is safe to
  // resume: mutation request IDs below replay the original server result.
  const [currentContext, existingPolicy, existingBaseline] = await Promise.all([
    client.context(), client.policy(), client.baseline(),
  ]);
  const expectedObligations = obligations.map(id => ({ id, description: `Demonstrate ${id.replaceAll('-', ' ')}.`, acceptanceExamples: [] }));
  const expectedPolicyChecks = [
    { id: 'mandatory-demo-api', obligationIds: [...obligations.slice(0, 4)] },
    { id: 'mandatory-demo-ui', obligationIds: [...obligations.slice(4)] },
  ];
  const currentContract = currentContext.contract as { version?: number; data?: Record<string, unknown> } | null;
  if (currentContract && currentContract.version !== 1)
    throw new Error('incompatible preexisting contract; setup made no changes');
  const contractData = currentContract?.data;
  if (contractData && (JSON.stringify(contractData.obligations) !== JSON.stringify(expectedObligations) ||
      JSON.stringify(contractData.requiredCheckIds) !== JSON.stringify([...requiredCheckIds]) ||
      contractData.outcome !== 'Deliver the approved demo with verifiable API behavior and usable tenant-aware UI navigation.' ||
      JSON.stringify(contractData.constraints) !== JSON.stringify(['Use the mandatory local API and UI demo suites; preserve tenant isolation.'])))
    throw new Error('incompatible preexisting contract; setup made no changes');
  const policyDataExisting = existingPolicy?.data;
  if (policyDataExisting && (existingPolicy!.version !== 1 || policyDataExisting.contractVersion !== 1 ||
      policyDataExisting.checkSuiteDigest !== mandatoryDemoSuiteDigest() || policyDataExisting.harnessVersion !== 'json-oracle-v1' ||
      policyDataExisting.requireIndependentReview !== true || policyDataExisting.sourceBackend !== input.sourceBackend ||
      JSON.stringify(policyDataExisting.checks) !== JSON.stringify(expectedPolicyChecks)))
    throw new Error('incompatible preexisting policy; setup made no changes');
  if (existingBaseline) throw new Error('preexisting baseline; setup made no changes');
  const proposal = await client.createProposal({ requestId: `${suffix}-contract`, payload: contractInput.parse({
    outcome: 'Deliver the approved demo with verifiable API behavior and usable tenant-aware UI navigation.',
    constraints: ['Use the mandatory local API and UI demo suites; preserve tenant isolation.'],
    obligations: obligations.map(id => ({ id, description: `Demonstrate ${id.replaceAll('-', ' ')}.`, acceptanceExamples: [] })),
    requiredCheckIds: [...requiredCheckIds], unresolvedQuestions: [],
  }) }) as { id: string };
  await client.approveProposal(proposal.id, { requestId: `${suffix}-approve`, expectedVersion: 0, payload: {} });
  await client.configurePolicy({ requestId: `${suffix}-policy`, expectedVersion: 0, payload: {
    contractVersion: 1, checkSuiteDigest: mandatoryDemoSuiteDigest(), harnessVersion: 'json-oracle-v1',
    checks: [
      { id: 'mandatory-demo-api', obligationIds: ['legacy-response', 'pagination-order', 'cursor-validation', 'tenant-isolation'] },
      { id: 'mandatory-demo-ui', obligationIds: ['ui-navigation', 'ui-tenant-switch'] },
    ], requireIndependentReview: true, sourceBackend: input.sourceBackend,
  } });
  const job = await client.initializeBaseline({ requestId: `${suffix}-baseline`, expectedVersion: 0, payload: input.source });
  const [contract, policy, persistedBaseline] = await Promise.all([
    client.contract(1), client.policy(), client.baseline(),
  ]);
  const contractDataAfter = (contract as { data?: Record<string, unknown> } | null)?.data;
  const policyData = policy?.data;
  if (!contractDataAfter || JSON.stringify(contractDataAfter.obligations) !== JSON.stringify(expectedObligations) ||
      JSON.stringify(contractDataAfter.requiredCheckIds) !== JSON.stringify([...requiredCheckIds]) ||
      contractDataAfter.outcome !== 'Deliver the approved demo with verifiable API behavior and usable tenant-aware UI navigation.' ||
      JSON.stringify(contractDataAfter.constraints) !== JSON.stringify(['Use the mandatory local API and UI demo suites; preserve tenant isolation.']))
    throw new Error('persisted contract does not match the approved setup contract');
  if (!policyData || policy.version !== 1 || policyData.contractVersion !== 1 ||
      policyData.checkSuiteDigest !== mandatoryDemoSuiteDigest() || policyData.harnessVersion !== 'json-oracle-v1' ||
      policyData.requireIndependentReview !== true || policyData.sourceBackend !== input.sourceBackend ||
      JSON.stringify(policyData.checks) !== JSON.stringify([
        { id: 'mandatory-demo-api', obligationIds: [...obligations.slice(0, 4)] },
        { id: 'mandatory-demo-ui', obligationIds: [...obligations.slice(4)] },
      ])) throw new Error('persisted policy does not match the approved mandatory demo policy');
  if (persistedBaseline !== null || job.data.status !== 'queued' || job.data.input.kind !== 'seed' ||
      job.data.input.source.commitOid !== input.source.commitOid || job.data.input.source.treeOid !== input.source.treeOid)
    throw new Error('persisted baseline job does not match the pending seed request');
  process.stdout.write(`${JSON.stringify({ mode: 'local-only', sourceBackend: input.sourceBackend, contractId: proposal.id, contractVersion: 1, policyVersion: 1, pendingSeedJobId: job.id, status: 'pending-seed-publication', commitOid: input.source.commitOid, treeOid: input.source.treeOid, note: 'Metadata setup only; the runner must publish and read back the seed before a runnable baseline exists. No code was executed.' })}\n`);
}

main().catch((error: unknown) => {
  let message = error instanceof Error ? error.message : 'setup failed';
  const token = process.env.WORKSPACE_TOKEN;
  if (token) message = message.split(token).join('[REDACTED]');
  process.stderr.write(`${JSON.stringify({ error: message })}\n`);
  process.exitCode = 1;
});
