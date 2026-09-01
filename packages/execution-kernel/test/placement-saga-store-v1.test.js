"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { canonicalHash } = require("@orquesta/contracts");

const { createPlacementSagaStore, taskFingerprint } = require("../src/placement-saga-store-v1");

const NOW = "2026-08-24T08:00:00.000Z";
const INTENT_ID = "PI-aaaaaaaaaaaa";
const AGENT_ID = "implementation-a1b2c3-1";
const TASK_ID = "placement:aaaaaaaaaaaa:1";

function fixture(prefix = "orquesta-placement-saga-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { root, dispose: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function saga() {
  const baseTask = {
    task_id: TASK_ID,
    task_kind: "specialist_work",
    placement_intent_id: INTENT_ID,
    assigned_agent_id: AGENT_ID,
    owner_agent_id: AGENT_ID,
    role_id: "implementation",
    role_version: 1,
    purpose: "Implement the selected project work.",
    acceptance_criteria: ["Complete the bounded implementation."],
    state: "queued",
    dependencies: [],
    blocked_by: [],
    result_summary: null,
    accepted_at: null,
    specialist_report_required: true,
    created_at: NOW,
    updated_at: NOW,
  };
  const task = { ...baseTask, placement_fingerprint: taskFingerprint(baseTask) };
  const intent = {
    placement_intent_id: INTENT_ID,
    purpose: "Implement the selected project work.",
    capability_needs: ["code"],
    scope_ref: { kind: "project", id: "project-test" },
    lifetime: "persistent",
    requested_count: 1,
    coordination_hint: null,
    source_ref: { kind: "user", id: "user-request" },
  };
  return {
    schema_version: 1,
    revision: 0,
    placement_intent_id: INTENT_ID,
    operation_id: "organization.agent-placement.persistent.v1",
    operation_version: 1,
    template_sha256: "a".repeat(64),
    intent,
    intent_hash: canonicalHash(intent),
    phase: "intent_recorded",
    task_records: [task],
    agents: [{
      agent_id: AGENT_ID,
      role_id: "implementation",
      role_version: 1,
      mission: intent.purpose,
      context_scope: ["project"],
      lifecycle_state: "provisioning",
      origin: "controller",
      created_from_ref: { kind: "task", id: TASK_ID },
      retired_at: null,
    }],
    organization_plan: {
      memberships: [],
      relationships: [{
        relationship_id: `relationship-${AGENT_ID}-reports-to-orchestrator`,
        type: "reports_to",
        subject_ref: { kind: "agent", id: AGENT_ID },
        object_ref: { kind: "agent", id: "orchestrator" },
      }],
      placement_evidence: [{
        agent_id: AGENT_ID,
        placement_intent_id: INTENT_ID,
        executable_task_id: TASK_ID,
      }],
    },
    task_evidence: null,
    organization_registration: null,
    session_bindings: {
      [AGENT_ID]: {
        agent_id: AGENT_ID,
        task_id: TASK_ID,
        request_id: `placement:${INTENT_ID}:${AGENT_ID}`,
        status: "not_requested",
        binding: null,
      },
    },
    activations: {
      [AGENT_ID]: { agent_id: AGENT_ID, status: "pending", evidence: null },
    },
    created_at: NOW,
    updated_at: NOW,
  };
}

test("PlacementSagaStore constructor and read are side-effect free", () => {
  const project = fixture();
  try {
    const store = createPlacementSagaStore({ rootPath: project.root, clock: () => NOW });
    assert.equal(store.read(INTENT_ID).status, "missing");
    assert.equal(fs.existsSync(path.join(project.root, ".orquesta")), false);
  } finally {
    project.dispose();
  }
});

test("PlacementSagaStore advances only through evidence-backed domain transitions", async () => {
  const project = fixture();
  try {
    const store = createPlacementSagaStore({ rootPath: project.root, clock: () => NOW });
    await store.withIntentLock(INTENT_ID, async (locked) => {
      locked.create(saga());
      locked.recordTasks({ state_revision: 2, state_hash: "b".repeat(64) });
      locked.recordOrganization({ organization_revision: 4, head_hash: "c".repeat(64), command_id: "OC-register" });
      locked.markSessionRequested(AGENT_ID);
      locked.recordSessionAccepted(AGENT_ID, {
        status: "accepted",
        agent_id: AGENT_ID,
        thread_id: "thread-1",
        session_id: "session-1",
        accepted_at: NOW,
      });
      locked.markSessionsAccepted();
      locked.recordActivation(AGENT_ID, {
        organization_revision: 5,
        head_hash: "d".repeat(64),
        command_id: "OC-activate",
      });
      locked.markOrganizationActivated();
      locked.markComplete();
    });
    const stored = store.read(INTENT_ID);
    assert.equal(stored.saga.phase, "complete");
    assert.equal(stored.saga.revision, 8);
    assert.equal(stored.saga.session_bindings[AGENT_ID].status, "accepted");
    assert.equal(stored.saga.activations[AGENT_ID].status, "active");
  } finally {
    project.dispose();
  }
});

test("PlacementSagaStore rejects an evidence-free jump to complete and releases its lock", async () => {
  const project = fixture();
  try {
    const store = createPlacementSagaStore({ rootPath: project.root, clock: () => NOW });
    await assert.rejects(
      store.withIntentLock(INTENT_ID, async (locked) => {
        locked.create(saga());
        locked.markComplete();
      }),
      { code: "PLACEMENT_SAGA_INVALID" }
    );
    await store.withIntentLock(INTENT_ID, async (locked) => {
      assert.equal(locked.read().saga.phase, "intent_recorded");
      locked.recordTasks({ state_revision: 1, state_hash: "e".repeat(64) });
    });
    assert.equal(store.read(INTENT_ID).saga.phase, "tasks_appended");
  } finally {
    project.dispose();
  }
});

test("PlacementSagaStore serializes the same intent", async () => {
  const project = fixture();
  try {
    const store = createPlacementSagaStore({ rootPath: project.root, clock: () => NOW });
    let release;
    const held = store.withIntentLock(INTENT_ID, async (locked) => {
      locked.create(saga());
      await new Promise((resolve) => { release = resolve; });
    });
    while (!release) await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(store.withIntentLock(INTENT_ID, async () => {}), { code: "PLACEMENT_SAGA_LOCKED" });
    release();
    await held;
  } finally {
    project.dispose();
  }
});

  test("PlacementSagaStore releases its hard-link process lock without metadata debris", async () => {
  const project = fixture();
  try {
    const store = createPlacementSagaStore({ rootPath: project.root, clock: () => NOW });
    await store.withIntentLock(INTENT_ID, async () => {
      const staging = path.join(project.root, ".orquesta", "runtime", "placement-saga-v1");
      const names = fs.readdirSync(staging);
      assert.equal(names.includes(`saga-${INTENT_ID}-lock-v1.lock`), true);
      assert.equal(names.filter((name) => name.includes("candidate-")).length, 1);
    });
    assert.deepEqual(fs.readdirSync(path.join(project.root, ".orquesta", "runtime", "placement-saga-v1")), []);
  } finally {
    project.dispose();
  }
});

test("PlacementSagaStore rejects a symlinked process lock", async (t) => {
  const project = fixture();
  const external = fixture("orquesta-placement-lock-external-");
  try {
    const staging = path.join(project.root, ".orquesta", "runtime", "placement-saga-v1");
    fs.mkdirSync(staging, { recursive: true });
    const externalFile = path.join(external.root, "lock.txt");
    fs.writeFileSync(externalFile, "", "utf8");
    try {
      fs.symlinkSync(externalFile, path.join(staging, `saga-${INTENT_ID}-lock-v1.lock`), "file");
    } catch (error) {
      t.skip(`file symlink creation unavailable: ${error.code || error.message}`);
      return;
    }
    const store = createPlacementSagaStore({ rootPath: project.root, clock: () => NOW });
    await assert.rejects(store.withIntentLock(INTENT_ID, async () => {}), { code: "PLACEMENT_SAGA_LOCK_PATH_UNSAFE" });
  } finally {
    project.dispose();
    external.dispose();
  }
});

test("PlacementSagaStore rejects a junction boundary before creating children outside the project", async (t) => {
  const project = fixture();
  const external = fixture("orquesta-placement-external-");
  try {
    try {
      fs.symlinkSync(external.root, path.join(project.root, ".orquesta"), "junction");
    } catch (error) {
      t.skip(`junction creation unavailable: ${error.code || error.message}`);
      return;
    }
    const store = createPlacementSagaStore({ rootPath: project.root, clock: () => NOW });
    await assert.rejects(store.withIntentLock(INTENT_ID, async () => {}), { code: "PLACEMENT_SAGA_PATH_UNSAFE" });
    assert.deepEqual(fs.readdirSync(external.root), []);
  } finally {
    project.dispose();
    external.dispose();
  }
});
