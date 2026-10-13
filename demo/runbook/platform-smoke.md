# Bounded native platform qualification

This is a one-shot operator probe against the existing authorized Swarmflare Worker, not a perpetual monitor or a human-review script. Preserve the original Project/resources and all existing secret values. Ingress must be renewed only for a concrete attended action and within current supervisor authority; the probe never renews it.

## Execution

Use the supported WSL Node/Chromium runtime and `BWRAP_PATH=/usr/bin/bwrap`. The native probe has a fixed authorized origin, creates only synthetic accounts, saves its generated identity/session/grant in owner-only local state and emits a separate credential-free report. Never read or stage that private state, use a real human credential, or copy cloud OAuth tokens into GitHub.

From the repository root, run the bounded phases serially:

```sh
node --import tsx demo/cloud/platform-smoke.ts auth
node --import tsx demo/cloud/platform-smoke.ts create
node --import tsx demo/cloud/platform-smoke.ts import
node --import tsx demo/cloud/platform-smoke.ts grants
node --import tsx demo/cloud/platform-smoke.ts logout
```

The probe resumes its existing synthetic identity and repository records; it does not recreate them each time. A failed pre-provision public import may use the narrow owner/CSRF-protected retry endpoint. An existing importing record with no commit/tree may explicitly select the supported `refs/heads/master` branch via refresh. A ready/pinned source is never rebound. This was needed because native provider metadata initially reported `main` for a `master` import. New imports request `master` explicitly at the native binding.

Import is only the fixed tiny public `https://github.com/octocat/Hello-World`; no private provider credential, SSH/local URL, arbitrary host, LFS, submodule or execution of imported source. Metadata availability fallback is bounded anonymous refs discovery for this source only, not a bypass of an explicit public/size denial.

After a successful native import, public screenshot qualification is available:

```sh
node --import tsx demo/cloud/public-capture.ts
```

This reads only the sanitized receipt, uses a fresh isolated browser without login, verifies catalog-to-repository navigation and the actual imported README, and saves public landing/catalog/Code/empty-candidate screenshots. It closes the browser and does not claim a human interaction or a candidate acceptance.

## Verified provenance and limits

The continuous41 source milestone passed typecheck, 344 unit/local tests and 107 Worker tests. Development GitHub Actions deployment actually succeeded. Native synthetic-account signup/login/logout, README repository creation/source readback, scoped agent work claim/revocation, outsider and cross-repository refusal were exercised separately from local synthetic-provider tests.

The same recovered import record and project retained their identity. Actual Artifacts master commit was `7fd1a60b01f91b314f59955a4e4d4e80d8edf11d`, tree `b4eecafa9be2f2006ce1b709d6857b07069b4608`. The commit matched independently fetched anonymous GitHub master refs. Actual deployed Code/README displayed `Hello World!`, and the new repository correctly showed no candidates. Detailed safe receipts/screenshots are local reports; they are not included in the public source archive or treated as current freshness authorization.

A transient HTTP410 immediately after bounded expiry renewal was followed by a successful exact landing readback and same-account probe retry; it is recorded rather than erased. Pending/import refreshes are bounded and do not invent source readiness. General control-plane API-token listing was refused by the existing OAuth credential, so no native active-token-list proof is claimed. Temporary repository-token cleanup has focused local fault tests and actual native reads, not a comprehensive control-plane audit.

Account-owned task approval/baseline initialization, per-repository source/runner policy and the complete candidate feedback/human-review journey remain unfinished. Human approval/final acceptance, public repository publication and competition submission remain reserved. Successful source import or deployment is not COMPLETE.
