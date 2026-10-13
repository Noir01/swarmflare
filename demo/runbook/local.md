# Local workspace (foreground)

Start with `npx tsx apps/local/index.ts --state <directory> --port <port> --run-seconds <seconds>` in a dedicated foreground terminal. Supply `AUTH_CREDENTIALS` (the strict worker credential JSON) and a 64-character lowercase hexadecimal `DASHBOARD_SESSION_KEY` through the environment; do not put them in command arguments, logs, recordings, or agent contexts. The process binds only to `127.0.0.1` and exits after the requested bounded run (at most 1800 seconds). Ctrl-C or termination signals close Miniflare; the library API also exposes an idempotent `close()` and a `closed` promise.

The `--state` directory stores Durable Object SQLite persistence and must be protected as workspace data. Keep human/operator credentials and session-key material in a separate environment from any agent credentials. Provide only agents their specifically scoped identity; do not distribute human credentials or session keys.

For identity/configuration manifests, record credential identity hashes only, never tokens or session keys. This is a local Miniflare workspace, not Cloudflare provisioning, deployment, or a claim of remote availability.
