import { describe, expect, it } from 'vitest';
import { site } from '../../apps/worker/src/http/site';
import { agentGuideExamples, guideProposalExample, validateAgentGuideExamples } from '../../apps/swarmflare/agent-guide';
import { demoPolicyManifest } from '../../apps/worker/src/generated/demo-policy';
import { findingInput, reviewInput } from '../../packages/contracts/feedback';

describe('first-party Swarmflare agent guide', () => {
  it('serves v2 at the public skill route and explains practical setup and recovery', async () => {
    const response = await site(new Request('https://swarmflare.test/skills/swarmflare.md'), {} as any);
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/markdown');
    expect(text).toContain('# Swarmflare agent guide (v2)');
    const example = text.match(/```json\s*([\s\S]*?)\s*```/)?.[1];
    expect(example).toBeTruthy();
    expect(JSON.parse(example!)).toEqual(guideProposalExample);
    expect(guideProposalExample.payload).toEqual(demoPolicyManifest.contract);
    expect(text).toContain('Agents may submit proposals');
    expect(text).toContain('there is no renewal control in the owner Settings interface');
    expect(text).toContain('GET $API/policy');
    expect(text).toContain('POST /api/platform/repos/<owner>/<repo>/agents/<grantId>/renew');
    expect(text).toContain('it does not mean accepted');
    expect(text).toContain('never human-approve or accept');
    expect(text).not.toMatch(/Bearer [a-f0-9]{64}/i);
    expect(text).not.toMatch(/(?:token|secret|credential)\s*[:=]\s*["'][^<]/i);
  });

  it('keeps proposal, review, and finding examples valid against strict contract schemas', () => {
    const parsed = validateAgentGuideExamples();
    expect(parsed.proposal.success).toBe(true);
    expect(parsed.proposal.success && parsed.proposal.data).toEqual(demoPolicyManifest.contract);
    expect(parsed.review.success).toBe(true);
    expect(parsed.finding.success).toBe(true);
    expect(parsed.proposal.success && parsed.proposal.data).toEqual(agentGuideExamples.proposal.payload);
    expect(parsed.review.success && parsed.review.data).toEqual(agentGuideExamples.review);
    expect(parsed.finding.success && parsed.finding.data).toEqual(agentGuideExamples.finding);
  });

  it('rejects examples with invented fields under strict schemas', () => {
    const { review, finding } = agentGuideExamples;
    expect(reviewInput.safeParse({ ...review, accepted: true }).success).toBe(false);
    expect(findingInput.safeParse({ ...finding, accepted: true }).success).toBe(false);
  });
});
