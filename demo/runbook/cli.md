CLI runbook

Run from the repository root:

  WORKSPACE_BASE_URL=http://127.0.0.1:8787 WORKSPACE_PROJECT_ID=demo npx tsx apps/cli/index.ts --help

Help works without credentials and lists every CLI command, the mutation envelope, and command-specific JSON shapes. For real requests, set WORKSPACE_BASE_URL, WORKSPACE_PROJECT_ID, and WORKSPACE_TOKEN in the process environment; never put bearer tokens in command arguments or checked-in files. Responses are JSON; errors are JSON on stderr and use a non-zero exit status.

Examples (replace IDs and payload values with real values from the project):

  npx tsx apps/cli/index.ts context
  npx tsx apps/cli/index.ts resolve-decision '{"id":"decision-id","mutation":{"requestId":"resolve-1","expectedVersion":1,"payload":{"kind":"clarification","contractVersion":1,"note":"Clarify the requirement"}}}'
  npx tsx apps/cli/index.ts checks '{"id":"view-id"}'
  npx tsx apps/cli/index.ts configure-policy '{"requestId":"policy-1","expectedVersion":0,"payload":{"contractVersion":1,"checkSuiteDigest":"<64-hex-digest>","harnessVersion":"json-oracle-v1","checks":[{"id":"check-id","obligationIds":["obligation-id"]}],"requireIndependentReview":true,"sourceBackend":"local-git"}}'
  npx tsx apps/cli/index.ts source-verification '{"id":"view-id"}'

For write operations, requestId is the idempotency key; use the same key and exact envelope to retry. Include expectedVersion where the operation requires optimistic concurrency. CLI/client schema validation is not authorization: the server authenticates the bearer identity and enforces roles. Human-only proposal approval, policy changes, view confirmation and acceptance require a genuinely human identity. Do not give a human token/secret to an agent. Agents must not confirm or accept on behalf of a human. Source verification is read-only in this CLI command; trusted source workflows record verification receipts. Acceptance requires current server-validated evidence and confirmation and may be refused.

The CLI exposes only operations already implemented by WorkspaceClient and its frozen route validation; it does not create endpoints or bypass those checks. Use --help for the complete command list and exact envelope forms. Generic get/mutate remain restricted to the client's frozen routes.
