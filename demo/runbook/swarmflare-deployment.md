# Swarmflare build and deployment handoff

## Exact project target

Use `wrangler.demo.jsonc`, not the local config. It targets existing Worker `git-collaboration-demo-c29`, Purdue account `cb50a73b7487ae7039cbc8b613986b8b`, existing Artifacts namespace `git-collaboration-demo-c29`, and the same `Project` SQLite class. Migration v2 adds only the account/catalog `Platform` SQLite class and `PLATFORM` binding. `demo-index.ts` keeps the fail-closed `DEMO_EXPIRES_AT` guard and delegates the product/legacy API paths to the integrated Worker. Keep the 100 ms CPU limit and disabled preview URLs; no DNS/routes/other sites/upgrades are required.

This config/build is qualified locally, not deployed by this milestone. Do not reset the existing Project DO, recreate namespace/source/candidate resources, or infer new account UI deployment from a development-branch push.

## Build commands

After pinned dependency installation:

```sh
npm ci
npm run check:swarmflare
```

`check:swarmflare` performs typecheck, serial supported account/catalog/source/site/task/deployment tests, targeted Worker authentication/review/acceptance-security tests, then `build:swarmflare`. That build is a Wrangler dry-run; it lists `PROJECTS`, `PLATFORM` and `ARTIFACTS` without uploading resources. The full supported-host regression and Chromium journey are separate release qualifications, not omitted acceptance requirements.

For an authorized deployment from the same verified source:

```sh
npm run deploy:swarmflare
```

Run the build gate before deployment. Native Workers Builds should use development branch `Noir01/swarmflare`, root directory `/`, build command `npm ci && npm run check:swarmflare`, deployment command `npm run deploy:swarmflare`. Do not configure preview branches against this retained demo state. Verify exact resulting deployment/version and binding names by readback before calling automation working.

## Automation credential boundary

Automated deployment is authorized but NOT connected. The current GitHub OAuth account has repo access but no workflow scope. A GitHub Actions workflow push requires the user to run `gh auth refresh -h github.com -s workflow` from their WSL terminal. This source milestone does not create a workflow or ask for a personal Cloudflare credential.

The alternative is user installation/connection of Cloudflare Workers Builds for this existing project Worker in Settings/Builds, selecting the private repository and development branch above. Do not copy existing personal Cloudflare OAuth/refresh tokens into GitHub secrets or automation. Actions requires a dedicated, appropriately scoped credential and exact account/project targeting; native Workers Builds uses its own approved installation. No setup is verified until an actual run and version readback succeed.

## Private state and expiry

Preserve current `AUTH_CREDENTIALS`, `DASHBOARD_SESSION_KEY`, `ARTIFACTS_SOURCE_CONFIG`, existing demo bootstrap configuration and `DEMO_EXPIRES_AT` through the secure operator workflow. Do not print their values, upload private `.local`/`.execution` state, embed secrets in config/argv, or read/use the human credential. Secrets remain deployment secrets rather than source vars. The existing expiry may have elapsed; preserve bounded renewal under current authority rather than removing the guard or introducing a perpetual refresh job.

## Before activating the account-backed cloud path

1. Verify native binding create/import/get/token/readback against tiny authorized inputs. Current local source tests use actual Git smart HTTP but synthetic provider metadata/token and HTTPS mapping.
2. Close known source token-cleanup gaps after malformed provider responses or failed handle acquisition, and bound pending imports/provider waits. Do not treat untested cleanup as verified because happy-path source tests pass.
3. Finish account-owned task approval/baseline initialization/per-repository runner-source mapping. New repositories correctly refuse Changes without approved contracts. Existing static project credentials do not establish new ownership or runner access.
4. Verify outsider/agent refusal, exact candidate/source/check freshness, safe preview, feedback and human-only final acceptance. No agent may perform the human approval/acceptance during qualification.
5. Deploy only the project config, read back exact resources/version, and exercise signup/login/logout and public source browsing with bounded synthetic test accounts, never the reserved human-review credential.

The old `cloud-deployment.md` records the original c29 provisioning workflow; its placeholder and initial-resource creation instructions are historical, not the current Swarmflare deployment procedure.
