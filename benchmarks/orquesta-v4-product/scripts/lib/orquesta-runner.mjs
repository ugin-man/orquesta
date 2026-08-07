import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

import { readOrquestaStateEvidence } from "./orquesta-state-evidence.mjs";

const FOUNDATION_AGENT_IDS = [
  "orchestrator",
  "orquesta-admin",
  "user-support"
];
const MODEL_TIER_IDS = Object.freeze({
  luna: "gpt-5.6-luna",
  terra: "gpt-5.6-terra",
  sol: "gpt-5.6-sol"
});

function requestedModelForRecommendation(value) {
  const recommendation = String(value || "").trim();
  return MODEL_TIER_IDS[recommendation.toLowerCase()]
    || recommendation
    || MODEL_TIER_IDS.terra;
}

function effortForRecommendation(value) {
  const recommendation = String(value || "").trim().toLowerCase();
  return recommendation.includes("sol") ? "high" : "medium";
}

function sameWorkspace(left, right) {
  return path.resolve(String(left || "")).toLowerCase()
    === path.resolve(String(right || "")).toLowerCase();
}

function reusedFoundationResult({ agentId, cached, workspaceRoot }) {
  if (
    !cached
    || typeof cached.thread_id !== "string"
    || !cached.thread_id
    || typeof cached.turn_id !== "string"
    || !cached.turn_id
    || !sameWorkspace(cached.workspace_root, workspaceRoot)
  ) {
    const error = new Error(`steady foundation session is unavailable for ${agentId}`);
    error.code = "steady_foundation_missing";
    throw error;
  }
  return {
    agent_id: agentId,
    thread_id: cached.thread_id,
    turn_id: cached.turn_id,
    status: "completed",
    actual_model: cached.actual_model || null,
    reused: true
  };
}

function foundationPrompt(agentId) {
  const roles = {
    orchestrator: "You are the Orquesta orchestrator. Read the repository Orquesta skill and canonical state. Acknowledge readiness only; do not execute the benchmark task yet.",
    "orquesta-admin": "You are Luca, the Orquesta administration helper. Read the repository Orquesta skill and canonical state. Acknowledge readiness only.",
    "user-support": "You are the Orquesta user-support agent. Read the repository Orquesta skill and canonical state. Acknowledge readiness only."
  };
  return roles[agentId] || `Initialize the Orquesta foundation role ${agentId}.`;
}

function foundationProfile(agentId) {
  return {
    model: agentId === "orchestrator"
      ? "gpt-5.6-sol"
      : agentId === "orquesta-admin"
        ? "gpt-5.6-luna"
        : "gpt-5.6-terra",
    effort: agentId === "orchestrator" ? "high" : "medium",
  };
}

async function startFoundationAgents({
  agentExecutor,
  agentIds,
  workspaceRoot,
  foundationSessionPool,
}) {
  const results = await Promise.all(agentIds.map(async (agentId) => {
    const profile = foundationProfile(agentId);
    const result = await agentExecutor.startAgent({
      agentId,
      ...profile,
      prompt: foundationPrompt(agentId),
      phase: "bootstrap",
    });
    if (result.status !== "completed") {
      throw controlError(
        "foundation_warmup_incomplete",
        `foundation warmup ended as ${result.status} for ${agentId}`,
      );
    }
    foundationSessionPool[agentId] = {
      thread_id: result.thread_id,
      turn_id: result.turn_id,
      actual_model: result.actual_model || null,
      workspace_root: path.resolve(workspaceRoot),
    };
    return result;
  }));
  return results;
}

export async function prepareSteadyOrquestaTask({
  workspaceRoot,
  runtimeRoot,
  setupRuntime = createSnapshotSetupRuntime({ runtimeRoot, workspaceRoot }),
  agentExecutor,
  foundationSessionPool = {},
  now = Date.now,
}) {
  const startedAt = now();
  await installFrozenSkill({ runtimeRoot, workspaceRoot });
  const foundationResults = [];
  let foundationReadyAt = null;
  const setup = await setupRuntime.run({
    async provisionFoundation({ agentIds }) {
      const results = await startFoundationAgents({
        agentExecutor,
        agentIds: agentIds || FOUNDATION_AGENT_IDS,
        workspaceRoot,
        foundationSessionPool,
      });
      foundationResults.push(...results);
      return results.map((result) => ({
        agent_id: result.agent_id,
        status: "accepted",
        thread_id: result.thread_id,
        turn_id: result.turn_id,
      }));
    },
    async provisionSpecialists({ batch }) {
      const pending = (batch.requests || []).filter((request) => (
        ["pending", "reuse_ready"].includes(request.status)
      ));
      if (pending.length) {
        throw controlError(
          "steady_warmup_requires_inline_task",
          "steady warmup cannot execute production specialist work",
        );
      }
      return batch;
    },
    onFoundationReady() {
      if (foundationReadyAt === null) foundationReadyAt = now();
    },
  });
  if (setup?.status !== "completed" || foundationReadyAt === null) {
    throw controlError(
      "steady_warmup_incomplete",
      `steady warmup setup ended as ${setup?.status || "unknown"}`,
    );
  }
  return {
    setup,
    foundation_session_pool: foundationSessionPool,
    metrics: {
      started_at_ms: startedAt,
      ended_at_ms: foundationReadyAt,
      wall_time_ms: foundationReadyAt - startedAt,
      foundation_generated_count: foundationResults.length,
      thread_ids: foundationResults.map((result) => result.thread_id),
      excluded_from_measured_run: true,
    },
  };
}

function specialistPrompt(request, benchmarkPrompt) {
  const reportPath = request.specialist_report_path
    || `.orquesta/reports/${request.task_id}-${request.agent_id}.md`;
  const resultContract = {
    specialist_result: {
      version: 1,
      task_id: request.task_id,
      agent_id: request.agent_id,
      status: "completed",
      summary: "one-line implementation result",
      files_read: ["only files directly needed for the implementation"],
      changes: [{
        path: "implemented artifact path",
        kind: "created_or_modified",
        summary: "one-line change summary",
      }],
      verification: [{
        command: "shortest deterministic verification command",
        status: "passed",
        expected: "expected result",
        evidence: "observed result",
      }],
      not_verified: [],
      open_risks: [],
      question_candidates: {
        status: "none",
        none_reason: "purely_mechanical_change",
        none_rationale: "one sentence explaining why no useful user question was exposed",
      },
      completed_at: "ISO-8601 timestamp",
    },
  };
  return [
    "Execute this bounded implementation task. This is not a coordination or state-management turn.",
    "The controller already validated routing, ownership, model selection, and the handoff.",
    "Do not load coordinator skills, inspect orchestration references or scripts, search memory, or run delegation/control/trigger/capacity audits.",
    "Do not modify .orquesta/state, .orquesta/setup, .orquesta/vision, .orquesta/failures, events, capacity, audits, or CURRENT_ORCHESTRA.md.",
    "Read only the benchmark inputs and implementation files directly needed to produce the requested artifact.",
    "Implement the smallest complete solution and run the shortest deterministic checks that prove it.",
    `Write one short report at ${reportPath}. It must contain one fenced JSON block matching the specialist_result contract below.`,
    "Do not write a completion_envelope; the deterministic acceptance controller expands specialist_result into canonical evidence.",
    'For question_candidates, use status "none" with a valid reason and rationale when there is no useful user question. Use status "submitted" with an items array only when the task genuinely exposes a user decision.',
    "After the report is written, end the turn. Do not perform lifecycle bookkeeping or additional audits.",
    "",
    "Benchmark task:",
    benchmarkPrompt,
    "",
    "Task identity:",
    JSON.stringify({
      task_id: request.task_id,
      agent_id: request.agent_id,
      role_id: request.role_id,
      report_path: reportPath,
    }, null, 2),
    "",
    "Required specialist_result contract:",
    JSON.stringify(resultContract, null, 2),
  ].join("\n");
}

function reviewPathForReceipt(receipt) {
  return `.orquesta/reviews/${receipt.task_id}-orchestrator.json`;
}

function extractReportEvidence(reportText) {
  const blockPattern = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const match of String(reportText).matchAll(blockPattern)) {
    try {
      const parsed = JSON.parse(match[1]);
      const payload = parsed?.specialist_result || parsed?.completion_envelope;
      if (!payload || typeof payload !== "object") continue;
      return {
        changes: Array.isArray(payload.changes) ? payload.changes : [],
        verification: Array.isArray(payload.verification)
          ? payload.verification
          : Array.isArray(payload.verification?.commands)
            ? payload.verification.commands
            : [],
      };
    } catch {
      // Other fenced report blocks may not be JSON.
    }
  }
  return { changes: [], verification: [] };
}

export function createSnapshotDeterministicReviewer({ workspaceRoot }) {
  return async ({ receipts, verification, now }) => {
    const reviews = [];
    for (const receipt of receipts || []) {
      const reportPath = receipt.report_path;
      const reportFile = path.join(workspaceRoot, ...String(reportPath).split("/"));
      const reportText = await fs.readFile(reportFile, "utf8");
      const evidence = extractReportEvidence(reportText);
      const implementationRefs = evidence.changes
        .filter((change) => !["report_only", "state_only"].includes(change?.kind))
        .map((change) => change?.path)
        .filter(Boolean);
      if (!implementationRefs.length) {
        throw new Error(`deterministic review found no implementation artifact for ${receipt.task_id}`);
      }
      for (const relative of implementationRefs) {
        const artifact = path.resolve(workspaceRoot, relative);
        const boundary = path.relative(workspaceRoot, artifact);
        if (boundary.startsWith("..") || path.isAbsolute(boundary)) {
          throw new Error(`deterministic review artifact escapes workspace: ${relative}`);
        }
        await fs.access(artifact);
      }
      const reviewPath = reviewPathForReceipt(receipt);
      const review = {
        schema_version: 1,
        task_id: receipt.task_id,
        review_owner_agent_id: "orchestrator",
        review_mechanism: "authoritative_deterministic_verifier",
        status: "accepted",
        findings: { critical: 0, important: 0, minor: 0 },
        evidence_refs: [
          reportPath,
          ...implementationRefs,
          reviewPath,
        ],
        completion_evidence: [
          {
            kind: "implementation",
            ref: implementationRefs[0],
            status: "passed",
          },
          {
            kind: "deterministic_check",
            ref: `authoritative verifier: ${verification.output || verification.status}`,
            status: "passed",
          },
        ],
        review_path: reviewPath,
        reviewed_at: now,
        summary: `Accepted by the authoritative deterministic verifier: ${
          verification.output || verification.status
        }`,
      };
      await writeJson(
        path.join(workspaceRoot, ...reviewPath.split("/")),
        review,
      );
      reviews.push(review);
    }
    return reviews;
  };
}

function correctionPrompt(benchmarkPrompt, receipt, verification) {
  return [
    benchmarkPrompt,
    "",
    "The authoritative deterministic verifier rejected the current specialist output.",
    `Verifier output: ${verification.output || verification.status}`,
    "Use your existing task context. Do not reread the Orquesta skill, search memory, or run Orquesta control audits.",
    "Inspect the source inputs and implementation artifacts, correct the smallest actual defect, rerun your local checks, and update the specialist report.",
    "Do not modify canonical .orquesta state, capacity state, events, or CURRENT_ORCHESTRA.md; the acceptance controller owns those writes.",
    "",
    "Specialist receipt:",
    JSON.stringify(receipt, null, 2),
  ].join("\n");
}

function directCorrectionPrompt(benchmarkPrompt, verification) {
  return [
    benchmarkPrompt,
    "",
    "The authoritative deterministic verifier rejected your solo-direct output.",
    `Verifier output: ${verification.output || verification.status}`,
    "Use your existing task context. Correct only the smallest actual defect and rerun the shortest relevant check.",
    "Do not reread the Orquesta skill, search memory, create a specialist, or broaden the task.",
  ].join("\n");
}

function directExecutionPrompt(benchmarkPrompt) {
  return [
    benchmarkPrompt,
    "",
    "You are the single execution owner for this measured task.",
    "Complete the task directly and run the shortest relevant verification.",
    "Do not create specialists, coordination reports, or lifecycle bookkeeping.",
  ].join("\n");
}

function finalPrompt(benchmarkPrompt, receipts, authoritativeVerification = null) {
  if (!receipts.length) {
    return [
      benchmarkPrompt,
      "",
      "You are the Orquesta orchestrator completing the measured task.",
      "No specialist receipt exists. Complete the task directly and verify the output.",
    ].join("\n");
  }
  const reviewContracts = receipts.map((receipt) => ({
    schema_version: 1,
    task_id: receipt.task_id,
    review_owner_agent_id: "orchestrator",
    status: "accepted_or_rejected",
    findings: { critical: 0, important: 0, minor: 0 },
    evidence_refs: [
      receipt.report_path,
      "every reviewed implementation artifact",
      reviewPathForReceipt(receipt),
    ],
    completion_evidence: [
      { kind: "implementation", ref: "primary implementation artifact", status: "passed" },
      { kind: "deterministic_check", ref: "verification command or output", status: "passed" },
    ],
    review_path: reviewPathForReceipt(receipt),
    reviewed_at: "ISO-8601 timestamp",
    summary: "one-line acceptance or rejection summary",
  }));
  return [
    benchmarkPrompt,
    "",
    "You are the independent Orquesta reviewer for already-completed specialist work.",
    "The Orquesta skill was read during your readiness turn. Do not reread it or search memory.",
    "Inspect only the target canonical task, its specialist report, the listed implementation artifacts, and the benchmark input files needed to verify acceptance.",
    "Run the shortest deterministic checks that prove or disprove the task requirements.",
    ...(authoritativeVerification ? [
      `The authoritative deterministic verifier already returned: ${JSON.stringify(authoritativeVerification)}`,
      "Treat that verifier result as the acceptance authority; do not replace it with a weaker self-authored validator.",
    ] : []),
    "Do not modify implementation artifacts, specialist reports, canonical .orquesta state, capacity state, CURRENT_ORCHESTRA.md, events, or audit files.",
    "Do not inspect Orquesta scripts and do not run delegation, control, trigger, encoding, or capacity audits.",
    "For each receipt, write exactly one durable JSON verdict at the review_path below. Rejected work must report its findings and stop; do not repair it in this turn.",
    "After the verdict file is written, end the turn with a one-line result. A deterministic controller will reconcile accepted state.",
    "",
    "Specialist receipts:",
    JSON.stringify(receipts, null, 2),
    "",
    "Required review JSON contracts:",
    JSON.stringify(reviewContracts, null, 2),
  ].join("\n");
}

async function installFrozenSkill({ runtimeRoot, workspaceRoot }) {
  const source = path.join(runtimeRoot, "orquesta");
  const sourceStat = await fs.stat(path.join(source, "SKILL.md")).catch(() => null);
  if (!sourceStat?.isFile()) throw new Error("frozen Orquesta skill is unavailable");
  const target = path.join(workspaceRoot, ".agents", "skills", "orquesta");
  await fs.rm(target, { recursive: true, force: true });
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.cp(source, target, { recursive: true });
  return target;
}

async function readJson(filePath, fallback) {
  return fs.readFile(filePath, "utf8")
    .then(JSON.parse)
    .catch((error) => {
      if (fallback !== undefined && error.code === "ENOENT") return structuredClone(fallback);
      throw error;
    });
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function enrichBatchFromTasks(workspaceRoot, batch) {
  const tasksPath = path.join(workspaceRoot, ".orquesta", "state", "tasks.json");
  const tasksState = await readJson(tasksPath, { tasks: [] });
  const tasks = new Map((tasksState.tasks || []).map((task) => [task.task_id, task]));
  return {
    ...batch,
    requests: (batch.requests || []).map((request) => ({
      ...request,
      specialist_report_path: tasks.get(request.task_id)?.specialist_report_path
        || request.specialist_report_path
        || null
    }))
  };
}

async function persistSpecialistEvidence({ workspaceRoot, batch, now }) {
  const stateRoot = path.join(workspaceRoot, ".orquesta", "state");
  const [agentsState, sessionsState, tasksState] = await Promise.all([
    readJson(path.join(stateRoot, "agents.json"), { version: 1, agents: [] }),
    readJson(path.join(stateRoot, "sessions.json"), { version: 1, sessions: [] }),
    readJson(path.join(stateRoot, "tasks.json"), { version: 1, tasks: [] })
  ]);
  const results = new Map((batch.requests || []).map((request) => [request.agent_id, request]));
  const sessions = new Map(
    (sessionsState.sessions || []).map((session) => [session.agent_id, session])
  );
  for (const request of batch.requests || []) {
    if (!request.thread_id || !request.turn_id) continue;
    sessions.set(request.agent_id, {
      ...(sessions.get(request.agent_id) || {}),
      session_id: sessions.get(request.agent_id)?.session_id || `session-${request.agent_id}`,
      agent_id: request.agent_id,
      thread_id: request.thread_id,
      handoff_turn_id: request.turn_id,
      handoff_status: request.handoff_status,
      operational_status: request.status,
      status: request.status,
      updated_at: now
    });
  }
  const updatedAgents = (agentsState.agents || []).map((agent) => {
    const result = results.get(agent.agent_id);
    if (!result?.thread_id) return agent;
    return {
      ...agent,
      thread_id: result.thread_id,
      lifecycle_state: "active",
      operational_status: result.status,
      status: result.status,
      updated_at: now
    };
  });
  const updatedTasks = (tasksState.tasks || []).map((task) => {
    const result = [...results.values()].find((request) => request.task_id === task.task_id);
    if (!result) return task;
    return {
      ...task,
      handoff_sent_at: task.handoff_sent_at || now,
      state: result.status === "standby" ? "completed" : task.state,
      updated_at: now
    };
  });
  await Promise.all([
    writeJson(path.join(stateRoot, "agents.json"), {
      ...agentsState,
      agents: updatedAgents,
      updated_at: now
    }),
    writeJson(path.join(stateRoot, "sessions.json"), {
      ...sessionsState,
      sessions: [...sessions.values()],
      updated_at: now
    }),
    writeJson(path.join(stateRoot, "tasks.json"), {
      ...tasksState,
      tasks: updatedTasks,
      updated_at: now
    })
  ]);
}

export function createSnapshotSetupRuntime({
  runtimeRoot,
  workspaceRoot,
  projectName = "Benchmark task",
  description = "Complete the benchmark task described by the current instruction."
}) {
  const runtimeRequire = createRequire(path.join(runtimeRoot, "package.json"));
  const { createSetupEngine } = runtimeRequire(
    path.join(runtimeRoot, "orquesta", "scripts", "setup-engine.js")
  );
  const { createDefaultPhaseHandlers } = runtimeRequire(
    path.join(runtimeRoot, "orquesta", "scripts", "setup-phase-handlers.js")
  );
  const { createSetupRunner } = runtimeRequire(
    path.join(runtimeRoot, "orquesta", "scripts", "setup-runner.js")
  );

  return {
    requiresStateEvidence: true,
    async run({
      provisionFoundation,
      provisionSpecialists,
      onFoundationReady
    }) {
      const engine = createSetupEngine();
      const started = await engine.start({
        rootPath: workspaceRoot,
        draft: {
          revision: 1,
          status: "draft",
          source: {
            kind: "detected_root",
            rootPath: workspaceRoot
          },
          projectName,
          description,
          questions: [],
          answers: []
        }
      });
      let boundaryObserved = false;
      const handlers = createDefaultPhaseHandlers({
        provisionFoundation: async (input) => {
          const results = await provisionFoundation(input);
          if (!boundaryObserved) {
            boundaryObserved = true;
            onFoundationReady();
          }
          return results;
        },
        provisionSpecialists: async ({ batch, ...input }) => {
          const enriched = await enrichBatchFromTasks(workspaceRoot, batch);
          const provisioned = await provisionSpecialists({ ...input, batch: enriched });
          await persistSpecialistEvidence({
            workspaceRoot,
            batch: provisioned,
            now: new Date().toISOString()
          });
          return provisioned;
        }
      });
      const runner = createSetupRunner({ handlers });
      return runner.run({
        rootPath: workspaceRoot,
        setupId: started.result.setupId
      });
    }
  };
}

function controlError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizedPath(value) {
  if (!value) return "";
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function assertAppliedAgentProfile({
  thread,
  workspaceRoot,
  requestedModel,
  profile
}) {
  const errors = [];
  if (thread.applied_model !== requestedModel) {
    errors.push(`model expected ${requestedModel}, observed ${thread.applied_model}`);
  }
  if (normalizedPath(thread.runtime_profile?.cwd) !== normalizedPath(workspaceRoot)) {
    errors.push(
      `cwd expected ${workspaceRoot}, observed ${thread.runtime_profile?.cwd}`
    );
  }
  if (thread.runtime_profile?.sandbox !== profile.execution.sandbox) {
    errors.push(
      `sandbox expected ${profile.execution.sandbox}, observed ${thread.runtime_profile?.sandbox}`
    );
  }
  if (
    thread.runtime_profile?.approval_policy
    !== profile.execution.approval_policy
  ) {
    errors.push(
      `approval policy expected ${profile.execution.approval_policy}, observed ${thread.runtime_profile?.approval_policy}`
    );
  }
  if (errors.length > 0) {
    throw controlError("runtime_profile_mismatch", errors.join("; "));
  }
}

export function createAppServerAgentExecutor({
  adapter,
  profile,
  workspaceRoot,
  timeoutMs = profile.execution.agent_timeout_sec * 1000,
  interruptGraceMs = 30_000
}) {
  const terminalByTurn = new Map();
  const waiters = new Map();
  const disposableThreadIds = new Set();
  let subscription = null;
  let initialized = false;
  let sequence = 0;

  async function initialize() {
    if (initialized) return;
    const subscribed = await adapter.subscribeEvents({
      correlationId: "benchmark-orquesta-subscribe",
      listener(event) {
        if (!event.turn_id) return;
        if (event.type === "turn_completed" || event.type === "approval_requested") {
          terminalByTurn.set(event.turn_id, event);
          waiters.get(event.turn_id)?.(event);
        }
      }
    });
    subscription = subscribed.subscription;
    initialized = true;
  }

  async function waitForTurn(threadId, turnId) {
    const existing = terminalByTurn.get(turnId);
    if (existing) return existing;
    let resolveEvent;
    const eventPromise = new Promise((resolve) => {
      resolveEvent = resolve;
      waiters.set(turnId, resolve);
    });
    const timeoutPromise = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      timer.unref?.();
    });
    let event = await Promise.race([eventPromise, timeoutPromise]);
    if (event?.type === "turn_completed") {
      waiters.delete(turnId);
      return event;
    }
    const reason = event?.type === "approval_requested" ? "unexpected_approval" : "timeout";
    const interrupted = await adapter.interruptTurn({
      correlationId: `benchmark-orquesta-interrupt-${++sequence}`,
      threadId,
      turnId
    });
    if (!interrupted?.ok) {
      throw controlError(
        interrupted?.error?.code || "turn_interrupt_failed",
        interrupted?.error?.message || "failed to interrupt Orquesta turn"
      );
    }
    const grace = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), interruptGraceMs);
      timer.unref?.();
    });
    event = await Promise.race([eventPromise, grace]);
    waiters.delete(turnId);
    if (!event || event.type !== "turn_completed") {
      throw controlError("turn_interrupt_unconfirmed", "Orquesta turn did not terminate");
    }
    throw controlError(reason, `Orquesta turn stopped because of ${reason}`);
  }

  async function startTurn({ threadId, prompt, effort }) {
    const started = await adapter.startTurn({
      correlationId: `benchmark-orquesta-turn-${++sequence}`,
      threadId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
      params: { effort }
    });
    if (!started?.ok) {
      throw controlError(
        started?.error?.code || "turn_start_failed",
        started?.error?.message || "Orquesta turn failed to start"
      );
    }
    const terminal = await waitForTurn(threadId, started.turn_id);
    return { started, terminal };
  }

  return {
    async startAgent({ agentId, model, effort = "high", prompt }) {
      await initialize();
      const requestedModel = model || profile.execution.model;
      const thread = await adapter.createThread({
        correlationId: `benchmark-orquesta-thread-${++sequence}`,
        recommendedModel: requestedModel,
        requestedModel,
        params: {
          cwd: workspaceRoot,
          model: requestedModel,
          sandbox: profile.execution.sandbox,
          approvalPolicy: profile.execution.approval_policy
        }
      });
      if (!thread?.ok) {
        throw controlError(
          thread?.error?.code || "thread_create_failed",
          thread?.error?.message || `failed to create ${agentId}`
        );
      }
      disposableThreadIds.add(thread.thread_id);
      assertAppliedAgentProfile({
        thread,
        workspaceRoot,
        requestedModel,
        profile
      });
      const { started, terminal } = await startTurn({
        threadId: thread.thread_id,
        prompt,
        effort
      });
      return {
        agent_id: agentId,
        thread_id: thread.thread_id,
        turn_id: started.turn_id,
        status: terminal.status === "completed" ? "completed" : "failed",
        actual_model: thread.applied_model || requestedModel
      };
    },
    async finalizeOrchestrator({ threadId, prompt }) {
      await initialize();
      const { started, terminal } = await startTurn({
        threadId,
        prompt,
        effort: profile.execution.reasoning_effort
      });
      return {
        thread_id: threadId,
        turn_id: started.turn_id,
        status: terminal.status === "completed" ? "completed" : "failed",
        actual_model: profile.execution.model
      };
    },
    async continueAgent({ threadId, prompt, effort = "high", actualModel = null }) {
      await initialize();
      const { started, terminal } = await startTurn({
        threadId,
        prompt,
        effort,
      });
      return {
        thread_id: threadId,
        turn_id: started.turn_id,
        status: terminal.status === "completed" ? "completed" : "failed",
        actual_model: actualModel,
      };
    },
    async shutdown() {
      subscription?.unsubscribe?.();
      let cleanupFailure = null;
      for (const threadId of disposableThreadIds) {
        try {
          const archived = await adapter.archiveThread({
            correlationId: `benchmark-orquesta-archive-${++sequence}`,
            threadId
          });
          if (!archived?.ok && !cleanupFailure) {
            cleanupFailure = new Error(
              archived?.error?.message || `failed to archive disposable thread ${threadId}`
            );
          }
        } catch (error) {
          cleanupFailure ||= error;
        }
      }
      await adapter.shutdown({
        correlationId: "benchmark-orquesta-shutdown"
      });
      if (cleanupFailure) throw cleanupFailure;
    }
  };
}

export function createSnapshotAcceptanceReconciler({
  runtimeRoot,
  workspaceRoot,
}) {
  const runtimeRequire = createRequire(path.join(runtimeRoot, "package.json"));
  const { reconcileTaskAcceptanceBatchAtomic } = runtimeRequire(
    path.join(runtimeRoot, "orquesta", "scripts", "task-acceptance-reconciler.js"),
  );
  return async ({ receipts }) => {
    const items = [];
    for (const receipt of receipts || []) {
      const reviewRelativePath = reviewPathForReceipt(receipt);
      const reviewFile = path.join(workspaceRoot, ...reviewRelativePath.split("/"));
      const review = await readJson(reviewFile);
      items.push({
        taskId: receipt.task_id,
        receipt,
        review: {
          ...review,
          review_path: review.review_path || reviewRelativePath,
        },
        now: review.reviewed_at,
      });
    }
    const reconciliation = reconcileTaskAcceptanceBatchAtomic({
      rootPath: workspaceRoot,
      items,
      now: items.at(-1)?.now || new Date().toISOString(),
    });
    return {
      status: reconciliation.results.every((result) => (
        result.status === "accepted" || result.status === "already_reconciled"
      )) ? "accepted" : "invalid",
      results: reconciliation.results,
      control_audit: reconciliation.control_audit,
      delegation_gate: reconciliation.delegation_gate,
    };
  };
}

export async function runOrquestaTask({
  workspaceRoot,
  runtimeRoot,
  prompt,
  setupRuntime = createSnapshotSetupRuntime({ runtimeRoot, workspaceRoot }),
  agentExecutor,
  acceptanceReconciler = createSnapshotAcceptanceReconciler({
    runtimeRoot,
    workspaceRoot,
  }),
  deterministicReviewer = createSnapshotDeterministicReviewer({ workspaceRoot }),
  acceptanceVerifier = null,
  dispatchObserver = null,
  specialistScheduler = null,
  startupMode = "cold",
  foundationSessionPool = null,
  preparedSetup = null,
  now = Date.now
}) {
  if (!["cold", "steady"].includes(startupMode)) {
    throw new TypeError(`unsupported startupMode: ${startupMode}`);
  }
  const bootstrapStartedAt = now();
  let foundationReadyAt = null;
  const foundationResults = [];
  const specialistResults = [];
  const observedThreadIds = new Set();

  try {
    await installFrozenSkill({ runtimeRoot, workspaceRoot });
    const provisionFoundation = async ({ agentIds }) => {
      const ids = agentIds || FOUNDATION_AGENT_IDS;
      const results = startupMode === "steady"
        ? ids.map((agentId) => reusedFoundationResult({
          agentId,
          cached: foundationSessionPool?.[agentId],
          workspaceRoot
        }))
        : await startFoundationAgents({
          agentExecutor,
          agentIds: ids,
          workspaceRoot,
          foundationSessionPool: foundationSessionPool || {},
        });
      for (const result of results) {
        foundationResults.push(result);
        observedThreadIds.add(result.thread_id);
      }
      return results.map((result) => ({
        agent_id: result.agent_id,
        status: result.status === "completed" ? "accepted" : "failed",
        thread_id: result.thread_id,
        turn_id: result.turn_id
      }));
    };
    const provisionSpecialists = async ({ batch }) => {
      const pending = (batch.requests || []).filter((request) => (
        ["pending", "reuse_ready"].includes(request.status)
      ));
      let shadowTickets = pending.map(() => null);
      if (dispatchObserver) {
        try {
          shadowTickets = await dispatchObserver.beginBatch({ requests: pending });
        } catch (error) {
          dispatchObserver.recordError(error);
        }
      }
      const indexByRequest = new Map(pending.map((request, index) => [request, index]));
      const startSpecialist = async (request) => {
        const index = indexByRequest.get(request);
        try {
          const result = await agentExecutor.startAgent({
            agentId: request.agent_id,
            model: requestedModelForRecommendation(request.recommended_model),
            effort: effortForRecommendation(request.recommended_model),
            prompt: specialistPrompt(request, prompt),
            phase: "main",
            taskId: request.task_id
          });
          if (dispatchObserver && shadowTickets[index]) {
            try {
              dispatchObserver.recordResult(shadowTickets[index], result);
            } catch (error) {
              dispatchObserver.recordError(error);
            }
          }
          return result;
        } catch (error) {
          if (dispatchObserver && shadowTickets[index]) {
            try {
              dispatchObserver.recordResult(shadowTickets[index], null, error);
            } catch (shadowError) {
              dispatchObserver.recordError(shadowError);
            }
          }
          throw error;
        }
      };
      const runtimeResults = specialistScheduler
        ? await specialistScheduler.run({ requests: pending, start: startSpecialist })
        : await Promise.all(pending.map(startSpecialist));
      const results = runtimeResults.map((result, index) => {
        const request = pending[index];
        const receipt = {
          agent_id: request.agent_id,
          task_id: request.task_id,
          thread_id: result.thread_id,
          turn_id: result.turn_id,
          status: result.status,
          report_path: request.specialist_report_path || null,
          actual_model: result.actual_model
        };
        specialistResults.push(receipt);
        observedThreadIds.add(result.thread_id);
        return {
          ...request,
          status: result.status === "completed" ? "standby" : "provisioning_failed",
          handoff_status: result.status === "completed" ? "accepted" : "failed",
          thread_id: result.thread_id,
          turn_id: result.turn_id,
          completed_at: new Date().toISOString()
        };
      });
      const byAgent = new Map(results.map((result) => [result.agent_id, result]));
      return {
        ...batch,
        requests: (batch.requests || []).map((request) => byAgent.get(request.agent_id) || request)
      };
    };
    let setup;
    if (preparedSetup) {
      await provisionFoundation({ agentIds: FOUNDATION_AGENT_IDS });
      foundationReadyAt = now();
      setup = preparedSetup.setup;
    } else {
      setup = await setupRuntime.run({
        provisionFoundation,
        provisionSpecialists,
      onFoundationReady() {
        if (foundationReadyAt === null) foundationReadyAt = now();
      }
      });
    }

    if (foundationReadyAt === null) {
      return {
        status: "infrastructure_error",
        error: {
          code: "foundation_not_ready",
          message: `Orquesta setup ended as ${setup?.status || "unknown"} before foundation readiness`
        }
      };
    }
    if (setup?.status !== "completed") {
      return {
        status: "infrastructure_error",
        error: {
          code: "setup_incomplete",
          message: `Orquesta setup ended as ${setup?.status || "unknown"}`
        }
      };
    }

    const orchestrator = foundationResults.find((result) => result.agent_id === "orchestrator");
    if (!orchestrator?.thread_id) {
      return {
        status: "infrastructure_error",
        error: {
          code: "orchestrator_missing",
          message: "foundation setup did not create the orchestrator thread"
        }
      };
    }
    const provisioningBatch = await readJson(
      path.join(workspaceRoot, ".orquesta", "setup", "provisioning_batch.json"),
      { requests: [] },
    );
    const directExecutionRequest = (provisioningBatch.requests || []).find((request) => (
      request.status === "inline_verified"
    )) || null;
    let directExecution = null;
    let directExecutionOwner = null;
    if (specialistResults.length === 0) {
      if (directExecutionRequest) {
        directExecution = await agentExecutor.startAgent({
          agentId: directExecutionRequest.agent_id,
          model: requestedModelForRecommendation(directExecutionRequest.recommended_model),
          effort: effortForRecommendation(directExecutionRequest.recommended_model),
          prompt: directExecutionPrompt(prompt),
          phase: "main",
          taskId: directExecutionRequest.task_id,
        });
        directExecutionOwner = {
          agent_id: directExecutionRequest.agent_id,
          task_id: directExecutionRequest.task_id,
          recommended_model: directExecutionRequest.recommended_model,
          actual_model: directExecution.actual_model,
        };
      } else {
        directExecution = await agentExecutor.finalizeOrchestrator({
          threadId: orchestrator.thread_id,
          prompt: finalPrompt(prompt, [], null),
          receipts: [],
        });
      }
      if (directExecution.status !== "completed") {
        return {
          status: "invalid",
          error: {
            code: "solo_direct_execution_incomplete",
            message: `solo-direct execution ended as ${directExecution.status}`,
          },
          setup,
        };
      }
    }
    let authoritativeVerification = acceptanceVerifier
      ? await acceptanceVerifier()
      : null;
    if (
      authoritativeVerification
      && !authoritativeVerification.passed
      && specialistResults.length
    ) {
      const receipt = specialistResults[0];
      const correction = await agentExecutor.continueAgent({
        threadId: receipt.thread_id,
        prompt: correctionPrompt(prompt, receipt, authoritativeVerification),
        effort: "high",
        actualModel: receipt.actual_model,
      });
      if (correction.status !== "completed") {
        return {
          status: "invalid",
          error: {
            code: "specialist_correction_incomplete",
            message: `specialist correction ended as ${correction.status}`,
          },
          setup,
          authoritative_verification: authoritativeVerification,
        };
      }
      receipt.initial_turn_id = receipt.turn_id;
      receipt.turn_id = correction.turn_id;
      receipt.correction_turn_id = correction.turn_id;
      authoritativeVerification = await acceptanceVerifier();
    }
    if (
      authoritativeVerification
      && !authoritativeVerification.passed
      && specialistResults.length === 0
    ) {
      const correction = await agentExecutor.continueAgent({
        threadId: directExecution.thread_id,
        prompt: directCorrectionPrompt(prompt, authoritativeVerification),
        effort: "high",
        actualModel: directExecution.actual_model,
      });
      if (correction.status !== "completed") {
        return {
          status: "invalid",
          error: {
            code: "solo_direct_correction_incomplete",
            message: `solo-direct correction ended as ${correction.status}`,
          },
          setup,
          authoritative_verification: authoritativeVerification,
        };
      }
      directExecution = correction;
      authoritativeVerification = await acceptanceVerifier();
    }
    if (authoritativeVerification && !authoritativeVerification.passed) {
      return {
        status: "invalid",
        error: {
          code: "authoritative_verification_failed",
          message: authoritativeVerification.output || authoritativeVerification.status,
        },
        setup,
        authoritative_verification: authoritativeVerification,
      };
    }
    const deterministicAcceptance = (
      authoritativeVerification?.passed === true
      && authoritativeVerification?.acceptance_authority === "deterministic"
      && specialistResults.length > 0
    );
    let final;
    if (specialistResults.length === 0) {
      final = {
        ...directExecution,
        review_mode: authoritativeVerification?.passed
          ? "solo_direct_authoritative_verifier"
          : "solo_direct",
      };
    } else if (deterministicAcceptance) {
      await deterministicReviewer({
        receipts: specialistResults,
        verification: authoritativeVerification,
        now: new Date().toISOString(),
      });
      final = {
        thread_id: orchestrator.thread_id,
        turn_id: null,
        status: "completed",
        actual_model: null,
        review_mode: "authoritative_deterministic_verifier",
      };
    } else {
      final = await agentExecutor.finalizeOrchestrator({
        threadId: orchestrator.thread_id,
        prompt: finalPrompt(prompt, specialistResults, authoritativeVerification),
        receipts: specialistResults
      });
    }
    const reconciliation = final.status === "completed" && specialistResults.length
      ? await acceptanceReconciler({ receipts: specialistResults, final })
      : { status: "not_required", results: [] };
    const mainEndedAt = now();
    let stateEvidence = null;
    if (setupRuntime.requiresStateEvidence !== false) {
      stateEvidence = await readOrquestaStateEvidence({
        workspaceRoot,
        observedThreadIds: [...observedThreadIds]
      });
    }
    const valid = final.status === "completed"
      && reconciliation.status !== "invalid"
      && (!stateEvidence || stateEvidence.valid);
    return {
      status: valid ? "completed" : "invalid",
      startup_mode: startupMode,
      error: valid ? null : {
        code: final.status !== "completed"
          ? "orchestrator_incomplete"
          : reconciliation.status === "invalid"
            ? "acceptance_reconciliation_invalid"
            : "orquesta_state_invalid",
        message: final.status !== "completed"
          ? `orchestrator ended as ${final.status}`
          : reconciliation.status === "invalid"
            ? "Accepted specialist results could not be reconciled"
            : stateEvidence.errors.join("; ")
      },
      bootstrap_metrics: {
        started_at_ms: bootstrapStartedAt,
        ended_at_ms: foundationReadyAt,
        wall_time_ms: foundationReadyAt - bootstrapStartedAt,
        foundation_generated_count: foundationResults.filter((result) => !result.reused).length,
        foundation_reused_count: foundationResults.filter((result) => result.reused).length,
        thread_ids: foundationResults.map((result) => result.thread_id)
      },
      main_metrics: {
        started_at_ms: foundationReadyAt,
        ended_at_ms: mainEndedAt,
        wall_time_ms: mainEndedAt - foundationReadyAt,
        orchestrator_thread_id: orchestrator.thread_id,
        direct_thread_ids: directExecutionOwner ? [directExecution.thread_id] : [],
        direct_execution_owner: directExecutionOwner,
        specialist_thread_ids: specialistResults.map((result) => result.thread_id),
        specialist_receipts: specialistResults
      },
      final,
      reconciliation,
      authoritative_verification: authoritativeVerification,
      setup,
      state_evidence: stateEvidence,
      execution_kernel_shadow: dispatchObserver?.snapshot() || null
    };
  } catch (error) {
    return {
      status: "infrastructure_error",
      error: {
        code: error.code || "orquesta_runner_failed",
        message: error.message
      },
      execution_kernel_shadow: dispatchObserver?.snapshot() || null
    };
  } finally {
    await agentExecutor.shutdown();
  }
}
