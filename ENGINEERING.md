# Engineering plan: shared agent task workspace

Status: planning deliverable, not an implementation or integration-success claim. Astra advisor; 2026-10-07. PRODUCT.md, EXECUTION.md and CLOUDFLARE-LIMITS.md were read in full and remain unchanged. No implementation agents launched in this cycle.

Implementation checkpoint (cycle 3, 2026-10-07): the text below preserves the original plan. Local bearer-authenticated client/Worker/SQLite coordination, immutable contract approval/CAS, event pagination, local eviction persistence and bounded local Git publication tests now execute. Coordinator independently ran typecheck, 32 unit tests and 15 Worker tests successfully, then added and separately passed one end-to-end contract/authorization integration test. Stage 1 source-publication/View-job integration is still missing; Stages 2-4 and remote deployment gates remain open. STATUS.md and NEXT.md carry exact execution receipts, worker sessions and limitations. No product-complete or remote-success claim.

Current checkpoint (continuous3, 2026-10-08): integrated local authenticated HTTP/SQLite/Git publication and exact Views now run through a real sandboxed JSON check failure, persisted evidence, reviewer finding, owner repair publication and passing replacement check. Old experiments and historical evidence survive. Coordinator independently ran full typecheck +82 unit +30 Worker tests, then corrected/tested acceptance-route and descendant-cleanup assertions and separately passed seven HTTP feedback/evidence security tests. Full suite after the final test-only additions is not yet rerun. This is a scripted local fixture, not the mandatory pagination/real-agent/remote demo. Stage2 acceptance and finding resolution remain fail-closed pending server-owned mandatory suite policy and transactional acceptance. No remote qualification or completion claim. STATUS.md/NEXT.md contain exact sessions, tests, limits and an operator note about unauthorized worker checkpoint metadata added to .execution/NEXT-WINDOW.json; execution scripts and actual deadline are unchanged. Historical cooldown prose below is superseded by EXECUTION.md/DECISIONS.md continuous override.

## 1. Build this slice

Build one private, single-project collaboration workspace. A human defines the pagination task; three contributors develop API, UI and adversarial tests concurrently; an independent reviewer inspects a combined candidate; a repair travels through shared context; a human accepts the exact re-evaluated result. Preserve older experiments throughout.

The platform is not an orchestrator, hosted development environment, deployment service or new VCS. Ordinary Git supplies commits, branches, worktrees and merges. Runtime launch and budgets remain outside the product, inside the execution cgroup. The initial human interface is a small task/decision page, not a graph or transcript viewer.

## 2. Selected stack and verified capability boundary

Select TypeScript throughout, npm with a committed lockfile, native Workers fetch routing, runtime JSON validation (Zod), and ordinary Git CLI in a local Node runner. No web framework is necessary: one static HTML/CSS/TypeScript dashboard and one small CLI consume the same HTTP API. Use Vitest with Cloudflare's Workers test pool for the Worker/DO, Node integration tests for Git, and Playwright for the human page and demo UI.

Deploy one project-only Worker with static assets, one SQLite-backed Durable Object instance for project metadata/serialization, and one Artifacts repository in one new project-only namespace. The DO is the only additional data service. No D1, KV, R2, Queues, Containers, Sandbox, Workers Builds, external Git host, websocket service, scheduled trigger or remote model execution. Local compilation/tests and all agents remain in this process cgroup. Candidate execution is local; real remote Worker coordination and Artifacts source storage are still mandatory for the final demo.

Why one DO: acceptance, findings, contract changes and baseline state need one transactional authority. Avoid a database plus separate lock service, and avoid claiming Git offers a transaction across metadata and source. The Git runner never runs inside a Worker.

Verified from official documentation in this cycle:

- Artifacts is Git-compatible storage. Git clone/fetch/push use its returned HTTPS remote and repository-scoped read/write tokens. Cloudflare account API tokens are not Git credentials.
- The live Workers binding supports create, get, list, and disposable repo capabilities. `using repo = await env.ARTIFACTS.get(name)` obtains a handle, not metadata; `repo.info()` reads metadata. `repo.createToken("read" | "write", ttl)` returns `plaintext` and `expiresAt`. Explicit scope/TTL are required by our adapter because the documented default scope is write.
- Repo capabilities expose `readCommit(hash)`, `readTree(hash)`, `readBlob(hash)`, `readFile({ref,path})` and `log`. Pin object IDs, not HEAD, for source inspection. Missing objects/files return null as documented.
- Current binding documentation requires Wrangler 4.145.0 or later for generated Artifacts types and Blob-returning methods with remote local-dev bindings. Installed Wrangler is 4.129.0: do not build against that globally installed version. Stage 0 must select and pin a project-local compatible published version and generate types. Node v22.19.0 and npm 10.9.3 are installed; check selected package engine constraints before installing.
- Artifacts limits: 1 GB/repository, 32 MB/blob, 2,000 control-plane requests/10 seconds/namespace, and 2,000 Git requests/10 seconds/artifact. These are service ceilings, not our budgets.
- Artifacts requires Workers Paid. Operations/storage billing begins October 14, 2026; included account-wide allowances are 10,000 operations/month and 1 GB-month. Repositories persist until explicitly deleted.
- Workers Paid includes 10 million requests/month and 30 million CPU ms/month. This is not a free subscription or permission to upgrade.
- SQLite-backed DOs offer transactional, strongly consistent per-object storage. Paid inclusions: 1 million DO requests/month, 400,000 GB-s duration/month, 25 billion SQL rows read/month, 50 million rows written/month and 5 GB-month SQL storage. DO SQLite limit is 10 GB/object; row/string/blob limit is 2 MB. DO duration and storage need their own headroom verification, not just Workers usage.

Sources, retrieved 2026-10-07:

1. https://developers.cloudflare.com/artifacts/api/workers-binding/index.md
2. https://developers.cloudflare.com/artifacts/api/git-protocol/
3. https://developers.cloudflare.com/artifacts/guides/authentication/
4. https://developers.cloudflare.com/artifacts/platform/limits/
5. https://developers.cloudflare.com/artifacts/platform/pricing/
6. https://developers.cloudflare.com/workers/platform/pricing/
7. https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
8. https://developers.cloudflare.com/durable-objects/platform/pricing/index.md
9. https://developers.cloudflare.com/durable-objects/platform/limits/index.md

The search extractor returned an older Artifacts binding description and an aggregate page mentioning closed beta. Direct retrieval of the live binding page exposed the newer API and minimum Wrangler version above. Treat generated types and an authorized remote probe as implementation gates; neither marketing pages nor an emulator prove account entitlement or working remote behavior. No branch protection, merge API, server-side Git execution, cross-service transaction or local Artifacts emulator fidelity is assumed.

## 3. Accounts, cost gate and execution boundary

Target Purdue account only: cb50a73b7487ae7039cbc8b613986b8b. Authentication for both accounts is now reported working; do not repeat the obsolete unauthenticated conclusion in CLOUDFLARE-LIMITS.md. Authentication is not verified Paid entitlement, Artifacts access or usage headroom. Do not touch Gmail resources, existing Workers, domains, DNS, deployments or secrets. Project-only secret bindings may be created only after the deployment gate; never alter existing secret bindings.

Before ANY new remote resource, remote binding dev session, migration or deploy:

1. Read back the exact target account and existing subscription/entitlements without printing credentials. Verify Workers Paid and Artifacts availability; no paid activation or upgrade.
2. Inspect account-wide usage in the current billing period for Workers requests/CPU, Artifacts operations/storage including daily peaks, and DO requests/duration/SQL reads/writes/storage. Record source, period, retrieval time, reporting lag and redacted totals in reports/cloud-preflight.md. Unknown dimensions fail closed.
3. Reserve conservative project ceilings below verified remaining inclusions, accounting for existing workload growth, reporting delay, repeated cycles and retained storage. Proposed initial ceiling for the entire first demo campaign: 2,000 Worker requests, 200,000 Worker CPU ms, 2,000 DO requests, 1,000 DO GB-s, 100,000 SQL row reads, 20,000 row writes, 10 MB SQL data, 200 Artifacts operations and 20 MB total Git storage. These are proposed application stop limits, not provider guarantees or extra allowance. Reduce them if account headroom requires it; never automatically increase them.
4. Bound all runners and clients, pagination and payloads. Poll shared context no faster than every five seconds during the active window, with ETags/backoff and a hard request counter; stop on cap, expired window, unknown accounting or failed preflight. Reserve budget before issuing an operation; count retries and failed attempts conservatively. No continuous polling outside a window.
5. Resolve public ingress accounting before deployment. Authentication/DO counters do not cap billable rejected Worker requests, and an application counter is not a Cloudflare billing limit. Default remote access should be a private service-binding invocation if the currently available tooling supports it without extra paid resources; verify that path. If the only feasible path is workers.dev, record that unguessable URLs and authentication do not guarantee zero overage, and obtain an acceptable bounded-ingress/headroom decision rather than silently publishing it. No custom domains or account-wide access-policy changes.
6. Record exact new resource IDs and cleanup ownership. Disable auto-provisioning outside this approved manifest. No automatic Builds or preview deployments on Artifacts pushes.

Local-only development is useful and must stay clearly labelled. It does not satisfy the Workers/Artifacts remote milestone. If the gate cannot be met, stop remote work and report the blocker, not a successful mock integration.

All future model work uses openai-codex/gpt-6-astra for coordination and explicitly selected openai-codex/gpt-6-luna for implementation. Existing probe file says LUNA_ROUTE_OK and execution state records luna_verified=true; no probe or worker was launched here. Every child/test/server stays in git-collaboration-cycle.service. No detach, cron, external scheduler or remote autonomous job. Read the persisted deadline each cycle; allow time for tests, reports and child termination before cutoff. A killed run is interrupted, never passed. Honor five-hour cooldown even after early completion. Guard files are not implementation targets.

## 4. Modules and ownership seams

Coordinator owns root tooling, lockfile, schema versions, generated types, shared contracts, integration and independent verification. Workers submit changes only in assigned directories; contract changes are proposals until the coordinator lands them.

- `packages/contracts/`: Zod request/response schemas, branded IDs, DTOs, error codes, JSON fixtures and API version. No database or Cloudflare calls.
- `packages/domain/`: permission checks, readiness evaluation, state-transition rules, applicability keys and dependency validation. Pure functions; used by the DO, never reimplemented in UI.
- `apps/worker/src/http/`: authenticated routes, project membership, strict request validation, body limits, same-origin human sessions and sanitized errors.
- `apps/worker/src/project/`: one Project DO, SQL migrations, transactions, event sequence, idempotency ledger and bounded jobs. No shell or model calls.
- `apps/worker/src/artifacts/`: actual Workers binding adapter; commit/tree verification, read-only source browsing, restricted runner token issuance. No generic unauthenticated repo/token endpoint.
- `packages/git-runner/`: local isolated working copies, publication, composition, check execution, redacted logs and credential isolation. Polls/claims bounded jobs; shuts down with the cgroup. Credentials belong to its supervisor, not to candidate code.
- `packages/client/` and `apps/cli/`: typed HTTP client and JSON commands for agents, including context, claim, decision, publish, view, finding, readiness and accept. CLI acceptance requires the separate human identity, unavailable to agents.
- `apps/dashboard/`: task progress/next owner, decisions, candidate manifest, requirement/evidence matrix, source/log links and explicit acceptance confirmation. Serve as Worker static assets; polling only.
- `demo/seed/`: tiny existing project-list service/UI and synthetic tenants; no real customer data. This is the code being changed, separate from collaboration-platform code.
- `tests/`: cross-module contract, security, integration and demo assertions. `reports/`: sanitized execution receipts and worker handoffs, not credentials or unbounded transcripts.

## 5. Shared data contracts (v1)

All IDs are opaque strings generated server-side; all actors derive from authenticated identity, never caller-supplied author fields. Times are UTC ISO strings for display; monotonic project sequence numbers order events. Validate full lowercase 40-character SHA-1 object IDs for this Artifacts Git mode; do not silently normalize malformed IDs. Keep Git object IDs distinct from SHA-256 manifest/check digests.

Common mutation envelope: `{requestId, expectedVersion?, payload}`. Scope idempotency by project + actor + operation + requestId; same key with different payload is a conflict. Responses contain `apiVersion: 1`, canonical resource, project sequence and resource version. Errors: `{code,message,details,requestId}` with 401/403, 404, 409 stale/conflicting, 422 invalid dependencies/transition, 429 budget and 503 remote unavailable. Never return partial successful Views or secrets in errors.

Core records:

- Project: id, members/roles, repo locator, baseline `{version, commitOid, acceptedViewId}`, current contractVersion and policyVersion. Initial baseline is human-approved seed commit.
- TaskContract: immutable version, outcome, constraints, stable obligation IDs with acceptance examples, required check IDs, review policy, unresolved material questions, human approval and timestamp. Changes create a new version; old versions remain readable.
- WorkClaim: owner, obligation IDs, explicit path/interface areas, status (`working|waiting|blocked|ready|done`), dependency links, overlap acknowledgements. Claims are non-exclusive. Explicit shared areas flag overlap; do not pretend to infer prose equivalence. Known overlap requires both owners to acknowledge coordination, split or intentional alternatives before affected readiness.
- Decision: question/proposal, affected obligations/interfaces/participants, responses, revision and `open|agreed|superseded|needs-human`. Required participant acknowledgements are stored; silence is never agreement. Constraint changes require a new human-approved contract, not merely an agent decision.
- Change: stable id and owner; immutable revisions `{revisionId, baseCommitOid, commitOid, treeOid, obligationIds, decisionRevisions, dependencies:[{changeId,revisionId}], status}`. Ownership is platform identity; Git author text is not authorization.
- View: immutable requested manifest `{baseVersion,baseCommitOid,contractVersion,policyVersion,orderedRevisions,excludedChangeIds,decisionRevisions,compositionVersion}` plus manifest SHA-256, composition state, exact composed commit/tree and source verification receipt. Changing any selection creates a new View. Excluded list is a snapshot at creation; new later work remains separately visible.
- Finding: id, reporter, blocking/advisory, requirement IDs, candidate/revision scope, affected changes, reproducer/evidence links, next owner and append-only transitions. States `open|repair-proposed|resolved`; resolution records authorized reviewer, reason, evaluated replacement View and evidence. No deleting or severity downgrade by repair author.
- Evidence: kind `agent-claim|recorded-check|review`; provenance actor/runner, exact applicability key, command/check definition digest, trusted harness version, start/end/exit status, result, sanitized logs digest/location and obligation coverage. Claims are never represented as executed checks. Interrupted, missing or truncated-required output is not pass.
- Review: reviewer identity, applicability key, inspected source/check references, obligation coverage, approval/rejection and known risks. Approval is not acceptance.
- Acceptance: human actor, selected View, applicability key, expected baseline version and readiness sequence, server decision reasons, old/new baseline and commit timestamp. Successful acceptance is append-only and idempotent.
- Event: project sequence, resource/version, authenticated actor, action and redacted summary. Store a small audit trail in the same transaction as each state change, not a second event-sourcing architecture.

Applicability key is `{projectId,viewId,manifestDigest,composedCommitOid,treeOid,contractVersion,policyVersion,checkSuiteDigest}`. Store this on every candidate check/review; do not infer applicability from branch name, latest revision or a green badge. A View may be runnable under an older contract but is not eligible for current acceptance.

## 6. HTTP/CLI surface

All routes are under `/api/v1/projects/:projectId`; enforce membership before resource lookup. GET context returns current contract, baseline, claims, relevant decisions/findings, newer dependency revisions and next actions in bounded pages. GET events uses an opaque sequence cursor and ETag; ordinary polling is enough.

- `GET /context`, `/events`, `/contracts/:version`, `/changes/:id`, `/views/:id`, `/findings`, `/baseline`.
- `POST /contracts/proposals`; `POST /contracts/:proposalId/approve` human-only with expected current version.
- `POST /claims`; `PATCH /claims/:id` owner-only; `POST /claims/:id/overlap-ack` records explicit acknowledgement.
- `POST /decisions`; `POST /decisions/:id/responses`; `POST /decisions/:id/agree` checks all required acknowledgements and contract authority.
- `POST /changes`; `POST /changes/:id/revisions` reserves an attributable immutable publication; runner completion plus actual remote readback makes it published.
- `POST /views` validates exact dependency closure/order and queues composition; `GET /views/:id/source?path=...` reads the pinned remote commit, escaped as text. Working-copy export returns a manifest/authorized clone path, never an embedded credential URL.
- `POST /findings`; `POST /findings/:id/repair`; `POST /findings/:id/resolve` authorized independent reviewer only.
- `POST /views/:id/checks` requests the fixed trusted suite; `POST /views/:id/reviews`; `GET /views/:id/readiness` returns per-obligation coverage, missing/stale evidence and machine-readable blocking reasons.
- `POST /acceptances` takes exact View, expected baseline/contract/policy versions and readiness sequence. Never accepts `latest` or a caller-computed ready flag.
- Private runner routes claim a bounded job lease and complete publication/composition/check receipts using attempt IDs. Duplicate completion is idempotent; expired/superseded attempts cannot make a newer job pass. No durable queue service is needed: small jobs table + local polling.

Freeze schemas and golden request/response fixtures before parallel implementation. Client and server validate those same schemas. The coordinator must turn this specification into executable schemas/tests in Stage 0; this planning cycle does not claim those files already exist.

## 7. Git composition and durable baseline

Use one remote repo with append-only application-managed refs for published revisions and Views. Only the trusted publisher holds a write token: Artifacts tokens are repo-scoped, not documented branch-scoped. Contributors get isolated local working copies and platform credentials, not remote write credentials. Read tokens are short-lived and issued only to authorized clients; no token-bearing URLs or command-line arguments in logged commands.

A revision is an ordinary Git commit with a declared base and exact dependencies. Start with a restricted composition rule: each revision is a single-parent delta against its declared base, whose tree is either the baseline or an already materialized dependency View. Validate that declared base and dependency closure match. No arbitrary merge-commit replay. Apply each revision once in stable dependency-topological order using ordinary Git cherry-pick/three-way merge into a new clean worktree, beginning at the selected baseline. Reject cycles, missing/mismatched dependency revisions or unresolved merge conflicts. Do not modify source worktrees or silently resolve conflicts. Report paths, involved revisions and next owner, and discard the partial candidate from readiness. Integration fixes are new attributable revisions, not undocumented local edits.

Record the resulting commit and tree, ordered input manifest and tool version; retries reuse the recorded candidate, not manufacture a new identity. Content equivalence does not reuse approval. Push a unique View ref, then fetch/read back the exact remote commit and tree before marking the View runnable. Pin refs for all published revisions, Views and accepted history so Git reachability preserves old experiments. A mutable Change latest pointer may advance, but its revisions and existing Views never do. Source browsing via the Worker uses the Artifacts binding and commit ID; local execution obtains that exact remote commit, not a convenient unpushed working tree.

The authoritative accepted baseline is the DO's versioned pointer to an already durable Artifacts commit. Accepting does NOT mean updating Git main, deployment or a push. Keep a seed branch and immutable View refs; clients obtain the baseline through the platform and check out its exact commit. This avoids a fictitious atomic transaction between Git refs and metadata. Optional Git branch mirrors are deferred, never a second source of truth.

## 8. Acceptance, permissions and race invariants

Proposed conservative demo policy needing human confirmation (PRODUCT.md section 12): all blocking findings relevant to the task or included work carry forward until explicit independent resolution; advisory findings remain visible but do not block. No waiving tenant-isolation failures or mandatory evidence. An assigned reviewer who is not an author of the affected repair may resolve a blocking finding with fresh evidence; a human may also resolve it under the same evidence rule, with an audit reason. Final acceptance and contract/policy changes are human-only.

Roles are project-scoped: human maintainer, contributor, reviewer and trusted runner. An agent may have contributor/reviewer capabilities but cannot independently approve or resolve its own affected contribution. The runner cannot change requirements, resolve findings, review or accept. Runtime job credentials cannot call human routes. Untrusted code cannot obtain runner, human or Cloudflare credentials. For the demo use explicit pre-provisioned role credentials and a separate human-only login/confirmation path; no OAuth product build is needed. Store only credential hashes/expiry server-side; never ship the human credential to agents. Cookie sessions require HttpOnly/Secure/SameSite and CSRF/origin protection. All source/review text is escaped; logs redact credential patterns and headers.

The acceptance transaction must re-evaluate, not trust cached dashboard readiness:

1. Authenticate authorized human and exact project. Verify unexpired explicit confirmation for the displayed View.
2. Verify expected baseline version/commit, current human-approved contract and policy, View identity, current readiness sequence and immutable publication receipt.
3. Verify exact dependency closure and resolved relevant material decisions; unknown or uncovered obligations block.
4. Verify all required current candidate checks pass, required independent review is present, and evidence keys match exactly. Neither per-change checks nor agent claims substitute for candidate validation.
5. Verify no applicable open blocking finding, including unresolved findings carried from earlier candidates touching the same obligations/work. Dropping an old View or changing a revision must not erase a blocker.
6. In one DO SQLite transaction, advance baseline by compare-and-swap and append the acceptance/event/idempotency record. No external await inside this transaction. If a finding/contract/baseline change wins the race, the accept request is stale and must be presented again.

Remote commit existence/tree are verified before entry into the final transaction; on return recheck all DO versions. Disallow repository/ref deletion through agent routes; cleanup requires a quiescent project and cannot race acceptance. External administrator deletion cannot be prevented by this prototype: detect missing source and fail closed, not silently substitute it. Successful acceptance returns its durable receipt; a separate GET baseline and source readback verifies completion. Timeout after commit is recovered by the same idempotency key, not a second acceptance.

Publication, successful checks, review approval, acceptance and deployment remain separate actions. No accept endpoint deploys anything. Known flaws do not become acceptable because several agents agree.

## 9. Tests and evidence gates

Local test doubles are explicitly labelled and cannot satisfy remote acceptance criteria. Tests are layered:

A. Domain/contract tests: validators, permissions matrix, idempotency, dependency cycles and exact revision matching; stale contract/policy/baseline; changed source; missing check; failed check; author self-review/resolution; unresolved blocker carry-forward; overlap acknowledgement; uncovered obligation. Table-driven readiness reasons must agree with HTTP refusal codes.

B. Worker/DO tests in workerd/Miniflare via Workers test pool: real SQLite migrations and transactions, persisted restart/readback, simultaneous accept/contract/finding races, duplicate requests, attempt lease expiry and pagination. Test all project-scoped routes against another project identity and unauthenticated actors. Do not equate emulated DO persistence with remote verification.

C. Git integration using real Git and temporary repositories/worktrees: concurrent isolated writes, exact revision publishing, dependency-based composition, genuine merge conflict with no partial View, missing object, interrupted push/receipt recovery, preserved old worktree including dirty edits, explicit update adoption and clone/export equality. A local bare repo is only the local adapter, not Artifacts. Disable hooks and unsafe external Git transports; reject path escapes, unsupported submodules/LFS and oversized content in the demo.

D. Trusted check runner: command allowlist and fixed harness pinned outside candidate-controlled scripts; record actual exit status, environment/tool versions, suite digest, stdout/stderr digest and applicability. Run candidate code with a sanitized environment in a local sandbox that stays in the cgroup. Separate supervisor credentials from child process environment/files; deny host-home mounts and unnecessary network. Verify available sandbox support before treating untrusted execution as safe; if unavailable, stop candidate execution for a decision, not merely unset environment variables. Never let candidate package scripts redefine mandatory checks.

E. Local end-to-end: real HTTP clients, real Git composition, check execution and browser assertions. Demo role scripts may test protocol mechanics, but mark scripted runs as tests, not a concurrent-agent demo. Assert accepted baseline equals evaluated commit/tree; assert source, contract and permission failures leave baseline unchanged.

F. Mandatory remote integration after preflight: deploy the exact project Worker/DO and Artifacts binding; record resource IDs/deployment version. Create only the approved repo/namespace, push a unique commit, clone into a fresh clean directory, compare commit/tree/file bytes, inspect same commit via deployed Worker binding, then exercise publication, View creation, evidence, refusal and human acceptance against that endpoint. Read back baseline and exact source after acceptance; test remote persistence and role rejection. Verify revoked read token fails on the exact target. Report emulator, remote smoke and full demo results separately. No secrets in receipts. Cleanup only manifest-listed disposable resources, read back deletion, and do not delete accepted demo evidence without an explicit retention decision.

Recommended future commands, to be created by implementation (not existing or executed now): `npm run typecheck`, `npm run test:unit`, `npm run test:worker`, `npm run test:git`, `npm run test:e2e:local`, `npm run test:integration:remote`, `npm run demo:agents`. Remote commands require an explicit preflight receipt, target account and active-window deadline; never silently fall back to local.

## 10. Small concurrent-agent demonstration

Use a seeded tiny project-list service with synthetic tenant A/B projects, stable `(createdAt,id)` ordering and a minimal browser list. Human approves this bounded contract: legacy no-pagination clients keep the old response shape/behavior; pagination is opt-in, returns `{items,nextCursor}`; cursor is opaque, validated and tenant/query-bound; UI resets its cursor when changing tenant/filter and never mixes previous tenant results. Signed cursor validation does not replace tenant filtering on every database query. Required check groups: legacy compatibility, pagination boundaries/tied timestamps/invalid cursors, tenant/cursor substitution, browser navigation and tenant switch, plus independent combined-source review. These are the recommended product defaults to confirm, not already approved requirements.

Run three real contributor agents concurrently in separate local working copies: API implementer, UI implementer and adversarial-check author. A fourth independent reviewer joins when a View is ready. Use the existing runtime with explicit model selection, bounded tool budgets and no detached work; model launches are future-stage work only. Use platform credentials that cannot accept.

Demonstration sequence and durable proof:

1. Human creates/approves contract and initial split; agents retrieve platform context and publish claims. Capture time intervals showing genuine overlapping execution, not sequential replay.
2. API agent posts its response/cursor assumption. UI agent asks about legacy shape and cursor lifetime; API responds; both explicitly acknowledge a shared decision retrieved through API/CLI. Human performs no message forwarding.
3. Publish real revisions and compose V1. Each contributor's isolated checks may pass. Reviewer runs the combined browser test against seeded tenant switch: deliberately disclose a prepared starting defect where the UI appends new-tenant rows to the old list or retains a cursor across tenants. Do not seed fake logs or hard-code a failing result; the actual browser/service must exhibit the failure.
4. Reviewer opens blocking finding linked to tenant-safety obligation, V1, reproducer and UI repair owner. Attempt human acceptance and retain exact refused response and unchanged baseline; also verify agent acceptance returns forbidden.
5. UI agent polls context, retrieves finding and publishes a repair revision without human relay. Meanwhile the adversarial contributor keeps an old V1 worktree, makes an independent extra malformed-cursor check and demonstrates its files and pinned source remain unchanged. An update notice appears; adoption is explicit.
6. Compose V2, rerun all required candidate-level checks, review the actual source, and resolve the finding through authorized independent evaluation. A stale V1 check/review must not count toward V2 readiness. Retain both Views.
7. Human opens the decision page, sees obligation coverage, findings/resolution, exact manifest, logs and excluded work; confirms V2; server accepts only that tuple. Read back baseline and fetch its Artifacts commit. Acceptance does not deploy the seed service.
8. Separately exercise a contract/baseline race and a textual composition conflict in integration tests. Demonstrate the same guards, without overloading the main narrative.

Save a sanitized machine-readable trace with event IDs, actor identities, manifests/OIDs, run IDs, interval timestamps, refusal reasons and acceptance receipt plus screenshots of decision state. Disclose manual split/launch, prepared defect, credentials setup and test fixtures. Compare a bounded equivalent run using isolated Git copies, integration branch and the same tests; count human relay steps, manual coordination interventions and state-reconstruction effort. Report observations, not a general productivity or scalability claim. A newcomer should identify task, blocker/owner, candidate, evidence and acceptance effect without reading private transcripts.

## 11. Milestones and disjoint Luna assignments

No agents are started by this plan. Each future assignment uses explicitly selected Luna, a fixed directory/test scope, a bounded runtime and `reports/workers/<stage>-<role>.md` containing changed files, commands/results, unresolved issues and exact resume point. Coordinator integrates only after reviewing diffs and executing independent checks. Workers do not edit PRODUCT.md, execution guards, root lockfile, shared contracts or cloud resources. Use 3-6 workers only when the listed independent work exists; do not parallelize prerequisite decisions.

### Stage 0 — coordinator prerequisite gate (serial)

Deliver: approved demo policy or recorded block; precise local/remote authorization; project-local dependency pins; repository/.gitignore; minimal runnable Worker+DO skeleton; generated binding types; executable contracts/domain port interfaces and golden fixtures; verified local sandbox; ownership map. Do not spend a whole cycle polishing scaffolding. Pin a compatible published Wrangler version and stop on an incompatible API rather than casting everything to any. Verify local test/build commands and no accidental remote connection. Remote provisioning remains gated; local scaffolding can proceed after explicit local-only resume if global BLOCKED is present.

Exit: schemas and fixtures compile, empty Worker/DO executes locally, core acceptance invariants have failing tests ready for implementation, reports distinguish not-run cloud tests. No workers are useful before shared seams exist.

### Stage 1 — collaboration and isolated source (four Luna assignments)

1. Metadata worker owns `apps/worker/src/project/` and `tests/project/`: migrations, context/claims/decisions/events, versioned mutations, jobs and idempotency against frozen domain ports. Verify restart and concurrent claim tests.
2. Git worker owns `packages/git-runner/` publication/composition modules and `tests/git/`: isolated copies, dependency validation integration, real Git conflict handling and retained Views. No remote provisioning; use explicit local backend.
3. Client worker owns `packages/client/`, `apps/cli/` and their tests: typed context/coordination/publication/View commands with pagination, backoff and actor separation. No invented server endpoints.
4. Demo fixture worker owns `demo/seed/` and `tests/demo-fixture/`: tiny baseline service/UI, synthetic tenants, passing legacy seed checks and reproducible prepared interaction condition. Do not implement the final pagination solution; leave that task to the demonstrated agents.

Coordinator owns HTTP wiring, pure domain rules and integration. Exit: two independent HTTP clients coordinate a real decision, publish isolated Git revisions and obtain a runnable local combined View with preserved old copies. Scripted clients at this stage are not claimed as real agents.

### Stage 2 — enforceable decision loop (four Luna assignments)

1. Guard worker owns `packages/domain/acceptance/` and `tests/acceptance/`: readiness/permission/finding applicability functions and exhaustive refusal/race specifications. Coordinator owns DO transaction wiring to avoid collision with metadata ownership.
2. Evidence worker owns `packages/git-runner/checks/` and `tests/check-runner/`: trusted-suite execution, sandbox integration, interrupted runs, applicability receipts and redaction. Depends on Stage 1 runner port, not its files.
3. Human interface worker owns `apps/dashboard/` and `tests/dashboard/`: task progress, next owner, immutable source/manifest/evidence inspection and exact-tuple confirmation; keyboard-usable plain UI, no graph work.
4. Integration/security worker owns `tests/e2e-local/`, `tests/security/` and stage-specific reports: independent acceptance negatives, old experiment survival and local full loop through public contracts. Files bugs; does not rewrite production modules owned by other workers.

Exit: actual local code/check/repair/accept loop, all negative guards enforced and persisted; no agent/human credential crossover; fresh evidence required after any input change. Coordinator independently re-runs tests and resolves discrepancies.

### Stage 3 — real Cloudflare qualification (three Luna assignments; provisioning serial)

Start only after account/usage/ingress gate. Coordinator alone owns project resource manifest, deployment configuration, secret handling, actual provisioning and readback. No worker modifies another account or resource.

1. Artifacts adapter worker owns `apps/worker/src/artifacts/` and adapter conformance tests: generated binding signatures, disposable handles, pinned source reads, scoped token port, fail-closed remote errors. Validate against approved test repo, not invented API behavior.
2. Remote integration worker owns `tests/remote/`: genuine push/clone/binding comparison, remote DO persistence, role rejection, exact acceptance readback and gated cleanup assertions. Performs remote writes only through the coordinator-approved harness/manifest/budget.
3. Budget/operations worker owns `ops/preflight/`, `ops/budget/` and `reports/cloud/`: read-only account/usage discovery, sanitized receipts, limits/expiry handling, resource accounting and private-ingress feasibility. No auto-upgrade, auto-provision, timer edits or account-wide configuration changes.

Exit: exact deployed target exercised and read back; no missing budget dimension; local-vs-remote evidence separately labelled. An unresolved entitlement, billing or safe ingress question blocks this stage rather than causing a platform substitution.

### Stage 4 — actual agents and handoff (three implementation assignments, then bounded live demo)

1. Runtime adapter worker owns `demo/launch/` and bounded role prompts: existing-runtime integration with explicit Luna routing, per-agent working copies, platform context retrieval and deadline propagation. No new scheduler or project guard modifications. Runtime/model documentation must be consulted when wiring commands.
2. Scenario verifier owns `tests/demo-verifier/` and trace schema consumers: assert overlap intervals, no human relay, genuine failure/repair, old View survival, stale-evidence refusal and exact accepted OID from real trace records; no fabricated traces.
3. Presentation/evaluation worker owns `demo/runbook/` and `reports/evaluation/` templates: human decision walkthrough, disclosed preparation, equivalent Git baseline protocol, retention/cleanup checklist and newcomer comprehension check. No claim of a result before execution.

Coordinator runs the real three-contributor plus independent-reviewer demo inside a permitted window against remote collaboration targets; human acceptance waits for the authorized human, never simulated as an agent. If the human is unavailable, save ready state and stop; do not leave agents polling through cooldown. Exit only when all PRODUCT.md section 8 steps and final readback are evidenced. If interrupted, retain exact checkpoints and resume in a later allowed window.

## 12. Definition of completion

### Continuous15 priority addendum — usable human review

HUMAN-REVIEW.md and the latest DECISIONS.md authorize this implementation before sign-off. The archived continuous14 human gate reserves acceptance only; it does not block review UX work. Preserve live-cont11 and never read/use its human credential or accept its candidate.

Use the existing dashboard as a task-first review/operate surface: approved outcome, discoverable recent candidates, requirement-linked applicable evidence, source changes, supported-demo preview, and exact-candidate request changes. Keep raw tuples under disclosure and retain separate confirmation/acceptance guards. Facts come from platform records and verified source, not generated prose.

Frozen implementation seams for disjoint Luna ownership:
- Backend: GET /views returns recent bounded View resources newest first; GET /views/:id/review-artifact returns resource or null. POST /runner/views/:id/review-artifacts is runner-only, idempotent, bounded, and validates exact applicability plus current baseline tuple. Artifact payload is {applicability, baseline:{version,commitOid,treeOid}, diff:{patch,files,truncated}, preview:null|{supported:'project-list-demo-v1',html,expiresAt}}. Bound total JSON under existing 64KiB transport; diff.patch <=16000 chars, <=100 safe paths; preview.html <=32000 chars and short expiry. Source mismatch/stale baseline makes artifact unusable. Do not make presentation artifacts acceptance evidence.
- Diff runner: packages/local-runner/review-artifact.ts exports buildReviewArtifact(client,{remote,workspaceRoot,viewId}); it verifies baseline and candidate Git receipts, reads bounded text-only git diff with external diff/textconv disabled, materializes exact candidate only into isolated work root, calls preview builder, uploads artifact and reads it back. demo/live/review-artifact.ts is the runner-only local bridge; no human credential or sign-off. No edits to execution infrastructure.
- Preview: packages/git-runner/checks/demo-preview.ts exports buildDemoPreview({candidateDirectory,expiresAt}) returning the preview object above. Execute candidate exports/API ONLY through existing sandbox primitives, with no inherited secrets/host mounts/network/fallback. Build an offline supported-demo artifact from actual candidate HTML/client JS and bounded actual API responses; label the offline response scope explicitly. Never execute candidate modules in control process. Browser execution is an opaque sandbox with no same-origin permission and restrictive enforced CSP; expiry tears down preview. No generic project preview claim.
- Frontend: apps/dashboard/index.ts owns discovery/readable summary/evidence/diff/preview. GET /dashboard/preview/:id serves only a valid current artifact to authenticated human session, as CSP-sandboxed HTML; iframe sandbox='allow-scripts' WITHOUT allow-same-origin, no popups/forms/top navigation, no credential bridge. Server CSP forbids network/connect/frames/forms/base, bounds artifact expiry. Keep old diagnostic IDs for regression tests.
- Feedback: apps/dashboard/feedback.ts exports feedbackHtml and feedbackScript strings, imported/interpolated into dashboard HTML/script. feedbackScript defines renderFeedback({view,readiness,findings,changes,contract}), uses existing lexical $, api, env, inspect, status, invalidateView functions, and attaches its form handler. Use existing exact-tuple finding/repair APIs, not a second feedback state machine. Request changes persists a blocking finding with selected obligation/affected Change/next owner; agents retrieve it and link a response revision via current APIs. No implicit acceptance, resolution or requirement edits.

Independent verification: real local Worker/DO/Git tests and isolated Chromium browser tests for discovery, evidence applicability, escaped source, preview containment/expiry, request-changes retrieval and linked repair. Synthetic human fixtures only. All children foreground/joined inside service cgroup. Cloudflare qualification remains separately gated. Update checkpoints with actual results; do not request sign-off until these paths are usable.

Required: working coordination API and understandable human decision page; immutable attributable Git revisions/Views stored in real Artifacts; genuine concurrent agents coordinating and repairing through the platform; preserved old experiment; actual check provenance and independent review; enforced refusal cases; human acceptance of the exact evaluated result; real Worker/DO/Artifacts readbacks; sanitized reports, runbook, bounded costs and an explicit resource-retention decision.

Not completion: a plan, green unit tests, replayed dashboard, scripts impersonating agents, local bare Git in place of Artifacts, deploying an empty Worker, or a claimed success without exact-target readback. At this planning checkpoint none of the implementation milestones is complete.
