"use strict";

const PHASES = Object.freeze([
  Object.freeze({ phase_id: "environment", title: "環境確認", summary: "保存先と実行環境を確認しています。" }),
  Object.freeze({ phase_id: "understanding", title: "プロジェクト理解", summary: "入力と既存資産からプロジェクトを整理します。" }),
  Object.freeze({ phase_id: "foundation", title: "基礎組織", summary: "統括者、Luca、利用者支援係を構築します。" }),
  Object.freeze({ phase_id: "planning", title: "初期計画", summary: "最初の実行可能作業を組み立てます。" }),
  Object.freeze({ phase_id: "specialists", title: "専門家編成", summary: "必要な専門家だけを配置します。" }),
  Object.freeze({ phase_id: "operation", title: "運用開始", summary: "初期体制を接続してホーム画面へ移ります。" }),
]);

const PHASE_IDS = new Set(PHASES.map(({ phase_id }) => phase_id));

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function phaseIndex(state, phaseId) {
  if (!PHASE_IDS.has(phaseId)) throw new TypeError(`Unknown setup phase: ${phaseId}`);
  const index = state.phases.findIndex((phase) => phase.phase_id === phaseId || phase.id === phaseId);
  if (index < 0) throw new Error(`Setup phase is missing from state: ${phaseId}`);
  return index;
}

function recentWith(state, activity) {
  if (!activity) return clone(state.recent_activities || []);
  return [...clone(state.recent_activities || []), clone(activity)].slice(-16);
}

function nextWaitingActivity(phases) {
  const phase = phases.find(({ status }) => status === "waiting");
  if (!phase) return null;
  return {
    activity_id: `setup-${phase.phase_id}`,
    title: phase.title,
    detail: phase.summary,
    status: "waiting",
    observed_at: null,
  };
}

function createSetupState({ setupId, projectId, draft, now }) {
  if (!setupId || !projectId || !draft || !now) throw new TypeError("setupId, projectId, draft, and now are required");
  const phases = PHASES.map((phase, index) => ({
    ...phase,
    order: index + 1,
    status: index === 0 ? "active" : "waiting",
    attempt: index === 0 ? 1 : 0,
    started_at: index === 0 ? now : null,
    completed_at: null,
    checkpoint_ref: null,
  }));
  return {
    schema_version: 3,
    setup_id: setupId,
    project_id: projectId,
    project_name: draft.projectName,
    project_title: draft.projectName,
    status: "running",
    current_phase_id: "environment",
    phases,
    input_snapshot: {
      revision: draft.revision,
      source: clone(draft.source),
      project_name: draft.projectName,
      description: draft.description,
      questions: clone(draft.questions),
      answers: clone(draft.answers),
    },
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
    blocking_issue: null,
    started_at: now,
    created_at: now,
    updated_at: now,
    completed_at: null,
  };
}

function activatePhase(input, phaseId, activity, now) {
  const state = clone(input);
  const index = phaseIndex(state, phaseId);
  for (let offset = 0; offset < index; offset += 1) {
    if (state.phases[offset].status !== "complete") throw new Error(`Cannot activate ${phaseId} before earlier phases complete`);
  }
  if (state.phases.some((phase, offset) => offset !== index && phase.status === "active")) {
    throw new Error("Another setup phase is already active");
  }
  const phase = state.phases[index];
  if (phase.status === "complete") throw new Error(`Setup phase is already complete: ${phaseId}`);
  phase.status = "active";
  phase.attempt = Number(phase.attempt || 0) + 1;
  phase.started_at = phase.started_at || now;
  state.status = "running";
  state.current_phase_id = phaseId;
  state.current_activity = clone(activity);
  state.next_activity = nextWaitingActivity(state.phases);
  state.blocking_issue = null;
  state.updated_at = now;
  return state;
}

function completePhase(input, phaseId, activity, now, checkpointRef = null) {
  const state = clone(input);
  const index = phaseIndex(state, phaseId);
  const phase = state.phases[index];
  if (!["active", "blocked"].includes(phase.status)) throw new Error(`Setup phase is not active: ${phaseId}`);
  phase.status = "complete";
  phase.completed_at = now;
  phase.checkpoint_ref = checkpointRef || phase.checkpoint_ref || null;
  state.status = "running";
  state.current_phase_id = phaseId;
  state.current_activity = clone(activity);
  state.recent_activities = recentWith(state, activity);
  state.next_activity = nextWaitingActivity(state.phases);
  state.blocking_issue = null;
  state.updated_at = now;
  return state;
}

function blockPhase(input, phaseId, issue, activity, now) {
  const state = clone(input);
  const phase = state.phases[phaseIndex(state, phaseId)];
  if (phase.status !== "active") throw new Error(`Setup phase is not active: ${phaseId}`);
  phase.status = "blocked";
  state.status = "blocked";
  state.current_phase_id = phaseId;
  state.current_activity = clone(activity);
  state.recent_activities = recentWith(state, activity);
  state.next_activity = null;
  state.blocking_issue = clone(issue);
  state.updated_at = now;
  return state;
}

function firstIncompletePhase(state) {
  const phase = (state.phases || []).find(({ status }) => status !== "complete");
  return phase ? phase.phase_id || phase.id : null;
}

function completeSetup(input, activity, now) {
  const state = clone(input);
  if (firstIncompletePhase(state)) throw new Error("all setup phases must be complete before setup completion");
  state.status = "completed";
  state.current_phase_id = "operation";
  state.current_activity = clone(activity);
  state.recent_activities = recentWith(state, activity);
  state.next_activity = null;
  state.blocking_issue = null;
  state.completed_at = state.completed_at || now;
  state.updated_at = now;
  return state;
}

module.exports = {
  PHASES,
  activatePhase,
  blockPhase,
  completePhase,
  completeSetup,
  createSetupState,
  firstIncompletePhase,
};
