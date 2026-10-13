# Cloudflare budget and deployment constraints

## Current read-only qualification — continuous20, 2026-10-11

The historical authentication/entitlement statements below are superseded by reports/cloud-preflight.md: Purdue account subscriptions GET now verifies existing Workers Paid (workers_paid, state Paid). Both current billable-usage/info and billable-usage GETs failed HTTP403/code10000; account-wide usage, billing period, reporting lag, Artifacts availability and bounded ingress remain unverified. No remote writes are authorized. Subscription component values are NOT usage totals. All spending restrictions remain binding. EXECUTION.md/DECISIONS.md continuous override supersedes historical duty-cycle prose; this document does not alter guards.

Verified from official pricing documentation on 2026-10-07. These are account-wide allowances, not a fresh allowance per project. Account plan and existing usage are currently unknown. Authentication subsequently verified: valid OAuth login for sriva140@purdue.edu and both accounts visible. User reports Purdue account already has Workers Paid; verify its subscription and usage before provisioning. Target account cb50a73b7487ae7039cbc8b613986b8b. Gmail account 36c74867d327a67156eddf58aaf5526c must not be upgraded or modified for this project.

## Required services

### Workers

Source: https://developers.cloudflare.com/workers/platform/pricing/

- Free: 100,000 requests/day; 10 ms CPU per invocation.
- Paid Standard: minimum $5/month account subscription; includes 10 million requests/month and 30 million CPU milliseconds/month.
- Paid overages: $0.30/million requests and $0.02/million CPU milliseconds.

### Artifacts

Source: https://developers.cloudflare.com/artifacts/platform/pricing/

- Available only on Workers Paid, NOT Workers Free.
- Billing for Artifacts operations/storage begins October 14, 2026.
- Paid plan includes 10,000 operations/month and 1 GB-month storage across repositories.
- Overage: $0.15 per additional 1,000 operations; $0.50 per additional GB-month.
- Stored repositories remain until explicitly deleted. Storage uses averaged daily peak usage, not simply current bytes.

## Spending policy

User authorized model/API use under the project duty-cycle rule, but requested staying within Cloudflare free limits. Do not interpret included Paid allowances as a free subscription or authorize a plan upgrade.

Before remote provisioning: authenticate, verify target account and current plan, inspect available account-wide usage, and resolve Workers Paid requirement with user. No plan upgrades, paid-service activation, or existing deployment modifications without approval. If sufficient usage cannot be established, keep development local and report the deployment blocker.

Do not assume staying under this project's limits prevents account-wide overages. Avoid public unprotected endpoints or uncapped automation. Define conservative project operation/storage caps with headroom before deployment, track consumption, and fail closed where usage cannot be bounded. Pricing documentation is not a spending enforcement mechanism.

Other services (D1, Durable Objects, R2, Queues, Containers, etc.) are not yet selected. Retrieve and record their current limits before choosing or provisioning them; do not assume they are free.

## CLI discovery

cf is installed at /home/noir/.local/state/nix/profile/bin/cf.

Read-only checks: `cf auth whoami` returned authenticated=false / Not logged in. `cf accounts list` failed because no authentication token was found. Remote account access has NOT been verified in this execution environment.

## Models and timing

Advisor: openai-codex / gpt-6-astra.
Implementation workers: openai-codex / gpt-6-luna (user-provided identifier; live routing still needs verification).

Hard requirement: no more than 30 minutes of project activity, then at least five hours with no project agents active. Durable timing enforcement is not yet installed; do not launch autonomous workers until it is installed and tested.
