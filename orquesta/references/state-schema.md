# Orquesta State Schema

The `.orquesta/state` files are the source of truth. Keep them small, explicit, and easy to inspect.

## agents.json

```json
{
  "version": 1,
  "max_active_agents": 3,
  "agents": [
    {
      "agent_id": "visual-art-001",
      "role": "visual-art",
      "thread_id": null,
      "status": "standby",
      "mission": "Own visual direction, art rules, mockups, and asset feedback.",
      "workspace_path": ".",
      "current_task": null,
      "context_scope": "visual production only",
      "required_reading": ["docs/art/visual_bible.md"],
      "excluded_context": ["implementation internals unless integration is assigned"],
      "allowed_files": ["docs/art/**", "assets/**"],
      "forbidden_actions": ["git push", "delete source files"],
      "last_heartbeat": null,
      "artifacts": []
    }
  ]
}
```

Add `vision-curator` only as an event-driven specialist. Its `status` should usually be `standby`; do not model it as a continuously running watcher.

Add `error-concierge` only as an event-driven specialist. Its `status` should usually be `standby`; do not model it as a continuously running watcher.

Add `user-liaison` as the event-driven owner of user-side task presentation and queue coordination. It may coordinate `vision-curator` and `error-concierge`, but must not replace their specialist interpretation.

During bootstrap, the calling chat becomes the orchestrator foundation agent first. New projects should use unnumbered foundation IDs: `orchestrator`, `user-liaison`, `vision-curator`, `error-concierge`, and `orquesta-admin`. Existing projects with `*-001` foundation IDs may keep them until an explicit migration updates state and dashboard code together. `orquesta-admin` manages Orquesta setup and tuning only; it is not the production orchestrator.

## sessions.json

`sessions.json` stores the latest observed Codex project threads. `agents.json` is the appointed role roster; `sessions.json` is the observed runtime session snapshot. The dashboard overlays sessions onto agents by `thread_id`, and may show unassigned project sessions separately.

```json
{
  "version": 1,
  "source": "codex_app.list_threads",
  "project_cwd": "C:\\Users\\kouki\\OneDrive\\ドキュメント\\Orquesta",
  "synced_at": "2026-06-22T00:00:00.000Z",
  "sessions": [
    {
      "thread_id": "019ee896-9dbf-7d30-aee8-7e8c8d8e19f1",
      "host_id": "local",
      "title": "Orquesta visual-art-001",
      "status": "idle",
      "cwd": "C:\\Users\\kouki\\OneDrive\\ドキュメント\\Orquesta",
      "created_at": 1782018650,
      "updated_at": 1782038749
    }
  ]
}
```

Refresh this file from the Codex thread list when the user asks to reflect actual project sessions, after creating or archiving specialist threads, or before relying on the visualizer as an operations view.

## tasks.json

```json
{
  "version": 1,
  "tasks": [
    {
      "task_id": "T001",
      "title": "Prototype agent board",
      "state": "queued",
      "owner_agent_id": null,
      "dependencies": [],
      "parallel_eligible": true,
      "effort": "focused",
      "blocked_by": [],
      "acceptance_checks": ["Dashboard loads sample state"],
      "artifacts": [],
      "result_summary": null
    }
  ]
}
```

## directives.json

```json
{
  "version": 1,
  "directives": [
    {
      "directive_id": "D001",
      "source": "user_direct_conversation",
      "agent_id": "visual-art-001",
      "task_id": "T014",
      "status": "needs_orchestrator_review",
      "summary": "User wants a denser, less thin UI feel.",
      "user_directives": ["Add visual weight without generic decoration."],
      "changed": ["Updated visual brief."],
      "needs_orchestrator_review": ["Confirm implementation timing."],
      "created_at": "2026-06-21T00:00:00+09:00"
    }
  ]
}
```

## events.jsonl

One JSON object per line:

```json
{"ts":"2026-06-21T00:00:00+09:00","type":"task_created","task_id":"T001","summary":"Created dashboard prototype task."}
```

## vision/questions.json

```json
{
  "version": 1,
  "questions": [
    {
      "question_id": "Q001",
      "source_agent_id": "visual-art-001",
      "task_id": "T020",
      "scope": "visual",
      "priority": "medium",
      "status": "draft",
      "question": "Should the UI feel more like a precise instrument or a lived-in workspace?",
      "why_it_matters": "This changes density, surface treatment, and animation restraint.",
      "answer_format": "choice_with_optional_note",
      "options": ["precise instrument", "lived-in workspace", "hybrid"],
      "created_at": "2026-06-21T00:00:00+09:00",
      "curated_by": null,
      "answer_id": null
    }
  ],
  "curation_policy": {
    "curator_agent_id": "vision-curator",
    "wake_triggers": [
      "project_kickoff",
      "uncurated_questions_gte_10",
      "high_priority_question",
      "task_accepted_with_creative_ambiguity",
      "user_requests_question_review",
      "major_direction_change"
    ],
    "default_batch_size": 20
  }
}
```

## vision/answers.json

```json
{
  "version": 1,
  "answer_batches": [
    {
      "batch_id": "A001",
      "question_ids": ["Q001"],
      "source": "user_batch_answer",
      "status": "needs_curation",
      "answers": [
        {
          "question_id": "Q001",
          "answer": "Hybrid, but avoid generic SaaS dashboard gloss.",
          "answered_at": "2026-06-21T00:00:00+09:00"
        }
      ],
      "curator_report": null,
      "adopted_updates": []
    }
  ]
}
```

## vision/*.md

`profile.md`, `decisions.md`, `anti_vision.md`, and `specialists/*.md` contain adopted direction only. Do not paste every raw answer into these files.

## failures/incidents.json

```json
{
  "version": 1,
  "incidents": [
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
      "created_at": "2026-06-22T00:00:00+09:00",
      "concierge_report": null
    }
  ],
  "wake_policy": {
    "concierge_agent_id": "error-concierge",
    "wake_triggers": [
      "equivalent_failures_gte_2",
      "permission_or_admin_denial",
      "local_server_startup_failure",
      "missing_dependency_or_path",
      "environment_blocked_task",
      "quality_lowering_fallback_proposed",
      "user_asks_why_failure_repeats"
    ]
  }
}
```

## failures/user_actions.json

```json
{
  "version": 1,
  "actions": [
    {
      "action_id": "UA001",
      "source_incident_ids": ["F001"],
      "status": "ready",
      "title": "Free dashboard port 4177",
      "why_this_helps": "The dashboard cannot start while another process owns the port.",
      "user_steps": ["Close the other app using port 4177, or allow Orquesta to use another port."],
      "codex_can_do": ["Retry the dashboard server after the port is free."],
      "risk": "low",
      "requires_user_approval": true,
      "created_at": "2026-06-22T00:00:00+09:00",
      "resolved_at": null
    }
  ]
}
```

## user_tasks/queue.json

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

## setup/options.json

```json
{
  "version": 1,
  "setup_status": "ready",
  "bootstrap_status": "ready",
  "foundation_id_policy": "unnumbered_for_new_projects",
  "orchestrator_agent_id": "orchestrator",
  "orchestrator_thread_id": null,
  "orchestrator_display_title": "★ Orquesta 統括",
  "orchestrator_title_policy": "rename_calling_thread_to_starred_Orquesta_orchestrator",
  "orchestrator_pin_policy": "pin_calling_thread",
  "foundation_agent_ids": [
    "user-liaison",
    "vision-curator",
    "error-concierge",
    "orquesta-admin"
  ],
  "foundation_sessions_required": true,
  "foundation_session_status": "pending",
  "foundation_blockers": [],
  "admin_agent_id": "orquesta-admin",
  "admin_thread_id": null,
  "dashboard_url": "http://127.0.0.1:4177/",
  "dashboard_verified_at": null,
  "dashboard_open_policy": "open_verified_url_once",
  "dashboard_open_attempted": false,
  "dashboard_opened_at": null,
  "dashboard_open_error": null,
  "enabled_packs": ["minimal_core"],
  "available_packs": [
    {
      "pack_id": "minimal_core",
      "label": "Minimal Core",
      "status": "enabled",
      "description": "Orquesta Admin plus production orchestrator."
    },
    {
      "pack_id": "game_production_core",
      "label": "Game Production Core",
      "status": "available",
      "description": "Implementation, visual-art, world-lore, and playtest QA roles."
    },
    {
      "pack_id": "vision_alignment",
      "label": "Vision Alignment",
      "status": "available",
      "description": "Question curation, answer batches, and adopted vision documents."
    },
    {
      "pack_id": "failure_concierge",
      "label": "Failure Concierge",
      "status": "available",
      "description": "Failure incidents and user-side repair cards."
    },
    {
      "pack_id": "user_liaison_desk",
      "label": "User Liaison Desk",
      "status": "available",
      "description": "User-side task queue and ask coordination."
    }
  ],
  "notes": []
}
```

## CURRENT_ORCHESTRA.md

Human-readable snapshot. It should summarize active agents, active tasks, blockers, direct user directives, and next orchestration actions. It may be regenerated from JSON state later.
