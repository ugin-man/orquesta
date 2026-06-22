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
8. Give the user the dashboard URL.
9. Present setup option packs.
10. Only after the foundation is ready, classify the user's product task and decide which production specialists are needed.

Bootstrap is idempotent. If setup runs again, inspect existing state and create only the missing foundation pieces.

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
   - Update `directives.json` for user-to-specialist decisions or nuance.
   - Add unresolved creative questions to `.orquesta/vision/questions.json` when specialist work reveals ambiguity.
   - Add repeated or user-actionable command failures to `.orquesta/failures/incidents.json`.
   - Append a short event to `events.jsonl`.

7. Acceptance
   - Orchestrator checks the report against acceptance checks.
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
5. Orchestrator accepts the report and updates `.orquesta/vision/profile.md`, `anti_vision.md`, `decisions.md`, or `specialists/*.md`.
6. Specialist threads read adopted vision files relevant to their role before future work.

## Failure Concierge Sync

Specialists may record failure incidents, but they must not silently keep retrying the same class of failure once a wake trigger is met.

Use this flow:

1. Specialist records concise failure evidence in `.orquesta/failures/incidents.json`.
2. Orchestrator checks the wake triggers in `references/failure-concierge.md`.
3. Wake `error-concierge` when the failure may be user-actionable, repeated, environment-specific, or likely to force a quality-lowering fallback.
4. Concierge clusters related incidents and writes a report plus repair cards in `.orquesta/failures/user_actions.json`.
5. Orchestrator accepts or rejects the concierge report.
6. Codex retries, routes a Codex-fixable task, or asks the user to complete/skip the repair card.

## Stop Conditions

Stop and report instead of continuing when:
- required reading is missing
- approval state is unclear
- two agents are about to edit the same ownership boundary
- the task requires a forbidden action
- acceptance checks cannot be run or described
- the specialist's scope has drifted
- a direct user directive conflicts with project canon or implementation constraints
- raw vision answers would need interpretation before safe adoption
- the same command or environment failure has repeated and no failure incident has been recorded
- a fallback would reduce user-visible quality before `error-concierge` has checked for a user-side repair path
