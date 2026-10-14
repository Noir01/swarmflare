# Native candidate qualification

Operator-only fixed C29 synthetic fixture; not a public import executor or human acceptance script. Existing generated synthetic identity and exact README repository are validated before account operations. Secrets are read only in-program from owner-only local files; never print them or pass real human credentials.

Run from repository root with the supported Node/Chromium/bubblewrap environment:

    node --import tsx demo/cloud/candidate-smoke.ts prepare
    node --import tsx demo/cloud/candidate-smoke.ts revision
    node --import tsx demo/cloud/candidate-smoke.ts view
    node --import tsx demo/cloud/candidate-smoke.ts checks

Phases persist request IDs before resource writes. Source materialization uses actual Artifacts Git objects and an exactly scoped 60-second read token, revoked in cleanup. Immutable seed/View refs have one UUID; revision refs contain exact Change UUID and Revision UUID. Invalid ref identifiers are refused, not normalized. No credentials belong in repository URLs, Git source, reports or screenshots.

Contribution uses an expiring repository contributor grant; execution uses a separate operator-issued 120-second, operation-capped runner session. Approval, source publication/composition, mandatory checks, review and final acceptance are separate authorities. Passing suites do not imply task intent or readiness.

Actual independent Luna review of the published prepared first-party candidate found a late tenant-switch response race and missing Previous navigation despite passing suites. `candidate-feedback.ts` records the exact failed review and anchored findings with a separate repository reviewer grant. `candidate-repair.ts` publishes a complete baseline-parented UI replacement without modifying the original View or baseline. Independent actual re-review found unsigned cursor offset tampering; that failed evidence remains blocking.

`cursor-repair.ts` builds the next local repair using per-handler random HMAC-SHA256 keys, exact cursor payload/schema/signature verification and preserved UI bytes. Cursors intentionally cease to work after handler/process restart; this demo is not a durable multi-worker cursor service. Self-contained tests reproduce the old in-range tamper and verify rejection, valid complete pagination and restart refusal. They do not require private native caches.

Once the owner-only renewal endpoint is deployed, `candidate-renew.ts` can explicitly renew the existing synthetic contributor and reviewer grants for 900 seconds. It rotates tokens, retains actor/repository/role, reads back scope and old-token denial, verifies unchanged source and logs out. It does not revive revoked grants, create a human session or grant runner authority. No perpetual renewal process exists.

Current evidence distinguishes actual native source/check/UI repair and actual independent failed reviews from local cursor repair, scripted local review tests and reserved human confirmation/acceptance. No final human decision is performed by these helpers. Native passing re-review/resolution remains a separate executable gate; a missing or failed verdict must never be replaced with a scripted passing verdict.
