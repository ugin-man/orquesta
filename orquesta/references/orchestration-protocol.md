# Orquesta Orchestration Protocol

## Purpose

Coordinate long-lived specialist Codex threads without making the orchestrator a bottleneck for every nuance. Keep the project coherent through contracts, state files, reports, and dashboard-visible synchronization.

## Operating Loop

1. Intake
   - Capture the user's goal.
   - Decide whether the request is bootstrap, orchestration, specialist work, review, or direct refinement.
   - Ask only questions that materially affect routing or safety.

2. State Read
   - Read `.orquesta/CURRENT_ORCHESTRA.md`.
   - Read task-relevant state JSON.
   - Do not load every specialist's required reading into the orchestrator.

3. Classification
   - Classify work as `bootstrap`, `persistent_role`, `bounded_task`, `review`, `standby`, or `direct_specialist_refinement`.
   - Reuse existing agents before creating new ones.

## Delegation Gate

Run this gate after Classification and before Appointment or implementation. The gate is mandatory for specialist-domain work and must be recorded in `.orquesta/state/tasks.json` so it survives context compaction.

Use `routing_class`:

- `orchestration_only`: routing, state bookkeeping, contract writing, report acceptance, or other coordination work that belongs to the orchestrator.
- `specialist_required`: work that touches an appointed specialist lane such as implementation, dashboard UX, docs, protocol, bootstrap QA, vision interpretation, failure triage, or user liaison coordination.
- `direct_exception`: specialist-domain work the orchestrator is doing directly for a narrow approved reason.
- `blocked`: work that cannot be routed safely yet.

For `specialist_required` tasks:

1. Set `handoff_required: true`.
2. Set `specialist_report_required: true` unless the task is explicitly report-free and low risk.
3. Send the specialist handoff before implementation starts.
4. Record `handoff_sent_at` and the specialist `owner_agent_id`.
5. Do not accept the task until `specialist_report_path`, `report`, or a specialist report artifact is present and reviewed.
6. Set `routing_gate_status: "passed"` only after the handoff evidence exists.

For `direct_exception` tasks:

1. Record `direct_exception_reason`.
2. Set `routing_gate_status: "bypassed_with_reason"`.
3. Record `bypass_review_owner` when a later specialist review is useful.
4. Keep the scope to orchestration bookkeeping, tiny state or report updates, emergency unblockers, or explicit user instruction.

If a specialist exists and the task touches that lane, the short rule is: no handoff, no implementation; no report, no acceptance. Direct exceptions must be visible in task state rather than remembered from chat.

## Bootstrap Loop

Use this before the normal operating loop when Orquesta is invoked in a project without current Orquesta state:

1. Treat the calling chat as the orchestrator foundation agent.
2. Rename the calling Codex thread to `★ Orquesta 統括` when thread-title tools are available.
3. Pin the calling Codex thread when pin tools are available.
4. Create the `.orquesta` state skeleton.
5. Record bootstrap status, title policy, and pin policy in `.orquesta/setup/options.json`.
6. Create or reuse the foundation sessions:
   - `user-liaison`
   - `vision-curator`
   - `error-concierge`
   - `orquesta-admin`
7. Start the dashboard server or record why it cannot start.
8. Verify the dashboard through `/api/state`; do not rely on HTTP 200 alone.
9. Open the verified dashboard URL in the user's external browser when possible.
10. Give the user the verified dashboard URL.
11. Present setup option packs.
12. Only after the foundation is ready, classify the user's product task and decide which production specialists are needed.

Bootstrap is idempotent. If setup runs again, inspect existing state and create only the missing foundation pieces.

Do not repeatedly open dashboard browser tabs during bootstrap resume. Auto-open once after first successful dashboard verification, then store the open attempt in setup state.

4. Appointment
   - Create or update an agent contract.
   - Define required reading and excluded context.
   - Define allowed and forbidden actions.
   - Define acceptance checks and done signal.

5. Execution
   - Specialist works within contract.
   - Specialist may talk directly with the user for domain nuance.
   - Specialist records direct user guidance in directives or reports.

6. Synchronization
   - Update `agents.json` heartbeat and status.
   - Update `tasks.json` state and artifacts.
   - Update task delegation fields: `routing_class`, `routing_gate_status`, `handoff_required`, `handoff_sent_at`, `specialist_report_required`, `specialist_report_path`, `direct_exception_reason`, and `bypass_review_owner`.
   - Update `directives.json` for user-to-specialist decisions or nuance.
   - Add unresolved creative questions to `.orquesta/vision/questions.json` when specialist work reveals ambiguity.
   - Add repeated or user-actionable command failures to `.orquesta/failures/incidents.json`.
   - Append a short event to `events.jsonl`.
   - Treat reports as snapshots. If state changes after a specialist report is written, update JSON state first and ask the affected specialist to re-read before relying on that report.

7. Acceptance
   - Orchestrator checks the report against acceptance checks.
   - For `specialist_required` tasks, verify `handoff_sent_at` and a specialist report path or report artifact before acceptance.
   - For `direct_exception` tasks, verify `direct_exception_reason` and any `bypass_review_owner` before acceptance.
   - Use `accepted`, `needs_review`, `blocked`, or `rejected_scope_drift`.
   - Do not mark project-level completion while unsynced specialist work exists.
   - If the report contains creative ambiguity, decide whether to queue questions, wake `vision-curator`, or update adopted vision documents.
   - If the report contains repeated environment, permission, dependency, or server-startup failure, decide whether to wake `error-concierge` before accepting a lower-quality fallback.

8. User Report
   - Report what changed, what is accepted, what remains blocked, and what needs approval.
   - Avoid dumping internal logs.

## New Thread Gate

Create a new specialist thread only when all are true:
- No existing agent owns the role or context scope.
- The task is long-lived or domain-specific enough to justify a teammate.
- The role can be given a bounded contract.
- The user has approved autonomous creation, or the current Orquesta policy allows it.

Default policy: propose new thread creation and wait for user approval.

## Direct Conversation Sync

When the user works directly with a specialist:

```json
{
  "source": "user_direct_conversation",
  "agent_id": "visual-art-001",
  "task_id": "T014",
  "summary": "User wants the interface to feel less thin and more physically layered.",
  "user_directives": [
    "Add visual weight without generic decoration."
  ],
  "changed": [
    "Updated the visual brief."
  ],
  "needs_orchestrator_review": [
    "Confirm whether implementation should start now."
  ]
}
```

## Vision Alignment Sync

Specialists may add question candidates, but they must not treat raw user answers as adopted direction.

Use this flow:

1. Specialist proposes 0-3 domain questions when a task exposes important ambiguity.
2. Orchestrator records them in `.orquesta/vision/questions.json` with `status: "draft"`.
3. Wake `vision-curator` only when a trigger in `references/vision-alignment.md` is met.
4. Curator rewrites question batches or interprets answer batches into a report.
5. Curator separates answers into discussion seeds, strong signals, candidate rules, counterproposals, and `do_not_adopt_yet` items.
6. Orchestrator accepts the report as curation, but does not automatically adopt the content as product direction.
7. Creative, product, UX, story, visual, and completion-map changes usually become `needs_user_review` before adoption.
8. Only user-confirmed or explicitly low-risk operating-rule candidates are reflected into `.orquesta/vision/profile.md`, `anti_vision.md`, `decisions.md`, or `specialists/*.md`.
9. Specialist threads read adopted vision files relevant to their role before future work.

## Failure Concierge Sync

Specialists may record failure incidents, but they must not silently keep retrying the same class of failure once a wake trigger is met.

Use this flow:

1. Specialist records concise failure evidence in `.orquesta/failures/incidents.json`.
2. Orchestrator checks the wake triggers in `references/failure-concierge.md`.
3. Wake `error-concierge` when the failure may be user-actionable, repeated, environment-specific, or likely to force a quality-lowering fallback.
4. Concierge clusters related incidents and writes a report plus repair cards in `.orquesta/failures/user_actions.json`.
5. Orchestrator accepts or rejects the concierge report.
6. Codex retries, routes a Codex-fixable task, or asks the user to complete/skip the repair card.

If a new incident is recorded after `error-concierge` has already written a "no failures" or readiness report, that report is stale. Wake or message `error-concierge` to re-read incidents and user actions before final setup acceptance.

## Report Freshness

`.orquesta/state/*.json`, `.orquesta/setup/options.json`, `.orquesta/failures/*.json`, `.orquesta/vision/*.json`, and `.orquesta/user_tasks/*.json` are the current source of truth.

Reports under `.orquesta/reports/` are snapshots written at a point in time. Do not assume report text is current after later state edits, port changes, new incidents, thread status changes, or answer curation. Final setup acceptance should re-check the relevant JSON state and, when needed, send a narrow re-sync prompt to stale foundation threads.

## Dashboard UI Verification

For dashboard UI changes, syntax checks are not enough. A helper-name typo can pass `node --check` and still crash browser rendering.

After dashboard UI edits:

1. Run `node --check` on dashboard scripts.
2. Load the dashboard in a real browser.
3. Check browser console errors, especially `ReferenceError`, `TypeError`, and `SyntaxError`.
4. Verify `/api/state` returns the expected project state.
5. Verify DOM agent nodes exist with `document.querySelectorAll("[data-agent-id]").length > 0`.

If `/api/state` has agents but the DOM has zero agent nodes, treat it as a frontend render failure, not a backend state failure.

## Stop Conditions

Stop and report instead of continuing when:
- required reading is missing
- approval state is unclear
- two agents are about to edit the same ownership boundary
- the task requires a forbidden action
- a `specialist_required` task has no `handoff_sent_at`
- a `specialist_required` task is being accepted without `specialist_report_path`, `report`, or a report artifact
- a `direct_exception` task has no `direct_exception_reason`
- acceptance checks cannot be run or described
- the specialist's scope has drifted
- a direct user directive conflicts with project canon or implementation constraints
- raw vision answers would need interpretation before safe adoption
- the same command or environment failure has repeated and no failure incident has been recorded
- a fallback would reduce user-visible quality before `error-concierge` has checked for a user-side repair path
