# User Support

`user-support` is Orquesta's single project-wide support seat. It replaces the separately generated `user-liaison`, `vision-curator`, and `error-concierge` agents. Old records and reports remain readable history, but new projects create only `user-support`.

## Responsibilities

- curate specialist question candidates and present only useful questions
- interpret user answers as signals rather than automatic commands
- collect approvals, confirmations, manual steps, and user-capability reviews in the user-task queue
- cluster repeated failure evidence and prepare a concise repair card when user knowledge or action may help
- preserve direct user nuance and route adopted changes back to the orchestrator

`user-support` does not own product implementation, replace the orchestrator, or run as a continuous watcher. It normally remains in `standby`.

## Wake Triggers

Wake it when at least one of these is true:

- a high-priority question candidate exists
- a question candidate blocks acceptance
- the pending question batch or age threshold is reached
- a repeated failure fingerprint, open incident cluster, environment blocker, or quality-lowering fallback needs triage
- an Orquesta task needs user review but has no matching user-task entry
- a user approval, confirmation, manual action, or capability review must be presented
- the user explicitly asks to review questions, failures, or their task queue

Do not wake it for a single low-value candidate, a resolved incident, or work Codex can finish normally. The trigger audit combines all three source types and writes one result for `user-support`.

## Output

Use the existing stores by concern:

- questions and candidates: `.orquesta/vision/`
- incidents, clusters, and repair cards: `.orquesta/failures/`
- user-visible asks: `.orquesta/user_tasks/queue.json`
- durable decisions or nuance: `.orquesta/state/directives.json`
- bounded reports: `.orquesta/reports/`

The support agent may create or update a user-task entry, but it does not invent an approval requirement. Product-level approval is required for a new production line. Other organization changes are autonomous. Codex safety and command approvals are separate harness controls and are recorded as approval-wait tasks when they occur.

## Legacy Migration

During migration:

- create or reuse `user-support`
- preserve the old thread IDs and agent records
- set the old agents to `lifecycle_state: "superseded"`
- set `superseded_by: "user-support"`
- do not copy an old agent's stale `current_task` into the new support agent
- keep old report attribution unchanged

Repeated migration must be idempotent and must never create a second `user-support` agent.
