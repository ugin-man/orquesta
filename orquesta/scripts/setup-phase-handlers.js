"use strict";

const { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { createAdaptiveSpecialistPlan } = require("../../packages/core/src/adaptive-setup");
const { createProfiledExecutionPlan } = require("../../packages/core/src/profiled-execution-plan");
const { createTaskIntent } = require("../../packages/core/src/task-intent");
const {
  buildSourceCatalogV2,
  buildProjectMapV2,
  compileContextPackV2Shadow,
  createProjectControlPlaneV2,
} = require("../../packages/context-compiler/src");
const {
  createFoundationStateBundle,
  createInitialRosterTransition,
  prepareProvisioningBatch,
} = require("./adaptive-setup-state");
const { defaultModelPolicy, recommendModelRoute } = require("./model-policy");
const { writeJsonAtomic: writeJsonStateAtomic } = require("./json-state");
const { buildCurrentOrchestra, buildSetupOptions, buildSetupWizard } = require("./setup-engine");
const { SetupBlockedError } = require("./setup-runner");
const { installSessionRotationHook } = require("./session-rotation-hook-install");
const { bindGeneratedContextV2 } = require("./context-v2-canonical");
const { initializeProjectStructure } = require("./project-structure-setup");

const TEXT_BUDGET = 256 * 1024;
const FILE_BUDGET = 40;
const FOUNDATION_AGENT_IDS = Object.freeze(["orchestrator", "orquesta-admin", "user-support"]);

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

function writeJsonAtomic(filePath, value) {
  return writeJsonStateAtomic(filePath, value);
}

async function writeTextAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, value, "utf8");
  try {
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function canonicalSessionsState(current, rootPath, timestamp) {
  return {
    ...current,
    version: current.version || 1,
    source: "codex_app.list_threads",
    project_cwd: path.resolve(rootPath),
    synced_at: timestamp,
    sessions: Array.isArray(current.sessions) ? current.sessions : [],
    updated_at: timestamp,
  };
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
  const text = String(understanding.goal || "");
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

function initialWorkDefinition(roleId, understanding, projectTitle, index) {
  const work = {
    implementation: {
      title: `${projectTitle}: 最小の実装成果物を作る`,
      desired_outcome: "現在の実装を確認し、プロジェクト目標へ直結する最小の実装単位を完成させて検証する。",
      scope_boundaries: ["."],
      work_mode: "implementation",
      acceptance_criteria: [
        "プロジェクト目標を直接前進させる最小の実装成果物がworkspace内に存在する。",
        "成果物に対応する決定的な検証を実行し、結果を記録する。",
      ],
    },
    design: {
      title: `${projectTitle}: 最初のレビュー可能な設計判断を作る`,
      desired_outcome: "現在の設計と目標を確認し、実装担当がそのまま使える最初の設計判断を一つ残す。",
      scope_boundaries: [".orquesta/reports"],
      work_mode: "report_only",
      acceptance_criteria: [
        "対象画面またはインターフェース、採用案、却下案、確認条件が明確である。",
        "実装担当が追加の設計探索なしで着手できる。",
      ],
    },
    research: {
      title: `${projectTitle}: 最初の未解決事項を調査して判断材料を残す`,
      desired_outcome: "プロジェクト目標を妨げる未解決事項を一つ選び、現実的な選択肢を比較する。",
      scope_boundaries: [".orquesta/reports"],
      work_mode: "report_only",
      acceptance_criteria: [
        "調査対象、比較した選択肢、根拠、推奨案が明確である。",
        "未確認事項と、次に必要な検証が区別されている。",
      ],
    },
    writing: {
      title: `${projectTitle}: 最初の文書成果物を作る`,
      desired_outcome: "プロジェクト目標へ直結する最小の文書成果物をworkspace内に作り、レビュー可能にする。",
      scope_boundaries: ["."],
      work_mode: "implementation",
      acceptance_criteria: [
        "対象読者と目的に合う文書成果物がworkspace内に存在する。",
        "文書の構造または内容を確認する決定的な検証結果がある。",
      ],
    },
    testing: {
      title: `${projectTitle}: 最初の検証不足を埋める`,
      desired_outcome: "現在の検証基準を確認し、最優先の不足を一つテストまたは検証手順として実装する。",
      scope_boundaries: ["."],
      work_mode: "implementation",
      acceptance_criteria: [
        "不足していた挙動を再現または判定できる検証がworkspace内に存在する。",
        "検証を実行し、成功または失敗の結果が明確である。",
      ],
    },
    generalist: {
      title: `${projectTitle}: 最初の実行可能な成果物を作る`,
      desired_outcome: "プロジェクト目標を、ユーザーが確認できる一つの小さな成果物としてworkspace内に完成させる。",
      scope_boundaries: ["."],
      work_mode: "implementation",
      acceptance_criteria: [
        "プロジェクト目標を直接前進させる最小の成果物がworkspace内に存在する。",
        "成果物が要求を満たすことを決定的な方法で確認できる。",
      ],
    },
  }[roleId] || {
    title: `${projectTitle}: 最初の実行可能な成果物を作る`,
    desired_outcome: "プロジェクト目標を、ユーザーが確認できる一つの小さな成果物としてworkspace内に完成させる。",
    scope_boundaries: ["."],
    work_mode: "implementation",
    acceptance_criteria: [
      "プロジェクト目標を直接前進させる最小の成果物がworkspace内に存在する。",
      "成果物が要求を満たすことを決定的な方法で確認できる。",
    ],
  };
  return {
    task_id: `SETUP-${roleId.toUpperCase()}-${String(index + 1).padStart(3, "0")}`,
    ...work,
    status: "ready",
    depends_on: [],
    role_id: roleId,
    line_id: "primary-line",
    team_id: `primary-${roleId}`,
    deliverable_id: "primary-deliverable",
    acceptance_root_id: `CM-PRIMARY-${String(index + 1).padStart(3, "0")}`,
    acceptance_criteria: [
      `「${understanding.goal}」を直接前進させる。`,
      ...work.acceptance_criteria,
      "実施内容、確認結果、未解決の障害をspecialist reportへ短く記録する。",
    ],
    scope_boundaries: work.scope_boundaries,
    work_mode: work.work_mode,
    durable: true,
    independent_deliverable: work.work_mode !== "report_only",
    activation_condition: null,
  };
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
    tasks: roles.map((roleId, index) => initialWorkDefinition(roleId, understanding, projectTitle, index)),
    phases: [
      { phase_id: "CM001", title: "初期理解", summary: "プロジェクト入力と既存資産を整理する。", status: "done", owner_agent_id: "orchestrator", items: [] },
      { phase_id: "CM002", title: "初期制作体制", summary: "最初の実行可能作業へ必要な専門家を接続する。", status: "in_progress", owner_agent_id: "orchestrator", items: [] },
      { phase_id: "CM003", title: "運用と調整", summary: "作業結果に合わせて組織を調整する。", status: "queued", owner_agent_id: "orchestrator", items: [] },
    ],
  };
}

function initialTaskExecution(work, rootPath, projectUnderstanding = {}) {
  const scopes = Array.isArray(work.scope_boundaries) && work.scope_boundaries.length
    ? work.scope_boundaries
    : ["."];
  const constraints = Array.isArray(work.constraints) && work.constraints.length
    ? work.constraints
    : scopes.map((scope) => (
      scope === "."
        ? "Keep repository changes within the project root."
        : `Limit workspace changes to ${scope}.`
    ));
  const taskIntent = createTaskIntent({
    rawRequestRef: `completion-map:${work.task_id}`,
    desiredOutcome: work.desired_outcome || work.title,
    acceptanceCriteria: (
      Array.isArray(work.acceptance_criteria) && work.acceptance_criteria.length
        ? work.acceptance_criteria
        : [`Produce durable completion evidence for ${work.acceptance_root_id || work.task_id}.`]
    ),
    constraints,
    risk: work.risk || { impact: "medium", reversible: true },
    authorityBoundary: {
      agent_may: [
        "read approved project context",
        "write inside the approved workspace scope",
        "report evidence",
        "perform task-authorized reversible intermediate actions when the actual target, data, and effect stay within approved boundaries",
      ],
      user_only: [
        "approve a new product line",
        "authorize destructive or irreversible actions",
        "perform final external send, submission, publication, purchase, contract, or consent",
      ],
    },
    assumptions: [`The ${work.role_id || "specialist"} role owns this first executable work item.`],
    status: "compiled",
  });
  const { task_profile: taskProfile, execution_plan: executionPlan } = createProfiledExecutionPlan({
    taskIntent,
    workItem: {
      scope_boundaries: scopes,
      effects: work.effects || [],
      verification_method: work.verification_method,
      work_mode: work.work_mode || "implementation",
      context_manifest: work.context_manifest || {},
      control_signals: work.control_signals || {},
      execution_evidence: work.execution_evidence || {}
    },
    projectUnderstanding,
    capabilityNeeds: work.capability_needs || work.capabilityNeeds || [],
    failureHistory: work.failure_history || work.failureHistory || []
  });
  const modelRoute = recommendModelRoute(
    { task_id: work.task_id, task_profile: taskProfile },
    defaultModelPolicy(),
    { work_mode: taskProfile.recommended_work_mode, task_profile: taskProfile },
  );
  return { taskIntent, taskProfile, executionPlan, modelRoute, canonicalStateRoot: path.resolve(rootPath) };
}

function contextV2ShadowArtifacts({
  rootPath,
  projectId,
  projectUnderstanding,
  completion,
  batch,
  executionByTaskId,
  timestamp,
}) {
  const sourceRecords = new Map();
  const requirements = [];
  const packs = [];
  const comparisons = [];
  const workById = new Map((completion.tasks || []).map((work) => [work.task_id, work]));
  for (const request of batch.requests || []) {
    const execution = executionByTaskId[request.task_id];
    const profile = execution?.taskProfile || {};
    const envelope = profile.task_envelope;
    const requirement = profile.context_requirement;
    if (!execution?.taskIntent || !envelope || !requirement) continue;
    const manifest = profile.context_manifest || {};
    const projectEvidenceRefs = (projectUnderstanding.evidence || [])
      .map((entry) => entry?.path)
      .filter((entry) => typeof entry === "string");
    const projectAssetRefs = (projectUnderstanding.existing_assets || [])
      .filter((entry) => typeof entry === "string");
    const catalog = buildSourceCatalogV2({
      workspaceRoot: rootPath,
      taskIntent: execution.taskIntent,
      taskEnvelope: envelope,
      contextRequirement: requirement,
      sourceRefs: [
        ...(Array.isArray(manifest.required_reading) ? manifest.required_reading : []),
        ...(Array.isArray(manifest.allowed_files) ? manifest.allowed_files : []),
        ...projectEvidenceRefs,
        ...projectAssetRefs,
      ],
    });
    for (const record of catalog) sourceRecords.set(record.source_id, record);
    const compiled = compileContextPackV2Shadow({
      taskIntent: execution.taskIntent,
      taskEnvelope: envelope,
      contextRequirement: requirement,
      agentCapabilityProfile: {
        agent_id: request.agent_id,
        capabilities: [],
        availability: "available",
        organization_revision: batch.organization_revision,
      },
      sourceCatalog: catalog,
    });
    requirements.push(requirement);
    packs.push(compiled.context_pack);
    const selectedRefs = compiled.selected_source_records.map(({ source_ref }) => source_ref).sort();
    const v1Refs = [...new Set(Array.isArray(manifest.required_reading) ? manifest.required_reading : [])].sort();
    comparisons.push({
      task_id: request.task_id,
      owner_agent_id: request.agent_id,
      task_envelope_id: envelope.task_envelope_id,
      context_requirement_id: requirement.requirement_id,
      context_pack_id: compiled.context_pack.context_pack_id,
      v1_required_reading: v1Refs,
      v2_selected_source_refs: selectedRefs,
      only_in_v1: v1Refs.filter((reference) => !selectedRefs.includes(reference)),
      only_in_v2: selectedRefs.filter((reference) => !v1Refs.includes(reference)),
      v2_selected_tokens: compiled.context_pack.budget_receipt.selected_tokens,
      coverage_matrix: compiled.context_pack.coverage_matrix,
      fallback_reason: compiled.shadow_assessment.fallback_reason,
    });
  }
  const firstWork = (completion.tasks || [])[0] || null;
  const controlPlane = createProjectControlPlaneV2({
    projectId,
    revision: batch.organization_revision,
    activeWorkstream: firstWork ? {
      workstream_id: `workstream:${firstWork.task_id}`,
      task_id: firstWork.task_id,
      current_goal: firstWork.desired_outcome || firstWork.title,
      next_decision: "Reconcile the first specialist result against its acceptance criteria.",
    } : null,
    projectBrief: {
      title: completion.project_title || projectUnderstanding.project_name || projectId,
      goal: projectUnderstanding.goal || completion.definition_of_done || "",
      source: "desktop_initial_setup",
    },
    userIntent: {
      desired_outcome: projectUnderstanding.goal || completion.definition_of_done || "",
      constraints: projectUnderstanding.constraints || [],
    },
    workGraph: {
      task_ids: (completion.tasks || []).map(({ task_id }) => task_id),
      dependencies: Object.fromEntries((completion.tasks || []).map((work) => [work.task_id, work.depends_on || []])),
    },
    organizationMap: {
      organization_revision: batch.organization_revision,
      agent_ids: (batch.requests || []).map(({ agent_id }) => agent_id),
    },
    riskAndApproval: {
      new_product_line_requires_user_approval: true,
    },
    backgroundWorkstreams: (completion.tasks || []).slice(1).map((work) => ({
      workstream_id: `workstream:${work.task_id}`,
      state: "queued",
      summary: work.desired_outcome || work.title,
    })),
    updatedAt: timestamp,
  });
  const sourceCatalog = {
    version: 2,
    derived: true,
    generated_at: timestamp,
    records: [...sourceRecords.values()].sort((left, right) => left.source_ref.localeCompare(right.source_ref)),
  };
  const relatedTaskIdsByRef = {};
  for (const work of completion.tasks || []) {
    const manifest = work.context_manifest || {};
    for (const reference of [
      ...(Array.isArray(manifest.required_reading) ? manifest.required_reading : []),
      ...(Array.isArray(manifest.allowed_files) ? manifest.allowed_files : []),
    ]) {
      relatedTaskIdsByRef[reference] = [...new Set([
        ...(relatedTaskIdsByRef[reference] || []),
        work.task_id,
      ])];
    }
  }
  const projectMap = buildProjectMapV2({
    workspaceRoot: rootPath,
    sourceCatalog: sourceCatalog.records,
    projectControlPlane: controlPlane,
    relatedTaskIdsByRef,
    generatedAt: timestamp,
  });
  return {
    requirements,
    packs,
    controlPlane,
    projectMap,
    sourceCatalog,
    shadowIndex: {
      version: 2,
      mode: "shadow",
      generated_at: timestamp,
      comparisons: comparisons.sort((left, right) => left.task_id.localeCompare(right.task_id)),
    },
  };
}

function executableTasks(completion, batch, current, now, rootPath, projectUnderstanding = {}) {
  const byId = new Map((current.tasks || []).map((task) => [task.task_id, clone(task)]));
  const workById = new Map((completion.tasks || []).map((task) => [task.task_id, task]));
  for (const request of batch.requests) {
    const work = workById.get(request.task_id) || {};
    const existing = byId.get(request.task_id) || {};
    const execution = initialTaskExecution({ ...work, task_id: request.task_id }, rootPath, projectUnderstanding);
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
      task_intent: existing.task_intent || execution.taskIntent,
      execution_policy_version: 1,
      canonical_state_root: execution.canonicalStateRoot,
      execution_plan: existing.execution_plan || execution.executionPlan,
      task_profile: existing.task_profile || execution.taskProfile,
      control_signals: existing.control_signals || execution.taskProfile.control_signals,
      work_mode: existing.work_mode || execution.taskProfile.recommended_work_mode,
      routing_class: execution.executionPlan.routing.routing_class,
      routing_gate_status: existing.routing_gate_status || "pending",
      handoff_required: execution.executionPlan.routing.handoff_required,
      handoff_sent_at: existing.handoff_sent_at || null,
      handoff_attempts: existing.handoff_attempts || [],
      specialist_report_required: execution.executionPlan.routing.specialist_report_required,
      specialist_report_path: execution.executionPlan.routing.specialist_report_required
        ? existing.specialist_report_path || `.orquesta/reports/${request.task_id}-${request.agent_id}.md`
        : null,
      execution_cycles: existing.execution_cycles || [],
      completion_evidence: existing.completion_evidence || [],
      execution_metrics: existing.execution_metrics || {
        wall_time_ms: 0,
        agent_turns: 0,
        handoffs: 0,
        independent_reviews: 0,
        correction_batches: 0,
        reports: 0,
        token_usage: { coverage: "unknown", known_total: null, by_thread: [] },
      },
      model_route: existing.model_route || execution.modelRoute,
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

function createDefaultPhaseHandlers({
  now = () => new Date().toISOString(),
  provisionFoundation = null,
  provisionSpecialists = null,
} = {}) {
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
      const projectStructure = await initializeProjectStructure({
        rootPath,
        projectId: setupState.project_id,
        projectName: setupState.project_title,
        description: projectUnderstanding.goal,
        sourceKind: setupState.input_snapshot?.source?.kind || "detected_root",
        setupAnswers: intake.answers || setupState.input_snapshot?.answers || [],
        generatedAt: timestamp,
      });
      projectUnderstanding.project_structure = {
        template_version: projectStructure.template_version,
        archetype: projectStructure.archetype,
        setup_mode: projectStructure.mode,
        layout_ref: ".orquesta/project/layout.json",
        lifecycle_ref: ".orquesta/project/lifecycle.json",
        context_view_ref: ".orquesta/context/initial-context-view.json",
        context_view_id: projectStructure.context_view_id,
      };
      await writeJsonAtomic(path.join(rootPath, ".orquesta", "project", "project_understanding.json"), projectUnderstanding);
      const relative = "setup/checkpoints/understanding.json";
      await checkpoint(rootPath, "understanding", setupState, timestamp, {
        evidence_count: projectUnderstanding.evidence.length,
        project_structure: projectUnderstanding.project_structure,
        physical_changes: projectStructure.physical_changes,
      });
      return {
        checkpointRef: relative,
        activity: activity("setup-understanding-complete", "プロジェクト理解が完了", "入力と主要資産から目的、技術構成、初期ファイル構造を整理しました。", "complete", timestamp),
        output: projectUnderstanding,
      };
    },

    async foundation({ rootPath, setupState }) {
      const timestamp = now();
      const organizationPath = path.join(rootPath, ".orquesta", "state", "organization.json");
      const current = await readJson(organizationPath, { revision: 0, agents: [] });
      const expected = [...FOUNDATION_AGENT_IDS];
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
      const stateRoot = path.join(rootPath, ".orquesta", "state");
      let agentsState = await readJson(path.join(stateRoot, "agents.json"), { version: 1, agents: [] });
      let sessionsState = await readJson(path.join(stateRoot, "sessions.json"), { version: 1, sessions: [] });
      sessionsState = canonicalSessionsState(sessionsState, rootPath, timestamp);
      await writeJsonAtomic(path.join(stateRoot, "sessions.json"), sessionsState);
      const connected = new Set((sessionsState.sessions || [])
        .filter((session) => typeof session.thread_id === "string" && session.thread_id.trim()
          && typeof session.handoff_turn_id === "string" && session.handoff_turn_id.trim())
        .map((session) => session.agent_id));
      const missing = expected.filter((agentId) => !connected.has(agentId));
      if (missing.length) {
        if (typeof provisionFoundation !== "function") {
          throw new SetupBlockedError(
            "FOUNDATION_RUNTIME_UNAVAILABLE",
            `基礎3役を起動するCodex runtimeへ接続できません: ${missing.join(", ")}`,
            true,
          );
        }
        let results;
        try {
          results = await provisionFoundation({
            rootPath,
            projectId: setupState.project_id,
            agentIds: missing,
          });
        } catch (error) {
          throw new SetupBlockedError(
            "FOUNDATION_PROVISIONING_FAILED",
            `基礎3役の起動に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
            true,
          );
        }
        const acceptedById = new Map((Array.isArray(results) ? results : [])
          .filter((result) => result?.status === "accepted"
            && typeof result.thread_id === "string" && result.thread_id.trim()
            && typeof result.turn_id === "string" && result.turn_id.trim())
          .map((result) => [result.agent_id, result]));
        const sessionByAgent = new Map((sessionsState.sessions || []).map((session) => [session.agent_id, clone(session)]));
        for (const agentId of missing) {
          const result = acceptedById.get(agentId);
          if (!result) continue;
          sessionByAgent.set(agentId, {
            ...(sessionByAgent.get(agentId) || {}),
            session_id: sessionByAgent.get(agentId)?.session_id || `session-${agentId}`,
            agent_id: agentId,
            thread_id: result.thread_id,
            status: agentId === "user-support" ? "standby" : "working",
            handoff_status: "accepted",
            handoff_turn_id: result.turn_id,
            session_generation: 1,
            rotation_state: "active",
            ownership_status: "owner",
            accepts_new_work: true,
            runtime_authority_id: result.runtime_authority_id || null,
            visibility: result.visibility || null,
            profile_id: result.profile_id || `foundation:${agentId}:v1`,
            session_kind: result.session_kind || "persistent_agent",
            updated_at: timestamp,
          });
        }
        sessionsState = canonicalSessionsState({
          ...sessionsState,
          sessions: [...sessionByAgent.values()],
        }, rootPath, timestamp);
        agentsState = {
          ...agentsState,
          agents: (agentsState.agents || []).map((agent) => {
            const result = acceptedById.get(agent.agent_id);
            if (!result) return agent;
            const operationalStatus = agent.agent_id === "user-support" ? "standby" : "working";
            return {
              ...agent,
              thread_id: result.thread_id,
              lifecycle_state: "active",
              operational_status: operationalStatus,
              status: operationalStatus,
              updated_at: timestamp,
            };
          }),
          updated_at: timestamp,
        };
        await Promise.all([
          writeJsonAtomic(path.join(stateRoot, "agents.json"), agentsState),
          writeJsonAtomic(path.join(stateRoot, "sessions.json"), sessionsState),
        ]);
        const incomplete = missing.filter((agentId) => !acceptedById.has(agentId));
        if (incomplete.length) {
          throw new SetupBlockedError(
            "FOUNDATION_PROVISIONING_INCOMPLETE",
            `基礎3役の接続が完了していません: ${incomplete.join(", ")}`,
            true,
          );
        }
      }
      const relative = "setup/checkpoints/foundation.json";
      await checkpoint(rootPath, "foundation", setupState, timestamp, {
        agent_ids: expected,
        session_ids: expected.map((agentId) => `session-${agentId}`),
      });
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
        const executionByTaskId = Object.fromEntries((completion.tasks || []).map((work) => [
          work.task_id,
          initialTaskExecution(work, rootPath, understanding),
        ]));
        batch = prepareProvisioningBatch({
          specialistPlan: plan,
          organizationRevision: bundle.organizationState.revision,
          existingAgents: bundle.agentsState.agents || [],
          recommendedModelsByTaskId: Object.fromEntries(Object.entries(executionByTaskId).map(([taskId, execution]) => [
            taskId,
            execution.modelRoute.recommended_model,
          ])),
          now: timestamp,
        });
        batch.requests = batch.requests.map((request) => ({
          ...request,
          task_profile: executionByTaskId[request.task_id]?.taskProfile || null,
          specialist_report_required: executionByTaskId[request.task_id]?.executionPlan.routing.specialist_report_required ?? true,
          ...(executionByTaskId[request.task_id]?.executionPlan.execution_mode === "solo_direct"
            ? { status: "inline_verified", handoff_status: "not_required" }
            : {}),
        }));
        const transition = createInitialRosterTransition({
          bundle,
          specialistPlan: plan,
          provisioningBatch: batch,
          projectUnderstanding: understanding,
          now: timestamp,
        });
        batch.organization_revision = transition.organizationState.revision;
        let tasksState = executableTasks(completion, batch, transition.tasksState, timestamp, rootPath, understanding);
        const contextV2 = contextV2ShadowArtifacts({
          rootPath,
          projectId: setupState.project_id,
          projectUnderstanding: understanding,
          completion,
          batch,
          executionByTaskId,
          timestamp,
        });
        const boundContext = bindGeneratedContextV2({ tasksState, batch, contextV2, generatedAt: timestamp });
        tasksState = boundContext.tasksState;
        batch = boundContext.batch;
        await Promise.all([
          writeJsonAtomic(path.join(rootPath, ".orquesta", "state", "roles.json"), transition.rolesState),
          writeJsonAtomic(path.join(rootPath, ".orquesta", "state", "agents.json"), transition.agentsState),
          writeJsonAtomic(path.join(rootPath, ".orquesta", "state", "organization.json"), transition.organizationState),
          writeJsonAtomic(
            path.join(rootPath, ".orquesta", "state", "sessions.json"),
            canonicalSessionsState(transition.sessionsState, rootPath, timestamp),
          ),
          writeJsonAtomic(path.join(rootPath, ".orquesta", "state", "tasks.json"), tasksState),
          writeJsonAtomic(batchPath, { ...batch, updated_at: timestamp }),
          writeJsonAtomic(path.join(rootPath, ".orquesta", "context", "project_control_plane.json"), contextV2.controlPlane),
          writeJsonAtomic(path.join(rootPath, ".orquesta", "context", "project_map.json"), contextV2.projectMap),
          writeJsonAtomic(path.join(rootPath, ".orquesta", "context", "source_catalog.json"), contextV2.sourceCatalog),
          writeJsonAtomic(path.join(rootPath, ".orquesta", "context", "shadow_index.json"), contextV2.shadowIndex),
          writeJsonAtomic(path.join(rootPath, ".orquesta", "context", "variant_comparison.json"), boundContext.qualification),
          ...boundContext.activations.map((activation) => writeJsonAtomic(
            path.join(rootPath, ".orquesta", "context", "activation", `${encodeURIComponent(activation.task_id)}.json`),
            activation,
          )),
          ...contextV2.requirements.map((requirement) => writeJsonAtomic(
            path.join(rootPath, ".orquesta", "context", "requirements", `${requirement.requirement_id}.json`),
            requirement,
          )),
          ...contextV2.packs.map((pack) => writeJsonAtomic(
            path.join(rootPath, ".orquesta", "context", "packs", `${pack.context_pack_id}.json`),
            pack,
          )),
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
      const unfinished = batch.requests.filter((request) => request.handoff_status !== "accepted" && !["standby", "accepted", "inline_verified"].includes(request.status));
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
      const missingFoundation = FOUNDATION_AGENT_IDS.filter((agentId) => {
        const session = sessions.get(agentId);
        return !session?.thread_id || !session?.handoff_turn_id;
      });
      if (missingFoundation.length) {
        throw new SetupBlockedError(
          "FOUNDATION_SESSIONS_MISSING",
          `基礎3役のsession evidenceが不足しています: ${missingFoundation.join(", ")}`,
          true,
        );
      }
      const missing = [];
      for (const request of batch.requests || []) {
        if (request.status === "inline_verified") continue;
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
      const orquestaRoot = path.join(rootPath, ".orquesta");
      const [intake, understanding] = await Promise.all([
        readJson(path.join(orquestaRoot, "setup", "project_intake.json"), {}),
        readJson(path.join(orquestaRoot, "project", "project_understanding.json"), {}),
      ]);
      const projectStructure = await initializeProjectStructure({
        rootPath,
        projectId: setupState.project_id,
        projectName: setupState.project_title,
        description: understanding.goal || intake.project_description || "",
        sourceKind: setupState.input_snapshot?.source?.kind || "detected_root",
        setupAnswers: intake.answers || setupState.input_snapshot?.answers || [],
        generatedAt: timestamp,
      });
      const optionsPath = path.join(orquestaRoot, "setup", "options.json");
      const wizardPath = path.join(orquestaRoot, "setup", "wizard.json");
      const directivesPath = path.join(orquestaRoot, "state", "directives.json");
      const [currentOptions, currentWizard, directivesState, directivesPresent] = await Promise.all([
        readJson(optionsPath, {}),
        readJson(wizardPath, {}),
        readJson(directivesPath, { version: 1, directives: [], updated_at: timestamp }),
        exists(directivesPath),
      ]);
      const readyOptions = buildSetupOptions({
        rootPath,
        now: timestamp,
        status: "ready",
        sessionsState: bundle.sessionsState,
        existing: currentOptions,
      });
      const readyWizard = buildSetupWizard({
        now: timestamp,
        status: "ready",
        existing: currentWizard,
      });
      const currentOrchestra = buildCurrentOrchestra({
        setupState,
        now: timestamp,
        status: "ready",
        agentsState: bundle.agentsState,
        tasksState: bundle.tasksState,
        directivesState,
        dashboardUrl: readyOptions.dashboard_url,
      });
      await Promise.all([
        writeJsonAtomic(optionsPath, readyOptions),
        writeJsonAtomic(wizardPath, readyWizard),
        writeTextAtomic(path.join(orquestaRoot, "CURRENT_ORCHESTRA.md"), currentOrchestra),
        ...(!directivesPresent ? [writeJsonAtomic(directivesPath, directivesState)] : []),
      ]);
      const sessionRotationHook = installSessionRotationHook({ projectRoot: rootPath });
      const relative = "setup/checkpoints/operation.json";
      await checkpoint(rootPath, "operation", setupState, timestamp, {
        organization_revision: bundle.organizationState.revision,
        ready: true,
        project_structure: {
          status: "ready",
          template_version: projectStructure.template_version,
          archetype: projectStructure.archetype,
          setup_mode: projectStructure.mode,
          context_view_id: projectStructure.context_view_id,
        },
        session_rotation_hook: {
          status: sessionRotationHook.status,
          config_path: path.relative(rootPath, sessionRotationHook.configPath).replace(/\\/g, "/"),
          runtime_path: path.relative(rootPath, sessionRotationHook.runtimePath).replace(/\\/g, "/"),
          requires_trust_review: sessionRotationHook.requiresTrustReview,
        },
      });
      return {
        checkpointRef: relative,
        activity: activity("setup-operation-complete", "運用準備が完了", "初期タスクと専門家を接続しました。", "complete", timestamp),
        output: {
          ready: true,
          organizationRevision: bundle.organizationState.revision,
          projectStructure: {
            templateVersion: projectStructure.template_version,
            archetype: projectStructure.archetype,
            setupMode: projectStructure.mode,
            contextViewId: projectStructure.context_view_id,
          },
        },
      };
    },
  };
}

module.exports = {
  createDefaultPhaseHandlers,
};
