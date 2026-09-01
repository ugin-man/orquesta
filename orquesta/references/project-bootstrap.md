# Project Bootstrap

Use this route only after Desktop/runtime selected-project authority has confirmed the exact native project root and V3 Foundation state at that root is absent, incomplete, or contradictory. An empty `.orquesta` directory, missing task-controller authority, or missing `.orquesta/CURRENT_ORCHESTRA.md` does not by itself prove that bootstrap is required. If selected-project authority is unavailable, report an authority gap instead. Bootstrap is a package-owned transaction, not an onboarding wizard and not a collection of files for an agent to assemble manually.

## Outcome

After a successful `project.bootstrap` operation:

- the selected native folder is bound as the exact project root;
- OrganizationStore V3 owns `agents.json`, `organization.json`, and `formations.json`;
- PlacementTaskPort owns `placement-tasks.json` while the separate coordination controller retains `tasks.json`;
- SessionBindingStore owns `session-bindings.json` while `sessions.json` may remain a Codex thread projection;
- `orchestrator`, `orquesta-admin`, and `user-support` each have an accepted Foundation session binding before any Foundation agent is activated;
- `project-bootstrap.json` records the durable bootstrap saga;
- a repeated call is a no-write success.

The project may open without a forced questionnaire. The user explains the work in normal conversation. Additional specialists appear later through PlacementIntent when the work actually needs them.

When `project-bootstrap.json` is complete and all three Foundation bindings are accepted, treat that state as ready. Do not create `CURRENT_ORCHESTRA.md`, repeat bootstrap probes, or search unrelated history to compensate for its absence.

## Required Route

1. Resolve the exact native project root from the selected project authority. Do not infer another checkout from a similar folder name.
2. Call the Desktop/runtime `project.bootstrap` operation with no renderer-supplied root path. The runtime derives the root from its selected project authority.
3. Let the bootstrap classifier distinguish `fresh`, `ready`, `incomplete`, `partial`, `mixed_v2`, and `unsupported` state.
4. For `fresh` or resumable `incomplete` state, let the package transaction initialize or continue the V3 organization, PlacementTaskPort, SessionBindingStore, and saga.
5. Require accepted Foundation bindings for all three Foundation agents before activation.
6. Re-read through the normal repository projection. Do not treat the operation result alone as visible proof.

Do not create or repair `agents.json`, `organization.json`, `formations.json`, `tasks.json`, `placement-tasks.json`, `sessions.json`, `session-bindings.json`, or `project-bootstrap.json` directly. Do not invoke Setup handlers, provisioning batches, organization-decision scripts, or legacy migration writers. If `project.bootstrap` is unavailable, record an explicit recovery gap; do not synthesize partial state.

## Foundation Roles

Machine-readable Foundation IDs are fixed:

- `orchestrator`: frames work, routes dependencies, and accepts results.
- `orquesta-admin`: owns Orquesta configuration and repair.
- `user-support`: translates user-facing needs and Desktop operations without making product decisions for the user.

The three accepted bindings are a bootstrap invariant, not a demand that all three agents continuously perform work. Operational status may be standby after activation.

## Existing And Legacy State

- `ready`: return success without rewriting or replacing verified owners.
- `incomplete`: resume only the recorded saga steps and preserve already requested or accepted bindings. A missing Session authority may be created only before the first Foundation request is recorded. Once any request has started, missing Session authority is a repair condition rather than permission to recreate it.
- `partial`: stop with the specific missing or contradictory authority; do not guess.
- `mixed_v2`: stop and use the bounded offline V2 assessment or explicit migration task. Never migrate during an ordinary bootstrap call.
- `unsupported`: preserve state and report the contract conflict.

When the dedicated Placement or Session authority already exists, its former shared-path file is ignored. When the dedicated file is absent and the shared-path file is an exact recognized predecessor, the store may copy it under its dedicated name; it never renames or deletes the predecessor during bootstrap. Missing dedicated authority after Foundation completion is always `repair_required`.

`no_write: true` guarantees that the canonical authority was not changed during that invocation. Foundation recovery and deletion of a verified Foundation staging candidate are reported conservatively as `no_write: false`, even when the final outcome is a repair or migration stop. Cleanup-only metadata in every store is not yet exposed uniformly; do not reinterpret this field as a complete filesystem-diff receipt.

The V2 assessor is read-only evidence tooling. It is not a live writer and its schemas are not current runtime authority.

## Desktop And Processes

Do not launch Desktop merely to initialize files. Launch it only when the user asks, the callable bootstrap surface requires it, or visible native proof is part of the task. If a task-owned server or helper is started, record its exact process tree and stop that verified tree at task end. Never terminate Codex `cua_node` as part of Orquesta cleanup.

## First Work

Once bootstrap is ready, compile the user's first executable work through the ordinary direct or coordinated route. Do not create specialists speculatively. When durable delegation is justified, express a PlacementIntent and let the controller own the task, organization, and session transaction.
