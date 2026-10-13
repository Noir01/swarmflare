# Human handoff: reviewing the local demo

## What this is

The collaboration platform is the workspace that lets API, UI, adversarial-test and reviewer roles share a task, claims, revisions, exact candidate Views, evidence and repair feedback. The sample application is separate: a small project-list API and browser UI, not the collaboration platform itself.

The original demo task is to add cursor pagination to that project list, preserve the legacy response for existing clients, and never expose another tenant's projects. The demonstrated cross-component defect was in the sample UI: switching tenants could append the new tenant's rows to old rows or retain the old tenant's cursor. Finding `bb8508f6-432a-48e3-88b7-47b9ed87300d` records the former failure on former View `74c7f3a4-5700-40b7-8978-2c6fa38e8fa8`; its historical resolution links the UI repair and later candidate evidence. It is resolved historical context, not an open finding on the candidate below.

The dashboard is the human review entry point (`/dashboard` on an active local service). It is intended to show the task, recent candidates, requirement-linked evidence, source diff, supported demo preview and request-changes path. Reviewing is not approval. If a human independently chooses to confirm and then accept an exact, currently applicable View, the local service advances its project baseline to that View's commit/tree and records acceptance. It does not deploy to Cloudflare or update a remote Git branch. No confirmation, acceptance or baseline change was performed for this handoff.

## Candidate identity and preserved historical evidence

Exact candidate View: `d33bde01-a380-4b41-9d06-c8ee729f9fe2` in project `continuous11-live`.

The following are preserved historical readbacks, not claims that evidence remains current or that the stopped service can still serve it:

- Candidate version 2 was recorded `runnable`; its base was version 1 at commit `b1889f816db0a875788d236170599d811314b8b0`. Its four ordered revisions composed to commit `b51e8a75fd7c10bc6ad8ef216e5beb6fdf6bd59b`, tree `d7f72b4693bb618ed1eee1c3104830d901906a68`, ref `refs/agent/views/d33bde01-a380-4b41-9d06-c8ee729f9fe2`.
- Historical readiness was `ready:true` at sequence 111, and later readback at sequence 113; it reported no blockers and complete coverage for six obligations. The recorded manifest digest was `e51c4b8362affec1e54bcb783d8755a16cf09694bb42d17e2c3c4e74403d52c9`, contract/policy version 1, suite digest `33be95ed272023f57cd099b8cc01f159579379d3bf38c42144de25f302b0a9a5`.
- Historical mandatory checks passed for that tuple: `mandatory-demo-api` (`28ed2f5e-a7dd-429b-b672-7628840b4e04`) and `mandatory-demo-ui` (`99b5e340-af54-4ec1-8988-0c32e8a2fbbc`), exit code 0. The recorded UI result showed page two containing only `a-project-03` with Next disabled, and tenant switching showed only the selected tenant. API evidence recorded legacy-array compatibility, ordered cursor traversal, invalid inputs/cursors and tenant separation.
- Independent reviewer record `3cfbc2dd-72bb-4b45-ba6d-9f4b6af11498` was recorded `passed` against the same tuple. Source-verification record `007995b4-e65e-4f6c-8d8e-dc332df324e3` was historically read back by the coordinator and matched the candidate receipt. These are dated observations, not fresh authorization.
- Baseline at those reads was version 1, commit `b1889f816db0a875788d236170599d811314b8b0`, tree `527a65fd83d4a1baf40123741942f72a577025b6`, seed ref `refs/agent/seeds/f2206c57-8616-432d-99dc-d96c849d9f60`.
- The historical contributor refusal probe is recorded in `.local/live-cont11/refusal-c13.json`: confirm and accept returned HTTP 403, readiness was false, and the baseline was unchanged. That was an authorization probe, not a human refusal or decision. The finding ID above is not a refusal-probe ID.

These records and their exact commands are preserved in `reports/workers/continuous14-handoff-result.md`. The continuous14 history does not authorize acceptance now.

## Current availability and safe review setup

The bounded local service has stopped; persisted workspace data may remain, but the old loopback URL is not live. A new bounded session requires an operator to arrange startup. The startup-created transient human setup token was discarded; do not recover, reconstruct or mint it. An authorized human/operator must independently provision their real human credential through the approved credential provider and deliver it securely to their own shell. The agent must not request, receive, inspect, store or use that credential. If the authorized setup cannot be completed independently, stop and arrange a newly approved human-authenticated session.

Once an operator has independently arranged the authorized session, open `/dashboard`, sign in as a genuine human for `continuous11-live`, and select the candidate from discovery (or use the exact View ID above). The dashboard login requires the human role and project-scoped configured credential; it cannot create or elevate credentials. Read the exact View, current baseline, readiness, applicable checks/reviews, source verification and findings afresh immediately before any human decision. Treat unavailable or stale evidence as a stop, not implied approval.

A trusted local operator may run the one-shot `review-artifact` command documented in `demo/runbook/runner.md` with a dedicated runner identity, local Git remote/workspace paths and the exact View ID. This regenerates and reads back the source-pinned local diff and optional supported preview; it is not sign-off. The preview expires after 120 seconds. The operator may run the same command again for that same View to regenerate an expired artifact; this creates a fresh expiry window and does not extend the old one. The service enforces expiry. Refreshing or inspecting the dashboard does not regenerate the artifact. Runner output is bounded metadata, not the HTML/diff body.

The dashboard actor bridge is read-only for this handoff; its human-only command set refuses `confirm-view` and `accept-view` (`demo/live/actor.ts:8-10,55-60`). Only an authorized human may decide whether to use the dashboard's separate confirmation and acceptance controls. If the human elects to accept, inspect the exact tuple and fresh evidence, then verify the recorded acceptance and exact baseline readback. Neither step has been performed here.

## Scope limits

This evidence is local Miniflare/local-Git evidence. It does not qualify Cloudflare Workers/Artifacts, remote source readback, entitlement/headroom/ingress or production safety. The recorded baseline was seeded locally; no competent comparison against an independently established Git baseline is claimed. A local acceptance, if later performed, is not remote deployment, production qualification or independent validation of those missing gates.

Useful implementation references: `PRODUCT.md:145-161,190-198`; `HUMAN-REVIEW.md:11-21`; `DECISIONS.md:3-5,16-19`; `apps/dashboard/index.ts:6-9,23-33,39-42`; `apps/worker/src/http/dashboard.ts:32-39`; `demo/live/session.ts:31-63`; `demo/runbook/local.md:3-7`; `demo/runbook/runner.md:3-15`.
