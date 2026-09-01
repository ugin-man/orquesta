"use strict";

const { canonicalHash, canonicalJson } = require("@orquesta/contracts");
const { FOUNDATION_AGENT_IDS, createOrganizationV3Bundle } = require("./organization-v3");

const COMMAND_KINDS = new Set([
  "apply_organization_decision",
  "register_persistent_agents",
  "set_persistent_agent_lifecycle",
  "start_workflow",
  "start_inspection",
  "retire_formation"
]);

const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function clone(value) {
  return JSON.parse(canonicalJson(value));
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortStrings(values) {
  if (Array.isArray(values)) values.sort((left, right) => compareText(String(left), String(right)));
}

function sortRecords(values, identity) {
  if (Array.isArray(values)) values.sort((left, right) => compareText(String(left?.[identity] || ""), String(right?.[identity] || "")));
}

function canonicalizeLine(line) {
  if (!isPlainObject(line)) return;
  sortStrings(line.deliverable_ids);
  sortStrings(line.completion_root_ids);
  sortStrings(line.scope);
}

function canonicalizeAgent(agent) {
  if (isPlainObject(agent)) sortStrings(agent.context_scope);
}

function canonicalizeFormation(formation) {
  if (!isPlainObject(formation)) return;
  sortStrings(formation.member_agent_ids);
  if (Array.isArray(formation.target_refs)) {
    formation.target_refs.sort((left, right) => (
      compareText(String(left?.kind || ""), String(right?.kind || ""))
      || compareText(String(left?.id || ""), String(right?.id || ""))
    ));
  }
}

function canonicalizePayloadCollections(payload) {
  const content = clone(payload);
  for (const field of ["agents"]) {
    if (Array.isArray(content[field])) {
      for (const agent of content[field]) canonicalizeAgent(agent);
      sortRecords(content[field], "agent_id");
    }
  }
  for (const field of ["lines", "replace_lines"]) {
    if (Array.isArray(content[field])) {
      for (const line of content[field]) canonicalizeLine(line);
      sortRecords(content[field], "line_id");
    }
  }
  for (const [field, identity] of [["teams", "team_id"], ["replace_teams", "team_id"], ["memberships", "membership_id"], ["replace_memberships", "membership_id"], ["relationships", "relationship_id"], ["replace_relationships", "relationship_id"]]) {
    sortRecords(content[field], identity);
  }
  sortRecords(content.placement_evidence, "agent_id");
  canonicalizeFormation(content.formation);
  return content;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function nonempty(value, name) {
  if (typeof value !== "string" || !value.trim()) fail("ORGANIZATION_COMMAND_INVALID", `${name} must be a nonempty string`);
  return value;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected, label) {
  if (!isPlainObject(value)) fail("ORGANIZATION_COMMAND_INVALID", `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) {
    fail("ORGANIZATION_COMMAND_INVALID", `${label} must contain exactly: ${canonical.join(", ")}`);
  }
}

function array(value, label) {
  if (!Array.isArray(value)) fail("ORGANIZATION_COMMAND_INVALID", `${label} must be an array`);
  return value;
}

function utcTimestamp(value, label) {
  if (typeof value !== "string" || !UTC_TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) {
    fail("ORGANIZATION_COMMAND_INVALID", `${label} must be a UTC timestamp`);
  }
  return value;
}

function expectedRevision(value) {
  if (!Number.isInteger(value) || value < 0) fail("ORGANIZATION_COMMAND_INVALID", "expectedRevision must be a non-negative integer");
  return value;
}

function expectedHeadHash(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    fail("ORGANIZATION_COMMAND_INVALID", "expectedHeadHash must be a SHA-256 hash");
  }
  return value;
}

function organizationV3HeadHash(bundle) {
  return canonicalHash(createOrganizationV3Bundle(bundle));
}

function commandIdFor({ kind, expected_revision: revision, expected_head_hash: headHash, payload }) {
  return `OC-${canonicalHash({ kind, expected_revision: revision, expected_head_hash: headHash, payload }).slice(0, 16)}`;
}

function createOrganizationControllerCommand({ kind, expectedRevision: revision, expectedHeadHash: headHash, payload } = {}) {
  if (!COMMAND_KINDS.has(kind)) fail("ORGANIZATION_COMMAND_INVALID", "Organization Controller command kind is invalid");
  const content = {
    kind,
    expected_revision: expectedRevision(revision),
    expected_head_hash: expectedHeadHash(headHash),
    payload: canonicalizePayloadCollections(payload || {})
  };
  return deepFreeze({ command_id: commandIdFor(content), ...content });
}

function formationId(kind, sourceKind, sourceId) {
  return `formation-${kind}-${canonicalHash({ kind, sourceKind, sourceId }).slice(0, 12)}`;
}

function startWorkflowFormationCommand({
  expectedRevision: revision,
  expectedHeadHash: headHash,
  workflowRunId,
  scopeRef,
  memberAgentIds,
  coordinationMode,
  leadAgentId,
  createdAt,
  agents
} = {}) {
  const sourceId = nonempty(workflowRunId, "workflowRunId");
  return createOrganizationControllerCommand({
    kind: "start_workflow",
    expectedRevision: revision,
    expectedHeadHash: headHash,
    payload: {
      agents: clone(agents || []),
      formation: {
        formation_id: formationId("workflow", "workflow_run", sourceId),
        formation_kind: "work_cell",
        source_ref: { kind: "workflow_run", id: sourceId },
        scope_ref: clone(scopeRef),
        member_agent_ids: clone(memberAgentIds || []),
        coordination_mode: coordinationMode,
        lead_agent_id: leadAgentId ?? null,
        target_refs: [],
        lifecycle_state: "active",
        created_at: createdAt,
        retired_at: null
      }
    }
  });
}

function startInspectionFormationCommand({
  expectedRevision: revision,
  expectedHeadHash: headHash,
  sourceTaskId,
  scopeRef,
  memberAgentIds,
  targetRefs,
  coordinationMode,
  leadAgentId,
  createdAt,
  agents
} = {}) {
  const sourceId = nonempty(sourceTaskId, "sourceTaskId");
  return createOrganizationControllerCommand({
    kind: "start_inspection",
    expectedRevision: revision,
    expectedHeadHash: headHash,
    payload: {
      agents: clone(agents || []),
      formation: {
        formation_id: formationId("inspection", "task", sourceId),
        formation_kind: "inspection",
        source_ref: { kind: "task", id: sourceId },
        scope_ref: clone(scopeRef),
        member_agent_ids: clone(memberAgentIds || []),
        coordination_mode: coordinationMode,
        lead_agent_id: leadAgentId ?? null,
        target_refs: clone(targetRefs || []),
        lifecycle_state: "active",
        created_at: createdAt,
        retired_at: null
      }
    }
  });
}

function retireFormationCommand({
  expectedRevision: revision,
  expectedHeadHash: headHash,
  formationId: id,
  retiredAt
} = {}) {
  return createOrganizationControllerCommand({
    kind: "retire_formation",
    expectedRevision: revision,
    expectedHeadHash: headHash,
    payload: {
      formation_id: nonempty(id, "formationId"),
      retired_at: nonempty(retiredAt, "retiredAt")
    }
  });
}

function registerPersistentAgentsCommand({
  expectedRevision: revision,
  expectedHeadHash: headHash,
  agents,
  lines,
  teams,
  memberships,
  relationships,
  placementEvidence
} = {}) {
  return createOrganizationControllerCommand({
    kind: "register_persistent_agents",
    expectedRevision: revision,
    expectedHeadHash: headHash,
    payload: {
      agents: clone(agents || []),
      lines: clone(lines || []),
      teams: clone(teams || []),
      memberships: clone(memberships || []),
      relationships: clone(relationships || []),
      placement_evidence: clone(placementEvidence || [])
    }
  });
}

function applyOrganizationDecisionCommand({
  expectedRevision: revision,
  expectedHeadHash: headHash,
  decisionId,
  lines,
  teams,
  memberships,
  relationships,
  replaceLines,
  replaceTeams,
  replaceMemberships,
  replaceRelationships
} = {}) {
  return createOrganizationControllerCommand({
    kind: "apply_organization_decision",
    expectedRevision: revision,
    expectedHeadHash: headHash,
    payload: {
      decision_id: nonempty(decisionId, "decisionId"),
      lines: clone(lines || []),
      teams: clone(teams || []),
      memberships: clone(memberships || []),
      relationships: clone(relationships || []),
      replace_lines: clone(replaceLines || []),
      replace_teams: clone(replaceTeams || []),
      replace_memberships: clone(replaceMemberships || []),
      replace_relationships: clone(replaceRelationships || [])
    }
  });
}

function setPersistentAgentLifecycleCommand({
  expectedRevision: revision,
  expectedHeadHash: headHash,
  agentId,
  lifecycleState,
  changedAt,
  acceptedSessionBinding
} = {}) {
  return createOrganizationControllerCommand({
    kind: "set_persistent_agent_lifecycle",
    expectedRevision: revision,
    expectedHeadHash: headHash,
    payload: {
      agent_id: nonempty(agentId, "agentId"),
      lifecycle_state: nonempty(lifecycleState, "lifecycleState"),
      changed_at: nonempty(changedAt, "changedAt"),
      accepted_session_binding: acceptedSessionBinding ? clone(acceptedSessionBinding) : null
    }
  });
}

function sameRecord(left, right) {
  return canonicalHash(left) === canonicalHash(right);
}

function canonicalDecisionContent(payload) {
  const content = canonicalizePayloadCollections(payload);
  delete content.decision_id;
  return content;
}

function requireCanonicalCollections(payload, label) {
  if (canonicalHash(payload) !== canonicalHash(canonicalizePayloadCollections(payload))) {
    fail("ORGANIZATION_COMMAND_INVALID", `${label} set-like collections must use canonical order`);
  }
}

function validateAcceptedSessionBinding(binding) {
  if (binding === null) return;
  exactKeys(binding, ["status", "agent_id", "thread_id", "session_id", "accepted_at"], "accepted_session_binding");
  if (binding.status !== "accepted") fail("ORGANIZATION_COMMAND_INVALID", "accepted_session_binding.status must be accepted");
  nonempty(binding.agent_id, "accepted_session_binding.agent_id");
  nonempty(binding.thread_id, "accepted_session_binding.thread_id");
  nonempty(binding.session_id, "accepted_session_binding.session_id");
  utcTimestamp(binding.accepted_at, "accepted_session_binding.accepted_at");
}

function validateProvisioningCapacity(current, newAgentCount) {
  const currentProvisioning = current.agentRegistry.agents.filter((agent) => agent.lifecycle_state === "provisioning").length;
  const maximum = current.organization.policy.max_concurrent_provisioning;
  if (currentProvisioning + newAgentCount > maximum) {
    fail("ORGANIZATION_PROVISIONING_CAPACITY", `provisioning would exceed policy maximum ${maximum}`);
  }
}

function validateLineCreationPolicy(current, incomingLines) {
  const existingIds = new Set(current.organization.lines.map((line) => line.line_id));
  const created = incomingLines.filter((line) => !existingIds.has(line?.line_id));
  if (created.length === 0) return;
  const policy = current.organization.policy.line_creation;
  if (policy === "forbidden") {
    fail("ORGANIZATION_LINE_CREATION_FORBIDDEN", "organization policy forbids new lines");
  }
  for (const line of created) {
    const allowed = policy === "review"
      ? line?.approval_source === "user_approval"
      : ["user_approval", "organization_decision"].includes(line?.approval_source);
    if (!allowed) {
      fail("ORGANIZATION_LINE_APPROVAL_REQUIRED", `new line ${line?.line_id || "<unknown>"} lacks the approval required by ${policy} policy`);
    }
  }
}

function validatePersistentRegistrationPayload(current, payload, validateState) {
  exactKeys(payload, ["agents", "lines", "teams", "memberships", "relationships", "placement_evidence"], "register_persistent_agents payload");
  for (const field of ["agents", "lines", "teams", "memberships", "relationships", "placement_evidence"]) array(payload[field], field);
  requireCanonicalCollections(payload, "register_persistent_agents payload");
  if (payload.agents.length === 0) fail("ORGANIZATION_COMMAND_INVALID", "register_persistent_agents requires at least one new agent");
  if (payload.placement_evidence.length !== payload.agents.length) {
    fail("ORGANIZATION_PLACEMENT_EVIDENCE_REQUIRED", "every new persistent agent requires exactly one placement evidence record");
  }
  const knownAgentIds = new Set(current.agentRegistry.agents.map((agent) => agent.agent_id));
  const incomingIds = new Set();
  for (const agent of payload.agents) {
    const agentId = nonempty(agent?.agent_id, "agent.agent_id");
    if (incomingIds.has(agentId)) fail("ORGANIZATION_COMMAND_INVALID", `duplicate incoming agent: ${agentId}`);
    incomingIds.add(agentId);
    if (validateState && knownAgentIds.has(agentId)) fail("ORGANIZATION_IDENTITY_CONFLICT", `register_persistent_agents cannot rewrite existing agent: ${agentId}`);
    if (agent.lifecycle_state !== "provisioning" || agent.origin !== "controller") {
      fail("ORGANIZATION_PROVISIONING_REQUIRED", `new persistent agent must begin provisioning with controller origin: ${agentId}`);
    }
    if (agent.created_from_ref?.kind !== "task" || !agent.created_from_ref?.id) {
      fail("ORGANIZATION_PROVENANCE_INVALID", `new persistent agent requires task provenance: ${agentId}`);
    }
  }
  const evidenceAgentIds = new Set();
  for (const evidence of payload.placement_evidence) {
    exactKeys(evidence, ["agent_id", "placement_intent_id", "executable_task_id"], "placement_evidence entry");
    const agentId = nonempty(evidence.agent_id, "placement_evidence.agent_id");
    nonempty(evidence.placement_intent_id, "placement_evidence.placement_intent_id");
    nonempty(evidence.executable_task_id, "placement_evidence.executable_task_id");
    if (!incomingIds.has(agentId) || evidenceAgentIds.has(agentId)) {
      fail("ORGANIZATION_PLACEMENT_EVIDENCE_REQUIRED", `placement evidence must bind exactly once to an incoming agent: ${agentId}`);
    }
    const agent = payload.agents.find((record) => record.agent_id === agentId);
    if (evidence.executable_task_id !== agent.created_from_ref.id) {
      fail("ORGANIZATION_PLACEMENT_EVIDENCE_CONFLICT", `placement evidence task must match agent provenance: ${agentId}`);
    }
    evidenceAgentIds.add(agentId);
  }
  if (validateState) {
    validateProvisioningCapacity(current, payload.agents.length);
    validateLineCreationPolicy(current, payload.lines);
  }
}

function validateOrganizationDecisionPayload(current, payload, validateState) {
  exactKeys(payload, [
    "decision_id", "lines", "teams", "memberships", "relationships",
    "replace_lines", "replace_teams", "replace_memberships", "replace_relationships"
  ], "apply_organization_decision payload");
  nonempty(payload.decision_id, "decision_id");
  for (const field of ["lines", "teams", "memberships", "relationships", "replace_lines", "replace_teams", "replace_memberships", "replace_relationships"]) {
    array(payload[field], field);
  }
  requireCanonicalCollections(payload, "apply_organization_decision payload");
  if (validateState) validateLineCreationPolicy(current, payload.lines);
}

function validateFormationStartPayload(current, payload, commandKind, validateState) {
  exactKeys(payload, ["agents", "formation"], `${commandKind} payload`);
  array(payload.agents, "agents");
  requireCanonicalCollections(payload, `${commandKind} payload`);
  exactKeys(payload.formation, [
    "formation_id", "formation_kind", "source_ref", "scope_ref", "member_agent_ids",
    "coordination_mode", "lead_agent_id", "target_refs", "lifecycle_state", "created_at", "retired_at"
  ], "formation");
  const formation = payload.formation;
  array(formation.member_agent_ids, "formation.member_agent_ids");
  array(formation.target_refs, "formation.target_refs");
  if (formation.member_agent_ids.length === 0) fail("ORGANIZATION_COMMAND_INVALID", "formation requires at least one member");
  if (new Set(formation.member_agent_ids).size !== formation.member_agent_ids.length) {
    fail("ORGANIZATION_COMMAND_INVALID", "formation member ids must be unique");
  }
  if (formation.lifecycle_state !== "active" || formation.retired_at !== null) {
    fail("ORGANIZATION_COMMAND_INVALID", "a started formation must be active and not retired");
  }
  utcTimestamp(formation.created_at, "formation.created_at");
  exactKeys(formation.source_ref, ["kind", "id"], "formation.source_ref");
  const workflow = commandKind === "start_workflow";
  const expectedFormationKind = workflow ? "work_cell" : "inspection";
  const expectedSourceKind = workflow ? "workflow_run" : "task";
  const expectedAgentOrigin = workflow ? "workflow" : "inspection";
  const expectedAgentRefKind = workflow ? "workflow_run" : "inspection";
  if (formation.formation_kind !== expectedFormationKind || formation.source_ref.kind !== expectedSourceKind || !formation.source_ref.id) {
    fail("ORGANIZATION_FORMATION_KIND_CONFLICT", `${commandKind} has mismatched formation kind or source`);
  }
  const expectedId = formationId(workflow ? "workflow" : "inspection", expectedSourceKind, formation.source_ref.id);
  if (formation.formation_id !== expectedId) {
    fail("ORGANIZATION_FORMATION_KIND_CONFLICT", `${commandKind} formation id does not match its source`);
  }
  if (workflow && formation.target_refs.length !== 0) {
    fail("ORGANIZATION_FORMATION_KIND_CONFLICT", "workflow formations cannot carry inspection targets");
  }
  if (!workflow && formation.target_refs.length === 0) {
    fail("ORGANIZATION_FORMATION_KIND_CONFLICT", "inspection formations require at least one target");
  }
  const memberIds = new Set(formation.member_agent_ids);
  const knownAgentIds = new Set(current.agentRegistry.agents.map((agent) => agent.agent_id));
  const knownAgents = new Map(current.agentRegistry.agents.map((agent) => [agent.agent_id, agent]));
  if (validateState) {
    for (const memberId of memberIds) {
      const existing = knownAgents.get(memberId);
      if (existing && ["workflow", "inspection"].includes(existing.origin)) {
        if (existing.origin !== expectedAgentOrigin
          || existing.created_from_ref?.kind !== expectedAgentRefKind
          || existing.created_from_ref?.id !== formation.source_ref.id) {
          fail("ORGANIZATION_FORMATION_AGENT_CONFLICT", `ephemeral agents cannot be reused by another formation: ${memberId}`);
        }
      } else if (existing && existing.lifecycle_state !== "active") {
        fail("ORGANIZATION_FORMATION_MEMBER_NOT_READY", `existing persistent formation member must be active: ${memberId}`);
      }
    }
  }
  const suppliedAgentIds = new Set();
  for (const agent of payload.agents) {
    const agentId = nonempty(agent?.agent_id, "agent.agent_id");
    if (suppliedAgentIds.has(agentId)) fail("ORGANIZATION_COMMAND_INVALID", `duplicate formation agent: ${agentId}`);
    suppliedAgentIds.add(agentId);
    if (validateState && knownAgentIds.has(agentId)) {
      fail("ORGANIZATION_FORMATION_AGENT_CONFLICT", `existing persistent formation member must be referenced by id only: ${agentId}`);
    }
    if (!memberIds.has(agentId)) {
      fail("ORGANIZATION_FORMATION_AGENT_CONFLICT", `new formation agent must be a formation member: ${agentId}`);
    }
    if (agent.lifecycle_state !== "provisioning"
      || agent.origin !== expectedAgentOrigin
      || agent.created_from_ref?.kind !== expectedAgentRefKind
      || agent.created_from_ref?.id !== formation.source_ref.id) {
      fail("ORGANIZATION_FORMATION_PROVENANCE_CONFLICT", `formation agent provenance does not match ${commandKind}: ${agentId}`);
    }
  }
  if (validateState) validateProvisioningCapacity(current, payload.agents.length);
}

function validateControllerPayload(current, command, validateState = true) {
  const payload = command.payload;
  if (command.kind === "register_persistent_agents") validatePersistentRegistrationPayload(current, payload, validateState);
  else if (command.kind === "apply_organization_decision") validateOrganizationDecisionPayload(current, payload, validateState);
  else if (command.kind === "set_persistent_agent_lifecycle") {
    exactKeys(payload, ["agent_id", "lifecycle_state", "changed_at", "accepted_session_binding"], "set_persistent_agent_lifecycle payload");
    nonempty(payload.agent_id, "agent_id");
    if (!["proposed", "provisioning", "active", "retired", "superseded"].includes(payload.lifecycle_state)) {
      fail("ORGANIZATION_COMMAND_INVALID", "lifecycle_state is invalid");
    }
    utcTimestamp(payload.changed_at, "changed_at");
    validateAcceptedSessionBinding(payload.accepted_session_binding);
  } else if (command.kind === "start_workflow" || command.kind === "start_inspection") {
    validateFormationStartPayload(current, payload, command.kind, validateState);
  } else if (command.kind === "retire_formation") {
    exactKeys(payload, ["formation_id", "retired_at"], "retire_formation payload");
    nonempty(payload.formation_id, "formation_id");
    utcTimestamp(payload.retired_at, "retired_at");
  }
}

function appendUnique(records, incoming, key, label) {
  const byId = new Map(records.map((record) => [record[key], record]));
  for (const record of incoming) {
    const id = nonempty(record?.[key], `${label}.${key}`);
    const existing = byId.get(id);
    if (existing && !sameRecord(existing, record)) {
      fail("ORGANIZATION_IDENTITY_CONFLICT", `${label} ${id} conflicts with an existing record`);
    }
    if (!existing) {
      const detached = clone(record);
      records.push(detached);
      byId.set(id, detached);
    }
  }
}

function replaceExisting(records, incoming, key, label) {
  const indexes = new Map(records.map((record, index) => [record[key], index]));
  for (const record of incoming) {
    const id = nonempty(record?.[key], `${label}.${key}`);
    const index = indexes.get(id);
    if (index === undefined) fail("ORGANIZATION_REFERENCE_MISSING", `${label} does not exist: ${id}`);
    records[index] = clone(record);
  }
}

function applyRegistration(bundle, payload) {
  appendUnique(bundle.agentRegistry.agents, payload.agents || [], "agent_id", "agent");
  appendUnique(bundle.organization.lines, payload.lines || [], "line_id", "line");
  appendUnique(bundle.organization.teams, payload.teams || [], "team_id", "team");
  appendUnique(bundle.organization.memberships, payload.memberships || [], "membership_id", "membership");
  appendUnique(bundle.organization.relationships, payload.relationships || [], "relationship_id", "relationship");
}

function applyOrganizationDecisionPatch(bundle, payload) {
  const decisionId = nonempty(payload.decision_id, "decision_id");
  const contentHash = canonicalHash(canonicalDecisionContent(payload));
  const bindings = bundle.organization.applied_decision_bindings || (bundle.organization.applied_decision_bindings = []);
  const existingBinding = bindings.find((binding) => binding.decision_id === decisionId);
  if (existingBinding) {
    if (existingBinding.content_hash !== contentHash) {
      fail("ORGANIZATION_DECISION_CONFLICT", `decision ${decisionId} was already bound to different content`);
    }
    return;
  }
  if (bundle.organization.applied_decision_ids.includes(decisionId)) {
    fail("ORGANIZATION_DECISION_CONFLICT", `decision ${decisionId} has no verifiable content binding`);
  }
  replaceExisting(bundle.organization.lines, payload.replace_lines || [], "line_id", "line");
  replaceExisting(bundle.organization.teams, payload.replace_teams || [], "team_id", "team");
  replaceExisting(bundle.organization.memberships, payload.replace_memberships || [], "membership_id", "membership");
  replaceExisting(bundle.organization.relationships, payload.replace_relationships || [], "relationship_id", "relationship");
  appendUnique(bundle.organization.lines, payload.lines || [], "line_id", "line");
  appendUnique(bundle.organization.teams, payload.teams || [], "team_id", "team");
  appendUnique(bundle.organization.memberships, payload.memberships || [], "membership_id", "membership");
  appendUnique(bundle.organization.relationships, payload.relationships || [], "relationship_id", "relationship");
  bundle.organization.applied_decision_ids.push(decisionId);
  bindings.push({ decision_id: decisionId, content_hash: contentHash });
}

function applyAgentLifecycle(bundle, payload) {
  const agentId = nonempty(payload.agent_id, "agent_id");
  const lifecycleState = nonempty(payload.lifecycle_state, "lifecycle_state");
  nonempty(payload.changed_at, "changed_at");
  const agent = bundle.agentRegistry.agents.find((record) => record.agent_id === agentId);
  if (!agent) fail("ORGANIZATION_REFERENCE_MISSING", `agent does not exist: ${agentId}`);
  const allowed = {
    proposed: new Set(["provisioning", "retired", "superseded"]),
    provisioning: new Set(["active", "retired", "superseded"]),
    active: new Set(["retired", "superseded"]),
    retired: new Set(),
    superseded: new Set(["retired"])
  };
  const binding = payload.accepted_session_binding;
  if (binding !== null && binding.agent_id !== agentId) {
    fail("AGENT_ACTIVATION_BINDING_REQUIRED", `accepted session binding must identify ${agentId}`);
  }
  const persistentActivation = agent.lifecycle_state === "provisioning"
    && lifecycleState === "active"
    && !["workflow", "inspection"].includes(agent.origin);
  if (persistentActivation) {
    if (!binding
      || binding.status !== "accepted"
      || binding.agent_id !== agentId
      || typeof binding.thread_id !== "string" || !binding.thread_id
      || typeof binding.session_id !== "string" || !binding.session_id
      || typeof binding.accepted_at !== "string" || !UTC_TIMESTAMP.test(binding.accepted_at)
      || binding.accepted_at > payload.changed_at) {
      fail("AGENT_ACTIVATION_BINDING_REQUIRED", `persistent activation requires an accepted session binding for ${agentId}`);
    }
  } else if (binding !== null) {
    fail("ORGANIZATION_COMMAND_INVALID", "accepted session binding is valid only for persistent provisioning activation");
  }
  if (agent.lifecycle_state === lifecycleState) return;
  if (!allowed[agent.lifecycle_state]?.has(lifecycleState)) {
    fail("ORGANIZATION_LIFECYCLE_CONFLICT", `agent lifecycle transition ${agent.lifecycle_state} -> ${lifecycleState} is not allowed`);
  }
  if (["retired", "superseded"].includes(lifecycleState)) {
    const activeFormation = bundle.formations.formations.find((formation) => (
      formation.lifecycle_state === "active" && (formation.member_agent_ids || []).includes(agentId)
    ));
    if (activeFormation) {
      fail("ORGANIZATION_ACTIVE_FORMATION_CONFLICT", `agent ${agentId} remains in active formation ${activeFormation.formation_id}`);
    }
    const ownedLine = bundle.organization.lines.find((line) => (
      line.status === "active" && line.owner_ref?.kind === "agent" && line.owner_ref.id === agentId
    ));
    if (ownedLine) fail("ORGANIZATION_ACTIVE_LINE_OWNER_CONFLICT", `agent ${agentId} owns active line ${ownedLine.line_id}`);
    const ledTeam = bundle.organization.teams.find((team) => team.lifecycle_state === "active" && team.lead_agent_id === agentId);
    if (ledTeam) fail("ORGANIZATION_ACTIVE_TEAM_LEAD_CONFLICT", `agent ${agentId} leads active team ${ledTeam.team_id}`);
    for (const membership of bundle.organization.memberships) {
      if (membership.agent_id !== agentId || membership.active_to !== null) continue;
      if (membership.active_from > payload.changed_at) {
        fail("ORGANIZATION_LIFECYCLE_CONFLICT", `retirement precedes active membership ${membership.membership_id}`);
      }
      membership.active_to = payload.changed_at;
    }
    bundle.organization.relationships = bundle.organization.relationships.filter((relationship) => !(
      (relationship.subject_ref?.kind === "agent" && relationship.subject_ref.id === agentId)
      || (relationship.object_ref?.kind === "agent" && relationship.object_ref.id === agentId)
    ));
  }
  agent.lifecycle_state = lifecycleState;
  agent.retired_at = lifecycleState === "retired" ? payload.changed_at : null;
}

function applyFormationStart(bundle, payload) {
  appendUnique(bundle.agentRegistry.agents, payload.agents || [], "agent_id", "agent");
  const formation = clone(payload.formation);
  const knownAgents = new Set(bundle.agentRegistry.agents.map((agent) => agent.agent_id));
  for (const agentId of formation.member_agent_ids || []) {
    if (!knownAgents.has(agentId)) fail("ORGANIZATION_REFERENCE_MISSING", `formation references missing agent: ${agentId}`);
  }
  if (formation.lead_agent_id !== null && !knownAgents.has(formation.lead_agent_id)) {
    fail("ORGANIZATION_REFERENCE_MISSING", `formation references missing lead agent: ${formation.lead_agent_id}`);
  }
  appendUnique(bundle.formations.formations, [formation], "formation_id", "formation");
}

function applyRetirement(bundle, payload) {
  const formationIdValue = nonempty(payload.formation_id, "formation_id");
  const formation = bundle.formations.formations.find((record) => record.formation_id === formationIdValue);
  if (!formation) fail("ORGANIZATION_REFERENCE_MISSING", `formation does not exist: ${formationIdValue}`);
  const retiredAt = nonempty(payload.retired_at, "retired_at");
  if (formation.lifecycle_state === "retired") return;
  const expectedOrigin = formation.formation_kind === "inspection" ? "inspection" : "workflow";
  const expectedRefKind = formation.formation_kind === "inspection" ? "inspection" : "workflow_run";
  const ephemeralAgents = (formation.member_agent_ids || [])
    .map((agentId) => bundle.agentRegistry.agents.find((record) => record.agent_id === agentId))
    .filter((agent) => agent
      && agent.origin === expectedOrigin
      && agent.created_from_ref?.kind === expectedRefKind
      && agent.created_from_ref?.id === formation.source_ref?.id);
  formation.lifecycle_state = "retired";
  formation.retired_at = retiredAt;
  for (const agent of ephemeralAgents) {
    applyAgentLifecycle(bundle, { agent_id: agent.agent_id, lifecycle_state: "retired", changed_at: retiredAt, accepted_session_binding: null });
  }
}

function applyOrganizationControllerCommand({ bundle, command, appliedCommandIds = [] } = {}) {
  const current = createOrganizationV3Bundle(bundle);
  if (!command || typeof command !== "object" || !COMMAND_KINDS.has(command.kind)) {
    fail("ORGANIZATION_COMMAND_INVALID", "Organization Controller command is invalid");
  }
  exactKeys(command, ["command_id", "kind", "expected_revision", "expected_head_hash", "payload"], "command");
  expectedRevision(command.expected_revision);
  expectedHeadHash(command.expected_head_hash);
  if (command.command_id !== commandIdFor(command)) {
    fail("ORGANIZATION_COMMAND_TAMPERED", "Organization Controller command id does not match its canonical content");
  }
  validateControllerPayload(current, command, false);
  if (appliedCommandIds.includes(command.command_id)) {
    return { status: "already_applied", bundle: current, head_hash: organizationV3HeadHash(current), command_id: command.command_id };
  }
  if (command.expected_revision !== current.organization.revision) {
    fail("ORGANIZATION_REVISION_CONFLICT", `expected revision ${command.expected_revision}, found ${current.organization.revision}`);
  }
  const currentHead = organizationV3HeadHash(current);
  if (command.expected_head_hash !== currentHead) {
    fail("ORGANIZATION_HEAD_CONFLICT", `expected head ${command.expected_head_hash}, found ${currentHead}`);
  }
  validateControllerPayload(current, command, true);

  const next = clone(current);
  if (command.kind === "apply_organization_decision") applyOrganizationDecisionPatch(next, command.payload || {});
  else if (command.kind === "register_persistent_agents") applyRegistration(next, command.payload || {});
  else if (command.kind === "set_persistent_agent_lifecycle") applyAgentLifecycle(next, command.payload || {});
  else if (command.kind === "start_workflow" || command.kind === "start_inspection") applyFormationStart(next, command.payload || {});
  else if (command.kind === "retire_formation") applyRetirement(next, command.payload || {});

  if (organizationV3HeadHash(next) === currentHead) {
    return {
      status: "no_change",
      bundle: current,
      head_hash: currentHead,
      command_id: command.command_id
    };
  }

  const nextRevision = current.organization.revision + 1;
  next.agentRegistry.organization_revision = nextRevision;
  next.organization.revision = nextRevision;
  next.formations.organization_revision = nextRevision;
  const validated = createOrganizationV3Bundle(next);
  return {
    status: "applied",
    bundle: validated,
    head_hash: organizationV3HeadHash(validated),
    command_id: command.command_id
  };
}

module.exports = {
  applyOrganizationDecisionCommand,
  applyOrganizationControllerCommand,
  organizationV3HeadHash,
  registerPersistentAgentsCommand,
  retireFormationCommand,
  setPersistentAgentLifecycleCommand,
  startInspectionFormationCommand,
  startWorkflowFormationCommand
};
