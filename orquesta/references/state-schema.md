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

## Beta V3 Task Controls

Beta V3 adds controls when a task is staged into the progressive gate. Legacy accepted tasks remain valid without backfilled fields unless they are reopened.

```json
{
  "control_signals": {
    "ambiguity": "low | medium | high",
    "consequence": "low | medium | high",
    "reversibility": "low | medium | high",
    "context_breadth": "low | medium | high",
    "aesthetic_judgment": "low | medium | high",
    "verifiability": "low | medium | high",
    "novelty": "low | medium | high",
    "failure_history": "low | medium | high",
    "risk_level": "low | medium | high",
    "reasons": ["short reason"]
  },
  "model_route": {
    "status": "proposed | active | reviewed | deferred | unavailable",
    "recommended_model": "Luna | Terra | Sol | null",
    "requested_model": null,
    "requested_model_evidence": null,
    "applied_model": null,
    "applied_model_evidence": null,
    "actual_model": null,
    "actual_model_evidence": null,
    "requires_semantic_review": false,
    "required_review_model": null,
    "reason_codes": [],
    "adapter": "repository_only | codex_product",
    "adapter_status": "unsupported | requested | applied | failed | null",
    "updated_at": "2026-07-10T00:00:00.000Z"
  },
  "completion_envelope": {
    "status": "missing | draft | submitted | accepted | needs_revision",
    "path": null
  }
}
```

`recommended_model` is not `requested_model`; a request is not `applied_model`; and an applied override is not `actual_model` without independent runtime evidence. The repository-only adapter records recommendations and `unsupported` status, but cannot switch a product model.

For staged-in `specialist_required` and medium/high-risk work, a valid report `completion_envelope`, `question_candidates`, delegation evidence, and task-scoped control audit are acceptance gates. Low-risk report-only work and older accepted tasks stay on the progressive warning path unless reopened.

## completion_envelope Report Block

Specialist reports contain a JSON `completion_envelope` block. The checker validates `task_id`, `agent_id`, delegation evidence, changed files, verification, fallback approval, timestamps, and question-candidate status against task state.

The envelope records model evidence under `model_route` and must keep requested, applied, and actual values separate. A report-only task may have an empty command list only when it explicitly says why all changes are `report_only`.

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

## control_audit.json

`control_audit.json` is a deterministic, atomically written snapshot. It reports missing or stale evidence; it does not make semantic acceptance decisions.

```json
{
  "version": 1,
  "generated_at": "2026-07-10T00:00:00.000Z",
  "generated_by": "orquesta/scripts/control-audit.js",
  "status": "clear | warnings | blockers",
  "rollout": {
    "mode": "progressive",
    "hard_gate_scope": ["specialist_required", "medium_risk", "high_risk"],
    "legacy_mode": "warn"
  },
  "summary": {
    "tasks_checked": 0,
    "blockers": 0,
    "warnings": 0
  },
  "findings": [
    {
      "finding_id": "CA-T000-001",
      "task_id": "T000",
      "severity": "info | warning | blocker",
      "category": "delegation | completion_envelope | model_route | fallback | failure_intake | question_observation | session_freshness | capacity",
      "code": "missing_completion_envelope",
      "message": "short evidence-backed message",
      "recommended_action": "request_report_metadata",
      "created_at": "2026-07-10T00:00:00.000Z"
    }
  ]
}
```

## capacity.json

Capacity is separate from task state and agent health. The ledger records evidence about whether a new specialist turn can start.

```json
{
  "version": 1,
  "policy": {
    "same_target_prestart_retry_limit": 2,
    "available_evidence_ttl_minutes": 15,
    "suspected_evidence_ttl_minutes": 10,
    "machine_unavailable_ttl_minutes": 30,
    "probe_backoff_minutes": [30, 60, 120]
  },
  "orchestra": {
    "mode": "normal | degraded | paused",
    "reason_codes": [],
    "affected_task_ids": []
  },
  "capacity_records": [
    {
      "capacity_id": "CAP-T000-001",
      "scope": {"agent_id": "implementation-001", "scope_key": "thread:opaque", "thread_id": "opaque"},
      "state": "unknown | probing | available | suspected_unavailable | unavailable | cooldown",
      "cause": "none | usage_window_exhausted | product_service_error | thread_unavailable | model_unavailable | unknown",
      "circuit": {"state": "closed | half_open | open", "generation": 0},
      "consecutive_prestart_failures": 0,
      "cooldown_until": null,
      "last_success_at": null
    }
  ],
  "dispatches": [
    {
      "dispatch_id": "DSP-T000-001",
      "task_id": "T000",
      "agent_id": "implementation-001",
      "state": "queued | dispatch_accepted | turn_started | progress_observed | report_produced | prestart_system_error",
      "queued_at": "2026-07-10T00:00:00.000Z",
      "dispatch_accepted_at": null,
      "turn_started_at": null,
      "progress_observed_at": null,
      "report_produced_at": null
    }
  ]
}
```

One ambiguous pre-start error is `suspected_unavailable`, not a quota claim. Two correlated pre-start failures may open an `unknown`-cause circuit. Cooldown expiry moves to `probing`; only correlated turn-start evidence returns capacity to `available`. A report can be late evidence without inventing `turn_started_at`.

## model_policy.json

`model_policy.json` is a file-backed recommendation policy, not a model-switch command. The current policy stores signals, MP001-MP004 rules, scheduling limits, and the repository-only adapter capability.

```json
{
  "version": 1,
  "signals": ["ambiguity", "consequence", "reversibility", "context_breadth", "aesthetic_judgment", "verifiability", "novelty", "failure_history"],
  "rules": [
    {"rule_id": "MP001", "match": {"work_modes": ["deterministic_triage"]}, "recommend": "Luna"},
    {"rule_id": "MP002", "match": {"work_modes": ["semantic_decision", "orchestration"]}, "recommend": "Sol"},
    {"rule_id": "MP003", "match": {"default": true}, "recommend": "Terra"},
    {"rule_id": "MP004", "if_any_high": ["ambiguity", "consequence", "reversibility", "context_breadth", "failure_history"], "action": "require_semantic_review", "review_model": "Sol"}
  ],
  "budget": {"max_concurrent_specialist_turns": 2, "max_concurrent_turns_per_dependency_chain": 1, "max_escalations_per_task": 1, "max_semantic_review_rounds": 1},
  "adapters": {"repository_only": {"can_switch_model": false, "records_recommendation": true}}
}
```

## dashboard_actions.json

`dashboard_actions.json` is optional and created lazily when a state-backed dashboard decision is recorded. It is not proof of a message dispatch or model change.

```json
{
  "version": 1,
  "actions": [
    {
      "action_id": "DA-T000-001",
      "type": "report_review | wake_defer | model_route_review | fallback_approval | incident_review | control_audit_run",
      "status": "requested | applied | rejected | unsupported | failed",
      "source": "dashboard | orchestrator | script",
      "task_id": "T000",
      "payload": {},
      "result": {},
      "idempotency_key": "DA-T000-001",
      "created_at": "2026-07-10T00:00:00.000Z"
    }
  ]
}
```

All control-state writes use `readJsonFile`, `writeJsonAtomic`, `updateJsonAtomic`, `appendJsonlAtomic`, or `recoverJsonFile`. The writer uses UTF-8, same-directory temp files, bounded retry where applicable, and fail-closed recovery. Do not rewrite Japanese text only because a console display looks corrupt.

## vision/question_candidates.json

`question_candidates.json` is the raw inbox for specialist-proposed question candidates. It is not user-facing. The orchestrator writes submitted candidates here after report review; `vision-curator` filters, deduplicates, rewrites, and promotes useful entries into `questions.json`.

```json
{
  "version": 1,
  "candidates": [
    {
      "candidate_id": "QC-T124-001",
      "status": "pending_curator_review | observation | clustered | curator_accepted | curator_rejected | merged_duplicate | promoted_to_question | retired",
      "priority": "medium",
      "category": "workflow",
      "question": "Should specialist reports be blocked when they omit question-candidate metadata?",
      "why_now": "A protocol review found recent specialist reports could be accepted without proving whether useful questions existed.",
      "user_impact": "This determines whether Orquesta keeps a durable question discovery loop without flooding the user.",
      "suggested_timing": "before_next_task",
      "source_task_id": "T124",
      "source_agent_id": "protocol-architect-001",
      "source_report_path": ".orquesta/reports/T124-protocol-question-candidate-loop.md",
      "observation": {
        "value_type": "user_emergence | operating_rule | maintenance_note | duplicate | low_value",
        "user_emergence_value": "low | medium | high",
        "decision_cluster_id": null,
        "suggested_action": "ignore | keep_as_note | curator_review | ask_user",
        "reason": "short reason"
      },
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
- `observation`: low-risk raw material that remains in the inbox and is not a user question.
- `clustered`: linked to a curator decision cluster before any user-facing promotion.
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

## failures/incident_candidates.json and incident_clusters.json

New failure intake is pre-acceptance. A candidate is not yet an accepted incident, repair card, or user task.

```json
{
  "version": 1,
  "candidates": [
    {
      "candidate_id": "IC-T000-001",
      "status": "candidate | promoted | clustered | noise | retired",
      "event_type": "command_failure | ineffective_repeat | quality_degradation",
      "task_id": "T000",
      "source_agent_id": "implementation-001",
      "failure_class": "environment.browser_runtime",
      "severity": "low | medium | high | blocker",
      "summary": "short summary",
      "evidence": ["short evidence"],
      "suspected_owner": "codex | user | shared | unknown",
      "fingerprint": "local fingerprint",
      "global_fingerprint": "normalized fingerprint",
      "cluster_id": null,
      "created_at": "2026-07-10T00:00:00.000Z"
    }
  ]
}
```

```json
{
  "version": 1,
  "clusters": [
    {
      "cluster_id": "FC001",
      "status": "open | routed_codex | repair_card_ready | user_task_open | waiting | resolved | reopened | wontfix",
      "primary_class": "environment.browser_runtime",
      "candidate_ids": ["IC-T000-001"],
      "occurrence_count": 1,
      "repair_card_id": null,
      "resolution_evidence": null
    }
  ]
}
```

Fingerprinting removes volatile temp paths, timestamps, thread IDs, and ports. Repeated fingerprints or proof-weakening fallbacks can create an open cluster. Same-quality fallback noise does not create a repair card. Only `open` accepted incidents or open candidate/cluster evidence contributes to an active error-concierge wake reason; mitigated and resolved history remains visible but nonblocking.

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

## User Capability Route

When a human is the strongest source of evidence, use a narrow queue item with `source: "user_capability_review"`. This route is for visual review, tacit or metacognitive judgment, credentialed judgment, or direct real-world experience. It is not a generic request to perform Orquesta work.

```json
{
  "user_task_id": "UT-CAPABILITY-001",
  "source": "user_capability_review",
  "source_ids": ["T162", "IC-T162-001"],
  "assigned_by": "user-liaison",
  "status": "ready",
  "priority": "high",
  "title": "Verify Control Plane in an external browser",
  "capability_type": "visual_review | tacit_judgment | credentialed_judgment | lived_experience",
  "evidence_gap": "The in-app Browser is unstable and cannot safely provide the required visual proof.",
  "procedure": ["Open the named local URL in an external browser.", "Check the listed behaviors.", "Reply with pass/fail and any observed issue."],
  "expected_response": "named pass/fail results plus notes",
  "resume_instruction": "Attach the user result to the task evidence, then resume review or remediation.",
  "created_at": "2026-07-10T00:00:00.000Z",
  "resolved_at": null
}
```

The blocked task stays paused until this evidence arrives or the user explicitly declines it. Do not record an automated pass, actual model, or visual proof that was not observed. The current Codex in-app Browser crash is an external tool limitation; external-browser UAT is a same-quality fallback when it checks the required named behaviors and the user result is recorded.

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
