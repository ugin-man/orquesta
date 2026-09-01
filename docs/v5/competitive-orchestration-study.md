# Orquesta V5 Business: competitive orchestration study

Date: 2026-08-10

This study compares current official product documentation and source repositories. It is an implementation decision record, not a claim that recorded or mocked benchmarks prove Orquesta is better than a live competitor.

## Decision

Orquesta Business should not become another agent harness or group-chat framework. Codex, Claude Code, OpenCode, OpenHands, and future remote agents remain execution providers. Orquesta owns the control plane above them:

- turn a user goal into an explicit, reviewable work order;
- assign bounded branches to provider-neutral specialists;
- compile a different minimum context pack for each branch;
- isolate writable branches and checkpoint their workspaces;
- persist commands before external effects;
- recover without resending work whose delivery is unknown;
- collect artifacts, diffs, tests, and independent review evidence;
- accept the parent result only after integration and verification pass.

The target is therefore **T3-like provider and workspace control, Cloudflare/Temporal-like durability, LangGraph-like branch checkpoints, and stronger Orquesta-owned context and acceptance semantics**.

The repository now contains the provider-neutral Work Order contract, pure
decider/projector, authenticated command and observation ingress, and a
system-only lease-action boundary. New Work Orders explicitly select aggregate
engine contract V2; a missing version is frozen V1 replay, never an implicit
stream upgrade. Exact historical receipts still replay, then any new
authenticated V1 command, observation, or worker action stops with migration
required (`BUSINESS_ENGINE_MIGRATION_REQUIRED`). The pure V2 model splits
thread-create from turn-start and binds each
successor to its exact predecessor and runtime identity. Outbox effects
and receipt-backed runtime facts are the lifecycle authority; branch and parent
statuses are materialized views, and recovery attention is effect-scoped.

It now has a public restricted, content-addressed DispatchPacket V1 store that
verifies canonical packet bytes, the exact Effect V2 identity, authority and
effect ceilings, and durable platform-adapter proofs before producing a
redacted verification receipt. A post-cutover, system-authorized send-begin can
now bind that exact receipt and an unexpired fencing token atomically, but it
performs no provider call. Public provider settlement now has an effect-bound V2
envelope, callback-owned fencing or content-addressed recovery-probe provenance,
atomic sending-lease expiry, and a durable probe ledger. New settlement writes
remain disabled until a
journal-global, readiness-backed cutover marker is committed. After that marker,
the projector requires the dedicated `provider_settlement` receipt source and a
bundle binding the exact effect, provenance, shared policy, and complete event
manifest. Packet, authority, and driver-capability failures before a provider
call also have one system-only, effect-bound, receipt-backed path that opens
operator attention without granting retry. An unexported, disabled-by-default
canonical reactor, a resolver constrained to the public EventStore replay port,
and a recorded fake are connected only inside isolated durability and crash
tests. They use the same
receipt-closed send authorization, Provider Entry Window continuation,
settlement, and recovery contracts without contacting a real provider or Codex.
The package still has no connected production driver, reactor, timer, or sender;
canonical integration is not complete. These are intentional safety gates, not
evidence that the live multi-agent product is finished. V4 and Desktop neither
import nor depend on the Business package, so the existing rollback path remains
untouched.

## Competitive comparison

| System | Strongest layer | What to adopt | What not to adopt as Orquesta's core |
| --- | --- | --- | --- |
| [T3 Code](https://github.com/pingdotgg/t3code/blob/main/docs/internals/overview.md) | Local control surface for several coding-agent providers | Provider driver registry, serialized commands, atomic command receipts, server-owned state, Git turn checkpoints, permission translation, structured local tracing | Browser/mobile/relay surfaces; project-thread-turn as the complete Business domain; provider-specific permission names in public contracts |
| [Cloudflare Agents and Workflows](https://developers.cloudflare.com/agents/concepts/workflows/) | Managed durable actors, waits, retries, schedules, and large-scale execution | Durable identity, persist-before-effect, durable approval/wait states, isolated ephemeral sandboxes, short-lived credential proxy, external artifact storage | Durable Objects or Workflow step names in domain contracts; automatic retry of ambiguous provider delivery; Workflow retention as the audit ledger; sandbox filesystem as canonical state |
| [Temporal](https://docs.temporal.io/workflows) | General durable execution and deterministic replay | Workflow/effect separation, durable timers and messages, bounded Activity policy, heartbeat/lease concepts, explicit workflow versioning | A required desktop dependency; Event History as Orquesta's business ledger; the assumption that an Activity cannot execute its side effect more than once |
| [LangGraph](https://docs.langchain.com/oss/javascript/langgraph/persistence) | Stateful graph runtime with checkpoints and human interrupts | Per-branch pending writes, resume/fork from checkpoints, per-invocation subgraph state, durable human interrupts | A new graph DSL as Orquesta's public model; side effects outside idempotent tasks; a hosted trace/session as canonical state |
| [Microsoft Agent Framework](https://learn.microsoft.com/en-us/agent-framework/workflows/) | AutoGen successor with typed workflows and superstep checkpoints | Storage ports, fan-out/fan-in checkpoints, typed routing, compatibility tests for alternative executors | Its cloud durability stack as a required V5 authority; experimental Magentic or autonomous routing for deterministic work |
| [Google ADK](https://adk.dev/workflows/collaboration/) | Agent development kit with graph collaboration and isolated session branches | Parent-selected context, per-branch sessions, typed result events/artifacts, resume that skips completed branches, context compaction receipts | ADK Session as canonical state; Gemini cache in the domain model; tool execution treated as exactly once; experimental confirmation as commercial approval |
| [CrewAI](https://docs.crewai.com/en/concepts/flows) | Autonomous crews inside event-driven flows | Deterministic outer flow with small pockets of agent autonomy; provider-neutral usage accounting | Role/backstory as a substitute for a validated plan; a free-running Crew as the parent state machine |
| [OpenAI Agents SDK](https://openai.github.io/openai-agents-js/guides/agents/) | Small agent, tool, manager, and handoff primitives | Agents-as-tools for bounded specialists, explicit approval, handoff input filters, request/run usage data, trace correlation | Full-history handoff by default; OpenAI session or trace state as authority; handoff/tool guardrails as sufficient end-to-end acceptance |
| [OpenHands](https://docs.openhands.dev/sdk) | Coding-agent runtime with workspaces, events, Git diffs, and restoration | Workspace contract, writable-branch isolation, diff/test artifacts, context compression receipts | Replacing all existing providers with one runtime; treating an agent's final message as the deliverable |
| [A2A 1.0](https://a2a-protocol.org/latest/specification/) | Remote-agent discovery and task interoperability | Optional remote provider adapter, capability cards, task polling/streaming, messages separated from artifacts, protocol/version negotiation | A2A `SendMessage` as exactly-once delivery; public agent discovery by default; an A2A task state as Business acceptance |
| [AutoGen](https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/core-concepts/architecture.html) | Message-passing and conversational multi-agent patterns | Historical design reference only | New dependency while it is in maintenance mode; broadcasting all history to every agent; LLM-selected speakers and open-ended group chat |

## The key distinction

T3 is closest to the provider control surface beneath Orquesta, not to the whole Orquesta product. Cloudflare and Temporal are execution substrates, not evidence-based business acceptance systems. LangGraph, CrewAI, Google ADK, OpenAI Agents SDK, Microsoft Agent Framework, and AutoGen are orchestration frameworks or harness libraries. A2A is an interoperability protocol.

Orquesta's defensible layer is the combination none of those layers supplies by itself:

1. explicit work-order decomposition and assignment;
2. branch-scoped context with measured duplication;
3. durable delivery certainty and crash recovery;
4. workspace isolation and reproducible artifacts;
5. independent integration and acceptance evidence;
6. a local-first, provider-neutral audit trail.

## Mapping to the current repository

### Keep and strengthen

`packages/event-store` already provides the strongest existing foundation: revision CAS, immutable batch identity, duplicate event rejection, a pending record, fsync/atomic replacement, projection replay, and explicit crash recovery. Business command receipts, domain events, and dispatch-outbox intent should be written in the same event batch. An in-memory queue may serialize work for speed, but must never be the authority.

`packages/execution-kernel` already provides deterministic execution and dispatch IDs, DAG dependency eligibility, concurrency limits, runtime identity checks, and the correct rule that `turn_completed` moves to `verifying`, not `accepted`.

`packages/context-compiler` already provides task envelopes, branch-owned context packs, source hashes, token budgets, source deduplication, coverage matrices, and context receipts. It should become a production gate rather than remain a shadow-only path, and it needs cross-branch duplication accounting rather than only within-pack deduplication.

`packages/codex-adapter` already separates App Server, SDK, and repository capabilities and can read remote thread/turn state through its App Server implementation. It should become the first implementation behind a provider-neutral driver contract, not the Business contract itself.

### Gaps demonstrated in current code

1. `packages/execution-kernel/src/scheduler.js` claims work and calls `adapter.start()` in one operation. There is no durable commit between claim and provider effect.
2. The same scheduler turns every rejected start into `attempt_failed` and queues a retry. A timeout after a provider accepted the turn is therefore treated like a proven pre-dispatch failure.
3. Retry delay is bounded, but retry count and elapsed retry time are not bounded in the existing kernel state.
4. Claimed work has no durable lease/heartbeat recovery contract.
5. Current adapter and runtime state do not form a provider-neutral configured-driver registry.
6. Workspace allocation, baseline checkpoint, diff, restore, and release are not a shared port.
7. Approval and long human waits are not yet a single durable Business command/event lifecycle.
8. Kernel recent events are useful but not a correlated task-to-provider-to-verification trace.
9. Context receipts measure a branch, but the parent work order does not yet enforce a total duplicate-context budget.
10. A remote provider's `completed` status does not prove Orquesta acceptance and must never bypass integration evidence.

The concurrent duplicate-dispatch race in the current App Server bridge was separately reproduced and fixed by reserving a canonical dispatch before the first asynchronous provider operation. That closes one in-process race; it does not provide a durable outbox or exactly-once delivery.

## Target control flow

The executable state-machine, receipt, outbox, lease, and crash-recovery design is fixed in [durable-work-order-engine.md](./durable-work-order-engine.md).

```text
User command
    -> authorize actor, scope, and permission ceiling
    -> validate command ID, payload hash, and expected revision
    -> route by immutable aggregate engine contract
    -> pure Work Order decider
    -> one EventStore batch
         [command receipt + domain events + dispatch outbox intent]
    -> commit succeeds
    -> provider reactor reads the durable outbox
    -> provider driver performs the external effect
    -> authenticated observation ingress verifies either
         [callback-owned worker fencing token |
          content-addressed recovery-probe receipt + mutation key]
    -> effect lifecycle records one of
         [not sent | accepted | delivery unknown]
    -> projector materializes branch and parent views
    -> result artifacts and verification evidence are reconciled
    -> integration branch and acceptance policy decide the parent outcome
```

No renderer, provider callback, or agent message may write an authoritative state directly.

The settlement-ingress portion of that segment is implemented but only becomes
writable after the journal-global V2 cutover. Exact historical receipt recovery
still runs before that gate. The suffix requires a dedicated settlement receipt
bundle; a generic observation receipt cannot carry settlement authority. The
observation boundary distinguishes `worker_result` from `recovery_probe` and
never copies the current projection's lease token onto an old callback. The
pre-send control-plane path is separately system-authored and cannot masquerade
as a provider callback. The internal recorded-fake stack exercises the suffix
only as explicit test scaffolding. A production provider driver/reactor/sender
remains a target and is not enabled.

## Adopt, defer, and reject

### P0 — implement locally now

- An immutable Work Order engine version: new aggregates explicitly use V2,
  missing historical versions mean frozen V1 replay, and migration is an
  explicit receipt-backed cutover rather than an in-stream upgrade.
- A strict command envelope with command ID, payload hash, expected revision, actor, and authorization performed outside caller-provided actor claims.
- A pure decider and event-only projector.
- Atomic command receipt plus domain-event commit in `event-store`.
- A durable dispatch outbox with immutable prompt/context/workspace/provider hashes.
- Effect-bound delivery results of `not_sent`, `accepted`, and
  `delivery_unknown`; only authoritative `not_sent` evidence can make retry
  eligible, while the legacy plan policy key remains
  `branch.dispatch.not_sent`.
- Effect-scoped recovery attention so settlement of one operation cannot clear
  another operation's ambiguity.
- Bounded attempts, elapsed deadline, claim lease, recovery probe, cancellation receipt, and late-result quarantine.
- Parent acceptance that requires all mandatory branches, the integration result, acceptance-criterion evidence, and the configured number of independent reviews.

### P1 — implement after the durable spine

- `ProviderDriverV1` and configured provider registry; wrap Codex first.
- `WorkspaceDriverV1`; implement Git worktree/checkpoint/diff/restore first and keep a sandbox implementation possible.
- Durable approval, user-input, edit, rejection, expiration, and resume events.
- Cross-branch context duplicate-token accounting and hard budget enforcement.
- Rotated local NDJSON traces with redaction and optional OpenTelemetry export.
- Versioned host snapshot/subscription handshake with sequence-gap recovery. This is a desktop-host contract, not a browser product.

### P2 — adapters, not domain dependencies

- A2A remote-agent discovery and task adapter.
- Temporal durable remote executor when multi-user week/month-long workflows justify the operational cost.
- Cloudflare Workflows/Agents/Sandbox executor for managed scale or isolated cloud workloads.
- Microsoft Agent Framework, Google ADK, LangGraph, CrewAI, OpenAI Agents SDK, or OpenHands specialist adapters where they add a provider capability.

### Explicitly reject

- A new browser application, hosted web dashboard, or browser fallback.
- Rebuilding Codex/Claude/OpenHands agent loops inside Orquesta.
- Broadcasting the full conversation or repository context to every branch.
- Letting an LLM repeatedly choose the next speaker as the scheduler.
- Automatic retry after ambiguous provider delivery.
- Using a provider's thread, a cloud workflow, a sandbox filesystem, or a renderer store as canonical Business state.
- Marking work accepted because a turn, workflow, or agent reports completion.

## Commercial decision gates

The local implementation remains the default until measured workload proves it inadequate. A hosted durable executor is justified only when multi-user high availability, week/month waits, distributed workers, or managed operations cost more to build and run locally than the adapter and vendor cost.

Every executor must pass the same conformance suite:

- crash before send, during send, after provider acceptance, and before local receipt commit;
- same command replay and same ID with a conflicting payload;
- provider timeout with delivery later discovered as accepted;
- process restart in every Work Order state;
- cancellation before send, while running, during delivery uncertainty, and after a late result;
- one failed parallel branch without rerunning successful branches;
- permission downgrade and unsupported-provider capability fail-closed behavior;
- context, token, cost, retry, human-intervention, artifact, and acceptance receipts reconcile to the audit trace.

## Primary sources

- T3 Code: [architecture](https://github.com/pingdotgg/t3code/blob/main/docs/internals/overview.md), [providers](https://github.com/pingdotgg/t3code/blob/main/docs/internals/providers.md), [permissions](https://github.com/pingdotgg/t3code/blob/main/docs/user/permission-modes.md), [observability](https://github.com/pingdotgg/t3code/blob/main/docs/operations/observability.md)
- Cloudflare: [Agents](https://developers.cloudflare.com/agents/), [durable execution](https://developers.cloudflare.com/agents/runtime/execution/durable-execution/), [Workflows rules](https://developers.cloudflare.com/workflows/build/rules-of-workflows/), [Sandbox security](https://developers.cloudflare.com/sandbox/concepts/security/), [Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/)
- Temporal: [Workflows](https://docs.temporal.io/workflows), [Activities](https://docs.temporal.io/activity-definition), [retry policies](https://docs.temporal.io/encyclopedia/retry-policies), [versioning](https://docs.temporal.io/patching)
- LangGraph: [persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence), [functional durability rules](https://docs.langchain.com/oss/javascript/langgraph/functional-api), [subgraphs](https://docs.langchain.com/oss/javascript/langgraph/use-subgraphs), [interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts)
- Microsoft Agent Framework: [workflows](https://learn.microsoft.com/en-us/agent-framework/workflows/), [durable extension](https://learn.microsoft.com/en-us/agent-framework/integrations/durable-extension)
- Google ADK: [collaborative workflows](https://adk.dev/workflows/collaboration/), [graph data handling](https://adk.dev/graphs/data-handling/), [resume](https://adk.dev/runtime/resume/), [context compaction](https://adk.dev/context/compaction/)
- CrewAI: [Flows](https://docs.crewai.com/en/concepts/flows), [HITL](https://docs.crewai.com/learn/human-in-the-loop)
- OpenAI Agents SDK: [agents](https://openai.github.io/openai-agents-js/guides/agents/), [handoffs](https://openai.github.io/openai-agents-js/guides/handoffs/), [guardrails](https://openai.github.io/openai-agents-js/guides/guardrails/), [tracing](https://openai.github.io/openai-agents-js/guides/tracing/)
- OpenHands: [SDK](https://docs.openhands.dev/sdk), [repository](https://github.com/OpenHands/OpenHands)
- A2A: [v1.0 specification](https://a2a-protocol.org/latest/specification/), [agent discovery](https://a2a-protocol.org/latest/topics/agent-discovery/), [streaming and asynchronous tasks](https://a2a-protocol.org/latest/topics/streaming-and-async/)
- AutoGen: [architecture](https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/core-concepts/architecture.html), [team state](https://microsoft.github.io/autogen/dev/user-guide/agentchat-user-guide/tutorial/state.html)
