"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { canonicalHash } = require("@orquesta/contracts");

const {
  applyOrganizationDecisionCommand,
  applyOrganizationControllerCommand,
  organizationV3HeadHash,
  registerPersistentAgentsCommand,
  retireFormationCommand,
  setPersistentAgentLifecycleCommand,
  startInspectionFormationCommand,
  startWorkflowFormationCommand
} = require("../src/organization-controller-v3");
const { createFoundationOrganizationV3Bundle } = require("../src/organization-v3");

const NOW = "2026-08-15T05:40:00.000Z";

function genericCommand({ kind, expectedRevision, expectedHeadHash, payload }) {
  const content = {
    kind,
    expected_revision: expectedRevision,
    expected_head_hash: expectedHeadHash,
    payload: structuredClone(payload)
  };
  return { command_id: `OC-${canonicalHash(content).slice(0, 16)}`, ...content };
}

function baseBundle() {
  return {
    agentRegistry: {
      schema_version: 3,
      organization_revision: 1,
      agents: [
        {
          agent_id: "orchestrator",
          role_id: "orchestrator",
          role_version: 1,
          mission: "Coordinate the project.",
          context_scope: ["project"],
          lifecycle_state: "active",
          origin: "foundation",
          created_from_ref: { kind: "project_bootstrap", id: "bootstrap-1" },
          retired_at: null
        },
        {
          agent_id: "orquesta-admin",
          role_id: "orquesta-admin",
          role_version: 1,
          mission: "Maintain Orquesta.",
          context_scope: ["project"],
          lifecycle_state: "active",
          origin: "foundation",
          created_from_ref: { kind: "project_bootstrap", id: "bootstrap-1" },
          retired_at: null
        },
        {
          agent_id: "user-support",
          role_id: "user-support",
          role_version: 1,
          mission: "Support the user.",
          context_scope: ["project"],
          lifecycle_state: "active",
          origin: "foundation",
          created_from_ref: { kind: "project_bootstrap", id: "bootstrap-1" },
          retired_at: null
        },
        {
          agent_id: "implementation-001",
          role_id: "implementation",
          role_version: 1,
          mission: "Implement assigned work.",
          context_scope: ["line-a"],
          lifecycle_state: "active",
          origin: "controller",
          created_from_ref: { kind: "task", id: "T-1" },
          retired_at: null
        }
      ]
    },
    organization: {
      schema_version: 3,
      revision: 1,
      policy: {
        line_creation: "review",
        max_concurrent_provisioning: 3,
        require_executable_task_per_new_agent: true,
        require_no_file_ownership_conflict: true
      },
      participants: [{ participant_id: "user", display_name: "User", participant_kind: "human", lifecycle_state: "active", joined_at: NOW }],
      lines: [
        {
          line_id: "line-a",
          display_name: "Line A",
          goal: "Build the product.",
          deliverable_ids: ["deliverable-a"],
          completion_root_ids: ["T-1"],
          scope: ["."],
          owner_ref: { kind: "agent", id: "orchestrator" },
          status: "active",
          approval_source: "user_approval"
        }
      ],
      teams: [
        {
          team_id: "implementation",
          line_id: "line-a",
          display_name: "Implementation",
          purpose: "Implement product work.",
          coordination_mode: "peer",
          lead_agent_id: null,
          lifecycle_state: "active"
        }
      ],
      memberships: [
        {
          membership_id: "membership-implementation-001",
          agent_id: "implementation-001",
          team_id: "implementation",
          position: "member",
          ordinal: 1,
          active_from: NOW,
          active_to: null
        }
      ],
      relationships: [{
        relationship_id: "relationship-user-authority-orchestrator",
        type: "authority_over",
        subject_ref: { kind: "participant", id: "user" },
        object_ref: { kind: "agent", id: "orchestrator" }
      }],
      applied_decision_ids: [],
      applied_decision_bindings: []
    },
    formations: { schema_version: 1, organization_revision: 1, formations: [] }
  };
}

function placementEvidence(agentId, executableTaskId, suffix = agentId) {
  return {
    agent_id: agentId,
    placement_intent_id: `PI-${suffix}`,
    executable_task_id: executableTaskId
  };
}

test("typed Workflow and inspection starts create formations through one revisioned mutation boundary", () => {
  const initial = baseBundle();
  const workflow = startWorkflowFormationCommand({
    expectedRevision: 1,
    expectedHeadHash: organizationV3HeadHash(initial),
    workflowRunId: "run-1",
    scopeRef: { kind: "line", id: "line-a" },
    memberAgentIds: ["implementation-001"],
    coordinationMode: "workflow_managed",
    leadAgentId: null,
    createdAt: NOW
  });
  const first = applyOrganizationControllerCommand({ bundle: initial, command: workflow, appliedCommandIds: [] });
  assert.equal(first.status, "applied");
  assert.equal(first.bundle.organization.revision, 2);
  assert.equal(first.bundle.formations.formations[0].formation_kind, "work_cell");

  const inspection = startInspectionFormationCommand({
    expectedRevision: 2,
    expectedHeadHash: first.head_hash,
    sourceTaskId: "T-INSPECT",
    scopeRef: { kind: "agent", id: "implementation-001" },
    memberAgentIds: ["orchestrator"],
    targetRefs: [{ kind: "agent", id: "implementation-001" }],
    coordinationMode: "peer",
    leadAgentId: null,
    createdAt: NOW
  });
  const second = applyOrganizationControllerCommand({ bundle: first.bundle, command: inspection, appliedCommandIds: [workflow.command_id] });
  assert.equal(second.bundle.organization.revision, 3);
  assert.equal(second.bundle.formations.formations.some((formation) => formation.formation_kind === "inspection"), true);
});

test("inspection start and retirement atomically register then retire its ephemeral agent", () => {
  const initial = baseBundle();
  const inspection = startInspectionFormationCommand({
    expectedRevision: 1,
    expectedHeadHash: organizationV3HeadHash(initial),
    sourceTaskId: "AUDIT-EPHEMERAL",
    scopeRef: { kind: "project", id: "repo-1" },
    memberAgentIds: ["inspection-a1b2c3", "orchestrator"],
    targetRefs: [{ kind: "project", id: "repo-1" }],
    coordinationMode: "peer",
    leadAgentId: null,
    createdAt: NOW,
    agents: [{
      agent_id: "inspection-a1b2c3",
      role_id: "inspection",
      role_version: 1,
      mission: "Inspect the selected project scope.",
      context_scope: ["project:repo-1"],
      lifecycle_state: "provisioning",
      origin: "inspection",
      created_from_ref: { kind: "inspection", id: "AUDIT-EPHEMERAL" },
      retired_at: null
    }]
  });
  const started = applyOrganizationControllerCommand({ bundle: initial, command: inspection });
  const formation = started.bundle.formations.formations.find(({ source_ref }) => source_ref.id === "AUDIT-EPHEMERAL");
  assert.equal(formation.member_agent_ids[0], "inspection-a1b2c3");
  const retired = applyOrganizationControllerCommand({
    bundle: started.bundle,
    command: retireFormationCommand({
      expectedRevision: 2,
      expectedHeadHash: started.head_hash,
      formationId: formation.formation_id,
      retiredAt: NOW
    })
  });
  assert.equal(retired.bundle.formations.formations.find(({ formation_id }) => formation_id === formation.formation_id).lifecycle_state, "retired");
  assert.equal(retired.bundle.agentRegistry.agents.find(({ agent_id }) => agent_id === "inspection-a1b2c3").lifecycle_state, "retired");
  assert.equal(retired.bundle.agentRegistry.agents.find(({ agent_id }) => agent_id === "orchestrator").lifecycle_state, "active");
});

test("persistent registration starts new controller agents in provisioning and is idempotent by command id", () => {
  const initial = baseBundle();
  const command = registerPersistentAgentsCommand({
    expectedRevision: 1,
    expectedHeadHash: organizationV3HeadHash(initial),
    agents: [{
      agent_id: "testing-001",
      role_id: "testing",
      role_version: 1,
      mission: "Test assigned work.",
      context_scope: ["line-a"],
      lifecycle_state: "provisioning",
      origin: "controller",
      created_from_ref: { kind: "task", id: "T-2" },
      retired_at: null
    }],
    placementEvidence: [placementEvidence("testing-001", "T-2")],
    teams: [],
    memberships: [{
      membership_id: "membership-testing-001",
      agent_id: "testing-001",
      team_id: "implementation",
      position: "member",
      ordinal: 2,
      active_from: NOW,
      active_to: null
    }]
  });
  const first = applyOrganizationControllerCommand({ bundle: initial, command, appliedCommandIds: [] });
  assert.equal(first.bundle.agentRegistry.agents.some((agent) => agent.agent_id === "testing-001"), true);
  const repeated = applyOrganizationControllerCommand({ bundle: first.bundle, command, appliedCommandIds: [command.command_id] });
  assert.equal(repeated.status, "already_applied");
  assert.equal(repeated.bundle.organization.revision, 2);

});

test("persistent registration owns explicit lines and relationships, then lifecycle activation is a separate command", () => {
  const initial = baseBundle();
  const registered = applyOrganizationControllerCommand({
    bundle: initial,
    command: registerPersistentAgentsCommand({
      expectedRevision: 1,
      expectedHeadHash: organizationV3HeadHash(initial),
      agents: [{
        agent_id: "testing-001",
        role_id: "testing",
        role_version: 1,
        mission: "Test the accepted task.",
        context_scope: ["task:T-001"],
        lifecycle_state: "provisioning",
        origin: "controller",
        created_from_ref: { kind: "task", id: "T-001" },
        retired_at: null
      }],
      placementEvidence: [placementEvidence("testing-001", "T-001", "testing-line")],
      lines: [{
        line_id: "product-line",
        display_name: "Product",
        goal: "Deliver the product.",
        deliverable_ids: ["product"],
        completion_root_ids: ["T-001"],
        scope: ["."],
        owner_ref: { kind: "agent", id: "orchestrator" },
        status: "active",
        approval_source: "user_approval"
      }],
      teams: [{
        team_id: "testing-team",
        line_id: "product-line",
        display_name: "Testing",
        purpose: "Test the product.",
        coordination_mode: "peer",
        lead_agent_id: null,
        lifecycle_state: "active"
      }],
      memberships: [{
        membership_id: "membership-testing-001",
        agent_id: "testing-001",
        team_id: "testing-team",
        position: "member",
        ordinal: 1,
        active_from: NOW,
        active_to: null
      }],
      relationships: [{
        relationship_id: "relationship-testing-001-orchestrator",
        type: "reports_to",
        subject_ref: { kind: "agent", id: "testing-001" },
        object_ref: { kind: "agent", id: "orchestrator" }
      }]
    })
  });
  assert.equal(registered.bundle.organization.lines.some(({ line_id }) => line_id === "product-line"), true);
  assert.equal(registered.bundle.organization.relationships.some(({ subject_ref }) => subject_ref.id === "testing-001"), true);
  assert.equal(registered.bundle.agentRegistry.agents.find(({ agent_id }) => agent_id === "testing-001").lifecycle_state, "provisioning");

  const unboundActivation = setPersistentAgentLifecycleCommand({
    expectedRevision: 2,
    expectedHeadHash: registered.head_hash,
    agentId: "testing-001",
    lifecycleState: "active",
    changedAt: NOW
  });
  assert.throws(() => applyOrganizationControllerCommand({
    bundle: registered.bundle,
    command: unboundActivation
  }), { code: "AGENT_ACTIVATION_BINDING_REQUIRED" });

  const activated = applyOrganizationControllerCommand({
    bundle: registered.bundle,
    command: setPersistentAgentLifecycleCommand({
      expectedRevision: 2,
      expectedHeadHash: registered.head_hash,
      agentId: "testing-001",
      lifecycleState: "active",
      changedAt: NOW,
      acceptedSessionBinding: {
        status: "accepted",
        agent_id: "testing-001",
        thread_id: "thread-testing-001",
        session_id: "session-testing-001",
        accepted_at: NOW
      }
    })
  });
  assert.equal(activated.bundle.agentRegistry.agents.find(({ agent_id }) => agent_id === "testing-001").lifecycle_state, "active");
  assert.throws(() => applyOrganizationControllerCommand({
    bundle: activated.bundle,
    command: setPersistentAgentLifecycleCommand({
      expectedRevision: 3,
      expectedHeadHash: activated.head_hash,
      agentId: "testing-001",
      lifecycleState: "provisioning",
      changedAt: NOW
    })
  }), /transition/i);
});

test("foundation activation requires an accepted binding for that exact agent session", () => {
  const initial = createFoundationOrganizationV3Bundle({ createdAt: NOW, bootstrapId: "bootstrap-activation" });
  const head = organizationV3HeadHash(initial);
  const unbound = setPersistentAgentLifecycleCommand({
    expectedRevision: 1,
    expectedHeadHash: head,
    agentId: "orchestrator",
    lifecycleState: "active",
    changedAt: NOW
  });
  assert.throws(() => applyOrganizationControllerCommand({ bundle: initial, command: unbound }), { code: "AGENT_ACTIVATION_BINDING_REQUIRED" });

  const wrongBindingOnNoop = setPersistentAgentLifecycleCommand({
    expectedRevision: 1,
    expectedHeadHash: head,
    agentId: "orchestrator",
    lifecycleState: "provisioning",
    changedAt: NOW,
    acceptedSessionBinding: {
      status: "accepted",
      agent_id: "orquesta-admin",
      thread_id: "thread-wrong",
      session_id: "session-wrong",
      accepted_at: NOW
    }
  });
  assert.throws(() => applyOrganizationControllerCommand({ bundle: initial, command: wrongBindingOnNoop }), { code: "AGENT_ACTIVATION_BINDING_REQUIRED" });

  const futureBinding = setPersistentAgentLifecycleCommand({
    expectedRevision: 1,
    expectedHeadHash: head,
    agentId: "orchestrator",
    lifecycleState: "active",
    changedAt: NOW,
    acceptedSessionBinding: {
      status: "accepted",
      agent_id: "orchestrator",
      thread_id: "thread-future",
      session_id: "session-future",
      accepted_at: "2026-08-15T05:41:00.000Z"
    }
  });
  assert.throws(() => applyOrganizationControllerCommand({ bundle: initial, command: futureBinding }), { code: "AGENT_ACTIVATION_BINDING_REQUIRED" });

  const bound = setPersistentAgentLifecycleCommand({
    expectedRevision: 1,
    expectedHeadHash: head,
    agentId: "orchestrator",
    lifecycleState: "active",
    changedAt: NOW,
    acceptedSessionBinding: {
      status: "accepted",
      agent_id: "orchestrator",
      thread_id: "thread-orchestrator",
      session_id: "session-orchestrator",
      accepted_at: NOW
    }
  });
  const activated = applyOrganizationControllerCommand({ bundle: initial, command: bound });
  assert.equal(activated.bundle.agentRegistry.agents.find(({ agent_id }) => agent_id === "orchestrator").lifecycle_state, "active");
});

test("an organization decision adds and replaces explicit structure while recording one decision id", () => {
  const initial = baseBundle();
  const added = applyOrganizationControllerCommand({
    bundle: initial,
    command: applyOrganizationDecisionCommand({
      expectedRevision: 1,
      expectedHeadHash: organizationV3HeadHash(initial),
      decisionId: "OD-123456abcdef",
      lines: [{
        line_id: "testing-line", display_name: "Testing", goal: "Test releases.",
        deliverable_ids: ["quality"], completion_root_ids: ["CM-QUALITY"], scope: ["tests"],
        owner_ref: { kind: "participant", id: "user" }, status: "active", approval_source: "user_approval"
      }]
    })
  });
  assert.equal(added.bundle.organization.applied_decision_ids.includes("OD-123456abcdef"), true);
  assert.equal(added.bundle.organization.lines.some(({ line_id }) => line_id === "testing-line"), true);

  const promoted = applyOrganizationControllerCommand({
    bundle: added.bundle,
    command: applyOrganizationDecisionCommand({
      expectedRevision: 2,
      expectedHeadHash: added.head_hash,
      decisionId: "OD-abcdef123456",
      replaceTeams: [{
        ...added.bundle.organization.teams[0], coordination_mode: "supervised", lead_agent_id: "implementation-001"
      }],
      replaceMemberships: [{
        ...added.bundle.organization.memberships.find(({ agent_id }) => agent_id === "implementation-001"),
        position: "lead"
      }]
    })
  });
  assert.equal(promoted.bundle.organization.teams[0].lead_agent_id, "implementation-001");
  assert.equal(promoted.bundle.organization.applied_decision_ids.length, 2);

  const repeated = applyOrganizationControllerCommand({
    bundle: promoted.bundle,
    command: applyOrganizationDecisionCommand({
      expectedRevision: 3,
      expectedHeadHash: promoted.head_hash,
      decisionId: "OD-abcdef123456",
      replaceTeams: [{
        ...promoted.bundle.organization.teams[0]
      }],
      replaceMemberships: [{
        ...promoted.bundle.organization.memberships.find(({ agent_id }) => agent_id === "implementation-001")
      }]
    })
  });
  assert.equal(repeated.status, "no_change");
  assert.equal(repeated.bundle.organization.revision, 3);

  assert.throws(() => applyOrganizationControllerCommand({
    bundle: promoted.bundle,
    command: applyOrganizationDecisionCommand({
      expectedRevision: 3,
      expectedHeadHash: promoted.head_hash,
      decisionId: "OD-abcdef123456"
    })
  }), { code: "ORGANIZATION_DECISION_CONFLICT" });
});

test("decision content binding treats set-like record order as the same decision", () => {
  const initial = baseBundle();
  const lines = [
    { line_id: "order-a", display_name: "Order A", goal: "A", deliverable_ids: ["A", "B"], completion_root_ids: ["CM-A", "CM-B"], scope: ["a", "b"], owner_ref: { kind: "participant", id: "user" }, status: "active", approval_source: "user_approval" },
    { line_id: "order-b", display_name: "Order B", goal: "B", deliverable_ids: ["B"], completion_root_ids: ["CM-B"], scope: ["b"], owner_ref: { kind: "participant", id: "user" }, status: "active", approval_source: "user_approval" }
  ];
  const first = applyOrganizationControllerCommand({
    bundle: initial,
    command: applyOrganizationDecisionCommand({
      expectedRevision: 1,
      expectedHeadHash: organizationV3HeadHash(initial),
      decisionId: "OD-111111111111",
      lines
    })
  });
  const reordered = applyOrganizationControllerCommand({
    bundle: first.bundle,
    command: applyOrganizationDecisionCommand({
      expectedRevision: 2,
      expectedHeadHash: first.head_hash,
      decisionId: "OD-111111111111",
      lines: [...lines].reverse().map((line) => line.line_id === "order-a" ? {
        ...line,
        deliverable_ids: [...line.deliverable_ids].reverse(),
        completion_root_ids: [...line.completion_root_ids].reverse(),
        scope: [...line.scope].reverse()
      } : line)
    })
  });
  assert.equal(reordered.status, "no_change");
  assert.equal(reordered.bundle.organization.revision, 2);
});

test("stale heads, missing members, and malformed commands fail before mutation", () => {
  const initial = baseBundle();
  const staleRevision = startWorkflowFormationCommand({
    expectedRevision: 0,
    expectedHeadHash: organizationV3HeadHash(initial),
    workflowRunId: "run-stale-revision",
    scopeRef: { kind: "project", id: "project" },
    memberAgentIds: ["implementation-001"],
    coordinationMode: "peer",
    leadAgentId: null,
    createdAt: NOW
  });
  assert.throws(() => applyOrganizationControllerCommand({ bundle: initial, command: staleRevision }), { code: "ORGANIZATION_REVISION_CONFLICT" });

  const command = startWorkflowFormationCommand({
    expectedRevision: 1,
    expectedHeadHash: "0".repeat(64),
    workflowRunId: "run-stale",
    scopeRef: { kind: "project", id: "project" },
    memberAgentIds: ["implementation-001"],
    coordinationMode: "peer",
    leadAgentId: null,
    createdAt: NOW
  });
  assert.throws(() => applyOrganizationControllerCommand({ bundle: initial, command, appliedCommandIds: [] }), { code: "ORGANIZATION_HEAD_CONFLICT" });

  const missing = startWorkflowFormationCommand({
    expectedRevision: 1,
    expectedHeadHash: organizationV3HeadHash(initial),
    workflowRunId: "run-missing",
    scopeRef: { kind: "project", id: "project" },
    memberAgentIds: ["missing-agent"],
    coordinationMode: "peer",
    leadAgentId: null,
    createdAt: NOW
  });
  assert.throws(() => applyOrganizationControllerCommand({ bundle: initial, command: missing, appliedCommandIds: [] }), /missing agent/);
});

test("the apply boundary rejects generic payload bypasses for every specialized authority", () => {
  const initial = baseBundle();
  const head = organizationV3HeadHash(initial);
  const decisionInjection = genericCommand({
    kind: "apply_organization_decision",
    expectedRevision: 1,
    expectedHeadHash: head,
    payload: {
      decision_id: "OD-222222222222",
      participants: [],
      lines: [], teams: [], memberships: [], relationships: [],
      replace_lines: [], replace_teams: [], replace_memberships: [], replace_relationships: []
    }
  });
  assert.throws(() => applyOrganizationControllerCommand({ bundle: initial, command: decisionInjection }), { code: "ORGANIZATION_COMMAND_INVALID" });

  const workflow = startWorkflowFormationCommand({
    expectedRevision: 1, expectedHeadHash: head, workflowRunId: "run-generic-bypass",
    scopeRef: { kind: "project", id: "project" }, memberAgentIds: ["implementation-001"],
    coordinationMode: "peer", leadAgentId: null, createdAt: NOW
  });
  const mismatchedInspection = genericCommand({
    kind: "start_inspection", expectedRevision: 1, expectedHeadHash: head, payload: workflow.payload
  });
  assert.throws(() => applyOrganizationControllerCommand({ bundle: initial, command: mismatchedInspection }), { code: "ORGANIZATION_FORMATION_KIND_CONFLICT" });

  const retireInjection = genericCommand({
    kind: "retire_formation", expectedRevision: 1, expectedHeadHash: head,
    payload: { formation_id: "formation-any", retired_at: NOW, agent_ids: [] }
  });
  assert.throws(() => applyOrganizationControllerCommand({ bundle: initial, command: retireInjection }), { code: "ORGANIZATION_COMMAND_INVALID" });

  const registrationInjection = genericCommand({
    kind: "register_persistent_agents", expectedRevision: 1, expectedHeadHash: head,
    payload: {
      agents: [], lines: [], teams: [], memberships: [], relationships: [], placement_evidence: [],
      participants: [{ participant_id: "rogue", display_name: "Rogue", participant_kind: "human", lifecycle_state: "active", joined_at: NOW }]
    }
  });
  assert.throws(() => applyOrganizationControllerCommand({ bundle: initial, command: registrationInjection }), { code: "ORGANIZATION_COMMAND_INVALID" });

  const extraEnvelopeField = structuredClone(workflow);
  extraEnvelopeField.unbound_authority = true;
  assert.throws(() => applyOrganizationControllerCommand({ bundle: initial, command: extraEnvelopeField }), { code: "ORGANIZATION_COMMAND_INVALID" });
});

test("formation start accepts only attached, newly provisioned agents with source-matched ephemeral provenance", () => {
  const initial = baseBundle();
  const head = organizationV3HeadHash(initial);
  const agent = {
    agent_id: "workflow-worker", role_id: "implementation", role_version: 1,
    mission: "Run bounded workflow work.", context_scope: ["project"], lifecycle_state: "provisioning",
    origin: "workflow", created_from_ref: { kind: "workflow_run", id: "run-provenance" }, retired_at: null
  };
  const unattached = startWorkflowFormationCommand({
    expectedRevision: 1, expectedHeadHash: head, workflowRunId: "run-provenance",
    scopeRef: { kind: "project", id: "project" }, memberAgentIds: ["implementation-001"],
    coordinationMode: "peer", leadAgentId: null, createdAt: NOW, agents: [agent]
  });
  assert.throws(() => applyOrganizationControllerCommand({ bundle: initial, command: unattached }), { code: "ORGANIZATION_FORMATION_AGENT_CONFLICT" });

  const wrongProvenance = startWorkflowFormationCommand({
    expectedRevision: 1, expectedHeadHash: head, workflowRunId: "run-provenance",
    scopeRef: { kind: "project", id: "project" }, memberAgentIds: ["workflow-worker"],
    coordinationMode: "peer", leadAgentId: null, createdAt: NOW,
    agents: [{ ...agent, origin: "controller", created_from_ref: { kind: "task", id: "T-WRONG" } }]
  });
  assert.throws(() => applyOrganizationControllerCommand({ bundle: initial, command: wrongProvenance }), { code: "ORGANIZATION_FORMATION_PROVENANCE_CONFLICT" });

  const existingRewrite = startWorkflowFormationCommand({
    expectedRevision: 1, expectedHeadHash: head, workflowRunId: "run-existing",
    scopeRef: { kind: "project", id: "project" }, memberAgentIds: ["implementation-001"],
    coordinationMode: "peer", leadAgentId: null, createdAt: NOW,
    agents: [{
      ...initial.agentRegistry.agents.find(({ agent_id }) => agent_id === "implementation-001"),
      lifecycle_state: "provisioning",
      origin: "workflow",
      created_from_ref: { kind: "workflow_run", id: "run-existing" }
    }]
  });
  assert.throws(() => applyOrganizationControllerCommand({ bundle: initial, command: existingRewrite }), { code: "ORGANIZATION_FORMATION_AGENT_CONFLICT" });

  const firstSource = startWorkflowFormationCommand({
    expectedRevision: 1, expectedHeadHash: head, workflowRunId: "run-one",
    scopeRef: { kind: "project", id: "project" }, memberAgentIds: ["workflow-worker-one"],
    coordinationMode: "peer", leadAgentId: null, createdAt: NOW,
    agents: [{ ...agent, agent_id: "workflow-worker-one", created_from_ref: { kind: "workflow_run", id: "run-one" } }]
  });
  const firstStarted = applyOrganizationControllerCommand({ bundle: initial, command: firstSource });
  const secondSource = startWorkflowFormationCommand({
    expectedRevision: 2, expectedHeadHash: firstStarted.head_hash, workflowRunId: "run-two",
    scopeRef: { kind: "project", id: "project" }, memberAgentIds: ["workflow-worker-one"],
    coordinationMode: "peer", leadAgentId: null, createdAt: NOW
  });
  assert.throws(() => applyOrganizationControllerCommand({ bundle: firstStarted.bundle, command: secondSource }), { code: "ORGANIZATION_FORMATION_AGENT_CONFLICT" });

  const foundation = createFoundationOrganizationV3Bundle({ createdAt: NOW, bootstrapId: "bootstrap-unbound-member" });
  const unboundPersistentMember = startWorkflowFormationCommand({
    expectedRevision: 1, expectedHeadHash: organizationV3HeadHash(foundation), workflowRunId: "run-unbound-member",
    scopeRef: { kind: "project", id: "project" }, memberAgentIds: ["orchestrator"],
    coordinationMode: "peer", leadAgentId: null, createdAt: NOW
  });
  assert.throws(() => applyOrganizationControllerCommand({ bundle: foundation, command: unboundPersistentMember }), { code: "ORGANIZATION_FORMATION_MEMBER_NOT_READY" });
});

test("formation command identity canonicalizes nested member and target sets", () => {
  const initial = baseBundle();
  const common = {
    expectedRevision: 1,
    expectedHeadHash: organizationV3HeadHash(initial),
    sourceTaskId: "T-CANONICAL",
    scopeRef: { kind: "project", id: "project" },
    coordinationMode: "peer",
    leadAgentId: null,
    createdAt: NOW
  };
  const first = startInspectionFormationCommand({
    ...common,
    memberAgentIds: ["orchestrator", "implementation-001"],
    targetRefs: [{ kind: "line", id: "line-a" }, { kind: "agent", id: "implementation-001" }]
  });
  const second = startInspectionFormationCommand({
    ...common,
    memberAgentIds: ["implementation-001", "orchestrator"],
    targetRefs: [{ kind: "agent", id: "implementation-001" }, { kind: "line", id: "line-a" }]
  });
  assert.equal(first.command_id, second.command_id);
  assert.deepEqual(first.payload, second.payload);
});

test("bundle policy gates provisioning capacity, placement evidence, and line creation", () => {
  const foundation = createFoundationOrganizationV3Bundle({ createdAt: NOW, bootstrapId: "bootstrap-policy" });
  const newAgent = {
    agent_id: "fourth-provisioning", role_id: "implementation", role_version: 1,
    mission: "Wait for capacity.", context_scope: ["project"], lifecycle_state: "provisioning",
    origin: "controller", created_from_ref: { kind: "task", id: "T-FOURTH" }, retired_at: null
  };
  const withoutEvidence = registerPersistentAgentsCommand({
    expectedRevision: 1, expectedHeadHash: organizationV3HeadHash(foundation), agents: [newAgent], placementEvidence: []
  });
  assert.throws(() => applyOrganizationControllerCommand({ bundle: foundation, command: withoutEvidence }), { code: "ORGANIZATION_PLACEMENT_EVIDENCE_REQUIRED" });
  const unrelatedEvidence = registerPersistentAgentsCommand({
    expectedRevision: 1, expectedHeadHash: organizationV3HeadHash(foundation), agents: [newAgent],
    placementEvidence: [{ ...placementEvidence("fourth-provisioning", "T-FOURTH"), executable_task_id: "T-UNRELATED" }]
  });
  assert.throws(() => applyOrganizationControllerCommand({ bundle: foundation, command: unrelatedEvidence }), { code: "ORGANIZATION_PLACEMENT_EVIDENCE_CONFLICT" });
  const overCapacity = registerPersistentAgentsCommand({
    expectedRevision: 1, expectedHeadHash: organizationV3HeadHash(foundation), agents: [newAgent],
    placementEvidence: [placementEvidence("fourth-provisioning", "T-FOURTH")]
  });
  assert.throws(() => applyOrganizationControllerCommand({ bundle: foundation, command: overCapacity }), { code: "ORGANIZATION_PROVISIONING_CAPACITY" });

  const line = {
    line_id: "policy-line", display_name: "Policy", goal: "Test policy.",
    deliverable_ids: ["D-POLICY"], completion_root_ids: ["CM-POLICY"], scope: ["policy"],
    owner_ref: { kind: "participant", id: "user" }, status: "active", approval_source: "user_approval"
  };
  const forbidden = baseBundle();
  forbidden.organization.policy.line_creation = "forbidden";
  const forbiddenCommand = applyOrganizationDecisionCommand({
    expectedRevision: 1, expectedHeadHash: organizationV3HeadHash(forbidden), decisionId: "OD-333333333333", lines: [line]
  });
  assert.throws(() => applyOrganizationControllerCommand({ bundle: forbidden, command: forbiddenCommand }), { code: "ORGANIZATION_LINE_CREATION_FORBIDDEN" });

  const review = baseBundle();
  const reviewCommand = applyOrganizationDecisionCommand({
    expectedRevision: 1, expectedHeadHash: organizationV3HeadHash(review), decisionId: "OD-444444444444",
    lines: [{ ...line, approval_source: "organization_decision" }]
  });
  assert.throws(() => applyOrganizationControllerCommand({ bundle: review, command: reviewCommand }), { code: "ORGANIZATION_LINE_APPROVAL_REQUIRED" });

  const autonomous = baseBundle();
  autonomous.organization.policy.line_creation = "autonomous";
  const autonomousCommand = applyOrganizationDecisionCommand({
    expectedRevision: 1, expectedHeadHash: organizationV3HeadHash(autonomous), decisionId: "OD-555555555555",
    lines: [{ ...line, approval_source: "organization_decision" }]
  });
  assert.equal(applyOrganizationControllerCommand({ bundle: autonomous, command: autonomousCommand }).status, "applied");
});

test("persistent lifecycle retirement closes memberships and current relationships but refuses active formation members", () => {
  const initial = baseBundle();
  initial.organization.relationships.push({
    relationship_id: "implementation-reports", type: "reports_to",
    subject_ref: { kind: "agent", id: "implementation-001" }, object_ref: { kind: "agent", id: "orchestrator" }
  });
  const retired = applyOrganizationControllerCommand({
    bundle: initial,
    command: setPersistentAgentLifecycleCommand({
      expectedRevision: 1, expectedHeadHash: organizationV3HeadHash(initial),
      agentId: "implementation-001", lifecycleState: "retired", changedAt: NOW
    })
  });
  assert.equal(retired.bundle.organization.memberships.find(({ agent_id }) => agent_id === "implementation-001").active_to, NOW);
  assert.equal(retired.bundle.organization.relationships.some(({ relationship_id }) => relationship_id === "implementation-reports"), false);

  const formationStart = startWorkflowFormationCommand({
    expectedRevision: 1, expectedHeadHash: organizationV3HeadHash(baseBundle()), workflowRunId: "run-active-member",
    scopeRef: { kind: "project", id: "project" }, memberAgentIds: ["implementation-001"],
    coordinationMode: "peer", leadAgentId: null, createdAt: NOW
  });
  const formed = applyOrganizationControllerCommand({ bundle: baseBundle(), command: formationStart });
  const conflictingRetirement = setPersistentAgentLifecycleCommand({
    expectedRevision: 2, expectedHeadHash: formed.head_hash,
    agentId: "implementation-001", lifecycleState: "retired", changedAt: NOW
  });
  assert.throws(() => applyOrganizationControllerCommand({ bundle: formed.bundle, command: conflictingRetirement }), { code: "ORGANIZATION_ACTIVE_FORMATION_CONFLICT" });
});

test("direct active persistent registration is rejected before mutation", () => {
  const initial = baseBundle();
  const command = registerPersistentAgentsCommand({
    expectedRevision: 1,
    expectedHeadHash: organizationV3HeadHash(initial),
    agents: [{
      agent_id: "direct-active", role_id: "implementation", role_version: 1,
      mission: "Bypass provisioning.", context_scope: ["project"], lifecycle_state: "active",
      origin: "controller", created_from_ref: { kind: "task", id: "T-DIRECT" }, retired_at: null
    }],
    placementEvidence: [placementEvidence("direct-active", "T-DIRECT")]
  });
  assert.throws(() => applyOrganizationControllerCommand({ bundle: initial, command }), { code: "ORGANIZATION_PROVISIONING_REQUIRED" });
  assert.equal(initial.agentRegistry.agents.some(({ agent_id }) => agent_id === "direct-active"), false);
});

test("commands and reductions do not mutate caller-owned inputs", () => {
  const initial = baseBundle();
  const initialSnapshot = structuredClone(initial);
  const agent = {
    agent_id: "testing-immutable",
    role_id: "testing",
    role_version: 1,
    mission: "Test immutable command inputs.",
    context_scope: ["line-a"],
    lifecycle_state: "provisioning",
    origin: "controller",
    created_from_ref: { kind: "task", id: "T-IMMUTABLE" },
    retired_at: null
  };
  const command = registerPersistentAgentsCommand({
    expectedRevision: 1,
    expectedHeadHash: organizationV3HeadHash(initial),
    agents: [agent],
    placementEvidence: [placementEvidence("testing-immutable", "T-IMMUTABLE")],
    memberships: [{
      membership_id: "membership-testing-immutable",
      agent_id: "testing-immutable",
      team_id: "implementation",
      position: "member",
      ordinal: 2,
      active_from: NOW,
      active_to: null
    }]
  });
  assert.equal(Object.isFrozen(command), true);
  assert.equal(Object.isFrozen(command.payload), true);
  assert.equal(Object.isFrozen(command.payload.agents[0]), true);
  assert.throws(() => { command.payload.agents[0].mission = "tampered"; }, TypeError);
  const forged = structuredClone(command);
  forged.payload.agents[0].mission = "forged after command construction";
  assert.throws(() => applyOrganizationControllerCommand({ bundle: initial, command: forged }), { code: "ORGANIZATION_COMMAND_TAMPERED" });
  agent.mission = "mutated after command construction";
  const result = applyOrganizationControllerCommand({ bundle: initial, command });
  assert.deepEqual(initial, initialSnapshot);
  assert.equal(result.bundle.agentRegistry.agents.find(({ agent_id }) => agent_id === "testing-immutable").mission, "Test immutable command inputs.");
});
