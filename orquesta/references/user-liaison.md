# User Liaison Layer

## Purpose

Keep user-side work visible, humane, and sequenced. Orquesta is not a fully autonomous company; it is a team that works with the user. `user-liaison` owns the user's desk.

## Owner

`user-liaison` is the eldest user-side coordination role. It is user-facing and event-driven.

It coordinates:

- `vision-curator`: turns creative ambiguity, questions, and answers into curated vision proposals.
- `error-concierge`: turns repeated failures and environment blockers into repair-card proposals.
- orchestrator requests: approvals, priorities, unblock decisions, and direct user tasks.

## Responsibility Split

`user-liaison` may:

- collect accepted user-side asks into `.orquesta/user_tasks/queue.json`
- sequence tasks so the user can answer in batches
- rewrite accepted asks into clearer, shorter user-facing wording
- route vision-related work to `vision-curator`
- route failure-related work to `error-concierge`
- tell the orchestrator what user tasks are ready, answered, skipped, or blocked

`user-liaison` must not:

- interpret raw vision answers into project direction
- turn raw failure incidents into repair instructions without concierge review
- create production implementation tasks without orchestrator acceptance
- hide user tasks inside long reports
- run continuously as a watcher

## Queue Shape

Store user-facing tasks in `.orquesta/user_tasks/queue.json`.

```json
{
  "version": 1,
  "owner_agent_id": "user-liaison",
  "tasks": [
    {
      "user_task_id": "UT001",
      "source": "vision_question",
      "source_ids": ["Q001"],
      "assigned_by": "vision-curator",
      "status": "ready",
      "priority": "medium",
      "title": "Answer visual direction question",
      "prompt": "Choose the direction that best matches your intended game feel.",
      "expected_response": "text",
      "created_at": "2026-06-22T00:00:00+09:00",
      "resolved_at": null
    }
  ],
  "policy": {
    "coordinator_agent_id": "user-liaison",
    "managed_agents": ["vision-curator", "error-concierge"],
    "default_status": "ready",
    "user_visible": true
  }
}
```

## Wake Triggers

Wake `user-liaison` when one of these is true:

- the orchestrator needs to ask the user for approval, choice, priority, or action
- `vision-curator` has accepted questions or interpreted answer follow-ups that need user-facing presentation
- `error-concierge` has accepted repair cards that need user action
- user-side work has accumulated enough that batching would reduce friction
- the user asks what they should do next

## Acceptance Flow

1. A specialist or orchestrator proposes a user-side ask.
2. The owning specialist performs domain-specific interpretation first.
3. Orchestrator accepts or rejects the ask.
4. `user-liaison` adds or updates the user task queue.
5. Dashboard presents the user-side work.
6. User answers, completes, skips, or asks for clarification.
7. `user-liaison` routes the result back to the owning specialist or orchestrator.
