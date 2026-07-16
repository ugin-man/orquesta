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
   - For Beta V3 staged-in work, read `.orquesta/state/control_audit.json`, `.orquesta/state/capacity.json`, and the current route evidence before claiming a specialist is running or a task is ready for acceptance.
   - Do not load every specialist's required reading into the orchestrator.

3. Classification
   - Classify work as `bootstrap`, `persistent_role`, `bounded_task`, `review`, `standby`, or `direct_specialist_refinement`.
   - Reuse existing agents before creating new ones.

## Execution Policy

After Classification, create one deterministic Execution Plan for a Phase 1.5 task before Appointment. Use the enumerated risk profile to classify `fast`, `standard`, or `critical`; do not score free prose.

- `fast` uses `inline_verified`, has no handoff or independent review, and needs deterministic completion evidence.
- `standard` uses one owner handoff and one independent review. One correction batch is allowed on the same task.
- `critical` uses one owner, up to two independent reviews, up to two correction batches, and optional QA.
- Store implementation, review, correction, and QA as `execution_cycles` on the same task. `R`, `F`, and `RR` auxiliary task entries are invalid for a Phase 1.5 parent.
- Escalate an insufficient lane on the same TaskIntent. Do not automatically downgrade a lane.

Resolve the task state from `canonical_state_root`. An explicit `--state-root` wins over `ORQUESTA_STATE_ROOT`, which wins over the current directory. The resolved root must contain `.orquesta/state/tasks.json`.

Legacy tasks without `execution_policy_version: 1` retain the legacy Delegation Gate below.

## Delegation Gate

Run this gate after Execution Policy and before Appointment or implementation. The gate is recorded in `.orquesta/state/tasks.json` so it survives context compaction.

Use `routing_class`:

- `orchestration_only`: routing, state bookkeeping, contract writing, report acceptance, or other coordination work that belongs to the orchestrator.
- `specialist_required`: work that touches an appointed specialist lane such as implementation, dashboard UX, docs, protocol, bootstrap QA, vision interpretation, failure triage, or user liaison coordination.
- `direct_exception`: specialist-domain work the orchestrator is doing directly for a narrow approved reason.
- `blocked`: work that cannot be routed safely yet.

For legacy `specialist_required` tasks:

1. Set `handoff_required: true`.
2. Set `specialist_report_required: true` unless the task is explicitly report-free and low risk.
3. Send the specialist handoff before implementation starts.
4. Record `handoff_sent_at` and the specialist `owner_agent_id`.
5. Do not accept the task until `specialist_report_path`, `report`, or a specialist report artifact is present and reviewed.
6. Set `routing_gate_status: "passed"` only after the handoff evidence exists.

For legacy `direct_exception` tasks:

1. Record `direct_exception_reason`.
2. Set `routing_gate_status: "bypassed_with_reason"`.
3. Record `bypass_review_owner` when a later specialist review is useful.
4. Keep the scope to orchestration bookkeeping, tiny state or report updates, emergency unblockers, or explicit user instruction.

For Phase 1.5 tasks, validate the Execution Plan contract and canonical ID, lane routing flags, exact budget, completed `execution_cycles`, completion evidence, and honest token coverage. `unknown` token coverage has `known_total: null`; `partial` and `complete` coverage retain unique `thread_id`, measured token values, and an evidence source. `complete` also records the full participating thread set. Accepted standard and critical tasks require a completed implementation cycle, an independent accepted review whose handoff and report reference that review cycle, and Critical and Important counts at zero. Accepted critical tasks also retain the existing approved `user_approval_evidence` record.

For legacy `specialist_required` work, the short rule is: no handoff, no implementation; no report, no acceptance. Phase 1.5 fast work is instead `inline_verified` with no handoff or report; standard and critical use the lane-specific review rules above. Direct exceptions must be visible in task state rather than remembered from chat.

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
   - Extract required specialist report `question_candidates` metadata. Store submitted candidates in `.orquesta/vision/question_candidates.json`; accept a `status: "none"` block only when it includes a valid `none_reason` and plausible rationale.
   - Update `directives.json` for user-to-specialist decisions or nuance.
   - Add unresolved creative question candidates to `.orquesta/vision/question_candidates.json` first. Only `vision-curator` should promote useful candidates into `.orquesta/vision/questions.json`.
   - Store new command failures, ineffective repeats, and quality-degrading fallbacks as candidate evidence first. `incident_candidates.json` and `incident_clusters.json` are pre-acceptance records; only accepted incidents belong in `incidents.json`, and only `status: "open"` incidents keep an active concierge wake reason.
   - Record capacity dispatch lifecycle separately from task state: `queued`, `dispatch_accepted`, `turn_started`, `progress_observed`, and `report_produced`. A message acceptance is not turn-start proof.
   - Use the shared atomic JSON helper for control-state writes. Do not add a new control write through ad hoc read-modify-write code.
   - Append a short event to `events.jsonl`.
   - Treat reports as snapshots. If state changes after a specialist report is written, update JSON state first and ask the affected specialist to re-read before relying on that report.

7. Acceptance
   - Orchestrator checks the report against acceptance checks.
   - For `specialist_required` tasks, verify `handoff_sent_at` and a specialist report path or report artifact before acceptance.
   - For staged-in `specialist_required` and medium/high-risk work, validate the report `completion_envelope` and run a task-scoped control audit before acceptance. Missing or invalid evidence becomes `needs_revision` or a blocker; legacy accepted work remains warning-only unless reopened.
   - For specialist-owned reports, verify the report includes structured `question_candidates`. If the field is missing, set the task to `needs_revision`, `needs_report_metadata`, or equivalent instead of accepting it.
   - Accept `question_candidates.status: "none"` only when it includes a valid `none_reason` and a plausible one-sentence rationale. If the task clearly exposed user choice, product direction, quality risk, or future planning and the `none` rationale is weak, request revision.
   - If candidates are submitted, record them in `.orquesta/vision/question_candidates.json` for later `vision-curator` review. Do not push raw candidates directly to the user.
   - For `direct_exception` tasks, verify `direct_exception_reason` and any `bypass_review_owner` before acceptance.
   - Use `accepted`, `needs_review`, `blocked`, or `rejected_scope_drift`.
   - Do not mark project-level completion while unsynced specialist work exists.
   - If the report contains creative ambiguity, decide whether to queue questions, wake `vision-curator`, or update adopted vision documents.
   - If the report contains repeated environment, permission, dependency, or server-startup failure, decide whether to wake `error-concierge` before accepting a lower-quality fallback.
   - Do not accept a fallback that weakens browser, visual, runtime, or acceptance evidence without explicit user approval.
   - Keep model evidence separate: `recommended_model` is a policy result, `requested_model` is a request, `applied_model` needs adapter evidence, and `actual_model` remains null until independently proved.
   - If a required capacity circuit is open, do not perform the affected specialist work directly. Use only a bounded, role-compatible, independent fallback with documented evidence downgrade, or pause the affected task.

8. User Report
   - Report what changed, what is accepted, what remains blocked, and what needs approval.
   - Avoid dumping internal logs.

## User Capability Route

Use a user capability route when the user is the stronger evidence source, not as a default clarification loop. Valid cases include visual review, metacognitive or tacit-knowledge judgment, credentialed judgment, and direct real-world experience.

When the only automated verification is unsafe or unstable:

1. Pause the affected task and record the evidence gap and failed surface.
2. Do not invent a passing result, silently lower the proof standard, or keep retrying the unstable tool.
3. Ask `user-liaison` to create one concrete user task: exact procedure, behaviors to confirm, and the short response needed to resume.
4. Record the user's result as user-supplied evidence, including its scope and any remaining uncertainty.

This route does not hand ordinary design, implementation, or debugging work to the user. The Codex in-app Browser crash is an external tool limitation: when it recurs, stop that in-app route and use named external-browser UAT only when the user can verify the same behaviors. Do not classify the crash itself as an Orquesta product defect without separate evidence.

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

1. Every specialist report includes a structured `question_candidates` block.
2. Specialist proposes 0-3 domain question candidates when a task exposes important ambiguity, future planning, quality risk, design direction, or user-intent uncertainty.
3. If no useful candidate exists, specialist records `question_candidates.status: "none"` with a valid `none_reason` and rationale.
4. Orchestrator checks the field before report acceptance.
5. Orchestrator records submitted candidates in `.orquesta/vision/question_candidates.json` with `status: "pending_curator_review"`.
6. Wake `vision-curator` only when a trigger in `references/vision-alignment.md` is met.
7. Curator deduplicates, filters, prioritizes, and promotes useful candidates into `.orquesta/vision/questions.json`; rejected or duplicate raw candidates must not reach the user.
8. Curator rewrites question batches or interprets answer batches into a report.
9. Curator separates answers into discussion seeds, strong signals, candidate rules, counterproposals, and `do_not_adopt_yet` items.
10. Orchestrator accepts the report as curation, but does not automatically adopt the content as product direction.
11. Creative, product, UX, story, visual, and completion-map changes usually become `needs_user_review` before adoption.
12. Only user-confirmed or explicitly low-risk operating-rule candidates are reflected into `.orquesta/vision/profile.md`, `anti_vision.md`, `decisions.md`, or `specialists/*.md`.
13. Specialist threads read adopted vision files relevant to their role before future work.

## Failure Concierge Sync

Specialists may record failure incidents, but they must not silently keep retrying the same class of failure once a wake trigger is met.

Use this flow:

1. Specialist records concise failure evidence as an incident candidate. Deterministic fingerprinting and clustering happen before an accepted incident, repair card, or user task exists.
2. Orchestrator checks the wake triggers in `references/failure-concierge.md`.
3. Wake `error-concierge` when the failure may be user-actionable, repeated, environment-specific, or likely to force a quality-lowering fallback.
4. Concierge clusters related candidate evidence, distinguishes open from mitigated history, and writes a report. Repair cards in `.orquesta/failures/user_actions.json` exist only after concierge and orchestrator acceptance.
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
- a specialist-owned report is being accepted without structured `question_candidates`
- a `direct_exception` task has no `direct_exception_reason`
- acceptance checks cannot be run or described
- the specialist's scope has drifted
- a direct user directive conflicts with project canon or implementation constraints
- raw vision answers would need interpretation before safe adoption
- the same command or environment failure has repeated and no failure incident has been recorded
- a fallback would reduce user-visible quality before `error-concierge` has checked for a user-side repair path
