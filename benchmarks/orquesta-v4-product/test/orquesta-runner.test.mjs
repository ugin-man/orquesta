import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createAppServerAgentExecutor,
  createSnapshotSetupRuntime,
  prepareSteadyOrquestaTask,
  runOrquestaTask
} from "../scripts/lib/orquesta-runner.mjs";

async function runtimeFixture(root) {
  const skill = path.join(root, "runtime", "orquesta");
  await fs.mkdir(skill, { recursive: true });
  await fs.writeFile(path.join(skill, "SKILL.md"), "# Orquesta fixture\n", "utf8");
  return path.join(root, "runtime");
}

function fakeExecutor() {
  const calls = [];
  let next = 0;
  return {
    calls,
    async startAgent(input) {
      next += 1;
      const result = {
        agent_id: input.agentId,
        thread_id: `thread-${input.agentId}`,
        turn_id: `turn-${next}`,
        status: "completed",
        actual_model: input.model || "gpt-5.6-sol"
      };
      calls.push(["startAgent", input, result]);
      return result;
    },
    async finalizeOrchestrator(input) {
      calls.push(["finalizeOrchestrator", input]);
      return {
        thread_id: input.threadId,
        turn_id: "turn-final",
        status: "completed",
        actual_model: "gpt-5.6-sol"
      };
    },
    async continueAgent(input) {
      next += 1;
      const result = {
        thread_id: input.threadId,
        turn_id: `turn-${next}`,
        status: "completed",
        actual_model: input.actualModel,
      };
      calls.push(["continueAgent", input, result]);
      return result;
    },
    async shutdown() {
      calls.push(["shutdown"]);
    }
  };
}

async function fakeAcceptanceReconciler() {
  return { status: "accepted", results: [] };
}

async function setupContractRuntimeFixture(root) {
  const runtimeRoot = path.join(root, "setup-runtime");
  const scriptsRoot = path.join(runtimeRoot, "orquesta", "scripts");
  await fs.mkdir(scriptsRoot, { recursive: true });
  await fs.writeFile(
    path.join(runtimeRoot, "package.json"),
    `${JSON.stringify({ name: "setup-contract-fixture", private: true })}\n`,
    "utf8"
  );
  await fs.writeFile(
    path.join(scriptsRoot, "setup-engine.js"),
    `"use strict";
module.exports = {
  createSetupEngine() {
    return {
      async start(input) {
        if (!input?.draft?.source?.kind || !input?.draft?.source?.rootPath) {
          throw new Error("setup draft source is required");
        }
        if (input.draft.projectName !== "Benchmark: conflict triage") {
          throw new Error("setup project name was not forwarded");
        }
        if (input.draft.description !== "Inspect conflicting requirements.") {
          throw new Error("setup description was not forwarded");
        }
        return { result: { setupId: "SETUP-CONTRACT" } };
      }
    };
  }
};
`,
    "utf8"
  );
  await fs.writeFile(
    path.join(scriptsRoot, "setup-phase-handlers.js"),
    `"use strict";
module.exports = {
  createDefaultPhaseHandlers(options) {
    return options;
  }
};
`,
    "utf8"
  );
  await fs.writeFile(
    path.join(scriptsRoot, "setup-runner.js"),
    `"use strict";
module.exports = {
  createSetupRunner() {
    return {
      async run() {
        return { status: "completed" };
      }
    };
  }
};
`,
    "utf8"
  );
  return runtimeRoot;
}

test("passes the detected workspace source required by the V4-fast setup contract", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orquesta-setup-contract-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtimeRoot = await setupContractRuntimeFixture(root);
  const workspaceRoot = path.join(root, "workspace");
  await fs.mkdir(workspaceRoot);
  const setupRuntime = createSnapshotSetupRuntime({
    runtimeRoot,
    workspaceRoot,
    projectName: "Benchmark: conflict triage",
    description: "Inspect conflicting requirements."
  });

  const result = await setupRuntime.run({
    async provisionFoundation() {
      return [];
    },
    async provisionSpecialists({ batch }) {
      return batch;
    },
    onFoundationReady() {}
  });

  assert.equal(result.status, "completed");
});

test("separates foundation bootstrap from task-time specialists and final receipt", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orquesta-runner-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtimeRoot = await runtimeFixture(root);
  const workspaceRoot = path.join(root, "workspace");
  await fs.mkdir(workspaceRoot);
  const executor = fakeExecutor();
  const verifierResults = [
    { status: "failed", passed: false, output: "fixture mismatch" },
    { status: "passed", passed: true, output: "fixture passed" },
  ];
  const setupRuntime = {
    requiresStateEvidence: false,
    async run({
      provisionFoundation,
      provisionSpecialists,
      onFoundationReady
    }) {
      const foundation = await provisionFoundation({
        agentIds: ["orchestrator", "orquesta-admin", "user-support"]
      });
      onFoundationReady();
      const batch = await provisionSpecialists({
        batch: {
          requests: [{
            agent_id: "implementation-001",
            task_id: "TASK-1",
            role_id: "implementation",
            recommended_model: "Terra",
            status: "pending"
          }]
        }
      });
      return {
        status: "completed",
        foundation,
        batch
      };
    }
  };

  const result = await runOrquestaTask({
    workspaceRoot,
    runtimeRoot,
    prompt: "Create organization.json",
    setupRuntime,
    agentExecutor: executor,
    acceptanceReconciler: fakeAcceptanceReconciler,
    acceptanceVerifier: async () => verifierResults.shift(),
    now: (() => {
      let time = 0;
      return () => {
        time += 100;
        return time;
      };
    })()
  });

  assert.equal(result.status, "completed");
  assert.equal(result.bootstrap_metrics.thread_ids.length, 3);
  assert.equal(result.main_metrics.specialist_thread_ids.length, 1);
  assert.equal(result.main_metrics.orchestrator_thread_id, "thread-orchestrator");
  assert.equal(result.main_metrics.wall_time_ms > 0, true);
  assert.equal(
    await fs.readFile(
      path.join(workspaceRoot, ".agents", "skills", "orquesta", "SKILL.md"),
      "utf8"
    ),
    "# Orquesta fixture\n"
  );
  const finalCall = executor.calls.find(([name]) => name === "finalizeOrchestrator");
  assert.equal(finalCall[1].threadId, "thread-orchestrator");
  assert.equal(finalCall[1].receipts.length, 1);
  assert.equal(finalCall[1].receipts[0].agent_id, "implementation-001");
  assert.equal(finalCall[1].receipts[0].initial_turn_id, "turn-4");
  assert.equal(finalCall[1].receipts[0].correction_turn_id, "turn-5");
  assert.match(finalCall[1].prompt, /Do not modify implementation artifacts/);
  assert.match(finalCall[1].prompt, /\.orquesta\/reviews\/TASK-1-orchestrator\.json/);
  assert.match(finalCall[1].prompt, /fixture passed/);
  const correctionCall = executor.calls.find(([name]) => name === "continueAgent");
  assert.match(correctionCall[1].prompt, /fixture mismatch/);
  const specialistCall = executor.calls.find(([name, input]) => (
    name === "startAgent" && input.agentId === "implementation-001"
  ));
  assert.equal(specialistCall[1].model, "gpt-5.6-terra");
  assert.equal(specialistCall[1].effort, "medium");
  assert.match(specialistCall[1].prompt, /This is not a coordination or state-management turn/);
  assert.match(specialistCall[1].prompt, /Do not load coordinator skills/);
  assert.match(specialistCall[1].prompt, /specialist_result/);
  assert.match(specialistCall[1].prompt, /"status": "none"/);
  assert.doesNotMatch(specialistCall[1].prompt, /none_or_submitted/);
  assert.doesNotMatch(specialistCall[1].prompt, /Read the repository Orquesta skill/);
});

test("does not invent specialists when setup returns an empty batch", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orquesta-runner-inline-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtimeRoot = await runtimeFixture(root);
  const workspaceRoot = path.join(root, "workspace");
  await fs.mkdir(workspaceRoot);
  const executor = fakeExecutor();
  const setupRuntime = {
    requiresStateEvidence: false,
    async run({ provisionFoundation, provisionSpecialists, onFoundationReady }) {
      await provisionFoundation({
        agentIds: ["orchestrator", "orquesta-admin", "user-support"]
      });
      onFoundationReady();
      const batch = await provisionSpecialists({ batch: { requests: [] } });
      return { status: "completed", batch };
    }
  };

  const result = await runOrquestaTask({
    workspaceRoot,
    runtimeRoot,
    prompt: "Small task",
    setupRuntime,
    agentExecutor: executor,
    acceptanceReconciler: fakeAcceptanceReconciler
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(result.main_metrics.specialist_thread_ids, []);
  assert.equal(
    executor.calls.filter(([name]) => name === "finalizeOrchestrator").length,
    1
  );
  assert.match(
    executor.calls.find(([name]) => name === "finalizeOrchestrator")[1].prompt,
    /Complete the task directly and verify the output/
  );
  assert.equal(
    executor.calls.filter(([name, input]) => (
      name === "startAgent"
      && !["orchestrator", "orquesta-admin", "user-support"].includes(input.agentId)
    )).length,
    0
  );
});

test("runs inline-verified work once on the recommended model", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orquesta-runner-direct-model-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtimeRoot = await runtimeFixture(root);
  const workspaceRoot = path.join(root, "workspace");
  await fs.mkdir(path.join(workspaceRoot, ".orquesta", "setup"), { recursive: true });
  const executor = fakeExecutor();
  const setupRuntime = {
    requiresStateEvidence: false,
    async run({ provisionFoundation, onFoundationReady }) {
      await provisionFoundation({ agentIds: ["orchestrator", "orquesta-admin", "user-support"] });
      onFoundationReady();
      await fs.writeFile(
        path.join(workspaceRoot, ".orquesta", "setup", "provisioning_batch.json"),
        `${JSON.stringify({
          requests: [{
            agent_id: "testing-001",
            task_id: "TASK-DIRECT",
            status: "inline_verified",
            recommended_model: "Terra",
          }],
        })}\n`,
        "utf8",
      );
      return { status: "completed" };
    },
  };

  const result = await runOrquestaTask({
    workspaceRoot,
    runtimeRoot,
    prompt: "Create artifact.json",
    setupRuntime,
    agentExecutor: executor,
    acceptanceReconciler: fakeAcceptanceReconciler,
    acceptanceVerifier: async () => ({
      status: "passed",
      passed: true,
      output: "fixture passed",
      acceptance_authority: "deterministic",
    }),
  });

  const directCall = executor.calls.find(([name, input]) => (
    name === "startAgent" && input.agentId === "testing-001"
  ));
  assert.equal(result.status, "completed");
  assert.equal(directCall[1].model, "gpt-5.6-terra");
  assert.equal(directCall[1].effort, "medium");
  assert.match(directCall[1].prompt, /single execution owner/);
  assert.equal(executor.calls.filter(([name]) => name === "finalizeOrchestrator").length, 0);
  assert.deepEqual(result.main_metrics.specialist_thread_ids, []);
  assert.deepEqual(result.main_metrics.direct_thread_ids, ["thread-testing-001"]);
  assert.equal(result.final.turn_id, "turn-4");
  assert.equal(result.final.review_mode, "solo_direct_authoritative_verifier");
});

test("corrects a rejected solo-direct result once before accepting it", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orquesta-runner-inline-correction-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtimeRoot = await runtimeFixture(root);
  const workspaceRoot = path.join(root, "workspace");
  await fs.mkdir(path.join(workspaceRoot, ".orquesta", "setup"), { recursive: true });
  const executor = fakeExecutor();
  const verifierCalls = [];
  const verifierResults = [
    { status: "failed", passed: false, output: "artifact mismatch", acceptance_authority: "deterministic" },
    { status: "passed", passed: true, output: "fixture passed", acceptance_authority: "deterministic" },
  ];
  const setupRuntime = {
    requiresStateEvidence: false,
    async run({ provisionFoundation, provisionSpecialists, onFoundationReady }) {
      await provisionFoundation({ agentIds: ["orchestrator", "orquesta-admin", "user-support"] });
      onFoundationReady();
      await provisionSpecialists({ batch: { requests: [] } });
      await fs.writeFile(
        path.join(workspaceRoot, ".orquesta", "setup", "provisioning_batch.json"),
        `${JSON.stringify({
          requests: [{
            agent_id: "testing-001",
            task_id: "TASK-DIRECT-CORRECTION",
            status: "inline_verified",
            recommended_model: "Terra",
          }],
        })}\n`,
        "utf8",
      );
      return { status: "completed" };
    },
  };

  const result = await runOrquestaTask({
    workspaceRoot,
    runtimeRoot,
    prompt: "Create artifact.json",
    setupRuntime,
    agentExecutor: executor,
    acceptanceReconciler: fakeAcceptanceReconciler,
    acceptanceVerifier: async () => {
      verifierCalls.push("verify");
      return verifierResults.shift();
    },
  });

  assert.equal(result.status, "completed");
  assert.equal(verifierCalls.length, 2);
  assert.equal(executor.calls.filter(([name]) => name === "finalizeOrchestrator").length, 0);
  assert.equal(executor.calls.filter(([name]) => name === "continueAgent").length, 1);
  assert.equal(
    executor.calls.find(([name]) => name === "continueAgent")[1].threadId,
    "thread-testing-001"
  );
  assert.match(
    executor.calls.find(([name]) => name === "continueAgent")[1].prompt,
    /authoritative deterministic verifier rejected your solo-direct output/
  );
  assert.equal(result.final.turn_id, "turn-5");
  assert.equal(result.final.review_mode, "solo_direct_authoritative_verifier");
});

test("steady startup reuses same-project foundation sessions without recreating agents", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orquesta-runner-steady-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtimeRoot = await runtimeFixture(root);
  const workspaceRoot = path.join(root, "workspace");
  await fs.mkdir(workspaceRoot);
  const foundationSessionPool = {};
  const setupRuntime = {
    requiresStateEvidence: false,
    async run({ provisionFoundation, provisionSpecialists, onFoundationReady }) {
      await provisionFoundation({
        agentIds: ["orchestrator", "orquesta-admin", "user-support"]
      });
      onFoundationReady();
      await provisionSpecialists({ batch: { requests: [] } });
      return { status: "completed" };
    }
  };

  const coldExecutor = fakeExecutor();
  const cold = await runOrquestaTask({
    workspaceRoot,
    runtimeRoot,
    prompt: "Small task",
    setupRuntime,
    agentExecutor: coldExecutor,
    acceptanceReconciler: fakeAcceptanceReconciler,
    startupMode: "cold",
    foundationSessionPool
  });
  assert.equal(cold.status, "completed");
  assert.equal(cold.bootstrap_metrics.foundation_generated_count, 3);
  assert.equal(cold.bootstrap_metrics.foundation_reused_count, 0);

  const steadyExecutor = fakeExecutor();
  const steady = await runOrquestaTask({
    workspaceRoot,
    runtimeRoot,
    prompt: "Follow-up task",
    setupRuntime,
    agentExecutor: steadyExecutor,
    acceptanceReconciler: fakeAcceptanceReconciler,
    startupMode: "steady",
    foundationSessionPool
  });

  assert.equal(steady.status, "completed");
  assert.equal(steady.startup_mode, "steady");
  assert.equal(steady.bootstrap_metrics.foundation_generated_count, 0);
  assert.equal(steady.bootstrap_metrics.foundation_reused_count, 3);
  assert.deepEqual(
    steady.bootstrap_metrics.thread_ids,
    ["thread-orchestrator", "thread-orquesta-admin", "thread-user-support"]
  );
  assert.equal(
    steadyExecutor.calls.some(([name]) => name === "startAgent"),
    false
  );
});

test("prepares steady execution with foundation turns only", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orquesta-runner-warmup-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtimeRoot = await runtimeFixture(root);
  const workspaceRoot = path.join(root, "workspace");
  await fs.mkdir(workspaceRoot);
  const executor = fakeExecutor();
  const foundationSessionPool = {};
  const setupRuntime = {
    async run({ provisionFoundation, provisionSpecialists, onFoundationReady }) {
      await provisionFoundation({ agentIds: ["orchestrator", "orquesta-admin", "user-support"] });
      onFoundationReady();
      await provisionSpecialists({
        batch: { requests: [{ agent_id: "testing-001", status: "inline_verified" }] },
      });
      return { status: "completed" };
    },
  };

  const prepared = await prepareSteadyOrquestaTask({
    workspaceRoot,
    runtimeRoot,
    setupRuntime,
    agentExecutor: executor,
    foundationSessionPool,
  });

  assert.equal(prepared.metrics.foundation_generated_count, 3);
  assert.equal(prepared.metrics.excluded_from_measured_run, true);
  assert.deepEqual(Object.keys(foundationSessionPool).sort(), [
    "orchestrator",
    "orquesta-admin",
    "user-support",
  ]);
  assert.equal(executor.calls.filter(([name]) => name === "startAgent").length, 3);
  assert.equal(executor.calls.some(([name]) => name === "finalizeOrchestrator"), false);
});

test("uses an authoritative deterministic verifier without a duplicate Sol review turn", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orquesta-runner-deterministic-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtimeRoot = await runtimeFixture(root);
  const workspaceRoot = path.join(root, "workspace");
  await fs.mkdir(workspaceRoot);
  const executor = fakeExecutor();
  const deterministicCalls = [];
  const setupRuntime = {
    requiresStateEvidence: false,
    async run({ provisionFoundation, provisionSpecialists, onFoundationReady }) {
      await provisionFoundation({
        agentIds: ["orchestrator", "orquesta-admin", "user-support"]
      });
      onFoundationReady();
      await provisionSpecialists({
        batch: {
          requests: [{
            agent_id: "implementation-001",
            task_id: "TASK-1",
            role_id: "implementation",
            recommended_model: "Terra",
            specialist_report_path: ".orquesta/reports/TASK-1-implementation-001.md",
            status: "pending"
          }]
        }
      });
      return { status: "completed" };
    }
  };

  const result = await runOrquestaTask({
    workspaceRoot,
    runtimeRoot,
    prompt: "Create artifact.json",
    setupRuntime,
    agentExecutor: executor,
    acceptanceReconciler: fakeAcceptanceReconciler,
    deterministicReviewer: async (input) => {
      deterministicCalls.push(input);
      return [];
    },
    acceptanceVerifier: async () => ({
      status: "passed",
      passed: true,
      output: "fixture passed",
      acceptance_authority: "deterministic",
    }),
  });

  assert.equal(result.status, "completed");
  assert.equal(deterministicCalls.length, 1);
  assert.equal(
    executor.calls.some(([name]) => name === "finalizeOrchestrator"),
    false,
  );
  assert.equal(result.final.review_mode, "authoritative_deterministic_verifier");
  assert.equal(result.final.actual_model, null);
});

test("fails when setup never reaches the foundation boundary", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orquesta-runner-blocked-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtimeRoot = await runtimeFixture(root);
  const workspaceRoot = path.join(root, "workspace");
  await fs.mkdir(workspaceRoot);
  const executor = fakeExecutor();

  const result = await runOrquestaTask({
    workspaceRoot,
    runtimeRoot,
    prompt: "Task",
    setupRuntime: {
      requiresStateEvidence: false,
      async run() {
        return { status: "blocked" };
      }
    },
    agentExecutor: executor,
    acceptanceReconciler: fakeAcceptanceReconciler
  });

  assert.equal(result.status, "infrastructure_error");
  assert.equal(result.error.code, "foundation_not_ready");
  assert.equal(
    executor.calls.some(([name]) => name === "finalizeOrchestrator"),
    false
  );
});

test("rejects an Orquesta agent whose applied App Server profile differs", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orquesta-profile-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let turnStarts = 0;
  const executor = createAppServerAgentExecutor({
    workspaceRoot: root,
    profile: {
      execution: {
        model: "gpt-5.6-sol",
        reasoning_effort: "high",
        sandbox: "workspace-write",
        approval_policy: "never",
        agent_timeout_sec: 900
      }
    },
    adapter: {
      async subscribeEvents() {
        return { subscription: { unsubscribe() {} } };
      },
      async createThread() {
        return {
          ok: true,
          thread_id: "thread-mismatch",
          applied_model: "gpt-5.6-sol",
          runtime_profile: {
            cwd: root,
            sandbox: "read-only",
            approval_policy: "never"
          }
        };
      },
      async startTurn() {
        turnStarts += 1;
        return { ok: true, turn_id: "turn-should-not-start" };
      },
      async archiveThread(input) {
        assert.equal(input.threadId, "thread-mismatch");
        return { ok: true, thread_id: input.threadId };
      },
      async shutdown() {
        return { ok: true };
      }
    }
  });

  await assert.rejects(executor.startAgent({
    agentId: "orchestrator",
    model: "gpt-5.6-sol",
    prompt: "ready"
  }), /sandbox/i);
  assert.equal(turnStarts, 0);
  await executor.shutdown();
});
