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

Every specialist report must include structured `question_candidates` metadata. Submit 0-3 useful candidates that would clarify user intent, future plans, quality risk, design direction, or task scope. Do not ask the user directly unless the handoff explicitly says to; `vision-curator` curates raw candidates into useful user-facing batches.

If there are no useful candidates, set `status: "none"` and provide a valid `none_reason` plus a one-sentence rationale. This prevents forced garbage questions while proving the specialist considered whether the task exposed useful ambiguity.

Valid `none_reason` values:

- `purely_mechanical_change`
- `no_new_user_choice`
- `already_covered_by_existing_question`
- `duplicate_or_low_value`
- `report_only_readiness_no_new_ambiguity`
- `blocked_before_domain_insight`
- `emergency_or_recovery_no_question_yet`

Candidate items must include `priority`, `category`, `question`, `why_now`, `user_impact`, `suggested_timing`, and the source task.

## Control Evidence Policy

For staged-in `specialist_required` and medium/high-risk work, include a valid `completion_envelope` JSON block in the report. It must match the task delegation evidence and list changed files, checks, explicit gaps, fallbacks, and model-route evidence.

Keep `recommended_model`, `requested_model`, `applied_model`, and `actual_model` separate. A requested override is not an applied model, and no actual-model value may be claimed without independent evidence. In repository-only mode, record `adapter: "repository_only"`, `applied_model: null`, and `actual_model: null` unless later evidence proves otherwise.

When a task needs user capability evidence, state the exact evidence gap and stop the affected verification. Ask `user-liaison` for a narrow procedure only when visual review, tacit judgment, credentialed judgment, or direct user experience is the stronger source. Do not use this route as a generic request for the user to do specialist work.

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

## Completion Envelope

Include one valid `completion_envelope` JSON block. For report-only work with no command checks, state why the changes are all `report_only`. Include any fallback and its approval state. Missing or invalid envelope metadata blocks staged-in acceptance.

## Question Candidates

Include exactly one structured block:

```json
{
  "question_candidates": {
    "status": "submitted",
    "items": [
      {
        "priority": "low | medium | high",
        "category": "scope | design | workflow | quality | risk | roadmap | user_preference | technical_direction | release | other",
        "question": "Short user-facing question candidate.",
        "why_now": "Why this arose from the current task.",
        "user_impact": "What user decision, risk, or future work this could improve.",
        "suggested_timing": "now | before_next_task | before_acceptance | batch_later | roadmap_review",
        "source_task_id": "<task-id>",
        "source_agent_id": "<agent-id>",
        "source_report_path": ".orquesta/reports/<task-id>-<agent-id>.md"
      }
    ]
  }
}
```

If no useful candidate exists, use:

```json
{
  "question_candidates": {
    "status": "none",
    "none_reason": "purely_mechanical_change",
    "none_rationale": "This task introduced no new user choice, ambiguity, risk, or future planning question."
  }
}
```

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
