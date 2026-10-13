import { describe, expect, it } from 'vitest';
import { mandatoryDemoSuiteDigest } from '../../packages/git-runner/checks/mandatory-demo-suite';
import { demoPolicyManifest } from '../../apps/worker/src/generated/demo-policy';
import { demoPolicyModel } from '../../apps/worker/src/http/repository-policy';

describe('generated repository demo policy', () => {
  it('pins the trusted source-based mandatory suite digest and complete six-obligation contract', () => {
    expect(demoPolicyManifest.policyTemplate.checkSuiteDigest).toBe(mandatoryDemoSuiteDigest());
    expect(demoPolicyManifest.contract.obligations.map(item => item.id)).toEqual(['legacy-response', 'pagination-order', 'cursor-validation', 'tenant-isolation', 'ui-navigation', 'ui-tenant-switch']);
    expect(demoPolicyManifest.contract.requiredCheckIds).toEqual(['mandatory-demo-api', 'mandatory-demo-ui']);
  });
  it('supports only exactly the obligation and check ID set', () => {
    const contract = demoPolicyManifest.contract;
    expect(demoPolicyModel(contract).supported).toBe(true);
    expect(demoPolicyModel({ ...contract, obligations: contract.obligations.slice(0, 5) }).supported).toBe(false);
    expect(demoPolicyModel({ ...contract, requiredCheckIds: ['mandatory-demo-api'] }).supported).toBe(false);
  });
  it('provides meaningful pagination expectations in the generated template', () => {
    const page = demoPolicyManifest.contract.obligations.find(item => item.id === 'pagination-order');
    expect(page?.acceptanceExamples.length).toBeGreaterThan(0);
  });
});
