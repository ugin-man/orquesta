"use strict";

const { canonicalHash, validateContract } = require("@orquesta/contracts");
const { loadDesktopOperation } = require("./desktop-operation-catalog");
const { createPlacementSagaStore, taskFingerprint } = require("./placement-saga-store-v1");
const { projectExecutionContext } = require("./project-execution-context");
const {
  registerPersistentAgentsCommand,
  setPersistentAgentLifecycleCommand,
} = require("./organization-controller-v3");

const OPERATION_ID = "organization.agent-placement.persistent.v1";
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const HASH = /^[a-f0-9]{64}$/;
const SOURCE_KINDS = new Set(["project", "user", "task", "workflow_run"]);
const TASK_DISPATCH_ACCEPTED_OR_LATER = new Set([
  "dispatch_accepted", "turn_started", "in_progress", "needs_orchestrator_review",
  "needs_revision", "accepted",
]);
const COMPLETE_TASK_EVIDENCE_STATES = new Set([
  ...TASK_DISPATCH_ACCEPTED_OR_LATER,
  "blocked", "failed", "cancelled", "superseded",
]);
const MAX_RETURNED_ISSUES = 128;
const MAX_RETURNED_CANDIDATES = 256;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function clone(value) {
  return structuredClone(value);
}

function issue(field, code, reason, candidates) {
  const value = { field, code, reason };
  if (Array.isArray(candidates) && candidates.length > 0) {
    const ordered = [...new Set(candidates)].sort();
    value.candidates = ordered.slice(0, MAX_RETURNED_CANDIDATES);
    value.candidate_count = ordered.length;
    value.candidates_truncated = ordered.length > MAX_RETURNED_CANDIDATES;
  }
  return value;
}

function sortIssues(issues) {
  const byKey = new Map();
  for (const item of issues) {
    const key = `${item.field}\0${item.code}\0${item.reason}\0${JSON.stringify(item.candidates || [])}`
      + `\0${item.candidate_count || 0}\0${item.candidates_truncated === true}`;
    if (!byKey.has(key)) byKey.set(key, item);
  }
  return [...byKey.values()].sort((left, right) => (
    left.field.localeCompare(right.field, "en")
    || left.code.localeCompare(right.code, "en")
    || left.reason.localeCompare(right.reason, "en")
  ));
}

function noWriteResult(status, operation, issues) {
  let bounded = sortIssues(issues);
  if (bounded.length > MAX_RETURNED_ISSUES) {
    const total = bounded.length;
    bounded = sortIssues([
      ...bounded.slice(0, MAX_RETURNED_ISSUES - 1),
      issue("$", "template_issue_limit_exceeded", `Template produced ${total} issues; revise the bounded operator output before retrying`),
    ]);
  }
  return {
    status,
    no_write: true,
    operation_id: operation.operation_id,
    template_version: operation.version,
    template_sha256: operation.schema_sha256,
    issues: bounded,
  };
}

function validateTrustedSource(sourceRef) {
  const exact = ["kind", "id"].sort();
  if (!sourceRef || typeof sourceRef !== "object" || Array.isArray(sourceRef)
    || JSON.stringify(Object.keys(sourceRef).sort()) !== JSON.stringify(exact)
    || !SOURCE_KINDS.has(sourceRef.kind)
    || typeof sourceRef.id !== "string" || !sourceRef.id.trim() || [...sourceRef.id].length > 256) {
    fail("PLACEMENT_SOURCE_INVALID", "Trusted placement source_ref is invalid");
  }
  return clone(sourceRef);
}

function assertPersistentPlacementControllerAuthority({
  projectRoot,
  projectId,
  organizationStore,
  taskPort,
  sessionAdapter,
}) {
  if (!organizationStore || typeof organizationStore.inspect !== "function" || typeof organizationStore.commit !== "function") {
    fail("PLACEMENT_ORGANIZATION_ADAPTER_INVALID", "Organization store adapter is required");
  }
  if (!taskPort || typeof taskPort.inspectPlacementTasks !== "function"
    || typeof taskPort.reconcilePlacementTasks !== "function"
    || typeof taskPort.transitionPlacementTask !== "function") {
    fail("PLACEMENT_TASK_PORT_INVALID", "The single-owner placement Task port is required");
  }
  if (!sessionAdapter || typeof sessionAdapter.findAcceptedBinding !== "function"
    || typeof sessionAdapter.provisionPersistentAgent !== "function") {
    fail("PLACEMENT_SESSION_ADAPTER_INVALID", "Persistent session adapter is required");
  }
  const expected = projectExecutionContext(projectRoot, projectId);
  if (organizationStore?.project_root_binding_sha256 !== expected.project_root_binding_sha256
    || taskPort?.project_root_binding_sha256 !== expected.project_root_binding_sha256
    || sessionAdapter?.project_root_binding_sha256 !== expected.project_root_binding_sha256
    || sessionAdapter?.project_id !== expected.project_id) {
    fail("PLACEMENT_CONTROLLER_AUTHORITY_MISMATCH", "Organization, Task, and Session ports must belong to one exact project execution context");
  }
}

function validateRoleCatalog(roleCatalog) {
  if (!Array.isArray(roleCatalog) || roleCatalog.length > 1024) {
    fail("PLACEMENT_ROLE_CATALOG_INVALID", "Trusted role catalog must be a bounded array");
  }
  const ids = new Set();
  return roleCatalog.map((role) => {
    const exact = ["id", "version", "capabilities"].sort();
    if (!role || typeof role !== "object" || Array.isArray(role)
      || JSON.stringify(Object.keys(role).sort()) !== JSON.stringify(exact)
      || typeof role.id !== "string" || [...role.id].length > 128 || !/^[a-z][a-z0-9-]*$/.test(role.id)
      || !Number.isSafeInteger(role.version) || role.version < 1
      || !Array.isArray(role.capabilities) || role.capabilities.length === 0 || role.capabilities.length > 64
      || role.capabilities.some((capability) => typeof capability !== "string"
        || [...capability].length > 128 || !/^[a-z][a-z0-9.-]*$/.test(capability))
      || new Set(role.capabilities).size !== role.capabilities.length) {
      fail("PLACEMENT_ROLE_CATALOG_INVALID", "Trusted role catalog contains an invalid role record");
    }
    const identity = `${role.id}@${role.version}`;
    if (ids.has(identity)) fail("PLACEMENT_ROLE_CATALOG_INVALID", `Trusted role identity is duplicated: ${identity}`);
    ids.add(identity);
    return { id: role.id, version: role.version, capabilities: [...role.capabilities].sort() };
  });
}

function schemaIssues(template) {
  const result = validateContract("organization-agent-placement-persistent-v1", template);
  return result.errors.map((error) => issue(
    error.path === "$" ? "$" : error.path.replace(/^\$\.?/, ""),
    `template_${error.code}`,
    error.message
  ));
}

function scopeCandidates(bundle, kind, projectId) {
  if (kind === "project") return [projectId];
  if (kind === "line") return bundle.organization.lines.filter((line) => line.status === "active").map((line) => line.line_id);
  if (kind === "team") return bundle.organization.teams.filter((team) => team.lifecycle_state === "active").map((team) => team.team_id);
  return [];
}

function exactScope(bundle, scopeRef, projectId) {
  if (scopeRef.kind === "project") return scopeRef.id === projectId ? { kind: "project", id: projectId } : null;
  if (scopeRef.kind === "line") {
    return bundle.organization.lines.find((line) => line.line_id === scopeRef.id && line.status === "active") || null;
  }
  if (scopeRef.kind === "team") {
    return bundle.organization.teams.find((team) => team.team_id === scopeRef.id && team.lifecycle_state === "active") || null;
  }
  return null;
}

function placementIdentity({ operation, template, projectId, sourceRef }) {
  const hash = canonicalHash({
    operation_id: operation.operation_id,
    operation_version: operation.version,
    project_id: projectId,
    source_ref: sourceRef,
    template,
  });
  return { hash, placement_intent_id: `PI-${hash.slice(0, 12)}` };
}

function contextScope(scopeRef) {
  return scopeRef.kind === "project" ? ["project"] : [`${scopeRef.kind}:${scopeRef.id}`];
}

function targetSupervisor(bundle, scopeRef) {
  if (scopeRef.kind === "team") {
    const team = bundle.organization.teams.find((record) => record.team_id === scopeRef.id);
    if (team?.lead_agent_id) return team.lead_agent_id;
  }
  if (scopeRef.kind === "line") {
    const line = bundle.organization.lines.find((record) => record.line_id === scopeRef.id);
    if (line?.owner_ref?.kind === "agent") return line.owner_ref.id;
  }
  return "orchestrator";
}

function plannedAgentId(roleId, identityHash, ordinal) {
  return `${roleId}-${identityHash.slice(0, 12)}-${ordinal}`;
}

function plannedRecords({ operation, template, intent, identity, bundle, observedAt }) {
  const taskSuffix = identity.hash.slice(0, 12);
  const supervisor = targetSupervisor(bundle, template.scope_ref);
  const team = template.scope_ref.kind === "team"
    ? bundle.organization.teams.find((record) => record.team_id === template.scope_ref.id)
    : null;
  const nextOrdinal = team
    ? Math.max(0, ...bundle.organization.memberships
      .filter((membership) => membership.team_id === team.team_id && membership.active_to === null)
      .map((membership) => membership.ordinal)) + 1
    : null;
  const tasks = [];
  const agents = [];
  const memberships = [];
  const relationships = [];
  const placementEvidence = [];
  for (let index = 0; index < template.requested_count; index += 1) {
    const ordinal = index + 1;
    const agentId = plannedAgentId(template.role_ref.id, identity.hash, ordinal);
    const taskId = `placement:${taskSuffix}:${ordinal}`;
    const baseTask = {
      task_id: taskId,
      task_kind: "specialist_work",
      placement_intent_id: intent.placement_intent_id,
      assigned_agent_id: agentId,
      owner_agent_id: agentId,
      role_id: template.role_ref.id,
      role_version: template.role_ref.version,
      purpose: template.purpose,
      acceptance_criteria: [
        "The assigned specialist session is durably accepted before work starts.",
        "The specialist completes the stated purpose within the selected scope.",
      ],
      state: "queued",
      dependencies: [],
      blocked_by: [],
      result_summary: null,
      accepted_at: null,
      specialist_report_required: true,
      created_at: observedAt,
      updated_at: observedAt,
    };
    const task = { ...baseTask, placement_fingerprint: taskFingerprint(baseTask) };
    const agent = {
      agent_id: agentId,
      role_id: template.role_ref.id,
      role_version: template.role_ref.version,
      mission: template.purpose,
      context_scope: contextScope(template.scope_ref),
      lifecycle_state: "provisioning",
      origin: "controller",
      created_from_ref: { kind: "task", id: taskId },
      retired_at: null,
    };
    tasks.push(task);
    agents.push(agent);
    placementEvidence.push({
      agent_id: agentId,
      placement_intent_id: intent.placement_intent_id,
      executable_task_id: taskId,
    });
    relationships.push({
      relationship_id: `relationship-${agentId}-reports-to-${supervisor}`,
      type: "reports_to",
      subject_ref: { kind: "agent", id: agentId },
      object_ref: { kind: "agent", id: supervisor },
    });
    if (team) {
      memberships.push({
        membership_id: `membership-${agentId}-${team.team_id}`,
        agent_id: agentId,
        team_id: team.team_id,
        position: "member",
        ordinal: nextOrdinal + index,
        active_from: observedAt,
        active_to: null,
      });
    }
  }
  return { tasks, agents, memberships, relationships, placementEvidence };
}

function compilePersistentAgentPlacement({
  loadedOperation,
  template,
  projectId,
  sourceRef,
  roleCatalog,
  organizationSnapshot,
  observedAt,
} = {}) {
  const operation = loadedOperation?.operation;
  if (!operation || operation.operation_id !== OPERATION_ID) fail("PLACEMENT_OPERATION_INVALID", "Persistent placement operation is not loaded");
  if (typeof projectId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(projectId)) {
    fail("PLACEMENT_PROJECT_ID_INVALID", "Trusted project id is invalid");
  }
  if (typeof observedAt !== "string" || !UTC_TIMESTAMP.test(observedAt)
    || !Number.isFinite(Date.parse(observedAt)) || new Date(observedAt).toISOString() !== observedAt) {
    fail("PLACEMENT_TIMESTAMP_INVALID", "Placement observation time must be canonical UTC");
  }
  const trustedSource = validateTrustedSource(sourceRef);
  const roles = validateRoleCatalog(roleCatalog);
  const schemaErrors = schemaIssues(template);
  if (schemaErrors.length > 0) return noWriteResult("incomplete", operation, schemaErrors);
  const bundle = organizationSnapshot?.bundle;
  if (organizationSnapshot?.status !== "ready" || !bundle) {
    return noWriteResult("blocked", operation, [issue("organization", "organization_not_ready", "Organization v3 authority is not ready")]);
  }
  const issues = [];
  const role = roles.find((candidate) => candidate.id === template.role_ref.id && candidate.version === template.role_ref.version);
  if (!role) {
    issues.push(issue(
      "role_ref",
      "role_not_found",
      "The selected role identity does not exist in the trusted role catalog",
      roles.map((candidate) => `${candidate.id}@${candidate.version}`)
    ));
  } else {
    const missingCapabilities = template.capability_needs.filter((capability) => !role.capabilities.includes(capability));
    if (missingCapabilities.length > 0) {
      const matchingRoles = roles
        .filter((candidate) => template.capability_needs.every((capability) => candidate.capabilities.includes(capability)))
        .map((candidate) => `${candidate.id}@${candidate.version}`);
      issues.push(issue(
        "capability_needs",
        "role_capability_mismatch",
        `The selected role does not provide: ${missingCapabilities.join(", ")}`,
        matchingRoles
      ));
    }
  }
  const scope = exactScope(bundle, template.scope_ref, projectId);
  if (!scope) {
    issues.push(issue(
      "scope_ref",
      "scope_not_found",
      "The selected scope does not exist as an active exact reference",
      scopeCandidates(bundle, template.scope_ref.kind, projectId)
    ));
  }
  if (scope && template.scope_ref.kind === "team" && template.coordination_hint !== null
    && template.coordination_hint !== scope.coordination_mode) {
    issues.push(issue(
      "coordination_hint",
      "team_coordination_mismatch",
      "The coordination hint conflicts with the selected team's canonical coordination mode",
      [scope.coordination_mode]
    ));
  }
  if (issues.length > 0) return noWriteResult("incomplete", operation, issues);

  const identity = placementIdentity({ operation, template, projectId, sourceRef: trustedSource });
  const intent = {
    placement_intent_id: identity.placement_intent_id,
    purpose: template.purpose,
    capability_needs: clone(template.capability_needs),
    scope_ref: clone(template.scope_ref),
    lifetime: "persistent",
    requested_count: template.requested_count,
    coordination_hint: template.coordination_hint,
    source_ref: trustedSource,
  };
  const existingById = new Map(bundle.agentRegistry.agents.map((agent) => [agent.agent_id, agent]));
  let newCount = 0;
  for (let index = 0; index < template.requested_count; index += 1) {
    const agentId = plannedAgentId(template.role_ref.id, identity.hash, index + 1);
    if (!existingById.has(agentId)) newCount += 1;
  }
  const currentProvisioning = bundle.agentRegistry.agents.filter((agent) => agent.lifecycle_state === "provisioning").length;
  if (currentProvisioning + newCount > bundle.organization.policy.max_concurrent_provisioning) {
    return noWriteResult("blocked", operation, [issue(
      "requested_count",
      "provisioning_capacity_exceeded",
      `Placement would exceed the current provisioning capacity of ${bundle.organization.policy.max_concurrent_provisioning}`
    )]);
  }
  const records = plannedRecords({ operation, template, intent, identity, bundle, observedAt });
  return {
    status: "ready",
    no_write: false,
    operation_id: operation.operation_id,
    template_version: operation.version,
    template_sha256: operation.schema_sha256,
    intent,
    intent_hash: canonicalHash(intent),
    ...records,
  };
}

function sameAgentPlan(existing, planned) {
  const normalized = { ...planned, lifecycle_state: existing.lifecycle_state };
  return ["provisioning", "active"].includes(existing.lifecycle_state)
    && canonicalHash(existing) === canonicalHash(normalized);
}

function acceptedBinding(value, agentId) {
  if (!value || value.status !== "accepted" || value.agent_id !== agentId
    || typeof value.thread_id !== "string" || !value.thread_id
    || typeof value.session_id !== "string" || !value.session_id
    || typeof value.accepted_at !== "string" || !UTC_TIMESTAMP.test(value.accepted_at)
    || !Number.isFinite(Date.parse(value.accepted_at)) || new Date(value.accepted_at).toISOString() !== value.accepted_at) {
    fail("PLACEMENT_SESSION_BINDING_INVALID", `Session adapter did not return an accepted exact binding for ${agentId}`);
  }
  return {
    status: "accepted",
    agent_id: agentId,
    thread_id: value.thread_id,
    session_id: value.session_id,
    accepted_at: value.accepted_at,
  };
}

function taskPersistenceEvidence(value, expectedTasks) {
  const fields = ["status", "state_revision", "state_hash", "tasks"].sort();
  if (!value || typeof value !== "object" || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(fields)
    || value.status !== "ready"
    || !Number.isSafeInteger(value.state_revision) || value.state_revision < 0
    || typeof value.state_hash !== "string" || !HASH.test(value.state_hash)
    || !Array.isArray(value.tasks) || value.tasks.length !== expectedTasks.length) {
    fail("PLACEMENT_TASK_PORT_INVALID", "Task owner returned an invalid placement persistence receipt");
  }
  const byId = new Map(value.tasks.map((task) => [task?.task_id, task]));
  if (byId.size !== expectedTasks.length || expectedTasks.some((task) => {
    const persisted = byId.get(task.task_id);
    return !persisted
      || persisted.placement_intent_id !== task.placement_intent_id
      || persisted.assigned_agent_id !== task.assigned_agent_id
      || persisted.placement_fingerprint !== task.placement_fingerprint
      || taskFingerprint(persisted) !== task.placement_fingerprint;
  })) {
    fail("PLACEMENT_TASK_PERSISTENCE_MISMATCH", "Task owner did not preserve the exact immutable placement task provenance");
  }
  return {
    state_revision: value.state_revision,
    state_hash: value.state_hash,
    tasks: value.tasks.map((task) => clone(task)),
  };
}

function nextTaskTimestamp(current, proposed) {
  const currentMs = Date.parse(current);
  const proposedMs = Date.parse(proposed);
  if (!Number.isFinite(currentMs) || !Number.isFinite(proposedMs)) {
    fail("PLACEMENT_TASK_CHRONOLOGY_INVALID", "Task transition timestamps are invalid");
  }
  return new Date(Math.max(proposedMs, currentMs + 1)).toISOString();
}

function durableTaskEvidence(evidence) {
  return { state_revision: evidence.state_revision, state_hash: evidence.state_hash };
}

function repairRequired(compiled, task, reason, requestId = null, {
  noWrite = false,
  durableEffects = ["placement_saga", "placement_tasks", "organization"],
} = {}) {
  return {
    status: "repair_required",
    no_write: noWrite,
    placement_intent_id: compiled.intent.placement_intent_id,
    task_id: task.task_id,
    agent_id: task.assigned_agent_id,
    request_id: requestId,
    observed_task_state: task.state,
    durable_effects: [...durableEffects],
    reason,
    next_action: "explicit_repair_then_reinspect",
    automatic_retry: false,
  };
}

async function advancePlacementTask({
  taskPort,
  projectId,
  placementIntentId,
  plannedTask,
  targetState,
  clock,
}) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const inspected = taskPersistenceEvidence(await taskPort.inspectPlacementTasks({
      projectId,
      placementIntentId,
      taskIds: [plannedTask.task_id],
    }), [plannedTask]);
    const current = inspected.tasks[0];
    if (targetState === "assigned" && current.state === "assigned") return { status: "ready", task: current };
    if (targetState === "assigned" && TASK_DISPATCH_ACCEPTED_OR_LATER.has(current.state)) {
      return { status: "ready", task: current };
    }
    if (targetState === "dispatch_accepted" && TASK_DISPATCH_ACCEPTED_OR_LATER.has(current.state)) {
      return { status: "ready", task: current };
    }
    if (!["queued", "assigned"].includes(current.state)) {
      return {
        status: "repair_required",
        task: current,
        reason: `Placement task is ${current.state}; lifecycle repair is required before ${targetState}`,
      };
    }
    const nextState = current.state === "queued" ? "assigned" : "dispatch_accepted";
    const changedAt = nextTaskTimestamp(current.updated_at, clock());
    try {
      const transitioned = taskPersistenceEvidence(await taskPort.transitionPlacementTask({
        projectId,
        expectedRevision: inspected.state_revision,
        taskId: current.task_id,
        expectedState: current.state,
        next: {
          state: nextState,
          blockedBy: [],
          resultSummary: null,
          acceptedAt: null,
          changedAt,
        },
      }), [plannedTask]);
      const observed = transitioned.tasks[0];
      if (nextState === targetState || (targetState === "assigned" && TASK_DISPATCH_ACCEPTED_OR_LATER.has(observed.state))) {
        return { status: "ready", task: observed };
      }
    } catch (error) {
      if (!["PLACEMENT_TASK_REVISION_CONFLICT", "PLACEMENT_TASK_STATE_CONFLICT"].includes(error.code) || attempt === 7) {
        throw error;
      }
    }
  }
  fail("PLACEMENT_TASK_TRANSITION_UNSETTLED", `Task ${plannedTask.task_id} did not settle at ${targetState}`);
}

function organizationEvidence(snapshot, commandId = null) {
  if (snapshot?.status !== "ready" || !Number.isSafeInteger(snapshot.bundle?.organization?.revision)
    || snapshot.bundle.organization.revision < 0 || typeof snapshot.head_hash !== "string"
    || !HASH.test(snapshot.head_hash) || (commandId !== null && (typeof commandId !== "string" || !commandId))) {
    fail("PLACEMENT_ORGANIZATION_EVIDENCE_INVALID", "Organization store did not provide exact durable evidence");
  }
  return {
    organization_revision: snapshot.bundle.organization.revision,
    head_hash: snapshot.head_hash,
    command_id: commandId,
  };
}

function initialSaga(compiled, operation, now) {
  const sessionBindings = {};
  const activations = {};
  for (const [index, agent] of compiled.agents.entries()) {
    sessionBindings[agent.agent_id] = {
      agent_id: agent.agent_id,
      task_id: compiled.tasks[index].task_id,
      request_id: `placement:${compiled.intent.placement_intent_id}:${agent.agent_id}`,
      status: "not_requested",
      binding: null,
    };
    activations[agent.agent_id] = {
      agent_id: agent.agent_id,
      status: "pending",
      evidence: null,
    };
  }
  return {
    schema_version: 1,
    revision: 0,
    placement_intent_id: compiled.intent.placement_intent_id,
    operation_id: operation.operation_id,
    operation_version: operation.version,
    template_sha256: operation.schema_sha256,
    intent: clone(compiled.intent),
    intent_hash: compiled.intent_hash,
    phase: "intent_recorded",
    task_records: clone(compiled.tasks),
    agents: clone(compiled.agents),
    organization_plan: {
      memberships: clone(compiled.memberships),
      relationships: clone(compiled.relationships),
      placement_evidence: clone(compiled.placementEvidence),
    },
    task_evidence: null,
    organization_registration: null,
    session_bindings: sessionBindings,
    activations,
    created_at: now,
    updated_at: now,
  };
}

function assertSagaIdentity(saga, compiled, operation) {
  if (saga.operation_id !== operation.operation_id || saga.operation_version !== operation.version
    || saga.template_sha256 !== operation.schema_sha256
    || saga.intent_hash !== compiled.intent_hash
    || canonicalHash(saga.intent) !== compiled.intent_hash) {
    fail("PLACEMENT_SAGA_IDENTITY_CONFLICT", "Existing placement saga is bound to different semantic content");
  }
}

function registrationState(snapshot, compiled) {
  const existing = compiled.agents.map((planned) => snapshot.bundle.agentRegistry.agents.find((agent) => agent.agent_id === planned.agent_id) || null);
  if (existing.every((agent) => agent === null)) return "absent";
  if (existing.some((agent) => agent === null)) fail("PLACEMENT_ORGANIZATION_PARTIAL", "Only part of the deterministic placement roster exists");
  if (!existing.every((agent, index) => sameAgentPlan(agent, compiled.agents[index]))) {
    fail("PLACEMENT_ORGANIZATION_CONFLICT", "Deterministic placement agent ids are bound to different organization content");
  }
  for (const membership of compiled.memberships) {
    const current = snapshot.bundle.organization.memberships.find((record) => record.membership_id === membership.membership_id);
    if (!current || canonicalHash(current) !== canonicalHash(membership)) {
      fail("PLACEMENT_ORGANIZATION_CONFLICT", `Placement membership is missing or different: ${membership.membership_id}`);
    }
  }
  for (const relationship of compiled.relationships) {
    const current = snapshot.bundle.organization.relationships.find((record) => record.relationship_id === relationship.relationship_id);
    if (!current || canonicalHash(current) !== canonicalHash(relationship)) {
      fail("PLACEMENT_ORGANIZATION_CONFLICT", `Placement relationship is missing or different: ${relationship.relationship_id}`);
    }
  }
  return "registered";
}

async function runPersistentAgentPlacement({
  productRoot,
  projectRoot,
  projectId,
  sourceRef,
  roleCatalog,
  template,
  organizationStore,
  taskPort,
  sessionAdapter,
  clock = () => new Date().toISOString(),
} = {}) {
  assertPersistentPlacementControllerAuthority({
    projectRoot,
    projectId,
    organizationStore,
    taskPort,
    sessionAdapter,
  });
  const loadedOperation = loadDesktopOperation({ productRoot, operationId: OPERATION_ID });
  let observedAt = clock();
  let compiled = compilePersistentAgentPlacement({
    loadedOperation,
    template,
    projectId,
    sourceRef,
    roleCatalog,
    organizationSnapshot: organizationStore.inspect(),
    observedAt,
  });
  if (compiled.status !== "ready") return compiled;
  const sagaStore = createPlacementSagaStore({ rootPath: projectRoot, clock });
  return sagaStore.withIntentLock(compiled.intent.placement_intent_id, async (locked) => {
    let sagaRecord = locked.read();
    if (sagaRecord.status === "missing") {
      const stable = compilePersistentAgentPlacement({
        loadedOperation,
        template,
        projectId,
        sourceRef,
        roleCatalog,
        organizationSnapshot: organizationStore.inspect(),
        observedAt,
      });
      if (stable.status !== "ready") return stable;
      if (stable.intent.placement_intent_id !== compiled.intent.placement_intent_id
        || stable.intent_hash !== compiled.intent_hash) {
        fail("PLACEMENT_INTENT_DRIFT", "Placement intent changed before its durable saga boundary");
      }
      compiled = stable;
      const created = initialSaga(compiled, loadedOperation.operation, observedAt);
      sagaRecord = locked.create(created);
    } else {
      assertSagaIdentity(sagaRecord.saga, compiled, loadedOperation.operation);
      const stable = compilePersistentAgentPlacement({
        loadedOperation,
        template,
        projectId,
        sourceRef,
        roleCatalog,
        organizationSnapshot: organizationStore.inspect(),
        observedAt: sagaRecord.saga.created_at,
      });
      if (stable.status !== "ready") return stable;
      assertSagaIdentity(sagaRecord.saga, stable, loadedOperation.operation);
      compiled = {
        ...stable,
        intent: clone(sagaRecord.saga.intent),
        intent_hash: sagaRecord.saga.intent_hash,
        tasks: clone(sagaRecord.saga.task_records),
        agents: clone(sagaRecord.saga.agents),
        memberships: clone(sagaRecord.saga.organization_plan.memberships),
        relationships: clone(sagaRecord.saga.organization_plan.relationships),
        placementEvidence: clone(sagaRecord.saga.organization_plan.placement_evidence),
      };
      if (sagaRecord.saga.phase === "complete") {
        const completeTasks = taskPersistenceEvidence(await taskPort.inspectPlacementTasks({
          projectId,
          placementIntentId: compiled.intent.placement_intent_id,
          taskIds: compiled.tasks.map((task) => task.task_id),
        }), compiled.tasks);
        const staleTask = completeTasks.tasks.find((task) => !COMPLETE_TASK_EVIDENCE_STATES.has(task.state));
        if (staleTask) {
          return repairRequired(
            compiled,
            staleTask,
            `Completed placement task is ${staleTask.state}; explicit lifecycle repair is required`,
            sagaRecord.saga.session_bindings[staleTask.assigned_agent_id]?.request_id ?? null,
            {
              noWrite: true,
              durableEffects: ["existing_placement_saga", "existing_task_state"],
            }
          );
        }
        const completeOrganization = organizationStore.inspect();
        if (completeOrganization.status !== "ready"
          || registrationState(completeOrganization, compiled) !== "registered"
          || compiled.agents.some((agent) => !completeOrganization.bundle.agentRegistry.agents.some((current) => (
            current.agent_id === agent.agent_id && current.lifecycle_state === "active" && sameAgentPlan(current, agent)
          )))) {
          fail("PLACEMENT_COMPLETE_AUTHORITY_MISMATCH", "Completed placement no longer matches active Organization authority");
        }
        for (const [index, agent] of compiled.agents.entries()) {
          const entry = sagaRecord.saga.session_bindings[agent.agent_id];
          const binding = await sessionAdapter.findAcceptedBinding({
            projectId,
            placementIntentId: compiled.intent.placement_intent_id,
            taskId: compiled.tasks[index].task_id,
            agentId: agent.agent_id,
            requestId: entry.request_id,
          });
          if (!binding || canonicalHash(acceptedBinding(binding, agent.agent_id)) !== canonicalHash(entry.binding)) {
            fail("PLACEMENT_COMPLETE_AUTHORITY_MISMATCH", `Completed placement session binding differs for ${agent.agent_id}`);
          }
        }
        return {
          status: "complete",
          no_write: true,
          placement_intent_id: compiled.intent.placement_intent_id,
          agent_ids: compiled.agents.map((agent) => agent.agent_id),
          task_ids: compiled.tasks.map((task) => task.task_id),
          saga_revision: sagaRecord.saga.revision,
        };
      }
    }

    const taskReceipt = await taskPort.reconcilePlacementTasks({
      projectId,
      placementIntentId: compiled.intent.placement_intent_id,
      tasks: clone(compiled.tasks),
    });
    taskPersistenceEvidence(taskReceipt, compiled.tasks);
    const taskEvidence = taskPersistenceEvidence(await taskPort.inspectPlacementTasks({
      projectId,
      placementIntentId: compiled.intent.placement_intent_id,
      taskIds: compiled.tasks.map((task) => task.task_id),
    }), compiled.tasks);
    if (sagaRecord.saga.phase === "intent_recorded") {
      sagaRecord = locked.recordTasks(durableTaskEvidence(taskEvidence));
    }

    let registrationCommandId = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const snapshot = organizationStore.inspect();
      if (snapshot.status !== "ready") fail("PLACEMENT_ORGANIZATION_NOT_READY", `Organization store is ${snapshot.status}`);
      const state = registrationState(snapshot, compiled);
      if (state === "registered") break;
      const command = registerPersistentAgentsCommand({
        expectedRevision: snapshot.bundle.organization.revision,
        expectedHeadHash: snapshot.head_hash,
        agents: compiled.agents,
        memberships: compiled.memberships,
        relationships: compiled.relationships,
        placementEvidence: compiled.placementEvidence,
      });
      try {
        organizationStore.commit(command);
        registrationCommandId = command.command_id;
        break;
      } catch (error) {
        if (!["ORGANIZATION_REVISION_CONFLICT", "ORGANIZATION_HEAD_CONFLICT"].includes(error.code) || attempt === 7) throw error;
      }
    }
    const registered = organizationStore.inspect();
    if (registered.status !== "ready" || registrationState(registered, compiled) !== "registered") {
      fail("PLACEMENT_ORGANIZATION_PERSISTENCE_MISMATCH", "Placement organization registration did not settle");
    }
    if (sagaRecord.saga.phase === "tasks_appended") {
      sagaRecord = locked.recordOrganization(organizationEvidence(registered, registrationCommandId));
    }

    for (const [index, agent] of compiled.agents.entries()) {
      let entry = sagaRecord.saga.session_bindings[agent.agent_id];
      const plannedTask = compiled.tasks[index];
      let binding = await sessionAdapter.findAcceptedBinding({
        projectId,
        placementIntentId: compiled.intent.placement_intent_id,
        taskId: plannedTask.task_id,
        agentId: agent.agent_id,
        requestId: entry.request_id,
      });
      if (binding) {
        binding = acceptedBinding(binding, agent.agent_id);
        const assigned = await advancePlacementTask({
          taskPort,
          projectId,
          placementIntentId: compiled.intent.placement_intent_id,
          plannedTask,
          targetState: "assigned",
          clock,
        });
        if (assigned.status === "repair_required") {
          return repairRequired(compiled, assigned.task, assigned.reason, entry.request_id, {
            durableEffects: ["placement_saga", "placement_tasks", "organization", "session_binding"],
          });
        }
        const dispatched = await advancePlacementTask({
          taskPort,
          projectId,
          placementIntentId: compiled.intent.placement_intent_id,
          plannedTask,
          targetState: "dispatch_accepted",
          clock,
        });
        if (dispatched.status === "repair_required") {
          return repairRequired(compiled, dispatched.task, dispatched.reason, entry.request_id, {
            durableEffects: ["placement_saga", "placement_tasks", "organization", "session_binding"],
          });
        }
        if (entry.status === "not_requested") {
          sagaRecord = locked.markSessionRequested(agent.agent_id);
          entry = sagaRecord.saga.session_bindings[agent.agent_id];
        }
        sagaRecord = locked.recordSessionAccepted(agent.agent_id, binding);
        continue;
      }
      if (entry.status === "accepted") {
        fail("PLACEMENT_SESSION_BINDING_MISSING", `Accepted session authority no longer contains ${agent.agent_id}`);
      }
      const assigned = await advancePlacementTask({
        taskPort,
        projectId,
        placementIntentId: compiled.intent.placement_intent_id,
        plannedTask,
        targetState: "assigned",
        clock,
      });
      if (assigned.status === "repair_required") {
        return repairRequired(compiled, assigned.task, assigned.reason, entry.request_id);
      }
      if (TASK_DISPATCH_ACCEPTED_OR_LATER.has(assigned.task.state)) {
        return repairRequired(
          compiled,
          assigned.task,
          "Placement task records dispatch acceptance but no accepted session binding exists",
          entry.request_id
        );
      }
      if (entry.status === "not_requested") {
        sagaRecord = locked.markSessionRequested(agent.agent_id);
        entry = sagaRecord.saga.session_bindings[agent.agent_id];
      }
      const acknowledgedBinding = acceptedBinding(await sessionAdapter.provisionPersistentAgent({
        projectId,
        placementIntentId: compiled.intent.placement_intent_id,
        requestId: entry.request_id,
        task: clone(assigned.task),
        agent: clone(agent),
      }), agent.agent_id);
      binding = await sessionAdapter.findAcceptedBinding({
        projectId,
        placementIntentId: compiled.intent.placement_intent_id,
        taskId: plannedTask.task_id,
        agentId: agent.agent_id,
        requestId: entry.request_id,
      });
      if (!binding || canonicalHash(acceptedBinding(binding, agent.agent_id)) !== canonicalHash(acknowledgedBinding)) {
        fail("PLACEMENT_SESSION_PERSISTENCE_MISMATCH", `Session authority did not preserve the accepted binding for ${agent.agent_id}`);
      }
      binding = acceptedBinding(binding, agent.agent_id);
      const dispatched = await advancePlacementTask({
        taskPort,
        projectId,
        placementIntentId: compiled.intent.placement_intent_id,
        plannedTask,
        targetState: "dispatch_accepted",
        clock,
      });
      if (dispatched.status === "repair_required") {
        return repairRequired(compiled, dispatched.task, dispatched.reason, entry.request_id, {
          durableEffects: ["placement_saga", "placement_tasks", "organization", "session_binding"],
        });
      }
      sagaRecord = locked.recordSessionAccepted(agent.agent_id, binding);
    }
    sagaRecord = locked.markSessionsAccepted();

    for (const agent of compiled.agents) {
      let activeSnapshot = null;
      let activationCommandId = null;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const snapshot = organizationStore.inspect();
        if (snapshot.status !== "ready") fail("PLACEMENT_ORGANIZATION_NOT_READY", `Organization store is ${snapshot.status}`);
        const current = snapshot.bundle.agentRegistry.agents.find((record) => record.agent_id === agent.agent_id);
        if (!current || !sameAgentPlan(current, agent)) fail("PLACEMENT_ORGANIZATION_CONFLICT", `Placement agent changed before activation: ${agent.agent_id}`);
        if (current.lifecycle_state === "active") {
          activeSnapshot = snapshot;
          break;
        }
        const binding = sagaRecord.saga.session_bindings[agent.agent_id].binding;
        observedAt = clock();
        const command = setPersistentAgentLifecycleCommand({
          expectedRevision: snapshot.bundle.organization.revision,
          expectedHeadHash: snapshot.head_hash,
          agentId: agent.agent_id,
          lifecycleState: "active",
          changedAt: observedAt,
          acceptedSessionBinding: binding,
        });
        try {
          organizationStore.commit(command);
          activationCommandId = command.command_id;
        } catch (error) {
          if (!["ORGANIZATION_REVISION_CONFLICT", "ORGANIZATION_HEAD_CONFLICT"].includes(error.code) || attempt === 7) throw error;
        }
      }
      if (!activeSnapshot) {
        const observed = organizationStore.inspect();
        const current = observed.status === "ready"
          ? observed.bundle.agentRegistry.agents.find((record) => record.agent_id === agent.agent_id)
          : null;
        if (!current || current.lifecycle_state !== "active" || !sameAgentPlan(current, agent)) {
          fail("PLACEMENT_ACTIVATION_INCOMPLETE", `Placement agent did not reach active lifecycle: ${agent.agent_id}`);
        }
        activeSnapshot = observed;
      }
      if (sagaRecord.saga.activations[agent.agent_id].status === "pending") {
        sagaRecord = locked.recordActivation(agent.agent_id, organizationEvidence(activeSnapshot, activationCommandId));
      }
    }
    sagaRecord = locked.markOrganizationActivated();
    sagaRecord = locked.markComplete();
    return {
      status: "complete",
      no_write: false,
      placement_intent_id: compiled.intent.placement_intent_id,
      agent_ids: compiled.agents.map((agent) => agent.agent_id),
      task_ids: compiled.tasks.map((task) => task.task_id),
      saga_revision: sagaRecord.saga.revision,
    };
  });
}

module.exports = {
  OPERATION_ID,
  compilePersistentAgentPlacement,
  runPersistentAgentPlacement,
};
