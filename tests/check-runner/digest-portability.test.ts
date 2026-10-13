import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { demoSuiteDigest } from '../../packages/git-runner/checks/demo-suite.js';
import { demoUiSuiteDigest } from '../../packages/git-runner/checks/demo-ui-suite.js';
import { trustedSourceArtifactDigest } from '../../packages/git-runner/checks/trusted-source-digest.js';

describe('trusted suite digest portability', () => {
  it('matches between Vitest and node --import tsx for API and UI suites', () => {
    const entry = new URL('../../packages/git-runner/checks/', import.meta.url).pathname;
    const script = `
      const api = await import(${JSON.stringify(`${entry}demo-suite.ts`)});
      const ui = await import(${JSON.stringify(`${entry}demo-ui-suite.ts`)});
      process.stdout.write(JSON.stringify({ api: api.demoSuiteDigest(), ui: ui.demoUiSuiteDigest() }));
    `;
    const child = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { encoding: 'utf8' }));
    expect(child).toEqual({ api: demoSuiteDigest(), ui: demoUiSuiteDigest() });
  });

  it('fails closed when the trusted source artifact is absent', () => {
    expect(() => trustedSourceArtifactDigest(new URL('file:///definitely-missing/trusted-suite.ts')))
      .toThrow(/source artifact is unavailable/);
  });
});