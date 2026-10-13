# Autonomous execution contract

User authorization: implement PRODUCT.md with an Astra engineering plan followed by parallel Luna implementation workers. Models: openai-codex/gpt-6-astra advisor; openai-codex/gpt-6-luna implementers. No model API spending ceiling; activity constrained by duty cycle.

## Current override — continuous execution, 2026-10-07

Noir authorized continuous work with manual pause/restart in place of the 25-minute/five-hour schedule. The fixed duty cycle below is historical and superseded. git-collaboration-cycle.timer is disabled; git-collaboration-cycle.service now runs .execution/continuous.py with no total RuntimeMaxSec. Individual coordinator/worker invocations remain bounded for checkpointing and hangs, but the supervisor starts the next successful iteration immediately without cooldown. All descendants remain inside the service cgroup. Stop the service to stop all project workers; start it to resume. Do not use SIGSTOP on budgeted runs. Major blockers and verified completion stop the loop. All cloud/account/spending/security and scope constraints below remain binding. Only the parent operator may change execution guards.

Astra remains coordinator and Luna remains implementation model. The continuous coordinator starts a fresh explicitly role-tagged session, then resumes only that exact coordinator identity; do not select an arbitrary latest project worker session.

## Historical hard duty cycle (superseded)

All model and project execution subprocesses run inside git-collaboration-cycle.service's systemd cgroup. RuntimeMaxSec=25min, TimeoutStopSec=5s, KillMode=control-group. Thus the active period stays below 30 minutes, including stop overhead. git-collaboration-cycle.timer starts the next window at least five hours AFTER service inactivity, not five hours after its start. No detached processes, external background agents, remote autonomous executions, project cron jobs, or subprocess escape from the service. No project model work between windows. The normal Hermes gateway is not stopped; this gate applies to this project's work.

Initial setup began 2026-10-07T01:37:14-04:00. The initial cycle additionally has an absolute deadline 2026-10-07T02:02:14-04:00 to count setup time conservatively. Later windows get 25 minutes. A failed or early-completed cycle still enters five-hour cooldown. Startup code refuses work before persisted cooldown ends. Major questions or routing failures create BLOCKED.md and stop future model activity until user resolution. No new external skills without inspection.

## Scope and accounts

Project: /home/noir/git-collaboration. No edits to other projects/profile configuration. Preserve PRODUCT.md. Do not publish a public repository or submit competition entry.

Cloudflare Purdue account: cb50a73b7487ae7039cbc8b613986b8b, Sriva140@purdue.edu's Account. OAuth authenticated and account visible; Paid subscription not yet verified. Gmail account: 36c74867d327a67156eddf58aaf5526c, Ansriv2005@gmail.com's Account. Do NOT upgrade either account. Do NOT modify existing workers, domains, DNS, redirects, secrets or deployments. Domains are available in principle but no domain changes are needed initially.

New project-only Cloudflare resources may be created only after verifying existing plan and conservatively establishing included usage headroom, per CLOUDFLARE-LIMITS.md. No paid add-ons or chargeable overages authorized. Otherwise implement locally and record deployment blocker. Remote integration success needs readback of exact targets, not mock-only tests. Never expose cloud credentials in logs, Git or browser-facing code.

## Delivery workflow

First cycle verifies Luna routing and requests Astra's high-level ENGINEERING.md and initial executable contracts. Later Astra coordinator windows resume saved context, inspect durable state and launch 3-6 bounded, disjoint Luna tasks where useful. Luna must be explicitly selected, not substituted. Coordinator owns integration, shared contracts and independent verification. Do not maximize worker count beyond available useful independent work. Testing and readback count as active work.

Astra may make bounded implementation and stack decisions aligned with PRODUCT.md, investigate current Cloudflare capabilities, and create project git history locally. Do not launch a new brainstorm or change the product direction. Pause for major ambiguity, necessary resource charges, or required missing permissions. Routine stack choices are delegated.

Each worker writes durable progress and tests before cutoff. CLI --run-budget and --max-turns bound calls; outer cgroup is authoritative even if a provider call hangs. Never rely on SIGSTOP to pause wall-clock budgets. At cutoff, terminated work is recovered from exact saved sessions/files next cycle, not treated as completed.

Maintain STATUS.md, ENGINEERING.md, per-worker reports, test results and NEXT.md. Claim completion only after real functionality is exercised, including actual concurrent agent coordination and guarded acceptance. Stop timer when completed or awaiting user input. Report verified milestones through project files; no out-of-window model-generated reporting.

## Operator commands

Inspect: systemctl --user status git-collaboration-cycle.service git-collaboration-cycle.timer
Stop future and current work: systemctl --user stop git-collaboration-cycle.timer git-collaboration-cycle.service
Logs: journalctl --user -u git-collaboration-cycle.service
State and reports: .execution/state.json and .execution/*.txt

Timing enforcement protects project worker processes, not third-party remote jobs; therefore remote autonomous workloads are prohibited during development. No tests or model work may survive the service window.
