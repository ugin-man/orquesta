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
      "routing_class": "specialist_required",
      "routing_gate_status": "passed",
      "handoff_required": true,
      "handoff_sent_at": "2026-06-23T00:00:00.000Z",
      "specialist_report_required": true,
      "specialist_report_path": ".orquesta/reports/T001-visual-art-001.md",
      "direct_exception_reason": null,
      "bypass_review_owner": null,
      "acceptance_checks": ["Dashboard loads sample state"],
      "artifacts": [],
      "result_summary": null
    }
  ]
}
```

Delegation gate fields:

- `routing_class`: `orchestration_only`, `specialist_required`, `direct_exception`, or `blocked`.
- `routing_gate_status`: `pending`, `passed`, `blocked`, or `bypassed_with_reason`.
- `handoff_required`: `true` when an appointed specialist should receive the task before implementation.
- `handoff_sent_at`: ISO timestamp for the actual specialist handoff. Handoff drafts do not count.
- `specialist_report_required`: `true` when acceptance must wait for a specialist report or artifact.
- `specialist_report_path`: `.orquesta/reports/*.md` path for the specialist report. The legacy `report` field may be used by older tasks, but new tasks should prefer `specialist_report_path`.
- `direct_exception_reason`: required when `routing_class` is `direct_exception`; keep it short and specific.
- `bypass_review_owner`: optional specialist `agent_id` that should later review a direct exception.

For specialist-domain implementation, use task state rather than chat memory. A task with `routing_class: "specialist_required"` should not be accepted until it has `handoff_sent_at` and either `specialist_report_path`, `report`, or a specialist report artifact. A task with `routing_class: "direct_exception"` should not be accepted without `direct_exception_reason`.

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

Useful delegation event types:

- `routing_gate_passed`: the task was classified and has the required routing fields.
- `routing_gate_blocked`: the task could not safely proceed through routing.
- `handoff_sent`: the orchestrator sent a real specialist handoff.
- `direct_exception_used`: the orchestrator used a documented direct-work exception.
- `specialist_report_received`: a specialist report path or artifact was recorded.
- `question_candidates_recorded`: specialist report question candidates were extracted into `.orquesta/vision/question_candidates.json`.
- `question_candidates_missing`: a specialist report was held because required `question_candidates` metadata was missing.
- `orchestrator_acceptance_decision`: the orchestrator accepted, held, rejected, or requested changes after review.

## vision/question_candidates.json

`question_candidates.json` is the raw inbox for specialist-proposed question candidates. It is not user-facing. The orchestrator writes submitted candidates here after report review; `vision-curator` filters, deduplicates, rewrites, and promotes useful entries into `questions.json`.

```json
{
  "version": 1,
  "candidates": [
    {
      "candidate_id": "QC-T124-001",
      "status": "pending_curator_review",
      "priority": "medium",
      "category": "workflow",
      "question": "Should specialist reports be blocked when they omit question-candidate metadata?",
      "why_now": "A protocol review found recent specialist reports could be accepted without proving whether useful questions existed.",
      "user_impact": "This determines whether Orquesta keeps a durable question discovery loop without flooding the user.",
      "suggested_timing": "before_next_task",
      "source_task_id": "T124",
      "source_agent_id": "protocol-architect-001",
      "source_report_path": ".orquesta/reports/T124-protocol-question-candidate-loop.md",
      "created_at": "2026-06-25T00:00:00Z",
      "curated_by": null,
      "curated_at": null,
      "curator_decision": null,
      "question_id": null,
      "notes": []
    }
  ],
  "policy": {
    "curator_agent_id": "vision-curator",
    "wake_triggers": [
      "pending_high_priority_candidate",
      "pending_candidates_gte_5",
      "pending_candidates_age_hours_gte_24",
      "candidate_blocks_acceptance",
      "user_requests_question_review"
    ],
    "default_batch_size": 8
  }
}
```

Candidate statuses:

- `pending_curator_review`: submitted by a specialist and waiting for curator triage.
- `curator_accepted`: curator decided the candidate is useful.
- `curator_rejected`: curator rejected it as low-value, unclear, or not user-actionable.
- `merged_duplicate`: curator merged it into another candidate or existing question.
- `promoted_to_question`: curator created or updated a `questions.json` entry from it.
- `retired`: stale or no longer useful.

Required candidate fields:

- `candidate_id`
- `status`
- `priority`: `low`, `medium`, or `high`
- `category`: `scope`, `design`, `workflow`, `quality`, `risk`, `roadmap`, `user_preference`, `technical_direction`, `release`, or `other`
- `question`
- `why_now`
- `user_impact`
- `suggested_timing`: `now`, `before_next_task`, `before_acceptance`, `batch_later`, or `roadmap_review`
- `source_task_id`
- `source_agent_id`
- `source_report_path`
- `created_at`

`question_candidates` is required report metadata for specialist-owned tasks. A report may use `status: "none"` instead of items, but must include a valid `none_reason`.

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

Questions generated from first-run project intake should use `setup_gate: true` and `required_for_setup: true`. The dashboard should prioritize these before ordinary vision questions. Project intake must exist before these setup questions are generated or shown. First-run setup completion stays blocked until they are answered, then setup autopilot may prepare the initial Completion Map and specialist plan without separate user approval gates.

`questions.json` should contain curated questions only. Do not write raw specialist candidates here directly; use `question_candidates.json` until `vision-curator` promotes them.

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

Approval waits are first-class user tasks. When a specialist or the orchestrator is blocked by a Codex approval, permission prompt, scope decision, destructive-action confirmation, or user-direction choice, add an open task with `source: "approval_wait"` instead of leaving the blocker only in chat.

```json
{
  "user_task_id": "UT-APPROVAL-001",
  "source": "approval_wait",
  "source_ids": ["T100"],
  "source_agent_id": "implementation-001",
  "assigned_by": "user-liaison",
  "status": "ready",
  "priority": "high",
  "title": "Approve local server restart",
  "prompt": "implementation-001 needs your approval before restarting the local server.",
  "approval_type": "codex_safety_approval",
  "requested_action": "Approve or deny the restart request in Codex.",
  "resume_instruction": "After approval, tell implementation-001 to retry T100.",
  "created_at": "2026-06-23T00:00:00+09:00",
  "resolved_at": null
}
```

Valid `approval_type` values include `codex_safety_approval`, `scope_expansion_approval`, `destructive_action_approval`, `environment_permission_approval`, and `user_direction_approval`. If the blocked Orquesta task uses `blocked_by: ["user_approval_required"]` or another approval blocker, an open `approval_wait` user task should reference that task id through `source_ids` or `source_task_id`.

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

The map should be created after project intake and required setup questions are answered. In first-run setup, Orquesta may create the initial map automatically and mark it as the current operating contract. The user can revise this map during normal operations; first-run setup should not require a separate map approval conversation.

## setup/wizard.json

The setup wizard records where the first-run guided setup currently is. It is dashboard state, not a production task list. Current first-run setup uses setup autopilot: after project intake and required answers, Orquesta automatically prepares the initial map and team, then moves to normal operation.

```json
{
  "version": 1,
  "status": "ready_for_operation",
  "current_step": "operation_ready",
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
      "step_id": "question_gate",
      "title": "必須質問への回答",
      "summary": "必要質問に答えて方向性を固める。",
      "status": "done"
    },
    {
      "step_id": "auto_finalize",
      "title": "初期セットアップ自動完了",
      "summary": "Orquestaが初期完成マップ、専門AI候補、開発ステップを自動で用意する。",
      "status": "done"
    },
    {
      "step_id": "operation_ready",
      "title": "運用開始",
      "summary": "ユーザーは必要に応じて体制や進め方を後から調整できる。",
      "status": "active"
    }
  ],
  "gates": {
    "project_intake_required": true,
    "required_questions_must_be_answered": true,
    "completion_map_requires_user_approval": false,
    "completion_map_approved": true,
    "setup_autopilot_enabled": true,
    "setup_autopilot_finalized": true,
    "specialist_plan_reviewed": true,
    "specialist_plan_approved": true,
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

Specialist Plan stores proposed production specialists after the Completion Map exists. During first-run setup, setup autopilot may mark high-priority candidates as `approve_now` automatically so Orquesta can begin operating without another approval round. It is still not a thread-creation command: sessions must not be created, specialist threads must not be messaged, and specialists must not be marked active until the orchestrator explicitly runs the next appointment or handoff step.

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
