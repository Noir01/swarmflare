# Review the local demo

Start here when you want to understand a candidate. This is a review guide, not an approval or deployment.

## What you are reviewing

The collaboration platform coordinates tasks, agents, revisions, evidence and review. The sample application is a separate small project-list API and browser UI. Its demo work adds cursor pagination while preserving the legacy response and tenant isolation. The historical tenant-switching bug is context, not a current open finding on the candidate.

The preserved candidate is View `d33bde01-a380-4b41-9d06-c8ee729f9fe2` in project `continuous11-live`. Start with the candidate freshly discovered in the dashboard; do not treat old IDs, receipts or URLs as live evidence. The deliverable is local code, not a deployed site.

## Review flow

1. **Outcome:** Read the task and current status; distinguish current blockers from historical findings.
2. **Candidate:** Select the exact View. Check its source identity and compare it with the current baseline.
3. **Requirements:** Inspect requirement-linked evidence and whether checks/reviews apply to this exact candidate. Historical passing records are not fresh authorization.
4. **Diff:** Read the exact source diff against the accepted baseline.
5. **Try result:** Use the supported demo preview only if available and current. It is a short-lived preview of this candidate, not arbitrary code execution or a deployment.
6. **Request changes:** If needed, send feedback on that exact candidate; it is not acceptance or a policy change.

Review, confirmation and acceptance are distinct. Do not confirm or accept as part of reading this guide. A human decision, if later made in an authorized active session, must follow fresh exact-candidate readbacks and the dashboard's separate controls. Local acceptance changes only the local project baseline; it does not deploy remotely.

## Operator setup (local only)

The old bounded service is stopped and its old URL is not promised to work. The startup-created temporary human setup token was discarded; it cannot be recovered or recreated. An authorized operator must arrange real human authentication independently through an approved credential provider, keeping credentials out of agent contexts. If that cannot be done, stop and arrange a newly approved human-authenticated session.

Verified local start syntax from `apps/local/index.ts --help`:

`npx tsx apps/local/index.ts --state <directory> --port <port> --run-seconds <seconds>`

The help confirms required environment variables `AUTH_CREDENTIALS` and `DASHBOARD_SESSION_KEY`. See `demo/runbook/local.md` for bounded lifetime (maximum 1800 seconds), loopback binding, and safe separation; do not put secrets in command arguments or logs. Once an authorized session is independently arranged, open `/dashboard` and sign in as a human for the project.

Optional artifact refresh is a separate one-shot local runner operation. See `demo/runbook/runner.md`; its verified help names `review-artifact` and requires runner-only `WORKSPACE_BASE_URL`, `WORKSPACE_PROJECT_ID`, and `WORKSPACE_TOKEN`. The operator must arrange these independently. It reads back a source-pinned artifact; preview expires after 120 seconds and can be refreshed by running that same operation for the exact View. Its output is bounded metadata, not the diff or HTML.

Local evidence is not Cloudflare qualification. Remote entitlement, capacity, ingress, source and production gates remain separate and unchanged.