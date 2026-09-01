"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { canonicalHash } = require("@orquesta/contracts");

const { createOrganizationV3Store } = require("../src/organization-store-v3");
const { createFoundationOrganizationV3Bundle, createOrganizationV3Bundle } = require("../src/organization-v3");
const { loadDesktopOperation } = require("../src/desktop-operation-catalog");
const { compilePersistentAgentPlacement, runPersistentAgentPlacement } = require("../src/placement-intent-v3");
const { projectRootBindingSha256 } = require("../src/project-execution-context");

const PRODUCT_ROOT = path.resolve(__dirname, "..", "..", "..");
const NOW = "2026-08-24T09:00:00.000Z";
const PROJECT_ID = "project-test";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-placement-intent-"));
  return { root, dispose: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function clock() {
  let value = Date.parse(NOW);
  return () => new Date(value++).toISOString();
}

function organization(root, now) {
  const base = createFoundationOrganizationV3Bundle({ createdAt: NOW, bootstrapId: "bootstrap-placement" });
  const bundle = createOrganizationV3Bundle({
    ...base,
    agentRegistry: {
      ...base.agentRegistry,
      agents: base.agentRegistry.agents.map((agent) => ({ ...agent, lifecycle_state: "active" })),
    },
    organization: {
      ...base.organization,
      policy: { ...base.organization.policy, max_concurrent_provisioning: 8 },
    },
  });
  const store = createOrganizationV3Store({ rootPath: root, clock: now });
  store.initialize({ bundle, commandId: "bootstrap-placement" });
  return store;
}

function template(overrides = {}) {
  return {
    purpose: "Implement the bounded project feature.",
    capability_needs: ["code"],
    role_ref: { id: "implementation", version: 1 },
    scope_ref: { kind: "project", id: PROJECT_ID },
    requested_count: 1,
    coordination_hint: null,
    ...overrides,
  };
}

function roles() {
  return [
    { id: "implementation", version: 1, capabilities: ["code", "test"] },
    { id: "testing", version: 1, capabilities: ["test"] },
  ];
}

function taskPort(rootPath, { events = [] } = {}) {
  const records = new Map();
  let revision = 0;
  return {
    project_root_binding_sha256: projectRootBindingSha256(rootPath),
    calls: 0,
    inspectCalls: 0,
    transitions: [],
    records,
    async inspectPlacementTasks({ taskIds }) {
      this.inspectCalls += 1;
      const tasks = taskIds.map((taskId) => records.get(taskId)).filter(Boolean).map((task) => structuredClone(task));
      return {
        status: "ready",
        state_revision: revision,
        state_hash: canonicalHash([...records.values()].sort((a, b) => a.task_id.localeCompare(b.task_id, "en"))),
        tasks,
      };
    },
    async reconcilePlacementTasks({ tasks }) {
      this.calls += 1;
      let changed = false;
      for (const task of tasks) {
        const existing = records.get(task.task_id);
        if (existing && existing.placement_fingerprint !== task.placement_fingerprint) {
          const error = new Error(`Task identity conflict: ${task.task_id}`);
          error.code = "TASK_IDENTITY_CONFLICT";
          throw error;
        }
        if (!existing) {
          records.set(task.task_id, structuredClone(task));
          changed = true;
        }
      }
      if (changed) revision += 1;
      return {
        status: "ready",
        state_revision: revision,
        state_hash: canonicalHash([...records.values()].sort((a, b) => a.task_id.localeCompare(b.task_id, "en"))),
        tasks: tasks.map((task) => structuredClone(records.get(task.task_id))),
      };
    },
    async transitionPlacementTask({ expectedRevision, taskId, expectedState, next }) {
      const current = records.get(taskId);
      if (!current) {
        const error = new Error(`Task not found: ${taskId}`);
        error.code = "PLACEMENT_TASK_NOT_FOUND";
        throw error;
      }
      const updated = {
        ...current,
        state: next.state,
        blocked_by: [...next.blockedBy].sort(),
        result_summary: next.resultSummary,
        accepted_at: next.acceptedAt,
        updated_at: next.changedAt,
      };
      if (current.state === next.state) {
        if (canonicalHash(current) !== canonicalHash(updated)) {
          const error = new Error(`Task replay conflict: ${taskId}`);
          error.code = "PLACEMENT_TASK_TRANSITION_REPLAY_CONFLICT";
          throw error;
        }
      } else {
        if (revision !== expectedRevision) {
          const error = new Error(`Task revision conflict: ${taskId}`);
          error.code = "PLACEMENT_TASK_REVISION_CONFLICT";
          throw error;
        }
        if (current.state !== expectedState) {
          const error = new Error(`Task state conflict: ${taskId}`);
          error.code = "PLACEMENT_TASK_STATE_CONFLICT";
          throw error;
        }
        records.set(taskId, updated);
        this.transitions.push(next.state);
        events.push(`task:${next.state}`);
        revision += 1;
      }
      return {
        status: "ready",
        state_revision: revision,
        state_hash: canonicalHash([...records.values()].sort((a, b) => a.task_id.localeCompare(b.task_id, "en"))),
        tasks: [structuredClone(records.get(taskId))],
      };
    },
  };
}

function sessionAdapter(rootPath, { loseFirstAck = false, events = [] } = {}) {
  const accepted = new Map();
  return {
    project_id: PROJECT_ID,
    project_root_binding_sha256: projectRootBindingSha256(rootPath),
    provisionCalls: 0,
    async findAcceptedBinding({ requestId }) {
      return accepted.has(requestId) ? structuredClone(accepted.get(requestId)) : null;
    },
    async provisionPersistentAgent({ requestId, agent }) {
      this.provisionCalls += 1;
      events.push("provider:provision");
      const binding = {
        status: "accepted",
        agent_id: agent.agent_id,
        thread_id: `thread-${agent.agent_id}`,
        session_id: `session-${agent.agent_id}`,
        accepted_at: NOW,
      };
      accepted.set(requestId, binding);
      events.push("session:accepted");
      if (loseFirstAck && this.provisionCalls === 1) {
        const error = new Error("simulated lost provisioning acknowledgment");
        error.code = "SIMULATED_LOST_ACK";
        throw error;
      }
      return structuredClone(binding);
    },
  };
}

function argumentsFor({ project, organizationStore, tasks, sessions, now, operationTemplate = template() }) {
  return {
    productRoot: PRODUCT_ROOT,
    projectRoot: project.root,
    projectId: PROJECT_ID,
    sourceRef: { kind: "user", id: "user-request" },
    roleCatalog: roles(),
    template: operationTemplate,
    organizationStore,
    taskPort: tasks,
    sessionAdapter: sessions,
    clock: now,
  };
}

test("incomplete operator input returns an exact no-write repair result", async () => {
  const project = fixture();
  try {
    const now = clock();
    const organizationStore = organization(project.root, now);
    const tasks = taskPort(project.root);
    const sessions = sessionAdapter(project.root);
    const result = await runPersistentAgentPlacement(argumentsFor({
      project,
      organizationStore,
      tasks,
      sessions,
      now,
      operationTemplate: template({ purpose: "   " }),
    }));
    assert.equal(result.status, "incomplete");
    assert.equal(result.no_write, true);
    assert.equal(result.issues.some((entry) => entry.field === "purpose"), true);
    assert.equal(tasks.calls, 0);
    assert.equal(sessions.provisionCalls, 0);
    assert.equal(fs.existsSync(path.join(project.root, ".orquesta", "state", "placement-sagas")), false);
    assert.equal(fs.existsSync(path.join(project.root, ".orquesta", "runtime", "placement-saga-v1")), false);
  } finally {
    project.dispose();
  }
});

test("unknown role returns trusted candidates without persistence", async () => {
  const project = fixture();
  try {
    const now = clock();
    const organizationStore = organization(project.root, now);
    const tasks = taskPort(project.root);
    const sessions = sessionAdapter(project.root);
    const result = await runPersistentAgentPlacement(argumentsFor({
      project,
      organizationStore,
      tasks,
      sessions,
      now,
      operationTemplate: template({ role_ref: { id: "research", version: 1 } }),
    }));
    assert.equal(result.status, "incomplete");
    assert.deepEqual(
      result.issues.find((entry) => entry.code === "role_not_found").candidates,
      ["implementation@1", "testing@1"]
    );
    assert.equal(tasks.calls, 0);
    assert.equal(fs.existsSync(path.join(project.root, ".orquesta", "state", "placement-sagas")), false);
  } finally {
    project.dispose();
  }
});

test("oversized operator input is rejected before saga or adapter work", async () => {
  const project = fixture();
  try {
    const now = clock();
    const organizationStore = organization(project.root, now);
    const tasks = taskPort(project.root);
    const sessions = sessionAdapter(project.root);
    const result = await runPersistentAgentPlacement(argumentsFor({
      project,
      organizationStore,
      tasks,
      sessions,
      now,
      operationTemplate: template({ requested_count: 1_000_000_000 }),
    }));
    assert.equal(result.status, "incomplete");
    assert.equal(result.no_write, true);
    assert.equal(result.issues.some((entry) => entry.field === "requested_count" && entry.code === "template_maximum"), true);
    assert.equal(tasks.calls, 0);
    assert.equal(tasks.inspectCalls, 0);
    assert.equal(sessions.provisionCalls, 0);
    assert.equal(fs.existsSync(path.join(project.root, ".orquesta", "runtime", "placement-saga-v1")), false);
  } finally {
    project.dispose();
  }
});

test("provisioning capacity is checked before any saga or adapter write", async () => {
  const project = fixture();
  try {
    const now = clock();
    const organizationStore = organization(project.root, now);
    const tasks = taskPort(project.root);
    const sessions = sessionAdapter(project.root);
    const result = await runPersistentAgentPlacement(argumentsFor({
      project,
      organizationStore,
      tasks,
      sessions,
      now,
      operationTemplate: template({ requested_count: 9 }),
    }));
    assert.equal(result.status, "blocked");
    assert.equal(result.no_write, true);
    assert.equal(result.issues.some((entry) => entry.code === "provisioning_capacity_exceeded"), true);
    assert.equal(tasks.calls, 0);
    assert.equal(tasks.inspectCalls, 0);
    assert.equal(sessions.provisionCalls, 0);
    assert.equal(fs.existsSync(path.join(project.root, ".orquesta", "runtime", "placement-saga-v1")), false);
  } finally {
    project.dispose();
  }
});

test("agent identity uses the full intent-strength suffix instead of a colliding 24-bit prefix", () => {
  const project = fixture();
  try {
    const now = clock();
    const organizationStore = organization(project.root, now);
    const loadedOperation = loadDesktopOperation({ productRoot: PRODUCT_ROOT, operationId: "organization.agent-placement.persistent.v1" });
    const compile = (purpose) => compilePersistentAgentPlacement({
      loadedOperation,
      template: template({ purpose }),
      projectId: PROJECT_ID,
      sourceRef: { kind: "user", id: "user-request" },
      roleCatalog: roles(),
      organizationSnapshot: organizationStore.inspect(),
      observedAt: NOW,
    });
    const left = compile("collision probe 3152");
    const right = compile("collision probe 4500");
    assert.equal(left.status, "ready");
    assert.equal(right.status, "ready");
    assert.notEqual(left.intent.placement_intent_id, right.intent.placement_intent_id);
    assert.notEqual(left.agents[0].agent_id, right.agents[0].agent_id);
    assert.equal(compile("collision probe 3152").agents[0].agent_id, left.agents[0].agent_id);
  } finally {
    project.dispose();
  }
});

test("persistent placement completes and repeats without duplicate task or session identity", async () => {
  const project = fixture();
  try {
    const now = clock();
    const organizationStore = organization(project.root, now);
    const events = [];
    const tasks = taskPort(project.root, { events });
    const sessions = sessionAdapter(project.root, { events });
    const args = argumentsFor({ project, organizationStore, tasks, sessions, now });
    const first = await runPersistentAgentPlacement(args);
    assert.equal(first.status, "complete");
    assert.equal(first.agent_ids.length, 1);
    assert.equal(tasks.records.size, 1);
    assert.equal(tasks.records.get(first.task_ids[0]).state, "dispatch_accepted");
    assert.deepEqual(tasks.transitions, ["assigned", "dispatch_accepted"]);
    assert.deepEqual(events, [
      "task:assigned",
      "provider:provision",
      "session:accepted",
      "task:dispatch_accepted",
    ]);
    assert.equal(sessions.provisionCalls, 1);
    assert.equal(
      organizationStore.inspect().bundle.agentRegistry.agents.find((agent) => agent.agent_id === first.agent_ids[0]).lifecycle_state,
      "active"
    );
    const second = await runPersistentAgentPlacement(args);
    assert.equal(second.status, "complete");
    assert.equal(second.no_write, true);
    assert.deepEqual(second.agent_ids, first.agent_ids);
    assert.deepEqual(second.task_ids, first.task_ids);
    assert.equal(tasks.records.size, 1);
    assert.equal(tasks.calls, 1);
    assert.equal(tasks.inspectCalls, 4);
    assert.equal(sessions.provisionCalls, 1);
  } finally {
    project.dispose();
  }
});

test("persistent placement resumes a lost session acknowledgment without provisioning a second thread", async () => {
  const project = fixture();
  try {
    const now = clock();
    const organizationStore = organization(project.root, now);
    const tasks = taskPort(project.root);
    const sessions = sessionAdapter(project.root, { loseFirstAck: true });
    const args = argumentsFor({ project, organizationStore, tasks, sessions, now });
    await assert.rejects(runPersistentAgentPlacement(args), { code: "SIMULATED_LOST_ACK" });
    assert.equal(tasks.records.values().next().value.state, "assigned");
    const sagaDir = path.join(project.root, ".orquesta", "state", "placement-sagas");
    const interrupted = JSON.parse(fs.readFileSync(path.join(sagaDir, fs.readdirSync(sagaDir)[0]), "utf8"));
    assert.equal(interrupted.phase, "sessions_requested");
    assert.equal(Object.values(interrupted.session_bindings)[0].status, "requested");
    const resumed = await runPersistentAgentPlacement(args);
    assert.equal(resumed.status, "complete");
    assert.equal(tasks.records.values().next().value.state, "dispatch_accepted");
    assert.deepEqual(tasks.transitions, ["assigned", "dispatch_accepted"]);
    assert.equal(sessions.provisionCalls, 1);
  } finally {
    project.dispose();
  }
});

test("repair after accepted session reports the durable partial effects instead of claiming no write", async () => {
  const project = fixture();
  try {
    const now = clock();
    const organizationStore = organization(project.root, now);
    const tasks = taskPort(project.root);
    const sessions = sessionAdapter(project.root);
    const transition = tasks.transitionPlacementTask.bind(tasks);
    let injected = false;
    tasks.transitionPlacementTask = async (input) => {
      if (!injected && input.next.state === "dispatch_accepted") {
        const current = tasks.records.get(input.taskId);
        tasks.records.set(input.taskId, {
          ...current,
          state: "blocked",
          blocked_by: ["simulated-concurrent-owner"],
          updated_at: input.next.changedAt,
        });
        injected = true;
      }
      return transition(input);
    };

    const result = await runPersistentAgentPlacement(argumentsFor({
      project, organizationStore, tasks, sessions, now,
    }));
    assert.equal(result.status, "repair_required");
    assert.equal(result.no_write, false);
    assert.equal(result.observed_task_state, "blocked");
    assert.equal(result.automatic_retry, false);
    assert.deepEqual(result.durable_effects, [
      "placement_saga",
      "placement_tasks",
      "organization",
      "session_binding",
    ]);
    assert.equal(sessions.provisionCalls, 1);
    assert.equal(tasks.records.values().next().value.state, "blocked");
  } finally {
    project.dispose();
  }
});

test("a valid-looking Task write receipt cannot advance without canonical readback", async () => {
  const project = fixture();
  try {
    const now = clock();
    const organizationStore = organization(project.root, now);
    const sessions = sessionAdapter(project.root);
    const lyingTasks = {
      project_root_binding_sha256: projectRootBindingSha256(project.root),
      async reconcilePlacementTasks({ tasks }) {
        return { status: "ready", state_revision: 1, state_hash: "a".repeat(64), tasks: structuredClone(tasks) };
      },
      async inspectPlacementTasks() {
        return { status: "ready", state_revision: 1, state_hash: "a".repeat(64), tasks: [] };
      },
      async transitionPlacementTask() {
        throw new Error("transition must not run after failed canonical Task readback");
      },
    };
    await assert.rejects(
      runPersistentAgentPlacement(argumentsFor({
        project, organizationStore, tasks: lyingTasks, sessions, now,
      })),
      { code: "PLACEMENT_TASK_PORT_INVALID" }
    );
    const sagaDir = path.join(project.root, ".orquesta", "state", "placement-sagas");
    const interrupted = JSON.parse(fs.readFileSync(path.join(sagaDir, fs.readdirSync(sagaDir)[0]), "utf8"));
    assert.equal(interrupted.phase, "intent_recorded");
    assert.equal(organizationStore.inspect().bundle.agentRegistry.agents.length, 3);
  } finally {
    project.dispose();
  }
});

test("a valid-looking Session acknowledgment cannot activate without canonical readback", async () => {
  const project = fixture();
  try {
    const now = clock();
    const organizationStore = organization(project.root, now);
    const tasks = taskPort(project.root);
    const lyingSessions = {
      project_id: PROJECT_ID,
      project_root_binding_sha256: projectRootBindingSha256(project.root),
      async findAcceptedBinding() { return null; },
      async provisionPersistentAgent({ agent }) {
        return {
          status: "accepted",
          agent_id: agent.agent_id,
          thread_id: `thread-${agent.agent_id}`,
          session_id: `session-${agent.agent_id}`,
          accepted_at: NOW,
        };
      },
    };
    await assert.rejects(
      runPersistentAgentPlacement(argumentsFor({
        project, organizationStore, tasks, sessions: lyingSessions, now,
      })),
      { code: "PLACEMENT_SESSION_PERSISTENCE_MISMATCH" }
    );
    const sagaDir = path.join(project.root, ".orquesta", "state", "placement-sagas");
    const interrupted = JSON.parse(fs.readFileSync(path.join(sagaDir, fs.readdirSync(sagaDir)[0]), "utf8"));
    assert.equal(interrupted.phase, "sessions_requested");
    const agent = organizationStore.inspect().bundle.agentRegistry.agents.find((item) => item.agent_id.startsWith("implementation-"));
    assert.equal(agent.lifecycle_state, "provisioning");
  } finally {
    project.dispose();
  }
});

test("controller rejects Organization, Task, and Session ports composed from different project roots", async () => {
  const first = fixture();
  const second = fixture();
  try {
    const now = clock();
    const organizationStore = organization(first.root, now);
    await assert.rejects(
      runPersistentAgentPlacement({
        productRoot: PRODUCT_ROOT,
        projectRoot: first.root,
        projectId: PROJECT_ID,
        sourceRef: { kind: "user", id: "user-request" },
        roleCatalog: roles(),
        template: template(),
        organizationStore,
        taskPort: taskPort(second.root),
        sessionAdapter: sessionAdapter(first.root),
        clock: now,
      }),
      { code: "PLACEMENT_CONTROLLER_AUTHORITY_MISMATCH" }
    );
    await assert.rejects(
      runPersistentAgentPlacement({
        productRoot: PRODUCT_ROOT,
        projectRoot: first.root,
        projectId: PROJECT_ID,
        sourceRef: { kind: "user", id: "user-request" },
        roleCatalog: roles(),
        template: template(),
        organizationStore,
        taskPort: taskPort(first.root),
        sessionAdapter: sessionAdapter(second.root),
        clock: now,
      }),
      { code: "PLACEMENT_CONTROLLER_AUTHORITY_MISMATCH" }
    );
  } finally {
    first.dispose();
    second.dispose();
  }
});
