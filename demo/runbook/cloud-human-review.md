# Human review guide — continuous33 cloud candidate

## What the evidence says

The platform coordinates task/revision history, combined Views, source identity, checks, findings, reviews and readiness. The sample app (`demo/seed/`) is a separate project-list API/UI for pagination, legacy-response compatibility and tenant isolation. Its original source was a prepared fixture, not fresh parallel contributor work. An independent reviewer found a stale-response race; an actual owner authored the repair. The replacement was composed, checked and independently reviewed.

Replacement: View `b12ac27e-3b03-4ea7-b1ce-112d0fea9391`, version 2; commit `8ab839695bee1e4d8c539fc34e5e5774a2c17ff1`, tree `0ffc3982848cb01c12102032658f5e175390dfa2`. Mandatory API/UI checks passed, a focused isolated-browser tenant-switch probe passed, independent review `7d2c26e7-d957-474a-9487-4ca98896cab8` passed six obligations, and the original finding was resolved on this replacement. Historical readback says ready with no blockers.

The original failed candidate remains preserved: View `cf8b6eee-6816-4e1b-917c-1bcd01fb8307`, commit `332b8613d3c534d08b4203eb095b4735f9d1e87d`, tree `41299ff4dbc4c998dfb4001a070e86d3f3218f77`. The baseline remains version 1, commit `7b44c2658101243b20625f89410932a67a60d6e2`, tree `527a65fd83d4a1baf40123741942f72a577025b6`; it was not accepted or advanced. One race ordering was runtime-probed; pagination overlap/reset and delayed body/error permutations were source-reviewed, not separately runtime-probed. This is bounded demo evidence, not broad production assurance. Readiness is not human acceptance.

Receipts are historical, not proof the cloud endpoint is live. The actual human login/review has not been verified. The authorized operator must securely deliver the current URL, project/access information, credential and expiry directly to you. No credential contents, private credential paths or endpoint secrets belong in this guide, reports, screenshots or recordings. Access is bounded and may have expired; if unavailable, request a bounded operator renewal on existing resources. Do not retry stale credentials or infer current availability.

## Optional review steps

1. Sign in using access details delivered to you directly by the authorized operator. Discover the task and candidates in the dashboard; select the replacement and confirm its friendly status and exact View/source tuple above.
2. Read the task outcome and constraints, then inspect requirement-linked API/UI checks and independent-review evidence. Historical `ready` describes platform evidence, not your decision.
3. Inspect the source diff against the unchanged baseline. Confirm it belongs to the replacement View, not the preserved original failure.
4. Use “Try result” only if the supported project-list preview is currently available and unexpired. It is a bounded supported-demo preview, not a general application host or deployment.
5. If you want changes, optionally submit “Request changes” against the relevant requirement with expected and observed behavior. Confirm the persisted finding/pending owner if available. This requests work; it neither accepts the candidate nor weakens requirements. Leaving feedback or taking no action is also fine.
6. Decide for yourself whether to stop or request changes. No acceptance is requested or presumed here; any separate acceptance flow remains human-only.

## Freshness and stale evidence

`packages/local-runner/review-artifact.ts` verifies exact baseline and candidate source receipts before building the artifact and reads them again before recording it. The supported preview expiry is refreshed to 120 seconds from artifact creation. Initial `checks` is a one-time mandatory-suite execution and records immutable check resources. For a repeat human-review window, use the explicit `refresh` phase: it issues a fresh source verification, builds/readbacks an exact-source review artifact, reads existing checks/policy/readiness, and never executes or records the mandatory suite. Its check list is labeled historical; missing or inapplicable checks remain missing. It returns actual readiness and blockers, never acceptance. Example: `CLOUD_REPAIR_CONFIG_FILE=<owner-only-config-file> /home/noir/.local/state/nix/profile/bin/node --import tsx demo/cloud/repair.ts refresh`. Use `checks` only for the initial mandatory execution, not refreshes.

If diff/preview is missing, stale, expired or mismatched, do not decide from it. Ask the trusted authorized operator for a bounded refresh tied to this exact immutable View, then rediscover the candidate and verify the View/source tuple and freshness. Do not reuse original-View evidence or start unbounded refresh work.

Grounding: `reports/evaluation/continuous33-coordinator-verification.md` and `reports/evaluation/continuous33-{compose,checks,composed-race,remote-composed-commit,final-finding,final-reviews,final-readiness,final-baseline}.json`. Gittifacts reuse is MIT-pinned to `5f06eb4a5e425fdc4796774e3bd4284a0056288b`; preserve the upstream notice and local adaptation provenance. Public publication/submission requires separate authorization.
