"use strict";

const assert = require("node:assert/strict");
const { mkdir, mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createSetupEngine } = require("./setup-engine");
const { createDefaultPhaseHandlers } = require("./setup-phase-handlers");
const { checkDelegationGate } = require("./delegation-gate-check");

const roots = [];
const NOW = "2026-07-22T05:00:00.000Z";
const LATER = "2026-07-22T05:01:00.000Z";

test.afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function json(root, relativePath) {
  return JSON.parse(await readFile(path.join(root, ".orquesta", ...relativePath.split("/")), "utf8"));
}

async function repository({
  projectName = "Demo Desktop",
  description = "Build a polished desktop UI with React and Electron.",
} = {}) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "orquesta-setup-phases-"));
  roots.push(parent);
  const root = path.join(parent, "project");
  await Promise.all([
    mkdir(path.join(root, "src"), { recursive: true }),
    mkdir(path.join(root, "docs", "research"), { recursive: true }),
    mkdir(path.join(root, "docs", "articles"), { recursive: true }),
    mkdir(path.join(root, "docs", "testing"), { recursive: true }),
  ]);
  await writeFile(path.join(root, "README.md"), "# Demo Desktop\nA React and Electron desktop interface.\n", "utf8");
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "demo-desktop", dependencies: { react: "19.0.0", electron: "43.0.0" } }), "utf8");
  await writeFile(path.join(root, "src", "App.tsx"), "export function App() { return null; }\n", "utf8");
  const engine = createSetupEngine({ now: () => NOW, randomUUID: () => "11111111-2222-4333-8444-555555555555" });
  const started = await engine.start({
    rootPath: root,
    draft: {
      revision: 1,
      status: "draft",
      source: { kind: "detected_root", rootPath: root },
      projectName,
      description,
      questions: [],
      answers: [],
    },
  });
  return { root, setupState: started.setup_state };
}

async function provisionFoundation({ agentIds }) {
  return agentIds.map((agentId) => ({
    agent_id: agentId,
    status: "accepted",
    thread_id: `thread-${agentId}`,
    turn_id: `turn-${agentId}`,
  }));
}

test("environment writes a durable complete checkpoint", async () => {
  const { root, setupState } = await repository();
  const handlers = createDefaultPhaseHandlers({ now: () => NOW });

  const result = await handlers.environment({ rootPath: root, setupState });
  const checkpoint = await json(root, "setup/checkpoints/environment.json");

  assert.equal(result.checkpointRef, "setup/checkpoints/environment.json");
  assert.equal(checkpoint.status, "complete");
  assert.equal(checkpoint.setup_id, setupState.setup_id);
  assert.equal(checkpoint.root_path, root);
});

test("understanding inspects bounded project evidence and stack", async () => {
  const { root, setupState } = await repository();
  const handlers = createDefaultPhaseHandlers({ now: () => NOW });

  const result = await handlers.understanding({ rootPath: root, setupState });
  const understanding = await json(root, "project/project_understanding.json");

  assert.equal(result.output.goal, "Build a polished desktop UI with React and Electron.");
  assert.deepEqual(understanding.stack, ["electron", "node", "react", "typescript"]);
  assert.ok(understanding.evidence.some(({ path: evidencePath }) => evidencePath === "README.md"));
  assert.ok(understanding.existing_assets.includes("src/App.tsx"));
  assert.equal(understanding.project_structure.archetype, "software");
  assert.equal(understanding.project_structure.setup_mode, "existing_shadow");
  const structureSetup = await json(root, "project/structure-setup.json");
  assert.equal(structureSetup.template_version, "project-structure-v1");
  assert.deepEqual(structureSetup.physical_changes.moved_paths, []);
  assert.equal((await json(root, "project/layout.json")).project_kind, "software");
  assert.match((await json(root, "context/initial-context-view.json")).view_id, /^PSCV-/u);
  const understandingCheckpoint = await json(root, "setup/checkpoints/understanding.json");
  assert.equal(understandingCheckpoint.project_structure.context_view_id, understanding.project_structure.context_view_id);
});

test("foundation creates exactly the three base agents and refreshes canonical session metadata idempotently", async () => {
  const { root, setupState } = await repository();
  const calls = [];
  const timestamps = [NOW, LATER];
  const handlers = createDefaultPhaseHandlers({
    now: () => timestamps.shift() || LATER,
    provisionFoundation: async ({ agentIds }) => {
      calls.push([...agentIds]);
      return agentIds.map((agentId) => ({
        agent_id: agentId,
        status: "accepted",
        thread_id: `thread-${agentId}`,
        turn_id: `turn-${agentId}`,
      }));
    },
  });

  await handlers.foundation({ rootPath: root, setupState });
  const firstOrganization = await json(root, "state/organization.json");
  const firstSessions = await json(root, "state/sessions.json");
  await handlers.foundation({ rootPath: root, setupState });
  const secondOrganization = await json(root, "state/organization.json");
  const agents = await json(root, "state/agents.json");
  const sessions = await json(root, "state/sessions.json");

  assert.deepEqual(agents.agents.map(({ agent_id }) => agent_id).sort(), ["orchestrator", "orquesta-admin", "user-support"]);
  assert.equal(firstOrganization.revision, 1);
  assert.equal(secondOrganization.revision, 1);
  assert.deepEqual(calls, [["orchestrator", "orquesta-admin", "user-support"]]);
  assert.equal(firstSessions.source, "codex_app.list_threads");
  assert.equal(firstSessions.project_cwd, root);
  assert.equal(firstSessions.synced_at, NOW);
  assert.equal(sessions.source, "codex_app.list_threads");
  assert.equal(sessions.project_cwd, root);
  assert.equal(sessions.synced_at, LATER);
  assert.deepEqual(sessions.sessions.map(({ agent_id }) => agent_id).sort(), ["orchestrator", "orquesta-admin", "user-support"]);
  assert.ok(sessions.sessions.every(({ thread_id, handoff_turn_id }) => thread_id && handoff_turn_id));
});

test("planning creates executable work and an adaptive specialist plan once", async () => {
  const { root, setupState } = await repository();
  const handlers = createDefaultPhaseHandlers({ now: () => NOW, provisionFoundation });
  await handlers.understanding({ rootPath: root, setupState });
  await handlers.foundation({ rootPath: root, setupState });

  await handlers.planning({ rootPath: root, setupState });
  const firstMap = await json(root, "project/completion_map.json");
  const firstPlan = await json(root, "setup/specialist_plan.json");
  await handlers.planning({ rootPath: root, setupState });
  const secondMap = await json(root, "project/completion_map.json");
  const secondPlan = await json(root, "setup/specialist_plan.json");

  assert.ok(firstMap.tasks.length >= 1);
  assert.ok(firstMap.tasks.every(({ status }) => status === "ready"));
  assert.ok(firstMap.tasks.every(({ title }) => !title.includes("first executable work")));
  assert.ok(firstMap.tasks.every(({ acceptance_criteria }) => Array.isArray(acceptance_criteria) && acceptance_criteria.length > 0));
  const implementationTask = firstMap.tasks.find(({ role_id }) => role_id === "implementation");
  const designTask = firstMap.tasks.find(({ role_id }) => role_id === "design");
  assert.deepEqual(implementationTask.scope_boundaries, ["."]);
  assert.equal(implementationTask.work_mode, "implementation");
  assert.equal(implementationTask.independent_deliverable, true);
  assert.deepEqual(designTask.scope_boundaries, [".orquesta/reports"]);
  assert.equal(designTask.work_mode, "report_only");
  assert.equal(designTask.independent_deliverable, false);
  assert.deepEqual(
    firstPlan.selected_specialists.map(({ role_id }) => role_id).sort(),
    ["design", "implementation"],
  );
  assert.equal(firstPlan.schema_version, 2);
  assert.ok(firstPlan.selected_specialists.some(({ role_id }) => role_id === "implementation"));
  assert.deepEqual(secondMap, firstMap);
  assert.deepEqual(secondPlan, firstPlan);
});

test("planning gives generalist work an implementation boundary instead of a report-only boundary", async () => {
  const { root, setupState } = await repository({
    projectName: "Organization JSON benchmark",
    description: "Produce an organization JSON artifact that satisfies the supplied constraints.",
  });
  const handlers = createDefaultPhaseHandlers({ now: () => NOW, provisionFoundation });
  await handlers.understanding({ rootPath: root, setupState });
  await handlers.foundation({ rootPath: root, setupState });

  await handlers.planning({ rootPath: root, setupState });
  const map = await json(root, "project/completion_map.json");
  const plan = await json(root, "setup/specialist_plan.json");

  assert.equal(map.tasks.length, 1);
  assert.equal(map.tasks[0].role_id, "generalist");
  assert.match(map.tasks[0].title, /成果物を作る/u);
  assert.deepEqual(map.tasks[0].scope_boundaries, ["."]);
  assert.equal(map.tasks[0].work_mode, "implementation");
  assert.equal(map.tasks[0].independent_deliverable, true);
  assert.deepEqual(plan.selected_specialists.map(({ role_id }) => role_id), ["generalist"]);
});

test("solo direct work skips specialist provisioning while retaining a profiled execution plan", async () => {
  const { root, setupState } = await repository();
  const provisioningCalls = [];
  const handlers = createDefaultPhaseHandlers({
    now: () => NOW,
    provisionFoundation,
    provisionSpecialists: async ({ batch }) => {
      provisioningCalls.push(batch.provisioning_batch_id);
      return {
        ...batch,
        requests: batch.requests.map((request, index) => ({
          ...request,
          status: "standby",
          handoff_status: "accepted",
          thread_id: `thread-${index + 1}`,
          turn_id: `turn-${index + 1}`,
          completed_at: NOW,
        })),
      };
    },
  });
  await handlers.understanding({ rootPath: root, setupState });
  await handlers.foundation({ rootPath: root, setupState });
  await handlers.planning({ rootPath: root, setupState });

  const result = await handlers.specialists({ rootPath: root, setupState });
  const batch = await json(root, "setup/provisioning_batch.json");
  const organization = await json(root, "state/organization.json");
  const tasks = await json(root, "state/tasks.json");
  const shadowIndex = await json(root, "context/shadow_index.json");
  const sourceCatalog = await json(root, "context/source_catalog.json");
  const controlPlane = await json(root, "context/project_control_plane.json");

  assert.equal(provisioningCalls.length, 0);
  assert.ok(batch.requests.length >= 1);
  assert.ok(batch.requests.every(({ handoff_status, status }) => handoff_status === "not_required" && status === "inline_verified"));
  assert.ok(batch.requests.every(({ recommended_model }) => typeof recommended_model === "string" && recommended_model.length > 0));
  assert.ok(batch.requests.every(({ task_profile }) => /^CP2-[a-f0-9]{12}$/u.test(task_profile?.context_pack_id)));
  assert.ok(tasks.tasks.every(({ task_profile }) => /^CP2-[a-f0-9]{12}$/u.test(task_profile?.context_pack_id)));
  assert.ok(tasks.tasks.every(({ task_profile }) => ["v2_initial", "v2_bounded_retrieval", "v1_fallback"].includes(task_profile?.context_route?.route)));
  assert.ok(batch.requests.every(({ task_profile }) => task_profile?.context_route?.task_id));
  assert.ok(tasks.tasks.every((task) => task.execution_policy_version === 1));
  assert.ok(tasks.tasks.every((task) => task.execution_plan?.policy_version === 2));
  assert.ok(tasks.tasks.every((task) => task.execution_plan?.execution_mode === "solo_direct"));
  assert.ok(tasks.tasks.every((task) => task.canonical_state_root === root));
  assert.ok(tasks.tasks.every((task) => ["fast", "standard", "critical"].includes(task.execution_plan?.lane)));
  assert.equal(tasks.tasks.find((task) => task.work_mode === "implementation")?.execution_plan?.lane, "standard");
  assert.ok(tasks.tasks.every((task) => task.routing_class === "inline_verified"));
  assert.ok(tasks.tasks.every((task) => task.handoff_required === false));
  assert.ok(tasks.tasks.every((task) => task.specialist_report_required === false));
  assert.ok(tasks.tasks.every((task) => task.specialist_report_path === null));
  assert.ok(batch.requests.every((request) => request.specialist_report_required === false));
  assert.ok(tasks.tasks.every((task) => task.task_intent?.authority_boundary?.agent_may?.some((item) => item.includes("reversible intermediate actions"))));
  assert.ok(tasks.tasks.every((task) => task.task_intent?.authority_boundary?.user_only?.some((item) => item.includes("final external send"))));
  assert.ok(tasks.tasks.every((task) => !task.task_intent?.authority_boundary?.user_only?.includes("authorize external or destructive actions")));
  assert.ok(tasks.tasks.every((task) => task.model_route?.recommended_model));
  assert.ok(tasks.tasks.every((task) => task.task_profile?.risk_profile));
  assert.ok(tasks.tasks.every((task) => task.task_profile?.context_manifest?.required_reading?.length > 0));
  assert.ok(tasks.tasks.every((task) => task.task_profile?.task_envelope?.task_envelope_id));
  assert.ok(tasks.tasks.every((task) => task.task_profile?.context_requirement?.requirement_id));
  assert.equal(shadowIndex.mode, "shadow");
  assert.equal(shadowIndex.comparisons.length, batch.requests.length);
  assert.ok(shadowIndex.comparisons.every((comparison) => Number.isInteger(comparison.v2_selected_tokens)));
  assert.ok(shadowIndex.comparisons.every((comparison) => (
    comparison.task_envelope_id && comparison.context_requirement_id && comparison.context_pack_id
  )));
  assert.ok(sourceCatalog.records.length >= batch.requests.length * 2);
  assert.ok(sourceCatalog.records.some((record) => record.source_ref === "src/App.tsx"));
  assert.equal(controlPlane.project_id, setupState.project_id);
  for (const task of tasks.tasks) {
    await json(root, `context/requirements/${task.task_profile.context_requirement.requirement_id}.json`);
    const comparison = shadowIndex.comparisons.find((entry) => entry.task_id === task.task_id);
    assert.ok(comparison);
  }
  assert.ok(tasks.tasks.every((task) => (
    JSON.stringify(task.model_route?.signals) === JSON.stringify(task.task_profile?.control_signals)
  )));
  assert.ok(tasks.tasks.every((task) => (
    Array.isArray(task.task_intent?.constraints)
    && task.task_intent.constraints.every((constraint) => !constraint.includes(".."))
  )));
  assert.deepEqual(checkDelegationGate(root), { errors: [], warnings: [] });
  assert.ok(organization.revision >= 2);
  assert.equal(result.output.provisioningBatchId, batch.provisioning_batch_id);
});

test("operation accepts solo direct tasks without specialist sessions or reports", async () => {
  const { root, setupState } = await repository();
  const handlers = createDefaultPhaseHandlers({
    now: () => NOW,
    provisionFoundation,
    provisionSpecialists: async ({ batch }) => ({
      ...batch,
      requests: batch.requests.map((request, index) => ({
        ...request,
        status: "standby",
        handoff_status: "accepted",
        thread_id: `thread-${index + 1}`,
        turn_id: `turn-${index + 1}`,
        completed_at: NOW,
      })),
    }),
  });
  await handlers.understanding({ rootPath: root, setupState });
  await handlers.foundation({ rootPath: root, setupState });
  await handlers.planning({ rootPath: root, setupState });
  await handlers.specialists({ rootPath: root, setupState });
  const batch = await json(root, "setup/provisioning_batch.json");

  assert.ok(batch.requests.every((request) => request.status === "inline_verified"));
  const directives = {
    version: 1,
    directives: [{
      directive_id: "SETUP-DIRECTIVE-1",
      source: "user",
      status: "active",
      summary: "Keep this directive during operation handoff.",
      created_at: NOW,
    }],
    updated_at: NOW,
  };
  await writeFile(
    path.join(root, ".orquesta", "state", "directives.json"),
    `${JSON.stringify(directives, null, 2)}\n`,
    "utf8",
  );

  const result = await handlers.operation({ rootPath: root, setupState });
  assert.equal(result.output.ready, true);
  const operationCheckpoint = await json(root, "setup/checkpoints/operation.json");
  assert.equal(operationCheckpoint.status, "complete");
  assert.equal(operationCheckpoint.project_structure.status, "ready");
  assert.equal(operationCheckpoint.project_structure.context_view_id, result.output.projectStructure.contextViewId);
  const options = await json(root, "setup/options.json");
  assert.equal(options.setup_status, "ready");
  assert.equal(options.bootstrap_status, "ready");
  assert.equal(options.foundation_session_status, "ready");
  assert.equal(options.orchestrator_thread_id, "thread-orchestrator");
  assert.equal(options.admin_thread_id, "thread-orquesta-admin");
  const wizard = await json(root, "setup/wizard.json");
  assert.equal(wizard.status, "ready_for_operation");
  assert.equal(wizard.current_step, "operation_ready");
  assert.equal(wizard.gates.setup_autopilot_finalized, true);
  assert.equal(wizard.gates.specialist_plan_reviewed, true);
  assert.deepEqual(await json(root, "state/directives.json"), directives);
  const currentOrchestra = await readFile(path.join(root, ".orquesta", "CURRENT_ORCHESTRA.md"), "utf8");
  assert.match(currentOrchestra, /Setup status: ready/u);
  assert.match(currentOrchestra, /Current phase: operation/u);
  assert.match(currentOrchestra, /SETUP-DIRECTIVE-1/u);
});

test("specialists preserve structured work risk and control inputs through the execution plan", async () => {
  const { root, setupState } = await repository();
  const handlers = createDefaultPhaseHandlers({
    now: () => NOW,
    provisionFoundation,
    provisionSpecialists: async ({ batch }) => ({
      ...batch,
      requests: batch.requests.map((request, index) => ({
        ...request,
        status: "standby",
        handoff_status: "accepted",
        thread_id: `thread-${index + 1}`,
        turn_id: `turn-${index + 1}`,
        completed_at: NOW,
      })),
    }),
  });
  await handlers.understanding({ rootPath: root, setupState });
  await handlers.foundation({ rootPath: root, setupState });
  await handlers.planning({ rootPath: root, setupState });
  const mapPath = path.join(root, ".orquesta", "project", "completion_map.json");
  const map = JSON.parse(await readFile(mapPath, "utf8"));
  const work = map.tasks.find((item) => item.role_id === "implementation");
  work.risk = { impact: "high", reversible: false };
  work.control_signals = { consequence: "low", reversibility: "low" };
  work.failure_history = [{ kind: "failed_check" }];
  work.capability_needs = [{
    need_id: "NEED-implementation",
    description: "Implement the bounded work item.",
    kind: "code",
    required_level: "required",
    hard_constraints: ["Respect the work item scope boundaries."],
    dependencies: [],
    verification_method: "focused automated tests",
    status: "open",
    confidence: 100,
  }];
  await writeFile(mapPath, JSON.stringify(map), "utf8");

  await handlers.specialists({ rootPath: root, setupState });
  const tasks = await json(root, "state/tasks.json");
  const task = tasks.tasks.find((item) => item.task_id === work.task_id);
  assert.equal(task.execution_plan.lane, "critical");
  assert.equal(task.execution_plan.risk_profile.reversibility, "irreversible");
  assert.equal(task.control_signals.consequence, "high");
  assert.equal(task.control_signals.reversibility, "high");
  assert.equal(task.model_route.signals.consequence, "high");
  assert.ok(task.task_profile.reason_codes.includes("explicit:task_intent.risk.impact"));
  assert.ok(task.task_profile.evidence_refs.includes("task_intent:risk.reversible"));
});

test("operation blocks when any canonical foundation session is missing", async () => {
  const { root, setupState } = await repository();
  const handlers = createDefaultPhaseHandlers({
    now: () => NOW,
    provisionFoundation,
  });
  await handlers.foundation({ rootPath: root, setupState });
  const sessions = await json(root, "state/sessions.json");
  await writeFile(
    path.join(root, ".orquesta", "state", "sessions.json"),
    JSON.stringify({
      ...sessions,
      sessions: sessions.sessions.map((session) => (
        session.agent_id === "orquesta-admin"
          ? { ...session, handoff_turn_id: null }
          : session
      )),
    }),
    "utf8",
  );

  await assert.rejects(
    handlers.operation({ rootPath: root, setupState }),
    (error) => error.code === "FOUNDATION_SESSIONS_MISSING"
      && error.retryable === true
      && error.message.includes("orquesta-admin"),
  );
});
