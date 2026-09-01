# Orquesta V3 State Authority

This reference explains which subsystem owns each live canonical fact. It intentionally does not duplicate every JSON field. For an exact write or validator change, use the contract schema loaded by the current V5 runtime.

## Single-writer rule

Agents describe intent and return evidence. They do not patch canonical organization, placement task, or session records. Live writes go through exactly these owners:

- OrganizationStore V3: `.orquesta/state/agents.json`, `organization.json`, `formations.json`
- coordination task controller: `.orquesta/state/tasks.json`
- PlacementTaskPort V3: `.orquesta/state/placement-tasks.json`
- Codex thread snapshot projection: `.orquesta/state/sessions.json`
- SessionBindingStore V1: `.orquesta/state/session-bindings.json`
- Foundation bootstrap transaction: `.orquesta/state/project-bootstrap.json`

Runtime locks and staging artifacts live below `.orquesta/runtime/` and are controller-owned. A projection, report, Desktop view, or provider callback is not another authority.

## OrganizationStore V3

`agents.json` uses `schema_version: 3` and records durable agent identity, role version, mission, context scope, lifecycle, origin, provenance, and retirement. It does not store the current thread binding.

`organization.json` uses `schema_version: 3` and records:

- human participants;
- lines and their human-or-agent owners;
- persistent teams and memberships;
- explicit `reports_to`, `authority_over`, and `supports` relationships;
- organization policy and revision evidence;
- applied controller decision bindings.

`formations.json` uses the Formation contract for temporary work cells and inspections. A formation has a task or workflow source, scope, members, coordination mode, optional lead, targets, and lifecycle. It does not mutate the durable reporting hierarchy.

The three files commit as one OrganizationStore bundle. Do not advance one file separately. Retired and superseded agents remain historical records but are excluded from the active Desktop projection.

## Coordination task ledger

`tasks.json` is the V1 coordination ledger used by the file-backed task controller and its CURRENT/event projections. It is not Placement authority and must never be converted to the V3 Placement schema.

## PlacementTaskPort

`placement-tasks.json` is the only live authority for specialist placement work. The V3 task record binds:

- task and PlacementIntent identity;
- assigned and owning agent;
- role and purpose;
- acceptance criteria and dependencies;
- lifecycle evidence from `queued` through dispatch, work, review, acceptance, cancellation, or supersession;
- a semantic placement fingerprint.

An agent must not be provisioned without an executable assigned task. `dispatch_accepted` and `turn_started` are distinct states. Replays must preserve immutable placement identity and use revision-checked transitions.

## SessionBindingStore

`session-bindings.json` is the only live session-binding authority. Each binding records the agent, provider thread, generation, handoff evidence, rotation and ownership state, whether it accepts new work, runtime authority, visibility, and Foundation or PlacementIntent provenance.

`sessions.json` may remain as a Codex thread-list projection. A thread listing, an agent record, a send callback, or an old session registry is observation only. Operational ownership requires one unambiguous accepted and bound owner binding. Conversation send, Luca routing, recovery, and Desktop projections resolve through SessionBindingStore rather than scanning or rewriting either file directly.

The dedicated-path split is copy-only and policy-bound. A recognized predecessor may be copied to `placement-tasks.json` or `session-bindings.json` only during the exact migration admission. The old shared-path bytes remain untouched. Once the dedicated authority is ready, later foreign or contradictory content at `tasks.json` or `sessions.json` cannot override it. If a ready or already-progressed Foundation project loses a dedicated authority, the controller stops for repair instead of silently recreating empty state.

## Project bootstrap

`project-bootstrap.json` is the durable Foundation saga. It binds one project and bootstrap identity to OrganizationStore revision evidence, three Foundation session requests, and activation receipts.

Bootstrap order is fixed by the transaction:

1. initialize or verify V3 organization state;
2. initialize PlacementTaskPort and SessionBindingStore;
3. provision and persist accepted bindings for `orchestrator`, `orquesta-admin`, and `user-support`;
4. activate the Foundation agents;
5. mark the saga ready.

A repeated ready bootstrap returns a no-write result when canonical authority remains unchanged. Prepared Foundation transaction recovery and verified Foundation staging cleanup are reported conservatively as writes. Cleanup-only metadata across every store is not yet a uniform public contract. Mixed V2 or unsupported state is not rewritten automatically.

## PlacementIntent

The orchestrator or user-support supplies semantic placement intent: purpose, capability needs, scope, lifetime, requested count, coordination hint, and source. The V3 controller selects or creates roles and agents, compiles assigned tasks, updates OrganizationStore atomically, provisions sessions, and verifies the resulting bindings.

Do not ask an orchestrator to construct machine-owned IDs, hashes, revisions, timestamps, filenames, or provider metadata. Do not use legacy `organization-decisions.json`, `roles.json`, `setup/provisioning_batch.json`, Setup handlers, or direct session writes for live placement.

## Read models and historical evidence

Desktop maps and work views are read models. They may combine OrganizationStore, the coordination ledger, PlacementTaskPort, SessionBindingStore, formations, events, conversations, and reports, but they never become a competing writer.

Old Setup files, wizard projections, V2 organization schemas, migration fixtures, archived reports, and generated build output are historical or offline evidence only. They must not be imported by the live runtime or distributed as current Skill authority. The bounded V2 assessor may read legacy state without writing it.

## Other task state

Completion maps, durable user tasks, reports, runtime binding evidence, project layout metadata, and session handoff manifests retain their dedicated contracts. Read or write them only through the route that owns that outcome. They never authorize a second writer for organization, tasks, or sessions.

## Validation rules

- Resolve the exact canonical project root before any write.
- Reject symlink or path escape at controller boundaries.
- Use atomic publication, revision checks, and idempotent replay.
- Preserve accepted owners and unrelated dirty project files.
- Treat missing, legacy, partial, contradictory, or ambiguous state as a controlled classification, not permission to reconstruct it.
- Re-read through the normal product projection before claiming visible success.
