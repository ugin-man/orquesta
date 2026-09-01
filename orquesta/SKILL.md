---
name: orquesta
description: Coordinate durable Orquesta project work across specialist Codex threads, canonical task state, handoffs, reviews, and recovery. Use for multi-agent or long-running work; do not impose orchestration ceremony on a bounded task that one owner can safely finish directly.
---

# Orquesta

Orquesta coordinates durable work. It is not a second safety harness, a mandatory checklist, or a reason to turn every edit into a multi-agent project.

## Roles

- The user owns intent, taste, priority, approvals, and final external decisions.
- The orchestrator owns problem framing, routing, dependencies, canonical coordination state, acceptance, and synthesis.
- A specialist owns only the bounded outcome and files assigned to it. It does not become another orchestrator.

Treat the user's proposed method as strong evidence, not an implementation command unless they make it a hard requirement. Challenge a weak premise when that prevents wasted work. Ask only when the answer changes the outcome, authority, or a costly irreversible choice.

## Authority

Canonical `.orquesta` state outranks chat recollection. Chat supplies new user intent; it does not silently replace file-backed ownership, task, or runtime authority.

Never infer permission for a final send, submission, publication, purchase, contract, consent, candidate activation, commit, push, release, destructive cleanup, or disclosure outside the accepted TaskIntent. Reversible local work inside the accepted boundary may proceed without extra confirmation.

For an Orquesta product/task-controller repository, use the authority under `canonical_state_root`: `.orquesta/CURRENT_ORCHESTRA.md` and its task state. V4 Desktop, old Electron UI, archived worktrees, and old handoff prose are historical evidence unless the current task explicitly selects them. Never choose an implementation target from a familiar filename alone.

## Start From the Smallest Reliable Context

When this skill is invoked in a repository:

1. Resolve `canonical_state_root` before deciding whether Foundation bootstrap applies. An explicitly supplied `canonical_state_root` (`--state-root` in CLI routes) wins over `ORQUESTA_STATE_ROOT`, which wins over the current directory. Canonicalize the path; do not infer another root from the skill installation or a sibling folder name.
2. When the resolved root contains both `.orquesta/CURRENT_ORCHESTRA.md` and `.orquesta/state/tasks.json`, use the Orquesta product/task-controller route. Read the current authority, then the exact target task and only state or files directly required by the request.
3. Otherwise, read `.orquesta/state/project-bootstrap.json` only at the exact native project root confirmed by Desktop/runtime selected-project authority. A complete V3 Foundation bootstrap is normal ready authority for a Desktop-managed project; it does not require `CURRENT_ORCHESTRA.md`.
4. Use `references/project-bootstrap.md` only after selected-project authority has confirmed that exact root and Foundation state there is absent, incomplete, or contradictory. An empty `.orquesta` directory, an empty state directory, or a missing `CURRENT_ORCHESTRA.md` alone is not bootstrap evidence. If neither task-controller authority nor selected-project authority is established, stop with an authority gap. Do not create canonical files by hand during a normal turn.
5. Determine whether the current actor is the orchestrator, a bounded specialist, or a read-only reviewer.
6. Do not reconstruct archived chats, scan all reports, refresh all audits, or launch Desktop merely to feel informed. Expand context only when the current evidence exposes a specific gap.

A missing expected canonical file is an evidence gap. A stale or contradictory file is not permission to regenerate the entire control plane.

## Choose the Lightest Valid Route

Use one route for the current bounded stage.

### Direct route

Use direct work when one owner can finish a bounded change with deterministic checks and no durable delegation, roster change, cross-task dependency, or later recovery requirement.

- Do the work and verify it.
- Do not create organization decisions, handoffs, reports, dashboards, user tasks, or new specialists merely to prove that orchestration happened.
- If a canonical task already exists, keep its material state current; otherwise do not create one for a trivial edit or status answer.

### Coordinated route

Use coordinated work when the outcome spans owners, turns, dependencies, recoverable stages, or the user explicitly asks for team orchestration.

- Compile or update one TaskIntent and one execution plan for the actual outcome.
- Keep implementation, correction, review, and QA as cycles of that task unless the outcome itself splits into independently valuable deliverables.
- Run organization preflight only when ownership, roster, role, team, or line structure may change. Reusing the current owner with no organizational effect does not require a new organization revision.
- Use the execution-policy and delegation sections of `references/orchestration-protocol.md` only on this route.

### Control route

Use control work for handoff, ownership recovery, acceptance, reconciliation, or status reporting. Touch only the canonical state selected by that operation. Do not mix product implementation into a handoff or readiness turn.

## Architecture Judgment

Use `references/architecture-reframe.md` when local patches, retries, validators, compatibility states, or reconciliation layers keep multiplying.

Look for the first point where evidence diverges from the user-visible outcome. Identify the assumption that made the current route seem reasonable. Then choose bounded repair, simplification, isolation, replacement, or removal based on the whole system.

Prefer one authority for the same fact, state transition, identity, or side effect. Passing the examples that previously failed is regression evidence, not proof that the underlying design is sound. Do not preserve an asset because effort was already spent on it.

This judgment does not require a form, option matrix, extra task, report, or user question. Update existing TaskIntent fields only when the chosen outcome or boundary materially changes.

## Bounded Specialist Contract

When routing was already established, a specialist should:

- read only the target task slice and directly referenced files;
- stay within allowed files, effects, and authority;
- implement, run the shortest meaningful checks, and report explicit gaps or risks;
- replan locally when the outcome and boundaries remain unchanged;
- stop when the assigned done signal is met.

The specialist must not scan full Orquesta state, edit coordinator-owned task/session/organization state, perform unrelated cleanup, or manufacture a completion envelope. Use `references/agent-contract.md` only when appointing or steering a specialist.

## Delegation

Use long-lived Codex threads when a role needs durable context, repeated work, or direct user refinement. Reuse an existing verified owner before adding another seat. Use subagents only for bounded tactical research, triage, or independent review when the current environment and user instructions allow them.

Use only thread tools callable in the current surface. Keep `dispatch_accepted`, `turn_started`, progress, report production, and acceptance distinct. A listed agent or accepted message is not evidence that work started.

If persistent send or wait is unavailable, continue through an honest direct route when the TaskIntent permits it, or record `manual_recovery`. Never fabricate a watcher, hidden Desktop agent, handoff, model observation, or review.

Organization changes use the PlacementIntent route described in `references/orchestration-protocol.md`. Describe the needed capability, purpose, scope, lifetime, and source; let the V3 controller compile identity, task, organization, and session records. A new line follows the current project policy. Never patch organization, task, or session files separately and never invoke legacy organization-decision or setup writers.

## State and Evidence

Write only state selected by the current route. The orchestrator or deterministic controller is the single writer for canonical coordination state; specialists return evidence.

Keep these distinctions explicit:

- local test versus independent review;
- deterministic acceptance versus visible live proof;
- provider callback versus durable projection;
- message accepted versus work started;
- candidate readiness versus activation or release.

Do not claim a broader result than the evidence proves. Preserve unrelated dirty work. For user-visible non-English state, write UTF-8 deliberately and run the repository encoding check when available. Console mojibake alone is not file corruption.

When a new project artifact has no declared location and project layout metadata exists, use `scripts/placement-resolver.js`. In-place edits and generated outputs with an already declared root do not need placement resolution.

## Reuse and External Discovery

Before creating a substantial new subsystem, decide whether a local asset, installed dependency, skill, or plugin already satisfies the need. Use live acquisition only when the TaskIntent calls for external comparison or a declared need remains unresolved after local inspection.

A found candidate is evidence, not permission to install it. License, compatibility, privacy, approval, and external-effect boundaries remain in force. Small local defects and already selected approaches do not need a reuse exercise.

## Desktop and Process Lifecycle

Use the runtime binding and product root declared in canonical state. Do not launch or relaunch Orquesta Desktop unless the user asks, project bootstrap requires it, or the current task needs visible Desktop proof. Do not substitute a browser preview for a required native window or a native window for a headless provider proof.

When starting a development server or helper process, record the exact command and process tree. Stop that verified tree at task end, interruption, or user stop, then re-query. Never terminate Codex `cua_node` merely because it is a Node process.

## Conditional References

Read only the reference selected by the current route:

- `references/architecture-reframe.md`: repeated local fixes or a suspect problem frame.
- `references/orchestration-protocol.md`: coordinated execution, delegation, organization change, acceptance, reconciliation, or session recovery.
- `references/agent-contract.md`: specialist appointment, steering, report, or compact receipt.
- `references/project-bootstrap.md`: selected-project Foundation state is absent, incomplete, contradictory, or in explicit bootstrap recovery.
- `references/state-schema.md`: exact state fields needed for a canonical write or validation.
- `references/user-support.md`: durable questions, approvals, manual actions, or user-capability review.
- `references/vision-alignment.md`: recurring taste or creative-direction ambiguity.
- `references/failure-concierge.md`: repeated environment, permission, or runtime failure.
- `references/game-production-patterns.md`: game-specific team decomposition.

Session rotation is driven only by SessionBindingStore lifecycle state plus verified handoff manifests and receipts. Compaction telemetry must enter that lifecycle as an event and must never create another ownership registry. Do not estimate compaction from chat length. Use the session-recovery section of `references/orchestration-protocol.md` only when the canonical SessionBinding lifecycle says rotation or placement recovery is pending.

## Stop Conditions

Stop and report the exact boundary when authority is unclear, ownership conflicts, an intended target escapes the accepted root, a destructive action lacks approval, a required tool or evidence path is unavailable, or new evidence changes the product outcome beyond the accepted TaskIntent.

Difficulty, elapsed time, a dirty tree, or a failed first approach is not by itself a reason to stop. Reframe, simplify, and continue when the outcome and authority remain intact.
