---
name: orquesta
description: Coordinate long-lived specialist Codex threads as an Orquesta production team. Use when the user wants multi-agent project management without disposable subagents, especially for game development, specialist thread appointment, context-scoped roles, user-to-specialist direct conversations, task state synchronization, dashboards, reports, blockers, approvals, and final orchestration summaries.
---

# Orquesta

Use Orquesta to coordinate a long-lived team of specialist Codex threads. Treat subagents as tactical helpers only. Treat normal Codex threads as production teammates with persistent roles, scoped context, task contracts, state reports, and synchronization back to the orchestrator.

## Core Principle

The user is not the orchestrator. The user is the originating creative authority. The orchestrator manages state, dependencies, blockers, and synthesis. Specialist threads hold domain context and may speak directly with the user when nuance matters.

Always preserve this split:
- Orchestrator: routing, contracts, state, acceptance, final reporting.
- Specialist thread: domain work, required reading, direct user refinement, report back.
- User: intent, taste, approval, final priority.

## Execution Policy and Delegation Gate

Classify a Phase 1.5 task once into `fast`, `standard`, or `critical` before implementation. Store the deterministic Execution Plan in canonical `.orquesta/state/tasks.json`, then run the Delegation Gate against that task's `canonical_state_root`, not a worktree snapshot.

- `fast` uses `inline_verified`: one owner or orchestrator, deterministic checks, no handoff and no review report. It is a normal Phase 1.5 route, not a legacy direct exception.
- `standard` uses one implementation owner and one independent review.
- `critical` uses one owner, up to two independent reviews, and optional QA when the semantic risk requires it.
- Review, correction, and QA are `execution_cycles` on the same task. Do not create `R`, `F`, or `RR` auxiliary task entries for a Phase 1.5 task.
- If the lane budget or meaning-level verification is no longer sufficient, escalate the same Execution Plan. Do not silently downgrade it.

Tasks without `execution_policy_version: 1` remain on the legacy gate. A legacy `direct_exception` still requires `direct_exception_reason` and is only for a genuine emergency or narrow orchestration work; it is not the normal fast route.

This rule survives context compaction by relying on canonical task state, not chat memory. Record the completed cycles, completion evidence, and token coverage as `unknown`, `partial`, or `complete`; do not claim a total when it is not measured.

## Phase 2A and 2B

Phase 2A and 2B extend the Phase 1.5 task policy with bounded acquisition, source-bound Audit, Codex-harness Audition, Codex-native execution, and one correlated acceptance chain.

The Codex harness is the runtime safety boundary. Orquesta does not add a second sandbox or a second command-approval system. It verifies that the requested Codex profile matches the approved roots and effects, and it stops when that evidence is missing.

- Acquisition queries official docs, registries, GitHub, and approved UI catalogs within fixed request and candidate budgets. Cache files are derived and never replace source evidence.
- Audit rejects hard-gate failures before scoring. Audition uses an exact candidate, Resolution, source hash, Codex profile, and cleanup plan.
- install authorization is separate from Audition and binds the candidate, version, source hash, dependency and lockfile previews, workspace, effects, and current review packet. Core has no install-execution command.
- Runtime order is App Server first, SDK fallback second, and repository-only last. Repository-only can prepare a handoff but cannot satisfy a live-turn acceptance check.
- Keep dispatch acceptance, turn start, progress, artifact, report, and acceptance as separate evidence. A dispatch response is not proof that a turn started.
- Keep requested, applied, and observed model evidence separate. `actual_model` stays null unless a runtime observation provides its evidence reference.

The current Workbench remains a Phase 1 review surface. Phase 2A and 2B add no desktop, web, or application shell; productization requires a separate user decision.

## Startup

When Orquesta is invoked in a repository:

1. Check for `.orquesta/CURRENT_ORCHESTRA.md`.
2. If it is missing, use `references/initial-setup.md`: make the calling chat the orchestrator, create or reuse the three-agent foundation, collect the project folder, name, and description, then derive the first executable work and its specialists. Setup questions are optional and option packs are not a first-run gate.
3. Check `.orquesta/setup/options.json` for bootstrap status. Resume incomplete setup from this file instead of creating duplicate foundation agents.
4. Check `.orquesta/state/agents.json`, `sessions.json`, `tasks.json`, `directives.json`, and `events.jsonl`.
5. If missing, create them from the schema in `references/state-schema.md`.
6. Run or refresh the foundation trigger audit (`npm run audit:triggers` or `node orquesta/scripts/foundation-trigger-audit.js`) and read `.orquesta/state/trigger_audit.json` before routing new Orquesta work. This distinguishes event-driven standby from neglected trigger-ready work.
7. When Codex thread tools are available and the task concerns the dashboard, agents, threads, or live state, refresh `.orquesta/state/sessions.json` from the project thread list before claiming the visualizer reflects reality.
8. Read only the Orquesta state and the task-relevant project docs. Do not load every specialist document into the orchestrator context.
9. Use `references/orchestration-protocol.md` for the workflow.
10. Use `references/agent-contract.md` when appointing or steering a specialist thread.
11. Use `references/user-support.md` when user taste, questions, tacit knowledge, repeated failures, approval waits, or user-side work need one coordinated route. The older vision, failure-concierge, and liaison documents are migration references only.

## Bootstrap Foundation

The first Orquesta invocation in a project should create this foundation before production planning:

- Current calling chat: `orchestrator`, title `★ Orquesta 統括`, pinned when possible.
- `user-support`: event-driven question curation, answer interpretation, failure triage, and user-side task coordination.
- `orquesta-admin`: Orquesta setup, dashboard handoff, option packs, and configuration.

These three foundation agents are registered immediately. Production specialists are derived from the first executable work; do not create a minimum or fixed roster. `bootstrap-qa` is a normal conditional specialist, never a foundation agent.

Use ASCII-only machine IDs for foundation agents. Star marks and Japanese labels belong in human-visible thread titles and dashboard display names only, not in JSON keys, file names, or agent IDs. Existing projects that already use `*-001` foundation IDs may keep them until a deliberate migration updates state and dashboard code together.

## Thread Model

Use long-lived Codex threads for specialists when:
- The role needs durable context over many sessions.
- The user benefits from talking directly to that specialist.
- A skill or workflow should not run in a subagent.
- The work is creative, visual, narrative, or game-production heavy.
- The role needs a scoped set of docs, not the whole project context.

Use subagents only for bounded, short-lived, read-heavy helper work such as exploration, triage, log review, or independent checks.

## Orquesta Admin

Every new Orquesta project should include `orquesta-admin` during bootstrap.

This role manages Orquesta itself: first-run setup, dashboard handoff, option-pack explanation, feature toggles, and Orquesta tuning. It is not the production orchestrator and should not own product implementation, story, art, QA, or raw user answer interpretation.

The first setup experience should include:
- what Orquesta can do in the project
- the dashboard URL
- the selected project folder, project name, and project description
- zero to three optional clarification questions only when the evidence is insufficient
- a six-phase progress view backed by real setup state
- the generated first executable work, initial organization, and provisioning result

## Direct User Conversations

The user may talk directly to a specialist thread. This is a feature, not a bypass.

When a specialist receives direct user guidance:

1. Preserve the nuance in `user_directives`.
2. Record what changed.
3. Record what needs orchestrator review.
4. Update `.orquesta/state/directives.json` or write a report under `.orquesta/reports/`.
5. Make the change visible to the orchestrator before claiming project-level completion.

## Vision Alignment

Orquesta treats the user's unspoken creative vision as project state. Use the Vision Alignment Layer when the work depends on taste, aesthetics, game feel, tone, world fantasy, or repeated "not like that" feedback.

Do not keep the support agent running continuously. Specialists may propose questions as they work, but `user-support` wakes only on meaningful question, repeated-failure, or user-task triggers.

The responsibility split is:
- Specialist threads propose domain-specific questions.
- `user-support` merges, prioritizes, rewrites, and interprets question batches.
- The orchestrator accepts or rejects the curator's proposed updates, but does not independently interpret raw user answers into direction.
- Specialist threads read only adopted vision documents relevant to their role.

Store this layer under `.orquesta/vision/`. Raw answers are not adopted direction until the orchestrator reflects them into `profile.md`, `anti_vision.md`, `decisions.md`, or a specialist vision file.

Treat user answers as thinking seeds, not commands. Unless the user explicitly marks an answer as a hard requirement, `user-support` turns answers into discussion seeds, strong signals, candidate rules, counterproposals, and review-needed items before the orchestrator adopts anything as implementation direction.

## Failure Concierge

Orquesta treats repeated tool, environment, permission, and local runtime failures as project state, not disposable terminal noise. Use the Failure Concierge Layer when Codex hits a failure that might be solved faster or better by user-side action.

Do not keep an error-monitoring agent running continuously. Specialists and the orchestrator record incidents as they happen, but `user-support` wakes when repeated equivalent failures, environment blockers, or a quality-lowering fallback may need user knowledge or action.

The responsibility split is:
- Specialist threads and the orchestrator record concise failure incidents with evidence and attempted fixes.
- `user-support` clusters incidents, distinguishes Codex-fixable work from user-actionable environment work, and prepares repair cards for the user.
- The orchestrator accepts or rejects concierge reports, then routes Codex-fixable work to the right specialist or exposes user-actionable work in the dashboard/user task queue.
- Specialists should not silently keep retrying the same class of failure after a concierge wake trigger is met.

Store this layer under `.orquesta/failures/`. Raw logs stay as incidents; user-facing repair proposals belong in `user_actions.json` and concierge reports.

## User Support

Orquesta treats user-side work as a first-class queue. Use `user-support` when the orchestrator needs to ask the user for action, approval, clarification, prioritization, or a machine-side repair step.

`user-support` is the single user-facing support desk. It owns question curation, raw answer interpretation, failure clustering, repair-card proposals, and making accepted user-side work visible and actionable. These responsibilities are one long-lived role, not three separately generated agents.

When a specialist is blocked by a Codex approval prompt, permission request, scope confirmation, destructive-action confirmation, or user-direction decision, create or update a `.orquesta/user_tasks/queue.json` task with `source: "approval_wait"`, an `approval_type`, the waiting `source_agent_id`, the blocked task id in `source_ids`, the requested user action, and the resume instruction. Also mark the blocked Orquesta task with a user approval blocker such as `blocked_by: ["user_approval_required"]`. Do not let approval waits live only inside a specialist chat.

Store this layer under `.orquesta/user_tasks/`. Keep user tasks short, statused, and dashboard-visible.

## Appointment Rule

Before creating or steering a specialist thread, define:
- `role`
- `mission`
- `required_reading`
- `excluded_context`
- `allowed_files`
- `forbidden_actions`
- `acceptance_checks`
- `done_signal`
- `requires_user_approval`

If an existing specialist can do the work, reuse that thread. The organization preflight may autonomously split a task, add a member, add a role, assign a lead, or permanently transfer an agent between existing lines. Creating a new line is the only Orquesta organization change that requires product-level user approval. Codex harness approvals remain separate and are never bypassed. Temporary cross-line assignments are forbidden.

## State Rule

The source of truth is not chat history. The source of truth is:
- `.orquesta/state/agents.json`
- `.orquesta/state/sessions.json`
- `.orquesta/state/tasks.json`
- `.orquesta/state/trigger_audit.json`
- `.orquesta/state/directives.json`
- `.orquesta/state/events.jsonl`
- `.orquesta/failures/incidents.json`
- `.orquesta/failures/user_actions.json`
- `.orquesta/user_tasks/queue.json`
- `.orquesta/setup/options.json`
- `.orquesta/setup/wizard.json`
- `.orquesta/setup/project_intake.json`
- `.orquesta/project/completion_map.json`
- `.orquesta/CURRENT_ORCHESTRA.md`
- `.orquesta/reports/*.md`

For specialist-domain tasks, `.orquesta/state/tasks.json` must preserve delegation evidence: `routing_class`, `routing_gate_status`, `handoff_required`, `handoff_sent_at`, `specialist_report_required`, `specialist_report_path`, `direct_exception_reason`, and `bypass_review_owner`. A specialist-required task should not become `accepted` until the specialist report path or artifact is recorded, unless a direct-work exception is recorded with a review owner.

Keep reports short. Link artifacts instead of copying large outputs into the orchestrator conversation.

When writing user-visible non-English text into `.orquesta` state, protect encoding explicitly. Prefer `apply_patch`, UTF-8-aware script files, or Unicode-escaped JavaScript literals over shell here-strings. Run `npm run check:encoding` when available after state writes. Repeated literal question marks such as `???` in `.orquesta` JSON are a failure, not a harmless display issue.

## Dashboard

The bundled dashboard lives at `assets/dashboard/index.html`. It is a static inspection tool for Orquesta state. Use it to view:
- agent roster
- first-run setup wizard and project intake
- completion map
- task board
- blockers
- pending approvals
- stale agents
- direct user directives
- artifacts and reports

For live browser monitoring, run the repository dashboard server from the workspace root:

```bash
npm run dashboard
```

Then open the dashboard URL printed by the server. When served this way, the dashboard checks `.orquesta/state` through `/api/state`; unchanged state returns `304 Not Modified` and does not trigger a full re-render. Opening `index.html` directly with `file://` still works, but requires manual state-file loading because browsers cannot automatically read local project files from a static page.

## References

- `references/orchestration-protocol.md`: full operating loop.
- `references/initial-setup.md`: first-run setup, Orquesta Admin, dashboard handoff, and option packs.
- `references/agent-contract.md`: appointment and report templates.
- `references/state-schema.md`: JSON state shape.
- `references/game-production-patterns.md`: default roles and context split for game development.
- `references/vision-alignment.md`: event-driven question curation and vision-document adoption.
- `references/failure-concierge.md`: event-driven failure logging, user-side repair cards, and fallback quality gates.
- `references/user-liaison.md`: user-side task queue, liaison boundaries, and coordination of vision/failure user asks.
