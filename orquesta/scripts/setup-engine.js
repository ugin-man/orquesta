"use strict";

const crypto = require("node:crypto");
const { access, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { createFoundationStateBundle } = require("./adaptive-setup-state");
const { buildCurrentOrchestra } = require("./current-orchestra");
const { PHASES, createSetupState } = require("./setup-state");

const FOUNDATION_AGENTS = Object.freeze([
  Object.freeze({ agent_id: "orchestrator", role_id: "orchestrator" }),
  Object.freeze({ agent_id: "user-support", role_id: "user-support" }),
  Object.freeze({ agent_id: "orquesta-admin", role_id: "orquesta-admin" }),
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function projectIdForRoot(rootPath) {
  return `repo-${crypto.createHash("sha256").update(rootPath.replace(/\\/g, "/").toLowerCase()).digest("hex").slice(0, 16)}`;
}

function buildProjectIntake(payload, now, source = "desktop_setup_intake") {
  const projectName = String(payload.projectName ?? payload.project_title ?? "Orquesta project").trim() || "Orquesta project";
  const description = String(payload.description ?? payload.project_description ?? "").trim();
  return {
    version: 2,
    status: "submitted",
    updated_at: now,
    project_title: projectName,
    project_description: description,
    source,
    questions: clone(payload.questions || []),
    answers: clone(payload.answers || []),
  };
}

function buildOptionalSetupQuestions(intake, now) {
  const projectTitle = intake.project_title || "このプロジェクト";
  return [
    [`${projectTitle}で、最初に完成させたいものは何ですか？`, "最初の実行可能作業を決めるため。"],
    ["最初に使う人と、一番重要な利用場面は何ですか？", "初期導線と必要な専門家を絞るため。"],
    ["絶対に避けたい挙動や進め方はありますか？", "AIが望ましくない方向へ進むのを防ぐため。"],
  ].map(([question, why], index) => ({
    question_id: `SETUP-Q${index + 1}`,
    question,
    why_it_matters: why,
    source_agent_id: "user-support",
    status: "ready",
    required_for_setup: false,
    setup_gate: true,
    created_at: now,
  }));
}

function buildSetupOptions({
  rootPath,
  now,
  status = "in_progress",
  sessionsState = { sessions: [] },
  existing = {},
}) {
  const current = existing && typeof existing === "object" ? clone(existing) : {};
  const ready = status === "ready";
  const sessions = new Map((sessionsState.sessions || []).map((session) => [session.agent_id, session]));
  const projectRoot = path.resolve(rootPath);
  return {
    ...current,
    version: 1,
    setup_status: ready ? "ready" : "in_progress",
    bootstrap_status: ready ? "ready" : "in_progress",
    updated_at: now,
    foundation_id_policy: "unnumbered_for_new_projects",
    orchestrator_agent_id: "orchestrator",
    orchestrator_thread_id: sessions.get("orchestrator")?.thread_id || null,
    orchestrator_display_title: "★ Orquesta 統括者",
    orchestrator_title_policy: "rename_calling_thread_to_starred_Orquesta_orchestrator",
    orchestrator_pin_policy: "pin_calling_thread",
    foundation_agent_ids: ["user-support", "orquesta-admin"],
    foundation_sessions_required: true,
    foundation_session_status: ready ? "ready" : "pending",
    foundation_blockers: ready ? [] : clone(current.foundation_blockers || []),
    admin_agent_id: "orquesta-admin",
    admin_thread_id: sessions.get("orquesta-admin")?.thread_id || null,
    desktop_executable: current.desktop_executable || null,
    desktop_project_root: projectRoot,
    dashboard_url: current.dashboard_url || null,
    dashboard_verified_at: current.dashboard_verified_at || null,
    dashboard_open_policy: current.dashboard_open_policy || "explicit_diagnostic_only",
    dashboard_open_attempted: Boolean(current.dashboard_open_attempted),
    dashboard_opened_at: current.dashboard_opened_at || null,
    dashboard_open_error: current.dashboard_open_error || null,
    enabled_packs: Array.isArray(current.enabled_packs) ? current.enabled_packs : ["minimal_core"],
    available_packs: Array.isArray(current.available_packs) ? current.available_packs : [],
    local_paths: {
      ...(current.local_paths || {}),
      project_root: projectRoot,
      state_dir: path.join(projectRoot, ".orquesta", "state"),
      orquesta_dir: path.join(projectRoot, ".orquesta"),
    },
    notes: Array.isArray(current.notes) ? current.notes : [],
  };
}

function buildSetupWizard({ now, status = "in_progress", existing = {} }) {
  const current = existing && typeof existing === "object" ? clone(existing) : {};
  const ready = status === "ready";
  return {
    ...current,
    version: 1,
    status: ready ? "ready_for_operation" : "in_progress",
    current_step: ready ? "operation_ready" : "auto_finalize",
    updated_at: now,
    steps: [
      { step_id: "welcome", title: "ようこそOrquestaへ", summary: "Orquestaの目的と進め方を確認する。", status: "done" },
      { step_id: "project_intake", title: "プロジェクト説明", summary: "目的、成果物、制約、既存資産を共有する。", status: "done" },
      { step_id: "question_gate", title: "補完質問", summary: "重大な不明点だけを確認する。", status: "done" },
      { step_id: "auto_finalize", title: "初期セットアップ自動完了", summary: "基礎3役、完成条件、初期専門家を確定する。", status: ready ? "done" : "active" },
      { step_id: "operation_ready", title: "運用開始", summary: "必要に応じて体制や進め方を後から調整する。", status: ready ? "active" : "queued" },
    ],
    gates: {
      ...(current.gates || {}),
      project_intake_required: true,
      required_questions_must_be_answered: false,
      completion_map_requires_user_approval: false,
      completion_map_approved: ready,
      setup_autopilot_enabled: true,
      setup_autopilot_finalized: ready,
      specialist_plan_reviewed: ready,
      specialist_plan_approved: ready,
      approved_specialist_candidate_ids: Array.isArray(current.gates?.approved_specialist_candidate_ids)
        ? current.gates.approved_specialist_candidate_ids
        : [],
    },
  };
}

async function exists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJson(root, relativePath, value) {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function emptyFoundationStateBundle({ projectId, now }) {
  const foundation = createFoundationStateBundle({ projectId, now });
  return {
    rolesState: { ...foundation.rolesState, organization_revision: 0, roles: [] },
    agentsState: { ...foundation.agentsState, organization_revision: 0, agents: [] },
    organizationState: {
      ...foundation.organizationState,
      revision: 0,
      agents: [],
      teams: [],
      memberships: [],
      relationships: [],
      lines: [],
      applied_decision_ids: [],
    },
    sessionsState: { ...foundation.sessionsState, sessions: [] },
    tasksState: { ...foundation.tasksState, tasks: [] },
  };
}

async function canonicalRoot(rootPath) {
  if (typeof rootPath !== "string" || !path.isAbsolute(rootPath)) throw new TypeError("Setup root must be absolute");
  const resolved = await realpath(rootPath);
  const info = await stat(resolved);
  if (!info.isDirectory()) throw new Error("Setup root must be a directory");
  return resolved;
}

async function containsOnlyEmptyDirectories(rootPath) {
  const entries = await readdir(rootPath, { withFileTypes: true });
  const results = await Promise.all(entries.map((entry) => (
    entry.isDirectory()
      ? containsOnlyEmptyDirectories(path.join(rootPath, entry.name))
      : false
  )));
  return results.every(Boolean);
}

function createSetupEngine(options = {}) {
  const now = options.now || (() => new Date().toISOString());
  const randomUUID = options.randomUUID || crypto.randomUUID;
  const beforeCommit = options.beforeCommit || (async () => undefined);
  return {
    async start(input) {
      if (!input || !input.draft || input.draft.revision !== 1 || input.draft.status !== "draft") {
        throw new TypeError("A validated SetupDraft is required");
      }
      const rootPath = await canonicalRoot(input.rootPath);
      const targetRoot = path.join(rootPath, ".orquesta");
      const currentStatePath = path.join(targetRoot, "setup", "setup_state.json");
      if (await exists(currentStatePath)) {
        const current = await readJson(currentStatePath);
        if (current.setup_id && !["completed", "cancelled"].includes(String(current.status))) {
          return { setup_state: current, result: { setupId: current.setup_id, rootPath, activePhaseId: current.current_phase_id } };
        }
        throw new Error("An Orquesta setup already exists in this project");
      }
      if (await exists(targetRoot)) {
        if (!(await containsOnlyEmptyDirectories(targetRoot))) {
          throw new Error("The project already contains Orquesta state but no resumable setup");
        }
        await rm(targetRoot, { recursive: true, force: true });
      }

      const timestamp = now();
      const setupId = `SETUP-${randomUUID()}`;
      const projectId = projectIdForRoot(rootPath);
      const stagingRoot = path.join(rootPath, `.orquesta.setup-${setupId}.tmp`);
      const state = createSetupState({ setupId, projectId, draft: input.draft, now: timestamp });
      const foundation = emptyFoundationStateBundle({ projectId, now: timestamp });
      const intake = buildProjectIntake(input.draft, timestamp);
      const optionsState = buildSetupOptions({ rootPath, now: timestamp });
      const wizardState = buildSetupWizard({ now: timestamp });
      const directivesState = { version: 1, directives: [], updated_at: timestamp };
      const currentOrchestra = buildCurrentOrchestra({
        setupState: state,
        now: timestamp,
        agentsState: foundation.agentsState,
        tasksState: foundation.tasksState,
        directivesState,
      });
      const answers = new Map(input.draft.answers.map((answer) => [answer.questionId, answer.answer]));
      const questions = input.draft.questions.map((question) => ({
        question_id: question.questionId,
        question: question.prompt,
        status: answers.get(question.questionId)?.trim() ? "answered" : "ready",
        answer: answers.get(question.questionId) || null,
        required_for_setup: false,
        setup_gate: true,
        source_agent_id: "user-support",
        created_at: timestamp,
      }));
      try {
        await rm(stagingRoot, { recursive: true, force: true });
        await mkdir(stagingRoot, { recursive: false });
        await Promise.all([
          writeJson(stagingRoot, "setup/setup_state.json", state),
          writeJson(stagingRoot, "setup/project_intake.json", intake),
          writeJson(stagingRoot, "setup/options.json", optionsState),
          writeJson(stagingRoot, "setup/wizard.json", wizardState),
          writeJson(stagingRoot, "state/agents.json", foundation.agentsState),
          writeJson(stagingRoot, "state/tasks.json", foundation.tasksState),
          writeJson(stagingRoot, "state/roles.json", foundation.rolesState),
          writeJson(stagingRoot, "state/organization.json", foundation.organizationState),
          writeJson(stagingRoot, "state/sessions.json", foundation.sessionsState),
          writeJson(stagingRoot, "state/directives.json", directivesState),
          writeJson(stagingRoot, "vision/questions.json", { version: 1, questions, curation_policy: { curator_agent_id: "user-support" } }),
          writeJson(stagingRoot, "user_tasks/queue.json", { version: 1, tasks: [], updated_at: timestamp }),
          writeJson(stagingRoot, "failures/incidents.json", { version: 1, incidents: [], updated_at: timestamp }),
          writeFile(path.join(stagingRoot, "CURRENT_ORCHESTRA.md"), currentOrchestra, "utf8"),
        ]);
        await writeFile(path.join(stagingRoot, "state", "events.jsonl"), `${JSON.stringify({ timestamp, type: "initial_setup_started", actor: "user", setup_id: setupId, summary: "User approved the initial Orquesta setup." })}\n`, "utf8");
        await beforeCommit({ stagingRoot, targetRoot, setupState: clone(state) });
        await rename(stagingRoot, targetRoot);
        return { setup_state: state, result: { setupId, rootPath, activePhaseId: "environment" } };
      } catch (error) {
        await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    },
  };
}

module.exports = {
  FOUNDATION_AGENTS,
  PHASES,
  buildCurrentOrchestra,
  buildOptionalSetupQuestions,
  buildProjectIntake,
  buildSetupOptions,
  buildSetupWizard,
  createSetupEngine,
};
