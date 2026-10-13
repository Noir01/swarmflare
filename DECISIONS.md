# Approved execution decisions

## Human-review experience — user-approved implementation

Read HUMAN-REVIEW.md. Noir agreed to the proposed usable review experience after the current JSON console proved confusing. Implement candidate discovery, readable task/result/evidence, exact diff, safely isolated supported-demo preview and request-changes loop before requesting sign-off again. The continuous14 human acceptance action remains reserved; it no longer blocks this UX implementation. Do not confirm/accept on behalf of Noir. Existing Cloudflare and security gates remain unchanged.

## Timing override — 2026-10-07

Noir offered continuous work with manual pause/restart instead of the fixed work/rest cycle, and the parent accepted. Continuous mode supersedes the old duty-cycle requirement below. Model roles and all resource/security/acceptance constraints are unchanged. Keep bounded subprocess invocations for recovery, but no mandatory five-hour rests. User can pause/resume through chat or service stop/start.


## User approval — 2026-10-07

Noir replied "I agree" to both recommended decisions:

1. Approve the demo acceptance-policy defaults recorded in the planning-cycle BLOCKED.md: explicitly blocking findings prevent acceptance; an independent authorized reviewer resolves them with applicable fresh evidence; repair authors cannot approve or resolve their own affected work; task/policy changes and final acceptance are human-only. Mandatory evidence covers legacy compatibility, pagination and malformed cursor handling, tenant isolation/cursor substitution, UI navigation/tenant switching, and independent combined-source review. No waiver of tenant-isolation failures or mandatory evidence. Demo pagination behavior follows the archived B1 defaults.
2. Authorize local-first Luna implementation while read-only Cloudflare preflight proceeds. Remote provisioning remains gated on verified existing Purdue Paid subscription/entitlement, conservative account-wide headroom and bounded ingress. This approval does not authorize plan upgrades, overages, other-account changes, existing deployment changes or relaxed security gates.

The initial planning pause record is preserved at reports/planning-blockers-resolved.md. Its remote gate remains active as a deployment-specific gate, not a global stop on local implementation. STATUS.md/NEXT.md historical planning notes are superseded by this decision for resumption.

Resume through the installed duty-cycle service only, after its persisted cooldown. Preserve the <=25-minute worker window and >=5-hour cooldown. Make useful routine implementation decisions without requesting another product review. New BIG pressing questions still require BLOCKED.md and a pause.
