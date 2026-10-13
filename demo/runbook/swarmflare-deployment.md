# Swarmflare build and deployment handoff

## Exact project target

Use `wrangler.demo.jsonc`, not the local config. It targets existing Worker `git-collaboration-demo-c29`, Purdue account `cb50a73b7487ae7039cbc8b613986b8b`, existing Artifacts namespace `git-collaboration-demo-c29`, and the same `Project` SQLite class. Migration v2 adds only the account/catalog `Platform` SQLite class and `PLATFORM` binding. `demo-index.ts` keeps the fail-closed `DEMO_EXPIRES_AT` guard and delegates the product/legacy API paths to the integrated Worker. Keep the 100 ms CPU limit and disabled preview URLs; no DNS/routes/other sites/upgrades are required.

This config/build and native development Actions deployment have been exercised. Exact deployment and binding readbacks were independently verified; the bounded native account/source probe is documented in `platform-smoke.md`. Do not reset the existing Project DO, recreate namespace/source/candidate resources, or infer a presently open endpoint or human session from a development-branch push.

## Build commands

After pinned dependency installation:

```sh
npm ci
npm run check:swarmflare
```

`check:swarmflare` performs typecheck, serial supported account/catalog/source/site/task/deployment tests, targeted Worker authentication/review/acceptance-security tests, then `build:swarmflare`. That build is a Wrangler dry-run; it lists `PROJECTS`, `PLATFORM` and `ARTIFACTS` without uploading resources. The full supported-host regression and Chromium journey are separate release qualifications, not omitted acceptance requirements.

The repository's `.github/workflows/deploy-development.yml` runs this gate and then deploys only on pushes to `development` or a manual dispatch. It uses the repository secret `CLOUDFLARE_API_TOKEN` and the explicit Purdue account ID. Actual successful Actions deployments established this route's validity for the project; no token value was read or copied into source.

For an authorized deployment from the same verified source:

```sh
npm run deploy:swarmflare
```

The deploy script uses `--keep-vars` so existing Worker variables/secrets are retained. The workflow is bounded to 10 minutes, serializes this project's deployments without cancelling an in-progress run, and does not run the isolated-browser suite. It does not renew the demo expiry. Verify the exact resulting deployment/version and binding names by readback before calling automation working.

## Automation credential boundary

GitHub Actions deployment uses the dedicated repository secret `CLOUDFLARE_API_TOKEN`; its value is never read or copied into source. Native Workers Builds is ruled out because the GitHub account is linked to another Cloudflare account. Do not reconnect it, copy personal Cloudflare OAuth/refresh tokens into GitHub, or request another credential. Verify each exact Actions run/deployment/version rather than treating an earlier successful run as proof of a later push.

## Private state and expiry

Preserve current `AUTH_CREDENTIALS`, `DASHBOARD_SESSION_KEY`, `ARTIFACTS_SOURCE_CONFIG`, existing demo bootstrap configuration and `DEMO_EXPIRES_AT` through the secure operator workflow. Do not print their values, upload private `.local`/`.execution` state, embed secrets in config/argv, or read/use the human credential. Secrets remain deployment secrets rather than source vars. The existing expiry may have elapsed; preserve bounded renewal under current authority rather than removing the guard or introducing a perpetual refresh job.

## Qualified source path and remaining integration

1. Native binding README creation and fixed public master import now have actual source/README readback. Local source tests remain actual Git smart HTTP with synthetic provider metadata/token and HTTPS mapping; they are not native evidence by themselves.
2. Fault tests cover source token cleanup after malformed provider responses/failed handle acquisition and bounded pending imports. General control-plane active-token listing was refused by the current OAuth credential; do not claim that audit or broaden credentials to obtain it routinely.
3. Account-owned task approval, verified baseline initialization and per-repository runner-source mapping are exercised locally with actual SQLite/Git. Local repair/re-review retains the original source and baseline; prepared first-party code/scripted synthetic reviews are not a fresh agent campaign. The new operator runner key/session scope has bounded native authentication proof only. Complete native account-owned baseline/source-job/candidate/repair qualification is still outstanding. New repositories correctly refuse Changes without approved contracts; existing static project credentials do not establish new ownership or runner access.
4. Verify outsider/agent refusal, exact candidate/source/check freshness, safe preview, feedback and human-only final acceptance. No agent may perform the human approval/acceptance during qualification.
5. Deploy only the project config, read back exact resources/version, and exercise signup/login/logout and public source browsing with bounded synthetic test accounts, never the reserved human-review credential.

The old `cloud-deployment.md` records the original c29 provisioning workflow; its placeholder and initial-resource creation instructions are historical, not the current Swarmflare deployment procedure.
