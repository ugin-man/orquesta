"use strict";

const path = require("node:path");
const { assertContract } = require("@orquesta/contracts");
const { applyOrganizationDecision } = require("@orquesta/core");
const {
  readJsonFile,
  updateJsonAtomic,
} = require("./json-state");
const {
  commitOrganizationTransition,
  readOrganizationBundle,
} = require("./organization-state");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function decisionPaths(root) {
  return {
    decisions: path.join(root, ".orquesta", "state", "organization-decisions.json"),
    userTasks: path.join(root, ".orquesta", "user_tasks", "queue.json"),
    provisioningBatch: path.join(root, ".orquesta", "setup", "provisioning_batch.json"),
  };
}

function defaultDecisionLedger() {
  return { schema_version: 1, decisions: [], updated_at: null };
}

function defaultUserTaskQueue() {
  return {
    version: 1,
    owner_agent_id: "user-support",
    tasks: [],
    sources: ["organization_line_approval"],
    updated_at: null,
  };
}

function lineUserTaskId(decisionId) {
  return `UT-LINE-${decisionId.replace(/^OD-/, "")}`;
}

function contractDecision(decision) {
  return {
    decision_id: decision.decision_id,
    task_intent_id: decision.task_intent_id,
    organization_revision: decision.organization_revision,
    input_hash: decision.input_hash,
    mode: decision.mode,
    selected_action: decision.selected_action,
    reason_codes: clone(decision.reason_codes),
    requires_user_approval: decision.requires_user_approval,
    approval_state: decision.approval_state,
    proposed_line: clone(decision.proposed_line),
    created_at: decision.created_at,
  };
}

function lineUserTask(decision, now) {
  const line = decision.proposed_line;
  return {
    user_task_id: lineUserTaskId(decision.decision_id),
    source: "approval_wait",
    source_kind: "organization_line_approval",
    source_ids: [decision.decision_id],
    assigned_by: "user-support",
    support_agent_id: "user-support",
    status: "ready",
    priority: "high",
    title: `Approve new line: ${line.display_name}`,
    prompt: `Orquesta proposes a new production line for ${line.goal}. Scope: ${line.scope.join(", ")}.`,
    approval_type: "organization_line_approval",
    requested_action: "Approve or reject creation of this production line.",
    resume_instruction: `After approval, apply organization decision ${decision.decision_id}.`,
    expected_response: "approve_or_reject_with_optional_note",
    review_choices: ["approve", "reject"],
    created_at: now,
    resolved_at: null,
    result: null,
  };
}

function readDecisionLedger(root) {
  return readJsonFile(decisionPaths(root).decisions, defaultDecisionLedger());
}

function findDecision(ledger, decisionId) {
  return (ledger.decisions || []).find((entry) => entry.decision_id === decisionId);
}

function mergeById(current, additions, field) {
  const byId = new Map((current || []).map((entry) => [entry[field], clone(entry)]));
  for (const addition of additions || []) {
    if (byId.has(addition[field])) throw new TypeError(`duplicate ${field}: ${addition[field]}`);
    byId.set(addition[field], clone(addition));
  }
  return [...byId.values()].sort((left, right) => compareText(String(left[field]), String(right[field])));
}

function markDecisionApplied(paths, decisionId, now) {
  let committed;
  updateJsonAtomic(paths.decisions, defaultDecisionLedger(), (current) => {
    const existing = findDecision(current, decisionId);
    if (!existing) throw new TypeError(`organization decision not found: ${decisionId}`);
    committed = { ...existing, status: "applied", applied_at: existing.applied_at || now };
    return {
      ...current,
      decisions: (current.decisions || []).map((entry) => entry.decision_id === decisionId ? committed : entry),
      updated_at: now,
    };
  }, { backup: true });
  return committed;
}

function normalizeProvisioningRequests(requests, tasksState, now) {
  const taskIds = new Set((tasksState.tasks || []).map((task) => task.task_id));
  const agentIds = new Set();
  const ownedTaskIds = new Set();
  return requests.map((request) => {
    for (const field of ["agent_id", "role_id", "team_id", "line_id", "task_id"]) {
      if (!String(request?.[field] || "").trim()) throw new TypeError(`provisioning request requires ${field}`);
    }
    if (!taskIds.has(request.task_id)) throw new TypeError(`provisioning request task not found: ${request.task_id}`);
    if (agentIds.has(request.agent_id)) throw new TypeError(`duplicate provisioning agent_id: ${request.agent_id}`);
    if (ownedTaskIds.has(request.task_id)) throw new TypeError(`duplicate provisioning task_id: ${request.task_id}`);
    agentIds.add(request.agent_id);
    ownedTaskIds.add(request.task_id);
    return {
      agent_id: request.agent_id,
      role_id: request.role_id,
      team_id: request.team_id,
      line_id: request.line_id,
      task_id: request.task_id,
      status: "pending",
      created_at: request.created_at || now,
      thread_id: null,
      turn_id: null,
      handoff_status: null,
      error: null,
      completed_at: null,
    };
  });
}

function persistProvisioningRequests({ root, decision, requests, organizationRevision, tasksState, now }) {
  if (!requests.length) return null;
  const normalized = normalizeProvisioningRequests(requests, tasksState, now);
  const batchPath = decisionPaths(root).provisioningBatch;
  let saved;
  updateJsonAtomic(batchPath, {
    provisioning_batch_id: `PB-${decision.decision_id.replace(/^OD-/, "")}`,
    organization_revision: organizationRevision,
    max_concurrent_provisioning: 3,
    requests: [],
    created_at: now,
    updated_at: now,
  }, (current) => {
    const byAgent = new Map((current.requests || []).map((request) => [request.agent_id, clone(request)]));
    for (const request of normalized) {
      const existing = byAgent.get(request.agent_id);
      if (existing && existing.task_id !== request.task_id) {
        throw new TypeError(`agent ${request.agent_id} already has a different provisioning task`);
      }
      if (!existing) byAgent.set(request.agent_id, request);
    }
    saved = {
      ...current,
      provisioning_batch_id: current.provisioning_batch_id || `PB-${decision.decision_id.replace(/^OD-/, "")}`,
      organization_revision: organizationRevision,
      max_concurrent_provisioning: 3,
      requests: [...byAgent.values()].sort((left, right) => compareText(left.agent_id, right.agent_id)),
      created_at: current.created_at || now,
      updated_at: now,
    };
    return saved;
  }, { backup: true });
  return saved;
}

function recordOrganizationDecision({ root, decision, now } = {}) {
  if (!root || !decision || !now) throw new TypeError("root, decision, and now are required");
  const canonicalDecision = contractDecision(decision);
  assertContract("organization-decision", canonicalDecision);
  const paths = decisionPaths(root);
  let stored;
  updateJsonAtomic(paths.decisions, defaultDecisionLedger(), (current) => {
    const existing = findDecision(current, decision.decision_id);
    if (existing) {
      if (existing.input_hash !== decision.input_hash) {
        throw new TypeError(`organization decision ${decision.decision_id} has conflicting input_hash`);
      }
      stored = clone(existing);
      return current;
    }
    stored = {
      ...canonicalDecision,
      status: decision.requires_user_approval ? "pending_user" : "ready",
      recorded_at: now,
      resolved_at: null,
      applied_at: null,
    };
    return {
      ...current,
      schema_version: 1,
      decisions: [...(current.decisions || []), stored],
      updated_at: now,
    };
  }, { backup: true });

  if (decision.selected_action === "propose_line") {
    updateJsonAtomic(paths.userTasks, defaultUserTaskQueue(), (current) => {
      const taskId = lineUserTaskId(decision.decision_id);
      if ((current.tasks || []).some((task) => task.user_task_id === taskId)) return current;
      const sources = [...new Set([...(current.sources || []), "organization_line_approval"])];
      return {
        ...current,
        version: current.version || 1,
        owner_agent_id: current.owner_agent_id || "user-support",
        tasks: [...(current.tasks || []), lineUserTask(decision, now)],
        sources,
        updated_at: now,
      };
    }, { backup: true });
  }

  return stored;
}

function resolveLineDecision({ root, decisionId, approved, note = "", now } = {}) {
  if (!root || !decisionId || typeof approved !== "boolean" || !now) {
    throw new TypeError("root, decisionId, approved, and now are required");
  }
  const paths = decisionPaths(root);
  let resolved;
  updateJsonAtomic(paths.decisions, defaultDecisionLedger(), (current) => {
    const existing = findDecision(current, decisionId);
    if (!existing || existing.selected_action !== "propose_line") {
      throw new TypeError(`organization line decision not found: ${decisionId}`);
    }
    if (existing.status === "applied") {
      resolved = clone(existing);
      return current;
    }
    resolved = {
      ...existing,
      approval_state: approved ? "approved" : "pending_user",
      status: approved ? "approved" : "rejected",
      resolved_at: now,
      resolution: { approved, note },
    };
    return {
      ...current,
      decisions: (current.decisions || []).map((entry) => entry.decision_id === decisionId ? resolved : entry),
      updated_at: now,
    };
  }, { backup: true });

  updateJsonAtomic(paths.userTasks, defaultUserTaskQueue(), (current) => ({
    ...current,
    tasks: (current.tasks || []).map((task) => task.source_ids?.includes(decisionId) ? {
      ...task,
      status: "resolved",
      resolved_at: now,
      result: { decision: approved ? "approved" : "rejected", note },
    } : task),
    updated_at: now,
  }), { backup: true });
  return resolved;
}

function commitAutonomousOrganizationDecision({
  root,
  decision,
  changes = {},
  roleDefinitions = [],
  agentRecords = [],
  provisioningRequests = [],
  now,
} = {}) {
  if (!root || !decision || !now) throw new TypeError("root, decision, and now are required");
  const canonicalDecision = contractDecision(decision);
  assertContract("organization-decision", canonicalDecision);
  if (canonicalDecision.requires_user_approval || canonicalDecision.selected_action === "propose_line") {
    throw new TypeError("new production lines must use the user approval flow");
  }
  const paths = decisionPaths(root);
  const bundle = readOrganizationBundle(root);
  const alreadyApplied = bundle.organizationState.applied_decision_ids.includes(canonicalDecision.decision_id);
  const createsAgent = canonicalDecision.selected_action === "add_member" || canonicalDecision.selected_action === "add_role";
  if (createsAgent && provisioningRequests.length === 0) {
    throw new TypeError(`${canonicalDecision.selected_action} requires an executable provisioning request`);
  }
  if (!createsAgent && provisioningRequests.length > 0) {
    throw new TypeError(`${canonicalDecision.selected_action} cannot create a provisioning request`);
  }
  if (!alreadyApplied && canonicalDecision.selected_action === "add_role" && roleDefinitions.length === 0) {
    throw new TypeError("add_role requires a role definition");
  }
  if (canonicalDecision.selected_action === "add_member" && roleDefinitions.length > 0) {
    throw new TypeError("add_member must reuse an existing role definition");
  }
  normalizeProvisioningRequests(provisioningRequests, bundle.tasksState, now);
  recordOrganizationDecision({ root, decision: canonicalDecision, now });
  if (alreadyApplied) {
    persistProvisioningRequests({
      root,
      decision: canonicalDecision,
      requests: provisioningRequests,
      organizationRevision: bundle.organizationState.revision,
      tasksState: bundle.tasksState,
      now,
    });
    return {
      organization: bundle.organizationState,
      decision: markDecisionApplied(paths, canonicalDecision.decision_id, now),
      idempotent: true,
    };
  }
  if (bundle.organizationState.revision !== canonicalDecision.organization_revision) {
    throw new TypeError("autonomous organization decision revision does not match current organization");
  }
  const applied = applyOrganizationDecision({
    state: bundle.organizationState,
    decision: canonicalDecision,
    changes,
  });
  const nextBundle = {
    ...bundle,
    rolesState: {
      ...bundle.rolesState,
      organization_revision: applied.state.revision,
      roles: mergeById(bundle.rolesState.roles, roleDefinitions, "role_id"),
      updated_at: now,
    },
    agentsState: {
      ...bundle.agentsState,
      organization_revision: applied.state.revision,
      agents: mergeById(bundle.agentsState.agents, agentRecords, "agent_id"),
      updated_at: now,
    },
    organizationState: applied.state,
  };
  for (const request of provisioningRequests) {
    const organizationAgent = nextBundle.organizationState.agents.find((agent) => agent.agent_id === request.agent_id);
    const agentRecord = nextBundle.agentsState.agents.find((agent) => agent.agent_id === request.agent_id);
    const roleRecord = nextBundle.rolesState.roles.find((role) => role.role_id === request.role_id);
    const team = nextBundle.organizationState.teams.find((item) => item.team_id === request.team_id);
    const membership = nextBundle.organizationState.memberships.find((item) => item.agent_id === request.agent_id && item.team_id === request.team_id && item.active_to === null);
    if (!organizationAgent || organizationAgent.role_id !== request.role_id || !agentRecord || !roleRecord || !team || team.line_id !== request.line_id || !membership) {
      throw new TypeError(`provisioning request is not bound to the committed organization: ${request.agent_id}`);
    }
  }
  commitOrganizationTransition({
    root,
    expectedRevision: bundle.organizationState.revision,
    bundle: nextBundle,
    now,
  });
  persistProvisioningRequests({
    root,
    decision: canonicalDecision,
    requests: provisioningRequests,
    organizationRevision: applied.state.revision,
    tasksState: bundle.tasksState,
    now,
  });
  return {
    organization: applied.state,
    decision: markDecisionApplied(paths, canonicalDecision.decision_id, now),
    idempotent: false,
  };
}

function commitApprovedLineDecision({ root, decisionId, now } = {}) {
  if (!root || !decisionId || !now) throw new TypeError("root, decisionId, and now are required");
  const paths = decisionPaths(root);
  const ledger = readDecisionLedger(root);
  const stored = findDecision(ledger, decisionId);
  if (!stored) throw new TypeError(`organization decision not found: ${decisionId}`);
  if (stored.status === "applied") {
    return { organization: readOrganizationBundle(root).organizationState, decision: clone(stored), idempotent: true };
  }
  if (stored.selected_action !== "propose_line" || stored.status !== "approved" || stored.approval_state !== "approved") {
    throw new TypeError("organization line decision must be approved before commit");
  }
  const canonicalDecision = contractDecision(stored);
  assertContract("organization-decision", canonicalDecision);

  const bundle = readOrganizationBundle(root);
  if (bundle.organizationState.applied_decision_ids.includes(decisionId)) {
    return {
      organization: bundle.organizationState,
      decision: markDecisionApplied(paths, decisionId, now),
      idempotent: true,
    };
  }
  if (bundle.organizationState.revision !== stored.organization_revision) {
    throw new TypeError("approved line decision revision does not match current organization");
  }
  const line = {
    ...clone(stored.proposed_line),
    dedicated_lead_agent_id: null,
    status: "active",
    approval_source: "user_approval",
  };
  const applied = applyOrganizationDecision({
    state: bundle.organizationState,
    decision: canonicalDecision,
    changes: { lines: [line] },
  });
  const nextBundle = {
    ...bundle,
    rolesState: { ...bundle.rolesState, organization_revision: applied.state.revision, updated_at: now },
    agentsState: { ...bundle.agentsState, organization_revision: applied.state.revision, updated_at: now },
    organizationState: applied.state,
  };
  commitOrganizationTransition({
    root,
    expectedRevision: bundle.organizationState.revision,
    bundle: nextBundle,
    now,
  });

  const committed = markDecisionApplied(paths, decisionId, now);
  return { organization: applied.state, decision: committed, idempotent: false };
}

module.exports = {
  commitAutonomousOrganizationDecision,
  commitApprovedLineDecision,
  readDecisionLedger,
  recordOrganizationDecision,
  resolveLineDecision,
};
