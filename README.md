# Shared Agent Workspace

A local proof of concept for coordinating software work and reviewing its combined result. The collaboration platform is the task/claim/decision/revision/View/evidence system; it is not the sample application. The separate sample in `demo/seed/` is a small project-list API and browser UI. Its exercise is cursor pagination while preserving the legacy response and tenant isolation.

## The demo story

Follow one task through complementary API, UI, and adversarial-test contributions; a shared decision; a combined, source-pinned View; an actual finding with a named repair owner; the owner's repair; then fresh mandatory checks and an independent review on the replacement View. Finally inspect the human-readable task/evidence/diff/preview and, if available, request changes on that exact candidate. Evidence belongs to an exact source View and can go stale. Requesting changes is not acceptance. Acceptance is a separate human-only decision; do not accept on an operator's behalf.

Use the [local demo runbook](demo/runbook/cloud-demo.md), [recording storyboard/status](demo/runbook/recording.md), and [human handoff](demo/runbook/human-handoff.md) for the full walkthrough and boundaries. The recording document is a storyboard: no video or screenshots are represented as recorded. The preserved View and its prior checks/review are historical session evidence, not fresh evidence or a live service. See [REVIEW.md](REVIEW.md) for the retained candidate context; rediscover and verify a candidate in a newly authorized session before relying on it.

## Local install and checks

Node/npm must be available, and this is not a Node-only project. The supported preview/test host is Linux/NixOS with `/nix/store` access, bubblewrap (`bwrap`), working user namespaces, `fc-match` plus a sans-serif font, and Chromium/Chrome-for-Testing available on `PATH`. See [local prerequisites](demo/runbook/local-prerequisites.md). Dependencies are pinned in `package-lock.json` and `package.json`.

```sh
npm ci
npm run typecheck
npm run test
```

`npm run test` runs the unit/local integration suite and the Worker/workerd suite. To run either separately: `npm run test:unit` or `npm run test:worker`. The repository does not define a single-command end-to-end demo; setup, the one-shot runner, and the local service are separate workflows. Start with `demo/runbook/setup.md`, `demo/runbook/local.md`, and `demo/runbook/runner.md`.

For an offline install, `npm ci --offline` works only if the complete dependency set is already in npm's local cache. Otherwise `npm ci` fetches dependencies; arrange any required network access/authentication through the operator's normal process. No dependency installation is performed by the demo instructions. After dependencies are present, these read-only help forms require no credentials and avoid `npx` package-resolution ambiguity:

```sh
node --import tsx apps/local/index.ts --help
node --import tsx apps/setup/index.ts --help
node --import tsx apps/runner/index.ts --help
node --import tsx apps/cli/index.ts --help
```

The local service command, when an authorized human/operator has arranged credentials independently, is `node --import tsx apps/local/index.ts --state <protected-directory> --port 0 --run-seconds <seconds>`. It binds to loopback and runs in the foreground for at most 1800 seconds. Supply `AUTH_CREDENTIALS` and `DASHBOARD_SESSION_KEY` only through the authorized environment workflow described in `demo/runbook/local.md`; never place secrets in arguments, logs, reports, or agent context. Setup is local-only and requires a human-scoped token; the runner is a separate one-shot local operation using its own authorized runner identity. Do not copy a human token into the runner environment.

Current automated verification: 265 unit/local tests (70 files) and 96 Worker tests (28 files) passed in the continuous26 full regression; see [the exact log](reports/evaluation/continuous26-final-regression.log). The local integrated Project/client/runner/adapter/Git HTTP lifecycle reaches seed, revision, View composition and source verification. This is not a live multi-agent demonstration or cloud proof.

## What is and is not demonstrated

Local Miniflare, local Git transport, unit/integration tests, and Worker/workerd tests exercise local behavior. Historical session artifacts and candidate records remain retained; they do not imply that an old service URL, preview, credentials, or evidence are live. Setup accepts `sourceBackend: "local-git"` (default) or `"artifacts-git"`, but choosing the latter does not provide a native Cloudflare binding or activate a cloud backend. Binding/token and logical-HTTPS-to-loopback mapping in local integration are synthetic. The loopback runner boundary remains in force and its supported source-pack transfer is bounded to 36 KB. No real cloud/TLS write/readback, live agent session, current human acceptance, video, production-safety, or release-ready claim is made. Cloud qualification remains gated by [the recorded decision request](reports/cloud-authorization-needed.md); do not repeat the failed usage-API research.

Substantial selectively reused Gittifacts code retains its MIT notice and attribution in [`packages/git-transport/LICENSE`](packages/git-transport/LICENSE) and [`packages/artifacts-source/LICENSE`](packages/artifacts-source/LICENSE). Local adaptations are described in [GITTIFACTS-REUSE.md](GITTIFACTS-REUSE.md); inspected upstream revision: `5f06eb4a5e425fdc4796774e3bd4284a0056288b`.

For a reproducible local source checkpoint, use the [snapshot helper](demo/runbook/release-snapshot.md). Create an archive only after source freeze, and identify exactly what was tested using its external manifest and verification receipt. An older archive is not evidence for subsequent source edits. The helper excludes runtime state, credential paths, execution guards and reports; snapshots are local artifacts, not a published release or evidence of cloud/human acceptance.

Upstream selectively reused code retains its MIT notice and attribution at pinned revision `5f06eb4a5e425fdc4796774e3bd4284a0056288b`; see `GITTIFACTS-REUSE.md` and the package notices. No project Git commit or public publication is implied.
