"use strict";

const crypto = require("node:crypto");
const { access, mkdir, readFile, realpath, rename, rm, stat, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { createFoundationStateBundle } = require("./adaptive-setup-state");

const PHASES = Object.freeze([
  Object.freeze({ phase_id: "environment", title: "環境確認", summary: "保存先と実行環境を確認しています。" }),
  Object.freeze({ phase_id: "understanding", title: "プロジェクト理解", summary: "入力と既存資産からプロジェクトを整理します。" }),
  Object.freeze({ phase_id: "foundation", title: "基礎組織", summary: "統括者、Luca、利用者支援係を構築します。" }),
  Object.freeze({ phase_id: "planning", title: "初期計画", summary: "最初の実行可能作業を組み立てます。" }),
  Object.freeze({ phase_id: "specialists", title: "専門家編成", summary: "必要な専門家だけを配置します。" }),
  Object.freeze({ phase_id: "operation", title: "運用開始", summary: "初期体制を接続してホーム画面へ移ります。" }),
]);

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

function setupState({ setupId, projectId, draft, now }) {
  return {
    schema_version: 2,
    setup_id: setupId,
    project_id: projectId,
    project_name: draft.projectName,
    project_title: draft.projectName,
    status: "active",
    current_phase_id: "environment",
    phases: PHASES.map((phase, index) => ({ ...phase, status: index === 0 ? "active" : "waiting" })),
    input_snapshot: {
      revision: draft.revision,
      source: clone(draft.source),
      project_name: draft.projectName,
      description: draft.description,
      questions: clone(draft.questions),
      answers: clone(draft.answers),
    },
    foundation_agents: FOUNDATION_AGENTS.map(clone),
    current_activity: {
      activity_id: "setup-environment-preflight",
      title: "環境を確認中",
      detail: "プロジェクトの保存先とOrquesta Coreの開始状態を確認しています。",
      status: "active",
      observed_at: now,
    },
    recent_activities: [],
    next_activity: {
      activity_id: "setup-project-understanding",
      title: "プロジェクト理解",
      detail: "入力内容と既存資産を整理します。",
      status: "waiting",
      observed_at: null,
    },
    started_at: now,
    created_at: now,
    updated_at: now,
  };
}

async function canonicalRoot(rootPath) {
  if (typeof rootPath !== "string" || !path.isAbsolute(rootPath)) throw new TypeError("Setup root must be absolute");
  const resolved = await realpath(rootPath);
  const info = await stat(resolved);
  if (!info.isDirectory()) throw new Error("Setup root must be a directory");
  return resolved;
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
      if (await exists(targetRoot)) throw new Error("The project already contains Orquesta state but no resumable setup");

      const timestamp = now();
      const setupId = `SETUP-${randomUUID()}`;
      const projectId = projectIdForRoot(rootPath);
      const stagingRoot = path.join(rootPath, `.orquesta.setup-${setupId}.tmp`);
      const state = setupState({ setupId, projectId, draft: input.draft, now: timestamp });
      const foundation = createFoundationStateBundle({ projectId, now: timestamp });
      const intake = buildProjectIntake(input.draft, timestamp);
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
          writeJson(stagingRoot, "state/agents.json", foundation.agentsState),
          writeJson(stagingRoot, "state/tasks.json", foundation.tasksState),
          writeJson(stagingRoot, "state/roles.json", foundation.rolesState),
          writeJson(stagingRoot, "state/organization.json", foundation.organizationState),
          writeJson(stagingRoot, "state/sessions.json", foundation.sessionsState),
          writeJson(stagingRoot, "vision/questions.json", { version: 1, questions, curation_policy: { curator_agent_id: "user-support" } }),
          writeJson(stagingRoot, "user_tasks/queue.json", { version: 1, tasks: [], updated_at: timestamp }),
          writeJson(stagingRoot, "failures/incidents.json", { version: 1, incidents: [], updated_at: timestamp }),
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
  buildOptionalSetupQuestions,
  buildProjectIntake,
  createSetupEngine,
};
