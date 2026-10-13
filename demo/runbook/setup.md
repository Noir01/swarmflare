# Local demo setup

This command creates an approved task contract, its mandatory local demo policy, and a queued seed-publication job. It does not execute, inspect, publish, or test source code. The supplied commit/tree OIDs identify the pending seed only. A runner must publish the seed through the local Git source workflow and read its receipt back before the baseline is runnable.

## 1. Start the local workspace

Use the bounded foreground workspace service from `demo/runbook/local.md`:

```sh
npx tsx apps/local/index.ts --state <protected-state-directory> --port 0 --run-seconds 1800
```

Set `AUTH_CREDENTIALS` and `DASHBOARD_SESSION_KEY` in the process environment as described there; never place credentials in command arguments or this runbook. The startup output reports the actual `http://127.0.0.1:<port>` URL. The workspace is local-only; it is not a remote deployment.

## 2. Prepare the seed OIDs

From the actual local seed Git repository, obtain the commit and tree OIDs:

```sh
git -C <seed-repository> rev-parse HEAD
git -C <seed-repository> rev-parse 'HEAD^{tree}'
```

These are inputs, not proof of published or runnable source. Do not claim the initializer executes the commit.

## 3. Human initializes approved metadata

In a human operator shell, set `WORKSPACE_BASE_URL` to the printed loopback URL, `WORKSPACE_PROJECT_ID` to the project identifier, and `WORKSPACE_TOKEN` to a genuinely human credential. Keep secrets in the environment; do not echo them, put them in shell history, or pass them to an agent. The initializer accepts literal HTTP `127.0.0.1` or `[::1]` only and refuses remote URLs and redirects.

```sh
npx tsx apps/setup/index.ts --help
npx tsx apps/setup/index.ts '{"requestId":"demo-setup-001","commitOid":"<40-lowercase-hex-commit>","treeOid":"<40-lowercase-hex-tree>","sourceBackend":"local-git"}'
```

`sourceBackend` is optional and defaults to `local-git`; the only other accepted value is `artifacts-git`. It selects the source backend recorded in the approved policy; it does not activate a native binding or provision/deploy anything. Unknown keys and unsupported values are rejected before any workspace request. Select the same backend when retrying an existing setup; changing it against an existing policy is refused before mutations. Both modes remain loopback-only and create only a queued seed job; this setup does not publish a baseline or fabricate an Artifacts receipt.

The setup request creates and human-approves a contract with exactly these obligation IDs: `legacy-response`, `pagination-order`, `cursor-validation`, `tenant-isolation`, `ui-navigation`, `ui-tenant-switch`. Required check IDs are `mandatory-demo-api` and `mandatory-demo-ui`. It installs the server-trusted `mandatoryDemoSuiteDigest()` policy with API coverage for the first four obligations and UI coverage for the final two, then requests baseline initialization (all expected versions are 0).

Keep `requestId` unchanged when retrying the exact same commit/tree payload: the CLI derives stable per-operation idempotency keys from it. Reusing it with different OIDs is rejected, not overwritten. The JSON output includes IDs and explicitly marks the seed job pending. The contract and policy setup succeeds only under an actual human identity enforced by the server; the CLI does not impersonate or upgrade roles and exposes no accept/confirm operation.

## 4. Runner publishes and verifies the pending seed

Use a separate runner shell/credential. Never export or copy the human token to the runner. Set `WORKSPACE_BASE_URL`, `WORKSPACE_PROJECT_ID`, and `WORKSPACE_TOKEN` for a runner identity, then follow `demo/runbook/runner.md` and run the existing source-job command once:

```sh
npx tsx apps/runner/index.ts source-job '{"remote":"<absolute-local-bare-git-path>","workspaceRoot":"<absolute-local-workspace-path>","seedRepository":"<absolute-local-seed-repository>","repositories":{},"requestId":"demo-seed-run-001"}'
```

The supervisor maps repositories for the actual server job; use the repository mapping required by the local runner installation. The runner claims work once and publishes the seed. Read the job back using the human CLI with `source-job` status by returned job ID and verify its completed status and receipt; then read `baseline` and confirm it matches the exact receipt commit/tree. `initializeBaseline` itself only returns the queued job and is verified by the setup CLI to leave baseline readback null. Until publication and the completed-job receipt/baseline readback succeed, treat the baseline as pending and do not call it runnable.

## 5. Continue the demo lifecycle

Agents receive only their scoped contributor credentials and the approved contract/policy. Use the existing CLI documented in `demo/runbook/cli.md` to create Changes and publish revisions; the runner publishes and composes source jobs and runs the mandatory suites as documented in `demo/runbook/runner.md`. A runnable View requires its actual source receipt, both mandatory checks, and independent review. Human confirmation/acceptance is a distinct later action; this setup command does neither.

All example identifiers and OIDs above are placeholders, not credentials. No hidden file or credential store is generated by the initializer.