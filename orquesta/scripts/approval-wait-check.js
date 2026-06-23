const fs = require("fs");
const path = require("path");

const CLOSED_STATUSES = new Set(["resolved", "skipped", "retired"]);
const USER_APPROVAL_BLOCKERS = new Set([
  "user_approval_required",
  "codex_safety_approval",
  "scope_expansion_approval",
  "destructive_action_approval",
  "environment_permission_approval"
]);

function readJsonIfExists(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function isClosed(status) {
  return CLOSED_STATUSES.has(String(status || "").toLowerCase());
}

function arrayValues(value) {
  return Array.isArray(value) ? value.filter(Boolean).map(String) : [];
}

function linkedSourceIds(task) {
  return [
    ...arrayValues(task.source_ids),
    ...arrayValues(task.source_task_ids),
    task.source_task_id,
    task.task_id
  ].filter(Boolean).map(String);
}

function hasText(value) {
  return String(value || "").trim().length > 0;
}

function validateApprovalWaits(state) {
  const errors = [];
  const warnings = [];
  const userTasks = state.userTasks?.tasks || [];
  const tasks = state.tasks || [];
  const openApprovalWaits = userTasks.filter((task) => task.source === "approval_wait" && !isClosed(task.status));

  openApprovalWaits.forEach((task) => {
    const id = task.user_task_id || "(missing user_task_id)";
    const requiredFields = ["user_task_id", "status", "title", "approval_type", "requested_action", "resume_instruction"];
    requiredFields.forEach((field) => {
      if (!hasText(task[field])) {
        errors.push(`${id}: approval_wait is missing ${field}`);
      }
    });
    if (!hasText(task.prompt) && !hasText(task.reason)) {
      errors.push(`${id}: approval_wait needs prompt or reason`);
    }
    if (!linkedSourceIds(task).length) {
      errors.push(`${id}: approval_wait needs source_ids or source_task_id`);
    }
    if (!hasText(task.source_agent_id) && !hasText(task.support_agent_id) && !hasText(task.assigned_by)) {
      errors.push(`${id}: approval_wait needs source_agent_id, support_agent_id, or assigned_by`);
    }
  });

  tasks.forEach((task) => {
    const blockers = arrayValues(task.blocked_by).map((blocker) => blocker.toLowerCase());
    const needsUserApproval = blockers.some((blocker) => USER_APPROVAL_BLOCKERS.has(blocker));
    if (!needsUserApproval || isClosed(task.state)) return;
    const hasVisibleWait = openApprovalWaits.some((wait) => linkedSourceIds(wait).includes(String(task.task_id)));
    if (!hasVisibleWait) {
      errors.push(`${task.task_id}: task is blocked by user approval but has no open approval_wait user task`);
    }
  });

  return { errors, warnings, approvalWaitCount: openApprovalWaits.length };
}

function loadProjectState(rootDir) {
  return {
    userTasks: readJsonIfExists(path.join(rootDir, ".orquesta", "user_tasks", "queue.json"), { tasks: [] }),
    tasks: readJsonIfExists(path.join(rootDir, ".orquesta", "state", "tasks.json"), { tasks: [] }).tasks || []
  };
}

function main() {
  const rootDir = process.cwd();
  const result = validateApprovalWaits(loadProjectState(rootDir));
  result.warnings.forEach((warning) => console.warn(`approval-wait warning: ${warning}`));
  if (result.errors.length) {
    result.errors.forEach((error) => console.error(`approval-wait error: ${error}`));
    process.exitCode = 1;
    return;
  }
  console.log(`approval-wait-check ok (${result.approvalWaitCount} open approval waits)`);
}

if (require.main === module) {
  main();
}

module.exports = {
  validateApprovalWaits,
  loadProjectState
};
