# Bounded operator runner authentication qualification

This helper targets only Purdue account `cb50a73b7487ae7039cbc8b613986b8b`, existing Worker `git-collaboration-demo-c29` and its existing synthetic source repositories. It creates no Worker/DO/Artifacts resource, never publishes source, creates a task or runs checks, and never confirms or accepts a candidate. Native runner authentication is a different claim from a complete native candidate journey.

## Secure operator setup

Use the supported Node runtime and the existing native cf installation. The coordinator/operator must review the helper before running it; implementation pupils do not execute it against Cloudflare.

```sh
export PATH="$PWD/.local/host-node/bin:$PATH"
node --import tsx demo/cloud/runner-smoke.ts prepare
node --import tsx demo/cloud/runner-smoke.ts configure
node --import tsx demo/cloud/runner-smoke.ts probe
```

`prepare` creates or reuses `.local/cloud-cont44/runner-private.json` with mode0600 under a mode0700 directory. Do not print, copy into prompts, commit or attach that file. It contains the private project service key and later an expiring runner token.

`configure` captures `cf auth whoami` output, verifies the existing identity includes the fixed authorized account, then loads the existing OAuth token inside the program only. This CLI emits JSON without a `--json` flag. It never logs the OAuth token or passes the service key in argv. The helper reads the exact Worker settings, puts only `RUNNER_SERVICE_KEY` and rereads settings, requiring other binding identities/configuration to remain unchanged. Metadata readback alone does not prove the key's value; successful session issuance in `probe` provides that proof. No auth login, profile switch, broader token or unrelated account change is part of this procedure.

The ingress guard may have expired. A renewal is a separate, explicitly bounded attended operation targeting only `DEMO_EXPIRES_AT`; do not remove the guard or run a recurring renewal. Allow propagation before one follow-up read/probe, and preserve all existing secrets/bindings/candidate resources. Deployment uses `--keep-vars` and does not renew ingress automatically.

## Probe and evidence boundary

The probe reads the sanitized source receipt from `reports/evaluation/continuous40-platform-smoke.json`, not its private account/password/session state. It checks the created repository's ready catalog tuple and actual source, issues30-second scoped sessions, reads own-project context, verifies cross-project and owner-action refusal, tests a one-operation session's exhaustion and wrong-key refusal, then reads the same catalog/source again. It has a16-request budget,20-second per-request timeout and no redirect following. The native qualification produced12 requests; provider/token values never appear in the receipt.

Safe local results are written to `reports/evaluation/continuous44-runner-smoke.json`; partial failures retain only path/method/status/code. Do not publish raw operational reports as release source. Injected test fetches are labelled synthetic and cannot claim native session qualification. Native key setup and session/counter/source-invariance checks passed; native token expiry after waiting, native baseline/source jobs/checks/repair and real human acceptance are not proved by this helper.

The service key is restricted to this application's operator issuance endpoint, not a Cloudflare account token. Individual runner sessions remain repository-scoped, hashed, expiring and operation-capped. The key stays in private local state/Worker secret storage; ingress expires independently. Cleanup or key rotation belongs to the authorized operator and must preserve unrelated project secrets and retained source/candidates. No automatic cleanup, background job or cloud execution survives this one-shot probe.
