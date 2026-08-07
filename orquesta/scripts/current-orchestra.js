"use strict";

function oneLine(value, fallback) {
  return String(value ?? fallback).replace(/\s+/gu, " ").trim() || fallback;
}

function buildCurrentOrchestra({
  setupState,
  now,
  status = "in_progress",
  agentsState = { agents: [] },
  tasksState = { tasks: [] },
  directivesState = { directives: [] },
  dashboardUrl = null,
}) {
  const ready = status === "ready";
  const agents = Array.isArray(agentsState.agents) ? agentsState.agents : [];
  const tasks = Array.isArray(tasksState.tasks) ? tasksState.tasks : [];
  const directives = Array.isArray(directivesState.directives) ? directivesState.directives : [];
  const closedTaskStates = new Set(["accepted", "adopted", "archived", "completed", "done", "rejected", "retired", "skipped", "superseded"]);
  const openTasks = tasks.filter((task) => !closedTaskStates.has(String(task.state || task.status || "").toLowerCase()));
  const agentLines = agents.length
    ? agents.map((agent) => `- ${oneLine(agent.agent_id, "unknown-agent")}: ${oneLine(agent.operational_status || agent.status || agent.lifecycle_state, "unknown")}`)
    : ["- None yet."];
  const taskLines = tasks.length
    ? tasks.map((task) => `- ${oneLine(task.task_id, "unknown-task")}: ${oneLine(task.state || task.status, "unknown")} (${oneLine(task.owner_agent_id, "unassigned")})`)
    : ["- None yet."];
  const directiveLines = directives.length
    ? directives.map((directive) => `- ${oneLine(directive.directive_id, "unknown-directive")}: ${oneLine(directive.summary, "No summary")} [${oneLine(directive.status, "unknown")}]`)
    : ["- None."];
  return [
    "# Current Orchestra",
    "",
    `Updated at: ${now}`,
    `Project: ${oneLine(setupState.project_title || setupState.project_name, "Orquesta project")} (${oneLine(setupState.project_id, "unknown-project")})`,
    `Setup status: ${ready ? "ready" : "in_progress"}`,
    `Current phase: ${ready ? "operation" : oneLine(setupState.current_phase_id, "environment")}`,
    "",
    "## Agents",
    ...agentLines,
    "",
    "## Tasks",
    ...taskLines,
    "",
    "## Blockers",
    ready ? "- None." : "- Initial setup is in progress.",
    "",
    "## Directives",
    ...directiveLines,
    "",
    "## Next actions",
    ready
      ? (openTasks.length ? "- Continue orchestration from the open tasks." : "- No initial work is open. Compile the next user-approved task before dispatch.")
      : "- Continue the automatic initial setup.",
    "",
    "## Local Dashboard Paths",
    `- Dashboard URL: ${dashboardUrl || "not running"}`,
    "",
  ].join("\n");
}

module.exports = { buildCurrentOrchestra };
