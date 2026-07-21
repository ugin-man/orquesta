"use strict";

const { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { createAdaptiveSpecialistPlan } = require("../../packages/core/src/adaptive-setup");
const {
  createFoundationStateBundle,
  createInitialRosterTransition,
  prepareProvisioningBatch,
} = require("./adaptive-setup-state");
const { SetupBlockedError } = require("./setup-runner");

const TEXT_BUDGET = 256 * 1024;
const FILE_BUDGET = 40;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function exists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
}

async function readJson(filePath, fallback = null) {
  try { return JSON.parse(await readFile(filePath, "utf8")); } catch (error) {
    if (error && error.code === "ENOENT") return clone(fallback);
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function activity(id, title, detail, status, now) {
  return { activity_id: id, title, detail, status, observed_at: now };
}

function checkpoint(rootPath, phaseId, setupState, now, extra = {}) {
  return writeJsonAtomic(path.join(rootPath, ".orquesta", "setup", "checkpoints", `${phaseId}.json`), {
    schema_version: 1,
    setup_id: setupState.setup_id,
    phase_id: phaseId,
    status: "complete",
    completed_at: now,
    ...clone(extra),
  });
}

async function boundedProjectEvidence(rootPath) {
  const names = [];
  const candidates = [];
  const rootEntries = await readdir(rootPath, { withFileTypes: true });
  for (const entry of rootEntries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === ".orquesta" || entry.name === ".git" || entry.name === "node_modules") continue;
    const relative = entry.name;
    names.push(relative);
    if (entry.isFile()) candidates.push(relative);
    if (entry.isDirectory() && names.length < FILE_BUDGET) {
      const children = await readdir(path.join(rootPath, entry.name), { withFileTypes: true }).catch(() => []);
      for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
        if (names.length >= FILE_BUDGET) break;
        const childRelative = `${entry.name}/${child.name}`;
        names.push(childRelative);
        if (child.isFile()) candidates.push(childRelative);
      }
    }
    if (names.length >= FILE_BUDGET) break;
  }

  const preferred = candidates.filter((relative) => /^(?:README[^/]*|package\.json|Cargo\.toml|pyproject\.toml|requirements\.txt|go\.mod)$/iu.test(relative));
  const documents = [];
  let consumed = 0;
  for (const relative of preferred) {
    const filePath = path.join(rootPath, ...relative.split("/"));
    const info = await stat(filePath).catch(() => null);
    if (!info?.isFile() || consumed >= TEXT_BUDGET) continue;
    const remaining = TEXT_BUDGET - consumed;
    const content = (await readFile(filePath)).subarray(0, remaining).toString("utf8");
    consumed += Buffer.byteLength(content, "utf8");
    documents.push({ path: relative.replace(/\\/g, "/"), content });
  }
  return { names: names.slice(0, FILE_BUDGET), documents };
}

function inferStack(evidence) {
  const stack = new Set();
  const packageDocument = evidence.documents.find(({ path: evidencePath }) => evidencePath === "package.json");
  if (packageDocument) {
    stack.add("node");
    try {
      const manifest = JSON.parse(packageDocument.content);
      const dependencies = { ...(manifest.dependencies || {}), ...(manifest.devDependencies || {}) };
      if (dependencies.react) stack.add("react");
      if (dependencies.electron) stack.add("electron");
      if (dependencies.typescript || evidence.names.some((name) => /\.tsx?$/iu.test(name))) stack.add("typescript");
    } catch {
      // Invalid manifests remain evidence but do not block setup understanding.
    }
  }
  if (evidence.names.includes("Cargo.toml")) stack.add("rust");
  if (evidence.names.includes("pyproject.toml") || evidence.names.includes("requirements.txt")) stack.add("python");
  if (evidence.names.includes("go.mod")) stack.add("go");
  return [...stack].sort();
}

function inferRoles(understanding) {
  const text = `${understanding.goal}\n${understanding.stack.join(" ")}\n${understanding.existing_assets.join(" ")}`;
  const rules = [
    ["implementation", /(app|desktop|electron|react|software|code|実装|開発|アプリ|システム)/iu],
    ["design", /(ui|ux|design|interface|visual|デザイン|画面|外観)/iu],
    ["research", /(research|analysis|audit|調査|分析|監査)/iu],
    ["writing", /(novel|story|article|document|小説|物語|記事|文書)/iu],
    ["testing", /(test|quality|qa|verify|検証|テスト|品質)/iu],
  ];
  const roles = rules.filter(([, pattern]) => pattern.test(text)).map(([roleId]) => roleId);
  return roles.length ? [...new Set(roles)] : ["generalist"];
}

function roleDefinition(roleId) {
  const names = {
    implementation: { ja: "実装係", en: "Implementation" },
    design: { ja: "設計係", en: "Design" },
    research: { ja: "調査係", en: "Research" },
    writing: { ja: "文書係", en: "Writing" },
    testing: { ja: "検証係", en: "Testing" },
    generalist: { ja: "専門係", en: "Generalist" },
  };
  return {
    role_id: roleId,
    version: 1,
    display_names: names[roleId] || { ja: roleId, en: roleId },
    aliases: [],
    capability_ids: [`role:${roleId}`],
    default_contract_template: `${roleId}-v1`,
    lifecycle_state: "active",
  };
}

function completionMap(understanding, projectTitle, now) {
  const roles = inferRoles(understanding);
  return {
    version: 2,
    revision: 1,
    project_title: projectTitle,
    status: "in_progress",
    updated_at: now,
    source: "desktop_initial_setup",
    definition_of_done: understanding.goal,
    tasks: roles.map((roleId, index) => ({
      task_id: `SETUP-${roleId.toUpperCase()}-${String(index + 1).padStart(3, "0")}`,
      title: `${projectTitle}: ${roleId} first executable work`,
      status: "ready",
      depends_on: [],
      role_id: roleId,
      line_id: "primary-line",
      team_id: `primary-${roleId}`,
      deliverable_id: "primary-deliverable",
      acceptance_root_id: `CM-PRIMARY-${String(index + 1).padStart(3, "0")}`,
      scope_boundaries: ["."],
      durable: true,
      independent_deliverable: false,
      activation_condition: null,
    })),
    phases: [
      { phase_id: "CM001", title: "初期理解", summary: "プロジェクト入力と既存資産を整理する。", status: "done", owner_agent_id: "orchestrator", items: [] },
      { phase_id: "CM002", title: "初期制作体制", summary: "最初の実行可能作業へ必要な専門家を接続する。", status: "in_progress", owner_agent_id: "orchestrator", items: [] },
      { phase_id: "CM003", title: "運用と調整", summary: "作業結果に合わせて組織を調整する。", status: "queued", owner_agent_id: "orchestrator", items: [] },
    ],
  };
}

function executableTasks(completion, batch, current, now) {
  const byId = new Map((current.tasks || []).map((task) => [task.task_id, clone(task)]));
  const workById = new Map((completion.tasks || []).map((task) => [task.task_id, task]));
  for (const request of batch.requests) {
    const work = workById.get(request.task_id) || {};
    const existing = byId.get(request.task_id) || {};
    byId.set(request.task_id, {
      ...existing,
      task_id: request.task_id,
      title: work.title || request.task_id,
      state: existing.state || "queued",
      owner_agent_id: request.agent_id,
      created_at: existing.created_at || now,
      dependencies: work.depends_on || [],
      blocked_by: [],
      source: "adaptive_initial_setup",
      line_id: work.line_id || request.line_id || "primary-line",
      team_id: work.team_id || request.team_id || null,
      result_summary: existing.result_summary || "Waiting for Desktop Codex provisioning.",
    });
  }
  return { ...current, version: current.version || 1, tasks: [...byId.values()], updated_at: now };
}

async function organizationBundle(rootPath) {
  const stateRoot = path.join(rootPath, ".orquesta", "state");
  return {
    rolesState: await readJson(path.join(stateRoot, "roles.json")),
    agentsState: await readJson(path.join(stateRoot, "agents.json")),
    organizationState: await readJson(path.join(stateRoot, "organization.json")),
    sessionsState: await readJson(path.join(stateRoot, "sessions.json"), { version: 1, sessions: [] }),
    tasksState: await readJson(path.join(stateRoot, "tasks.json"), { version: 1, tasks: [] }),
  };
}

function createDefaultPhaseHandlers({ now = () => new Date().toISOString(), provisionSpecialists = null } = {}) {
  return {
    async environment({ rootPath, setupState }) {
      const timestamp = now();
      const statePath = path.join(rootPath, ".orquesta", "setup", "setup_state.json");
      if (!(await exists(statePath))) throw new Error("Canonical setup state is missing");
      const persisted = await readJson(statePath);
      if (persisted.setup_id !== setupState.setup_id) throw new Error("Setup state identity mismatch");
      const relative = "setup/checkpoints/environment.json";
      await checkpoint(rootPath, "environment", setupState, timestamp, { root_path: path.resolve(rootPath) });
      return {
        checkpointRef: relative,
        activity: activity("setup-environment-complete", "環境確認が完了", "保存先とOrquesta状態を確認しました。", "complete", timestamp),
        output: { rootPath: path.resolve(rootPath) },
      };
    },

    async understanding({ rootPath, setupState }) {
      const timestamp = now();
      const intake = await readJson(path.join(rootPath, ".orquesta", "setup", "project_intake.json"), {});
      const evidence = await boundedProjectEvidence(rootPath);
      const projectUnderstanding = {
        project_id: setupState.project_id,
        goal: String(intake.project_description || setupState.input_snapshot?.description || intake.project_title || setupState.project_title).trim(),
        stage: "initial-setup",
        deliverables: [{ deliverable_id: "primary-deliverable", name: setupState.project_title, completion_evidence: [] }],
        stack: inferStack(evidence),
        constraints: [],
        existing_assets: evidence.names,
        unknowns: [],
        evidence: evidence.documents.map(({ path: evidencePath }) => ({ path: evidencePath, kind: evidencePath === "README.md" ? "readme" : "manifest" })),
        confidence: evidence.documents.length ? 0.78 : 0.58,
      };
      await writeJsonAtomic(path.join(rootPath, ".orquesta", "project", "project_understanding.json"), projectUnderstanding);
      const relative = "setup/checkpoints/understanding.json";
      await checkpoint(rootPath, "understanding", setupState, timestamp, { evidence_count: projectUnderstanding.evidence.length });
      return {
        checkpointRef: relative,
        activity: activity("setup-understanding-complete", "プロジェクト理解が完了", "入力と主要資産から目的と技術構成を整理しました。", "complete", timestamp),
        output: projectUnderstanding,
      };
    },

    async foundation({ rootPath, setupState }) {
      const timestamp = now();
      const organizationPath = path.join(rootPath, ".orquesta", "state", "organization.json");
      const current = await readJson(organizationPath, { revision: 0, agents: [] });
      const expected = ["orchestrator", "orquesta-admin", "user-support"];
      const ids = new Set((current.agents || []).map(({ agent_id }) => agent_id));
      if (!(current.revision >= 1 && expected.every((agentId) => ids.has(agentId)))) {
        if (current.revision !== 0) throw new Error("Existing organization cannot be replaced during foundation setup");
        const bundle = createFoundationStateBundle({ projectId: setupState.project_id, now: timestamp });
        await Promise.all([
          writeJsonAtomic(path.join(rootPath, ".orquesta", "state", "roles.json"), bundle.rolesState),
          writeJsonAtomic(path.join(rootPath, ".orquesta", "state", "agents.json"), bundle.agentsState),
          writeJsonAtomic(organizationPath, bundle.organizationState),
          writeJsonAtomic(path.join(rootPath, ".orquesta", "state", "sessions.json"), bundle.sessionsState),
          writeJsonAtomic(path.join(rootPath, ".orquesta", "state", "tasks.json"), bundle.tasksState),
        ]);
      }
      const relative = "setup/checkpoints/foundation.json";
      await checkpoint(rootPath, "foundation", setupState, timestamp, { agent_ids: expected });
      return {
        checkpointRef: relative,
        activity: activity("setup-foundation-complete", "基礎組織が完成", "統括者、Luca、利用者支援係を接続しました。", "complete", timestamp),
        output: { agentIds: expected },
      };
    },

    async planning({ rootPath, setupState }) {
      const timestamp = now();
      const mapPath = path.join(rootPath, ".orquesta", "project", "completion_map.json");
      const planPath = path.join(rootPath, ".orquesta", "setup", "specialist_plan.json");
      let map = await readJson(mapPath, null);
      let plan = await readJson(planPath, null);
      if (!(map?.revision === 1 && Array.isArray(map.tasks) && map.tasks.length && plan?.schema_version === 2)) {
        const understanding = await readJson(path.join(rootPath, ".orquesta", "project", "project_understanding.json"));
        map = completionMap(understanding, setupState.project_title, timestamp);
        const roles = [...new Set(map.tasks.map(({ role_id }) => role_id))].map(roleDefinition);
        plan = createAdaptiveSpecialistPlan({
          project_understanding: understanding,
          completion_map: map,
          role_definitions: roles,
          approval_source: "setup_confirmation",
        });
        if (plan.status === "blocked_unknown") throw new Error(plan.user_capability?.reason || "Initial specialist planning is blocked");
        await writeJsonAtomic(mapPath, map);
        await writeJsonAtomic(planPath, plan);
      }
      const relative = "setup/checkpoints/planning.json";
      await checkpoint(rootPath, "planning", setupState, timestamp, { task_count: map.tasks.length, specialist_group_count: plan.selected_specialists.length });
      return {
        checkpointRef: relative,
        activity: activity("setup-planning-complete", "初期計画が完成", `${map.tasks.length}件の実行可能作業を準備しました。`, "complete", timestamp),
        output: { completionMap: map, specialistPlan: plan },
      };
    },

    async specialists({ rootPath, setupState }) {
      const timestamp = now();
      const batchPath = path.join(rootPath, ".orquesta", "setup", "provisioning_batch.json");
      const plan = await readJson(path.join(rootPath, ".orquesta", "setup", "specialist_plan.json"));
      const understanding = await readJson(path.join(rootPath, ".orquesta", "project", "project_understanding.json"));
      const completion = await readJson(path.join(rootPath, ".orquesta", "project", "completion_map.json"));
      let batch = await readJson(batchPath, null);
      if (!batch) {
        const bundle = await organizationBundle(rootPath);
        batch = prepareProvisioningBatch({
          specialistPlan: plan,
          organizationRevision: bundle.organizationState.revision,
          existingAgents: bundle.agentsState.agents || [],
          now: timestamp,
        });
        const transition = createInitialRosterTransition({
          bundle,
          specialistPlan: plan,
          provisioningBatch: batch,
          projectUnderstanding: understanding,
          now: timestamp,
        });
        batch.organization_revision = transition.organizationState.revision;
        const tasksState = executableTasks(completion, batch, transition.tasksState, timestamp);
        await Promise.all([
          writeJsonAtomic(path.join(rootPath, ".orquesta", "state", "roles.json"), transition.rolesState),
          writeJsonAtomic(path.join(rootPath, ".orquesta", "state", "agents.json"), transition.agentsState),
          writeJsonAtomic(path.join(rootPath, ".orquesta", "state", "organization.json"), transition.organizationState),
          writeJsonAtomic(path.join(rootPath, ".orquesta", "state", "sessions.json"), transition.sessionsState),
          writeJsonAtomic(path.join(rootPath, ".orquesta", "state", "tasks.json"), tasksState),
          writeJsonAtomic(batchPath, { ...batch, updated_at: timestamp }),
        ]);
      }

      const pending = batch.requests.some((request) => ["pending", "reuse_ready"].includes(request.status));
      if (pending) {
        if (typeof provisionSpecialists !== "function") {
          throw new SetupBlockedError("SPECIALIST_RUNTIME_UNAVAILABLE", "専門家を起動するCodex runtimeへ接続できません。", true);
        }
        batch = await provisionSpecialists({ rootPath, projectId: setupState.project_id, batch: clone(batch) });
        await writeJsonAtomic(batchPath, { ...batch, updated_at: now() });
      }
      const failures = batch.requests.filter((request) => request.status === "provisioning_failed" || request.handoff_status === "failed");
      if (failures.length) {
        throw new SetupBlockedError("SPECIALIST_PROVISIONING_FAILED", `${failures.length}件の専門家起動に失敗しました。`, true);
      }
      const unfinished = batch.requests.filter((request) => request.handoff_status !== "accepted" && !["standby", "accepted"].includes(request.status));
      if (unfinished.length) {
        throw new SetupBlockedError("SPECIALIST_PROVISIONING_INCOMPLETE", `${unfinished.length}件の専門家がまだ起動していません。`, true);
      }
      const relative = "setup/checkpoints/specialists.json";
      await checkpoint(rootPath, "specialists", setupState, now(), { provisioning_batch_id: batch.provisioning_batch_id, request_count: batch.requests.length });
      return {
        checkpointRef: relative,
        activity: activity("setup-specialists-complete", "専門家編成が完了", `${batch.requests.length}件の専門家接続を確認しました。`, "complete", now()),
        output: { provisioningBatchId: batch.provisioning_batch_id, requestCount: batch.requests.length },
      };
    },

    async operation({ rootPath, setupState }) {
      const timestamp = now();
      const batch = await readJson(path.join(rootPath, ".orquesta", "setup", "provisioning_batch.json"), { requests: [] });
      const bundle = await organizationBundle(rootPath);
      const sessions = new Map((bundle.sessionsState.sessions || []).map((session) => [session.agent_id, session]));
      const tasks = new Map((bundle.tasksState.tasks || []).map((task) => [task.task_id, task]));
      const organizationAgents = new Set((bundle.organizationState.agents || []).map((agent) => agent.agent_id));
      const missing = [];
      for (const request of batch.requests || []) {
        if (!organizationAgents.has(request.agent_id)) missing.push(`organization:${request.agent_id}`);
        if (!sessions.get(request.agent_id)?.thread_id) missing.push(`session:${request.agent_id}`);
        if (tasks.get(request.task_id)?.owner_agent_id !== request.agent_id) missing.push(`task:${request.task_id}`);
      }
      if (missing.length) {
        throw new SetupBlockedError("OPERATION_NOT_READY", `初期体制の接続が完了していません: ${missing.slice(0, 6).join(", ")}`, true);
      }
      if (bundle.organizationState.revision !== bundle.rolesState.organization_revision
        || bundle.organizationState.revision !== bundle.agentsState.organization_revision) {
        throw new SetupBlockedError("ORGANIZATION_REVISION_MISMATCH", "組織stateのrevisionが一致していません。", true);
      }
      const relative = "setup/checkpoints/operation.json";
      await checkpoint(rootPath, "operation", setupState, timestamp, { organization_revision: bundle.organizationState.revision, ready: true });
      return {
        checkpointRef: relative,
        activity: activity("setup-operation-complete", "運用準備が完了", "初期タスクと専門家を接続しました。", "complete", timestamp),
        output: { ready: true, organizationRevision: bundle.organizationState.revision },
      };
    },
  };
}

module.exports = {
  createDefaultPhaseHandlers,
};
