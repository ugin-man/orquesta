# Agent Contract Templates

Use these templates when appointing, steering, or receiving reports from specialist Codex threads.

## Appointment Contract

```md
# Orquesta Appointment

agent_id:
role:
mission:
workspace_path:
thread_policy: long_lived_specialist

## Required Reading

- 

## Excluded Context

- 

## Allowed Files

- 

## Forbidden Actions

- 

## Current Task

task_id:
title:
acceptance_checks:
- 

## User Direct Conversation Policy

You may speak directly with the user about this role's domain. Preserve nuance. When direct user guidance changes direction, write `user_directives`, `changed`, and `needs_orchestrator_review` into the report or Orquesta state.

## Vision Question Policy

If the task exposes user-taste ambiguity, propose 0-3 questions. Do not ask everything immediately. Mark whether each question is `low`, `medium`, or `high` priority and why it matters.

## Done Signal

Write a report to `.orquesta/reports/<task-id>-<agent-id>.md` using the report template.
```

## Orquesta Admin Appointment Template

Use this as one of the foundation sessions created during bootstrap. The calling chat is the first orchestrator; this role is the settings and setup specialist.

```md
# Orquesta Appointment

agent_id: orquesta-admin
role: orquesta-admin
mission: Manage Orquesta itself for this project: first-run setup, dashboard handoff, option packs, feature toggles, and Orquesta tuning.
workspace_path:
thread_policy: long_lived_specialist

## Required Reading

- .agents/skills/orquesta/SKILL.md
- orquesta/references/initial-setup.md
- orquesta/references/state-schema.md
- .orquesta/setup/options.json
- .orquesta/CURRENT_ORCHESTRA.md
- .orquesta/state/agents.json
- .orquesta/state/sessions.json
- .orquesta/state/tasks.json

## Excluded Context

- Product implementation details unless the user is tuning Orquesta around them.
- Full art, lore, QA, or production docs unless setup options require a narrow check.
- Raw vision answers and raw failure incidents.

## Allowed Files

- .orquesta/setup/**
- .orquesta/state/**
- .orquesta/reports/**
- .orquesta/CURRENT_ORCHESTRA.md

## Forbidden Actions

- Do not become the production orchestrator.
- Do not implement product features.
- Do not interpret raw vision answers.
- Do not turn raw failures into repair cards.
- Do not create specialist threads without user approval or setup policy.

## Current Task

task_id: SETUP001
title: Orient the user and configure initial Orquesta options.
acceptance_checks:
- Dashboard URL is shown or dashboard startup blocker is recorded.
- Available option packs are listed.
- Enabled option packs are recorded in `.orquesta/setup/options.json`.
- Next setup action is clear.

## Done Signal

Write a short setup report to `.orquesta/reports/SETUP001-orquesta-admin.md` and wait.
```

## Report Template

```md
# Agent Report

task_id:
agent_id:
status: completed | blocked | needs_review | rejected_scope

## User Directives

- 

## Changed

- 

## Verified

- 

## Not Verified

- 

## Blockers

- 

## Artifacts

- 

## Needs Orchestrator Review

- 

## Question Candidates

- 

## Handoff

- 
```

## Vision Curator Report Template

```md
# Vision Curator Report

task_id:
agent_id: vision-curator
status: completed | blocked | needs_review

## Input

- questions:
- answer_batches:

## Curated Questions

- 

## Answer Interpretation

- 

## Proposed Adopted Updates

- profile:
- anti_vision:
- decisions:
- specialists/visual:
- specialists/world:
- specialists/gameplay:
- specialists/ui:
- specialists/technical:

## Conflicts Or Ambiguities

- 

## Needs Orchestrator Decision

- 
```

## Scope Drift Rejection

Use this when a specialist stepped outside contract:

```md
# Scope Drift Notice

agent_id:
task_id:
status: rejected_scope_drift

## Contract Boundary

## Drift Observed

## Required Correction

## User Decision Needed
```
