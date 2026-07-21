const http = require("http");
const fs = require("fs");
const path = require("path");
const { validateEncoding } = require("./scripts/validate-state-encoding");
const {
  DEFAULT_DASHBOARD_HOST,
  DEFAULT_DASHBOARD_PORT,
  findAvailableDashboardPort,
  normalizePort
} = require("./scripts/dashboard-port-selection");
const { buildDashboardStateEtag } = require("./scripts/dashboard-state-cache");
const { appendJsonlAtomic, updateJsonAtomic, writeJsonAtomic } = require("./scripts/json-state");
const {
  appendSubmittedQuestionCandidates,
  inspectReportQuestionCandidates
} = require("./scripts/report-question-candidates-check");
const { reviewTaskControl } = require("./scripts/control-audit");
const { createEmptyCapacityLedger } = require("./scripts/capacity-gate");
const { defaultModelPolicy } = require("./scripts/model-policy");
const { createAdaptiveSpecialistPlan } = require("@orquesta/core");
const {
  createInitialRosterTransition,
  createSetupStateBundle,
  prepareProvisioningBatch
} = require("./scripts/adaptive-setup-state");
const {
  buildOptionalSetupQuestions,
  buildProjectIntake
} = require("./scripts/setup-engine");
const buildSetupQuestions = buildOptionalSetupQuestions;
const {
  commitOrganizationTransition,
  migrateLegacyOrganization,
  readOrganizationBundle
} = require("./scripts/organization-state");

const root = path.resolve(__dirname, "..");
const dashboardRoot = path.join(__dirname, "assets", "dashboard");
const stateRoot = path.join(root, ".orquesta", "state");
const visionRoot = path.join(root, ".orquesta", "vision");
const failuresRoot = path.join(root, ".orquesta", "failures");
const userTasksRoot = path.join(root, ".orquesta", "user_tasks");
const setupRoot = path.join(root, ".orquesta", "setup");
const projectRoot = path.join(root, ".orquesta", "project");
const reportsRoot = path.join(root, ".orquesta", "reports");
let latestEncodingWarnings = [];

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8"
};

function readJsonFrom(basePath, fileName, fallback = null) {
  const filePath = path.join(basePath, fileName);
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readJson(fileName) {
  return readJsonFrom(stateRoot, fileName, {});
}

function readModelPolicyState(basePath = stateRoot) {
  return readJsonFrom(basePath, "model_policy.json", defaultModelPolicy());
}

function writeJsonTo(basePath, fileName, data) {
  return writeJsonAtomic(path.join(basePath, fileName), data);
}

function readSetupOptions() {
  return readJsonFrom(setupRoot, "options.json", {});
}

function parsePortFromUrl(value) {
  if (!value) return null;
  try {
    return normalizePort(new URL(String(value)).port);
  } catch {
    return null;
  }
}

function previousDashboardPortFromOptions(options) {
  return normalizePort(options?.dashboard_port)
    ?? parsePortFromUrl(options?.dashboard_url)
    ?? parsePortFromUrl(options?.local_paths?.dashboard_url);
}

function dashboardUrlFor(portInfo) {
  return `http://${portInfo.host}:${portInfo.port}/`;
}

function updateCurrentOrchestraDashboardUrl(dashboardUrl) {
  const currentPath = path.join(root, ".orquesta", "CURRENT_ORCHESTRA.md");
  if (!fs.existsSync(currentPath)) return false;

  const line = `- Dashboard URL: ${dashboardUrl}`;
  let text = fs.readFileSync(currentPath, "utf8");
  if (/^- Dashboard URL: .*$/m.test(text)) {
    text = text.replace(/^- Dashboard URL: .*$/m, line);
  } else {
    text = `${text.trimEnd()}\n\n## Local Dashboard Paths\n${line}\n`;
  }
  fs.writeFileSync(currentPath, text, "utf8");
  return true;
}

function writeDashboardRuntimeOptions(portInfo) {
  const options = readSetupOptions() || {};
  const dashboardUrl = dashboardUrlFor(portInfo);
  const now = new Date().toISOString();
  const nextOptions = {
    ...options,
    dashboard_url: dashboardUrl,
    dashboard_host: portInfo.host,
    dashboard_port: portInfo.port,
    dashboard_port_strategy: {
      source: portInfo.source,
      selected_at: now,
      checked_ports: portInfo.checkedPorts,
      conflicts: portInfo.conflicts
    },
    local_paths: {
      ...(options.local_paths || {}),
      project_root: root,
      dashboard_url: dashboardUrl,
      dashboard_html: path.join(dashboardRoot, "index.html"),
      dashboard_assets_dir: dashboardRoot,
      state_dir: stateRoot,
      orquesta_dir: path.join(root, ".orquesta")
    }
  };

  writeJsonTo(setupRoot, "options.json", nextOptions);
  const updatedCurrent = updateCurrentOrchestraDashboardUrl(dashboardUrl);
  return { dashboardUrl, updatedCurrent };
}

function readJsonl(fileName) {
  const filePath = path.join(stateRoot, fileName);
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function send(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store"
  });
  res.end(body);
}

function sendJson(res, status, data) {
  send(res, status, JSON.stringify(data), "application/json; charset=utf-8");
}

function sendJsonWithHeaders(res, status, data, headers = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers
  });
  res.end(JSON.stringify(data));
}

function sendNotModified(res, etag) {
  res.writeHead(304, {
    "cache-control": "no-store",
    etag
  });
  res.end();
}

function refreshEncodingWarnings() {
  latestEncodingWarnings = validateEncoding(path.join(root, ".orquesta"));
  return latestEncodingWarnings;
}

function readRequestJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        req.destroy(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function appendEvent(event) {
  const filePath = path.join(stateRoot, "events.jsonl");
  return appendJsonlAtomic(filePath, event);
}

function normalizeState(value) {
  return String(value || "").trim().toLowerCase().replaceAll("-", "_");
}

function reportPathForTask(task) {
  const candidates = [
    task?.specialist_report_path,
    task?.report,
    task?.review_report,
    ...(Array.isArray(task?.artifacts) ? task.artifacts : [])
  ].filter(Boolean);
  return candidates.find((artifact) => String(artifact).replace(/\\/g, "/").startsWith(".orquesta/reports/") && String(artifact).endsWith(".md")) || null;
}

function safeReportAbsolutePath(reportPath) {
  if (!reportPath) return null;
  const absolute = path.resolve(root, reportPath);
  if (!absolute.startsWith(reportsRoot + path.sep)) return null;
  return absolute;
}

function readReportExcerpt(reportPath) {
  const absolute = safeReportAbsolutePath(reportPath);
  if (!absolute || !fs.existsSync(absolute)) return { exists: false, excerpt: "" };
  const text = fs.readFileSync(absolute, "utf8");
  return {
    exists: true,
    excerpt: text.split(/\r?\n/).slice(0, 18).join("\n").slice(0, 1600)
  };
}

function buildReportReviews(tasks, agents) {
  const reviewStates = new Set(["completed", "report_submitted", "needs_review", "needs_orchestrator_review"]);
  const agentById = new Map((agents || []).map((agent) => [agent.agent_id, agent]));

  return (tasks || [])
    .filter((task) => reviewStates.has(normalizeState(task.state)) && reportPathForTask(task))
    .map((task) => {
      const report_path = reportPathForTask(task);
      const report = readReportExcerpt(report_path);
      const questionCandidates = report.exists
        ? inspectReportQuestionCandidates(safeReportAbsolutePath(report_path))
        : { present: false, status: "missing", itemCount: 0, errors: ["report file missing"], warnings: [] };
      const agent = agentById.get(task.owner_agent_id);
      return {
        task_id: task.task_id,
        title: task.title,
        state: task.state,
        owner_agent_id: task.owner_agent_id,
        owner_display_name: agent?.display_name_ja || agent?.display_name || task.owner_agent_id || "",
        report_path,
        report_exists: report.exists,
        report_excerpt: report.excerpt,
        result_summary: task.result_summary || "",
        completed_at: task.completed_at || null,
        source: task.source || null,
        source_candidate_id: task.source_candidate_id || null,
        question_candidates: {
          present: questionCandidates.present,
          status: questionCandidates.status,
          item_count: questionCandidates.itemCount,
          errors: questionCandidates.errors,
          warnings: questionCandidates.warnings
        }
      };
    });
}

function candidateByTaskId(plan, task) {
  const candidates = plan?.candidates || [];
  return candidates.find((candidate) => candidate.candidate_id === task.source_candidate_id)
    || candidates.find((candidate) => candidate.agent_id === task.owner_agent_id)
    || null;
}

function taskHandoffMode(task, productionStart) {
  const state = normalizeState(task.state);
  if (state === "queued" && task.source === "production_start") return "initial";
  if (state === "needs_revision" || state === "changes_requested") return "revision";
  const request = (productionStart?.activation_requests || []).find((item) => item.task_id === task.task_id);
  if (request && ["handoff_ready", "changes_requested"].includes(normalizeState(request.status))) {
    return normalizeState(request.status) === "changes_requested" ? "revision" : "initial";
  }
  return null;
}

function buildHandoffPrompt({ task, agent, candidate, productionStart, mode }) {
  const displayName = agent?.display_name_ja || agent?.display_name || candidate?.display_name || task.owner_agent_id || "specialist";
  const requiredReading = candidate?.required_reading || agent?.required_reading || [];
  const excludedContext = candidate?.excluded_context || agent?.excluded_context || [];
  const allowedFiles = agent?.allowed_files || [];
  const forbiddenActions = agent?.forbidden_actions || [];
  const acceptanceChecks = task.acceptance_checks || [];
  const artifacts = task.artifacts || [];
  const request = (productionStart?.activation_requests || []).find((item) => item.task_id === task.task_id);
  const revisionNote = task.report_review?.note || task.result_summary || request?.note || "";

  const lines = [
    `# Orquesta Handoff`,
    ``,
    `agent_id: ${task.owner_agent_id || ""}`,
    `display_name: ${displayName}`,
    `task_id: ${task.task_id}`,
    `mode: ${mode === "revision" ? "revision" : "initial"}`,
    ``,
    `## Mission`,
    task.title || "Complete the assigned Orquesta task.",
    ``,
    `## Required Reading`,
    ...(requiredReading.length ? requiredReading.map((item) => `- ${item}`) : ["- Orquesta state files relevant to this task."]),
    ``,
    `## Excluded Context`,
    ...(excludedContext.length ? excludedContext.map((item) => `- ${item}`) : ["- Do not load unrelated specialist context."]),
    ``,
    `## Allowed Files`,
    ...(allowedFiles.length ? allowedFiles.map((item) => `- ${item}`) : ["- Task-owned files only."]),
    ``,
    `## Forbidden Actions`,
    ...(forbiddenActions.length ? forbiddenActions.map((item) => `- ${item}`) : ["- Do not push to GitHub without orchestrator approval.", "- Do not broaden scope without reporting back."]),
    ``,
    `## Acceptance Checks`,
    ...(acceptanceChecks.length ? acceptanceChecks.map((item) => `- ${item}`) : ["- Write a short report before claiming completion."]),
    ``,
    `## Question Candidate Requirement`,
    `At the end of your report, include a structured \`question_candidates\` JSON block.`,
    `Submit 0-3 useful candidates that would clarify user intent, future plans, quality risk, design direction, or task scope.`,
    `If there are no useful candidates, set \`status: "none"\`, include a valid \`none_reason\`, and add a one-sentence \`none_rationale\`.`,
    `Do not ask the user directly; user-support will curate raw candidates before any user-facing question is created.`,
    ``,
    `## Current Artifacts`,
    ...(artifacts.length ? artifacts.map((item) => `- ${item}`) : ["- None yet."]),
    ``,
    `## Instructions`,
    mode === "revision"
      ? "This is a revision handoff. Re-read the report review note, make only the requested corrections, and write an updated report."
      : "This is an initial production handoff. Work inside the contract, keep context narrow, and report back before project-level acceptance.",
    revisionNote ? `\nReview or handoff note: ${revisionNote}` : "",
    ``,
    `## Done Signal`,
    `Write a report to .orquesta/reports/${task.task_id}-${task.owner_agent_id || "agent"}.md with:`,
    `- status`,
    `- changed`,
    `- verified`,
    `- not verified`,
    `- blockers`,
    `- artifacts`,
    `- needs orchestrator review`,
    `- structured question_candidates block`,
    ``,
    `Stop after the report unless the task explicitly asks for more.`
  ];

  return lines.filter((line) => line !== null).join("\n");
}

function buildHandoffDrafts(tasks, agents, specialistPlan, productionStart) {
  const agentById = new Map((agents || []).map((agent) => [agent.agent_id, agent]));
  return (tasks || [])
    .map((task) => {
      const mode = taskHandoffMode(task, productionStart);
      if (!mode || !task.owner_agent_id) return null;
      const agent = agentById.get(task.owner_agent_id);
      const candidate = candidateByTaskId(specialistPlan, task);
      const prompt = buildHandoffPrompt({ task, agent, candidate, productionStart, mode });
      return {
        handoff_id: `HO-${task.task_id}`,
        task_id: task.task_id,
        mode,
        title: task.title || task.task_id,
        agent_id: task.owner_agent_id,
        agent_display_name: agent?.display_name_ja || agent?.display_name || candidate?.display_name || task.owner_agent_id,
        thread_id: agent?.thread_id || candidate?.thread_id || null,
        task_state: task.state,
        prompt,
        prompt_preview: prompt.split(/\r?\n/).slice(0, 18).join("\n")
      };
    })
    .filter(Boolean);
}

function addUnique(list, value) {
  if (!value) return list || [];
  const next = Array.isArray(list) ? list : [];
  if (!next.includes(value)) next.push(value);
  return next;
}

function nextBatchId(answerBatches) {
  const max = answerBatches
    .map((batch) => String(batch.batch_id || "").match(/^A(\d+)$/)?.[1])
    .filter(Boolean)
    .map(Number)
    .reduce((current, value) => Math.max(current, value), 0);
  return `A${String(max + 1).padStart(3, "0")}`;
}

function nextQuestionIdFactory(questions) {
  const max = questions
    .map((question) => String(question.question_id || "").match(/^Q(\d+)$/)?.[1])
    .filter(Boolean)
    .map(Number)
    .reduce((current, value) => Math.max(current, value), 0);
  return (offset) => `Q${String(max + offset).padStart(3, "0")}`;
}

function nextProductionTaskIdFactory(tasks) {
  const max = (tasks || [])
    .map((task) => String(task.task_id || "").match(/^PS(\d+)$/)?.[1])
    .filter(Boolean)
    .map(Number)
    .reduce((current, value) => Math.max(current, value), 0);
  return (offset) => `PS${String(max + offset).padStart(3, "0")}`;
}

function defaultSetupWizard() {
  return {
    version: 1,
    status: "not_started",
    current_step: "welcome",
    steps: [
      { step_id: "welcome", title: "ようこそOrquestaへ", summary: "Orquestaが何をするか、どの順番で進むかをユーザーに説明する。", status: "active" },
      { step_id: "project_intake", title: "プロジェクト説明", summary: "ユーザーが作りたいものを説明する。", status: "queued" },
      { step_id: "question_gate", title: "任意の補完質問", summary: "必要なら質問に答える。飛ばしてもセットアップは続行できる。", status: "queued" },
      { step_id: "auto_finalize", title: "初期セットアップ自動完了", summary: "Orquestaが初期完成マップ、専門AI候補、開発ステップを自動で用意する。", status: "queued" },
      { step_id: "operation_ready", title: "運用開始", summary: "ユーザーは必要に応じて体制や進め方を後から調整できる。", status: "queued" }
    ],
    gates: {
      project_intake_required: true,
      required_questions_must_be_answered: false,
      completion_map_requires_user_approval: false,
      completion_map_approved: false,
      setup_autopilot_enabled: true
    }
  };
}

function updateSetupStep(wizard, stepId, status) {
  return {
    ...wizard,
    steps: (wizard.steps || []).map((step) => (
      step.step_id === stepId ? { ...step, status } : step
    ))
  };
}

function defaultSpecialistPlan() {
  return {
    version: 1,
    status: "not_generated",
    updated_at: null,
    source: "completion_map",
    candidates: [],
    notes: []
  };
}

function defaultProductionStart() {
  return {
    version: 1,
    status: "not_started",
    updated_at: null,
    selected_candidate_ids: [],
    activation_requests: [],
    policy: {
      create_sessions_on_start: false,
      requires_thread_handoff: true
    }
  };
}

function setupQuestionStats(questionsState) {
  const setupQuestions = (questionsState.questions || []).filter((question) => question.required_for_setup);
  const unresolved = setupQuestions.filter((question) => !["answered", "adopted", "retired"].includes(String(question.status || "")));
  return {
    total: setupQuestions.length,
    unresolved: unresolved.length,
    answered: setupQuestions.length - unresolved.length
  };
}

function syncWizardQuestionGate(questionsState) {
  let wizard = readJsonFrom(setupRoot, "wizard.json", defaultSetupWizard());
  const stats = setupQuestionStats(questionsState);
  if (!stats.total) return wizard;

  wizard.status = "in_progress";
  wizard.updated_at = new Date().toISOString();
  wizard.gates = {
    ...(wizard.gates || {}),
    required_questions_must_be_answered: true,
    required_questions_total: stats.total,
    required_questions_answered: stats.answered,
    required_questions_unresolved: stats.unresolved
  };

  if (stats.unresolved > 0) {
    wizard.current_step = "question_gate";
    wizard = updateSetupStep(wizard, "welcome", "done");
    wizard = updateSetupStep(wizard, "project_intake", "done");
    wizard = updateSetupStep(wizard, "question_gate", "active");
    wizard = updateSetupStep(wizard, "auto_finalize", "queued");
    wizard.gates.completion_map_approved = false;
  } else {
    wizard.current_step = wizard.gates.setup_autopilot_finalized ? "operation_ready" : "auto_finalize";
    wizard = updateSetupStep(wizard, "question_gate", "done");
    wizard = updateSetupStep(wizard, "auto_finalize", wizard.gates.setup_autopilot_finalized ? "done" : "active");
    wizard = updateSetupStep(wizard, "operation_ready", wizard.gates.setup_autopilot_finalized ? "active" : "queued");
  }

  writeJsonTo(setupRoot, "wizard.json", wizard);
  return wizard;
}

const ROLE_INFERENCE_RULES = Object.freeze([
  { role_id: "implementation", pattern: /(app|web|desktop|electron|software|system|code|game|開発|実装|アプリ|ゲーム|システム|ツール)/iu },
  { role_id: "design", pattern: /(ui|ux|design|interface|visual|デザイン|画面|外観|設計)/iu },
  { role_id: "research", pattern: /(research|investigat|analysis|audit|調査|研究|分析|監査)/iu },
  { role_id: "writing", pattern: /(novel|story|book|article|document|writing|小説|物語|記事|文書|執筆)/iu },
  { role_id: "testing", pattern: /(test|quality|qa|verify|validation|検証|テスト|品質)/iu }
]);

function inferInitialRoleIds(intake) {
  const text = `${intake.project_title || ""}\n${intake.project_description || ""}`;
  const matches = ROLE_INFERENCE_RULES.filter((rule) => rule.pattern.test(text)).map((rule) => rule.role_id);
  return matches.length ? [...new Set(matches)] : ["generalist"];
}

function setupRoleDefinition(roleId) {
  const names = {
    implementation: { ja: "実装係", en: "Implementation" },
    design: { ja: "設計係", en: "Design" },
    research: { ja: "調査係", en: "Research" },
    writing: { ja: "文書係", en: "Writing" },
    testing: { ja: "検証係", en: "Testing" },
    generalist: { ja: "専門係", en: "Generalist" }
  };
  return {
    role_id: roleId,
    version: 1,
    display_names: names[roleId] || { ja: roleId, en: roleId },
    aliases: [],
    capability_ids: [`role:${roleId}`],
    default_contract_template: `${roleId}-v1`,
    lifecycle_state: "active"
  };
}

function buildProjectUnderstanding(intake, completionMap) {
  const tasks = completionMap.tasks || [];
  const deliverables = [...new Set(tasks.map((task) => task.deliverable_id).filter(Boolean))]
    .map((deliverableId) => ({
      deliverable_id: deliverableId,
      name: deliverableId,
      completion_evidence: tasks.filter((task) => task.deliverable_id === deliverableId).map((task) => task.acceptance_root_id)
    }));
  return {
    project_id: path.basename(root),
    goal: String(intake.project_description || intake.project_title || "Orquesta project").trim(),
    stage: "initial-setup",
    deliverables,
    stack: [],
    constraints: [],
    existing_assets: [],
    unknowns: [],
    evidence: [{ path: ".orquesta/setup/project_intake.json", kind: "user_input" }],
    confidence: 0.65
  };
}

function buildAutopilotCompletionMap(intake, now) {
  const projectTitle = String(intake.project_title || "Orquesta project").trim() || "Orquesta project";
  const roles = inferInitialRoleIds(intake);
  const tasks = roles.map((roleId, index) => ({
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
    activation_condition: null
  }));
  return {
    version: 2,
    revision: 1,
    project_title: projectTitle,
    status: "in_progress",
    updated_at: now,
    source: "setup_autopilot_project_intake",
    definition_of_done: String(intake.project_description || `Complete ${projectTitle}`).trim(),
    tasks,
    phases: [
      { phase_id: "CM001", title: "初期理解", summary: "プロジェクト入力から最初の実行可能作業を作る。", status: "done", owner_agent_id: "orchestrator", items: [] },
      { phase_id: "CM002", title: "初期制作体制", summary: "必要な専門家だけを生成して最初の作業へ接続する。", status: "in_progress", owner_agent_id: "orchestrator", items: tasks.map((task) => ({ item_id: task.task_id, title: task.title, status: "in_progress" })) },
      { phase_id: "CM003", title: "運用と調整", summary: "作業結果に合わせて組織を調整する。", status: "queued", owner_agent_id: "orchestrator", items: [] }
    ]
  };
}

function normalizeCompletionMapForSetup(current, intake, now) {
  if (Array.isArray(current.tasks) && current.tasks.length) {
    return {
      ...current,
      revision: Number.isInteger(current.revision) ? current.revision : 1,
      tasks: current.tasks.map((task) => ({
        ...task,
        line_id: task.line_id || "primary-line",
        team_id: task.team_id || `primary-${task.role_id || "generalist"}`,
        scope_boundaries: Array.isArray(task.scope_boundaries) && task.scope_boundaries.length ? task.scope_boundaries : ["."],
        depends_on: Array.isArray(task.depends_on) ? task.depends_on : []
      })),
      updated_at: current.updated_at || now
    };
  }
  return buildAutopilotCompletionMap(intake, now);
}

function ensureAutopilotCompletionMap(intake, now) {
  const current = readJsonFrom(projectRoot, "completion_map.json", {});
  const map = normalizeCompletionMapForSetup(current, intake, now);
  const created = !Array.isArray(current.tasks) || current.tasks.length === 0;
  writeJsonTo(projectRoot, "completion_map.json", map);
  if (created) {
    appendEvent({
      timestamp: now,
      type: "setup_autopilot_completion_map_created",
      actor: "orchestrator",
      summary: `Created ${map.tasks.length} first executable work items from project intake.`
    });
  }
  return { map, created };
}

function ensureFoundationOrganization(now) {
  const current = readOrganizationBundle(root);
  if (current.organizationState.revision > 0) return current;
  const migrated = migrateLegacyOrganization({
    projectId: path.basename(root),
    agentsState: current.agentsState,
    sessionsState: current.sessionsState,
    tasksState: current.tasksState,
    rolesState: current.rolesState,
    organizationState: null,
    now
  });
  commitOrganizationTransition({ root, expectedRevision: 0, bundle: migrated, now });
  return readOrganizationBundle(root);
}

function setupRoleDefinitions(bundle, completionMap) {
  const existing = bundle.rolesState.roles || [];
  const roleIds = [...new Set((completionMap.tasks || []).map((task) => task.role_id).filter(Boolean))];
  return [...existing, ...roleIds.filter((roleId) => !existing.some((role) => role.role_id === roleId)).map(setupRoleDefinition)];
}

function ensureExecutableSetupTasks(completionMap, batch, now) {
  const tasksState = readJson("tasks.json");
  const tasks = tasksState.tasks || [];
  const workById = new Map((completionMap.tasks || []).map((task) => [task.task_id, task]));
  const ownerByTask = new Map(batch.requests.map((request) => [request.task_id, request.agent_id]));
  for (const taskId of batch.requests.map((request) => request.task_id)) {
    const work = workById.get(taskId);
    const record = tasks.find((task) => task.task_id === taskId);
    const next = {
      ...(record || {}),
      task_id: taskId,
      title: work?.title || taskId,
      state: record?.state || "queued",
      owner_agent_id: ownerByTask.get(taskId),
      created_at: record?.created_at || now,
      dependencies: work?.depends_on || [],
      blocked_by: [],
      source: "adaptive_initial_setup",
      line_id: work?.line_id || "primary-line",
      team_id: work?.team_id || null,
      result_summary: record?.result_summary || "Waiting for Desktop Codex provisioning."
    };
    if (record) Object.assign(record, next);
    else tasks.push(next);
  }
  writeJsonTo(stateRoot, "tasks.json", { ...tasksState, version: tasksState.version || 1, tasks, updated_at: now });
}

function prepareSetupProvisioning({ plan, understanding, completionMap, now, retryFailed = false }) {
  const expectedTasks = [...plan.first_executable_batch].sort();
  const existingBatch = readJsonFrom(setupRoot, "provisioning_batch.json", null);
  if (existingBatch && JSON.stringify(existingBatch.requests.map((request) => request.task_id).sort()) === JSON.stringify(expectedTasks)) {
    if (retryFailed) {
      existingBatch.requests = existingBatch.requests.map((request) => request.status === "provisioning_failed"
        ? { ...request, status: "pending", handoff_status: null, error: null, completed_at: null }
        : request);
      existingBatch.updated_at = now;
      writeJsonTo(setupRoot, "provisioning_batch.json", existingBatch);
    }
    return { reused: true, batch: existingBatch };
  }
  const foundation = ensureFoundationOrganization(now);
  const batch = prepareProvisioningBatch({
    specialistPlan: plan,
    organizationRevision: foundation.organizationState.revision,
    existingAgents: foundation.agentsState.agents || [],
    now
  });
  const transition = createInitialRosterTransition({
    bundle: foundation,
    specialistPlan: plan,
    provisioningBatch: batch,
    projectUnderstanding: understanding,
    now
  });
  commitOrganizationTransition({
    root,
    expectedRevision: foundation.organizationState.revision,
    bundle: transition,
    now
  });
  batch.organization_revision = transition.organizationState.revision;
  ensureExecutableSetupTasks(completionMap, batch, now);
  writeJsonTo(setupRoot, "provisioning_batch.json", { ...batch, updated_at: now });
  return { reused: false, batch };
}

function saveVisionAnswers(payload) {
  const submitted = Array.isArray(payload.answers) ? payload.answers : [];
  const answers = submitted
    .map((answer) => ({
      question_id: String(answer.question_id || "").trim(),
      answer: String(answer.answer || "").trim()
    }))
    .filter((answer) => answer.question_id && answer.answer);

  if (!answers.length) {
    const error = new Error("No non-empty answers submitted");
    error.statusCode = 400;
    throw error;
  }

  const now = new Date().toISOString();
  const questionsState = readJsonFrom(visionRoot, "questions.json", { version: 1, questions: [], curation_policy: {} });
  const answersState = readJsonFrom(visionRoot, "answers.json", { version: 1, answer_batches: [] });
  const existingBatches = answersState.answer_batches || [];
  const batchId = nextBatchId(existingBatches);
  const questionIds = new Set(answers.map((answer) => answer.question_id));
  const readyQuestionIds = new Set((questionsState.questions || [])
    .filter((question) => question.status === "ready")
    .map((question) => question.question_id));
  const invalidQuestionIds = [...questionIds].filter((questionId) => !readyQuestionIds.has(questionId));
  if (invalidQuestionIds.length) {
    const error = new Error(`Questions are not ready or do not exist: ${invalidQuestionIds.join(", ")}`);
    error.statusCode = 400;
    throw error;
  }

  answersState.version = answersState.version || 1;
  answersState.answer_batches = [
    ...existingBatches,
    {
      batch_id: batchId,
      question_ids: [...questionIds],
      source: "dashboard_text_answer",
      status: "needs_curation",
      interpretation_mode: "discussion_seed_not_command",
      answers: answers.map((answer) => ({
        question_id: answer.question_id,
        answer: answer.answer,
        answered_at: now
      })),
      curator_report: null,
      discussion_seeds: [],
      strong_signals: [],
      candidate_rules: [],
      counterproposals: [],
      do_not_adopt_yet: [],
      needs_user_review: [],
      proposed_updates: [],
      adopted_updates: []
    }
  ];

  questionsState.questions = (questionsState.questions || []).map((question) => {
    if (!questionIds.has(question.question_id)) return question;
    return {
      ...question,
      status: "answered",
      answer_id: batchId,
      answered_at: now
    };
  });

  writeJsonTo(visionRoot, "answers.json", answersState);
  writeJsonTo(visionRoot, "questions.json", questionsState);
  const wizard = syncWizardQuestionGate(questionsState);
  let setupAutopilot = null;
  const setupStats = setupQuestionStats(questionsState);
  if (setupStats.total && setupStats.unresolved === 0) {
    try {
      setupAutopilot = finalizeSetupAutopilot();
    } catch (error) {
      setupAutopilot = { finalized: false, error: String(error.message || error) };
    }
  }
  appendEvent({
    ts: now,
    type: "vision_answers_submitted",
    batch_id: batchId,
    summary: `User submitted ${answers.length} vision answers through the dashboard.`
  });

  return { batch_id: batchId, saved: answers.length, wizard, setup_autopilot: setupAutopilot };
}

function statusForReviewDecision(decision) {
  if (decision === "keep_as_is" || decision === "revise") return "approved_for_adoption";
  if (decision === "reject") return "retired";
  if (decision === "ask_orquesta_for_alternatives") return "needs_curation";
  return "needs_user_review";
}

function saveVisionReview(payload) {
  const userTaskId = String(payload.user_task_id || "").trim();
  const batchId = String(payload.batch_id || "").trim();
  const decision = String(payload.decision || "").trim();
  const note = String(payload.note || "").trim();
  const allowed = new Set(["keep_as_is", "revise", "reject", "ask_orquesta_for_alternatives"]);

  if (!userTaskId || !batchId || !allowed.has(decision)) {
    const error = new Error("Invalid vision review payload");
    error.statusCode = 400;
    throw error;
  }

  const now = new Date().toISOString();
  const answersState = readJsonFrom(visionRoot, "answers.json", { version: 1, answer_batches: [] });
  const userTasksState = readJsonFrom(userTasksRoot, "queue.json", { version: 1, owner_agent_id: "user-support", tasks: [], policy: {} });
  const batch = (answersState.answer_batches || []).find((item) => item.batch_id === batchId);
  const task = (userTasksState.tasks || []).find((item) => item.user_task_id === userTaskId);

  if (!batch) {
    const error = new Error(`Answer batch not found: ${batchId}`);
    error.statusCode = 404;
    throw error;
  }
  if (!task) {
    const error = new Error(`User task not found: ${userTaskId}`);
    error.statusCode = 404;
    throw error;
  }

  batch.interpretation_mode = batch.interpretation_mode || "discussion_seed_not_command";
  batch.status = statusForReviewDecision(decision);
  batch.review_decision = {
    user_task_id: userTaskId,
    decision,
    note,
    decided_at: now,
    source: "dashboard_vision_review"
  };
  batch.review_history = [
    ...(batch.review_history || []),
    batch.review_decision
  ];
  if (decision === "ask_orquesta_for_alternatives") {
    batch.counterproposal_requested = true;
  }
  if (decision === "revise" && note) {
    batch.user_revision_note = note;
  }

  task.status = "resolved";
  task.resolved_at = now;
  task.result = {
    decision,
    batch_id: batchId,
    note
  };

  writeJsonTo(visionRoot, "answers.json", answersState);
  writeJsonTo(userTasksRoot, "queue.json", userTasksState);
  appendEvent({
    timestamp: now,
    type: "vision_review_saved",
    actor: "user",
    user_task_id: userTaskId,
    batch_id: batchId,
    decision,
    summary: `User reviewed ${batchId}: ${decision}.`
  });

  return { saved: true, user_task_id: userTaskId, batch_id: batchId, status: batch.status, decision };
}

function updateReportReviewStateFiles({
  stateRoot: targetStateRoot = stateRoot,
  taskId,
  decision,
  note,
  now,
  reportPath,
  questionCandidateSummary,
  completionEnvelopeSummary
}) {
  let reviewedTask = null;
  let reviewRecord = null;
  const tasksResult = updateJsonAtomic(
    path.join(targetStateRoot, "tasks.json"),
    { version: 1, tasks: [] },
    (tasksState) => {
      tasksState.version = tasksState.version || 1;
      tasksState.tasks = Array.isArray(tasksState.tasks) ? tasksState.tasks : [];
      const task = tasksState.tasks.find((item) => item.task_id === taskId);
      if (!task) {
        const error = new Error(`Task not found: ${taskId}`);
        error.statusCode = 404;
        throw error;
      }

      const currentReportPath = reportPathForTask(task);
      if (currentReportPath !== reportPath) {
        const error = new Error(`Task report changed during review: ${taskId}`);
        error.statusCode = 409;
        throw error;
      }

      const previousState = task.state || "unknown";
      reviewRecord = {
        decision,
        note,
        reviewed_at: now,
        reviewed_by: "orchestrator",
        report: reportPath,
        previous_state: previousState,
        question_candidates: questionCandidateSummary
      };

      task.report_review = reviewRecord;
      task.review_history = [...(task.review_history || []), reviewRecord];
      task.report = reportPath;
      task.artifacts = addUnique(task.artifacts, reportPath);

      if (decision === "accept") {
        task.state = "accepted";
        task.completed_at = task.completed_at || now;
        task.accepted_at = now;
        if (completionEnvelopeSummary) {
          task.control_rollout = "beta_v3";
          task.completion_envelope = completionEnvelopeSummary;
          reviewRecord.completion_envelope = completionEnvelopeSummary;
        }
        if (note) task.result_summary = note;
      } else if (decision === "request_changes") {
        task.state = "needs_revision";
        task.blocked_by = [];
        task.revision_requested_at = now;
        if (note) task.result_summary = `Revision requested: ${note}`;
      } else {
        task.state = "needs_orchestrator_review";
        task.review_held_at = now;
        if (note) task.result_summary = `Review held: ${note}`;
      }

      tasksState.updated_at = now;
      reviewedTask = { ...task };
      return tasksState;
    }
  );

  let reviewedAgent = null;
  const agentsResult = updateJsonAtomic(
    path.join(targetStateRoot, "agents.json"),
    { version: 1, agents: [] },
    (agentsState) => {
      agentsState.version = agentsState.version || 1;
      agentsState.agents = Array.isArray(agentsState.agents) ? agentsState.agents : [];
      const agent = agentsState.agents.find((item) => item.agent_id === reviewedTask.owner_agent_id);
      if (agent) {
        if (decision === "accept") {
          agent.status = "standby";
          if (agent.current_task === taskId) agent.current_task = null;
          agent.last_report_at = now;
          agent.artifacts = addUnique(agent.artifacts, reportPath);
        } else if (decision === "request_changes") {
          agent.status = "active";
          agent.current_task = taskId;
        }
        reviewedAgent = { ...agent };
      }
      agentsState.updated_at = now;
      return agentsState;
    }
  );

  return {
    task: reviewedTask,
    agent: reviewedAgent,
    reviewRecord,
    locks: {
      tasks: tasksResult.lock,
      agents: agentsResult.lock
    }
  };
}

function reconcileCapacityReportProduced({
  stateRoot: targetStateRoot = stateRoot,
  taskId,
  agentId,
  reportPath,
  now
}) {
  const capacityPath = path.join(targetStateRoot, "capacity.json");
  if (!fs.existsSync(capacityPath)) return null;
  let reconciled = null;
  const result = updateJsonAtomic(capacityPath, createEmptyCapacityLedger(), (capacity) => {
    capacity.dispatches = Array.isArray(capacity.dispatches) ? capacity.dispatches : [];
    const matches = capacity.dispatches
      .filter((dispatch) => dispatch.task_id === taskId && (!agentId || dispatch.agent_id === agentId))
      .sort((left, right) => Date.parse(left.queued_at || 0) - Date.parse(right.queued_at || 0));
    const dispatch = matches[matches.length - 1];
    if (!dispatch) return capacity;
    dispatch.state = "report_produced";
    dispatch.report_produced_at = now;
    dispatch.report_path = reportPath;
    capacity.updated_at = now;

    const orchestra = capacity.orchestra;
    if (orchestra && Array.isArray(orchestra.affected_task_ids) && orchestra.affected_task_ids.includes(taskId)) {
      orchestra.affected_task_ids = orchestra.affected_task_ids.filter((id) => id !== taskId);
      const onlyUnconfirmedStart = (orchestra.reason_codes || []).every((code) => code === "required_specialist_turn_start_unconfirmed");
      if (orchestra.affected_task_ids.length === 0 && onlyUnconfirmedStart) {
        orchestra.mode = "normal";
        orchestra.reason_codes = [];
        orchestra.changed_at = now;
        orchestra.notification_key = null;
      }
    }
    reconciled = { ...dispatch };
    return capacity;
  });
  return { dispatch: reconciled, lock: result.lock };
}

function reviewSpecialistReport(payload) {
  const taskId = String(payload.task_id || "").trim();
  const decision = String(payload.decision || "").trim();
  const note = String(payload.note || "").trim();
  const allowed = new Set(["accept", "request_changes", "hold"]);

  if (!taskId || !allowed.has(decision)) {
    const error = new Error("Invalid report review payload");
    error.statusCode = 400;
    throw error;
  }

  const now = new Date().toISOString();
  const taskSnapshotState = readJson("tasks.json");
  const taskSnapshot = (taskSnapshotState.tasks || []).find((item) => item.task_id === taskId);
  if (!taskSnapshot) {
    const error = new Error(`Task not found: ${taskId}`);
    error.statusCode = 404;
    throw error;
  }

  const reportPath = reportPathForTask(taskSnapshot);
  if (!reportPath) {
    const error = new Error(`Task has no .orquesta/reports/*.md artifact: ${taskId}`);
    error.statusCode = 409;
    throw error;
  }

  const reportAbsolutePath = safeReportAbsolutePath(reportPath);
  const questionCandidateCheck = inspectReportQuestionCandidates(reportAbsolutePath || reportPath);
  if (decision === "accept" && questionCandidateCheck.errors.length) {
    const error = new Error(`Report is missing valid question_candidates metadata: ${questionCandidateCheck.errors.join("; ")}`);
    error.statusCode = 409;
    throw error;
  }

  let controlReview = {
    status: "not_required",
    blockers: [],
    warnings: []
  };
  if (decision === "accept") {
    controlReview = reviewTaskControl({
      root,
      task: taskSnapshot,
      reportPath,
      now
    });
    if (controlReview.blockers.length) {
      appendEvent({
        timestamp: now,
        type: "control_review_blocked",
        actor: "orchestrator",
        task_id: taskId,
        agent_id: taskSnapshot.owner_agent_id || null,
        report: reportPath,
        finding_codes: controlReview.blockers.map((finding) => finding.code),
        summary: `Blocked specialist report acceptance for ${taskId}: ${controlReview.blockers.map((finding) => finding.code).join(", ")}.`
      });
      const error = new Error(`Control review blocked acceptance: ${controlReview.blockers.map((finding) => finding.message).join("; ")}`);
      error.statusCode = 409;
      error.controlReview = controlReview;
      throw error;
    }
  }

  let recordedQuestionCandidates = { recorded: 0, skipped: 0, candidates: [] };
  if (decision === "accept" && questionCandidateCheck.status === "submitted") {
    recordedQuestionCandidates = appendSubmittedQuestionCandidates(root, questionCandidateCheck.metadata, now);
  }

  if (decision === "accept" && controlReview.completion?.present) {
    reconcileCapacityReportProduced({
      stateRoot,
      taskId,
      agentId: taskSnapshot.owner_agent_id || null,
      reportPath,
      now
    });
  }

  const questionCandidateSummary = {
      present: questionCandidateCheck.present,
      status: questionCandidateCheck.status,
      item_count: questionCandidateCheck.itemCount,
      recorded_count: recordedQuestionCandidates.recorded,
      skipped_duplicate_count: recordedQuestionCandidates.skipped,
      errors: questionCandidateCheck.errors,
      warnings: questionCandidateCheck.warnings
  };
  const stateUpdate = updateReportReviewStateFiles({
    stateRoot,
    taskId,
    decision,
    note,
    now,
    reportPath,
    questionCandidateSummary,
    completionEnvelopeSummary: decision === "accept" && controlReview.completion?.present
      ? {
        status: "accepted",
        path: reportPath,
        validated_at: now
      }
      : null
  });
  const task = stateUpdate.task;
  const reviewRecord = stateUpdate.reviewRecord;

  const productionStartPath = path.join(setupRoot, "production_start.json");
  let productionStart = defaultProductionStart();
  if (fs.existsSync(productionStartPath)) {
    updateJsonAtomic(productionStartPath, defaultProductionStart(), (current) => {
      productionStart = current;
      const activationRequest = (current.activation_requests || []).find((request) => request.task_id === taskId);
      if (!activationRequest) return current;
      activationRequest.status = decision === "accept" ? "accepted" : decision === "request_changes" ? "changes_requested" : "needs_orchestrator_review";
      activationRequest.reviewed_at = now;
      activationRequest.report = reportPath;
      if (decision === "accept") activationRequest.accepted_at = now;
      if (decision === "request_changes") activationRequest.revision_requested_at = now;
      current.updated_at = now;
      current.status = decision === "accept"
        ? "handoff_accepted"
        : decision === "request_changes"
          ? "handoff_changes_requested"
          : "handoff_review_held";
      return current;
    });
  }

  const specialistPlanPath = path.join(setupRoot, "specialist_plan.json");
  let specialistPlan = defaultSpecialistPlan();
  if (fs.existsSync(specialistPlanPath)) {
    updateJsonAtomic(specialistPlanPath, defaultSpecialistPlan(), (current) => {
      specialistPlan = current;
      const candidate = (current.candidates || []).find((item) => item.candidate_id === task.source_candidate_id);
      if (!candidate) return current;
      candidate.activation_status = decision === "accept" ? "accepted" : decision === "request_changes" ? "changes_requested" : "needs_orchestrator_review";
      candidate.activation_report = reportPath;
      candidate.activation_reviewed_at = now;
      if (decision === "accept") candidate.activation_accepted_at = now;
      current.updated_at = now;
      current.status = decision === "accept"
        ? "production_handoff_accepted"
        : decision === "request_changes"
          ? "production_handoff_changes_requested"
          : "production_handoff_review_held";
      return current;
    });
  }

  appendEvent({
    timestamp: now,
    type: decision === "accept" ? "specialist_report_accepted" : decision === "request_changes" ? "specialist_report_changes_requested" : "specialist_report_review_held",
    actor: "orchestrator",
    task_id: taskId,
    agent_id: task.owner_agent_id || null,
    report: reportPath,
    summary: decision === "accept"
      ? `Accepted specialist report for ${taskId}.`
      : decision === "request_changes"
        ? `Requested changes for specialist report ${taskId}.`
        : `Held specialist report ${taskId} for further orchestrator review.`
  });

  if (decision === "accept" && questionCandidateCheck.status === "submitted") {
    appendEvent({
      timestamp: now,
      type: "question_candidates_recorded",
      actor: "orchestrator",
      task_id: taskId,
      agent_id: task.owner_agent_id || null,
      report: reportPath,
      summary: `Recorded ${recordedQuestionCandidates.recorded} question candidates from ${taskId}; skipped ${recordedQuestionCandidates.skipped} duplicates.`
    });
  }

  if (decision === "accept") {
    appendEvent({
      timestamp: now,
      type: "control_review_passed",
      actor: "orchestrator",
      task_id: taskId,
      agent_id: task.owner_agent_id || null,
      report: reportPath,
      warning_codes: controlReview.warnings.map((finding) => finding.code),
      summary: `Control review passed for specialist report ${taskId}.`
    });
  }

  return {
    saved: true,
    task_id: taskId,
    decision,
    state: task.state,
    report: reportPath,
    question_candidates: reviewRecord.question_candidates,
    task,
    productionStart,
    specialistPlan,
    control_review: {
      status: controlReview.status,
      blockers: controlReview.blockers,
      warnings: controlReview.warnings
    }
  };
}

function saveSetupProjectIntake(payload) {
  const now = new Date().toISOString();
  const intake = buildProjectIntake(payload, now, "dashboard_setup_wizard");
  intake.notes = Array.isArray(payload.notes) ? payload.notes : [];

  let wizard = readJsonFrom(setupRoot, "wizard.json", defaultSetupWizard());
  const stepOrder = ["welcome", "project_intake", "question_gate", "completion_map_review", "specialist_planning", "production_start"];
  const currentIndex = stepOrder.indexOf(wizard.current_step || "welcome");
  const questionGateIndex = stepOrder.indexOf("question_gate");
  const shouldAdvanceToQuestionGate = currentIndex === -1 || currentIndex < questionGateIndex;
  wizard.status = "in_progress";
  wizard.current_step = shouldAdvanceToQuestionGate ? "question_gate" : wizard.current_step;
  wizard.updated_at = now;
  wizard = updateSetupStep(wizard, "welcome", "done");
  wizard = updateSetupStep(wizard, "project_intake", "done");
  if (shouldAdvanceToQuestionGate) {
    wizard = updateSetupStep(wizard, "question_gate", "active");
  }
  wizard.gates = {
    ...(wizard.gates || {}),
    project_intake_required: true
  };

  writeJsonTo(setupRoot, "project_intake.json", intake);
  writeJsonTo(setupRoot, "wizard.json", wizard);
  appendEvent({
    timestamp: now,
    type: "setup_project_intake_saved",
    actor: "user",
    summary: "User saved the Orquesta setup project intake through the dashboard."
  });

  return { saved: true, wizard, projectIntake: intake };
}

function generateSetupQuestions() {
  const intake = readJsonFrom(setupRoot, "project_intake.json", { status: "empty" });
  if (intake.status !== "submitted") {
    const error = new Error("Project intake is required before generating questions");
    error.statusCode = 400;
    throw error;
  }

  const now = new Date().toISOString();
  const questionsState = readJsonFrom(visionRoot, "questions.json", { version: 1, questions: [], curation_policy: {} });
  const existingSetupQuestions = (questionsState.questions || []).filter((question) => question.required_for_setup);
  if (existingSetupQuestions.some((question) => ["ready", "answered"].includes(String(question.status || "")))) {
    const wizard = syncWizardQuestionGate(questionsState);
    return { generated: 0, reused: existingSetupQuestions.length, wizard };
  }

  const idFor = nextQuestionIdFactory(questionsState.questions || []);
  const setupQuestions = buildOptionalSetupQuestions(intake, now).map((question, index) => ({
    ...question,
    question_id: idFor(index + 1),
    task_id: "SETUP-QUESTION-GATE",
    priority: "normal",
    options: [],
    answer_format: "free_text",
    curated_by: "user-support"
  }));

  questionsState.version = questionsState.version || 1;
  questionsState.questions = [
    ...(questionsState.questions || []),
    ...setupQuestions
  ];
  questionsState.curation_policy = {
    ...(questionsState.curation_policy || {}),
    curator_agent_id: "user-support",
    wake_triggers: [
      ...new Set([
        ...((questionsState.curation_policy || {}).wake_triggers || []),
        "project_kickoff",
        "required_setup_questions_ready"
      ])
    ],
    setup_required_question_ids: setupQuestions.map((question) => question.question_id)
  };

  writeJsonTo(visionRoot, "questions.json", questionsState);
  const wizard = syncWizardQuestionGate(questionsState);
  appendEvent({
    timestamp: now,
    type: "setup_questions_generated",
    actor: "user-support",
    summary: `Generated ${setupQuestions.length} optional setup questions from project intake.`
  });

  return { generated: setupQuestions.length, question_ids: setupQuestions.map((question) => question.question_id), wizard };
}

function approveCompletionMap() {
  const now = new Date().toISOString();
  const questionsState = readJsonFrom(visionRoot, "questions.json", { version: 1, questions: [], curation_policy: {} });
  const stats = setupQuestionStats(questionsState);
  if (stats.total && stats.unresolved) {
    const error = new Error(`Required setup questions are still unanswered: ${stats.unresolved}`);
    error.statusCode = 409;
    throw error;
  }

  let wizard = readJsonFrom(setupRoot, "wizard.json", defaultSetupWizard());
  wizard.status = "in_progress";
  wizard.current_step = "specialist_planning";
  wizard.updated_at = now;
  wizard = updateSetupStep(wizard, "welcome", "done");
  wizard = updateSetupStep(wizard, "project_intake", "done");
  wizard = updateSetupStep(wizard, "question_gate", "done");
  wizard = updateSetupStep(wizard, "completion_map_review", "done");
  wizard = updateSetupStep(wizard, "specialist_planning", "active");
  wizard.gates = {
    ...(wizard.gates || {}),
    completion_map_requires_user_approval: true,
    completion_map_approved: true,
    completion_map_approved_at: now
  };

  writeJsonTo(setupRoot, "wizard.json", wizard);
  appendEvent({
    timestamp: now,
    type: "setup_completion_map_approved",
    actor: "user",
    summary: "User approved the Completion Map through the setup wizard."
  });

  return { approved: true, wizard };
}

function generateSpecialistPlan() {
  const now = new Date().toISOString();
  const wizard = readJsonFrom(setupRoot, "wizard.json", defaultSetupWizard());
  if (!wizard.gates?.completion_map_approved && !wizard.gates?.setup_autopilot_finalized) {
    const error = new Error("Completion Map approval or setup autopilot finalization is required before specialist planning");
    error.statusCode = 409;
    throw error;
  }

  const intake = readJsonFrom(setupRoot, "project_intake.json", { status: "empty" });
  const completionMap = normalizeCompletionMapForSetup(
    readJsonFrom(projectRoot, "completion_map.json", {}),
    intake,
    now
  );
  const understanding = buildProjectUnderstanding(intake, completionMap);
  const foundation = ensureFoundationOrganization(now);
  const existingPlan = readJsonFrom(setupRoot, "specialist_plan.json", defaultSpecialistPlan());
  if (existingPlan.schema_version === 2
    && existingPlan.source_completion_map_revision === completionMap.revision
    && existingPlan.first_executable_batch?.length) {
    return { reused: true, plan: existingPlan };
  }
  const plan = createAdaptiveSpecialistPlan({
    project_understanding: understanding,
    completion_map: completionMap,
    role_definitions: setupRoleDefinitions(foundation, completionMap),
    approval_source: "setup_confirmation"
  });
  if (plan.status === "blocked_unknown") {
    writeJsonTo(setupRoot, "setup_blocked.json", { ...plan, updated_at: now });
    const error = new Error(plan.user_capability?.reason || "Initial specialist planning requires clarification");
    error.statusCode = 409;
    throw error;
  }
  writeJsonTo(projectRoot, "project_understanding.json", understanding);
  writeJsonTo(projectRoot, "completion_map.json", completionMap);
  writeJsonTo(setupRoot, "specialist_plan.json", plan);
  const setupState = createSetupStateBundle({
    projectId: understanding.project_id,
    projectUnderstanding: understanding,
    specialistPlan: plan,
    now
  });
  writeJsonTo(setupRoot, "setup_state.json", {
    ...setupState,
    status: "running",
    current_phase: "specialists",
    updated_at: now
  });
  appendEvent({
    timestamp: now,
    type: "setup_specialist_plan_generated",
    actor: "orchestrator",
    summary: `Generated ${plan.selected_specialists.length} specialist groups from ${plan.first_executable_batch.length} executable work items.`
  });

  return { generated: plan.selected_specialists.length, plan };
}

function finalizeSetupAutopilot() {
  const now = new Date().toISOString();
  const intake = readJsonFrom(setupRoot, "project_intake.json", { status: "empty" });
  if (intake.status !== "submitted" || !String(intake.project_description || "").trim()) {
    const error = new Error("Project intake is required before setup autopilot can finalize");
    error.statusCode = 409;
    throw error;
  }

  const questionsState = readJsonFrom(visionRoot, "questions.json", { version: 1, questions: [], curation_policy: {} });
  const optionalQuestions = (questionsState.questions || []).filter((question) => question.setup_gate);
  const { map, created: completionMapCreated } = ensureAutopilotCompletionMap(intake, now);
  let wizard = readJsonFrom(setupRoot, "wizard.json", defaultSetupWizard());
  wizard.status = "in_progress";
  wizard.current_step = "auto_finalize";
  wizard.updated_at = now;
  wizard = updateSetupStep(wizard, "welcome", "done");
  wizard = updateSetupStep(wizard, "project_intake", "done");
  wizard = updateSetupStep(wizard, "question_gate", "done");
  wizard = updateSetupStep(wizard, "auto_finalize", "active");
  wizard = updateSetupStep(wizard, "operation_ready", "queued");
  wizard.gates = {
    ...(wizard.gates || {}),
    required_questions_must_be_answered: false,
    optional_setup_questions_total: optionalQuestions.length,
    optional_setup_questions_unanswered: optionalQuestions.filter((question) => question.status === "ready").length,
    completion_map_requires_user_approval: false,
    completion_map_approved: true,
    completion_map_approved_at: wizard.gates?.completion_map_approved_at || now,
    setup_autopilot_enabled: true,
    setup_autopilot_finalized: true,
    setup_autopilot_finalized_at: now
  };
  writeJsonTo(setupRoot, "wizard.json", wizard);
  const specialistResult = generateSpecialistPlan();
  const plan = specialistResult.plan;
  const understanding = readJsonFrom(projectRoot, "project_understanding.json", buildProjectUnderstanding(intake, map));
  const provisioning = prepareSetupProvisioning({ plan, understanding, completionMap: map, now });
  const setupState = readJsonFrom(setupRoot, "setup_state.json", {});
  writeJsonTo(setupRoot, "setup_state.json", {
    ...setupState,
    status: "running",
    current_phase: "specialists",
    provisioning_batch_id: provisioning.batch.provisioning_batch_id,
    updated_at: now
  });
  wizard = readJsonFrom(setupRoot, "wizard.json", wizard);
  wizard.status = "provisioning";
  wizard.current_step = "auto_finalize";
  wizard.updated_at = now;
  wizard = updateSetupStep(wizard, "auto_finalize", "active");
  wizard = updateSetupStep(wizard, "operation_ready", "queued");
  wizard.gates = {
    ...(wizard.gates || {}),
    specialist_plan_reviewed: true,
    specialist_plan_approved: true,
    production_tasks_prepared: true,
    provisioning_batch_id: provisioning.batch.provisioning_batch_id
  };
  writeJsonTo(setupRoot, "wizard.json", wizard);

  appendEvent({
    timestamp: now,
    type: "setup_autopilot_finalized",
    actor: "orchestrator",
    summary: `Setup created ${provisioning.batch.requests.length} specialist provisioning requests from ${plan.first_executable_batch.length} executable work items.`
  });

  return {
    finalized: true,
    completion_map_created: completionMapCreated,
    completion_map_title: map.project_title || null,
    specialist_groups: plan.selected_specialists.length,
    provisioning_requests: provisioning.batch.requests.length,
    provisioning_batch_id: provisioning.batch.provisioning_batch_id,
    wizard,
    plan,
    provisioning: provisioning.batch
  };
}

function reviewSpecialistPlan(payload) {
  const now = new Date().toISOString();
  const currentPlan = readJsonFrom(setupRoot, "specialist_plan.json", defaultSpecialistPlan());
  if (currentPlan.schema_version === 2) {
    return {
      saved: true,
      reviewed: 0,
      approved: currentPlan.selected_specialists.length,
      approval_state: "not_required",
      reason: "The setup confirmation approves the initial roster; only a later new line requires separate user approval.",
      plan: currentPlan,
      wizard: readJsonFrom(setupRoot, "wizard.json", defaultSetupWizard())
    };
  }
  const submitted = Array.isArray(payload.decisions) ? payload.decisions : [];
  const allowed = new Set(["approve_now", "later", "reject", "revise"]);
  const decisions = submitted
    .map((item) => ({
      candidate_id: String(item.candidate_id || "").trim(),
      decision: String(item.decision || "").trim(),
      note: String(item.note || "").trim()
    }))
    .filter((item) => item.candidate_id && allowed.has(item.decision));

  if (!decisions.length) {
    const error = new Error("No valid specialist plan decisions submitted");
    error.statusCode = 400;
    throw error;
  }

  const plan = readJsonFrom(setupRoot, "specialist_plan.json", defaultSpecialistPlan());
  const candidates = plan.candidates || [];
  const byId = new Map(candidates.map((candidate) => [candidate.candidate_id, candidate]));

  for (const decision of decisions) {
    const candidate = byId.get(decision.candidate_id);
    if (!candidate) {
      const error = new Error(`Unknown specialist candidate: ${decision.candidate_id}`);
      error.statusCode = 404;
      throw error;
    }
    candidate.status = decision.decision === "approve_now" ? "approved" : decision.decision;
    candidate.user_decision = decision.decision;
    candidate.user_note = decision.note;
    candidate.decided_at = now;
  }

  const reviewed = candidates.filter((candidate) => candidate.user_decision).length;
  const approved = candidates.filter((candidate) => candidate.user_decision === "approve_now").length;
  plan.status = approved ? "reviewed_with_approvals" : reviewed ? "reviewed_without_approvals" : "proposal_ready";
  plan.updated_at = now;
  plan.reviewed_at = now;
  plan.approved_candidate_ids = candidates
    .filter((candidate) => candidate.user_decision === "approve_now")
    .map((candidate) => candidate.candidate_id);

  writeJsonTo(setupRoot, "specialist_plan.json", plan);
  let wizard = readJsonFrom(setupRoot, "wizard.json", defaultSetupWizard());
  wizard.status = approved ? "ready_for_production" : "in_progress";
  wizard.current_step = approved ? "production_start" : "specialist_planning";
  wizard.updated_at = now;
  wizard = updateSetupStep(wizard, "specialist_planning", reviewed ? "done" : "active");
  wizard = updateSetupStep(wizard, "production_start", approved ? "active" : "queued");
  wizard.gates = {
    ...(wizard.gates || {}),
    specialist_plan_reviewed: reviewed > 0,
    specialist_plan_approved: approved > 0,
    approved_specialist_candidate_ids: plan.approved_candidate_ids
  };
  writeJsonTo(setupRoot, "wizard.json", wizard);
  appendEvent({
    timestamp: now,
    type: "setup_specialist_plan_reviewed",
    actor: "user",
    summary: `User reviewed ${decisions.length} specialist candidates; ${approved} approved for later activation.`
  });

  return { saved: true, reviewed: decisions.length, approved, plan, wizard };
}

function startProduction(payload) {
  const now = new Date().toISOString();
  const plan = readJsonFrom(setupRoot, "specialist_plan.json", defaultSpecialistPlan());
  if (plan.schema_version === 2) {
    const intake = readJsonFrom(setupRoot, "project_intake.json", { status: "empty" });
    const completionMap = normalizeCompletionMapForSetup(
      readJsonFrom(projectRoot, "completion_map.json", {}),
      intake,
      now
    );
    const understanding = readJsonFrom(
      projectRoot,
      "project_understanding.json",
      buildProjectUnderstanding(intake, completionMap)
    );
    const provisioning = prepareSetupProvisioning({
      plan,
      understanding,
      completionMap,
      now,
      retryFailed: payload.retry_failed === true
    });
    const productionStart = {
      version: 2,
      status: "provisioning",
      updated_at: now,
      provisioning_batch_id: provisioning.batch.provisioning_batch_id,
      task_ids: provisioning.batch.requests.map((request) => request.task_id),
      agent_ids: provisioning.batch.requests.map((request) => request.agent_id),
      policy: {
        desktop_codex_provisioning_required: true,
        max_concurrent_provisioning: 3,
        new_line_requires_user_approval: true,
        other_organization_changes_require_user_approval: false
      }
    };
    writeJsonTo(setupRoot, "production_start.json", productionStart);
    let wizard = readJsonFrom(setupRoot, "wizard.json", defaultSetupWizard());
    wizard.status = "provisioning";
    wizard.current_step = "auto_finalize";
    wizard.updated_at = now;
    wizard.gates = {
      ...(wizard.gates || {}),
      production_start_ready: true,
      production_tasks_prepared: true,
      provisioning_batch_id: provisioning.batch.provisioning_batch_id
    };
    writeJsonTo(setupRoot, "wizard.json", wizard);
    appendEvent({
      timestamp: now,
      type: "setup_provisioning_batch_ready",
      actor: "orchestrator",
      summary: `Prepared ${provisioning.batch.requests.length} Desktop Codex provisioning requests.`
    });
    return {
      saved: true,
      prepared: provisioning.batch.requests.length,
      task_ids: productionStart.task_ids,
      productionStart,
      provisioning: provisioning.batch,
      plan,
      wizard
    };
  }
  const approvedCandidates = (plan.candidates || []).filter((candidate) => candidate.user_decision === "approve_now");
  if (!approvedCandidates.length) {
    const error = new Error("No approved specialist candidates are available for production start");
    error.statusCode = 409;
    throw error;
  }

  const requestedIds = Array.isArray(payload.candidate_ids)
    ? payload.candidate_ids.map((id) => String(id || "").trim()).filter(Boolean)
    : [];
  const selectedIds = requestedIds.length
    ? requestedIds
    : approvedCandidates
      .filter((candidate) => candidate.priority === "high")
      .slice(0, 2)
      .map((candidate) => candidate.candidate_id);
  const approvedById = new Map(approvedCandidates.map((candidate) => [candidate.candidate_id, candidate]));
  const unknown = selectedIds.filter((candidateId) => !approvedById.has(candidateId));
  if (unknown.length) {
    const error = new Error(`Unknown or unapproved specialist candidate: ${unknown.join(", ")}`);
    error.statusCode = 404;
    throw error;
  }
  if (!selectedIds.length) {
    const error = new Error("At least one specialist candidate must be selected");
    error.statusCode = 400;
    throw error;
  }

  const tasksState = readJson("tasks.json");
  tasksState.version = tasksState.version || 1;
  tasksState.tasks = tasksState.tasks || [];
  const nextTaskId = nextProductionTaskIdFactory(tasksState.tasks);
  const existingByCandidate = new Map(
    tasksState.tasks
      .filter((task) => task.source === "production_start" && task.source_candidate_id)
      .map((task) => [task.source_candidate_id, task])
  );
  const createdTasks = [];

  selectedIds.forEach((candidateId, index) => {
    const candidate = approvedById.get(candidateId);
    const existingTask = existingByCandidate.get(candidateId);
    if (existingTask) {
      createdTasks.push(existingTask);
      return;
    }

    const task = {
      task_id: nextTaskId(index + 1),
      title: `Production handoff: ${candidate.display_name || candidate.agent_id}`,
      state: "queued",
      owner_agent_id: candidate.agent_id,
      created_at: now,
      dependencies: ["T060"],
      parallel_eligible: true,
      effort: candidate.priority === "high" ? "focused" : "quick",
      blocked_by: [],
      source: "production_start",
      source_candidate_id: candidate.candidate_id,
      acceptance_checks: [
        "orchestrator sends a narrow handoff to the existing specialist thread",
        "specialist reads only the required reading listed in specialist_plan.json",
        "specialist writes a short report or completion signal before the task is accepted",
        "dashboard state is updated after the specialist reports back"
      ],
      artifacts: [
        ".orquesta/setup/specialist_plan.json",
        ".orquesta/setup/production_start.json"
      ],
      result_summary: "Prepared for orchestrator handoff. No specialist thread was messaged or created by the dashboard action."
    };
    tasksState.tasks.push(task);
    createdTasks.push(task);
  });
  tasksState.updated_at = now;
  writeJsonTo(stateRoot, "tasks.json", tasksState);

  const activationRequests = selectedIds.map((candidateId) => {
    const candidate = approvedById.get(candidateId);
    const task = createdTasks.find((item) => item.source_candidate_id === candidateId);
    return {
      candidate_id: candidate.candidate_id,
      agent_id: candidate.agent_id,
      display_name: candidate.display_name || candidate.agent_id,
      task_id: task?.task_id || null,
      status: "handoff_ready",
      requested_at: now,
      note: String(payload.note || "Prepared from the production start dashboard gate.").trim(),
      thread_id: candidate.thread_id || null
    };
  });

  for (const request of activationRequests) {
    const candidate = approvedById.get(request.candidate_id);
    candidate.activation_status = "handoff_ready";
    candidate.activation_task_id = request.task_id;
    candidate.activation_requested_at = now;
  }
  plan.status = "production_handoff_ready";
  plan.updated_at = now;
  plan.production_start_task_ids = activationRequests.map((request) => request.task_id).filter(Boolean);
  writeJsonTo(setupRoot, "specialist_plan.json", plan);

  const productionStart = {
    version: 1,
    status: "handoff_ready",
    updated_at: now,
    selected_candidate_ids: selectedIds,
    activation_requests: activationRequests,
    policy: {
      create_sessions_on_start: false,
      requires_thread_handoff: true
    },
    notes: [
      "The dashboard prepared handoff tasks only. It did not create sessions or send messages to specialist threads.",
      "The orchestrator must perform the actual thread handoff before marking these tasks active."
    ]
  };
  writeJsonTo(setupRoot, "production_start.json", productionStart);

  let wizard = readJsonFrom(setupRoot, "wizard.json", defaultSetupWizard());
  wizard.status = "production_handoff_ready";
  wizard.current_step = "production_start";
  wizard.updated_at = now;
  wizard = updateSetupStep(wizard, "production_start", "active");
  wizard.gates = {
    ...(wizard.gates || {}),
    production_start_ready: true,
    production_tasks_prepared: true,
    production_task_ids: productionStart.activation_requests.map((request) => request.task_id).filter(Boolean)
  };
  writeJsonTo(setupRoot, "wizard.json", wizard);

  appendEvent({
    timestamp: now,
    type: "setup_production_start_prepared",
    actor: "orchestrator",
    summary: `Prepared ${activationRequests.length} production handoff tasks without creating or messaging sessions.`
  });

  return {
    saved: true,
    prepared: activationRequests.length,
    task_ids: productionStart.activation_requests.map((request) => request.task_id).filter(Boolean),
    productionStart,
    plan,
    wizard
  };
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = path.resolve(dashboardRoot, `.${requested}`);

  if (!filePath.startsWith(dashboardRoot)) {
    send(res, 403, "Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      send(res, 404, "Not found");
      return;
    }
    send(res, 200, data, mimeTypes[path.extname(filePath)] || "application/octet-stream");
  });
}

const server = http.createServer(async (req, res) => {
  if (req.url.startsWith("/api/state")) {
    try {
      const etag = buildDashboardStateEtag(root);
      if (req.headers["if-none-match"] === etag) {
        sendNotModified(res, etag);
        return;
      }
      const encodingWarnings = refreshEncodingWarnings();
      const agents = readJson("agents.json").agents || [];
      const tasks = readJson("tasks.json").tasks || [];
      const specialistPlan = readJsonFrom(setupRoot, "specialist_plan.json", defaultSpecialistPlan());
      const productionStart = readJsonFrom(setupRoot, "production_start.json", defaultProductionStart());
      sendJsonWithHeaders(res, 200, {
        agents,
        sessions: readJson("sessions.json").sessions || [],
        tasks,
        modelPolicy: readModelPolicyState(),
        capacity: readJsonFrom(stateRoot, "capacity.json", createEmptyCapacityLedger()),
        controlAudit: readJson("control_audit.json"),
        dashboardActions: readJson("dashboard_actions.json"),
        triggerAudit: readJson("trigger_audit.json"),
        directives: readJson("directives.json").directives || [],
        events: readJsonl("events.jsonl"),
        reportReviews: buildReportReviews(tasks, agents),
        handoffDrafts: buildHandoffDrafts(tasks, agents, specialistPlan, productionStart),
        vision: {
          questionCandidates: readJsonFrom(visionRoot, "question_candidates.json", { version: 1, candidates: [], policy: {} }),
          questions: readJsonFrom(visionRoot, "questions.json", { questions: [], curation_policy: {} }),
          answers: readJsonFrom(visionRoot, "answers.json", { answer_batches: [] })
        },
        failures: {
          incidents: readJsonFrom(failuresRoot, "incidents.json", { incidents: [], wake_policy: {} }),
          userActions: readJsonFrom(failuresRoot, "user_actions.json", { actions: [] }),
          incidentCandidates: readJsonFrom(failuresRoot, "incident_candidates.json", { candidates: [] }),
          incidentClusters: readJsonFrom(failuresRoot, "incident_clusters.json", { clusters: [] })
        },
        userTasks: readJsonFrom(userTasksRoot, "queue.json", { tasks: [], policy: {} }),
        setup: {
          options: readJsonFrom(setupRoot, "options.json", { available_packs: [], enabled_packs: [] }),
          wizard: readJsonFrom(setupRoot, "wizard.json", defaultSetupWizard()),
          projectIntake: readJsonFrom(setupRoot, "project_intake.json", { status: "empty" }),
          specialistPlan,
          productionStart
        },
        completionMap: readJsonFrom(projectRoot, "completion_map.json", { phases: [], revision_policy: {} }),
        health: {
          encodingWarnings: encodingWarnings.map((warning) => ({
            file: path.relative(root, warning.file).replace(/\\/g, "/"),
            kind: warning.kind,
            detail: warning.detail,
            sample: warning.sample
          }))
        },
        loadedFiles: ["agents.json", "sessions.json", "tasks.json", "model_policy.json", "capacity.json", "control_audit.json", "dashboard_actions.json", "trigger_audit.json", "directives.json", "events.jsonl", "question_candidates.json", "questions.json", "answers.json", "incidents.json", "user_actions.json", "incident_candidates.json", "incident_clusters.json", "queue.json", "options.json", "wizard.json", "project_intake.json", "specialist_plan.json", "production_start.json", "completion_map.json"],
        loadedAt: new Date().toISOString(),
        source: "server"
      }, { etag });
    } catch (error) {
      sendJson(res, 500, { error: String(error.message || error) });
    }
    return;
  }

  if (req.url.startsWith("/api/answers") && req.method === "POST") {
    try {
      const payload = await readRequestJson(req);
      sendJson(res, 200, saveVisionAnswers(payload));
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: String(error.message || error) });
    }
    return;
  }

  if (req.url.startsWith("/api/vision-review") && req.method === "POST") {
    try {
      const payload = await readRequestJson(req);
      sendJson(res, 200, saveVisionReview(payload));
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: String(error.message || error) });
    }
    return;
  }

  if (req.url.startsWith("/api/reports/review") && req.method === "POST") {
    try {
      const payload = await readRequestJson(req);
      sendJson(res, 200, reviewSpecialistReport(payload));
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: String(error.message || error) });
    }
    return;
  }

  if (req.url.startsWith("/api/setup/project-intake") && req.method === "POST") {
    try {
      const payload = await readRequestJson(req);
      sendJson(res, 200, saveSetupProjectIntake(payload));
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: String(error.message || error) });
    }
    return;
  }

  if (req.url.startsWith("/api/setup/generate-questions") && req.method === "POST") {
    try {
      sendJson(res, 200, generateSetupQuestions());
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: String(error.message || error) });
    }
    return;
  }

  if (req.url.startsWith("/api/setup/auto-finalize") && req.method === "POST") {
    try {
      sendJson(res, 200, finalizeSetupAutopilot());
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: String(error.message || error) });
    }
    return;
  }

  if (req.url.startsWith("/api/setup/approve-completion-map") && req.method === "POST") {
    try {
      sendJson(res, 200, approveCompletionMap());
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: String(error.message || error) });
    }
    return;
  }

  if (req.url.startsWith("/api/setup/generate-specialist-plan") && req.method === "POST") {
    try {
      sendJson(res, 200, generateSpecialistPlan());
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: String(error.message || error) });
    }
    return;
  }

  if (req.url.startsWith("/api/setup/review-specialist-plan") && req.method === "POST") {
    try {
      const payload = await readRequestJson(req);
      sendJson(res, 200, reviewSpecialistPlan(payload));
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: String(error.message || error) });
    }
    return;
  }

  if (req.url.startsWith("/api/setup/start-production") && req.method === "POST") {
    try {
      const payload = await readRequestJson(req);
      sendJson(res, 200, startProduction(payload));
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: String(error.message || error) });
    }
    return;
  }

  serveStatic(req, res);
});

function listenOnPort(portInfo) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(portInfo.port, portInfo.host);
  });
}

function requestedDashboardPort() {
  return normalizePort(process.env.PORT || process.argv[2]);
}

async function selectDashboardPort() {
  const options = readSetupOptions();
  const requestedPort = requestedDashboardPort();
  const strictPort = process.env.ORQUESTA_DASHBOARD_STRICT_PORT === "1";
  const preferredPort = requestedPort ?? DEFAULT_DASHBOARD_PORT;
  const previousPort = requestedPort ? null : previousDashboardPortFromOptions(options);
  const scanStart = preferredPort;
  const scanEnd = strictPort ? preferredPort : Math.min(preferredPort + 100, 65535);

  return findAvailableDashboardPort({
    host: DEFAULT_DASHBOARD_HOST,
    previousPort,
    preferredPort,
    scanStart,
    scanEnd,
    allowEphemeral: !strictPort
  });
}

async function startDashboardServer() {
  let portInfo = await selectDashboardPort();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await listenOnPort(portInfo);
      const { dashboardUrl, updatedCurrent } = writeDashboardRuntimeOptions(portInfo);
      console.log(`Orquesta dashboard: ${dashboardUrl}`);
      if (portInfo.conflicts.length) {
        console.warn(`Orquesta dashboard skipped occupied ports: ${portInfo.conflicts.join(", ")}`);
      }
      if (!updatedCurrent) {
        console.warn("Orquesta dashboard URL was not written to CURRENT_ORCHESTRA.md because the file does not exist yet.");
      }
      const warnings = refreshEncodingWarnings();
      if (warnings.length) {
        console.warn(`Orquesta encoding warnings: ${warnings.length}`);
        for (const warning of warnings.slice(0, 10)) {
          console.warn(`- ${warning.kind}: ${path.relative(root, warning.file)} ${warning.detail}`);
        }
      }
      return;
    } catch (error) {
      if (error.code !== "EADDRINUSE" || process.env.ORQUESTA_DASHBOARD_STRICT_PORT === "1") {
        throw error;
      }
      portInfo = await findAvailableDashboardPort({
        host: DEFAULT_DASHBOARD_HOST,
        preferredPort: Math.min(portInfo.port + 1, 65535),
        scanStart: Math.min(portInfo.port + 1, 65535),
        scanEnd: Math.min(portInfo.port + 101, 65535),
        allowEphemeral: true
      });
    }
  }

  throw new Error("Could not start Orquesta dashboard after repeated port selection races.");
}

if (require.main === module) {
  startDashboardServer().catch((error) => {
    console.error(`Orquesta dashboard failed to start: ${error.stack || error.message || error}`);
    process.exit(1);
  });
}

module.exports = {
  buildAutopilotCompletionMap,
  buildSetupQuestions,
  inferInitialRoleIds,
  readModelPolicyState,
  reviewSpecialistReport,
  updateReportReviewStateFiles
};
