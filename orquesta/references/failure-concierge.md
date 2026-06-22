# Failure Concierge Layer

## Purpose

Prevent repeated Codex retries, hidden local-environment blockers, and quality-lowering fallbacks from becoming invisible project drag. The Failure Concierge Layer turns tool failures into inspectable incidents and, when useful, user-actionable repair cards.

This layer is independent from the orchestrator in the same sense as the Vision Alignment Layer. It is user-facing and event-driven, not a permanent watcher.

## Owner

`error-concierge` owns failure clustering, user-side repair proposals, and fallback quality warnings.

The role should usually be `standby`. Wake it only when a trigger is met.

## Wake Triggers

Wake `error-concierge` when one of these is true:

- the same failure class occurs 2 or more times in one task
- permission, admin-rights, file-lock, antivirus, OneDrive sync, or shell policy denial appears likely
- a local server, browser, package manager, runtime, or build tool cannot start
- a command fails because a dependency, executable, PATH entry, credential, or environment variable is missing
- a specialist proposes a fallback that may reduce quality, skip visual verification, or avoid an intended workflow
- a task is blocked by environment state rather than by project ambiguity
- the user asks why repeated execution is failing

## Incident Capture

Any specialist or the orchestrator may append an incident to `.orquesta/failures/incidents.json`.

Record only concise evidence:

```json
{
  "incident_id": "F001",
  "task_id": "T038",
  "source_agent_id": "implementation-001",
  "command_or_action": "npm run dashboard",
  "failure_class": "local_server_startup",
  "severity": "medium",
  "summary": "Dashboard server could not bind to the expected port.",
  "evidence": "EADDRINUSE: address already in use 127.0.0.1:4177",
  "attempted_fixes": ["checked running process list"],
  "suspected_owner": "codex",
  "status": "open",
  "created_at": "2026-06-22T00:00:00+09:00"
}
```

Use `suspected_owner` values:

- `codex`: Codex can likely fix it inside the workspace.
- `user`: the user likely needs to grant permission, close a program, install something, sign in, or change machine settings.
- `shared`: Codex can prepare steps, but the user must approve or perform part of the repair.
- `unknown`: classification needs concierge review.

## Repair Cards

`error-concierge` writes user-facing proposals to `.orquesta/failures/user_actions.json`.

Repair cards must be concrete, short, and safe:

```json
{
  "action_id": "UA001",
  "source_incident_ids": ["F001"],
  "status": "ready",
  "title": "Free dashboard port 4177",
  "why_this_helps": "The dashboard cannot start while another process owns the port.",
  "user_steps": [
    "Close the other app using port 4177, or allow Orquesta to use another port."
  ],
  "codex_can_do": [
    "Retry the dashboard server after the port is free."
  ],
  "risk": "low",
  "requires_user_approval": true,
  "created_at": "2026-06-22T00:00:00+09:00"
}
```

## Fallback Quality Gate

Before accepting a fallback after repeated failure, check whether the fallback changes the user-visible result.

If it does, record:

- what failed
- what fallback is proposed
- what quality, evidence, or workflow will be lost
- what user-side action might preserve the original plan

Do not quietly downgrade visual verification, asset generation, browser testing, or runtime integration when a user-side repair might unblock the intended path.

## Acceptance Flow

1. Incident is recorded.
2. Orchestrator checks whether a wake trigger is met.
3. `error-concierge` clusters related incidents and writes a concise report.
4. Orchestrator accepts or rejects the report.
5. Accepted user-side work is exposed as repair cards.
6. Codex retries only after the relevant action is completed or explicitly skipped.

## Stale Failure Reports

Failure reports are snapshots. If an incident is recorded after `error-concierge` has already reported "no failures", that earlier report is stale.

When this happens:

1. Keep the incident in `.orquesta/failures/incidents.json` as the source of truth.
2. Ask `error-concierge` to re-read incidents and user actions.
3. Update or append the concierge report.
4. Only then mark setup or the affected task as fully synchronized.

This matters during bootstrap because foundation sessions may write readiness reports before the orchestrator finishes dashboard startup and failure logging.

## Boundaries

`error-concierge` must not:

- run continuously as a background watcher
- request broad machine changes when a narrow action is enough
- ask the user to run destructive commands
- hide security or credential implications
- replace the implementation or QA agent
- treat a workaround as equivalent when it reduces quality
