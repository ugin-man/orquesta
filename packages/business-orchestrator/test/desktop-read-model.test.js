"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  BUSINESS_DESKTOP_READ_FEATURES,
  createBusinessDesktopReadResultV1,
  initialBusinessProjectionV1,
} = require("../src");

function workOrder(index) {
  const suffix = index.toString(16).padStart(32, "0");
  const id = `WO-${suffix}`;
  return {
    work_order_id: id,
    plan_snapshot_ref: `BPS-${suffix}`,
    plan_hash: "a".repeat(64),
    plan: { project_ref: index % 2 === 0 ? "project:a" : "project:b", title: `Work ${index}` },
    engine_contract_version: 1,
    revision: 1,
    status: "running",
    created_at: "2026-08-10T00:00:00.000Z",
    started_at: "2026-08-10T00:00:00.000Z",
    deadline_at: "2026-08-10T01:00:00.000Z",
    stop_reason: null,
    branches: {
      main: { branch_ref: "main", state: "running" },
    },
    attention: {},
    acceptance: { reviews: {}, decision: null },
    pending_projection_input: null,
  };
}

function request(afterKey = null) {
  return {
    projectId: "native-project",
    consumer: {
      name: "orquesta.business-work-orders.read",
      major: 1,
      minMinor: 0,
      requiredFeatures: [...BUSINESS_DESKTOP_READ_FEATURES],
    },
    afterCursor: null,
    query: { kind: "index", limit: 25, afterKey },
  };
}

function cursor(sequence = 1) {
  return {
    journalSequence: sequence,
    lastBatchId: "batch:one",
    journalHash: "b".repeat(64),
    projectionHash: "c".repeat(64),
  };
}

test("builds bounded keyset pages without conflating runtime and Business project identity", () => {
  const projection = {
    ...initialBusinessProjectionV1(),
    work_orders: Object.fromEntries(
      Array.from({ length: 26 }, (_, index) => {
        const item = workOrder(index);
        return [item.work_order_id, item];
      }),
    ),
  };
  const first = createBusinessDesktopReadResultV1({
    request: request(), projection, cursor: cursor(), continuity: "initial", runtimeProjectId: "native-project",
  });
  assert.equal(first.page.items.length, 25);
  assert.equal(first.page.nextAfterKey, first.page.items[24].key);
  assert.deepEqual(first.businessProjectScope, {
    mode: "multiple",
    projectRefs: ["project:a", "project:b"],
  });
  const second = createBusinessDesktopReadResultV1({
    request: request(first.page.nextAfterKey), projection, cursor: cursor(), continuity: "unchanged", runtimeProjectId: "native-project",
  });
  assert.equal(second.page.items.length, 1);
  assert.equal(second.page.nextAfterKey, null);
});

test("fails closed on source divergence and inherited query names", () => {
  const projection = initialBusinessProjectionV1();
  assert.throws(
    () => createBusinessDesktopReadResultV1({
      request: request(), projection, cursor: cursor(0), continuity: "rewound", runtimeProjectId: "native-project",
    }),
    (error) => error?.code === "BUSINESS_DESKTOP_SOURCE_RECOVERY_REQUIRED",
  );
  assert.throws(
    () => createBusinessDesktopReadResultV1({
      request: { ...request(), query: { kind: "toString" } },
      projection,
      cursor: cursor(0),
      continuity: "initial",
      runtimeProjectId: "native-project",
    }),
    (error) => error?.code === "BUSINESS_DESKTOP_READ_QUERY_UNSUPPORTED",
  );
});
