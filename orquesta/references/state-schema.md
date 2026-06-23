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

Specialist report review uses task state rather than a separate task store. When a specialist has finished a task but the orchestrator has not accepted it yet, set the task to `completed`, `report_submitted`, `needs_review`, or `needs_orchestrator_review` and include a `.orquesta/reports/*.md` artifact. The dashboard turns those tasks into report review cards.

Report review decisions:

- `accept`: set the task to `accepted`, record `accepted_at`, return the owner agent to `standby`, and synchronize any Production Start activation request to `accepted`.
- `request_changes`: set the task to `needs_revision`, keep or return the owner agent to `active`, and synchronize any Production Start activation request to `changes_requested`.
- `hold`: keep the task at `needs_orchestrator_review` while preserving the report and orchestrator note.

The dashboard endpoint `POST /api/reports/review` performs this file-backed synchronization. It does not message specialist threads by itself; the orchestrator still owns any follow-up handoff.

## Handoff Drafts

The dashboard may expose `handoffDrafts` through `/api/state`. These are generated, copy-ready prompts for the orchestrator to send to long-lived specialist Codex threads.

Handoff drafts are not proof that a message was sent. They are derived from current state:

- queued Production Start tasks become initial handoff drafts
- `needs_revision` or `changes_requested` tasks become revision handoff drafts
- agent contracts and specialist candidate fields provide required reading, excluded context, allowed files, forbidden actions, and acceptance checks

The browser may copy the prompt text, but only the orchestrator thread should perform the actual Codex thread handoff and then update state with `handoff_sent_at`, task `active`, and related agent status.

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
      "setup_gate": false,
      "required_for_setup": false,
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

Questions generated from first-run project intake should use `setup_gate: true` and `required_for_setup: true`. The dashboard should prioritize these before ordinary vision questions, and Completion Map approval must stay blocked until they are answered.

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
      "interpretation_mode": "discussion_seed_not_command",
      "answers": [
        {
          "question_id": "Q001",
          "answer": "Hybrid, but avoid generic SaaS dashboard gloss.",
          "answered_at": "2026-06-21T00:00:00+09:00"
        }
      ],
      "curator_report": null,
      "discussion_seeds": [],
      "strong_signals": [],
      "candidate_rules": [],
      "counterproposals": [],
      "do_not_adopt_yet": [],
      "needs_user_review": [],
      "proposed_updates": [],
      "adopted_updates": []
    }
  ]
}
```

Answer batch statuses:

- `needs_curation`: raw answers were saved and still need `vision-curator`.
- `curated`: the curator interpreted the batch, but it is not adopted direction.
- `needs_user_review`: the interpretation contains candidates that should be discussed with the user before adoption.
- `approved_for_adoption`: the user or an explicit setup policy approved the candidate direction.
- `adopted`: approved candidates were reflected into adopted vision documents.
- `retired`: stale, duplicate, or no longer useful.

Use `interpretation_mode: "discussion_seed_not_command"` by default. User answers are thinking seeds unless the user explicitly marks them as hard requirements. Curator reports should preserve useful uncertainty and include counterproposals when a direct answer seems underdeveloped, too broad, or likely to become a weak implementation rule.

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

## project/completion_map.json

The Completion Map records the large pieces required to finish the project. It is not a task log. It is the current completion contract that the dashboard shows and the orchestrator uses to decide which specialists are needed.

```json
{
  "version": 1,
  "project_title": "Example browser game",
  "status": "in_progress",
  "definition_of_done": "The game is playable from start to finish with the agreed core screens and loop.",
  "revision_policy": {
    "owner_agent_id": "orchestrator",
    "review_triggers": [
      "major_direction_change",
      "user_changes_project_goal",
      "repeated_failure",
      "completion_item_no_longer_matches_project",
      "new_required_surface_discovered"
    ],
    "rule": "Completion Map items may change after user approval when the project direction changes."
  },
  "phases": [
    {
      "phase_id": "CM001",
      "title": "Core game loop",
      "summary": "The player can start, act, receive feedback, and continue.",
      "status": "in_progress",
      "owner_agent_id": "implementation-001",
      "items": [
        {
          "item_id": "CM001.1",
          "title": "Title screen",
          "status": "done"
        },
        {
          "item_id": "CM001.2",
          "title": "Combat screen",
          "status": "queued"
        }
      ]
    }
  ]
}
```

The map should be created after project intake and required vision questions are answered. Production specialists should be created from the approved map, not from vague impulse.

## setup/wizard.json

The setup wizard records where the first-run guided setup currently is. It is dashboard state, not a production task list.

```json
{
  "version": 1,
  "status": "in_progress",
  "current_step": "completion_map_review",
  "updated_at": "2026-06-23T00:00:00+09:00",
  "steps": [
    {
      "step_id": "welcome",
      "title": "ようこそOrquestaへ",
      "summary": "Orquestaが何をするか、どの順番で進むかをユーザーに説明する。",
      "status": "done"
    },
    {
      "step_id": "project_intake",
      "title": "プロジェクト説明",
      "summary": "ユーザーが作りたいもの、重視する体験、避けたい方向性を説明する。",
      "status": "active"
    },
    {
      "step_id": "completion_map_review",
      "title": "完成マップ確認",
      "summary": "プロジェクト完成までの大項目を確認し、必要なら修正してから承認する。",
      "status": "queued"
    }
  ],
  "gates": {
    "project_intake_required": true,
    "required_questions_must_be_answered": true,
    "completion_map_requires_user_approval": true,
    "completion_map_approved": false,
    "specialist_plan_reviewed": false,
    "specialist_plan_approved": false,
    "approved_specialist_candidate_ids": []
  }
}
```

## setup/project_intake.json

Project intake stores the user's initial explanation before Orquesta generates questions and the Completion Map.

```json
{
  "version": 1,
  "status": "submitted",
  "updated_at": "2026-06-23T00:00:00+09:00",
  "project_title": "Example browser game",
  "project_description": "A short description of what the user wants to make, what matters, and what should be avoided.",
  "source": "dashboard_setup_wizard",
  "notes": []
}
```

## setup/specialist_plan.json

Specialist Plan stores proposed production specialists after the Completion Map is approved. It is an approval buffer, not a thread-creation command. The dashboard may let the user mark each candidate as `approve_now`, `later`, `reject`, or `revise`, but sessions must not be created from this file until the orchestrator explicitly runs the next appointment step.

```json
{
  "version": 1,
  "status": "proposal_ready",
  "updated_at": "2026-06-23T00:00:00+09:00",
  "source": "completion_map",
  "source_completion_map_updated_at": "2026-06-23T00:00:00+09:00",
  "policy": {
    "create_sessions_on_review": false,
    "require_user_approval_before_thread_creation": true,
    "default_capability_docs_policy": "deferred_research"
  },
  "candidates": [
    {
      "candidate_id": "SP001",
      "agent_id": "implementation-001",
      "display_name": "実装係",
      "role": "implementation",
      "priority": "high",
      "reuse_existing_agent": true,
      "status": "proposed",
      "reason": "Dashboard/API/state implementation is needed for the approved Completion Map.",
      "proposed_scope": "Implement dashboard, setup, state, and local server changes.",
      "completion_items": ["CM002.1"],
      "required_reading": ["orquesta/references/state-schema.md"],
      "excluded_context": ["Unrelated project lore or visual direction"],
      "user_decision": null,
      "user_note": null
    }
  ],
  "deferred_topics": [
    {
      "topic_id": "SP-D001",
      "title": "Whether default capability documents are needed for every specialist",
      "status": "deferred_research"
    }
  ]
}
```

## setup/production_start.json

Production Start stores the first handoff requests prepared from approved specialist candidates. It is still not a thread automation layer. Preparing production start may create queued handoff tasks, but it must not create sessions, message specialist threads, or mark specialists active unless the orchestrator actually performs those handoffs.

```json
{
  "version": 1,
  "status": "handoff_ready",
  "updated_at": "2026-06-23T00:00:00+09:00",
  "selected_candidate_ids": ["SP001", "SP002"],
  "activation_requests": [
    {
      "candidate_id": "SP001",
      "agent_id": "implementation-001",
      "display_name": "実装係",
      "task_id": "PS001",
      "status": "handoff_ready",
      "requested_at": "2026-06-23T00:00:00+09:00",
      "note": "Prepared from the production start dashboard gate.",
      "thread_id": "019eed9a-7d5a-7652-9038-fa855dbac9d6"
    }
  ],
  "policy": {
    "create_sessions_on_start": false,
    "requires_thread_handoff": true
  },
  "notes": [
    "The dashboard prepared handoff tasks only. It did not create sessions or send messages to specialist threads."
  ]
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
