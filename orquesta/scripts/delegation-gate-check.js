#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const REVIEW_STATES = new Set([
  "active",
  "completed",
  "report_submitted",
  "needs_review",
  "needs_orchestrator_review",
  "accepted"
]);

const SPECIALIST_HINTS = [
  "dashboard",
  "visualizer",
  "ui",
  "readme",
  "docs",
  "documentation",
  "protocol",
  "schema",
  "bootstrap",
  "setup",
  "implementation",
  "server",
  "script",
  "encoding",
  "github"
];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function hasReportArtifact(task) {
  if (task.specialist_report_path || task.report) return true;
  return (task.artifacts || []).some((artifact) => {
    const value = String(artifact || "").toLowerCase();
    return value.includes(".orquesta/reports/") || value.includes("\\.orquesta\\reports\\");
  });
}

function looksLikeSpecialistDomain(task) {
  const text = [
    task.title,
    task.result_summary,
    ...(task.artifacts || [])
  ].join(" ").toLowerCase();
  return SPECIALIST_HINTS.some((hint) => text.includes(hint));
}

function checkTask(task) {
  const errors = [];
  const warnings = [];
  const id = task.task_id || "(unknown task)";
  const stateNeedsGate = REVIEW_STATES.has(task.state);

  if (task.routing_class === "specialist_required" && stateNeedsGate) {
    if (task.handoff_required !== false && !task.handoff_sent_at) {
      errors.push(`${id}: specialist_required task is ${task.state} but has no handoff_sent_at`);
    }

    if (task.state === "accepted" && task.specialist_report_required !== false && !hasReportArtifact(task)) {
      errors.push(`${id}: specialist_required task is accepted but has no specialist report path or report artifact`);
    }

    if (task.routing_gate_status === "passed" && !task.handoff_sent_at) {
      errors.push(`${id}: routing_gate_status is passed but handoff_sent_at is missing`);
    }
  }

  if (task.routing_class === "direct_exception" && stateNeedsGate) {
    if (!task.direct_exception_reason) {
      errors.push(`${id}: direct_exception task is ${task.state} but has no direct_exception_reason`);
    }
    if (task.routing_gate_status !== "bypassed_with_reason") {
      errors.push(`${id}: direct_exception task must use routing_gate_status=bypassed_with_reason`);
    }
  }

  if (!task.routing_class && task.owner_agent_id === "orchestrator" && stateNeedsGate && looksLikeSpecialistDomain(task)) {
    warnings.push(`${id}: orchestrator-owned ${task.state} task looks like specialist-domain work; add routing_class or direct_exception on future tasks`);
  }

  return { errors, warnings };
}

function checkDelegationGate(rootDir) {
  const tasksPath = path.join(rootDir, ".orquesta", "state", "tasks.json");
  if (!fs.existsSync(tasksPath)) {
    return { errors: [], warnings: [`No tasks.json found at ${tasksPath}; delegation gate skipped.`] };
  }

  const state = readJson(tasksPath);
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  const result = { errors: [], warnings: [] };

  for (const task of tasks) {
    const taskResult = checkTask(task);
    result.errors.push(...taskResult.errors);
    result.warnings.push(...taskResult.warnings);
  }

  return result;
}

function main() {
  const rootDir = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
  const result = checkDelegationGate(rootDir);

  for (const warning of result.warnings) {
    console.warn(`delegation warning: ${warning}`);
  }

  if (result.errors.length > 0) {
    for (const error of result.errors) {
      console.error(`delegation error: ${error}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("delegation gate check passed");
}

if (require.main === module) {
  main();
}

module.exports = {
  checkDelegationGate,
  checkTask,
  hasReportArtifact,
  looksLikeSpecialistDomain
};
