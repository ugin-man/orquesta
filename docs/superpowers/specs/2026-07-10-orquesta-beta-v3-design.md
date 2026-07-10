# Orquesta Beta V3 design

Target version: `0.3.0-beta.0`

This spec consolidates T142 through T148. It does not describe a fully automatic agent platform. It describes the next beta of Orquesta as a file-backed control plane that can prove routing, review, fallback, and dashboard truth without pretending that repository code can control every Codex product surface.

## Direction

Beta V3 adds a control plane beside the existing orchestration layer.

The important split is this.

- Deterministic checks decide what evidence is missing, stale, invalid, or risky.
- Semantic review decides meaning, confidence, escalation, and user-facing wording.
- Product adapters may dispatch messages or request model overrides only when the Codex product exposes that ability.
- Repository fallback always exists. It records recommendations, required reviews, and manual evidence without fake automation.

This is a staged beta. The hard gates apply first to `specialist_required` and medium or high risk tasks. Low risk, narrow, report-only work may start with warnings until the rollout is tuned.

## Accepted decisions

- Beta V3 starts with repository-owned, file-backed evidence.
- Product-level Codex tool streams, model switching, and thread dispatch are optional adapters.
- Browser, visual, runtime, or acceptance-evidence weakening fallbacks require user approval.
- Home stays focused. A separate Control Plane or Audit focused view holds detailed evidence.
- Luna, Terra, and Sol routing uses task signals, not domain labels.
- Per-task question output becomes observations. Vision Curator clusters meaning before user-facing questions.
- Specialist capacity is separate from agent health and task state. A sent handoff is not proof that a specialist turn started.
- Required specialist capacity loss opens a fail-closed circuit: affected work stops, fallback is bounded, and the orchestrator may not quietly substitute itself.

## New state files

Beta V3 adds these files.

```text
.orquesta/state/control_audit.json
.orquesta/state/model_policy.json
.orquesta/state/dashboard_actions.json
.orquesta/failures/incident_candidates.json
.orquesta/failures/incident_clusters.json
```

It also extends `tasks.json` with control metadata and extends `.orquesta/vision/question_candidates.json` entries with observation values.

## Task control fields

Each task may add these fields. During the first rollout they are required for `specialist_required` and medium or high risk tasks.

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
    "recommended_model": "Luna | Terra | Sol",
    "actual_model": null,
    "confidence": "low | medium | high",
    "reason": "short reason",
    "requires_semantic_review": false,
    "required_review_model": null,
    "adapter": "repository_only | codex_product",
    "manual_evidence": null,
    "created_at": "2026-07-10T00:00:00.000Z",
    "updated_at": "2026-07-10T00:00:00.000Z"
  },
  "escalation_history": [
    {
      "from": "Luna",
      "to": "Terra",
      "reason_code": "missing_completion_evidence",
      "reason": "Completion evidence is missing before acceptance.",
      "created_at": "2026-07-10T00:00:00.000Z"
    }
  ],
  "fallbacks": [
    {
      "fallback_id": "FB-T000-001",
      "category": "browser_evidence | visual_evidence | runtime_evidence | acceptance_evidence | workflow | other",
      "quality_impact": "none | weakens_evidence | weakens_output",
      "requires_user_approval": true,
      "approval_status": "not_required | required | requested | approved | rejected",
      "reason": "short reason",
      "incident_candidate_id": null,
      "created_at": "2026-07-10T00:00:00.000Z"
    }
  ],
  "completion_envelope": {
    "status": "missing | draft | submitted | accepted | needs_revision",
    "path": null
  }
}
```

Signal meanings:

- `ambiguity`: unclear user intent, taste, scope, or acceptance meaning.
- `consequence`: cost of being wrong.
- `reversibility`: how easy it is to undo safely. High means hard to undo.
- `context_breadth`: how many state, report, protocol, or code areas must be read.
- `aesthetic_judgment`: amount of taste, visual, prose, UX, or creative judgment.
- `verifiability`: how hard it is to prove. High means hard to verify.
- `novelty`: how far the task is from known patterns.
- `failure_history`: recent retries, workarounds, stale state, encoding trouble, or blocked proof.

## Completion envelope

Specialist reports and direct exceptions use a `completion_envelope` JSON block. The report block is the source for review; the task field stores the accepted summary.

```json
{
  "completion_envelope": {
    "version": 1,
    "task_id": "T000",
    "agent_id": "implementation-001",
    "status": "submitted",
    "risk_level": "low | medium | high",
    "required_reading": {
      "status": "done | partial | blocked",
      "files": ["path"],
      "not_read": []
    },
    "delegation_evidence": {
      "routing_class": "specialist_required",
      "handoff_sent_at": "2026-07-10T00:00:00.000Z",
      "specialist_report_path": ".orquesta/reports/example.md",
      "direct_exception_reason": null,
      "bypass_review_owner": null
    },
    "model_route": {
      "recommended_model": "Terra",
      "actual_model": null,
      "confidence": "medium",
      "reason": "Multiple state files and acceptance checks were involved.",
      "adapter": "repository_only"
    },
    "changes": [
      {
        "path": "path",
        "kind": "created | modified | deleted | report_only | state_only",
        "summary": "short summary"
      }
    ],
    "verification": {
      "commands": [
        {
          "command": "npm run check",
          "status": "passed | failed | blocked | not_run",
          "expected": "short expected output",
          "evidence": "short evidence"
        }
      ],
      "browser": {
        "status": "passed | failed | blocked | not_required",
        "evidence": null
      },
      "live_thread": {
        "status": "passed | failed | blocked | not_required",
        "evidence": null
      }
    },
    "not_verified": [],
    "fallbacks": [],
    "open_risks": [],
    "question_candidates_status": "submitted | none",
    "created_at": "2026-07-10T00:00:00.000Z"
  }
}
```

Acceptance rule:

- Missing envelope blocks acceptance for staged-in tasks.
- Empty `commands` is allowed only when the task is report-only and says why.
- `not_verified` must be explicit.
- Any fallback with `quality_impact: "weakens_evidence"` or `weakens_output` must have user approval before acceptance.

## control_audit.json

`control_audit.json` is deterministic. It summarizes missing evidence and risky state. It does not ask a model to decide meaning.

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
    "warnings": 0,
    "missing_completion_envelopes": 0,
    "missing_specialist_reports": 0,
    "fallbacks_requiring_user_approval": 0,
    "incident_candidates": 0,
    "question_observation_clusters": 0
  },
  "findings": [
    {
      "finding_id": "CA-T000-001",
      "task_id": "T000",
      "agent_id": "implementation-001",
      "severity": "info | warning | blocker",
      "category": "delegation | completion_envelope | model_route | fallback | failure_intake | question_observation | session_freshness | dashboard_action",
      "code": "missing_completion_envelope",
      "message": "Task is staged-in but has no completion envelope.",
      "evidence": {
        "path": ".orquesta/state/tasks.json",
        "field": "completion_envelope"
      },
      "recommended_action": "request_report_metadata",
      "created_at": "2026-07-10T00:00:00.000Z"
    }
  ],
  "sources": [
    ".orquesta/state/tasks.json",
    ".orquesta/state/trigger_audit.json",
    ".orquesta/vision/question_candidates.json",
    ".orquesta/failures/incidents.json",
    ".orquesta/failures/incident_candidates.json"
  ]
}
```

Control audit blocker examples:

- staged-in `specialist_required` task lacks `handoff_sent_at`
- staged-in accepted task lacks `specialist_report_path`
- staged-in acceptance lacks completion envelope
- invalid timestamp in handoff, report, candidate, incident, or envelope
- fallback weakens browser, visual, runtime, or acceptance evidence without approval
- stale sessions are used for a live session claim
- staged-in required specialist work is active or accepted with only dispatch acceptance and no turn-start or report evidence
- an open capacity circuit exists while the orchestrator performs the same specialist-required work directly
- required specialist capacity is unavailable with no eligible fallback while orchestra mode remains `normal`

## Specialist capacity and circuit breaker

`.orquesta/state/capacity.json` is the source of truth for specialist execution capacity. `agents.json`, `sessions.json`, and task `state` keep their existing meanings and do not duplicate the current capacity value.

Capacity states are `unknown | probing | available | suspected_unavailable | unavailable | cooldown`. Cause is separate: `none | usage_window_exhausted | product_service_error | thread_unavailable | model_unavailable | unknown`.

Dispatch lifecycle is separate from both task and capacity state:

- `queued`: an attempt is recorded but no adapter result exists.
- `dispatch_accepted`: the product accepted the message. This is not turn-start proof.
- `turn_started`: task-correlated start or progress evidence exists.
- `progress_observed`: later task-correlated progress exists.
- `report_produced`: the expected report exists. If start telemetry was unavailable, do not invent `turn_started_at`.

One ambiguous pre-start `systemError` marks `suspected_unavailable`; it does not prove quota exhaustion. Two correlated pre-start failures within the configured window open the circuit with cause `unknown`. Cause becomes `usage_window_exhausted` only from an explicit product error or user-confirmed evidence.

Orchestra mode is derived as `normal | degraded | paused`. `degraded` means affected work is stopped but unrelated safe work or an eligible fallback remains. `paused` means the critical path needs an unavailable specialist and no eligible fallback or approved evidence downgrade exists.

While a required circuit is open, the orchestrator cannot implement the same `specialist_required` work directly. Fallback requires compatible role, independence, fresh capacity or one bounded probe, and separate requested/actual model evidence. A model mismatch may support diagnostic or fail evidence, but it cannot be the only positive acceptance evidence without approval or later qualifying review.

Cooldown expiry moves capacity to `probing`, not directly to `available`. Only a successful correlated turn start closes the circuit. Unknown capacity scope stops only the observed target; fallback candidates are checked independently.

The full transition table, evidence levels, notification suppression rules, and acceptance matrix are recorded in `.orquesta/reports/T154-protocol-capacity-gate.md` and must become deterministic tests before release.

## Model policy and routes

`model_policy.json` stores routing rules. It does not claim that the model was actually switched.

```json
{
  "version": 1,
  "updated_at": "2026-07-10T00:00:00.000Z",
  "models": {
    "Luna": {
      "purpose": "cheap and fast tracking, validation, narrow report work",
      "max_risk": "low"
    },
    "Terra": {
      "purpose": "normal implementation, protocol, and multi-file design work",
      "max_risk": "medium"
    },
    "Sol": {
      "purpose": "high ambiguity, high consequence, hard-to-reverse, broad context, or repeated failure review",
      "max_risk": "high"
    }
  },
  "signals": [
    "ambiguity",
    "consequence",
    "reversibility",
    "context_breadth",
    "aesthetic_judgment",
    "verifiability",
    "novelty",
    "failure_history"
  ],
  "rules": [
    {
      "rule_id": "MP001",
      "if": {
        "risk_level": "low",
        "context_breadth": "low",
        "verifiability": "low"
      },
      "recommend": "Luna",
      "reason": "Low risk and narrow proof."
    },
    {
      "rule_id": "MP002",
      "if_any_high": ["ambiguity", "consequence", "reversibility", "context_breadth", "failure_history"],
      "recommend": "Sol",
      "reason": "High risk signal needs deeper review."
    }
  ],
  "budget": {
    "default_start": "Terra",
    "max_concurrent_specialist_turns": 2,
    "max_concurrent_turns_per_dependency_chain": 1,
    "max_escalations_per_task": 1,
    "max_semantic_review_rounds": 1,
    "require_reason_for_sol": true,
    "record_reason_when_not_escalating": true,
    "prefer_file_backed_briefs": true,
    "handoff_mode": "delta_plus_artifact_paths",
    "thread_poll_backoff_seconds": [60, 120, 240]
  },
  "adapters": {
    "repository_only": {
      "can_switch_model": false,
      "records_recommendation": true
    },
    "codex_product": {
      "can_switch_model": "capability_detected",
      "records_recommendation": true
    }
  }
}
```

The budget is a quality-preserving scheduling policy, not a promise that the repository can read billing usage. Local Codex token counters may be cumulative or product-internal, so Orquesta records route and concurrency evidence without presenting those counters as invoice tokens.

- Sol is the default for the orchestrator's ambiguous cross-system decisions, difficult aesthetic judgment, repeated-failure diagnosis, and final high-consequence semantic acceptance.
- Terra is the default for ordinary implementation, focused repair, protocol edits, browser implementation, and integration work.
- Luna is the default first pass for deterministic audit triage, question and failure clustering, metadata checks, and narrow report normalization.
- Luna or Terra escalates to Sol only after a failed check, low-confidence result, repeated equivalent failure, broad cross-module consequence, or judgment that cannot be resolved deterministically.
- Independent work may run in parallel, but no more than two specialist turns run at once. Work in the same dependency chain remains serial.
- One semantic review round is normal. A second review requires failed evidence or a material revision, rather than routine duplication.
- Handoffs point to file-backed contracts and send only the delta. Polling uses backoff and does not repeatedly reload unchanged thread history.

Model route states:

- `proposed`: route has been calculated.
- `active`: orchestrator or adapter says the route is being used.
- `reviewed`: route was checked during acceptance.
- `deferred`: route was not applied and a reason exists.
- `unavailable`: product adapter was requested but unavailable.

## Product adapter interface

The adapter interface is optional. Repository fallback is mandatory.

```json
{
  "adapter_id": "repository_only | codex_product",
  "capabilities": {
    "thread_message_dispatch": false,
    "thread_model_override": false,
    "tool_event_stream": false,
    "thread_state_read": false
  },
  "actions": {
    "dispatch_message": {
      "supported": false,
      "input": {
        "thread_id": "opaque-thread-id",
        "message": "handoff text",
        "idempotency_key": "T000-dispatch-001"
      },
      "output": {
        "status": "sent | queued | unsupported | failed",
        "evidence": null
      }
    },
    "request_model_override": {
      "supported": false,
      "input": {
        "thread_id": "opaque-thread-id",
        "model": "Luna | Terra | Sol",
        "reason": "short reason",
        "idempotency_key": "T000-model-001"
      },
      "output": {
        "status": "applied | requested | unsupported | failed",
        "evidence": null
      }
    },
    "read_tool_events": {
      "supported": false,
      "input": {
        "thread_id": "opaque-thread-id",
        "since": "2026-07-10T00:00:00.000Z"
      },
      "output": {
        "status": "ok | unsupported | failed",
        "events": []
      }
    }
  }
}
```

Repository fallback behavior:

- Handoff prompts include recommended model and review requirement.
- `tasks[].model_route.actual_model` stays null unless there is evidence.
- `manual_evidence` can record what the orchestrator did.
- Dashboard shows "recommended, not applied" instead of pretending the thread changed.

## Incident candidates and clusters

Beta V3 separates candidates from accepted incidents.

`incident_candidates.json`:

```json
{
  "version": 1,
  "updated_at": "2026-07-10T00:00:00.000Z",
  "candidates": [
    {
      "candidate_id": "IC-T000-001",
      "status": "candidate | promoted | clustered | noise | retired",
      "event_type": "command_failure | ineffective_repeat | quality_degradation",
      "task_id": "T000",
      "source_agent_id": "implementation-001",
      "command_or_action": "short command or behavior",
      "failure_class": "environment.browser_runtime",
      "severity": "low | medium | high | blocker",
      "summary": "short summary",
      "evidence": ["short evidence"],
      "attempted_fixes": [],
      "suspected_owner": "codex | user | shared | unknown",
      "fingerprint": "local fingerprint",
      "global_fingerprint": "global fingerprint",
      "cluster_id": null,
      "fallback_id": null,
      "created_at": "2026-07-10T00:00:00.000Z",
      "reviewed_at": null,
      "review_decision": null
    }
  ]
}
```

`incident_clusters.json`:

```json
{
  "version": 1,
  "updated_at": "2026-07-10T00:00:00.000Z",
  "clusters": [
    {
      "cluster_id": "FC001",
      "status": "open | routed_codex | repair_card_ready | user_task_open | waiting | resolved | reopened | wontfix",
      "primary_class": "environment.browser_runtime",
      "severity": "medium",
      "suspected_owner": "shared",
      "candidate_ids": ["IC-T000-001"],
      "incident_ids": [],
      "related_task_ids": ["T000"],
      "occurrence_count": 1,
      "first_seen_at": "2026-07-10T00:00:00.000Z",
      "last_seen_at": "2026-07-10T00:00:00.000Z",
      "latest_evidence": ["short evidence"],
      "repair_card_id": null,
      "codex_route_task_id": null,
      "resolution_evidence": null
    }
  ]
}
```

User approval is required when the fallback weakens browser proof, visual proof, runtime proof, or acceptance proof. Lower risk candidates can stay as candidates or be closed as noise with evidence.

## Question observations

Per-task question output becomes observations before it becomes a user question. Existing `question_candidates.json` remains the raw inbox, but candidates gain observation fields.

```json
{
  "candidate_id": "QC-T000-001",
  "status": "pending_curator_review | observation | clustered | curator_rejected | merged_duplicate | promoted_to_question | retired",
  "priority": "low | medium | high",
  "category": "scope | design | workflow | quality | risk | roadmap | user_preference | technical_direction | release | other",
  "question": "raw candidate text",
  "observation": {
    "value_type": "user_emergence | operating_rule | maintenance_note | duplicate | low_value",
    "user_emergence_value": "low | medium | high",
    "decision_cluster_id": null,
    "suggested_action": "ignore | keep_as_note | curator_review | ask_user",
    "reason": "short reason"
  },
  "source_task_id": "T000",
  "source_agent_id": "agent-id",
  "source_report_path": ".orquesta/reports/example.md",
  "created_at": "2026-07-10T00:00:00.000Z"
}
```

Curator behavior:

- Do not promote individual low priority workflow candidates just because they are old.
- Cluster related observations first.
- Ask the user only when the cluster changes project direction, quality boundary, or user expression.
- Operational observations may become protocol rules without user-facing question only when they are low-risk operating rules already approved by the user.

## Dashboard actions

`dashboard_actions.json` records state-backed actions. It is not a message dispatch log unless a product adapter proves dispatch.

```json
{
  "version": 1,
  "updated_at": "2026-07-10T00:00:00.000Z",
  "actions": [
    {
      "action_id": "DA-T000-001",
      "type": "report_review | wake_defer | model_route_review | fallback_approval | incident_review | control_audit_run",
      "status": "requested | applied | rejected | unsupported | failed",
      "source": "dashboard | orchestrator | script",
      "task_id": "T000",
      "agent_id": "implementation-001",
      "payload": {},
      "result": {},
      "created_at": "2026-07-10T00:00:00.000Z",
      "applied_at": null,
      "idempotency_key": "DA-T000-001"
    }
  ]
}
```

Dashboard action rules:

- All POST actions use idempotency keys.
- Actions write only through atomic JSON APIs.
- Actions append `events.jsonl` after the state write succeeds.
- Dashboard may record wake or defer decisions, but must not automatically message agents unless adapter support exists.
- Dashboard may record model route review, but must not claim actual model switching without adapter evidence.

## Atomic JSON write API

All new write paths use a shared helper.

Interface:

```js
readJsonFile(filePath, defaultValue)
writeJsonAtomic(filePath, data, options)
updateJsonAtomic(filePath, defaultValue, updater, options)
appendJsonlAtomic(filePath, event)
recoverJsonFile(filePath)
```

`writeJsonAtomic` behavior:

- create parent directory
- read existing file if present
- write UTF-8 JSON to a temp path such as `filePath.tmp-${process.pid}-${Date.now()}`
- flush the file handle where Node supports it
- rename current file to `filePath.bak` when `backup: true`
- rename temp file to target
- remove temp on failure when safe
- return `{ status, path, backupPath, tempPath, writtenAt }`

Recovery behavior:

- If target JSON parses, use it.
- If target fails to parse and backup parses, restore backup and write an incident candidate.
- If target is missing but temp exists, parse temp and promote it only if valid.
- If neither target nor backup parses, return a blocker and do not continue acceptance.
- Do not repair Japanese text just because console output is mojibake. Read as UTF-8 and, when useful, verify with Node before rewriting.

## Deterministic and semantic boundaries

Deterministic:

- parse JSON
- validate required fields
- parse timestamps
- check handoff and report evidence
- check completion envelope fields
- check fallback approval status
- compute incident fingerprints
- count pending question observations
- detect stale sessions
- produce control audit findings

Semantic:

- decide whether a question observation helps user emergence
- decide if a fallback is equivalent in quality
- decide if a model route reason is sufficient
- decide if a report satisfies the intent of acceptance checks
- cluster similar incidents beyond deterministic fingerprints
- write user-facing repair or question text

Semantic review must write its result back to state or report. Chat-only decisions do not count.

## Migration from beta.2

Existing beta.2 state is not invalid.

Migration rules:

- Keep current `tasks.json` routing fields.
- Add new fields only when tasks are touched or staged into V3.
- Accepted legacy reports do not need retroactive completion envelopes.
- Active, `needs_review`, and new `specialist_required` tasks enter V3 gates.
- Existing `question_candidates.json` entries can be migrated by adding `observation` fields during curator review.
- Existing `incidents.json` remains accepted incidents. New intake uses `incident_candidates.json` first.
- Current `trigger_audit.json` remains foundation audit. `control_audit.json` is a separate general task audit.
- `package.json` version changes from `0.1.0-beta.2` to `0.3.0-beta.0` only in the implementation phase.
- README beta wording changes only after Gate 1 and Gate 2 pass.

Legacy reports:

- Do not fail old accepted reports only because they lack envelopes.
- If a legacy report is reopened, ask for a completion envelope addendum.
- If old task summaries mention fallback or blocked browser proof, backfill as low-confidence incident candidates only when the migration task explicitly chooses to.

## Dashboard IA

Home remains focused on current work, team shape, and user attention.

Control Plane/Audit gets its own focused view with:

- summary: blocked, needs review, evidence missing, stale, fallback used, clear
- Model Route
- Completion Evidence
- Question Observations
- Failure Clusters
- Repair Cards
- Approvals
- Dashboard Actions

Home may show P0 and some P1 notifications only:

- user approval required
- repair card ready
- fallback approval required
- completion evidence missing before acceptance
- repeated browser or runtime proof failure

Raw scores, fingerprints, report excerpts, raw question text, and raw logs stay in details.

## Security and quality constraints

- No destructive file operation from dashboard actions.
- No thread creation or message dispatch without explicit adapter capability and user/orchestrator action.
- No model override claim without adapter evidence.
- No raw user answers turned into adopted direction without Vision Curator and orchestrator acceptance.
- No raw question candidates shown as user questions without curation.
- No fallback that weakens browser, visual, runtime, or acceptance proof without user approval.
- No live session or dashboard truth claim when `sessions.json` is stale unless the warning is explicit.
- No specialist-running claim from message dispatch acceptance alone.
- No quota or usage-exhaustion claim from an ambiguous `systemError` or start timeout alone.
- No orchestrator substitution for affected `specialist_required` work while its capacity circuit is open.
- No JSON write path without atomic write helper after Phase 1 migration.
- No encoding rewrite based only on PowerShell console mojibake.

## No-fake-automation rules

- A handoff draft is not a sent handoff.
- A sent handoff is not a started specialist turn.
- A recommended model is not an applied model.
- An accepted model override is not verified actual-model evidence unless the product exposes that evidence.
- A dashboard action is not a thread message unless adapter evidence says it was sent.
- A trigger audit wake condition is not a running agent.
- A repair card draft is not a user task until accepted and mirrored.
- A completion envelope with empty verification is not proof.
- A green dashboard is not acceptance if state evidence is missing.

## Release criteria

Beta V3 can be released as `0.3.0-beta.0` when:

- atomic JSON helper is used by new control write paths
- `control_audit.json` is generated by script
- completion envelope checker exists
- report review can block staged-in missing envelopes
- incident candidate intake and cluster schema exist
- question observation fields are validated
- model policy and model route records exist
- capacity ledger, dispatch lifecycle, and circuit-breaker audit exist
- repeated pre-start failure pauses or degrades safely without orchestrator-only substitution
- dashboard Control Plane/Audit view is available and Home remains focused
- protocol and README version docs are updated
- `npm run check` passes
- browser smoke passes against a running dashboard
- one live-thread specialist flow proves handoff, turn-start evidence or its explicit telemetry limit, report, envelope, review, and acceptance
- one bounded failure flow proves repeated pre-start failure opens a circuit and prevents orchestrator substitution
- one recovery flow proves cooldown expiry enters probing and only correlated start closes the circuit
- compaction recovery can explain next actions from state only

## Rollback criteria

Rollback Beta V3 changes when:

- atomic writes corrupt or lose state
- report acceptance is blocked for legacy tasks without a migration escape hatch
- dashboard Control Plane hides Home's main workflow
- incident candidates create noisy user tasks
- model route UI implies automatic switching that did not happen
- question observations become direct user question spam
- browser smoke or `/api/state` becomes unreliable

Rollback should disable V3 gates before deleting state. Keep V3 files as inert evidence unless they are corrupt.
