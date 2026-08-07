"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { createAppServerAdapter } = require("@orquesta/codex-adapter");
const {
  applyKernelEvent,
  createAppServerExecutionBridge,
  createKernelState,
  executionKernelEnabled,
  runDispatchTick,
} = require("../src");

const LIVE_FLAG = "ORQUESTA_EXECUTION_KERNEL_LIVE_PROOF";
const TASKS = Object.freeze([
  {
    task_id: "APP-SERVER-PROOF-001",
    priority: 1,
    prompt: 'Read only the root package.json. Reply with exactly the value of its "name" field. Do not modify files or run tests.',
    thread_name: "Orquesta V4 Fast Proof 1",
    expected: "orquesta-codex-skill",
  },
  {
    task_id: "APP-SERVER-PROOF-002",
    priority: 2,
    prompt: 'Read only packages/execution-kernel/package.json. Reply with exactly the value of its "name" field. Do not modify files or run tests.',
    thread_name: "Orquesta V4 Fast Proof 2",
    expected: "@orquesta/execution-kernel",
  },
]);

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
  const disposableThreadIds = new Set();
  let subscription = null;
  let timeout = null;

  try {
    const tick = await runDispatchTick({
      state,
      tasks: TASKS,
      adapter: bridge,
      now: startedAt,
    });
    state = tick.state;
    for (const result of tick.results) {
      if (typeof result.thread_id === "string") disposableThreadIds.add(result.thread_id);
    }

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
        () => reject(new Error("live_two_task_proof_timeout")),
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
      if (read.thread.last_agent_message !== expected) {
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

    const proof = {
      schema_version: 1,
      status: TASKS.every(({ task_id: taskId }) => state.tasks[taskId].state === "accepted")
        ? "passed"
        : "failed",
      started_at: startedAt,
      finished_at: new Date().toISOString(),
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
    const outputDirectory = path.join(repositoryRoot, "output", "execution-kernel");
    fs.mkdirSync(outputDirectory, { recursive: true });
    const outputPath = path.join(
      outputDirectory,
      `live-two-task-proof-${startedAt.replace(/[:.]/g, "-")}.json`,
    );
    fs.writeFileSync(outputPath, `${JSON.stringify(proof, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({ ...proof, output_path: outputPath }, null, 2)}\n`);
    if (proof.status !== "passed") process.exitCode = 1;
  } finally {
    if (timeout) clearTimeout(timeout);
    subscription?.unsubscribe?.();
    let cleanupFailure = null;
    for (const threadId of disposableThreadIds) {
      try {
        const archived = await adapter.archiveThread({
          correlationId: `live-two-task-proof:archive:${threadId}`,
          threadId,
        });
        if (!archived?.ok && !cleanupFailure) {
          cleanupFailure = new Error(
            archived?.error?.message || `failed to archive disposable thread ${threadId}`,
          );
        }
      } catch (error) {
        cleanupFailure ||= error;
      }
    }
    await bridge.shutdown().catch(() => {});
    if (cleanupFailure) throw cleanupFailure;
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
