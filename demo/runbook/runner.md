Bounded local runner

Run from the repository root in the foreground. The runner performs exactly one command and exits; it does not poll or auto-accept. Configure a dedicated runner identity using WORKSPACE_BASE_URL, WORKSPACE_PROJECT_ID, and WORKSPACE_TOKEN in the environment. The base URL is restricted to plain HTTP at 127.0.0.1 or [::1] only (not hostname resolution). Do not use a remote workspace or place credentials in command arguments.

  npx tsx apps/runner/index.ts --help
  npx tsx apps/runner/index.ts source-job '{"remote":"/absolute/path/remote.git","workspaceRoot":"/absolute/path/work","seedRepository":"/absolute/path/seed","repositories":{"actor-id":"/absolute/path/contributor"},"requestId":"source-001"}'
  npx tsx apps/runner/index.ts mandatory-checks '{"remote":"/absolute/path/remote.git","workspaceRoot":"/absolute/path/work","viewId":"view-id","requestId":"checks-001"}'
  npx tsx apps/runner/index.ts verify-source '{"remote":"/absolute/path/remote.git","viewId":"view-id","requestId":"verify-001"}'
  npx tsx apps/runner/index.ts review-artifact '{"remote":"/absolute/path/remote.git","workspaceRoot":"/absolute/path/work","viewId":"view-id"}'

All Git paths must be local filesystem paths. Source publication repositories are selected from the server-provided revision owner and the explicit repositories allowlist; an unknown owner fails closed. Composition uses the explicit bare remote. Seed jobs require seedRepository. A claimed job marked failed produces a non-zero process exit; a null claim is an empty one-shot result, not a success claim. Check/source execution is delegated to the existing restricted local-runner and Git modules.

The local API and Git state are not disposable unless you explicitly choose disposable directories. Keep human/operator credentials separate from the runner environment; never pass human credentials to agents. This is a loopback local runner, not a Cloudflare deployment or production-safe sandbox for hostile code. Stop the foreground command normally with Ctrl-C; it has no detached children.

`review-artifact` builds using the existing source-pinned local runner builder, records the artifact and verifies an exact server readback. It requires an existing accepted baseline and runnable candidate. Output contains bounded metadata (artifact/version, matching project/View, baseline tuple, diff size/count and optional preview expiry), never the HTML or diff body. The preview expires after 120 seconds; expiry is enforced by the service and is not extended by regeneration. To renew an expired preview, run the same command again for the same exact View to create/read back a fresh artifact. No poller or daemon is started. The builder/client/backend own the artifact contract and persistence; this CLI only invokes the builder and reports safe metadata.
