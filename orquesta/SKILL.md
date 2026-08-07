---
name: orquesta
description: Coordinate long-lived specialist Codex threads as an Orquesta production team. Use when the user wants multi-agent project management without disposable subagents, especially for game development, specialist thread appointment, context-scoped roles, user-to-specialist direct conversations, task state synchronization, dashboards, reports, blockers, approvals, and final orchestration summaries.
---

# Orquesta

Use Orquesta to coordinate a long-lived team of specialist Codex threads. Treat subagents as tactical helpers only. Treat normal Codex threads as production teammates with persistent roles, scoped context, task contracts, state reports, and synchronization back to the orchestrator.

## Core Principle

The user is not the orchestrator. The user is the originating creative authority. The orchestrator manages state, dependencies, blockers, and synthesis. Specialist threads hold domain context and may speak directly with the user when nuance matters.

Always preserve this split:
- Orchestrator: routing, contracts, state, acceptance, final reporting.
- Specialist thread: domain work, required reading, direct user refinement, report back.
- User: intent, taste, approval, final priority.

Treat the user's proposed method as a strong input, not automatically as the best implementation route unless they mark it as a hard requirement. The orchestrator may briefly translate vague intent into domain language, recommend a materially better route, or point out a costly hidden tradeoff. Ask only when the answer changes the outcome or prevents expensive rework; otherwise state the working interpretation and proceed. This is a judgment guideline, not a mandatory challenge step.

## Architecture Judgment

Use `references/architecture-reframe.md` as a judgment lens when evidence suggests that the current framing may be wrong. It is not a mandatory stage or completion gate. Do not require a form, fixed option count, new task, report, status, or schema merely to prove that reflection happened.

When the chosen approach materially changes, revise the affected existing TaskIntent fields or specialist handoff in ordinary prose before continuing. Otherwise proceed normally. A missing standalone reframe artifact must never, by itself, block a specialist, reject a report, or fail acceptance.

## Bounded Specialist Fast Path

When a thread receives a bounded production task whose routing and ownership were already established, it is an implementation specialist, not a second orchestrator.

- Read only the target task slice and directly referenced project files.
- Do not inspect the full Orquesta state, coordinator references, audit scripts, memory, or unrelated reports.
- Do not write canonical task, session, capacity, event, audit, setup, failure, vision, or `CURRENT_ORCHESTRA.md` state. The orchestrator or deterministic controller owns those writes.
- Implement the task and run the shortest deterministic checks. When `specialist_report_required` is not `false`, write one short `specialist_result` JSON block at the assigned report path with changed paths, checks, explicit gaps, and risks. Include `question_candidates` only when a useful candidate exists or the handoff explicitly requests it.
- Replan locally when evidence invalidates a step but the outcome, allowed files and effects, authority boundary, and acceptance checks remain unchanged. Report the deviation. Ask for a revised handoff only when one of those boundaries or the product direction must change.
- End after the assigned done signal. When a report and compact receipt are required, write the report before sending the receipt. Do not run delegation, completion-envelope, control, trigger, encoding, or capacity audits.

For report-producing work, the acceptance controller expands `specialist_result` into the canonical completion envelope, adds observed handoff and model evidence, performs independent acceptance, and synchronizes state once. Existing full completion envelopes remain supported for compatibility. The report acceptance reconciler does not handle explicitly report-free work. That task's assigned transport or controller must validate its canonical done signal and durable evidence before changing task state; if no such controller is available, use `manual_recovery`. Do not invent a report or completion envelope.

## Execution Policy and Delegation Gate

Classify a Phase 1.5 task once into `fast`, `standard`, or `critical` before implementation. Store the deterministic Execution Plan in canonical `.orquesta/state/tasks.json`, then run the Delegation Gate against that task's `canonical_state_root`, not a worktree snapshot.

- `fast` uses `inline_verified`: one owner or orchestrator, deterministic checks, no handoff and no review report. It is a normal Phase 1.5 route, not a legacy direct exception.
- `standard` uses one implementation owner and one independent review.
- `critical` uses one owner, up to two independent reviews, and optional QA when the semantic risk requires it.
- Review, correction, and QA are `execution_cycles` on the same task. Do not create `R`, `F`, or `RR` auxiliary task entries for a Phase 1.5 task.
- If a V1 lane budget or meaning-level verification is no longer sufficient, escalate the same Execution Plan. In V2, treat `max_correction_batches` as a replanning threshold: revise the same plan with reason code `correction_threshold_replanned` and continue only while TaskIntent, authority, effects, `execution_mode`, and `review_intensity` remain unchanged. Ask the user when one of those boundaries changes. Do not silently downgrade a plan.

Tasks without `execution_policy_version: 1` remain on the legacy gate. A legacy `direct_exception` still requires `direct_exception_reason` and is only for a genuine emergency or narrow orchestration work; it is not the normal fast route.

This rule survives context compaction by relying on canonical task state, not chat memory. Record the completed cycles, completion evidence, and token coverage as `unknown`, `partial`, or `complete`; do not claim a total when it is not measured.

## Phase 2A and 2B

Phase 2A and 2B add bounded acquisition, source-bound Audit, Codex-harness Audition, and correlated runtime evidence. Read the matching sections of `references/orchestration-protocol.md` only when acquiring or auditing a capability, preparing install authorization, or evaluating runtime evidence. The Codex harness is the runtime safety boundary; Orquesta does not add a second sandbox or approval system. App Server, SDK, and repository-only paths keep dispatch acceptance separate from turn start, install authorization separate from candidate discovery, and requested model identity separate from `actual_model`. Orquesta V4 Desktop is the primary operating surface.

## Startup

When Orquesta is invoked in a repository:

1. Read `.orquesta/CURRENT_ORCHESTRA.md`.
2. If it is missing, use `references/initial-setup.md`. Bootstrap may create missing canonical state, launch Orquesta Desktop for the selected root, and run the foundation trigger audit as that protocol requires. Resume incomplete bootstrap from `.orquesta/setup/options.json`.
3. If it exists, treat the turn as an existing-project normal turn. Read only `CURRENT_ORCHESTRA.md`, the target task in `.orquesta/state/tasks.json`, and state directly required by the user's request. A missing expected canonical file is an evidence gap; do not silently recreate setup or state during a normal or read-only turn.
4. On an existing project, do not launch or relaunch Orquesta Desktop unless the user asks for it, the task is Desktop or setup work, or current evidence says that a required Desktop surface is unavailable.
5. Run or refresh the foundation trigger audit only when routing or waking `user-support`, checking foundation readiness, or resolving missing, stale, or contradictory trigger evidence. Otherwise use the existing audit only when it is task-relevant.
6. Refresh `.orquesta/state/sessions.json` from callable thread tools only when the task concerns agents, threads, live state, or the dashboard, or before making a live ownership or visualizer claim.
7. Read only the applicable sections of `references/orchestration-protocol.md`, and only for bootstrap, appointment or delegation, live completion or resume, acceptance or reconciliation, organization change, direct-specialist synchronization, or user-support and failure routing. A bounded status query or an already-scoped specialist task does not require the full protocol.
8. Use `references/agent-contract.md` only when appointing or steering a specialist thread. Use `references/user-support.md` only when its trigger route is relevant.

These conditional startup rules do not relax hard boundaries: file-backed canonical state outranks chat; stop on unclear authority, a destructive action without its required approval, or a concurrent ownership conflict; keep `dispatch_accepted` separate from `turn_started`; keep `actual_model` null without runtime observation evidence; and never infer authority for a final external send, submission, publication, purchase, contract, or consent.

Judge external-action authority by the actual target, data, and effect, not by labels such as typing, upload, or draft save. A task-authorized reversible intermediate step may proceed when it stays within the approved TaskIntent and does not itself disclose unapproved data or finalize an external action. An upload that is itself an unapproved external disclosure still requires authority. Final send, submission, publication, purchase, contract, and consent remain user-controlled.

## Bootstrap Foundation

On first setup, create only `orchestrator`, `user-support`, and `orquesta-admin` as foundation roles, then derive production specialists from executable work. Use ASCII machine IDs and human-readable Japanese task titles. All setup, naming, and idempotent provisioning details live in `references/initial-setup.md`.

## Thread Model

Use long-lived Codex threads when a role needs durable scoped context or direct user refinement. Use subagents only for bounded, short-lived, read-heavy exploration, triage, log review, or independent checks. Reuse an existing owner before creating another seat.

## Event-Driven Orchestrator Resume Loop

<!-- ORQUESTA_EVENT_WAKE_CONTRACT_V1 -->

Choose `wait_threads`, report-backed `compact_receipt`, or honest `manual_recovery` from tools actually callable in the current surface. Record the transport and done signal in the handoff. Process the first real completion or attention event, reconcile only that branch from durable evidence, and immediately start its review, correction, or newly unblocked work while other branches continue. Never treat a receipt as completion evidence, claim an unavailable watcher is running, or declare project completion while required branches remain live. The detailed loop and compact receipt schema live in `references/orchestration-protocol.md` and `references/agent-contract.md`.

## Orquesta Admin

`orquesta-admin` owns Orquesta setup, Desktop handoff, diagnostics, option packs, and configuration. It does not own project production or raw user-answer interpretation. Use `references/initial-setup.md` for its workflow.

## Direct User Conversations

Direct specialist conversation is allowed. Preserve the user's nuance and return changed direction through the assigned report or done signal so the controller can update canonical directives; the specialist must not edit coordinator-owned state. See `references/agent-contract.md`.

## Vision Alignment

Use `.orquesta/vision/` when work depends on taste or recurring creative feedback. Specialists propose useful questions; `user-support` curates durable cross-task ambiguity; the orchestrator owns the live conversation and adoption. Omitted question metadata is valid unless the task explicitly requires a question decision. Use `references/vision-alignment.md` only on this route.

## Failure Concierge

Record repeated environment, permission, tool, or runtime failures under `.orquesta/failures/`; do not silently repeat the same ineffective fix. Wake `user-support` only when evidence reaches the route's trigger or a quality-lowering fallback needs user knowledge. Use `references/failure-concierge.md` on this route.

## User Support

`user-support` is one long-lived support desk for useful questions, answer interpretation, failure clustering, approvals, and user-side repair tasks. Durable waits belong in `.orquesta/user_tasks/queue.json`, never only inside a specialist chat. Relay only a canonical `ready` wake request; preserve `manual_recovery` instead of starting a hidden watcher. Use `references/user-support.md` on this route.

## Proactive Reuse Discovery

Before a non-trivial task creates a new subsystem, dependency, tool, visual system, data pipeline, or implementation approach, decide whether existing assets could materially shorten or improve the route. This is a semantic orchestration decision, not a keyword-matching rule.

1. Derive structured Capability Needs from the TaskIntent using the task's actual outcome, constraints, and acceptance checks. Do not expand a keyword catalog to imitate semantic judgment. Unusual specialists and domains must use the same Capability Need contract.
2. Give each open Need an `acquisition_mode`: `internal_only`, `local_only`, `external_if_missing`, or `compare_external`.
3. Check repository assets, installed packages, available Codex skills/plugins, and recorded local inventory first.
4. Use live Acquisition only for an unresolved `external_if_missing` Need after a local miss, or for an explicit `compare_external` Need. Keep the existing limit of eight requests per Need, two per connector, and three candidates.
5. Compare reuse, thin adaptation, and build. A found candidate is evidence, not an instruction to install or use it. Existing Codex approval, license, compatibility, and external-effect boundaries still apply.
6. Persist the discovery status and reason in the Task Profile. If discovery is skipped, record why.

Skip live discovery for a bounded local defect, a small edit within an already selected approach, a satisfied or superseded Need, a permission or human-judgment-only Need, or when the user has already fixed the asset choice. Missing semantic decomposition is not evidence that no reusable asset exists: declare the Need or record that the task is too small to justify discovery.

## Appointment Rule

### New artifact placement

When `.orquesta/project/layout.json` and `lifecycle.json` exist, resolve a genuinely new project artifact before creating its path. Do not run this for an in-place edit to an existing file or for a generated output whose root is already declared.

Use the artifact's target component and nature, never the specialist role name:

```powershell
node "<orquesta-skill-root>\scripts\placement-resolver.js" --root <project-root> --task-id <task-id> --component <component-id> --name <file-name> --artifact-kind <kind> --authority-intent supporting --audience mixed --retention project --proposed-path <relative-path>
```

Use the proposed path only when the decision status is `proposed`. Status `inbox` means write to the returned task-scoped `workbench/inbox/<task-id>/` path and leave the warning for completion review. Status `blocked` means stop. Supersedes candidates are review hints only; never retire or delete the old source automatically. The acceptance reconciler runs the lightweight completion hook and blocks only project-path escapes or canonical claim conflicts.

### Limited Context V2 handoff

Before a specialist handoff, run `scripts/context-v2-route.js --mode limited` only when the task profile has a ready `context_requirement` and a `context_pack_id`. A missing input remains on V1 `required_reading`. If the route falls back, keep V1; only a passed route may pass selected refs and the Broker to the specialist. Do not scan beyond the catalog.

Before creating or steering a specialist thread, define:
- `role`
- `mission`
- `required_reading`
- `excluded_context`
- `allowed_files`
- `forbidden_actions`
- `acceptance_checks`
- `done_signal`
- `completion_transport`
- `orchestrator_thread_id` when `completion_transport` is `compact_receipt`
- `requires_user_approval`

If an existing specialist can do the work, reuse that thread. The organization preflight may autonomously split a task, add a member, add a role, assign a lead, or permanently transfer an agent between existing lines. Creating a new line is the only Orquesta organization change that requires product-level user approval. Codex harness approvals remain separate and are never bypassed. Temporary cross-line assignments are forbidden.

Persistent thread creation follows the project's runtime binding:

- In `codex_hosted`, create the Codex task with the callable Codex thread tool from the selected Codex project before dispatch. Record the returned thread ID in canonical `sessions.json` and the provisioning request. Desktop may send only after that ID is bound and visible in the selected project.
- If the required Codex thread tool is unavailable, record `manual_recovery` or a visible provisioning blocker. Do not ask Desktop to create a hidden persistent task and do not fall back to standalone.
- In `standalone`, Desktop may create the persistent thread through its owned App Server and records it as `desktop_only`.

Before non-trivial production work, persist the preflight result in `.orquesta/state/organization-decisions.json`. Apply approval-free organization decisions through the atomic organization transition instead of merely describing them in chat. `add_member` and `add_role` must include an executable task-bound provisioning request. In `codex_hosted`, bind the Codex-created thread ID before Desktop dispatch; in `standalone`, the Desktop adapter may create it. For `propose_line`, create one `approval_wait` user task and leave the proposed line out of `organization.json` until the user approves it.

## State Rule

The source of truth is canonical `.orquesta` state, not chat history. Read and write only the files selected by the current route; use `references/state-schema.md` for the file inventory and field contracts. A specialist task cannot become `accepted` before its handoff and assigned evidence pass target-scoped checks. A report path is required only when `specialist_report_required` is not `false`. Keep reports short and link artifacts instead of copying large outputs into chat.

When writing user-visible non-English text into `.orquesta` state, protect encoding explicitly. Prefer `apply_patch`, UTF-8-aware script files, or Unicode-escaped JavaScript literals over shell here-strings. Run `npm run check:encoding` when available after state writes. Repeated literal question marks, Unicode replacement characters, and strong mojibake signatures are failures. Inline-code examples are exempt only in Markdown or a verified hash-protected handoff conversation tail. Never rewrite a handoff manifest merely to satisfy the validator.

## Session Generation Rule

Long-lived agents keep a stable `agent_id` but rotate the underlying Codex thread when repeated context compaction makes the session unreliable. The project-local `PostCompact` hook writes `.orquesta/state/session-rotation.json`; do not estimate compaction count from chat length.

- At 12 compactions, keep working but ensure canonical task state and evidence are current.
- At 15 compactions, rotate at the next completed turn or other safe boundary.
- At 20 compactions, accept no new production work until rotation finishes. Never interrupt a tool call, file write, state transition, or approval wait.
- A successor uses a fresh thread, the same `agent_id`, and `session_generation + 1`. Do not fork the degraded transcript.
- The predecessor remains the owner until the successor reads the handoff manifest and returns a valid structured receipt. Failure preserves the predecessor owner and marks the candidate failed.
- Desktop performs this transition automatically when it is running. Without Desktop, the hook still persists the threshold and warns the active agent; reconcile the pending transition on the next Orquesta control turn using available Codex thread tools. Never claim an unavailable background controller is watching.
- In `codex_hosted`, Desktop never creates the successor task. It records `.orquesta/state/session-rotation-recovery.json` with `status: "manual_recovery"`. Create the successor with the callable Codex thread tool in the selected project, then bind the returned ID with `node "<orquesta-skill-root>\scripts\session-rotation-bind.js" --root <project-root> --agent-id <agent-id> --thread-id <thread-id> --expected-generation <generation>`. Desktop validates that the task is visible in that exact project before sending the handoff; an unavailable tool or failed visibility check preserves the predecessor owner.
- For a legacy seat that is outside the selected Codex project or absent from `session-rotation.json`, first run `node "<orquesta-skill-root>\scripts\session-placement-prepare.js" --root <project-root> --agent-id <agent-id> --expected-generation <generation>`. This imports only the canonical active owner, marks a placement rotation pending without stopping new work, and creates the exact `manual_recovery` request. It must reject a stale generation, multiple owners, a conflicting registry owner, or a seat already bound to the current runtime.
- In Desktop, all verified generations of the same `agent_id` are one logical conversation. Send only to the verified active owner; old generations are read-only provenance.

Treat `.orquesta/state/session-rotation.json` and `.orquesta/state/session-handoffs/**` as canonical session-health evidence. Conversation tail in a V4 Fast handoff is bounded raw provenance, not a new long-term-memory system; richer tacit-memory retrieval remains V5 work.

## Desktop And Diagnostic Dashboard

Orquesta Desktop is the primary operating surface. When Startup selects Desktop work, open it with the selected repository:

```powershell
node "<orquesta-skill-root>\scripts\desktop-launch.js" --project-root "<project-root>"
```

Resolve `<orquesta-skill-root>` to this skill's absolute directory. The launcher passes `--orquesta-project <project-root>`; stop on a missing Desktop executable and never substitute the operating system's default browser. The web dashboard is diagnostic-only and requires an explicit request. Before browser delegation, apply current TaskIntent, project policy, `forbidden_actions`, live stop state, and manual-only constraints, then let the browser-control skill bind only an allowed browser/tab. Verify `/api/state` belongs to this project. Full setup and dashboard steps live in `references/initial-setup.md` and `references/orchestration-protocol.md`.

## References

- `references/orchestration-protocol.md`: conditionally routed operating sections; read only the section selected by Startup.
- `references/architecture-reframe.md`: lightweight judgment lens for questioning a failing route without adding a mandatory gate.
- `references/initial-setup.md`: first-run setup, Orquesta Admin, dashboard handoff, and option packs.
- `references/agent-contract.md`: appointment and report templates.
- `references/state-schema.md`: JSON state shape.
- `references/game-production-patterns.md`: default roles and context split for game development.
- `references/vision-alignment.md`: event-driven question curation and vision-document adoption.
- `references/failure-concierge.md`: event-driven failure logging, user-side repair cards, and fallback quality gates.
- `references/user-liaison.md`: user-side task queue, liaison boundaries, and coordination of vision/failure user asks.
