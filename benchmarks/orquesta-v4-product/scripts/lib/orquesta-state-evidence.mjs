import fs from "node:fs/promises";
import path from "node:path";

const FOUNDATION_AGENT_IDS = new Set([
  "orchestrator",
  "orquesta-admin",
  "user-support"
]);

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function exists(filePath) {
  return fs.stat(filePath).then((stat) => stat.isFile(), () => false);
}

export async function readOrquestaStateEvidence({
  workspaceRoot,
  observedThreadIds
}) {
  const errors = [];
  const stateRoot = path.join(workspaceRoot, ".orquesta", "state");
  let agentsState;
  let sessionsState;
  let tasksState;
  try {
    [agentsState, sessionsState, tasksState] = await Promise.all([
      readJson(path.join(stateRoot, "agents.json")),
      readJson(path.join(stateRoot, "sessions.json")),
      readJson(path.join(stateRoot, "tasks.json"))
    ]);
  } catch (error) {
    return {
      valid: false,
      foundation_threads: 0,
      specialist_threads: 0,
      errors: [`canonical Orquesta state is unreadable: ${error.message}`]
    };
  }

  const observed = new Set(observedThreadIds || []);
  const agents = new Map((agentsState.agents || []).map((agent) => [agent.agent_id, agent]));
  const sessions = new Map(
    (sessionsState.sessions || []).map((session) => [session.agent_id, session])
  );
  const specialistThreadIds = new Set();

  for (const agentId of FOUNDATION_AGENT_IDS) {
    const agent = agents.get(agentId);
    const session = sessions.get(agentId);
    if (!agent) errors.push(`foundation agent is missing: ${agentId}`);
    if (!session?.thread_id) errors.push(`foundation session thread is missing: ${agentId}`);
    if (!session?.handoff_turn_id) errors.push(`foundation handoff turn is missing: ${agentId}`);
    if (
      agent?.thread_id
      && session?.thread_id
      && agent.thread_id !== session.thread_id
    ) {
      errors.push(`foundation agent/session thread mismatch: ${agentId}`);
    }
    if (session?.thread_id && !observed.has(session.thread_id)) {
      errors.push(`foundation thread is not an observed App Server thread: ${agentId}`);
    }
  }

  for (const [agentId, session] of sessions) {
    if (FOUNDATION_AGENT_IDS.has(agentId) || !session?.thread_id) continue;
    specialistThreadIds.add(session.thread_id);
    if (!observed.has(session.thread_id)) {
      errors.push(`specialist thread is not an observed App Server thread: ${agentId}`);
    }
    if (agents.get(agentId)?.thread_id !== session.thread_id) {
      errors.push(`specialist agent/session thread mismatch: ${agentId}`);
    }
  }

  for (const task of tasksState.tasks || []) {
    if (task.routing_class !== "specialist_required") continue;
    const owner = task.owner_agent_id;
    const session = sessions.get(owner);
    if (!owner || !agents.has(owner)) {
      errors.push(`specialist task owner is missing: ${task.task_id}`);
      continue;
    }
    if (!session?.thread_id) errors.push(`specialist session is missing: ${task.task_id}`);
    if (task.handoff_required && !task.handoff_sent_at) {
      errors.push(`specialist handoff evidence is missing: ${task.task_id}`);
    }
    if (task.handoff_required && !session?.handoff_turn_id) {
      errors.push(`specialist handoff turn is missing: ${task.task_id}`);
    }
    if (task.specialist_report_required) {
      if (!task.specialist_report_path) {
        errors.push(`specialist report path is missing: ${task.task_id}`);
      } else {
        const reportPath = path.resolve(workspaceRoot, task.specialist_report_path);
        const relative = path.relative(workspaceRoot, reportPath);
        if (relative.startsWith("..") || path.isAbsolute(relative)) {
          errors.push(`specialist report escapes the workspace: ${task.task_id}`);
        } else if (!(await exists(reportPath))) {
          errors.push(`specialist report is missing: ${task.task_id}`);
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    foundation_threads: [...FOUNDATION_AGENT_IDS]
      .filter((agentId) => observed.has(sessions.get(agentId)?.thread_id))
      .length,
    specialist_threads: specialistThreadIds.size,
    errors
  };
}
