import { createHash } from 'node:crypto';
import { applicabilitySchema, type Applicability } from '../../contracts/index.js';
import { demoSuiteDigest, runDemoSuite, type DemoCheckReceipt } from './demo-suite.js';
import { demoUiSuiteDigest, runDemoUiSuite } from './demo-ui-suite.js';

const harnessVersion = 'json-oracle-v1';

export function mandatoryDemoSuiteDigest(): string {
  return createHash('sha256').update(JSON.stringify({
    harnessVersion,
    apiDigest: demoSuiteDigest(),
    uiDigest: demoUiSuiteDigest(),
  })).digest('hex');
}

export async function runMandatoryDemoSuite(options: {
  candidateDirectory: string;
  applicability: Applicability;
}): Promise<DemoCheckReceipt[]> {
  // Strictly validate the complete outer applicability before starting either child.
  const applicability = applicabilitySchema.parse(options.applicability);
  if (applicability.checkSuiteDigest !== mandatoryDemoSuiteDigest()) {
    throw new Error('Applicability check suite digest does not match trusted mandatory demo suite');
  }
  const common = { ...applicability };
  const results = await Promise.allSettled([
    runDemoSuite({ candidateDirectory: options.candidateDirectory, applicability: {
      ...common, checkSuiteDigest: demoSuiteDigest(),
    } }),
    runDemoUiSuite({ candidateDirectory: options.candidateDirectory, applicability: {
      ...common, checkSuiteDigest: demoUiSuiteDigest(),
    } }),
  ]);
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (rejected) throw rejected.reason;
  const [api, ui] = results.map(result => (result as PromiseFulfilledResult<DemoCheckReceipt[]>).value);
  return [...api, ...ui].map(receipt => ({ ...receipt, applicability }));
}