# Agent Contract Templates

Use these templates when appointing, steering, or receiving reports from specialist Codex threads.

## Appointment Contract

```md
# Orquesta Appointment

agent_id:
role:
thread_title:
mission:
workspace_path:
thread_policy: long_lived_specialist

## Required Reading

- (add entries when applicable)

## Excluded Context

- (add entries when applicable)

## Allowed Files

- (add entries when applicable)

## Forbidden Actions

- (add entries when applicable)

## Current Task

task_id:
title:
completion_transport: wait_threads | compact_receipt | manual_recovery
orchestrator_thread_id:
orchestrator_host_id:
specialist_report_required: true | false
acceptance_checks:
- (add entries when applicable)

## User Direct Conversation Policy

You may speak directly with the user about this role's domain. Preserve nuance. When direct user guidance changes direction, write `user_directives`, `changed`, and `needs_orchestrator_review` into the report or Orquesta state.

## Vision Question Policy

Include structured `question_candidates` metadata only when the task exposes a useful candidate or the handoff explicitly requests it. Submit 0-3 useful candidates that would clarify user intent, future plans, quality risk, design direction, or task scope. Do not ask the user directly unless the handoff explicitly says to; `user-support` curates raw candidates into useful user-facing batches. Omission by itself is not an acceptance failure.

A candidate is useful only when the answer could change direction or acceptance, prevent costly rework, resolve a non-inferable choice, or preserve a recurring preference or contradiction. Do not submit a candidate when repository inspection, live research, or a cheap reversible test can answer it. This is a relevance test, not a requirement to manufacture questions.

If the handoff requires a question decision and there are no useful candidates, set `status: "none"` and provide a valid `none_reason` plus a one-sentence rationale. Otherwise omit the field rather than proving that the specialist considered it.

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

For staged-in `specialist_required` and medium/high-risk work, prefer one compact `specialist_result` JSON block containing task and agent IDs, `changes[]` with `path`, `kind`, and `summary`, `verification[]` with `command`, `status`, `expected`, and `evidence`, explicit gaps, and risks. Include `question_candidates` only under the policy above. The specialist must not reconstruct handoff, model, task-state, or audit evidence. The deterministic acceptance controller expands the compact result into a valid `completion_envelope` and adds those controller-owned facts. Existing valid `completion_envelope` blocks remain supported for compatibility.

Keep `recommended_model`, `requested_model`, `applied_model`, and `actual_model` separate. A requested override is not an applied model, and no actual-model value may be claimed without independent evidence. In repository-only mode, record `adapter: "repository_only"`, `applied_model: null`, and `actual_model: null` unless later evidence proves otherwise.

## Phase 2 runtime contract

For Phase 2 work, a specialist receives only the current TaskIntent, Resolution, Context Pack, source evidence, permitted effects, and acceptance checks needed for that role. It must not load unrelated specialist context.

- Acquisition and Audit return source refs, hashes, freshness, facts, and explicit unknowns.
- Audition runs through the approved Codex profile and returns preflight, step, side-effect, and cleanup evidence. It does not imply install authorization.
- The App Server adapter is primary when its pinned bundled runtime is available. The SDK is the live fallback. repository-only mode can draft a handoff but cannot claim a started or completed turn.
- A runtime report distinguishes dispatch acceptance, turn start, progress, completion, artifact, and acceptance. It never treats dispatch as started work.
- `actual_model` remains null unless a model-observation event or an approved observation hook supplies the evidence reference. Requested or applied configuration is not enough.
- Large response bodies stay outside the Event Journal. Store refs, hashes, correlation IDs, and bounded current projections instead.

When a task needs user capability evidence, state the exact evidence gap and stop the affected verification. Ask `user-support` for a narrow procedure only when visual review, tacit judgment, credentialed judgment, or direct user experience is the stronger source. Do not use this route as a generic request for the user to do specialist work.

Architecture judgment remains the orchestrator's responsibility. Do not require a specialist to produce a separate reframe checklist, status, or report. When a handoff uses a newly chosen approach, state it through the normal mission, constraints, required reading, forbidden actions, or acceptance checks. If implementation evidence contradicts that framing, the specialist may report the evidence and pause for a revised handoff without being treated as scope drift.

## Done Signal

1. If `specialist_report_required` is not `false`, write a report to `.orquesta/reports/<task-id>-<agent-id>.md` using the report template. For an explicit report-free task, the handoff must name `wait_threads` or `manual_recovery`, an exact done signal, and any task-owned evidence refs required for recovery. Return only that assigned result.
2. Persist any task-owned completion evidence required by the handoff before signaling.
3. If `completion_transport` is `wait_threads`, do not send a separate completion chat message.
4. If `completion_transport` is `compact_receipt`, use `send_message_to_thread` once with the supplied orchestrator thread and optional host. Send the receipt only when a report path was assigned:

<orquesta_completion_receipt version="1">
  <task_id><task-id></task_id>
  <agent_id><agent-id></agent_id>
  <report_path>.orquesta/reports/<task-id>-<agent-id>.md</report_path>
  <receipt_id><task-id>:<agent-id>:<report-produced-at></receipt_id>
</orquesta_completion_receipt>

Do not paste report content into the message. A receipt wakes the orchestrator but does not prove completion. If the same receipt was already sent, do not send it again.
```

## Orquesta Admin Foundation Contract

Use this only to describe the durable `orquesta-admin` Foundation role. `project.bootstrap` creates and binds it; an agent must not recreate its canonical records from this example.

```md
# Orquesta Appointment

agent_id: orquesta-admin
role: orquesta-admin
mission: Diagnose and repair Orquesta configuration, runtime binding, Desktop integration, and controller health without becoming the product orchestrator.
workspace_path:
thread_policy: long_lived_specialist

## Required Reading

- .agents/skills/orquesta/SKILL.md
- orquesta/references/project-bootstrap.md
- orquesta/references/state-schema.md
- .orquesta/CURRENT_ORCHESTRA.md
- current task-owned runtime and controller evidence

## Excluded Context

- Product implementation details unless the user is tuning Orquesta around them.
- Full art, lore, QA, or production docs unless a bounded repair needs a narrow check.
- Raw vision answers and raw failure incidents.

## Allowed Files

- task-owned diagnostic and report paths named in the handoff
- Orquesta product files explicitly assigned for repair

## Forbidden Actions

- Do not become the production orchestrator.
- Do not implement product features.
- Do not interpret raw vision answers.
- Do not turn raw failures into repair cards.
- Do not patch OrganizationStore, TaskPort, SessionBindingStore, or project bootstrap files directly.
- Do not invoke legacy Setup, organization-decision, migration, or session registry writers.

## Current Task

task_id: <assigned-repair-task>
title: Diagnose and repair the assigned Orquesta control-plane fault.
acceptance_checks:
- The root cause and affected authority are identified.
- The smallest valid repair path is implemented or the exact blocker is recorded.
- Focused regression evidence and any remaining risk are reported.

## Done Signal

Write the assigned specialist report and return its configured done signal.
```

## Report Template

```md
# Agent Report

task_id:
agent_id:
status: completed | blocked | needs_review | rejected_scope

## User Directives

- (add entries when applicable)

## Changed

- (add entries when applicable)

## Verified

- (add entries when applicable)

## Not Verified

- (add entries when applicable)

## Blockers

- (add entries when applicable)

## Artifacts

- (add entries when applicable)

## Needs Orchestrator Review

- (add entries when applicable)

## Completion Envelope

Prefer one compact `specialist_result` JSON block. For report-only work with no command checks, use an empty `verification` array and a nonempty `no_commands_reason`; every change must be `report_only`. Include any fallback and its approval state. The acceptance controller must expand and validate the canonical `completion_envelope` before staged-in acceptance.

## Question Candidates

When a useful candidate exists or the handoff explicitly requires this metadata, include one structured block:

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

If the handoff explicitly requires a decision record but no useful candidate exists, use:

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

- (add entries when applicable)
```

## User Support Report Template

```md
# User Support Report

task_id:
agent_id: user-support
status: completed | blocked | needs_review

## Input

- questions:
- answer_batches:
- failure_clusters:
- user_tasks:

## Curated Questions

- (add entries when applicable)

## Answer Interpretation

- (add entries when applicable)

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

- (add entries when applicable)

## Needs Orchestrator Decision

- (add entries when applicable)
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
