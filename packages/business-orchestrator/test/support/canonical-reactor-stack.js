"use strict";

const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { canonicalHash, canonicalJson } = require("@orquesta/contracts");
const { createEventStore } = require("@orquesta/event-store");
const { normalizeBusinessWorkOrderPlanV1 } = require("../../src/contract");
const {
  createBusinessInternalActionBoundary,
  normalizeInternalActionEnvelopeV1,
} = require("../../src/internal-action-boundary");
const {
  V2_EFFECT_IDENTITY_FIELDS,
  deriveEffectOperationScopeHashV2,
} = require("../../src/lifecycle");
const {
  createBusinessObservationBoundary,
} = require("../../src/observation-boundary");
const {
  createDispatchPacketStore,
} = require("../../src/packet-store");
const {
  createDispatchPacketStorePosixPlatformAdapter,
  createRecordedFakeProviderPosixPlatformAdapter,
} = require("../../src/posix-platform-adapters");
const {
  BUSINESS_EVENT_TYPES,
  OUTBOX_IMMUTABLE_FIELDS,
  businessProjectionConfigurationV1,
  initialBusinessProjectionV1,
  projectBusinessEventV1,
} = require("../../src/projector");
const {
  buildProviderSettlementCutoverBatchV1,
  deriveProviderSettlementCutoverReadinessV1,
} = require("../../src/provider-settlement-cutover-boundary");
const {
  createPresendFailureObservationFactsResolver,
  createPresendFailureRecorder,
} = require("../../src/presend-failure-recorder");
const {
  createRecordedFakeProviderDriver,
} = require("../../src/recorded-fake-provider");
const {
  createBusinessSendAuthorizationResolver,
} = require("../../src/send-authorization-resolver");
const {
  createRecordedFakePosixTestAdapter,
} = require("./recorded-fake-platform-adapter");

const SYSTEM_ACTOR_ID = "system:canonical-reactor";
const RUNTIME_ACTOR_ID = "runtime:canonical-reactor";
const OWNER_ID = "worker:canonical-reactor";
const INTERNAL_AUTHENTICATION = "internal:canonical-reactor";
const OBSERVATION_AUTHENTICATION = "observation:canonical-reactor";
const CONTROL_PLANE_AUTHENTICATION = "control-plane:canonical-reactor";
const CREATED_AT = "2026-08-10T01:00:00.000Z";
const CLAIMED_AT = "2026-08-10T01:00:10.000Z";
const SEND_AT = "2026-08-10T01:00:11.000Z";
const PROVIDER_AT = "2026-08-10T01:00:12.000Z";
const LEASE_EXPIRES_AT = "2026-08-10T01:00:40.000Z";

function ref(id) {
  return { id, hash: canonicalHash({ id }) };
}

function planFixture(label) {
  return normalizeBusinessWorkOrderPlanV1({
    version: 1,
    project_ref: `project:canonical-reactor:${label}`,
    revision: 1,
    supersedes_plan_ref: null,
    title: "Drive one canonical provider Effect through durable boundaries",
    desired_outcome: "One exact Effect is either settled or reconciled without duplicate mutation.",
    acceptance_policy: {
      criteria: [{
        criterion_id: "criterion:canonical-reactor",
        description: "The canonical reactor closes the provider Effect.",
        verification: "deterministic",
        verification_requirements: [{
          kind: "deterministic",
          verification_ref: ref(`verification:canonical-reactor:${label}`),
        }],
      }],
      review_minimum: "light",
    },
    task_intent_ref: ref(`task-intent:canonical-reactor:${label}`),
    execution_plan_ref: ref(`execution-plan:canonical-reactor:${label}`),
    context_pack_ref: ref(`context-pack:canonical-reactor:${label}`),
    branches: [{
      branch_ref: `branch:${label}`,
      task_intent_ref: ref(`task-intent:branch:${label}`),
      execution_plan_ref: ref(`execution-plan:branch:${label}`),
      context_pack_ref: ref(`context-pack:branch:${label}`),
      dependencies: [],
      role: "work",
      parallelizable: false,
      isolation: "sandbox",
      assignee_ref: `assignee:${label}`,
      provider_ref: "provider:recorded",
      permission_mode: "workspace-write",
    }],
    integration_branch_ref: null,
    max_concurrency: 1,
    context_duplication_budget_tokens: 1_000,
    retry_policy: {
      max_attempts: 3,
      attempt_timeout_ms: 60_000,
      max_elapsed_ms: 600_000,
      backoff_initial_ms: 1_000,
      backoff_max_ms: 30_000,
      retryable_observations: ["branch.dispatch.not_sent"],
    },
    lease_policy: {
      lease_duration_ms: 30_000,
      heartbeat_interval_ms: 10_000,
      max_recovery_probes: 3,
    },
    provider_policy: {
      allowed_provider_refs: ["provider:recorded"],
      selection: "fixed",
    },
    permission_mode: "workspace-write",
  });
}

function dispatchPacket(plan, workOrderId, label) {
  const branch = plan.branches[0];
  return {
    schema_version: 1,
    work_order: {
      work_order_id: workOrderId,
      work_order_revision: 1,
      engine_contract_version: 2,
    },
    plan: {
      plan_snapshot_ref: plan.plan_snapshot_id,
      plan_hash: plan.plan_hash,
    },
    branch: {
      branch_ref: branch.branch_ref,
      next_attempt: 1,
      task_intent_ref: branch.task_intent_ref,
      execution_plan_ref: branch.execution_plan_ref,
      attempt_packet_ref: null,
    },
    provider: {
      provider_ref: branch.provider_ref,
      configuration_ref: ref(`provider-configuration:${label}`),
    },
    workspace: {
      workspace_ref: `workspace:canonical-reactor:${label}`,
      checkpoint_ref: ref(`workspace-checkpoint:${label}`),
      isolation_mode: branch.isolation,
    },
    context: {
      context_pack_ref: branch.context_pack_ref,
      context_manifest_ref: ref(`context-manifest:${label}`),
      request_payload: { task: `canonical reactor fixture ${label}` },
      user_input_request_id: null,
      user_input_response_ref: null,
    },
    authority: {
      authority_ref: ref(`authority:canonical-reactor:${label}`),
      principal_type: "system",
      principal_id: SYSTEM_ACTOR_ID,
      project_ref: plan.project_ref,
      permission_mode: branch.permission_mode,
      allowed_provider_refs: [branch.provider_ref],
      allowed_effects: ["provider.thread.create"],
    },
    effect_ceiling: {
      allowed_effect_kinds: ["provider.thread.create"],
      deadline_at: "2026-08-10T01:10:00.000Z",
      max_runtime_ms: 120_000,
      max_output_bytes: 1_048_576,
      max_tool_calls: 32,
    },
  };
}

function effectIdentity(effect) {
  return Object.fromEntries(V2_EFFECT_IDENTITY_FIELDS.map((field) => [field, effect[field]]));
}

function effectFor(plan, workOrderId, commandId, packetRef) {
  const branchRef = plan.branches[0].branch_ref;
  const dispatchId = `DSP-${canonicalHash({
    work_order_id: workOrderId,
    branch_ref: branchRef,
    attempt: 1,
    packet_ref: packetRef,
  }).slice(0, 32)}`;
  const seed = {
    effect_contract_version: 2,
    work_order_id: workOrderId,
    branch_ref: branchRef,
    attempt: 1,
    dispatch_id: dispatchId,
    effect_kind: "provider.thread.create",
    origin_source_id: commandId,
    operation_scope_hash: deriveEffectOperationScopeHashV2({
      effect_kind: "provider.thread.create",
      provider_ref: "provider:recorded",
      packet_ref: packetRef.id,
      packet_hash: packetRef.hash,
    }),
    operation_generation: 1,
    generation_predecessor_effect_id: null,
    provider_ref: "provider:recorded",
    packet_ref: packetRef.id,
    packet_hash: packetRef.hash,
    predecessor_effect_id: null,
    predecessor_delivery_hash: null,
    target_runtime_identity: null,
  };
  const identityHash = canonicalHash(seed);
  return {
    effect_id: `FX-${identityHash.slice(0, 32)}`,
    ...seed,
    idempotency_key: `IDEM-${identityHash.slice(0, 32)}`,
    status: "pending",
    lease: null,
    delivery: null,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
  };
}

function businessEvent(plan, {
  eventId,
  type,
  sourceId,
  workOrderId,
  prior,
  target,
  specific,
}) {
  return {
    event_id: eventId,
    schema_version: 1,
    type,
    payload: {
      work_order_id: workOrderId,
      plan_snapshot_ref: plan.plan_snapshot_id,
      plan_hash: plan.plan_hash,
      source_id: sourceId,
      prior_work_order_revision: prior,
      target_work_order_revision: target,
      occurred_at: CREATED_AT,
      ...specific,
    },
    evidence_refs: [],
  };
}

function initialBatch(plan, workOrderId, commandId, packetRef, effect) {
  const entries = [{
    type: "business.work_order.created",
    specific: {
      plan,
      engine_contract_version: 2,
      deadline_at: "2026-08-10T01:10:00.000Z",
    },
  }, {
    type: "business.context_budget.verified",
    specific: {
      receipt: {
        budget_tokens: 1_000,
        duplicate_context_tokens: 100,
        evidence_refs: ["evidence:canonical-context-budget"],
      },
    },
  }, {
    type: "business.branch.initialized",
    specific: {
      branch: plan.branches[0],
      state: "ready",
      required_criterion_ids: ["criterion:canonical-reactor"],
    },
  }, {
    type: "business.branch.attempt_opened",
    specific: {
      branch_ref: effect.branch_ref,
      attempt: 1,
      dispatch_id: effect.dispatch_id,
      attempt_started_at: CREATED_AT,
      attempt_deadline_at: "2026-08-10T01:01:00.000Z",
      retry_at: null,
      packet_ref: packetRef,
      packet_hash: packetRef.hash,
    },
  }, {
    type: "business.outbox.enqueued",
    specific: { effect },
  }];
  const events = entries.map((entry, index) => businessEvent(plan, {
    eventId: `${commandId}:event:${index + 1}`,
    type: entry.type,
    sourceId: commandId,
    workOrderId,
    prior: 0,
    target: 1,
    specific: entry.specific,
  }));
  const batchId = `business:${commandId}`;
  const receipt = {
    source_id: commandId,
    source_type: "command",
    identity_hash: canonicalHash({ source_id: commandId, fixture: true }),
    payload_hash: canonicalHash(entries),
    work_order_id: workOrderId,
    applied_revision: 1,
    batch_id: batchId,
    event_ids: events.map((event) => event.event_id),
    result: { work_order_id: workOrderId, work_order_revision: 1 },
  };
  events.push(businessEvent(plan, {
    eventId: `${commandId}:receipt`,
    type: "business.command.received",
    sourceId: commandId,
    workOrderId,
    prior: 0,
    target: 1,
    specific: { receipt },
  }));
  return {
    expected_revision: 0,
    batch_id: batchId,
    actor: { type: "agent", id: "fixture:canonical-reactor" },
    correlation_id: commandId,
    events,
  };
}

function publicEventStore(root) {
  const configuration = businessProjectionConfigurationV1();
  return createEventStore({
    stateRoot: root,
    workspaceId: "canonical-reactor-stack",
    preflightProjection: true,
    reducers: configuration.reducers,
    initialState: initialBusinessProjectionV1(),
    clock: () => CREATED_AT,
  });
}

async function activateCutover(eventStore, actorId) {
  const replay = await eventStore.replay();
  const projectedReadiness = deriveProviderSettlementCutoverReadinessV1(
    replay.state,
    replay.watermark.journal_sequence,
  );
  const assessment = {
    assessment_schema_version: 1,
    status: "ready",
    event_store_recovery: "clean",
    settlement_ingress: "stopped",
    provider_reactors: "stopped",
    send_authorization_contract_version: 2,
    projected_readiness: projectedReadiness,
  };
  const assessmentHash = canonicalHash(assessment);
  const cutover = {
    version: 1,
    cutover_id: `PSC-${canonicalHash({ fixture: "canonical-reactor" }).slice(0, 32)}`,
    actor: { type: "system", actor_id: actorId },
    settlement_contract_version: 2,
    send_authorization_contract_version: 2,
    payload_hash: canonicalHash({
      settlement_contract_version: 2,
      send_authorization_contract_version: 2,
    }),
  };
  const request = buildProviderSettlementCutoverBatchV1({
    cutover,
    principal: { type: "system", id: actorId },
    projection: replay.state,
    journal_sequence: replay.watermark.journal_sequence,
    readiness: {
      readiness_assessment_ref: {
        id: `PSA-${assessmentHash.slice(0, 32)}`,
        hash: assessmentHash,
      },
      assessment,
    },
    occurred_at: "2026-08-10T01:00:01.000Z",
  }).request;
  await eventStore.commit(request);
}

function effectFacts(effect) {
  return {
    work_order_id: effect.work_order_id,
    effect_id: effect.effect_id,
    effect: Object.fromEntries(OUTBOX_IMMUTABLE_FIELDS.map((field) => [field, effect[field]])),
    status: effect.status,
    lease: effect.lease === null ? null : structuredClone(effect.lease),
  };
}

function acceptedOutcome(label) {
  return {
    outcome_version: 1,
    classification: "accepted",
    reason: "provider_acknowledged",
    runtime_identity: {
      operation_id: `operation:${label}`,
      thread_id: `thread:${label}`,
      turn_id: null,
    },
    provider_result_ref: ref(`provider-result:${label}`),
    evidence_refs: [ref(`provider-evidence:${label}`)],
  };
}

function evidenceIds(evidence, provenanceId) {
  return [...new Set([
    provenanceId,
    ...(evidence.evidence_refs || []).map((entry) => entry.id),
  ])];
}

function settlementFacts(observation, effect, evidence) {
  const provenance = observation.payload.settlement_source === "worker_result"
    ? observation.payload.worker_result_ref.id
    : observation.payload.recovery_probe.probe_receipt_ref.id;
  const refs = evidenceIds(evidence, provenance);
  const runtimeIdentity = observation.payload.classification === "accepted"
    ? evidence.runtime_identity
    : null;
  const common = {
    effect_id: effect.effect_id,
    idempotency_key: effect.idempotency_key,
    provider_ref: effect.provider_ref,
    classification: observation.payload.classification,
    settlement_source: observation.payload.settlement_source,
    runtime_identity: runtimeIdentity,
    evidence_refs: refs,
  };
  return {
    observation_evidence_refs: refs,
    provider_ref: effect.provider_ref,
    ...(runtimeIdentity === null ? {} : { runtime_identity: runtimeIdentity }),
    ...(observation.payload.settlement_source === "recovery_probe"
      ? { reconciliation_resolution_ref: ref(`reconciliation:${provenance}`) }
      : {}),
    settlement_attestation: observation.payload.settlement_source === "worker_result"
      ? {
        ...common,
        worker_fencing_token: observation.payload.worker_fencing_token,
        worker_result_ref: observation.payload.worker_result_ref,
      }
      : {
        ...common,
        recovery_probe: observation.payload.recovery_probe,
      },
    settlement_certainty_fact: {
      certainty_fact_version: 2,
      effect_contract_version: 2,
      effect_kind: effect.effect_kind,
      effect_stage: "thread_create",
      settlement_source: observation.payload.settlement_source,
      classification: observation.payload.classification,
      reason: evidence.reason,
    },
  };
}

async function privateRoot(prefix, cleanup) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  await fsp.chmod(root, 0o700);
  cleanup.push(() => fsp.rm(root, { recursive: true, force: true }));
  return fsp.realpath(root);
}

async function createCanonicalReactorStack(t, {
  label = "one",
  crashAt = null,
  legacyDriverCapability = false,
  productionProviderAdapter = false,
} = {}) {
  const cleanup = [];
  t.after(async () => {
    for (const remove of cleanup.reverse()) await remove();
  });
  const [eventRoot, packetRoot, providerRoot, failureRoot] = await Promise.all([
    privateRoot("orquesta-reactor-events-", cleanup),
    privateRoot("orquesta-reactor-packets-", cleanup),
    privateRoot("orquesta-reactor-provider-", cleanup),
    privateRoot("orquesta-reactor-presend-", cleanup),
  ]);
  const now = { value: CLAIMED_AT };
  const clock = () => now.value;
  const plan = planFixture(label);
  const workOrderId = `WO-${canonicalHash({ label, fixture: "canonical" }).slice(0, 32)}`;
  const commandId = `CMD-${canonicalHash({ label, fixture: "canonical" }).slice(0, 32)}`;
  const packetStore = createDispatchPacketStore({
    root_path: packetRoot,
    platform_adapter: createDispatchPacketStorePosixPlatformAdapter(),
  });
  const packet = dispatchPacket(plan, workOrderId, label);
  const packetRef = await packetStore.create(packet);
  const effect = effectFor(plan, workOrderId, commandId, packetRef);
  const eventStore = publicEventStore(eventRoot);
  await eventStore.commit(initialBatch(plan, workOrderId, commandId, packetRef, effect));
  await activateCutover(eventStore, SYSTEM_ACTOR_ID);

  const internalActionBoundary = createBusinessInternalActionBoundary({
    eventStore,
    packetStore,
    clock,
    authorizer: {
      async authenticate({ authentication }) {
        if (authentication !== INTERNAL_AUTHENTICATION) return null;
        return { type: "system", id: SYSTEM_ACTOR_ID };
      },
      async authorize({ principal, action, internal_action: actionEnvelope }) {
        return {
          authorized: true,
          principal_type: principal.type,
          principal_id: principal.id,
          work_order_id: actionEnvelope.work_order_id,
          effect_id: actionEnvelope.payload.effect_id,
          action,
        };
      },
    },
    resolvers: {
      async resolveEffectFacts({ effect_id: effectId }) {
        const replay = await eventStore.replay();
        return effectFacts(replay.state.outbox[effectId]);
      },
    },
  });

  const authorizationResolver = createBusinessSendAuthorizationResolver({ eventStore, clock });
  const baseDriver = createRecordedFakeProviderDriver({
    root_path: providerRoot,
    platform_adapter: productionProviderAdapter
      ? createRecordedFakeProviderPosixPlatformAdapter()
      : createRecordedFakePosixTestAdapter(),
    recorded_outcomes: { [effect.idempotency_key]: acceptedOutcome(label) },
    authorization_resolver: authorizationResolver,
    clock,
    test_only_allow_process_local_adapter: !productionProviderAdapter,
  });
  let crashPending = crashAt;
  let providerEntryCalls = 0;
  const crashDriver = crashAt === null ? baseDriver : Object.freeze({
    authorization_contract_version: baseDriver.authorization_contract_version,
    capabilities: () => baseDriver.capabilities(),
    async executeMutation(invocation) {
      const selected = crashPending;
      crashPending = null;
      return baseDriver.executeMutation(
        invocation,
        selected === null ? {} : { crash_at: selected },
      );
    },
    readAuthorizedMutationResult: (input) => baseDriver.readAuthorizedMutationResult(input),
    inspectByExactKey: (input) => baseDriver.inspectByExactKey(input),
    readEvidence: (input) => baseDriver.readEvidence(input),
  });
  const recordedFakeProvider = legacyDriverCapability ? Object.freeze({
    authorization_contract_version: 1,
    capabilities() {
      const { provider_entry_window: ignored, ...legacy } = baseDriver.capabilities();
      void ignored;
      return legacy;
    },
    async executeMutation() { providerEntryCalls += 1; throw new Error("unauthorized entry"); },
    async readAuthorizedMutationResult() { providerEntryCalls += 1; throw new Error("unauthorized lookup"); },
    async inspectByExactKey() { providerEntryCalls += 1; throw new Error("unauthorized probe"); },
    async readEvidence() { providerEntryCalls += 1; throw new Error("unauthorized evidence read"); },
  }) : crashDriver;

  function verifiedFailure(source, reason, request, evidence) {
    return {
      verification_contract_version: 1,
      verification_status: "verified_failure",
      failure_source: source,
      failure_reason: reason,
      binding_hash: canonicalHash(request),
      evidence_refs: [evidence],
    };
  }
  const sourceVerifiers = {
    async packet_store(request) {
      try {
        await packetStore.verifyForEffect(request.effect_identity);
      } catch (error) {
        return verifiedFailure(
          "packet_store",
          "packet_integrity_failed",
          request,
          `PFE-${canonicalHash({ source: "packet_store", code: error?.code, request }).slice(0, 32)}`,
        );
      }
      throw Object.assign(new Error("PacketStore did not reproduce a failure"), {
        code: "PACKET_FAILURE_NOT_REPRODUCED",
      });
    },
    async authority() {
      throw Object.assign(new Error("Authority failure is not configured"), {
        code: "AUTHORITY_FAILURE_NOT_REPRODUCED",
      });
    },
    async driver_capability(request) {
      let actual = null;
      try {
        actual = recordedFakeProvider.capabilities();
      } catch {}
      if (canonicalJson(actual) === canonicalJson(baseDriver.capabilities())) {
        throw Object.assign(new Error("Driver capability failure is not current"), {
          code: "DRIVER_CAPABILITY_FAILURE_NOT_REPRODUCED",
        });
      }
      return verifiedFailure(
        "driver_capability",
        "driver_capability_failed",
        request,
        `PFE-${canonicalHash({ source: "driver_capability", actual, request }).slice(0, 32)}`,
      );
    },
  };
  const presendFailureRecorder = createPresendFailureRecorder({
    root_path: failureRoot,
    platform_adapter: createRecordedFakePosixTestAdapter(),
    source_verifiers: sourceVerifiers,
    allow_test_only_platform_adapter: true,
  });

  const observationFactsDelegate = {
    async resolveObservationFacts({ observation, settlement_effect: settlementEffect }) {
      if (observation.name === "provider.effect.send_expiration.recorded") {
        return {
          observation_evidence_refs: [observation.payload.expiry_receipt_ref.id],
          provider_ref: effect.provider_ref,
          attention_detail_ref: observation.payload.expiry_receipt_ref,
        };
      }
      if (observation.name === "provider.effect.presend_failure.recorded") {
        return {
          observation_evidence_refs: [],
          provider_ref: effect.provider_ref,
        };
      }
      const provenance = observation.payload.settlement_source === "worker_result"
        ? observation.payload.worker_result_ref
        : observation.payload.recovery_probe.probe_receipt_ref;
      const evidence = await baseDriver.readEvidence(provenance);
      return settlementFacts(observation, settlementEffect, evidence);
    },
  };
  const observationFactsResolver = createPresendFailureObservationFactsResolver({
    delegate: observationFactsDelegate,
    recorder: presendFailureRecorder,
  });
  const observationBoundary = createBusinessObservationBoundary({
    eventStore,
    clock,
    authorizer: {
      async authenticate({ authentication }) {
        if (authentication === OBSERVATION_AUTHENTICATION) {
          return { type: "agent", id: RUNTIME_ACTOR_ID };
        }
        if (authentication === CONTROL_PLANE_AUTHENTICATION) {
          return { type: "system", id: SYSTEM_ACTOR_ID };
        }
        return null;
      },
      async authorize({ principal, observation, plan: currentPlan }) {
        return {
          authorized: true,
          principal_type: principal.type,
          principal_id: principal.id,
          project_ref: currentPlan.project_ref,
          work_order_id: observation.work_order_id,
          plan_snapshot_ref: observation.plan_snapshot_ref,
          plan_hash: observation.plan_hash,
          allowed_observation_names: [observation.name],
          allowed_branch_refs: [observation.payload.branch_ref],
          allowed_provider_refs: [effect.provider_ref],
          allowed_verifier_refs: [],
        };
      },
    },
    resolvers: {
      async resolveProject({ project_ref: projectRef }) {
        return { project_ref: projectRef };
      },
      resolveObservationFacts: (input) => observationFactsResolver.resolveObservationFacts(input),
    },
  });

  function reactorOptions(driver = recordedFakeProvider, runId = "a".repeat(32)) {
    return {
      eventStore,
      internalActionBoundary,
      observationBoundary,
      packetStore,
      authorizationResolver,
      recordedFakeProvider: driver,
      presendFailureRecorder,
      enabled: true,
      internalAuthentication: INTERNAL_AUTHENTICATION,
      observationAuthentication: OBSERVATION_AUTHENTICATION,
      controlPlaneObservationAuthentication: CONTROL_PLANE_AUTHENTICATION,
      systemActorId: SYSTEM_ACTOR_ID,
      runtimeActorId: RUNTIME_ACTOR_ID,
      ownerId: OWNER_ID,
      runId,
      clock,
    };
  }

  async function renewSendingLease(
    renewedAt = "2026-08-10T01:00:20.000Z",
  ) {
    now.value = renewedAt;
    const replay = await eventStore.replay();
    const projectedEffect = replay.state.outbox[effect.effect_id];
    const workOrder = replay.state.work_orders[effect.work_order_id];
    if (projectedEffect?.status !== "sending" || !projectedEffect.lease || !workOrder) {
      throw new Error("fixture effect must be sending before a lease renewal");
    }
    const payload = {
      effect_id: projectedEffect.effect_id,
      lease_id: projectedEffect.lease.lease_id,
      owner_id: projectedEffect.lease.owner_id,
      generation: projectedEffect.lease.generation,
    };
    const identity = {
      fixture: "canonical-reactor-sending-renewal",
      effect_id: projectedEffect.effect_id,
      prior_lease_expires_at: projectedEffect.lease.expires_at,
      renewed_at: renewedAt,
    };
    const action = normalizeInternalActionEnvelopeV1({
      version: 1,
      internal_action_id: `INT-${canonicalHash(identity).slice(0, 32)}`,
      work_order_id: workOrder.work_order_id,
      plan_snapshot_ref: workOrder.plan_snapshot_ref,
      plan_hash: workOrder.plan_hash,
      expected_work_order_revision: workOrder.revision,
      actor: { type: "system", actor_id: SYSTEM_ACTOR_ID },
      name: "outbox.lease.renew",
      payload,
      payload_hash: canonicalHash(payload),
    });
    return internalActionBoundary.execute({
      internal_action: action,
      authentication: INTERNAL_AUTHENTICATION,
    });
  }

  return {
    authorizationResolver,
    baseDriver,
    clock,
    effect,
    eventRoot,
    eventStore,
    now,
    packetStore,
    get providerEntryCalls() { return providerEntryCalls; },
    async removeDispatchPacket() {
      await fsp.unlink(path.join(packetRoot, `dispatch-packet-${effect.packet_hash}.json`));
    },
    presendFailureRecorder,
    renewSendingLease,
    async providerRecordKinds() {
      const kinds = [];
      for (const name of await fsp.readdir(providerRoot)) {
        if (!name.endsWith(".json")) continue;
        const value = JSON.parse(await fsp.readFile(path.join(providerRoot, name), "utf8"));
        if (typeof value.record_kind === "string") kinds.push(value.record_kind);
      }
      return kinds.sort();
    },
    providerRoot,
    reopenAuthorization() {
      const reopenedEventStore = publicEventStore(eventRoot);
      return {
        eventStore: reopenedEventStore,
        authorizationResolver: createBusinessSendAuthorizationResolver({
          eventStore: reopenedEventStore,
          clock,
        }),
      };
    },
    reactorOptions,
    times: {
      claimed_at: CLAIMED_AT,
      send_at: SEND_AT,
      provider_at: PROVIDER_AT,
      lease_expires_at: LEASE_EXPIRES_AT,
    },
  };
}

module.exports = {
  createCanonicalReactorStack,
};
