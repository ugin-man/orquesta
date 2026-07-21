"use strict";

const { appendFile, mkdir, readFile, realpath, rename, rm, writeFile } = require("node:fs/promises");
const path = require("node:path");
const {
  PHASES,
  activatePhase,
  blockPhase,
  completePhase,
  completeSetup,
  firstIncompletePhase,
} = require("./setup-state");

class SetupBlockedError extends Error {
  constructor(code, message, retryable = false, userAction = null) {
    super(message);
    this.name = "SetupBlockedError";
    this.code = code;
    this.retryable = retryable;
    this.userAction = userAction;
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function readState(rootPath) {
  return JSON.parse(await readFile(path.join(rootPath, ".orquesta", "setup", "setup_state.json"), "utf8"));
}

async function writeStateAtomic(rootPath, state) {
  const filePath = path.join(rootPath, ".orquesta", "setup", "setup_state.json");
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  try {
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function appendSetupEvent(rootPath, event) {
  const filePath = path.join(rootPath, ".orquesta", "state", "events.jsonl");
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(event)}\n`, "utf8");
}

function activeActivity(phase, now) {
  return {
    activity_id: `setup-${phase.phase_id}-active`,
    title: phase.title,
    detail: phase.summary,
    status: "active",
    observed_at: now,
  };
}

function failureActivity(phase, error, now) {
  return {
    activity_id: `setup-${phase.phase_id}-blocked`,
    title: `${phase.title}で停止`,
    detail: error.message,
    status: "failed",
    observed_at: now,
  };
}

function createSetupRunner({
  handlers,
  now = () => new Date().toISOString(),
  onProgress = () => undefined,
  readSetupState = readState,
  writeSetupState = writeStateAtomic,
  appendEvent = appendSetupEvent,
} = {}) {
  if (!handlers || typeof handlers !== "object") throw new TypeError("Setup phase handlers are required");
  const running = new Map();

  async function progress(state, phaseId, status, message, occurredAt) {
    await onProgress({ setupId: state.setup_id, phaseId, status, message, occurredAt });
  }

  async function execute(rootPath, setupId) {
    let state = await readSetupState(rootPath);
    if (state.setup_id !== setupId) throw new Error("Setup runner identity mismatch");
    if (state.status === "completed" || state.status === "cancelled") return state;

    let phaseId = firstIncompletePhase(state);
    while (phaseId) {
      const definition = PHASES.find((phase) => phase.phase_id === phaseId);
      if (!definition) throw new Error(`Unknown setup phase: ${phaseId}`);
      const phase = state.phases.find((item) => (item.phase_id || item.id) === phaseId);
      if (phase.status !== "active") {
        const timestamp = now();
        state = activatePhase(state, phaseId, activeActivity(definition, timestamp), timestamp);
        await writeSetupState(rootPath, state);
      }
      const startedAt = now();
      await appendEvent(rootPath, { timestamp: startedAt, type: "setup_phase_started", actor: "orchestrator", setup_id: setupId, phase_id: phaseId, summary: `${definition.title} started.` });
      await progress(state, phaseId, "active", definition.summary, startedAt);

      try {
        const handler = handlers[phaseId];
        if (typeof handler !== "function") throw new SetupBlockedError("PHASE_HANDLER_MISSING", `Setup handler is missing: ${phaseId}`, false);
        const result = await handler({ rootPath, setupState: clone(state) });
        const completedAt = now();
        state = completePhase(state, phaseId, result.activity, completedAt, result.checkpointRef || null);
        await writeSetupState(rootPath, state);
        await appendEvent(rootPath, { timestamp: completedAt, type: "setup_phase_completed", actor: "orchestrator", setup_id: setupId, phase_id: phaseId, summary: result.activity?.detail || `${definition.title} completed.` });
        await progress(state, phaseId, "completed", result.activity?.detail || `${definition.title} completed.`, completedAt);
      } catch (error) {
        const failure = error instanceof SetupBlockedError
          ? error
          : new SetupBlockedError("SETUP_PHASE_FAILED", error instanceof Error ? error.message : String(error), true);
        const failedAt = now();
        state = blockPhase(state, phaseId, {
          code: failure.code,
          message: failure.message,
          retryable: failure.retryable,
          user_action: failure.userAction,
        }, failureActivity(definition, failure, failedAt), failedAt);
        await writeSetupState(rootPath, state);
        await appendEvent(rootPath, { timestamp: failedAt, type: "setup_phase_blocked", actor: "orchestrator", setup_id: setupId, phase_id: phaseId, summary: failure.message });
        await progress(state, phaseId, "failed", failure.message, failedAt);
        return state;
      }
      phaseId = firstIncompletePhase(state);
    }

    const completedAt = now();
    const completionActivity = {
      activity_id: "setup-completed",
      title: "セットアップが完了しました",
      detail: "初期体制を接続し、Orquestaを開始できます。",
      status: "complete",
      observed_at: completedAt,
    };
    state = completeSetup(state, completionActivity, completedAt);
    await writeSetupState(rootPath, state);
    await appendEvent(rootPath, { timestamp: completedAt, type: "initial_setup_completed", actor: "orchestrator", setup_id: setupId, phase_id: "operation", summary: completionActivity.detail });
    await progress(state, "operation", "completed", completionActivity.detail, completedAt);
    return state;
  }

  function run({ rootPath, setupId }) {
    const promise = realpath(rootPath).then((canonicalRoot) => {
      if (running.has(canonicalRoot)) return running.get(canonicalRoot);
      const active = execute(canonicalRoot, setupId).finally(() => running.delete(canonicalRoot));
      running.set(canonicalRoot, active);
      return active;
    });
    return promise.then((value) => value);
  }

  function resume(input) {
    return run(input);
  }

  async function cancel({ rootPath, setupId }) {
    const canonicalRoot = await realpath(rootPath);
    if (running.has(canonicalRoot)) throw new Error("Cannot cancel setup while a phase transition is committing");
    const state = await readSetupState(canonicalRoot);
    if (state.setup_id !== setupId) throw new Error("Setup runner identity mismatch");
    if (state.status === "completed") throw new Error("Completed setup cannot be cancelled");
    const cancelledAt = now();
    const cancelled = {
      ...clone(state),
      status: "cancelled",
      current_activity: {
        activity_id: "setup-cancelled",
        title: "セットアップを中止しました",
        detail: "現在の進行状況を保存しました。",
        status: "failed",
        observed_at: cancelledAt,
      },
      next_activity: null,
      updated_at: cancelledAt,
    };
    await writeSetupState(canonicalRoot, cancelled);
    await appendEvent(canonicalRoot, { timestamp: cancelledAt, type: "initial_setup_cancelled", actor: "user", setup_id: setupId, phase_id: cancelled.current_phase_id, summary: "User cancelled initial setup." });
    return cancelled;
  }

  return { run, resume, cancel };
}

module.exports = {
  SetupBlockedError,
  createSetupRunner,
};
