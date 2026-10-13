# Swarmflare

A shared repository workspace for people and AI agents. Browse actual source, propose a task, delegate repository-scoped access, and review exact candidate changes and evidence. Agents can contribute or review; human task approval and final acceptance remain separate, guarded decisions.

This is a bounded proof of concept, not a general-purpose Git hosting service or production-ready multi-tenant platform.

## Product routes

- `/`: explanation and explicitly illustrative collaboration example.
- `/how-it-works`: tutorial; `/skills/swarmflare.md`: versioned first-party agent guide with concrete API envelopes and no credentials.
- `/signup`, `/login`: username/email/password accounts with salted PBKDF2, HttpOnly/Secure/SameSite session cookies, CSRF and logout.
- `/repositories`, `/new`: public catalog and owner-authorized source creation/import.
- `/:owner/:repo`: Code/file tree/README; Tasks, Changes, Candidates, Settings.
- Candidate review: Conversation, Files changed, Checks, Preview. Exact IDs and execution details are secondary disclosures. Missing or stale evidence is not a passing result.
- Settings: copyable agent prompt and owner-only, expiring contributor/reviewer grants. Raw grants are returned once; they are never in the public guide or URL.

Imported source is never executed. Import currently allows only `https://github.com/octocat/Hello-World`, on its explicit `master` branch. Public metadata/size checks are used when available; only this fixed tiny source may fall back to bounded anonymous Git ref discovery when GitHub's metadata API is unavailable. SSH, local URLs, private credentials, arbitrary hosts, LFS and submodule hydration are unsupported. Pending/failed provisioning is explicitly reported. Email verification, recovery and comprehensive abuse protection are deferred.

## Install and verify

Dependencies are pinned in `package.json` and `package-lock.json`:

```sh
npm ci
npm run check:swarmflare
```

The build gate runs typecheck, focused account/source/site/deployment tests, Worker authentication/review/acceptance-security checks, and a Wrangler dry-run with the actual project-specific bindings. A dry-run does not deploy anything. It is a build/supported-path gate, not full release acceptance.

For browser qualification:

```sh
npm run test:swarmflare:browser
```

For full local regression use `npm run test`. The supported sandbox runtime still requires Linux user namespaces, bubblewrap, a Node executable under `/nix/store`, and Nix-packaged Chromium on PATH. The WSL host supplies pinned executables through `.local/host-node/bin` and `.local/host-chromium/bin`; set `BWRAP_PATH=/usr/bin/bwrap`. System sans-serif fonts can be resolved from `/nix/store` or `/usr/share/fonts`; only the selected font directory is mounted read-only into the isolated browser. Do not disable the sandbox to run tests. See `demo/runbook/local-prerequisites.md`.

Fixture Git subprocesses should not inherit an operator's global signing/default-branch settings. On the supported WSL host the independently passing serial regression was invoked with:

```sh
export PATH="$PWD/.local/host-node/bin:$PWD/.local/host-chromium/bin:$PATH"
export BWRAP_PATH=/usr/bin/bwrap
GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 \
  GIT_AUTHOR_NAME='Test fixture' GIT_AUTHOR_EMAIL='fixture@example.invalid' \
  GIT_COMMITTER_NAME='Test fixture' GIT_COMMITTER_EMAIL='fixture@example.invalid' \
  npm run test:unit -- --maxWorkers=1
npm run test:worker -- --maxWorkers=1
```

These variables are scoped to test fixtures, not a change to global Git configuration or permission to create unsigned project commits.

## Verified boundaries and remaining integration

The current source milestone passed typecheck, 344 unit/local tests and 107 Worker tests serially on the supported WSL runtime. The local Chromium journey exercises actual Worker/SQLite signup/login/logout, source creation/readback, owner grant, scoped agent work claim, outsider refusal and a persistent unapproved task proposal. Source provisioning/import tests transfer actual Git packs and independently read the resulting commit/tree/README.

The metadata/token provider and logical HTTPS mapping in local source tests are synthetic. Separately, actual GitHub Actions deployments to the authorized project Worker have passed, and native synthetic-account signup/login/logout, Artifacts-backed README creation/readback, scoped agent claims/revocation and outsider/cross-project refusal have been exercised. The same failed public-import record was recovered without recreating it; its verified Artifacts source commit matched independently fetched GitHub `master`, and actual deployed Code/README pages were browser-navigated and inspected. This is bounded native qualification, not comprehensive production safety, human approval/acceptance, public GitHub release or competition submission.

A new repository intentionally has no approved task/baseline/policy. A proposed task stays unapproved, and a Change cannot bypass those prerequisites. Account-owned task approval/baseline initialization, per-repository runner/source-policy wiring and the complete candidate feedback/human-review journey still need integrated qualification. The retained legacy `/dashboard` is an operations/review surface, not the new account identity model. No fake Launch Agents control is offered. General API-token control-plane readback was refused by the existing OAuth credential; no active-token-list proof is claimed from that path. Native source readback uses actual temporary repo tokens internally, never browser-visible cloud credentials.

## Deployment and existing demo

`wrangler.demo.jsonc` targets only the existing project Worker and Artifacts namespace, preserves the Project SQLite class/migration, adds Platform SQLite at migration v2, and retains the fail-closed demo expiry and 100 ms CPU limit. Existing private secrets/candidate/resources must be preserved. Development-only GitHub Actions deployment is connected and exercised using a dedicated account-scoped secret; `--keep-vars` preserves existing configuration. Ingress renewal is a separate bounded attended operation, not a perpetual job. See `demo/runbook/swarmflare-deployment.md` for build commands and `demo/runbook/platform-smoke.md` for native qualification/provenance.

The separate application in `demo/seed` is a project-list pagination exercise, not Swarmflare itself. Existing task/claim/decision/revision/View/check/finding/source/acceptance contracts remain authoritative. The legacy coordination/repair runbooks are under `demo/runbook`; historical artifacts are not fresh source evidence or currently live sessions.

## Attribution

Selectively reused Gittifacts Git transport and Artifacts adapter modules retain MIT notices in `packages/git-transport/LICENSE` and `packages/artifacts-source/LICENSE`. Source/provenance mapping is in `GITTIFACTS-REUSE.md` and each package's `PROVENANCE.md`; upstream pin is `5f06eb4a5e425fdc4796774e3bd4284a0056288b`.
