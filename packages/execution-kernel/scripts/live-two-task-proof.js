"use strict";

const path = require("node:path");

const { createAppServerAdapter } = require("@orquesta/codex-adapter");
const {
  applyKernelEvent,
  createAppServerExecutionBridge,
  createKernelState,
  executionKernelEnabled,
  runDispatchTick,
} = require("../src");
const { publishExclusiveJsonFile } = require("../src/exclusive-process-lock-v1");

const LIVE_FLAG = "ORQUESTA_EXECUTION_KERNEL_LIVE_PROOF";
const ACTIVE_TURN_STATUS = "inProgress";
const CLEANUP_QUIESCENCE_DELAYS_MS = Object.freeze([0, 25, 50, 100, 200, 400, 800]);
const MAX_CLEANUP_QUIESCENCE_ATTEMPTS = 16;
const MAX_CLEANUP_QUIESCENCE_DELAY_MS = 5_000;
const PROOF_ARTIFACT_NAME = /^live-two-task-proof-[A-Za-z0-9._-]+\.json$/u;
const TERMINAL_TURN_STATUSES = new Set([
  "completed",
  "failed",
  "interrupted",
]);
const TASKS = Object.freeze([
  {
    task_id: "APP-SERVER-PROOF-001",
    priority: 1,
    prompt: 'Read only the root package.json. Reply with exactly the value of its "name" field. Do not modify files or run tests.',
    thread_name: "Orquesta V5 Kernel Proof 1",
    expected: "orquesta-v5",
  },
  {
    task_id: "APP-SERVER-PROOF-002",
    priority: 2,
    prompt: 'Read only packages/execution-kernel/package.json. Reply with exactly the value of its "name" field. Do not modify files or run tests.',
    thread_name: "Orquesta V5 Kernel Proof 2",
    expected: "@orquesta/execution-kernel",
  },
]);

function normalizeProofAnswer(value) {
  const trimmed = String(value ?? "").trim();
  const inlineCode = trimmed.match(/^`([^`\r\n]+)`$/u);
  return inlineCode ? inlineCode[1] : trimmed;
}

function flagEnabled(name) {
  return ["1", "true", "on", "enabled"].includes(
    String(process.env[name] ?? "").trim().toLowerCase(),
  );
}

function terminalForProof(state) {
  return TASKS.every(({ task_id: taskId }) => (
    ["verifying", "accepted", "failed", "cancelled", "retry_queued"].includes(
      state.tasks[taskId]?.state,
    )
  ));
}

function summarizeThread(thread) {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const lastTurn = turns.at(-1) ?? null;
  const items = Array.isArray(lastTurn?.items) ? lastTurn.items : [];
  const agentMessages = items
    .filter((item) => item?.type === "agentMessage")
    .map((item) => item.text ?? item.content ?? null)
    .filter(Boolean);
  return {
    id: thread?.id ?? null,
    status: thread?.status ?? null,
    turn_count: turns.length,
    last_turn_status: lastTurn?.status ?? null,
    last_agent_message: agentMessages.at(-1) ?? null,
  };
}

function requireCompletedAdapterResult(result, operation) {
  if (result?.ok) return result;
  const error = new Error(result?.error?.message || `${operation} failed`);
  error.code = result?.error?.code || `live_proof_${operation}_failed`;
  throw error;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function collectProofOwnedThreads({
  bridge,
  taskIds,
  dispatchResults = [],
  forceOutcomeUnknown = false,
}) {
  const candidates = new Map();
  for (const result of dispatchResults) {
    if (typeof result?.thread_id === "string" && result.thread_id) {
      const candidate = candidates.get(result.thread_id) ?? {
        thread_id: result.thread_id,
        known_turn_ids: new Set(),
        pre_provider_failure: false,
        outcome_unknown: false,
      };
      if (typeof result.turn_id === "string" && result.turn_id) {
        candidate.known_turn_ids.add(result.turn_id);
      }
      candidates.set(result.thread_id, candidate);
    }
  }
  for (const taskId of taskIds) {
    const session = bridge.readTaskSession(taskId);
    if (typeof session?.thread_id === "string" && session.thread_id) {
      const candidate = candidates.get(session.thread_id) ?? {
        thread_id: session.thread_id,
        known_turn_ids: new Set(),
        pre_provider_failure: true,
        outcome_unknown: false,
      };
      const failure = session.last_start_failure;
      candidate.outcome_unknown ||= failure?.code === "runtime_outcome_unknown"
        || (session.start_turn_stage === "issued" && failure?.dispatch_accepted !== false);
      candidate.pre_provider_failure &&= session.accepted_turns === 0
        && !candidate.outcome_unknown
        && (session.start_turn_stage === "not_issued"
          || (failure?.dispatch_accepted === false && failure?.operation === "startTurn"));
      candidates.set(session.thread_id, candidate);
    }
  }
  return [...candidates.values()]
    .map((candidate) => {
      return {
        thread_id: candidate.thread_id,
        known_turn_ids: [...candidate.known_turn_ids].sort(),
        settlement: forceOutcomeUnknown || candidate.outcome_unknown
          ? "observe_active"
          : candidate.known_turn_ids.size > 0
            ? "known_turn"
            : candidate.pre_provider_failure
              ? "pre_provider"
              : "observe_active",
      };
    })
    .sort((left, right) => left.thread_id.localeCompare(right.thread_id));
}

function inspectCleanupSnapshot(thread, threadId) {
  if (!thread || typeof thread !== "object" || thread.id !== threadId) {
    throw new Error(`live_proof_cleanup_thread_identity_mismatch:${threadId}`);
  }
  if (!Array.isArray(thread.turns)) {
    throw new Error(`live_proof_cleanup_turn_history_missing:${threadId}`);
  }
  const threadStatus = typeof thread.status === "string"
    ? thread.status
    : thread.status?.type;
  if (threadStatus !== "active" && threadStatus !== "idle") {
    throw new Error(`live_proof_cleanup_thread_status_uninspectable:${threadId}:${threadStatus}`);
  }
  const active = [];
  for (const turn of thread.turns) {
    if (!turn || typeof turn.id !== "string" || !turn.id
        || typeof turn.status !== "string" || !turn.status) {
      throw new Error(`live_proof_cleanup_turn_identity_invalid:${threadId}`);
    }
    if (turn.status === ACTIVE_TURN_STATUS) {
      active.push(turn.id);
      continue;
    }
    if (!TERMINAL_TURN_STATUSES.has(turn.status)) {
      throw new Error(
        `live_proof_cleanup_turn_status_unknown:${threadId}:${turn.id}:${turn.status}`,
      );
    }
  }
  if (threadStatus === "active" && active.length === 0) {
    throw new Error(`live_proof_cleanup_active_turn_identity_missing:${threadId}`);
  }
  return {
    active_turn_ids: active,
    thread_status: threadStatus,
    turn_status: new Map(thread.turns.map((turn) => [turn.id, turn.status])),
    turn_count: thread.turns.length,
  };
}

async function settleCleanupCandidate({
  adapter,
  candidate,
  quiescenceDelaysMs,
  sleep,
}) {
  let phase = "observe";
  let readCount = 0;
  let interruptedTurnIds = [];
  for (let attempt = 0; attempt < quiescenceDelaysMs.length; attempt += 1) {
    const waitMs = quiescenceDelaysMs[attempt];
    if (waitMs > 0) await sleep(waitMs);
    const read = await adapter.readThread({
      correlationId: `live-two-task-proof:cleanup:${phase}:${candidate.thread_id}:${attempt + 1}`,
      threadId: candidate.thread_id,
      includeTurns: true,
    });
    requireCompletedAdapterResult(read, `cleanup_${phase}_read_thread`);
    readCount += 1;
    const snapshot = inspectCleanupSnapshot(read.thread, candidate.thread_id);
    if (phase === "settle") {
      const allTerminal = interruptedTurnIds.every((turnId) => (
        TERMINAL_TURN_STATUSES.has(snapshot.turn_status.get(turnId))
      ));
      if (allTerminal && snapshot.active_turn_ids.length === 0) {
        return { interruptedTurnIds, readCount, snapshot };
      }
      continue;
    }
    if (candidate.settlement === "pre_provider") {
      if (snapshot.thread_status === "idle" && snapshot.turn_count === 0) {
        return { interruptedTurnIds, readCount, snapshot };
      }
      throw new Error(`live_proof_cleanup_pre_provider_activity_observed:${candidate.thread_id}`);
    }

    const known = new Set(candidate.known_turn_ids);
    const unexpectedActive = known.size > 0
      ? snapshot.active_turn_ids.find((turnId) => !known.has(turnId))
      : null;
    if (unexpectedActive) {
      throw new Error(
        `live_proof_cleanup_unowned_active_turn:${candidate.thread_id}:${unexpectedActive}`,
      );
    }
    if (candidate.settlement === "known_turn") {
      const knownStatuses = candidate.known_turn_ids.map((turnId) => snapshot.turn_status.get(turnId));
      if (knownStatuses.every((status) => TERMINAL_TURN_STATUSES.has(status))
          && snapshot.active_turn_ids.length === 0) {
        return { interruptedTurnIds, readCount, snapshot };
      }
    }
    if (snapshot.active_turn_ids.length > 0) {
      interruptedTurnIds = [...snapshot.active_turn_ids];
      for (const turnId of interruptedTurnIds) {
        const interrupted = await adapter.interruptTurn({
          correlationId: `live-two-task-proof:cleanup:interrupt:${candidate.thread_id}:${turnId}`,
          threadId: candidate.thread_id,
          turnId,
        });
        requireCompletedAdapterResult(interrupted, "cleanup_interrupt_turn");
      }
      phase = "settle";
      attempt = -1;
    }
  }
  const suffix = phase === "settle" ? "quiescence_timeout" : "recovery_required";
  throw new Error(`live_proof_cleanup_${suffix}:${candidate.thread_id}`);
}

async function cleanupProofRuntime({
  adapter,
  bridge,
  taskIds,
  dispatchResults = [],
  subscription = null,
  forceOutcomeUnknown = false,
  quiescenceDelaysMs = CLEANUP_QUIESCENCE_DELAYS_MS,
  sleep = delay,
}) {
  if (!Array.isArray(quiescenceDelaysMs) || quiescenceDelaysMs.length === 0
      || quiescenceDelaysMs.length > MAX_CLEANUP_QUIESCENCE_ATTEMPTS
      || quiescenceDelaysMs.some((value) => !Number.isInteger(value)
        || value < 0
        || value > MAX_CLEANUP_QUIESCENCE_DELAY_MS)) {
    throw new TypeError("quiescenceDelaysMs must contain bounded non-negative delays");
  }
  if (typeof sleep !== "function") throw new TypeError("sleep must be a function");
  const candidates = collectProofOwnedThreads({
    bridge,
    taskIds,
    dispatchResults,
    forceOutcomeUnknown,
  });
  const threads = [];
  const failures = [];

  try {
    subscription?.unsubscribe?.();
  } catch (error) {
    failures.push(error);
  }

  for (const candidate of candidates) {
    const threadId = candidate.thread_id;
    const evidence = {
      thread_id: threadId,
      settlement: candidate.settlement,
      inspected: false,
      observed_turn_count: 0,
      interrupted_turn_ids: [],
      quiescence_read_count: 0,
      archived: false,
    };
    try {
      const settled = await settleCleanupCandidate({
        adapter,
        candidate,
        quiescenceDelaysMs,
        sleep,
      });
      evidence.inspected = true;
      evidence.observed_turn_count = settled.snapshot.turn_count;
      evidence.interrupted_turn_ids = settled.interruptedTurnIds;
      evidence.quiescence_read_count = settled.readCount;

      const archived = await adapter.archiveThread({
        correlationId: `live-two-task-proof:cleanup:archive:${threadId}`,
        threadId,
      });
      requireCompletedAdapterResult(archived, "cleanup_archive_thread");
      evidence.archived = true;
    } catch (error) {
      evidence.error = error instanceof Error ? error.message : String(error);
      failures.push(error);
    }
    threads.push(evidence);
  }

  let providerShutdown = false;
  try {
    const shutdown = await bridge.shutdown();
    requireCompletedAdapterResult(shutdown, "cleanup_shutdown");
    providerShutdown = true;
  } catch (error) {
    failures.push(error);
  }

  const cleanup = {
    proof_owned_thread_count: candidates.length,
    inspected_thread_count: threads.filter((thread) => thread.inspected).length,
    interrupted_turn_count: threads.reduce(
      (total, thread) => total + thread.interrupted_turn_ids.length,
      0,
    ),
    archived_thread_count: threads.filter((thread) => thread.archived).length,
    provider_shutdown: providerShutdown,
    threads,
  };
  if (failures.length > 0) {
    const error = new AggregateError(failures, "live_two_task_proof_cleanup_failed");
    error.cleanup = cleanup;
    throw error;
  }
  return cleanup;
}

function assertPlainJson(value, field = "proof") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPlainJson(item, `${field}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object"
      || (Object.getPrototypeOf(value) !== Object.prototype
        && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${field} must contain only plain JSON values`);
  }
  for (const [key, nested] of Object.entries(value)) assertPlainJson(nested, `${field}.${key}`);
}

function validateProofArtifact(proof) {
  assertPlainJson(proof);
  if (proof.schema_version !== 1 || proof.status !== "passed"
      || typeof proof.finished_at !== "string" || !proof.finished_at) {
    throw new TypeError("proof artifact must be a finalized passed schema v1 document");
  }
  const cleanup = proof.cleanup;
  if (!cleanup || typeof cleanup !== "object" || Array.isArray(cleanup)
      || cleanup.provider_shutdown !== true
      || !Number.isSafeInteger(cleanup.proof_owned_thread_count)
      || cleanup.proof_owned_thread_count < 0
      || cleanup.inspected_thread_count !== cleanup.proof_owned_thread_count
      || cleanup.archived_thread_count !== cleanup.proof_owned_thread_count
      || !Number.isSafeInteger(cleanup.interrupted_turn_count)
      || cleanup.interrupted_turn_count < 0
      || !Array.isArray(cleanup.threads)
      || cleanup.threads.length !== cleanup.proof_owned_thread_count
      || cleanup.threads.some((thread) => !thread || typeof thread !== "object"
        || thread.inspected !== true || thread.archived !== true
        || Object.hasOwn(thread, "error"))) {
    throw new TypeError("proof artifact cleanup evidence is incomplete");
  }
}

async function publishProofArtifact(outputPath, proof, { repositoryRoot } = {}) {
  if (typeof repositoryRoot !== "string" || !repositoryRoot) {
    throw new TypeError("repositoryRoot is required to publish proof artifacts");
  }
  const root = path.resolve(repositoryRoot);
  const target = path.resolve(outputPath);
  const outputDirectory = path.join(root, "output", "execution-kernel");
  if (path.dirname(target) !== outputDirectory
      || !PROOF_ARTIFACT_NAME.test(path.basename(target))) {
    throw new Error("live_proof_artifact_path_invalid");
  }
  return publishExclusiveJsonFile({
    rootPath: root,
    filePath: target,
    value: proof,
    validate: validateProofArtifact,
    codePrefix: "LIVE_PROOF_ARTIFACT",
  });
}

async function finalizeProofArtifact({
  proof,
  cleanupOperation,
  repositoryRoot,
  outputPath,
  finishedAt,
}) {
  const cleanup = await cleanupOperation();
  const finalized = {
    ...proof,
    finished_at: finishedAt(),
    cleanup,
  };
  await publishProofArtifact(outputPath, finalized, { repositoryRoot });
  return finalized;
}

async function main() {
  if (!executionKernelEnabled() || !flagEnabled(LIVE_FLAG)) {
    throw new Error(
      `live proof requires ORQUESTA_EXECUTION_KERNEL_V2=1 and ${LIVE_FLAG}=1`,
    );
  }

  const repositoryRoot = path.resolve(__dirname, "..", "..", "..");
  const startedAt = new Date().toISOString();
  const diagnostics = [];
  const adapter = createAppServerAdapter({
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  const taskById = new Map(TASKS.map((task) => [task.task_id, task]));
  const bridge = createAppServerExecutionBridge({
    adapter,
    maxTasks: 2,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    resolveTask({ task_id: taskId }) {
      const task = taskById.get(taskId);
      if (!task) throw new Error(`proof_task_not_found:${taskId}`);
      return {
        cwd: repositoryRoot,
        prompt: task.prompt,
        thread_name: task.thread_name,
      };
    },
  });

  let state = createKernelState({ maxConcurrent: 2, updatedAt: startedAt });
  const events = [];
  let subscription = null;
  let timeout = null;
  let dispatchResults = [];
  let proof = null;
  let operationFailure = null;

  try {
    const tick = await runDispatchTick({
      state,
      tasks: TASKS,
      adapter: bridge,
      now: startedAt,
    });
    state = tick.state;
    dispatchResults = tick.results;

    let resolveTerminal;
    const terminal = new Promise((resolve) => {
      resolveTerminal = resolve;
    });
    const applyEvent = (event) => {
      events.push(event);
      state = applyKernelEvent(state, event);
      if (terminalForProof(state)) resolveTerminal();
    };
    subscription = bridge.subscribeKernelEvents({
      listener: applyEvent,
      replayQueued: true,
    });
    if (terminalForProof(state)) resolveTerminal();

    const timedOut = new Promise((_, reject) => {
      timeout = setTimeout(
        () => {
          const error = new Error("live_two_task_proof_timeout");
          error.code = "live_two_task_proof_timeout";
          reject(error);
        },
        120_000,
      );
      timeout.unref?.();
    });
    await Promise.race([terminal, timedOut]);
    clearTimeout(timeout);
    timeout = null;

    const reads = [];
    for (const result of tick.results) {
      const read = await adapter.readThread({
        correlationId: `${result.correlation_id}:read`,
        threadId: result.thread_id,
        includeTurns: true,
      });
      if (!read?.ok) throw new Error(read?.error?.message || "readThread failed");
      reads.push({
        task_id: result.task_id,
        dispatch_id: result.dispatch_id,
        correlation_id: result.correlation_id,
        thread_id: result.thread_id,
        turn_id: result.turn_id,
        thread: summarizeThread(read.thread),
      });
    }

    const distinctThreads = new Set(reads.map((read) => read.thread_id));
    const distinctTurns = new Set(reads.map((read) => read.turn_id));
    if (distinctThreads.size !== 2 || distinctTurns.size !== 2) {
      throw new Error("live_proof_runtime_identity_not_distinct");
    }
    if (reads.some((read) => read.thread.id !== read.thread_id)) {
      throw new Error("live_proof_thread_read_identity_mismatch");
    }
    for (const read of reads) {
      const expected = taskById.get(read.task_id).expected;
      const observed = normalizeProofAnswer(read.thread.last_agent_message);
      if (observed !== expected) {
        throw new Error(
          `live_proof_answer_mismatch:${read.task_id}:expected=${expected}:observed=${read.thread.last_agent_message}`,
        );
      }
    }

    const acceptedAt = new Date().toISOString();
    for (const task of TASKS) {
      if (state.tasks[task.task_id].state !== "verifying") continue;
      state = applyKernelEvent(state, {
        event_id: `${state.tasks[task.task_id].dispatch_id}:verification_accepted`,
        type: "verification_accepted",
        task_id: task.task_id,
        dispatch_id: state.tasks[task.task_id].dispatch_id,
        thread_id: state.tasks[task.task_id].thread_id,
        turn_id: state.tasks[task.task_id].turn_id,
        observed_at: acceptedAt,
      });
    }

    proof = {
      schema_version: 1,
      status: TASKS.every(({ task_id: taskId }) => state.tasks[taskId].state === "accepted")
        ? "passed"
        : "failed",
      started_at: startedAt,
      repository_root: repositoryRoot,
      task_count: TASKS.length,
      distinct_thread_count: distinctThreads.size,
      distinct_turn_count: distinctTurns.size,
      dispatch_results: tick.results,
      runtime_reads: reads,
      event_types: events.map((event) => event.type),
      final_tasks: Object.fromEntries(
        TASKS.map(({ task_id: taskId }) => [taskId, state.tasks[taskId]]),
      ),
      diagnostics,
    };
  } catch (error) {
    operationFailure = error;
  }

  if (timeout) clearTimeout(timeout);
  const cleanupOperation = () => cleanupProofRuntime({
    adapter,
    bridge,
    taskIds: TASKS.map((task) => task.task_id),
    dispatchResults,
    subscription,
    forceOutcomeUnknown: operationFailure?.code === "live_two_task_proof_timeout"
      || operationFailure?.code === "runtime_outcome_unknown",
  });
  if (operationFailure) {
    try {
      await cleanupOperation();
    } catch (cleanupError) {
      const operationMessage = operationFailure instanceof Error
        ? operationFailure.message
        : String(operationFailure);
      const cleanupMessage = cleanupError instanceof Error
        ? cleanupError.message
        : String(cleanupError);
      const combined = new AggregateError(
        [operationFailure, cleanupError],
        `live_two_task_proof_and_cleanup_failed:operation=${operationMessage}:cleanup=${cleanupMessage}`,
      );
      combined.cleanup = cleanupError?.cleanup ?? null;
      throw combined;
    }
    throw operationFailure;
  }
  if (!proof) throw new Error("live_two_task_proof_result_missing");

  const outputPath = path.join(
    repositoryRoot,
    "output",
    "execution-kernel",
    `live-two-task-proof-${startedAt.replace(/[:.]/g, "-")}.json`,
  );
  const finalized = await finalizeProofArtifact({
    proof,
    cleanupOperation,
    repositoryRoot,
    outputPath,
    finishedAt: () => new Date().toISOString(),
  });
  process.stdout.write(`${JSON.stringify({ ...finalized, output_path: outputPath }, null, 2)}\n`);
  if (finalized.status !== "passed") process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  cleanupProofRuntime,
  finalizeProofArtifact,
  normalizeProofAnswer,
  publishProofArtifact,
};
