# Priority: usable human review before acceptance

User feedback: signed into dashboard but could not understand result; agreed that readable task summary, code diff, runnable candidate preview, requirement-linked evidence and request-changes loop sound appropriate. Treat this as approval to implement the missing review experience, NOT approval to accept any candidate.

The continuous14 human-acceptance gate remains a RESERVED ACTION, but must not globally block implementation of this missing UX. Preserve its record in reports/continuous14-human-gate.md. No agent may confirm/accept the ready demo on Noir's behalf, use the private human token from the temporary review session, or weaken admission rules.

## Astra/Luna work now

Read PRODUCT.md and current code. Write a short engineering addendum to ENGINEERING.md (no new brainstorm) and delegate bounded disjoint Luna tasks: candidate discovery/readable summary and evidence UI; exact-source readable diff endpoint; secure bounded demo preview; request-changes feedback/routing integration. Coordinator owns shared contracts and independently tests integrated behavior. No mandatory dependency on remote Cloudflare provisioning. The previous console is a diagnostic view, not a sufficient human review surface.

## Acceptance criteria for this tranche

- Human lands on task outcome, latest candidates and actionable status without typing an opaque View UUID. Preserve exact candidate pinning behind friendly labels.
- Explain what changed and which requirements have applicable passing/failing/missing evidence. Distinguish historical finding/repair from currently open blockers; include evidence links. Avoid invented agent-generated summaries; derive facts from verified platform records/source.
- Readable file diff against accepted baseline with path/size bounds, source tuple verification, escaped untrusted text and no executing candidate code in the privileged dashboard.
- 'Try result' for THIS supported web demo gives exact candidate preview with isolated execution, no Cloudflare/operator/human credentials, bounded lifetime and strict source pinning. Do not claim arbitrary project previews. Do not introduce unsafe iframe/same-origin access to dashboard tokens/cookies, host mounts or unsandboxed fallback. A supported tunnel/separate-origin preview or generated sandboxed artifact may be used if independently exercised and documented. No remote ingress or paid resources needed. Pause if real isolation cannot be achieved.
- Request-changes message persists on exact candidate/task, shows pending status/owner, and can be retrieved by appropriate agents. Test agent retrieval and linked response revision without human relay. Request changes is not silently an acceptance or requirement weakening.
- Browser tests exercise discovery, summary, diff, evidence, preview where supported, and request changes; preserve existing backend/refusal regression tests. All child/browser work stays inside service cgroup.
- Report verified artifacts and provide one understandable review entry point for Noir. Pause for the actual human decision ONLY AFTER the review surface is useful; no COMPLETE claim before all remaining product/remote gates.

Existing candidate View d33bde01-a380-4b41-9d06-c8ee729f9fe2 and live-cont11 history must be preserved. Temporary review server/token may be expired; do not assume old localhost URL is live. Do not expose human token paths/contents to workers. No further input is needed for routine implementation. Cloud spending/account restrictions and manually controlled continuous execution remain unchanged.
