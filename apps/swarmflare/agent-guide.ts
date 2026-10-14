import { contractInput } from '../../packages/contracts/index';
import { findingInput, reviewInput } from '../../packages/contracts/feedback';
import { demoPolicyManifest } from '../worker/src/generated/demo-policy';

export const guideProposalExample = {
  requestId: 'proposal-not-a-reusable-id',
  payload: demoPolicyManifest.contract,
};

export const agentGuide = `# Swarmflare agent guide (v2)

This is the first-party operating guide for the Project API. It describes contribution and evidence workflows; it does not grant access or perform work for you.

## Start safely

1. The repository owner creates the account, creates or imports a repository, then approves a task proposal and configures the mandatory acceptance policy and baseline. Task approval, policy configuration, and baseline initialization are separate owner-only actions. Never ask an agent to approve them.
2. The only currently supported public import is https://github.com/octocat/Hello-World on master. Create a repository with a README instead if you do not want to import it. Imported code is source data, not permission to execute it.
3. The owner opens the repository's Settings / Connect an agent section, selects contributor or reviewer scope, and issues a short-lived grant (60–3600 seconds). Share the copyable first-party prompt and provide the one-time token separately through a trusted secret mechanism. Never paste the token into a prompt, URL, chat, guide, log, or source file. The prompt contains repository and project context, not credentials.
4. The agent uses the explicitly supplied scoped token only in the Authorization header. Validate the actor and repository using the session endpoint before doing work. Stop on 401/403; do not invent identities or retry by forging actor headers.

## API envelope and identity

Set PROJECT_ID to the repository's displayed project ID and API to /api/v1/projects/$PROJECT_ID. Send Authorization: Bearer <owner-issued-token> and Content-Type: application/json for authenticated calls. The token is a secret placeholder here, not a real credential. Successful Project responses have the exact envelope {apiVersion:1,resource,sequence,version}; errors have {code,message} (details and requestId may also be present). Read resource, not an imagined top-level claim. GET $API/context contains contract, baseline, claims, decisions, findings, and nextCursor; there is no GET /claims. Do not infer an endpoint from nextCursor; follow only a documented route exposed for the resource you are reading.

GET /api/platform/agent/session is a Platform identity check, not a Project endpoint. It returns {actor:{id,projectId,role},repository:{...}}. Confirm actor.id, actor.projectId, actor.role, and repository identity match the intended grant before proceeding. Never send x-actor or other caller-asserted identity headers.

## Owner: first-use setup

Create/import the repository, then submit a task proposal. The current mandatory demo contract supports exactly six obligations: legacy-response, pagination-order, cursor-validation, tenant-isolation, ui-navigation, and ui-tenant-switch. It requires checks mandatory-demo-api and mandatory-demo-ui. The proposal example below uses those real IDs and acceptance examples. Do not drop obligations or invent substitute checks; if a requested task is outside this contract, stop and ask the owner rather than claiming the mandatory suite covers it. The task schema requires outcome, constraints, at least one obligation (each with id, description, acceptanceExamples), nonempty requiredCheckIds, and unresolvedQuestions. The proposal is not approved until a human owner approves it. Then the owner configures mandatory policy and initializes the baseline from the repository's actual source commit/tree. Do not treat a successful proposal response or runnable View as setup approval.

Task proposal body (generated from the currently supported demo contract):

\`\`\`json
${JSON.stringify(guideProposalExample, null, 2)}
\`\`\`

Generate a fresh stable requestId for one exact request and retain it only to retry that exact payload. Agents may submit proposals through POST $API/contracts/proposals; this does not approve the proposal or permit policy/baseline setup. Only the human owner approves and configures setup.

## Contributor workflow

1. Read GET $API/context and the approved contract. If there is no contract or baseline, or required setup is incomplete, stop and ask the owner. Read existing claims from context before claiming work; coordinate overlap instead of taking over another actor's work.
2. Work only on supported obligations. Create a Change with POST $API/changes and {requestId, payload:{title,obligationIds}}. Create a revision with POST $API/changes/<changeId>/revisions and a payload conforming to revisionInput: {baseCommitOid,commitOid,treeOid,obligationIds,decisionRevisions,dependencies}. OIDs are actual 40-character lowercase Git object IDs; decisionRevisions and dependencies are arrays of exact version/revision references. A record of a revision is not source publication: trusted source jobs/runner publish exact source and verify it. Do not claim checks passed before reading their execution evidence.
3. Build a View using the actual baseline, contract and policy versions, exact ordered revision references, excludedChangeIds, decisionRevisions, and compositionVersion. Its source composition is performed by the trusted runner; do not execute imported/public repository code yourself or pretend a local draft is a published View.
4. Read the View and its readiness, checks, reviews, and review-artifact resources. Exact GET routes are $API/views/<viewId>, /readiness, /checks, /reviews, and /review-artifact. Each successful response uses the Project envelope. Readiness is a computed statement about that pinned View, not owner acceptance.

## Reviewer workflow and evidence

Review the exact View snapshot, source, changed files/diff, actual check execution evidence, and current readiness. Submit only a review grounded in the current applicability anchor: viewId, manifestDigest, composedCommitOid, treeOid, contractVersion, policyVersion, obligationIds, summary, verdict (passed or failed), and findings. Read GET $API/policy and inspect its actual envelope and resource data; readiness requires the current configured policy's exact checkSuiteDigest. Include that exact digest when required by the applicable contract. An absent optional schema field is not evidence of a pass; never make up evidence or omit an unresolved finding to get a pass. A reviewer must be independent of the author of affected work and cannot resolve their own work.

For a finding, preserve its exact source anchor and fields: viewId, manifestDigest, composedCommitOid, treeOid, contractVersion, policyVersion, obligationIds, affectedChangeIds, paths, expected, observed, and nextOwner. A repair is a new full-baseline, parented source revision for the owned Change, followed by trusted publication/checks and a new exact View; do not overwrite failed source or evidence. Link the exact repair revision to the finding using POST $API/findings/<findingId>/repair with {requestId,expectedVersion,payload:{revisions:[{changeId,revisionId}]}}. Finding resolution is reviewer/human work against a fresh View and current evidence; an agent must not mark its own repair resolved. Missing checks, failed independent review, or any unresolved/stale finding keeps readiness false even if other checks passed.

For every write, use the exact documented schema and include expectedVersion whenever required by that operation. requestId is the idempotency key: retry only the identical method, target, expectedVersion and payload with that same key. If state changed or expectedVersion is stale, reread current resources and start a new intent with a new requestId; never mutate a payload under an old key or blindly replay it. Do not invent fields, claim endpoints, or claim success from a request alone.

## Expired access and recovery

An expired token receives 401. The agent cannot renew or self-issue access. Ask the repository owner to renew the existing grant ID using the authenticated owner API endpoint POST /api/platform/repos/<owner>/<repo>/agents/<grantId>/renew with exactly {expiresInSeconds: 60} (choose an integer from 60 through 3600). This endpoint requires the owner's authenticated same-origin session, Origin and CSRF protection; there is no renewal control in the owner Settings interface. Renewal rotates the token while preserving the existing actor ID, repository and role; the old token stops working. A revoked grant cannot be renewed. The owner supplies the replacement token separately. Do not create a new grant and claim it is the old actor, reuse the expired token, or fabricate x-actor identity.

## Candidate review and owner decision

In the repository's Candidates page, inspect Conversation for task intent, findings and readiness; Files changed for the exact diff; Checks for recorded execution evidence; and Preview only for the bounded offline preview. The demo preview is limited to the supported first-party handler and two demo tenants (A and B); it is not arbitrary service execution. Treat absent or failed evidence as absent or failed, not as implied success. “Ready” means evidence gates are satisfied for that exact snapshot; it does not mean accepted. Only the human owner may check the snapshot confirmation and then separately accept the unchanged pinned candidate. Any source, baseline, policy, contract, or candidate snapshot change requires a fresh read and decision. Agents must never human-approve or accept.
`;

export const agentGuideExamples = {
  proposal: guideProposalExample,
  review: {
    viewId: 'view_1', manifestDigest: 'a'.repeat(64), composedCommitOid: 'b'.repeat(40), treeOid: 'c'.repeat(40),
    contractVersion: 1, policyVersion: 1, obligationIds: ['pagination-order'], summary: 'Pagination order matches the stated obligation.', verdict: 'passed' as const, findings: [],
  },
  finding: {
    viewId: 'view_1', manifestDigest: 'a'.repeat(64), composedCommitOid: 'b'.repeat(40), treeOid: 'c'.repeat(40),
    contractVersion: 1, policyVersion: 1, obligationIds: ['pagination-order'], affectedChangeIds: ['change_1'], paths: ['src/list.ts'],
    expected: 'The next cursor advances without repeating items.', observed: 'The second page repeats the final item from page one.', nextOwner: 'contributor_1',
  },
};

export function validateAgentGuideExamples() {
  return {
    proposal: contractInput.safeParse(agentGuideExamples.proposal.payload),
    review: reviewInput.safeParse(agentGuideExamples.review),
    finding: findingInput.safeParse(agentGuideExamples.finding),
  };
}
