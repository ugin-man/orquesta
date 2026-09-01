"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { canonicalHash } = require("@orquesta/contracts");
const { createEventStore } = require("@orquesta/event-store");
const { normalizeBusinessWorkOrderPlanV1 } = require("../src/contract");
const {
  REQUIRED_PROVIDER_EFFECTS,
  createBusinessCommandBoundary,
} = require("../src/command-boundary");
const {
  BUSINESS_EVENT_TYPES,
  initialBusinessProjectionV1,
  projectBusinessEventV1,
} = require("../src/projector");
const { decideWorkOrderV1 } = require("../src/state-machine");

const WORK_ORDER_ID = `WO-${"5".repeat(32)}`;
const COMMAND_ID = `CMD-${"6".repeat(32)}`;
const PRINCIPAL_ID = "orchestrator:business-integration";
const PROVIDER_REF = "provider:recorded-local";

function contentRef(id) {
  return { id, hash: canonicalHash({ id }) };
}

function planFixture() {
  return normalizeBusinessWorkOrderPlanV1({
    version: 1,
    project_ref: "project:business-integration",
    revision: 1,
    supersedes_plan_ref: null,
    title: "Execute one durable Business Work Order",
    desired_outcome: "One isolated branch is durably scheduled exactly once.",
    acceptance_policy: {
      criteria: [{
        criterion_id: "criterion:tests",
        description: "The recorded deterministic test passes.",
        verification: "deterministic",
        verification_requirements: [{
          kind: "deterministic",
          verification_ref: contentRef("verification:recorded-tests"),
        }],
      }],
      review_minimum: "light",
    },
    task_intent_ref: contentRef("TI-business-root"),
    execution_plan_ref: contentRef("EP-business-root"),
    context_pack_ref: contentRef("CP-business-root"),
    branches: [{
      branch_ref: "branch:implementation",
      task_intent_ref: contentRef("TI-business-implementation"),
      execution_plan_ref: contentRef("EP-business-implementation"),
      context_pack_ref: contentRef("CP-business-implementation"),
      dependencies: [],
      role: "work",
      parallelizable: false,
      isolation: "sandbox",
      assignee_ref: "agent:implementation",
      provider_ref: PROVIDER_REF,
      permission_mode: "workspace-write",
    }],
    integration_branch_ref: null,
    max_concurrency: 1,
    context_duplication_budget_tokens: 512,
    retry_policy: {
      max_attempts: 3,
      attempt_timeout_ms: 60_000,
      max_elapsed_ms: 300_000,
      backoff_initial_ms: 1_000,
      backoff_max_ms: 10_000,
      retryable_observations: ["branch.dispatch.not_sent"],
    },
    lease_policy: {
      lease_duration_ms: 30_000,
      heartbeat_interval_ms: 5_000,
      max_recovery_probes: 3,
    },
    provider_policy: {
      allowed_provider_refs: [PROVIDER_REF],
      selection: "fixed",
    },
    permission_mode: "workspace-write",
  });
}

function planContentRefs(plan) {
  const refs = [plan.task_intent_ref, plan.execution_plan_ref, plan.context_pack_ref];
  for (const branch of plan.branches) {
    refs.push(branch.task_intent_ref, branch.execution_plan_ref, branch.context_pack_ref);
  }
  for (const criterion of plan.acceptance_policy.criteria) {
    for (const requirement of criterion.verification_requirements) {
      refs.push(requirement.verification_ref);
    }
  }
  return refs.map((ref) => ({ id: ref.id, hash: ref.hash }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function projectionConfiguration() {
  return {
    initialState: initialBusinessProjectionV1(),
    reducers: Object.fromEntries(BUSINESS_EVENT_TYPES.map((type) => [
      type,
      (state, event, batch) => projectBusinessEventV1(state, event, batch),
    ])),
  };
}

test("the real command boundary, state machine, projector, and EventStore schedule exactly once", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-business-p0-"));
  try {
    const plan = planFixture();
    const projection = projectionConfiguration();
    const eventStore = createEventStore({
      stateRoot: root,
      workspaceId: "business-p0-integration",
      ...projection,
      preflightProjection: true,
      clock: () => "2026-08-09T08:00:00.000Z",
    });
    const command = {
      version: 1,
      command_id: COMMAND_ID,
      work_order_id: WORK_ORDER_ID,
      plan_snapshot_ref: plan.plan_snapshot_id,
      plan_hash: plan.plan_hash,
      expected_work_order_revision: 0,
      actor: { type: "orchestrator", actor_id: PRINCIPAL_ID },
      name: "work_order.start",
      payload: {},
      payload_hash: canonicalHash({}),
    };
    const boundary = createBusinessCommandBoundary({
      eventStore,
      authorizer: {
        async authenticate({ authentication }) {
          return authentication === "recorded-session"
            ? { type: "agent", id: PRINCIPAL_ID }
            : null;
        },
        async authorize({ project, principal }) {
          return {
            authorized: true,
            principal_type: principal.type,
            principal_id: principal.id,
            project_ref: project.project_ref,
            permission_mode: "workspace-write",
            allowed_provider_refs: [PROVIDER_REF],
            allowed_effects: [...REQUIRED_PROVIDER_EFFECTS],
          };
        },
      },
      resolvers: {
        async resolvePlan() { return plan; },
        async resolveProject({ project_ref: projectRef }) {
          return { project_ref: projectRef, status: "active" };
        },
        async resolvePlanArtifacts() {
          return {
            plan_snapshot_ref: plan.plan_snapshot_id,
            plan_hash: plan.plan_hash,
            project_ref: plan.project_ref,
            verified_refs: planContentRefs(plan),
            provider_capabilities: [{
              provider_ref: PROVIDER_REF,
              permission_modes: ["workspace-write"],
              isolation_modes: ["sandbox"],
              effects: [...REQUIRED_PROVIDER_EFFECTS],
            }],
          };
        },
        async resolveCommandFacts() {
          return {
            context_budget_receipt: {
              budget_tokens: 512,
              duplicate_context_tokens: 128,
              evidence_refs: ["evidence:context-budget"],
            },
            branch_criterion_ids: {
              "branch:implementation": ["criterion:tests"],
            },
            dispatch_packets: {
              "branch:implementation": contentRef("packet:implementation:attempt-1"),
            },
          };
        },
      },
      decider: decideWorkOrderV1,
      clock: () => "2026-08-09T07:59:59.000Z",
    });

    const first = await boundary.execute({ command, authentication: "recorded-session" });
    const replay = eventStore.replay(projection);
    const workOrder = replay.state.work_orders[WORK_ORDER_ID];
    const outbox = Object.values(replay.state.outbox);

    assert.deepEqual(first, {
      status: "starting",
      work_order_revision: 1,
      dispatched_branch_refs: ["branch:implementation"],
    });
    assert.equal(replay.watermark.journal_sequence, 1);
    assert.equal(workOrder.revision, 1);
    assert.equal(workOrder.branches["branch:implementation"].state, "dispatch_pending");
    assert.equal(workOrder.pending_projection_input, null);
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].status, "pending");
    assert.equal(outbox[0].effect_contract_version, 2);
    assert.equal(outbox[0].effect_kind, "provider.thread.create");
    assert.equal(outbox[0].predecessor_effect_id, null);
    assert.equal(outbox[0].predecessor_delivery_hash, null);
    assert.equal(outbox[0].target_runtime_identity, null);
    assert.equal(replay.state.command_receipts[COMMAND_ID].result.status, "starting");

    const exactReplay = await boundary.execute({ command, authentication: "recorded-session" });
    assert.deepEqual(exactReplay, first);
    assert.equal(eventStore.replay(projection).watermark.journal_sequence, 1);

    const forgedSourceId = `CMD-${"9".repeat(32)}`;
    const forgedBatchId = `business:${forgedSourceId}`;
    const forgedAt = "2026-08-09T08:00:01.000Z";
    const forgedBinding = {
      work_order_id: WORK_ORDER_ID,
      plan_snapshot_ref: plan.plan_snapshot_id,
      plan_hash: plan.plan_hash,
      source_id: forgedSourceId,
      prior_work_order_revision: 1,
      target_work_order_revision: 2,
      occurred_at: forgedAt,
    };
    assert.throws(
      () => eventStore.commit({
        expected_revision: 1,
        batch_id: forgedBatchId,
        actor: { type: "agent", id: "redteam:business-integration" },
        correlation_id: forgedSourceId,
        events: [{
          event_id: `${forgedSourceId}:foreign`,
          schema_version: 1,
          type: "task.updated",
          payload: { title: "Foreign event outside the Business aggregate" },
          evidence_refs: ["evidence:mixed-batch-attack"],
        }, {
          event_id: `${forgedSourceId}:receipt`,
          schema_version: 1,
          type: "business.command.received",
          payload: {
            ...forgedBinding,
            receipt: {
              source_id: forgedSourceId,
              source_type: "command",
              identity_hash: canonicalHash({ forgedSourceId, attack: "mixed-batch" }),
              payload_hash: canonicalHash({ status: "forged" }),
              work_order_id: WORK_ORDER_ID,
              applied_revision: 2,
              batch_id: forgedBatchId,
              event_ids: [],
              result: { status: "forged" },
            },
          },
          evidence_refs: [],
        }],
      }),
      { code: "BUSINESS_PROJECTION_EVENT_UNKNOWN" },
    );
    const afterRejectedForgery = eventStore.replay(projection);
    assert.equal(afterRejectedForgery.watermark.journal_sequence, 1);
    assert.equal(afterRejectedForgery.state.command_receipts[forgedSourceId], undefined);
    const pendingDirectory = path.join(root, "pending");
    assert.deepEqual(
      fs.existsSync(pendingDirectory) ? fs.readdirSync(pendingDirectory) : [],
      [],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
