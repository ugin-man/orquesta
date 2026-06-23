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

## Startup

When Orquesta is invoked in a repository:

1. Check for `.orquesta/CURRENT_ORCHESTRA.md`.
2. If it is missing, use `references/initial-setup.md`: make the calling chat the orchestrator foundation agent, rename it to `★ Orquesta 統括` and pin it when thread tools are available, create the state skeleton, create or reuse the foundation sessions, start or explain the dashboard at `http://127.0.0.1:4177/`, and present setup option packs before creating production specialists.
3. Check `.orquesta/setup/options.json` for bootstrap status. Resume incomplete setup from this file instead of creating duplicate foundation agents.
4. Check `.orquesta/state/agents.json`, `sessions.json`, `tasks.json`, `directives.json`, and `events.jsonl`.
5. If missing, create them from the schema in `references/state-schema.md`.
6. When Codex thread tools are available and the task concerns the dashboard, agents, threads, or live state, refresh `.orquesta/state/sessions.json` from the project thread list before claiming the visualizer reflects reality.
7. Read only the Orquesta state and the task-relevant project docs. Do not load every specialist document into the orchestrator context.
8. Use `references/orchestration-protocol.md` for the workflow.
9. Use `references/agent-contract.md` when appointing or steering a specialist thread.
10. Use `references/vision-alignment.md` when user taste, implicit vision, art direction, story tone, game feel, or creative ambiguity affects the work.
11. Use `references/failure-concierge.md` when command failures, permission errors, server startup failures, missing local dependencies, repeated retries, or quality-lowering fallbacks may require user-side action.
12. Use `references/user-liaison.md` when accepted user-facing asks need batching, sequencing, dashboard visibility, or a user-side task queue.

## Bootstrap Foundation

The first Orquesta invocation in a project should create this foundation before production planning:

- Current calling chat: `orchestrator`, title `★ Orquesta 統括`, pinned when possible.
- `user-liaison`: user-facing work queue and user-side ask coordination.
- `vision-curator`: event-driven vision question curation and answer interpretation.
- `error-concierge`: event-driven failure clustering and repair-card preparation.
- `orquesta-admin`: Orquesta setup, dashboard handoff, option packs, and configuration.

These foundation roles are allowed to exist immediately because they protect the operating system itself. Production specialists should still be created or awakened only after the user's actual task is classified.

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

The first setup response should include:
- what Orquesta can do in the project
- the dashboard URL
- enabled and available option packs
- the next setup choice the user can make

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

Do not keep a question-curation agent running continuously. Specialists may propose questions as they work, but `vision-curator` wakes only on triggers such as project kickoff, 10 or more uncurated questions, a high-priority question, a user request to answer questions, or a major direction change.

The responsibility split is:
- Specialist threads propose domain-specific questions.
- `vision-curator` merges, prioritizes, rewrites, and interprets question batches.
- The orchestrator accepts or rejects the curator's proposed updates, but does not independently interpret raw user answers into direction.
- Specialist threads read only adopted vision documents relevant to their role.

Store this layer under `.orquesta/vision/`. Raw answers are not adopted direction until the orchestrator reflects them into `profile.md`, `anti_vision.md`, `decisions.md`, or a specialist vision file.

Treat user answers as thinking seeds, not commands. Questions exist to help the user notice and refine ideas, including ideas they had not consciously formed yet. Unless the user explicitly marks an answer as a hard requirement, `vision-curator` should turn answers into discussion seeds, strong signals, candidate rules, counterproposals, and review-needed items before the orchestrator adopts anything as implementation direction.

## Failure Concierge

Orquesta treats repeated tool, environment, permission, and local runtime failures as project state, not disposable terminal noise. Use the Failure Concierge Layer when Codex hits a failure that might be solved faster or better by user-side action.

Do not keep an error-monitoring agent running continuously. Specialists and the orchestrator record incidents as they happen, but `error-concierge` wakes only on triggers such as repeated equivalent failures, permission or admin-rights denial, missing PATH or dependency setup, local server startup failure, a blocked task caused by environment state, or a proposed fallback that would reduce output quality.

The responsibility split is:
- Specialist threads and the orchestrator record concise failure incidents with evidence and attempted fixes.
- `error-concierge` clusters incidents, distinguishes Codex-fixable work from user-actionable environment work, and prepares repair cards for the user.
- The orchestrator accepts or rejects concierge reports, then routes Codex-fixable work to the right specialist or exposes user-actionable work in the dashboard/user task queue.
- Specialists should not silently keep retrying the same class of failure after a concierge wake trigger is met.

Store this layer under `.orquesta/failures/`. Raw logs stay as incidents; user-facing repair proposals belong in `user_actions.json` and concierge reports.

## User Liaison

Orquesta treats user-side work as a first-class queue. Use `user-liaison` when the orchestrator needs to ask the user for action, approval, clarification, prioritization, or a machine-side repair step.

`user-liaison` is the user-facing desk for Orquesta. It coordinates user-visible tasks from the orchestrator, `vision-curator`, and `error-concierge`, but it must not replace their specialist judgment:
- `vision-curator` owns raw answer interpretation and creative/taste synthesis.
- `error-concierge` owns failure clustering and repair-card proposal.
- `user-liaison` owns making accepted user-side work visible, sequenced, humane, and actionable.

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

If an existing specialist can do the work, reuse that thread. Create a new thread only when the role, context scope, or ownership boundary truly differs.

## State Rule

The source of truth is not chat history. The source of truth is:
- `.orquesta/state/agents.json`
- `.orquesta/state/sessions.json`
- `.orquesta/state/tasks.json`
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

Then open `http://127.0.0.1:4177/`. When served this way, the dashboard polls `.orquesta/state` every five seconds through `/api/state`. Opening `index.html` directly with `file://` still works, but requires manual state-file loading because browsers cannot automatically read local project files from a static page.

## References

- `references/orchestration-protocol.md`: full operating loop.
- `references/initial-setup.md`: first-run setup, Orquesta Admin, dashboard handoff, and option packs.
- `references/agent-contract.md`: appointment and report templates.
- `references/state-schema.md`: JSON state shape.
- `references/game-production-patterns.md`: default roles and context split for game development.
- `references/vision-alignment.md`: event-driven question curation and vision-document adoption.
- `references/failure-concierge.md`: event-driven failure logging, user-side repair cards, and fallback quality gates.
- `references/user-liaison.md`: user-side task queue, liaison boundaries, and coordination of vision/failure user asks.
