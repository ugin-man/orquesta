import type { AgentCreationRefKind, AgentV3, OrganizationLineV3, OrganizationStateV3, OrganizationV3Bundle as ContractOrganizationV3Bundle } from "@orquesta/contracts";
import {
  applyOrganizationDecisionCommand,
  createFoundationOrganizationV3Bundle,
  registerPersistentAgentsCommand,
  type OrganizationControllerCommandKind,
  type PersistentProvisioningAgentV3,
  type OrganizationV3Bundle
} from "../src";

const bundle: OrganizationV3Bundle = createFoundationOrganizationV3Bundle({
  createdAt: "2026-08-24T00:00:00.000Z",
  bootstrapId: "bootstrap-types"
});
const contractBundle: ContractOrganizationV3Bundle = bundle;
const agent: AgentV3 = contractBundle.agentRegistry.agents[0];
const provisioningAgent: PersistentProvisioningAgentV3 = {
  agent_id: "implementation-types",
  role_id: "implementation",
  role_version: 1,
  mission: "Prove strict controller types.",
  context_scope: ["project"],
  lifecycle_state: "provisioning",
  origin: "controller",
  created_from_ref: { kind: "task", id: "T-TYPES" },
  retired_at: null
};
const command = registerPersistentAgentsCommand({
  expectedRevision: bundle.organization.revision,
  expectedHeadHash: "0".repeat(64),
  agents: [provisioningAgent],
  placementEvidence: [{
    agent_id: provisioningAgent.agent_id,
    placement_intent_id: "PI-types",
    executable_task_id: "T-TYPES"
  }]
});
const kind: OrganizationControllerCommandKind = command.kind;
// @ts-expect-error organization decisions cannot create agents outside placement registration.
applyOrganizationDecisionCommand({ expectedRevision: 1, expectedHeadHash: "0".repeat(64), decisionId: "OD-111111111111", agents: [agent] });
// @ts-expect-error persistent registration cannot skip provisioning.
registerPersistentAgentsCommand({ expectedRevision: 1, expectedHeadHash: "0".repeat(64), agents: [{ ...provisioningAgent, lifecycle_state: "active" }], placementEvidence: [{ agent_id: provisioningAgent.agent_id, placement_intent_id: "PI-types", executable_task_id: "T-TYPES" }] });
// @ts-expect-error persistent registration cannot bypass placement evidence.
registerPersistentAgentsCommand({ expectedRevision: 1, expectedHeadHash: "0".repeat(64), agents: [provisioningAgent] });
// @ts-expect-error organization decisions cannot substitute for an executable task provenance in placement registration.
registerPersistentAgentsCommand({ expectedRevision: 1, expectedHeadHash: "0".repeat(64), agents: [{ ...provisioningAgent, created_from_ref: { kind: "organization_decision", id: "OD-types" } }], placementEvidence: [{ agent_id: provisioningAgent.agent_id, placement_intent_id: "PI-types", executable_task_id: "OD-types" }] });

// @ts-expect-error Setup Wizard provenance is not part of Organization v3.
const obsoleteSetupKind: AgentCreationRefKind = "setup";
// @ts-expect-error Setup confirmation is not an Organization v3 approval source.
const obsoleteSetupApproval: OrganizationLineV3["approval_source"] = "setup_confirmation";
const { applied_decision_bindings: removedBindings, ...stateWithoutBindings } = bundle.organization;
// @ts-expect-error applied_decision_bindings is required by the canonical schema.
const missingRequiredProperty: OrganizationStateV3 = stateWithoutBindings;
// @ts-expect-error generated object types reject extra properties on object literals.
const extraAgentProperty: AgentV3 = { ...agent, unexpected_property: true };
// @ts-expect-error generated nullability rejects null for required arrays.
const invalidAgentNullability: AgentV3 = { ...agent, context_scope: null };

void kind;
void obsoleteSetupKind;
void obsoleteSetupApproval;
void removedBindings;
void missingRequiredProperty;
void extraAgentProperty;
void invalidAgentNullability;
