# Scripted local operator journey (not agent acceptance)

This runbook documents a disposable, loopback-only usability proof. The verified Vitest journey starts `startLocalWorkspace` in-process, then runs `apps/setup/index.ts`, `apps/runner/index.ts`, and `apps/cli/index.ts` as joined child processes with 30-second per-command limits. The workspace budget is 150 seconds. Each run uses a temporary state directory, a temporary Git seed repository populated from the real `demo/seed/index.ts`, and a temporary local bare remote; cleanup runs even on failure. No model or agent is launched. This is not real-agent acceptance, mandatory check execution, View readiness, or human acceptance.

## Roles and environment

Use three distinct synthetic identities in the test only: `demo-human` (human), `demo-contributor` (contributor), and `demo-runner` (runner). Their synthetic tokens are independently hashed into local test credentials. Never reuse these values outside the test. The service authorizes each operation server-side by bearer identity.

In an operator shell, set these variables from your local setup without putting token values in arguments or files:

- `WORKSPACE_BASE_URL`: the actual `http://127.0.0.1:<port>` URL; setup and runner reject non-loopback targets.
- `WORKSPACE_PROJECT_ID`: the project's identifier.
- `WORKSPACE_TOKEN`: credential for the role used in that shell.

The API credential provider also needs local `AUTH_CREDENTIALS` and `DASHBOARD_SESSION_KEY` to start `apps/local/index.ts`; see `demo/runbook/local.md`. Keep them in the environment. Use a protected, disposable state directory. The example app accepts a bounded run duration; stop it normally. The automated proof uses `startLocalWorkspace` directly and always closes it, rather than spawning an unjoined service process.

## Journey commands

From the repository root, get exact source OIDs from the seed repository you intend to publish:

```sh
git -C <seed-repository> rev-parse HEAD
git -C <seed-repository> rev-parse 'HEAD^{tree}'
```

For the tested fixture, the disposable Git commit contains the actual contents of `demo/seed/index.ts` (not invented metadata), committed under a synthetic author, with a newly initialized bare repository as remote. In an operator shell, inspect help and create approved demo metadata as a human:

```sh
npx tsx apps/setup/index.ts --help
npx tsx apps/setup/index.ts '{"requestId":"operator-setup","commitOid":"<40-hex-commit>","treeOid":"<40-hex-tree>"}'
```

Setup creates and approves contract version 1 with the six obligations `legacy-response`, `pagination-order`, `cursor-validation`, `tenant-isolation`, `ui-navigation`, and `ui-tenant-switch`; installs policy version 1 with mandatory demo API/UI checks; and queues the seed job. Its output explicitly reports `pending-seed-publication`. It does not execute or publish source.

In a separate runner shell, use only the runner identity and its own `WORKSPACE_TOKEN`:

```sh
npx tsx apps/runner/index.ts --help
npx tsx apps/runner/index.ts source-job '{"remote":"<absolute-local-bare-git-path>","workspaceRoot":"<absolute-local-workspace-path>","seedRepository":"<absolute-local-seed-repository>","repositories":{},"requestId":"operator-seed"}'
```

A one-shot call claims one queued job. To read its state, use the `apps/cli` read command with the runner identity and runner token (not `apps/runner`, whose `source-job` command executes queued work):

```sh
npx tsx apps/cli/index.ts source-job '{"id":"<job-id>"}'
```

Then use the human CLI for the baseline. Verify the receipt commit/tree and ref against Git; do not infer a runnable baseline from setup output alone.

With the human identity, read the actual baseline:

```sh
npx tsx apps/cli/index.ts baseline
```

With the contributor identity, inspect context, claim scoped work, create a Change, and publish a revision. The exact JSON forms and all supported operations are in `npx tsx apps/cli/index.ts --help`:

```sh
npx tsx apps/cli/index.ts context
npx tsx apps/cli/index.ts claim '{"requestId":"claim-1","payload":{"obligationIds":["legacy-response"],"areas":["demo/seed/index.ts"],"status":"working"}}'
npx tsx apps/cli/index.ts change-create '{"requestId":"change-1","payload":{"title":"Example source change","obligationIds":["legacy-response"]}}'
npx tsx apps/cli/index.ts revision-publish '{"id":"<change-id>","mutation":{"requestId":"revision-1","payload":{"baseCommitOid":"<baseline-commit>","commitOid":"<contributor-commit>","treeOid":"<contributor-tree>","obligationIds":["legacy-response"],"decisionRevisions":[],"dependencies":[]}}}'
```

A reserved revision is not yet published. In the runner shell, run the same `source-job` command with `repositories` mapping the actual contributor actor ID to its local checkout. Then read back `change '{"id":"<change-id>"}'` and `revision '{"id":"<revision-id>"}'` through the contributor CLI. Confirm the revision is `published`, its receipt is `local-git`, and `git -C <bare-remote> rev-parse <receipt-ref>` and `^{tree}` match the exact commit and tree. Keep role credentials in separate environments; never copy the human credential to a contributor or runner.

## Scope and limitations

The automated test exercises setup metadata, seed publication, baseline receipt readback, contributor context and claim, Change/revision reservation, runner publication, and exact API/Git readback. It does not claim the mandatory API/UI suites ran, a View is runnable, independent review occurred, or human acceptance happened. The local runner is not a hostile-code sandbox or a production deployment. Run `npm run test:unit -- tests/e2e-local/operator-journey.test.ts` and `npm run typecheck` to verify this journey in the current checkout.
