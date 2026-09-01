# Orquesta V5 Business: durable Work Order engine

Status: Effect V2 settlement, its journal-global cutover, restricted DispatchPacket V1 storage, receipt-closed send authorization, and provider-entry lease continuation are implemented; an unexported, disabled-by-default canonical reactor/resolver/recorded-fake stack is connected only for isolated tests, while production provider integration and every real sender remain disabled; canonical integration is not complete

Date: 2026-08-10

This document fixes the smallest production-safe aggregate, projector, command boundary, and durable outbox that can be implemented on the current `@orquesta/event-store`. The plan payload remains `BusinessWorkOrderPlanV1`; the aggregate engine contract is versioned separately.

The engine owns orchestration state. Provider threads, renderer state, workspace files, and agent messages are evidence sources, not authority.

## Implementation boundary

Implement this design in bounded commits:

1. Strict Work Order contracts and evidence-backed acceptance rules.
2. A pure Work Order decider, event-only projector, authenticated EventStore command boundary, durable command receipts, and transition tests.
3. Authenticated runtime-observation and internal-action boundaries with exact receipts, bounded dependencies, and commit-outcome reconciliation.
4. Split provider effects, a restricted packet store, provider-driver port, recorded fake provider, durable reactor, process-crash tests, and the legacy-state importer.

Do not route this work through desktop, browser, or renderer code. Do not call a provider from a projector or from the EventStore `project(entry)` callback.

The first three stages, explicit aggregate-version routing, the pure
provider-effect split, the restricted content-addressed packet store, and the
fenced Effect V2 settlement boundary are implemented under
`packages/business-orchestrator`.
Commands, provider/runtime/verifier observations, and system-only outbox lease
actions authenticate the asserted actor, re-resolve authority after CAS loss,
preflight the authoritative projector, and commit their domain events and exact
receipt in one EventStore batch. Read-side dependencies are abortable and
bounded; once a durable commit starts, response loss is reconciled by receipt
instead of being guessed. No ingress boundary can call a provider or start a
process. The separate PacketStore can create, read, and verify only canonical
DispatchPacket V1 content through a security-proving platform adapter. The
package is therefore a durable orchestration foundation, not yet a complete
provider runtime. The authenticated observation boundary can settle an exact
Effect V2 only after the journal-global settlement cutover is durable. An
unexported resolver, canonical reactor, and recorded fake now exercise that
path together under explicit test-only opt-in, including restart and recovery
fixtures. They are disabled by default, are not public ingress authorities, and
make no real provider or Codex connection. No production provider driver,
reactor, timer, or sender currently produces those inputs.

V4 remains the rollback path. V4 and Desktop do not import this package, no V4
state schema is rewritten, and no Business outbox has a sender. Reverting the
isolated V5 commits therefore restores the prior product without a data
downgrade. New Work Orders write
`business.work_order.created.payload.engine_contract_version = 2`. A historical
create event with no version is interpreted as frozen V1. V1 is replay-only:
after returning an exact existing receipt, authenticated new commands,
observations, and internal actions stop with
`BUSINESS_ENGINE_MIGRATION_REQUIRED`. The engine version cannot change within a
Work Order stream, and replay never upgrades or rewrites its events.

New V2 attempts enqueue `provider.thread.create`, then the pure transition binds
an accepted thread before enqueuing `provider.turn.start`. Frozen V1 effects
retain their historical identities but cannot be claimed by the V2 worker. A
future V1 cutover/import must be explicit and receipt-backed; it cannot disguise
an in-stream version mutation as replay compatibility.

Direct EventStore commits are a privileged internal boundary, not a product API.
V1 projector compatibility preserves already-written journals; it does not
authorize new V1-shaped writes.

The internal-action boundary exposes `outbox.claim`, `outbox.send.begin`,
`outbox.lease.renew`, and `outbox.requeue`. Send-begin remains disabled unless a
restricted PacketStore is configured and the journal-global settlement epoch is
active. A new send-begin must bind the exact PacketStore verification receipt,
Effect V2 identity, current unexpired lease, and internal-action receipt in one
batch; it still performs no provider call. The V2 send-expiration observation is
implemented separately: one authenticated batch moves the exact expired sending
effect to `delivery_unknown`, updates branch and attention state, and closes
with the dedicated provider-settlement receipt. Only isolated canonical test
fixtures exercise that path; no production timer or reactor emits it. Packet,
authority, or driver-capability failure before send uses the
separate `provider.effect.presend_failure.recorded` control-plane observation:
it proves the exact claimed Effect and lease, records `not_sent` without
provider mutation, fails the branch, and opens effect-scoped operator attention
without creating retry eligibility.

Authenticated timeout ingestion derives the exact current V2 effect from the
projection; timeout is not a uniform branch-state rewrite. An unsent start can
be cancelled locally, an ambiguous mutation remains held for reconciliation,
and an accepted operation requires exact cancellation. A production timer
reactor that produces this observation is still disabled.

## Authoritative projection

The initial projection is:

```js
{
  schema_version: 2,
  work_orders: {},
  command_receipts: {},
  observation_receipts: {},
  internal_receipts: {},
  outbox: {},
  late_observations: {},
  provider_settlement_epoch: null,
  provider_entry_windows: {}
}
```

`provider_settlement_epoch` is a journal-global compatibility boundary, not a
Work Order field. Activating it does not increment or otherwise rewrite any
Work Order revision. `provider_entry_windows` is a projector-derived
receipt-closure index keyed by Effect ID. It retains only the latest pointer;
the exact continuation history remains in immutable internal-action receipts,
and the index remains available after the lease is cleared or the Effect is
settled for authorized lookup and recovery evidence.

Each `work_orders[work_order_id]` record contains:

```js
{
  work_order_id,
  engine_contract_version, // 2 for new Work Orders; absent historical create means frozen V1
  plan_snapshot_ref,
  plan_hash,
  plan,                  // normalized immutable BusinessWorkOrderPlanV1
  revision,              // public business revision, starts at 1
  status,
  created_at,
  started_at,
  deadline_at,
  stop_reason,
  branches,
  attention,
  acceptance
}
```

For V2, the outbox effect records and their receipt-backed runtime facts are the
lifecycle authority. Branch `state`, `delivery`, and `runtime_identity`, plus
the parent `status`, are deterministic materialized views of that effect
lifecycle and immutable plan policy. A branch or parent status event cannot
independently settle an effect or create a second source of truth. The projector
checks that the views agree with the authoritative effects after each batch.

Attention is scoped to the exact effect or operation that needs recovery. A
cancel acknowledgement, for example, cannot resolve an older start effect's
delivery ambiguity. `paused` means automatic scheduling is paused; it may
coexist with an unresolved cleanup hold and does not claim that every effect is
quiescent.

The Work Order states are:

```text
starting
running
paused
awaiting_acceptance
cancelling
accepted
failed
cancelled
```

The terminal states are `accepted`, `failed`, and `cancelled`. No later observation may reopen a terminal Work Order.

Each branch record contains the immutable branch definition plus:

```js
{
  state,
  attempt,
  dispatch_id,
  attempt_started_at,
  attempt_deadline_at,
  retry_at,
  delivery,
  runtime_identity,
  open_user_input,
  result,
  verification_by_criterion,
  last_progress_at,
  finished_at
}
```

The branch states are:

```text
blocked
ready
dispatch_pending
running
waiting_for_user
verifying
accepted
retryable
delivery_unknown
cancelling
failed
cancelled
```

`dispatch_pending`, `running`, `waiting_for_user`, `delivery_unknown`, and `cancelling` consume a concurrency slot. `verifying` releases the provider-execution slot but does not satisfy dependencies.

After every applied transition, the decider recomputes the parent materialized
view deterministically:

- `cancelling` and terminal states remain sticky;
- all required branches accepted produces `awaiting_acceptance`; the final
  branch cannot become accepted until its current-result review minimum passes;
- under V2, an accepted `provider.turn.start` materializes a running branch and
  advances the parent; `work_order.started` is not a second execution authority;
- zero runnable/active branches with an unresolved blocker produces `paused`;
- otherwise the status is `running`.

Eligibility is deterministic. A branch is eligible only when every dependency is `accepted`, the Work Order is runnable, the concurrency ceiling has room, the elapsed deadline has not passed, and no active or ambiguous delivery exists for that branch. Eligible branches are ordered by topological readiness and then `branch_ref`.

## Pure decider and projector

The public functions should have no implicit I/O or clock:

```js
decideWorkOrder(state, normalizedInput, trustedFacts)
  -> { events, result }

projectBusinessEvent(projection, event, batch)
  -> nextProjection
```

`trustedFacts` supplies an already captured UTC time, the authenticated principal, resolved content-addressed records, and packet metadata. The decider must not read files, environment variables, credentials, or provider state.

Every Work-Order-scoped business event carries:

```js
{
  work_order_id,
  plan_snapshot_ref,
  plan_hash,
  source_id,
  prior_work_order_revision,
  target_work_order_revision,
  occurred_at
}
```

The two journal-global provider-settlement cutover events are the deliberate
exception. They carry the exact activation and cutover-receipt payloads instead
of pretending to belong to a Work Order.

The projector must fail closed on a plan binding mismatch, revision regression, invalid transition, mutation of an outbox effect's immutable fields, or duplicate identifier with conflicting content. Time-driven behavior is represented by explicit events; replay never compares the wall clock.

Public commands and accepted/quarantined runtime observations advance the Work Order revision once per input. Internal outbox claim and heartbeat events advance only the EventStore journal revision. This prevents operational lease churn from continuously invalidating UI commands while EventStore CAS still serializes the writes.

## Event vocabulary

Use this bounded event set:

```text
business.work_order.created
business.work_order.status_changed
business.context_budget.verified

business.branch.initialized
business.branch.attempt_opened
business.branch.status_changed
business.branch.runtime_observed
business.verification.recorded
business.review.recorded
business.acceptance.recorded
business.late_observation.quarantined
business.recovery_probe.recorded

business.outbox.enqueued
business.outbox.claimed
business.outbox.send_begun
business.outbox.lease_renewed
business.outbox.requeued
business.outbox.send_expired
business.outbox.delivered
business.outbox.not_sent
business.outbox.delivery_unknown
business.outbox.cancelled

business.command.received
business.observation.received
business.provider_settlement.received
business.internal_action.received
business.attention.opened
business.attention.resolved

business.provider_settlement.v2_activated
business.provider_settlement.cutover_received
```

Status-change events contain `{ from, to, reason }`. `business.branch.attempt_opened` contains the branch, attempt, deterministic dispatch ID, attempt deadline, and immutable dispatch-packet reference. Runtime-observed events retain the normalized observation envelope rather than an unvalidated provider payload.

## Command transitions

The trusted command processor authorizes the caller independently of the asserted `actor` field before deciding.

| Command | Preconditions | Events and result |
| --- | --- | --- |
| `work_order.start` | The Work Order does not exist; expected revision is `0`; the plan ref/hash resolves exactly; context and workspace preflight pass. | Create the Work Order at revision 1, initialize every branch, persist the context-budget receipt, and enqueue attempts for eligible roots up to `max_concurrency`. Status is `starting`. |
| `work_order.cancel.request` | Work Order is non-terminal and expected revision matches. | Move the parent to `cancelling`; cancel blocked, ready, retryable, and unsent work; enqueue cancel effects for accepted/running provider operations; retain unknown deliveries as blockers. |
| `work_order.resume` | Parent is `paused`; no unresolved delivery ambiguity or user-input request remains; limits have not expired. | Recompute eligibility, enqueue available work, and move to `running`. It cannot override `delivery_unknown`. |
| `branch.retry.request` | The named failed attempt is current and authoritatively terminal or not sent; no unknown/running effect remains; attempt and elapsed limits allow another attempt. | Open a new attempt with a new dispatch ID and enqueue its first provider effect. |
| `user_input.resolve` | The request ID identifies the single open request and the response content ref resolves with the declared hash. | Keep the request open, retain only its content ref, and enqueue a provider-input effect. Close the request only after exact accepted delivery. The response body is not journaled. |
| `acceptance.decision.record` | Parent is `awaiting_acceptance`; all mandatory branch, integration, criterion, independent-review, and attention gates pass. | Record the decision. `accepted` makes the parent terminal; `rejected` moves it to `paused` without deleting evidence. |

A timeout is not proof that a provider run stopped. `branch.retry.request` must therefore reject timed-out or delivery-unknown work until cancellation or reconciliation proves the prior attempt terminal.

## Runtime-observation transitions

Runtime observations are facts, not commands. Their `work_order_revision`
records what the producer observed; a delayed fact may still apply when its
effect, attempt, and dispatch identity are current. Otherwise it is durably
quarantined.

The table below includes pure transition semantics and historical replay; it is
not a list of callbacks that a provider may freely emit. New writes for
`provider.effect.settlement.recorded` and
`provider.effect.send_expiration.recorded`, and
`provider.effect.presend_failure.recorded` are accepted only after the durable
journal-global cutover. Legacy delivery and dispatch aliases, provider
availability signals, `work_order.started`, and unbound progress, result,
failure, cancellation, and user-input callbacks remain replay-only or withheld.
The pure decider/projector cases do not grant a provider or worker ingress
authority.

The V2 settlement envelope carries a `settlement_source` discriminator. A
`worker_result` carries the exact callback-supplied fencing token and a
content-addressed normalized worker-result reference. The boundary compares the
token with authoritative state and never substitutes the projection's current
lease. A `recovery_probe` carries no worker token; it instead binds a
content-addressed probe receipt and the exact provider mutation key. Probe use
is recorded in the durable receipt ledger and bounded by the immutable lease
policy. Sending-lease expiry is a control-plane fact with its own exact token,
expiry timestamp, and content-addressed expiry receipt.

| Observation | Pure V2 or replay transition |
| --- | --- |
| `work_order.started` | Historical V1 replay signal only. V2 derives execution from the accepted start effect instead of this aggregate-wide callback. |
| `work_order.cancelled` | Makes the parent `cancelled` only if all branches and mutating outbox effects are quiescent. Otherwise quarantine the claim and keep cancelling. |
| `provider.effect.settlement.recorded` | Post-cutover V2 ingress for one exact effect. Authenticated worker-result or recovery-probe provenance is translated through the shared certainty policy into `accepted`, `not_sent`, or `delivery_unknown`; the outbox, branch, attention, audit record, optional successor generation, probe ledger, and receipt close atomically. |
| `provider.effect.send_expiration.recorded` | Post-cutover control-plane ingress for one exact sending lease. At or after its durable expiry it records `delivery_unknown`, updates the branch and attention atomically, and quarantines a late original callback rather than guessing non-delivery. |
| `provider.effect.presend_failure.recorded` | Post-cutover system control-plane ingress for one exact claimed Effect. A content-addressed packet, authority, or driver-capability failure is recorded atomically as provider-not-invoked `not_sent`, branch failure, effect-scoped operator attention, canonical non-retry policy, and a dedicated receipt. |
| `provider.effect.delivery.recorded` | Bind one exact V2 effect ID, kind, attempt, dispatch, idempotency key, provider, classification, runtime identity, and evidence set. Thread creation stores only a thread and atomically enqueues turn start; only accepted turn start makes the branch `running`. Input and cancel effects remain distinct from branch completion. |
| `branch.dispatch.accepted` | Historical alias for final turn-start acceptance; it is not a separate lifecycle authority. |
| `branch.dispatch.not_sent` | Historical alias for an authoritative `not_sent` classification. The legacy plan policy key keeps this name, but retry eligibility comes from the exact effect result and its limits. |
| `branch.progress` | Historical replay may update current-attempt progress. Progress never renews a worker lease and never changes delivery certainty. |
| `branch.result.submitted` | Before both immutable execution deadlines, the current running attempt becomes `verifying`; only content-addressed artifact refs and evidence refs are retained. A late result is quarantined with its artifact refs. |
| `branch.failed` | Record an authoritatively terminal, provider-accepted attempt. A failure while delivery is still pending is quarantined instead of stranding an effect. Explicit retry remains possible only when the prior effect is proven not sent or the accepted attempt is terminal. |
| `branch.timed_out` | A clock fact has no uniform branch transition. The decider derives the exact current effect: an unsent pending/claimed start can be cancelled locally; a sending or unknown start stays ambiguous with effect-scoped attention; an accepted operation requires exact cancellation. Unsupported or stale combinations do not invent provider certainty. |
| `branch.delivery_unknown` | Historical alias. The exact effect remains unresolved and opens effect-scoped attention; it cannot authorize automatic retry. Current reconciliation uses the V2 recovery-probe settlement path. |
| `branch.cancelled` | `cancelling -> cancelled`; then re-evaluate parent termination. |
| `user_input.requested` | Before both immutable execution deadlines, the current running branch becomes `waiting_for_user`; retain only the content-addressed prompt ref. A response cannot resume an expired attempt. |
| `verification.recorded` | Bind the verifier, criterion, status, and evidence to the current submitted result. Failed verification makes the branch failed. Required passes accept an ordinary branch; the final branch remains `verifying` until its current-result review minimum also passes. |
| `review.recorded` | Bind authenticated verifier identity, findings, evidence, final integration branch, and the exact current result hash. Clean independent reviews release the final branch only at the configured minimum. Rejected or blocking findings fail that result and pause the parent for an explicit safe retry. Reviews of an older result remain history but cannot count. |
| `provider.rate_limited` | Future effect-bound provider evidence; it cannot itself authorize retry. |
| `provider.unavailable` | Future effect-bound provider evidence; it does not itself prove `not_sent`. |

An observation for an older attempt, a replaced dispatch, or a terminal Work
Order is retained as late evidence where the transition supports it. It never
changes branch acceptance, unlocks a dependency, or reopens the parent. A stale
V2 settlement can close only as an exact quarantine receipt; it cannot settle a
different effect generation.

The legacy turn envelopes do not carry an effect ID or runtime identity.
Historical V1 batches therefore remain projector-replayable only inside a
frozen V1 aggregate. The authenticated boundary returns an exact old receipt
before applying cutover or migration gates, then requires explicit migration
for any new V1 input. This compatibility does not let a legacy callback enter
the post-cutover provider-settlement suffix.

The active execution window ends at the earlier of the branch attempt deadline
and the Work Order elapsed deadline. V2 semantics preserve late facts without
letting them resume or satisfy the branch. Verification and review may continue
after the deadline only for a result submitted on time.

Branch acceptance is derived, not provider-reported. Resolve each branch's content-addressed TaskIntent at start and persist its required criterion IDs. A branch is accepted only after a current result and all of its required verification records pass. For multi-branch work, the integration branch must additionally cover every parent acceptance criterion. The configured review minimum is measured with distinct authorized verifier identities that are independent of the assignee and bound to the canonical hash of the current final result.

## Atomic EventStore batches

The boundary loads the business projection and EventStore watermark, decides, and submits one request:

Business EventStore instances enable the opt-in `preflightProjection` gate. The
same pure reducers validate the complete candidate batch while the journal lock
is held and before pending evidence or journal bytes are written. Command,
observation, and internal-action boundaries still prevalidate independently;
the store gate prevents a lower-level mixed-domain commit from poisoning replay.

```js
{
  expected_revision: replay.watermark.journal_sequence,
  batch_id: `business:${source_id}`,
  actor: mapVerifiedActor(authenticatedPrincipal),
  correlation_id: source_id,
  events
}
```

`source_id` is the command ID, observation ID, or deterministic internal-action ID. Event IDs are deterministic hashes of `{ source_id, ordinal, type, payload, evidence_refs }`.

The start batch is:

```text
business.work_order.created
business.context_budget.verified
business.branch.initialized × branch count
business.branch.attempt_opened × selected roots
business.outbox.enqueued × initial provider effects
business.command.received
```

A post-cutover provider-settlement batch is:

```text
business.outbox.delivered | business.outbox.not_sent | business.outbox.delivery_unknown
business.branch.runtime_observed
business.branch.status_changed
optional business.outbox.enqueued for the next provider effect
optional business.recovery_probe.recorded
optional business.attention.opened | business.attention.resolved
business.provider_settlement.received
```

The final receipt uses source type `provider_settlement`, not the generic
`observation` source. Its `settlement_bundle` binds the active cutover ID, exact
Effect V2 and mutation key, worker/probe/expiry provenance reference, effective
classification, canonical settlement-policy hash, and a hash of the complete
domain-event manifest. Worker result, recovery probe, expiry, and pre-send
failure each have a distinct bounded ingress kind and provenance reference.
The projector derives those values again and rejects a
bundle that merely repeats caller-chosen data.

A verification batch is:

```text
business.verification.recorded
optional business.review.recorded
business.branch.status_changed
optional business.branch.attempt_opened for newly eligible branches
optional business.outbox.enqueued
optional business.work_order.status_changed
business.observation.received
```

A cancellation-request batch is:

```text
business.work_order.status_changed(cancelling)
business.outbox.cancelled × pending unsent effects
business.branch.status_changed(cancelled) × inactive branches
business.outbox.enqueued × required provider cancellations
business.command.received
```

The receipt is in the same batch as every state change and outbox intent. A commit response is not required for correctness: after an uncertain response, replay either finds the receipt or finds no applied input.

EventStore uses one global journal revision, whereas CommandEnvelope uses the Work Order's business revision. On `EVENT_REVISION_CONFLICT`, reload and re-decide. Retry automatically only when the same Work Order revision still satisfies the original command; otherwise return a typed stale-work-order error. Runtime observations reload and are either applied to the exact current attempt or quarantined.

## Journal-global provider-settlement cutover

A per-Work-Order flag cannot safely separate historical receipt routing from
new settlement routing: the compatibility question is where a batch sits in the
single EventStore journal. The cutover boundary therefore commits one exact
system-authorized, two-event global batch:

```text
business.provider_settlement.v2_activated
business.provider_settlement.cutover_received
```

The resulting `provider_settlement_epoch` binds the legacy tail sequence,
activation sequence and batch IDs, complete activation-batch core hash, exact
pre-cutover projection hash, content-addressed readiness assessment, actor,
timestamp, and receipt. Readiness requires clean EventStore recovery, stopped
settlement ingress and provider reactors, no incomplete projection input, no
claimed/sending/unknown provider effect, and no unresolved legacy effect. CAS
loss causes replay, reauthorization, readiness re-resolution, a fresh
projection hash, and a fresh marker candidate.

This epoch divides replay into two durable regions:

- In the prefix, historical generic observation receipts remain replayable.
- A historical prefix `business.outbox.send_begun` without an embedded
  PacketStore verification receipt remains replay-compatible; in the suffix a
  new send-begin requires that exact receipt.
- In the suffix, settlement-sensitive events require one current V2 envelope
  and the dedicated `business.provider_settlement.received` receipt bundle.
- An exact receipt is recovered before cutover and live-write gates, so response
  loss does not turn an already committed input into a different route.

Activation changes only the global epoch; it does not mutate any Work Order
revision. It also does not enable a provider, timer, reactor, or sender. Those
components remain disabled until their own authority and crash-recovery work is
complete.

## Committed send authorization and provider-entry windows

A post-cutover `outbox.send.begin` receipt carries a content-addressed Send
Authorization Bundle V1. The bundle binds the exact `business.outbox.send_begun`
event, immutable Effect V2 identity, PacketStore receipt, operation scope,
fencing token, lease expiry, cutover ID, batch ID, and complete domain-event
manifest. The projector independently reconstructs the receipt event and event
hash closure. The stable committed proof is therefore derived from replayed
public projection data, not from an in-memory send decision or a private journal
field.

That stable proof alone does not grant provider entry forever. The projector
also materializes a Provider Entry Window for the send-begin lease. Each
same-token renewal while the Effect remains `sending` must commit one
content-addressed continuation plus its exact internal receipt. A continuation
names its immediate predecessor, prior expiry, new expiry, source event, and
receipt-backed manifest. Later unrelated Work Order revisions are allowed; the
renewal remains revision-neutral and revisions may not regress. There is no
fixed history cap: immutable receipts keep the chain while
`provider_entry_windows` points to its latest verified tip.

The internal resolver has separate authority surfaces: stable committed-send
lookup, retained read-only PEW lookup, live provider-entry authorization, and
recovery authorization. Live entry rechecks the exact current token, current
PEW expiry, authoritative projection, and trusted time. Retained lookup can
reconstruct an entry-to-current receipt chain after a lease is cleared but
cannot authorize a new mutation. Recovery additionally requires an exact
effect-bound eligibility proof and content-addressed recovery authorization
reference. All resolver reconstruction uses public
EventStore replay; the content hashes prove the supplied bytes, while replayed
projection and receipt closure establish journal membership.

These contracts currently serve the unexported test-only canonical stack. They
do not export the resolver, enable the reactor, select a production driver, or
connect to a real provider.

## Receipt idempotency

Process an input in this order:

1. Normalize the plan or envelope, authenticate the principal, and authorize
   access to its immutable Work Order scope.
2. Look up the receipt by source type and ID under that verified identity.
3. Return the stored result when the canonical identity matches, or reject
   `*_ID_CONFLICT` when the same ID has different immutable content.
4. For a new input to an existing Work Order, read its immutable engine version.
   Missing means V1; stop new V1 work with
   `BUSINESS_ENGINE_MIGRATION_REQUIRED`.
5. Verify new-input facts, plan/content bindings, and expected Work Order revision.
6. Decide and commit the receipt with the resulting events.

The receipt lookup precedes the migration gate so a frozen V1 caller can recover
the result of an operation that was already committed. It does not reopen V1
for a new write or permit an in-stream version change. Typed observation callers
make that intent explicit with `replay_only: true`; the receipt still has to
exist and match the complete authenticated identity.

The common receipt fields are:

```js
{
  source_id,
  source_type,
  identity_hash,
  payload_hash,
  work_order_id,
  applied_revision,
  batch_id,
  event_ids,
  result
}
```

Projected receipts also retain the event hashes used to close the atomic input.
Post-cutover provider settlement adds the `settlement_bundle` described above;
ordinary observations keep source type `observation` and cannot carry that
authority.

Identity includes the complete normalized envelope and the verified principal binding. An exact replay keeps its original expected revision and is resolved before the current revision check. A caller that changes any envelope content must use a new ID.

## Dispatch packet and secret boundary

Before enqueuing a provider effect, materialize a content-addressed `DispatchPacketV1` under a restricted local packet store. The packet includes the exact prompt, branch context manifest, workspace/checkpoint identity, permission ceiling, provider configuration reference, and their hashes. It never includes an API key.

Write and fsync the packet before the EventStore batch. The outbox stores only `{ packet_ref, packet_hash }` and immutable routing metadata. A crash before the batch may leave an unreferenced packet that garbage collection can remove. A missing or changed packet is a pre-send control-plane failure, not a provider callback: send-begin fails before any provider call and the reactor must never fall back to current mutable files. The dedicated post-cutover pre-send observation now closes that fact with a receipt-backed operator-attention path and explicitly no retry eligibility; any production reactor must produce that observation from trusted control-plane evidence rather than inventing provider `not_sent`. The isolated recorded-fake stack exercises the same rule without making a network call.

The current EventStore does not set restrictive file permissions or redact payloads. Consequently, raw prompt text, raw user input, credentials, provider response bodies, and unredacted progress logs must not enter its events. Sanitize `branch.progress.message` before normalization and keep detailed raw traces in a separate restricted, rotated store.

## Durable outbox and leases

Each outbox record separates immutable request data from mutable delivery state:

```js
{
  effect_id,
  effect_contract_version,
  work_order_id,
  branch_ref,
  attempt,
  dispatch_id,
  effect_kind,
  origin_source_id,
  provider_ref,
  packet_ref,
  packet_hash,
  operation_scope_hash,
  operation_generation,
  generation_predecessor_effect_id,
  predecessor_effect_id,
  predecessor_delivery_hash,
  target_runtime_identity,
  idempotency_key,
  status,
  lease,
  delivery,
  created_at,
  updated_at
}
```

`predecessor_effect_id` binds stage dependency, such as thread creation before
turn start. It is not a retry-generation pointer. Retry lineage is the separate
`{ operation_scope_hash, operation_generation,
generation_predecessor_effect_id }` tuple. Generation 1 has no generation
predecessor. A later generation must name the immediately preceding effect in
the same operation scope, and that predecessor must be durably `not_sent`.
`sending`, `delivery_unknown`, `delivered`, and `cancelled` never authorize a
successor generation.

The operation scope is content-derived. Thread and turn stages bind their
packet and accepted stage identity; cancel binds the exact target turn; user
input binds the request ID and response content reference independently of a
replaceable delivery packet. The engine never reconstructs generation order
from wall-clock timestamps or lexical effect IDs. This lets a response or
cancel be retried after proof of non-delivery while keeping later independent
user input as a new operation.

The state machine is:

```text
pending -> claimed -> sending -> delivered
                          |----> not_sent
                          |----> delivery_unknown
pending/claimed ---------> cancelled
```

Internal reactor operations are not public Work Order commands. They use deterministic internal-action IDs, system authorization, their own durable receipts, and the same EventStore CAS. The full target vocabulary is:

```text
outbox.claim
outbox.send.begin
outbox.lease.renew
outbox.lease.expire
outbox.delivery.record
outbox.delivery.reconcile
retry.timer.fire
deadline.timer.fire
recovery.probe.record
```

Claim, verified send-begin, lease-renew, and safe claimed-effect requeue are
exposed as internal actions. Send-begin fails closed without an active
settlement epoch, configured PacketStore, current unexpired lease, and exact
Effect V2 verification receipt. Exact pre-cutover send-begin receipts remain
replayable, but a new post-cutover transition must retain that receipt in its
domain event. Pre-send control-plane failure, Effect settlement,
sending-lease expiry, and receipt-backed recovery-probe reconciliation are
implemented through the post-cutover
observation boundary. The unexported canonical test stack invokes them only
through isolated recorded-fake fixtures; no production timer, reactor, driver,
or sender invokes them.

The lease contains `{ lease_id, owner_id, generation, claimed_at, heartbeat_at, expires_at }`.

- Claim only a `pending` effect.
- Claim and renewal timestamps use the immutable plan's exact
  `lease_duration_ms`; an internal worker cannot mint an unbounded lease.
- Begin send only with the current, unexpired lease token and a verified packet.
- Renew only the current token before expiry; a renewal cannot alter the request.
- A `worker_result` settlement carries the exact
  `{ lease_id, owner_id, generation }` token supplied by the callback. A result
  from an earlier worker generation cannot settle a reclaimed effect, and the
  boundary must not substitute the projection's current token.
- An expired `claimed` effect may return to `pending`, because send did not begin.
- An expired `sending` effect becomes `delivery_unknown`, because the provider call may have crossed the effect boundary.
- The expiry transition is an explicit receipt-backed
  `business.outbox.send_expired` domain event; replay never infers it from the
  current wall clock.
- The settlement reducer quarantines a stale worker result. A `recovery_probe`
  may reconcile the same effect only through its
  content-addressed probe receipt and exact mutation key.
- A future effect-bound runtime heartbeat may renew observation ownership for a provider-accepted attempt; historical `branch.progress` currently records progress only and never changes delivery certainty.

The production reactor remains disabled. The unexported test-only canonical
reactor starts only with explicit opt-in and clean EventStore recovery. It scans
the projected outbox, claims a bounded number of effects, commits `send_begun`,
obtains live provider-entry authorization, performs exactly one recorded-fake
mutation, and records the fenced structured result through the observation
boundary. This proves the local contract path; it is not a production sender
and cannot connect to a real provider.

## Delivery certainty

Every mutating provider result is one of:

```text
not_sent
accepted
delivery_unknown
```

`not_sent` requires proof that the provider mutation did not occur. Allowed evidence includes local validation or permission failure before the provider boundary, failure before any request bytes could be written, an authoritative provider rejection that guarantees no operation was created, or an authoritative settled probe that proves absence.

`accepted` requires an authoritative provider acknowledgement bound to the
effect's idempotency key, or a probe that finds the exact provider operation.
The pure V2 transition already binds the effect, stage, provider, runtime
identity, and evidence. Its public settlement envelope is implemented, but new
ingress is gated by the durable journal-global cutover and the boundary enforces
the worker-result/probe provenance rules above. Legacy dispatch aliases remain
replay compatibility, not a live settlement path.

Everything else is `delivery_unknown`, including timeouts, resets after send began, acknowledgement loss, an unclassified 5xx, reactor death while `sending`, and a crash after provider acceptance but before the local receipt commit.

Only an authoritative `not_sent` classification may make a retry eligible; the
legacy plan policy key remains `branch.dispatch.not_sent`. For a current V2
start stage, retry means a new generation of the same Effect operation: it
preserves the branch attempt, dispatch, packet, operation scope, and accepted
stage identity, while binding the new effect ID to its exact `not_sent`
predecessor. It never silently falls back to opening a branch attempt. Unknown
delivery holds its concurrency slot and permits only reconciliation. The
content-addressed probe ledger makes probe use receipt-backed, rejects reuse,
and enforces `lease_policy.max_recovery_probes`. If no authoritative answer is
available, automation pauses with attention on that exact effect.

## Provider effect splitting

A durable outbox effect must contain at most one externally mutating provider call. The current App Server execution bridge bundles `createThread`, optional naming, and `startTurn`; calling that bridge's `start()` from the durable reactor would lose the thread identity if the process crashed between those operations.

The Codex provider driver must instead expose at least:

```text
provider.thread.create
provider.turn.start
provider.user_input.submit
provider.turn.cancel
provider.thread.inspect    // read-only, safe to repeat
provider.turn.inspect      // read-only, safe to repeat
```

The implemented state machine commits the accepted thread identity and its
delivery hash in the same batch that enqueues `provider.turn.start`. The turn
effect binds the predecessor effect, predecessor delivery hash, and exact target
thread. Only accepted turn start makes the branch running. Thread naming is
either a separate idempotent effect or non-authoritative best effort after the
thread identity is durable.

The App Server adapter has `listThreads`, `readThread`, and `listThreadTurns`, so it can implement reconciliation. The SDK adapter reports those capabilities unavailable; it must fail closed for commercial durable execution until it gains an authoritative recovery mechanism.

## Cancellation and late results

Cancellation is complete only after all mutating effects are settled and every non-accepted branch is cancelled or otherwise authoritatively terminal.

- Pending effects are cancelled locally.
- Claimed effects may be cancelled before `send_begun`.
- Sending or unknown start effects must first be reconciled.
- If an uncertain start is later found accepted, enqueue a cancellation using its exact runtime identity.
- Running attempts receive a durable cancel effect.
- An ambiguous cancel blocks terminal `cancelled`; it is never treated as success.
- Accepted branch artifacts remain evidence when the parent is later cancelled.

A late result is retained under `late_observations` with its artifact/evidence refs and quarantine reason. It never replaces the current result or satisfies acceptance. No quarantined artifact may be merged without a new explicit Work Order command and plan revision.

## Crash and recovery matrix

The unexported recorded fake provider durably distinguishes `call_entered`,
`provider_accepted`, and `ack_returned`, so isolated tests can reproduce each
case without credentials, network access, or paid APIs. Passing those fixtures
does not establish production-provider conformance.

The current isolated suite restarts at six mutation checkpoints for both the
send-begin anchor and a renewed PEW, and at two recovery-probe checkpoints. It
also advances more than 64 same-token renewals and rejects a fork, missing or
forged receipt closure, stale index, legacy V1 record, and store-entry race.
These tests protect the shared chain semantics without imposing an arbitrary
history cap; the production adapter still must pass the same authority and
crash contract.

| Crash or replay point | Required result |
| --- | --- |
| Before command pending write | No state or effect; the same command may run. |
| After pending fsync, before journal append | Explicit EventStore recovery produces one batch. |
| After journal rename, before projection | Replay/rebuild restores one receipt and one set of outbox intents. |
| After projection, before pending deletion | Recovery consumes the pending evidence; no duplicate event. |
| Before outbox claim | Effect remains pending. |
| During claim commit | Recover the batch; a persisted claim that never began send may later requeue. |
| After claim, before send-begin commit | Lease expiry requeues safely. |
| During or after send-begin commit, before provider call | Conservative `delivery_unknown`; no automatic resend. |
| Provider accepted, acknowledgement not returned | Unknown, then authoritative probe resolves accepted. |
| Provider proves rejection before mutation | `not_sent`; bounded backoff may create the next attempt. |
| Provider acknowledgement returned, receipt commit not completed | Restart probes the same effect; it does not call start again. |
| Delivery-receipt commit crashes at any EventStore crash point | Recovery produces either the single durable result or the prior sending state; no duplicate dispatch. |
| Dispatch accepted, process dies before subscription | Resume/inspect using durable provider runtime identity. |
| Turn completed, process dies before result ingestion | Inspect and ingest the content-addressed result with one observation receipt. |
| Cancel before send | Pending effect is cancelled; provider call count remains zero. |
| Cancel while claimed but not sending | Prevent send-begin and cancel/requeue the lease deterministically. |
| Cancel while start delivery is unknown | Reconcile start; accepted enqueues cancel, not-sent cancels locally. |
| Cancel while running | Exactly one cancel outbox effect is created. |
| Cancel acknowledgement is unknown | Parent remains cancelling. |
| Result arrives after cancel, terminal state, or later attempt | Quarantine; parent and dependency state do not change. |
| Same command concurrently submitted twice | One batch and one receipt. |
| Same command ID with conflicting content | Typed conflict, no effect. |
| Two commands race on one Work Order | One CAS winner; loser reloads and returns stale unless receipt-idempotent. |
| An unrelated Work Order advances the global journal | Reload/re-decide against the unchanged Work Order; no duplicate outbox. |
| Attempt or elapsed limit expires | Automation stops and cleanup/cancellation begins; no infinite retry. |
| Dispatch packet is missing or has a changed hash | Fail before send as a control-plane error; never call the provider, claim provider `not_sent`, or read current mutable content. Persist operator attention before reactor enable. |
| Restart from every Work Order, branch, outbox, and lease state | Replay hash is stable and the recovery action matches this table. |

## Legacy direct-send migration

The current execution scheduler claims work and calls `adapter.start()` in the same in-memory operation. It also converts every rejected start into `attempt_failed`, even when delivery may be ambiguous. Do not insert the new reactor underneath that method and pretend its enqueue response is provider acceptance.

Migrate in four stages:

1. Shadow only the pure dispatch selection. The legacy path remains the sole sender; the durable path sends nothing.
2. Stop new legacy sends and drain or snapshot active legacy operations.
3. Import each legacy execution through a deterministic, receipt-idempotent V2
   cutover workflow. Do not append an engine-version mutation to the V1 stream.
4. Enable the durable reactor as the sole sender. Keep frozen V1 projection
   support for historical replay, never for worker claims or new actions.

Import states as follows:

| Legacy state | Durable state |
| --- | --- |
| `pending`, `eligible` | `ready` or `blocked` after dependency recomputation |
| `retry_queued` | `retryable` with the preserved due time and attempt count |
| `claimed`, `dispatching` without provider evidence | `delivery_unknown`; never resend automatically |
| `dispatching`, `running` with exact thread/turn evidence | Accepted delivery followed by provider inspection |
| `waiting_for_user` | `waiting_for_user` only when the content-addressed request can be reconstructed; otherwise attention |
| `verifying` | `verifying` with existing result/evidence refs, never accepted solely from turn completion |
| `accepted`, `failed`, `cancelled` | Corresponding terminal branch state with migration evidence |

The importer key is the legacy execution key plus attempt. Re-import is idempotent. Freeze legacy sends before importing active states; never dual-send.

## Current EventStore connection and constraints

The existing API already supplies the required local durability primitives:

- replay plus `watermark.journal_sequence`;
- global revision CAS;
- immutable batch-ID conflict detection;
- duplicate event-ID rejection;
- multi-event atomic journal batches;
- pending evidence, fsync, atomic replacement, and strict verification;
- deterministic projection rebuild;
- explicit crash and conflict recovery.

The command boundary should instantiate one EventStore with the business reducers and initial projection. On `EVENT_REVISION_CONFLICT`, it reloads the watermark and projection before deciding again. On startup it must call `inspectRecovery()` before enabling timers or the reactor. Safe explicit actions such as pending finalization or projection rebuild may run through the fixed local recovery operator; conflict, corruption, invalid pending evidence, and unproven lock ownership remain blocking user-visible incidents.

The following limitations remain:

- CAS is journal-global rather than aggregate-local, so unrelated Work Orders may cause harmless retries.
- There is no receipt lookup, outbox scan, subscription, lease, or timer API; the business package must project and poll them.
- Every commit rewrites and verifies the complete journal, limiting long-term event volume.
- The lock protocol is local host/PID oriented and is not a distributed-worker lease.
- `project(entry)` executes after projection rebuild but before pending cleanup; it is unsuitable for provider effects.
- Pending metadata is hard-coded to `.orquesta/v4/events.jsonl`, which must be migrated with a backward-readable pending protocol before V5 path names become authoritative.
- File mode, encryption, redaction, and log rotation are not supplied by EventStore.
- The atomic replacement fsyncs the file but not its containing directory; process-crash recovery is tested, but abrupt power-loss durability requires an additional directory-fsync decision per supported OS.

These constraints are acceptable for the first local single-host V5 slice only. They must be explicit in capability reporting and must not be described as distributed exactly-once execution.

## Next milestone: finish canonical integration and production cutover

The split thread-create/turn-start intent, restricted PacketStore,
receipt-closed send authorization, Provider Entry Window chain, pre-send
failure, fenced settlement and expiry observations, shared certainty policy,
recovery-probe ledger, and journal-global cutover are implemented. The
unexported resolver, canonical reactor, and recorded fake exercise these pieces
together in isolated, disabled-by-default tests. That is test scaffolding, not a
connected production provider, timer, reactor, or sender, and it does not finish
canonical integration.

Before any production reactor is enabled, complete the remaining shared
authority and adapter work:

- bind the same shared send/entry/recovery contracts to a selected production
  driver that proves its mutation-key and inspection capabilities without
  weakening PacketStore, PEW, or lease checks;
- add the effect-bound terminal turn callback that proves provider cancellation
  and closes a delivered cancel without trusting an unbound legacy callback;
- settle or reconcile every in-flight input/start effect atomically when timeout
  or cancellation wins, preserving late evidence without resuming the branch;
- refuse drivers that cannot inspect by the exact mutation key.

Execute the full crash matrix against the production adapter boundary, plus all
existing EventStore, execution-kernel, context-compiler, and
business-orchestrator tests, before any sender cutover. The recorded fake and
settlement-contract marker are not permission to skip this runtime cutover.

The first implementation should wrap the App Server adapter only after splitting thread creation from turn start. SDK and providers without authoritative inspection remain unavailable in durable commercial mode.

Commercial cutover also requires a Work-Order-sharded projection, durable snapshots,
bounded receipt/outbox archival, and compaction. The current global replay is
deterministic and adequate for an isolated foundation, but its full-map copying
and EventStore's full-journal rebuild remain superlinear as long-lived history
grows.

## Acceptance-model binding

The V1 contracts now separate criterion verification from independent result review. `verification.recorded` must match an exact content-addressed verification requirement in the plan and only `passed` records count. `review.recorded` carries bounded finding counts and is verifier-only. The trusted projector derives `verifier_ref` and `reviewer_ref` from authenticated observation actors, retains the exact integration branch, and resolves every evidence and artifact reference before constructing `BusinessAcceptanceSnapshotV1`.

Never expose the standalone evaluator directly to renderer, user, or provider data. It validates the trusted projection's structural and policy bindings; it is not an authentication boundary or an evidence store. `acceptance.decision.record` must fail closed when projector provenance, plan hashes, required artifacts, final-branch checks, or independent review evidence are missing.
