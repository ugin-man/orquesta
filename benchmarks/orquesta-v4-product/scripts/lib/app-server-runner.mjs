import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

function correlation(prefix, suffix) {
  return `${prefix}-${suffix}`;
}

function normalizedPath(value) {
  if (!value) return "";
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
  });
}

function infrastructureError(code, message, fields = {}) {
  return {
    status: "infrastructure_error",
    error: { code, message },
    ...fields
  };
}

function validateAppliedProfile({ thread, profile, workspaceRoot }) {
  const errors = [];
  if (thread.applied_model !== profile.execution.model) {
    errors.push(`model expected ${profile.execution.model}, observed ${thread.applied_model}`);
  }
  if (normalizedPath(thread.runtime_profile?.cwd) !== normalizedPath(workspaceRoot)) {
    errors.push(`cwd expected ${workspaceRoot}, observed ${thread.runtime_profile?.cwd}`);
  }
  if (thread.runtime_profile?.sandbox !== profile.execution.sandbox) {
    errors.push(
      `sandbox expected ${profile.execution.sandbox}, observed ${thread.runtime_profile?.sandbox}`
    );
  }
  if (thread.runtime_profile?.approval_policy !== profile.execution.approval_policy) {
    errors.push(
      `approval policy expected ${profile.execution.approval_policy}, observed ${thread.runtime_profile?.approval_policy}`
    );
  }
  return errors;
}

export function createProfiledSpawn({
  profile,
  spawnImpl = spawn,
  baseEnvironment = process.env
}) {
  return (executable, _args, options = {}) => spawnImpl(
    executable,
    profile.app_server_args,
    {
      ...options,
      env: {
        ...baseEnvironment,
        ...profile.environment
      }
    }
  );
}

export function createDefaultAppServerAdapter({
  profile,
  spawnImpl = spawn,
  onDiagnostic = () => {}
} = {}) {
  const { createAppServerAdapter } = require(
    "../../../../packages/codex-adapter/src/index.js"
  );
  return createAppServerAdapter({
    spawnProcess: createProfiledSpawn({ profile, spawnImpl }),
    onDiagnostic
  });
}

export async function runAppServerTask({
  adapter,
  profile,
  workspaceRoot,
  prompt,
  timeoutMs = profile.execution.agent_timeout_sec * 1000,
  interruptGraceMs = 30_000,
  successProbe = null,
  successProbeIntervalMs = 250,
  correlationPrefix = `benchmark-${Date.now()}`
}) {
  const events = [];
  let resolveTerminal;
  let resolveControl;
  let deadline = null;
  let probeTimer = null;
  let subscription = null;
  let threadId = null;
  let turnId = null;
  let actualModel = null;

  const terminalPromise = new Promise((resolve) => {
    resolveTerminal = resolve;
  });
  const controlPromise = new Promise((resolve) => {
    resolveControl = resolve;
  });

  try {
    const subscribed = await adapter.subscribeEvents({
      correlationId: correlation(correlationPrefix, "subscribe"),
      listener(event) {
        events.push(event);
        if (event.type === "model_observed" && event.model) actualModel = event.model;
        if (
          event.type === "approval_requested"
          && (!turnId || event.turn_id === turnId)
        ) {
          resolveControl({ kind: "approval", event });
        }
        if (
          event.type === "turn_completed"
          && (!turnId || event.turn_id === turnId)
        ) {
          resolveTerminal(event);
        }
      }
    });
    subscription = subscribed.subscription;

    const thread = await adapter.createThread({
      correlationId: correlation(correlationPrefix, "thread"),
      recommendedModel: profile.execution.model,
      requestedModel: profile.execution.model,
      params: {
        cwd: workspaceRoot,
        model: profile.execution.model,
        sandbox: profile.execution.sandbox,
        approvalPolicy: profile.execution.approval_policy
      }
    });
    if (!thread?.ok) {
      return infrastructureError(
        thread?.error?.code || "app_server_launch_failed",
        thread?.error?.message || "Codex App Server thread creation failed",
        { events }
      );
    }
    threadId = thread.thread_id;
    actualModel = thread.applied_model || actualModel;

    const profileErrors = validateAppliedProfile({ thread, profile, workspaceRoot });
    if (profileErrors.length > 0) {
      return infrastructureError(
        "runtime_profile_mismatch",
        profileErrors.join("; "),
        {
          thread_id: threadId,
          runtime_profile: thread.runtime_profile,
          events
        }
      );
    }

    const started = await adapter.startTurn({
      correlationId: correlation(correlationPrefix, "turn"),
      threadId,
      input: [{
        type: "text",
        text: prompt,
        text_elements: []
      }],
      params: {
        effort: profile.execution.reasoning_effort
      }
    });
    if (!started?.ok) {
      return infrastructureError(
        started?.error?.code || "turn_start_failed",
        started?.error?.message || "Codex App Server turn start failed",
        { thread_id: threadId, events }
      );
    }
    turnId = started.turn_id;

    deadline = setTimeout(
      () => resolveControl({ kind: "timeout" }),
      timeoutMs
    );
    deadline.unref?.();
    if (successProbe) {
      const poll = async () => {
        try {
          if (await successProbe()) resolveControl({ kind: "probe_success" });
        } catch (error) {
          resolveControl({ kind: "probe_error", error });
        }
      };
      probeTimer = setInterval(poll, successProbeIntervalMs);
      probeTimer.unref?.();
      await poll();
    }

    const firstOutcome = await Promise.race([
      terminalPromise.then((event) => ({ kind: "terminal", event })),
      controlPromise
    ]);
    clearTimeout(deadline);
    deadline = null;
    if (probeTimer) clearInterval(probeTimer);
    probeTimer = null;

    if (firstOutcome.kind === "terminal") {
      const threadRead = await adapter.readThread({
        correlationId: correlation(correlationPrefix, "read"),
        threadId,
        includeTurns: true
      });
      return {
        status: firstOutcome.event.status === "completed" ? "completed" : "failed",
        thread_id: threadId,
        turn_id: turnId,
        actual_model: actualModel,
        runtime_profile: thread.runtime_profile,
        terminal_event: firstOutcome.event,
        thread: threadRead?.ok ? threadRead.thread : null,
        events
      };
    }

    const interrupted = await adapter.interruptTurn({
      correlationId: correlation(correlationPrefix, "interrupt"),
      threadId,
      turnId
    });
    if (!interrupted?.ok) {
      return infrastructureError(
        interrupted?.error?.code || "turn_interrupt_failed",
        interrupted?.error?.message || "Codex App Server turn interrupt failed",
        {
          thread_id: threadId,
          turn_id: turnId,
          events,
          interrupt_confirmed: false
        }
      );
    }

    const terminalAfterInterrupt = await Promise.race([
      terminalPromise,
      delay(interruptGraceMs)
    ]);
    if (!terminalAfterInterrupt) {
      return infrastructureError(
        "turn_interrupt_unconfirmed",
        "Codex App Server did not emit a terminal event after interrupt",
        {
          thread_id: threadId,
          turn_id: turnId,
          events,
          interrupt_confirmed: false
        }
      );
    }

    if (firstOutcome.kind === "approval") {
      return infrastructureError(
        "unexpected_approval",
        "approval_policy=never produced an approval request",
        {
          thread_id: threadId,
          turn_id: turnId,
          actual_model: actualModel,
          runtime_profile: thread.runtime_profile,
          approval: firstOutcome.event,
          terminal_event: terminalAfterInterrupt,
          events,
          interrupt_confirmed: true
        }
      );
    }

    if (firstOutcome.kind === "probe_error") {
      return infrastructureError(
        "success_probe_failed",
        firstOutcome.error?.message || "success probe failed",
        {
          thread_id: threadId,
          turn_id: turnId,
          actual_model: actualModel,
          runtime_profile: thread.runtime_profile,
          terminal_event: terminalAfterInterrupt,
          events,
          interrupt_confirmed: true
        }
      );
    }

    if (firstOutcome.kind === "probe_success") {
      return {
        status: "probe_completed",
        thread_id: threadId,
        turn_id: turnId,
        actual_model: actualModel,
        runtime_profile: thread.runtime_profile,
        terminal_event: terminalAfterInterrupt,
        events,
        interrupt_confirmed: true
      };
    }

    return {
      status: "timeout",
      thread_id: threadId,
      turn_id: turnId,
      actual_model: actualModel,
      runtime_profile: thread.runtime_profile,
      terminal_event: terminalAfterInterrupt,
      events,
      interrupt_confirmed: true
    };
  } catch (error) {
    return infrastructureError(
      "app_server_runner_failed",
      error.message,
      {
        thread_id: threadId,
        turn_id: turnId,
        events
      }
    );
  } finally {
    if (deadline) clearTimeout(deadline);
    if (probeTimer) clearInterval(probeTimer);
    subscription?.unsubscribe?.();
    let cleanupFailure = null;
    if (threadId) {
      try {
        const archived = await adapter.archiveThread({
          correlationId: correlation(correlationPrefix, "archive"),
          threadId
        });
        if (!archived?.ok) {
          cleanupFailure = new Error(
            archived?.error?.message || `failed to archive disposable thread ${threadId}`
          );
        }
      } catch (error) {
        cleanupFailure = error;
      }
    }
    await adapter.shutdown({
      correlationId: correlation(correlationPrefix, "shutdown")
    }).catch(() => {});
    if (cleanupFailure) throw cleanupFailure;
  }
}
