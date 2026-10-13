# Product: a shared workspace for agents pursuing a task in parallel

**Status:** Revised product draft incorporating Astra's review. Working vocabulary, not final branding. Product defaults below remain subject to approval.

This document defines the desired human and agent experience and the first demonstrable product. It does not choose an architecture, storage schema, merge algorithm, agent framework, or execution platform. Requirements describe intended behavior, not capabilities already implemented.

## 1. Product promise

> Give agents a shared task to pursue in parallel, a place to coordinate their work, and a guarded path to a human-accepted result.

The human delegates an outcome, not a queue of individual patches. Agents can discover related work, share assumptions, write and review code concurrently, and respond to findings without requiring the human to carry messages between them.

The human remains in charge of intent and final acceptance. Their attention should go to consequential questions and decisions, not routine handoffs or reconstructing agent transcripts.

Views, exact revisions, and trustworthy evidence support this experience. They are not the main product promise.

## 2. The future we are designing for

When agents are inexpensive enough to run in groups, parallel code generation is no longer the only challenge. A group can produce more work while duplicating effort, drifting from the task, relying on incompatible assumptions, or approving the same mistake.

The platform should make useful parallel participation easy: agents can see what is already happening, coordinate interfaces before integration, publish attributable work, and discover what needs action next. Routine work should not have to pass through one human coordinator.

Our hypothesis is that shared task context and an explicit collaboration loop can reduce coordination effort while preserving independent progress. The initial prototype tests that hypothesis with a small concurrent group. It does not establish thousand-agent scalability or general productivity gains.

## 3. Who it is for

**Task owner:** a human defining an outcome and its constraints. Wants to launch a bounded group, answer material ambiguities, and decide whether to accept the result without supervising every exchange.

**Contributor agent:** writes code or tests. Needs to discover available work, collaborators, current assumptions, and feedback; publish progress; and continue independently when other work changes.

**Reviewer agent:** evaluates actual contributions and combined behavior against the task. Needs inspectable source, evidence, and a way to publish actionable findings rather than merely approve another agent's claim.

**Maintainer:** the human authorized to accept code into the shared baseline. May also be the task owner. Needs a clear acceptance decision with exact inputs, current evidence, and unresolved risks.

Humans and scripts can use the same collaboration concepts. The default journey and first demonstration are deliberately agent-first. The product is not tied to one agent runtime.

## 4. What users should feel

### The human

- **Able to delegate:** I can describe the outcome and constraints without managing each patch.
- **Informed, not flooded:** I see meaningful progress, blockers, and decisions that need me—not an undifferentiated stream of messages.
- **In control:** agents cannot quietly weaken the task or accept their own work into the baseline.
- **Confident about the decision:** I can understand what the proposed result delivers, what was checked, and what remains uncertain.

### The agent

- **Oriented:** I can find the current task, available work, collaborators, and decisions relevant to my contribution.
- **Able to coordinate:** I can publish an assumption, question, or finding and retrieve a response without off-platform message relay.
- **Free to progress:** another agent's work does not overwrite mine or force every contributor to stop for an unrelated issue.
- **Able to act:** feedback identifies the violated requirement, affected work, and next owner.

The main human experience is task progress and decisions. Detailed contributions, evidence, source review, and history remain accessible underneath it.

## 5. Working vocabulary

**Task contract:** a persistent, versioned description of the desired outcome, constraints, acceptance examples, and unresolved questions. It can use prose and examples; it is not a formal proof specification.

**Work claim:** a visible statement that a contributor is pursuing part of the task. It identifies an owner and status. Claims expose overlap; they do not provide exclusive ownership of code or guarantee duplicate work will not occur.

**Shared decision:** an attributable agreement or unresolved question about behavior, interfaces, or assumptions. Relevant contributors can find it, reference it, and see later changes.

**Change:** a recognizable contribution linked to the task obligations it addresses, with an owner and revisions. Its discussion remains discoverable as the implementation evolves.

**View:** a named, runnable candidate containing selected Change revisions against a particular baseline. Creating or trying it does not accept its contents.

**Finding:** actionable feedback tied to a task obligation and affected work or candidate. It has a next owner and a resolution status; a blocking finding prevents acceptance until authorized resolution.

**Evidence:** recorded checks, review findings, and approvals associated with exact work and relevant task requirements. An agent's statement that a check passed is distinguishable from a recorded check execution.

**Baseline:** the code the team has explicitly accepted. Experimentation does not change it.

These are product concepts, not a prescribed technical schema or final UI terminology.

## 6. The core journey

### A. Define an outcome and launch a bounded group

The human creates a task contract describing what should change, what must remain true, and examples of an acceptable result. Ambiguities can remain explicit rather than being hidden behind apparently precise instructions.

For the first product, the human approves a small initial division of work and launches the agents using a compatible runtime. Automatic planning is not required. The task and decisions remain shared platform context, not information available only in each agent's private prompt.

### B. Discover work and coordinate before finishing code

An agent retrieves the current contract, work claims, published assumptions, and unresolved questions. It can claim available work, contact a relevant contributor through shared context, or identify overlap.

Overlapping claims require acknowledgement: contributors choose to coordinate, divide the work, or mark intentional alternatives. The platform makes the overlap visible; it does not automatically infer that two descriptions are semantically identical.

Agents can publish an intended interface or behavior before completing its implementation. Other agents can question it and record an agreement. Material ambiguity or a proposed change to the task's constraints is escalated to the human. Silence is not agreement.

### C. Develop and share progress in parallel

Contributors work independently and publish Changes connected to the obligations and decisions they address. Others can inspect the owner, revision, dependencies, and readiness of that work.

The human can distinguish work in progress, waiting for a collaborator, needing a decision, and ready for review. Activity alone is not presented as task completion.

One contributor's edits must not overwrite another's ongoing work. Isolation prevents accidental workspace interference; shared assumptions and findings address coordination. Neither substitutes for the other.

### D. Try the combined result

A contributor creates a View from selected Changes. The product explains the exact revisions, baseline, declared dependencies, and excluded work. The combined source can be inspected and obtained as a working copy for development or evaluation.

If the work cannot be combined, the product reports the failure rather than presenting a partial candidate or silently substituting revisions. Creating a View leaves constituent work and the baseline untouched.

### E. Review, discover interactions, and repair

Reviewers inspect contributions and combined behavior against the contract. Their findings can identify a missed obligation, incompatible assumption, security concern, or failing integration check.

A useful finding includes the affected candidate or revision, relevant requirement, supporting evidence or reproducer, and next owner. Agents can retrieve findings and respond with linked repairs without the human copying messages between sessions.

An interaction may fail despite isolated checks passing. The repair can revise a Change or be separately identified integration work; its author and discussion remain visible. Unrelated development can continue while the blocker is addressed.

The initial product supports explicit dependencies and assigned ownership. It does not promise automatic diagnosis, complete dependency discovery, or automatic settlement of semantic disagreements.

### F. Stay aligned as code and requirements evolve

When a dependency advances, a contributor sees that an update is available while their current View remains unchanged. They can keep the existing experiment or explicitly adopt an updated candidate. Ongoing work and earlier candidates remain accessible; local edits are not silently discarded.

Baseline changes follow the same principle. Task-contract changes require human approval and make prior readiness subject to reconsideration, even if the code itself has not changed. An agent may propose a change to requirements but cannot authorize it alone.

Historical checks and discussions remain available. They must not appear to validate changed source or changed requirements. For the initial product, changed candidates or contracts require fresh applicable candidate-level validation and confirmation; intelligent approval reuse is deferred.

### G. Present one decision and accept deliberately

The human sees what the task required, what the candidate delivers, the included Changes, required checks and reviews, uncovered obligations, outstanding findings, and unresolved risks. They can inspect source and logs, request further work, reject, or accept.

Acceptance is refused if required evidence is missing or inapplicable, a blocking finding remains unresolved, the target baseline or contract is outdated, or the actor lacks acceptance authority. Reporting a blocker is not enough: the product must enforce the refusal.

Final acceptance requires an authorized human and incorporates the exact selected result into the baseline. If its inputs change before completion, acceptance stops for a new decision. Publication, reviewer approval, acceptance, and deployment are distinct actions. Unselected work and experiments remain available.

These guards reduce known risks. Passing tests and agreement among agents cannot guarantee the absence of unknown defects or misunderstood requirements.

## 7. Responsibility boundaries

**Platform:** retains the contract and shared decisions; exposes work, ownership, and feedback to agents; preserves contributions and candidate identity; records evidence provenance; presents task readiness; and enforces acceptance rules and authority.

**Agent runtime/orchestrator:** launches and stops agents, provides execution and tools, allocates budgets, and schedules or retries work. It must not be the only place where usable collaboration context exists.

**Agents:** reason about the task, propose work divisions, write code and tests, negotiate assumptions, review results, and repair findings using the shared platform context.

**Human:** owns intent, approves material contract changes, resolves consequential ambiguity, and authorizes final acceptance. Authorized reviewers may resolve findings according to explicit project rules; the repair author cannot silently erase a blocking finding.

API versus CLI, polling versus notifications, scheduling, storage, and execution arrangements belong in the technical plan.

## 8. First demonstration

Use a small real service with this task:

> Add cursor pagination to the project list and its UI; preserve existing clients; never expose another tenant's projects.

A bounded group develops the API, UI, and adversarial checks concurrently. A reviewer evaluates the combined result. The demonstration must show:

1. A shared contract and visible work claims guiding participation.
2. An API assumption discovered and questioned by the UI contributor, followed by a recorded agreement without human message relay.
3. Independent contributions becoming a runnable candidate.
4. A cross-component behavioral failure becoming an actionable blocking finding with a repair owner.
5. The responsible agent retrieving the finding, publishing a repair, and obtaining renewed evaluation while another contributor continues an older experiment.
6. An attempted acceptance being refused for the demonstrated blocker or missing current evidence.
7. A human inspecting and accepting the exact evaluated result after authorized blocker resolution.

Task division, agent launch, dependencies, and prepared test conditions may be manual, but must be disclosed. Source composition, agent context exchange, checks, repair feedback, and guarded acceptance must actually run. The demonstration should introduce a revision that exercises update handling rather than only replay a prepared dashboard.

Comparing alternative implementations is optional. It must not crowd out the essential coordination loop.

## 9. Required first-product outcomes

- A human can define a persistent task contract and approve updates to it.
- Agents can discover work claims, contributors, shared assumptions, decisions, and relevant feedback.
- Agents can coordinate one meaningful interaction and respond to a finding without human message relay.
- Contributors can publish attributable revisions and create exact, runnable Views.
- Existing experiments survive dependency and baseline updates.
- Readiness connects task obligations to evidence and unresolved findings, not just check status or agent activity.
- Known blockers, missing applicable evidence, outdated inputs, and unauthorized acceptance actually prevent baseline changes.
- The human receives an understandable final decision with access to its underlying work and evidence.

Graphs, agent avatars, candidate rankings, and chat transcript playback are optional presentation—not success criteria.

## 10. Non-goals

- A new VCS or full replacement for GitHub.
- Autonomous task decomposition or inferred dependency graphs.
- Exhaustive candidate search or automated resolution of product tradeoffs.
- Proof of arbitrary program correctness or reliable autonomous acceptance.
- Intelligent reuse of approvals across changed candidates.
- Thousand-agent scale claims from a small demonstration.
- Full enterprise policy management, deployment automation, or a new agent runtime.

Parallelism is a design requirement for the demonstrated collaboration, not an unverified throughput claim. Only the affected work should require coordination; every contribution must not wait on a human-mediated handoff.

## 11. How we judge success

The demo passes only if agents complete an actual coordination-and-repair loop through the platform, unrelated work can progress concurrently, old experiments survive updates, and guarded acceptance behaves as specified.

A person unfamiliar with the scenario should be able to explain the task, current blocker or next owner, proposed outcome, applicable evidence, and acceptance consequences without an oral reconstruction of agent transcripts.

An agent should be able to retrieve enough shared context to find its collaborator and next action without the human forwarding private messages. Required information and responses must be usable by agents, not visible only on a human dashboard.

Compare against a competent baseline using isolated working copies, task instructions, agent review, integration branches, and equivalent tests. Record human relay steps, manual coordination interventions, effort reconstructing state, and failed acceptance attempts caught. A working demo verifies functional behavior; productivity and broad scalability remain hypotheses until measured.

## 12. Proposed product defaults and remaining decisions

Defaults for this draft:

- Human-approved task-contract changes and human-only final acceptance.
- Visible, non-exclusive work claims with explicit acknowledgement of known overlap.
- Contributors can create Views; adopting updates is deliberate.
- Changed candidates or contracts require fresh applicable validation.
- Findings have explicit owners; blocking findings require authorized reviewer resolution.

Before technical design, finalize which findings block acceptance, who may resolve them, and the required checks and reviews for the demonstration task. These are bounded product decisions, not a reason to reopen broad ideation.

## 13. Competition boundary and differentiation

The submission must use Cloudflare Workers and Artifacts and demonstrate concurrent agents. Implementation choices and sequencing belong in a separate technical plan once this experience is agreed.

The product does not claim to have invented tasks, composable changes, Views, or evidence tracking. Its differentiation must be demonstrated in agents coordinating toward a semantic outcome through shared context, while a human retains an understandable, guarded acceptance decision. A graph of prepared changes or a CI dashboard alone does not establish that distinction.
