"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { reconcileContextReceiptV2 } = require("../src");

const NOW = "2026-07-31T00:00:00.000Z";

function fixture(overrides = {}) {
  const envelope = {
    task_envelope_id: "TE-123456789abc",
    task_intent_id: "TI-1",
    workstream_id: "workstream:T1",
    terminal_outcome: "Complete the parent result.",
    continue_policy: "continue_until_terminal",
    notification_policy: { silent_progress: true, notify_on: ["blocker", "user_action", "terminal"] },
    ...overrides.envelope,
  };
  const pack = {
    context_pack_id: "CP2-123456789abc",
    task_intent_id: "TI-1",
    task_envelope_id: envelope.task_envelope_id,
  };
  const receipt = {
    receipt_id: "CE-123456789abc",
    context_pack_id: pack.context_pack_id,
    task_intent_id: pack.task_intent_id,
    initial_token_estimate: 1200,
    additional_tokens: 200,
    compaction_count: 0,
    missing_context: [],
    user_corrections: 0,
    incorrect_project_facts: 0,
    acceptance_results: [{ criterion_id: "acceptance:1", status: "passed", evidence_refs: ["test:1"] }],
    created_at: NOW,
    ...overrides.receipt,
  };
  const controlPlane = {
    version: 2,
    project_id: "project-1",
    revision: 3,
    active_workstream: {
      workstream_id: "workstream:T1",
      task_id: "T1",
      current_goal: "Produce the local result.",
      next_decision: "Run the specialist.",
    },
    updated_at: NOW,
  };
  return { projectControlPlane: controlPlane, taskEnvelope: envelope, contextPack: pack, contextReceipt: receipt, observedAt: NOW };
}

test("accepted local work schedules continuation without waking the orchestrator", () => {
  const result = reconcileContextReceiptV2(fixture());
  assert.equal(result.branch_delta.transition, "continuation_ready");
  assert.equal(result.branch_delta.orchestrator_action, "schedule_continuation");
  assert.equal(result.notification.wake_orchestrator, false);
  assert.equal(result.project_control_plane.revision, 4);
});

test("missing context creates one blocking delta and wakes the orchestrator", () => {
  const result = reconcileContextReceiptV2(fixture({
    receipt: { missing_context: ["Current owner decision is unavailable."] },
  }));
  assert.equal(result.branch_delta.transition, "needs_context");
  assert.equal(result.notification.wake_orchestrator, true);
  assert.equal(result.notification.notify_user, true);
});

test("the same receipt is idempotent when its branch delta was already applied", () => {
  const first = reconcileContextReceiptV2(fixture());
  const second = reconcileContextReceiptV2({
    ...fixture(),
    priorBranchDeltaIds: [first.branch_delta.branch_delta_id],
  });
  assert.equal(second.duplicate, true);
  assert.equal(second.notification.wake_orchestrator, false);
  assert.equal(second.project_control_plane.revision, 3);
});

test("terminal acceptance follows notification policy and rejects mismatched bindings", () => {
  const accepted = reconcileContextReceiptV2({ ...fixture(), terminalOutcomeCompleted: true });
  assert.equal(accepted.branch_delta.transition, "terminal_accepted");
  assert.equal(accepted.notification.wake_orchestrator, true);
  assert.equal(accepted.notification.notify_user, true);

  const invalid = fixture();
  invalid.contextReceipt.context_pack_id = "CP2-mismatch";
  assert.throws(() => reconcileContextReceiptV2(invalid), /context_receipt_binding_mismatch/);
});

test("parallel specialist receipts update only their own background workstream", () => {
  const base = fixture();
  const taskEnvelope = {
    ...base.taskEnvelope,
    workstream_id: "workstream:T2",
    task_intent_id: "TI-2",
    task_envelope_id: "TE-2",
  };
  const contextPack = {
    ...base.contextPack,
    task_intent_id: "TI-2",
    task_envelope_id: "TE-2",
    context_pack_id: "CP2-222222222222",
  };
  const contextReceipt = {
    ...base.contextReceipt,
    task_intent_id: "TI-2",
    context_pack_id: "CP2-222222222222",
    receipt_id: "CE-222222222222",
  };
  const plane = {
    ...base.projectControlPlane,
    active_workstream: {
      workstream_id: "workstream:T1",
      task_id: "T1",
      current_goal: "Keep the primary goal unchanged.",
      next_decision: "Wait for T1.",
    },
    background_workstreams: [{
      workstream_id: "workstream:T2",
      state: "running",
      summary: "Parallel implementation",
    }],
  };

  const result = reconcileContextReceiptV2({
    projectControlPlane: plane,
    taskEnvelope,
    contextPack,
    contextReceipt,
    terminalOutcomeCompleted: true,
    observedAt: NOW,
  });

  assert.equal(result.branch_delta.workstream_id, "workstream:T2");
  assert.deepEqual(result.project_control_plane.active_workstream, plane.active_workstream);
  assert.equal(result.project_control_plane.background_workstreams[0].state, "terminal_accepted");
  assert.equal(result.notification.wake_orchestrator, true);
});

test("a partial or invented acceptance list cannot complete a task", () => {
  const base = fixture();
  const contextPack = {
    ...base.contextPack,
    coverage_matrix: [
      { criterion_id: "acceptance:1", status: "covered", source_ids: [] },
      { criterion_id: "acceptance:2", status: "covered", source_ids: [] },
    ],
  };
  const partial = reconcileContextReceiptV2({
    ...base,
    contextPack,
    terminalOutcomeCompleted: true,
  });
  assert.equal(partial.branch_delta.transition, "verification_incomplete");
  assert.equal(partial.notification.wake_orchestrator, false);

  const invented = reconcileContextReceiptV2({
    ...base,
    contextPack,
    contextReceipt: {
      ...base.contextReceipt,
      acceptance_results: [
        { criterion_id: "acceptance:1", status: "passed", evidence_refs: ["test:1"] },
        { criterion_id: "acceptance:invented", status: "passed", evidence_refs: ["test:invented"] },
      ],
    },
    terminalOutcomeCompleted: true,
  });
  assert.equal(invented.branch_delta.transition, "verification_incomplete");
});
