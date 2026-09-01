"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { canonicalHash, canonicalJson } = require("@orquesta/contracts");
const { createEventStore } = require("@orquesta/event-store");
const { businessProjectionConfigurationV1 } = require("../src/projector");
const {
  PROVIDER_SETTLEMENT_CUTOVER_ACTION,
  PROVIDER_SETTLEMENT_CUTOVER_RECEIVED_EVENT,
  PROVIDER_SETTLEMENT_CUTOVER_SOURCE_TYPE,
  PROVIDER_SETTLEMENT_ACTIVATED_EVENT,
  BusinessProviderSettlementCutoverBoundaryError,
  buildProviderSettlementCutoverBatchV1,
  createBusinessProviderSettlementCutoverBoundary,
  deriveProviderSettlementCutoverReadinessV1,
  deriveProviderSettlementEpochFromBatchV1,
  normalizeProviderSettlementCutoverEnvelopeV1,
  normalizeProviderSettlementCutoverReadinessEvidenceV1,
} = require("../src/provider-settlement-cutover-boundary");

const SYSTEM_ID = "system:provider-settlement-cutover";
const OCCURRED_AT = "2026-08-10T00:00:00.000Z";

function cutoverId(label) {
  return `PSC-${canonicalHash({ label }).slice(0, 32)}`;
}

function cutover(label = "primary", actorId = SYSTEM_ID) {
  return {
    version: 1,
    cutover_id: cutoverId(label),
    actor: { type: "system", actor_id: actorId },
    settlement_contract_version: 2,
    send_authorization_contract_version: 2,
    payload_hash: canonicalHash({
      settlement_contract_version: 2,
      send_authorization_contract_version: 2,
    }),
  };
}

function initialProjection(extra = {}) {
  return {
    schema_version: 2,
    work_orders: {},
    command_receipts: {},
    observation_receipts: {},
    internal_receipts: {},
    outbox: {},
    late_observations: {},
    provider_settlement_epoch: null,
    ...extra,
  };
}

function readinessEvidence(projectedReadiness, transform = (value) => value) {
  const assessment = transform({
    assessment_schema_version: 1,
    status: "ready",
    event_store_recovery: "clean",
    settlement_ingress: "stopped",
    provider_reactors: "stopped",
    send_authorization_contract_version: 2,
    projected_readiness: structuredClone(projectedReadiness),
  });
  const hash = canonicalHash(assessment);
  return {
    readiness_assessment_ref: {
      id: `PSA-${hash.slice(0, 32)}`,
      hash,
    },
    assessment,
  };
}

function applyCutover(projection, request) {
  return {
    ...projection,
    provider_settlement_epoch: deriveProviderSettlementEpochFromBatchV1(request),
  };
}

function markerEventId(sourceId, ordinal, event) {
  return `BVE-${canonicalHash({
    source_id: sourceId,
    ordinal,
    type: event.type,
    payload: event.payload,
    evidence_refs: event.evidence_refs,
  }).slice(0, 32)}`;
}

function errorWithCode(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function memoryEventStore({
  state = initialProjection(),
  sequence = 0,
  conflictOnce = false,
  responseLossOnce = false,
  invalidResultOnce = false,
  idempotentResultOnce = false,
  recoveryReplayError = null,
  mutateOnConflict = null,
} = {}) {
  let currentState = structuredClone(state);
  let currentSequence = sequence;
  let conflicts = conflictOnce ? 1 : 0;
  let responseLosses = responseLossOnce ? 1 : 0;
  let invalidResults = invalidResultOnce ? 1 : 0;
  let idempotentResults = idempotentResultOnce ? 1 : 0;
  const batches = new Map();
  const commitCalls = [];
  const replayCalls = [];
  return {
    get state() { return currentState; },
    get sequence() { return currentSequence; },
    commitCalls,
    replayCalls,
    async replay(configuration, control) {
      replayCalls.push({
        configuration,
        has_signal: Boolean(control?.signal),
        signal_aborted: control?.signal?.aborted === true,
      });
      if (commitCalls.length > 0 && recoveryReplayError) {
        throw recoveryReplayError;
      }
      return {
        state: currentState,
        watermark: { journal_sequence: currentSequence },
      };
    },
    async commit(request) {
      commitCalls.push(structuredClone(request));
      if (conflicts > 0) {
        conflicts -= 1;
        currentSequence += 1;
        currentState = mutateOnConflict
          ? mutateOnConflict(currentState, currentSequence)
          : { ...currentState, unrelated_journal_activity: currentSequence };
        throw errorWithCode("EVENT_REVISION_CONFLICT");
      }
      const serialized = canonicalJson(request);
      const existing = batches.get(request.batch_id);
      if (existing) {
        if (existing.serialized !== serialized) throw errorWithCode("EVENT_BATCH_ID_CONFLICT");
        return { status: "idempotent", sequence: existing.sequence };
      }
      if (request.expected_revision !== currentSequence) {
        throw errorWithCode("EVENT_REVISION_CONFLICT");
      }
      currentState = applyCutover(currentState, request);
      currentSequence += 1;
      batches.set(request.batch_id, {
        serialized,
        sequence: currentSequence,
      });
      if (responseLosses > 0) {
        responseLosses -= 1;
        throw errorWithCode("ECONNRESET", "commit response was lost");
      }
      if (idempotentResults > 0) {
        idempotentResults -= 1;
        return { status: "idempotent", sequence: currentSequence };
      }
      if (invalidResults > 0) {
        invalidResults -= 1;
        return { status: "unknown" };
      }
      return { status: "committed", sequence: currentSequence };
    },
  };
}

function boundaryFixture(store, {
  actorId = SYSTEM_ID,
  authenticate,
  authorize,
  resolveReadiness,
  prevalidate,
  clock = () => OCCURRED_AT,
  maxGlobalCasRetries = 3,
  dependencyTimeoutMs = 5_000,
} = {}) {
  const calls = {
    authenticate: 0,
    authorize: 0,
    readiness: 0,
    prevalidate: 0,
    readiness_refs: [],
  };
  const boundary = createBusinessProviderSettlementCutoverBoundary({
    eventStore: store,
    clock,
    maxGlobalCasRetries,
    dependencyTimeoutMs,
    authorizer: {
      async authenticate(args) {
        calls.authenticate += 1;
        if (authenticate) return authenticate(args, calls);
        return { principal: { type: "system", id: actorId } };
      },
      async authorize(args) {
        calls.authorize += 1;
        if (authorize) return authorize(args, calls);
        return {
          authorized: true,
          principal_type: "system",
          principal_id: args.principal.id,
          action: args.action,
          cutover_id: args.cutover.cutover_id,
          settlement_contract_version: 2,
          send_authorization_contract_version: 2,
        };
      },
    },
    resolvers: {
      async resolveReadiness(args) {
        calls.readiness += 1;
        const result = resolveReadiness
          ? await resolveReadiness(args, calls)
          : readinessEvidence(args.projected_readiness);
        calls.readiness_refs.push(result?.readiness_assessment_ref?.id || null);
        return result;
      },
    },
    projectionAdapter: {
      configuration: { name: "business-projection-v2-test-adapter" },
      async prevalidateCutoverBatch(args) {
        calls.prevalidate += 1;
        if (prevalidate) return prevalidate(args, calls);
        assert.deepEqual(
          deriveProviderSettlementEpochFromBatchV1(args.request),
          args.expected_epoch,
        );
        return applyCutover(args.projection, args.request);
      },
    },
  });
  return { boundary, calls };
}

function expectCode(code) {
  return (error) => {
    assert.ok(error instanceof BusinessProviderSettlementCutoverBoundaryError);
    assert.equal(error.code, code);
    return true;
  };
}

test("normalizes one system-only, hash-bound V1 cutover intent", () => {
  const value = cutover("normalize");
  assert.deepEqual(normalizeProviderSettlementCutoverEnvelopeV1(value), value);

  assert.throws(
    () => normalizeProviderSettlementCutoverEnvelopeV1({ ...value, extra: true }),
    expectCode("BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_INVALID"),
  );
  assert.throws(
    () => normalizeProviderSettlementCutoverEnvelopeV1({
      ...value,
      actor: { type: "agent", actor_id: SYSTEM_ID },
    }),
    expectCode("BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_ACTOR_INVALID"),
  );
  assert.throws(
    () => normalizeProviderSettlementCutoverEnvelopeV1({
      ...value,
      payload_hash: canonicalHash({
        settlement_contract_version: 1,
        send_authorization_contract_version: 2,
      }),
    }),
    expectCode("BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_HASH_MISMATCH"),
  );
});

test("derives exact projected readiness and inventories incomplete or unsafe state", () => {
  const state = initialProjection({
    work_orders: {
      "WO-11111111111111111111111111111111": {
        revision: 9,
        pending_projection_input: {
          source_id: "OBS-11111111111111111111111111111111",
          source_type: "observation",
          batch_id: "business:OBS-11111111111111111111111111111111",
        },
      },
    },
    outbox: {
      "FX-22222222222222222222222222222222": {
        effect_contract_version: 2,
        status: "sending",
      },
      "effect:legacy:pending": { status: "pending" },
      "FX-33333333333333333333333333333333": {
        effect_contract_version: 2,
        status: "pending",
      },
    },
  });
  const readiness = deriveProviderSettlementCutoverReadinessV1(state, 41);
  assert.equal(readiness.journal_sequence, 41);
  assert.equal(readiness.pre_cutover_projection_hash, canonicalHash(state));
  assert.equal(readiness.pending_projection_inputs.length, 1);
  assert.deepEqual(
    readiness.unsafe_provider_effects.map((effect) => [effect.effect_id, effect.reason]),
    [
      ["FX-22222222222222222222222222222222", "in_flight_or_ambiguous"],
      ["effect:legacy:pending", "legacy_unresolved"],
    ],
  );
});

test("builds the deterministic two-event marker and derives its non-self-referential epoch", () => {
  const state = initialProjection({
    work_orders: {
      "WO-44444444444444444444444444444444": {
        revision: 7,
        pending_projection_input: null,
      },
    },
  });
  const projected = deriveProviderSettlementCutoverReadinessV1(state, 17);
  const built = buildProviderSettlementCutoverBatchV1({
    cutover: cutover("build"),
    principal: { type: "system", id: SYSTEM_ID },
    projection: state,
    journal_sequence: 17,
    readiness: readinessEvidence(projected),
    occurred_at: OCCURRED_AT,
  });

  assert.equal(built.request.expected_revision, 17);
  assert.equal(built.request.events.length, 2);
  assert.deepEqual(built.request.events.map((event) => event.type), [
    PROVIDER_SETTLEMENT_ACTIVATED_EVENT,
    PROVIDER_SETTLEMENT_CUTOVER_RECEIVED_EVENT,
  ]);
  assert.equal(built.request.events[1].payload.source_type, PROVIDER_SETTLEMENT_CUTOVER_SOURCE_TYPE);
  assert.equal(built.request.events[1].payload.applied_journal_sequence, 18);
  assert.deepEqual(built.request.events[1].payload.event_ids, [built.request.events[0].event_id]);
  assert.equal(built.epoch.legacy_tail_sequence, 17);
  assert.equal(built.epoch.activation_journal_sequence, 18);
  assert.equal(built.epoch.activation_batch_core_hash, canonicalHash(built.request));
  assert.equal(built.epoch.pre_cutover_projection_hash, canonicalHash(state));
  assert.equal(built.epoch.receipt.result.status, "activated");
  assert.equal(Object.hasOwn(built.epoch.receipt, "activation_batch_core_hash"), false);
  for (const event of built.request.events) {
    assert.equal(Object.hasOwn(event.payload, "work_order_id"), false);
    assert.equal(Object.hasOwn(event.payload, "target_work_order_revision"), false);
  }

  const tampered = structuredClone(built.request);
  tampered.events[1].payload.event_ids = ["BVE-hostile"];
  assert.throws(
    () => deriveProviderSettlementEpochFromBatchV1(tampered),
    expectCode("BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_BATCH_INVALID"),
  );
});

test("pure marker derivation binds the journal actor and fixed V2 payload to receipt identity", () => {
  const state = initialProjection();
  const intent = cutover("batch-identity");
  const built = buildProviderSettlementCutoverBatchV1({
    cutover: intent,
    principal: { type: "system", id: SYSTEM_ID },
    projection: state,
    journal_sequence: 0,
    readiness: readinessEvidence(
      deriveProviderSettlementCutoverReadinessV1(state, 0),
    ),
    occurred_at: OCCURRED_AT,
  });

  const actorMismatch = structuredClone(built.request);
  actorMismatch.actor.id = "system:hostile-cutover-author";
  assert.throws(
    () => deriveProviderSettlementEpochFromBatchV1(actorMismatch),
    expectCode("BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_BATCH_INVALID"),
  );

  const payloadMismatch = structuredClone(built.request);
  const wrongPayloadHash = canonicalHash({
    settlement_contract_version: 999,
    send_authorization_contract_version: 2,
  });
  payloadMismatch.events[1].payload.payload_hash = wrongPayloadHash;
  payloadMismatch.events[1].payload.identity_hash = canonicalHash({
    source_type: PROVIDER_SETTLEMENT_CUTOVER_SOURCE_TYPE,
    cutover: { ...intent, payload_hash: wrongPayloadHash },
    authenticated_principal: { type: "system", id: SYSTEM_ID },
  });
  payloadMismatch.events[1].event_id = markerEventId(
    intent.cutover_id,
    1,
    payloadMismatch.events[1],
  );
  assert.throws(
    () => deriveProviderSettlementEpochFromBatchV1(payloadMismatch),
    expectCode("BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_BATCH_INVALID"),
  );
});

test("commits one authorized global marker without changing any Work Order revision", async () => {
  const workOrders = {
    "WO-55555555555555555555555555555555": {
      revision: 23,
      pending_projection_input: null,
      status: "running",
    },
  };
  const store = memoryEventStore({ state: initialProjection({ work_orders: workOrders }) });
  const { boundary, calls } = boundaryFixture(store);
  const result = await boundary.execute({
    cutover: cutover("success"),
    authentication: { bearer: "redacted" },
  });

  assert.deepEqual(result, {
    status: "activated",
    settlement_contract_version: 2,
    send_authorization_contract_version: 2,
  });
  assert.equal(store.commitCalls.length, 1);
  assert.equal(calls.authenticate, 1);
  assert.equal(calls.authorize, 1);
  assert.equal(calls.readiness, 1);
  assert.equal(calls.prevalidate, 1);
  assert.deepEqual(store.state.work_orders, workOrders);
  assert.equal(store.state.work_orders[Object.keys(workOrders)[0]].revision, 23);
  assert.equal(store.state.provider_settlement_epoch.receipt.source_type,
    PROVIDER_SETTLEMENT_CUTOVER_SOURCE_TYPE);
});

test("uses the canonical Business projector against the real EventStore by default", async () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-settlement-cutover-"));
  try {
    const store = createEventStore({
      stateRoot,
      workspaceId: "provider-settlement-cutover-integration",
      ...businessProjectionConfigurationV1(),
      preflightProjection: true,
      clock: () => OCCURRED_AT,
    });
    const boundary = createBusinessProviderSettlementCutoverBoundary({
      eventStore: store,
      clock: () => OCCURRED_AT,
      authorizer: {
        async authenticate() {
          return { principal: { type: "system", id: SYSTEM_ID } };
        },
        async authorize(args) {
          return {
            authorized: true,
            principal_type: "system",
            principal_id: args.principal.id,
            action: args.action,
            cutover_id: args.cutover.cutover_id,
            settlement_contract_version: 2,
            send_authorization_contract_version: 2,
          };
        },
      },
      resolvers: {
        async resolveReadiness(args) {
          return readinessEvidence(args.projected_readiness);
        },
      },
    });
    const result = await boundary.execute({
      cutover: cutover("real-event-store"),
      authentication: { system_token: "redacted" },
    });
    assert.deepEqual(result, {
      status: "activated",
      settlement_contract_version: 2,
      send_authorization_contract_version: 2,
    });

    const replayed = store.replay(businessProjectionConfigurationV1());
    assert.equal(replayed.watermark.journal_sequence, 1);
    assert.equal(replayed.state.provider_settlement_epoch.cutover_id,
      cutover("real-event-store").cutover_id);
    assert.deepEqual(replayed.state.work_orders, {});

    const exactReplay = await boundary.execute({
      cutover: cutover("real-event-store"),
      authentication: { system_token: "redacted" },
    });
    assert.deepEqual(exactReplay, result);
    assert.equal(store.replay(businessProjectionConfigurationV1()).watermark.journal_sequence, 1);

    const hostileSourceId = `OBS-${"f".repeat(32)}`;
    const hostileWorkOrderId = `WO-${"f".repeat(32)}`;
    const binding = {
      work_order_id: hostileWorkOrderId,
      plan_snapshot_ref: `BPS-${"f".repeat(32)}`,
      plan_hash: "f".repeat(64),
      source_id: hostileSourceId,
      prior_work_order_revision: 0,
      target_work_order_revision: 1,
      occurred_at: OCCURRED_AT,
    };
    const hostileDomainEvent = {
      event_id: `${hostileSourceId}:settlement`,
      schema_version: 1,
      type: "business.outbox.delivered",
      payload: { ...binding, effect_id: `FX-${"f".repeat(32)}` },
      evidence_refs: [],
    };
    const hostileBatchId = `business:${hostileSourceId}`;
    const hostileReceiptEvent = {
      event_id: `${hostileSourceId}:receipt`,
      schema_version: 1,
      type: "business.observation.received",
      payload: {
        ...binding,
        receipt: {
          source_id: hostileSourceId,
          source_type: "observation",
          identity_hash: canonicalHash({ hostileSourceId, kind: "generic-suffix" }),
          payload_hash: canonicalHash(hostileDomainEvent.payload),
          work_order_id: hostileWorkOrderId,
          applied_revision: 1,
          batch_id: hostileBatchId,
          event_ids: [hostileDomainEvent.event_id],
          result: { status: "forged" },
        },
      },
      evidence_refs: [],
    };
    assert.throws(
      () => store.commit({
        expected_revision: 1,
        batch_id: hostileBatchId,
        actor: { type: "agent", id: "redteam:generic-settlement-suffix" },
        correlation_id: hostileSourceId,
        events: [hostileDomainEvent, hostileReceiptEvent],
      }),
      { code: "BUSINESS_PROJECTION_PROVIDER_SETTLEMENT_ROUTE" },
    );
    const afterRejectedSuffix = store.replay(businessProjectionConfigurationV1());
    assert.equal(afterRejectedSuffix.watermark.journal_sequence, 1);
    assert.equal(afterRejectedSuffix.state.observation_receipts[hostileSourceId], undefined);
    const pendingDirectory = path.join(stateRoot, "pending");
    assert.deepEqual(
      fs.existsSync(pendingDirectory) ? fs.readdirSync(pendingDirectory) : [],
      [],
    );
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("returns an exact receipt before readiness and already-activated gates", async () => {
  const store = memoryEventStore();
  const fixture = boundaryFixture(store);
  const input = { cutover: cutover("idempotent"), authentication: {} };
  const first = await fixture.boundary.execute(input);
  const second = await fixture.boundary.execute(input);

  assert.deepEqual(second, first);
  assert.equal(store.commitCalls.length, 1);
  assert.equal(fixture.calls.authorize, 2);
  assert.equal(fixture.calls.readiness, 1);
  assert.equal(fixture.calls.prevalidate, 1);
});

test("exact replay rederives stored marker IDs and activation batch core", async (t) => {
  const intent = cutover("tampered-epoch");
  const sourceStore = memoryEventStore();
  await boundaryFixture(sourceStore).boundary.execute({
    cutover: intent,
    authentication: {},
  });
  const validState = structuredClone(sourceStore.state);
  const cases = [
    ["batch core", (epoch) => {
      epoch.activation_batch_core_hash = "0".repeat(64);
    }],
    ["receipt event id", (epoch) => {
      epoch.activation_receipt_event_id = "BVE-hostile-receipt";
    }],
    ["activation event id", (epoch) => {
      epoch.activation_event_id = "BVE-hostile-activation";
      epoch.receipt.event_ids = [epoch.activation_event_id];
    }],
  ];

  for (const [label, mutate] of cases) {
    await t.test(label, async () => {
      const hostile = structuredClone(validState);
      mutate(hostile.provider_settlement_epoch);
      const store = memoryEventStore({ state: hostile, sequence: 1 });
      const fixture = boundaryFixture(store);
      await assert.rejects(
        fixture.boundary.execute({ cutover: intent, authentication: {} }),
        expectCode("BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_RECEIPT_INVALID"),
      );
      assert.equal(fixture.calls.readiness, 0);
      assert.equal(store.commitCalls.length, 0);
    });
  }
});

test("rejects reuse of a cutover ID by another authenticated principal", async () => {
  const store = memoryEventStore();
  const first = boundaryFixture(store);
  await first.boundary.execute({ cutover: cutover("identity"), authentication: {} });

  const otherId = "system:provider-settlement-cutover-other";
  const second = boundaryFixture(store, { actorId: otherId });
  await assert.rejects(
    second.boundary.execute({
      cutover: cutover("identity", otherId),
      authentication: {},
    }),
    expectCode("BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_ID_CONFLICT"),
  );
  assert.equal(second.calls.readiness, 0);
  assert.equal(store.commitCalls.length, 1);
});

test("does not replace an epoch activated by another cutover", async () => {
  const store = memoryEventStore();
  await boundaryFixture(store).boundary.execute({
    cutover: cutover("first-epoch"),
    authentication: {},
  });
  const second = boundaryFixture(store);
  await assert.rejects(
    second.boundary.execute({
      cutover: cutover("second-epoch"),
      authentication: {},
    }),
    expectCode("BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_ALREADY_ACTIVATED"),
  );
  assert.equal(second.calls.readiness, 0);
});

test("requires resolver evidence to match the exact current projection and watermark", async () => {
  const store = memoryEventStore();
  const { boundary } = boundaryFixture(store, {
    resolveReadiness(args) {
      const stale = structuredClone(args.projected_readiness);
      stale.journal_sequence += 1;
      return readinessEvidence(stale);
    },
  });
  await assert.rejects(
    boundary.execute({ cutover: cutover("stale-readiness"), authentication: {} }),
    expectCode("BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_READINESS_STALE"),
  );
  assert.equal(store.commitCalls.length, 0);
});

test("requires the readiness reference to content-address the normalized assessment", async () => {
  const store = memoryEventStore();
  const { boundary } = boundaryFixture(store, {
    resolveReadiness(args) {
      const evidence = readinessEvidence(args.projected_readiness);
      const wrongHash = canonicalHash({ not: "the assessment" });
      evidence.readiness_assessment_ref = {
        id: `PSA-${wrongHash.slice(0, 32)}`,
        hash: wrongHash,
      };
      return evidence;
    },
  });
  await assert.rejects(
    boundary.execute({ cutover: cutover("bad-assessment-ref"), authentication: {} }),
    expectCode("BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_READINESS_HASH_MISMATCH"),
  );
});

test("blocks cutover when the exact projected inventory is unsafe", async () => {
  const store = memoryEventStore({
    state: initialProjection({
      outbox: {
        "FX-66666666666666666666666666666666": {
          effect_contract_version: 2,
          status: "delivery_unknown",
        },
      },
    }),
  });
  const { boundary } = boundaryFixture(store);
  await assert.rejects(
    boundary.execute({ cutover: cutover("unsafe"), authentication: {} }),
    expectCode("BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_NOT_READY"),
  );
  assert.equal(store.commitCalls.length, 0);
});

test("replays, reauthorizes, and recomputes position, projection hash, and evidence after CAS loss", async () => {
  const store = memoryEventStore({
    conflictOnce: true,
    mutateOnConflict(state, sequence) {
      return { ...state, unrelated_journal_activity: { sequence } };
    },
  });
  const times = ["2026-08-10T00:00:01.000Z", "2026-08-10T00:00:02.000Z"];
  const { boundary, calls } = boundaryFixture(store, {
    clock: () => times.shift(),
  });
  const result = await boundary.execute({
    cutover: cutover("cas"),
    authentication: {},
  });

  assert.equal(result.status, "activated");
  assert.equal(store.commitCalls.length, 2);
  assert.equal(calls.authorize, 2);
  assert.equal(calls.readiness, 2);
  assert.equal(calls.prevalidate, 2);
  assert.notEqual(calls.readiness_refs[0], calls.readiness_refs[1]);
  assert.notEqual(
    store.commitCalls[0].events[0].payload.pre_cutover_projection_hash,
    store.commitCalls[1].events[0].payload.pre_cutover_projection_hash,
  );
  assert.equal(store.commitCalls[0].expected_revision, 0);
  assert.equal(store.commitCalls[1].expected_revision, 1);
  assert.equal(store.state.provider_settlement_epoch.legacy_tail_sequence, 1);
  assert.equal(store.state.provider_settlement_epoch.activation_journal_sequence, 2);
  assert.equal(store.state.provider_settlement_epoch.activated_at, times[0] || "2026-08-10T00:00:02.000Z");
});

test("bounds repeated journal-global CAS loss without weakening readiness", async () => {
  const state = initialProjection();
  const commitCalls = [];
  const store = {
    async replay() {
      return { state, watermark: { journal_sequence: 0 } };
    },
    async commit(request) {
      commitCalls.push(request);
      throw errorWithCode("EVENT_REVISION_CONFLICT");
    },
  };
  const fixture = boundaryFixture(store, { maxGlobalCasRetries: 2 });
  await assert.rejects(
    fixture.boundary.execute({ cutover: cutover("cas-exhausted"), authentication: {} }),
    (error) => {
      assert.ok(error instanceof BusinessProviderSettlementCutoverBoundaryError);
      assert.equal(
        error.code,
        "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_GLOBAL_CAS_EXHAUSTED",
      );
      assert.equal(error.details.attempts, 3);
      return true;
    },
  );
  assert.equal(commitCalls.length, 3);
  assert.equal(fixture.calls.authorize, 3);
  assert.equal(fixture.calls.readiness, 3);
});

test("recovers a lost commit response only from the exact durable receipt", async () => {
  const store = memoryEventStore({ responseLossOnce: true });
  const { boundary } = boundaryFixture(store);
  const result = await boundary.execute({
    cutover: cutover("response-loss"),
    authentication: {},
  });

  assert.deepEqual(result, {
    status: "activated",
    settlement_contract_version: 2,
    send_authorization_contract_version: 2,
  });
  assert.equal(store.commitCalls.length, 1);
  assert.ok(store.replayCalls.length >= 2);
  assert.equal(store.state.provider_settlement_epoch.cutover_id, cutoverId("response-loss"));
});

test("accepts an idempotent EventStore result only after replaying its exact receipt", async () => {
  const store = memoryEventStore({ idempotentResultOnce: true });
  const { boundary } = boundaryFixture(store);
  const result = await boundary.execute({
    cutover: cutover("idempotent-commit-result"),
    authentication: {},
  });
  assert.deepEqual(result, {
    status: "activated",
    settlement_contract_version: 2,
    send_authorization_contract_version: 2,
  });
  assert.equal(store.commitCalls.length, 1);
  assert.ok(store.replayCalls.length >= 2);
});

test("classifies a lost commit response with failed receipt recovery as unknown", async () => {
  const store = memoryEventStore({
    responseLossOnce: true,
    recoveryReplayError: errorWithCode("EIO", "recovery replay failed"),
  });
  const { boundary } = boundaryFixture(store);
  await assert.rejects(
    boundary.execute({
      cutover: cutover("response-loss-recovery-failed"),
      authentication: {},
    }),
    (error) => {
      assert.ok(error instanceof BusinessProviderSettlementCutoverBoundaryError);
      assert.equal(
        error.code,
        "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_COMMIT_OUTCOME_UNKNOWN",
      );
      assert.equal(error.details.cause_code, "ECONNRESET");
      assert.equal(
        error.details.recovery_code,
        "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_REPLAY_FAILED",
      );
      assert.equal(error.details.commit_outcome, "unknown");
      assert.equal(error.details.reconciliation_required, true);
      return true;
    },
  );
  assert.equal(store.commitCalls.length, 1);
  assert.equal(store.state.provider_settlement_epoch.cutover_id,
    cutoverId("response-loss-recovery-failed"));
});

test("caller abort after commit begins cannot cancel exact receipt reconciliation", async () => {
  const controller = new AbortController();
  const durableStore = memoryEventStore({ responseLossOnce: true });
  const store = {
    replay: (...args) => durableStore.replay(...args),
    async commit(request) {
      controller.abort("caller stopped waiting");
      return durableStore.commit(request);
    },
  };
  const { boundary } = boundaryFixture(store);
  const result = await boundary.execute({
    cutover: cutover("abort-after-commit"),
    authentication: {},
    signal: controller.signal,
  });
  assert.equal(result.status, "activated");
  assert.equal(durableStore.commitCalls.length, 1);
  assert.equal(durableStore.replayCalls.at(-1).signal_aborted, false);
  assert.equal(durableStore.state.provider_settlement_epoch.cutover_id,
    cutoverId("abort-after-commit"));
});

test("also reconciles an invalid commit response when the exact marker is durable", async () => {
  const store = memoryEventStore({ invalidResultOnce: true });
  const { boundary } = boundaryFixture(store);
  const result = await boundary.execute({
    cutover: cutover("invalid-response"),
    authentication: {},
  });
  assert.equal(result.status, "activated");
  assert.equal(store.commitCalls.length, 1);
});

test("rejects a prevalidator that mutates Work Orders or any state beyond the epoch", async () => {
  const state = initialProjection({
    work_orders: {
      "WO-77777777777777777777777777777777": {
        revision: 4,
        pending_projection_input: null,
      },
    },
  });
  const store = memoryEventStore({ state });
  const { boundary } = boundaryFixture(store, {
    prevalidate(args) {
      const candidate = applyCutover(args.projection, args.request);
      candidate.work_orders = structuredClone(candidate.work_orders);
      candidate.work_orders["WO-77777777777777777777777777777777"].revision = 5;
      return candidate;
    },
  });
  await assert.rejects(
    boundary.execute({ cutover: cutover("hostile-prevalidate"), authentication: {} }),
    expectCode("BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_PREVALIDATION_INVALID"),
  );
  assert.equal(store.commitCalls.length, 0);
});

test("detaches and freezes replay state before authorizer or prevalidator hooks", async () => {
  const workOrderId = "WO-99999999999999999999999999999999";
  const state = initialProjection({
    work_orders: {
      [workOrderId]: { revision: 12, pending_projection_input: null },
    },
  });

  const authorizationStore = memoryEventStore({ state });
  const authorizationAttack = boundaryFixture(authorizationStore, {
    authorize(args) {
      Object.defineProperty(args.projection.work_orders[workOrderId], "revision", {
        value: 13,
      });
      throw new Error("unreachable");
    },
  });
  await assert.rejects(
    authorizationAttack.boundary.execute({
      cutover: cutover("authorizer-in-place"),
      authentication: {},
    }),
    expectCode("BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_AUTHORIZATION_DENIED"),
  );
  assert.equal(authorizationStore.state.work_orders[workOrderId].revision, 12);
  assert.equal(authorizationStore.commitCalls.length, 0);

  const prevalidationStore = memoryEventStore({ state });
  const prevalidationAttack = boundaryFixture(prevalidationStore, {
    prevalidate(args) {
      Object.defineProperty(args.projection.work_orders[workOrderId], "revision", {
        value: 13,
      });
      return applyCutover(args.projection, args.request);
    },
  });
  await assert.rejects(
    prevalidationAttack.boundary.execute({
      cutover: cutover("prevalidator-in-place"),
      authentication: {},
    }),
    expectCode("BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_PREVALIDATION_FAILED"),
  );
  assert.equal(prevalidationStore.state.work_orders[workOrderId].revision, 12);
  assert.equal(prevalidationStore.commitCalls.length, 0);
});

test("honors AbortSignal and bounds pre-commit dependencies", async () => {
  const abortedStore = memoryEventStore();
  const aborted = boundaryFixture(abortedStore);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    aborted.boundary.execute({
      cutover: cutover("aborted"),
      authentication: {},
      signal: controller.signal,
    }),
    expectCode("BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_ABORTED"),
  );
  assert.equal(abortedStore.commitCalls.length, 0);

  const timeoutStore = memoryEventStore();
  const timed = boundaryFixture(timeoutStore, {
    dependencyTimeoutMs: 10,
    resolveReadiness() {
      return new Promise(() => {});
    },
  });
  await assert.rejects(
    timed.boundary.execute({ cutover: cutover("timeout"), authentication: {} }),
    expectCode("BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_DEPENDENCY_TIMEOUT"),
  );
  assert.equal(timeoutStore.commitCalls.length, 0);
});

test("fails closed until the integrated Business projector exposes projection V2 and epoch state", async () => {
  const store = memoryEventStore({
    state: {
      ...initialProjection(),
      schema_version: 1,
    },
  });
  const { boundary } = boundaryFixture(store);
  await assert.rejects(
    boundary.execute({ cutover: cutover("old-projector"), authentication: {} }),
    expectCode("BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_PROJECTION_INVALID"),
  );
  assert.equal(store.commitCalls.length, 0);
});

test("requires exact authorization for the journal-global cutover action", async () => {
  const store = memoryEventStore();
  const { boundary } = boundaryFixture(store, {
    authorize(args) {
      assert.equal(args.action, PROVIDER_SETTLEMENT_CUTOVER_ACTION);
      return {
        authorized: true,
        principal_type: "system",
        principal_id: args.principal.id,
        action: args.action,
        cutover_id: args.cutover.cutover_id,
        settlement_contract_version: 2,
        send_authorization_contract_version: 2,
        work_order_id: "must-not-be-present",
      };
    },
  });
  await assert.rejects(
    boundary.execute({ cutover: cutover("authority"), authentication: {} }),
    expectCode("BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_AUTHORIZATION_DENIED"),
  );
  assert.equal(store.commitCalls.length, 0);
});

test("public readiness normalizer rejects a clean label over a non-clean exact inventory", () => {
  const state = initialProjection({
    outbox: {
      "FX-88888888888888888888888888888888": {
        effect_contract_version: 2,
        status: "claimed",
      },
    },
  });
  const projected = deriveProviderSettlementCutoverReadinessV1(state, 3);
  assert.throws(
    () => normalizeProviderSettlementCutoverReadinessEvidenceV1(
      readinessEvidence(projected),
      projected,
    ),
    expectCode("BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_NOT_READY"),
  );
});
