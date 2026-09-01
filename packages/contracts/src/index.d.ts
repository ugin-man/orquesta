import type { CanonicalContractMap } from "./organization-v3-contracts.generated";

export const FOUNDATION_AGENT_IDS: readonly ["orchestrator", "orquesta-admin", "user-support"];

export type {
  AgentCreationRef,
  AgentCreationRefKind,
  AgentLifecycleState,
  AgentOrigin,
  AgentRegistryV3,
  AgentV3,
  CoordinationMode,
  FormationReferenceKind,
  FormationReferenceV3,
  FormationState,
  FormationV3,
  OrganizationLineV3,
  OrganizationMembershipV3,
  OrganizationParticipantV3,
  OrganizationPolicyV3,
  OrganizationReferenceKind,
  OrganizationReferenceV3,
  OrganizationRelationshipV3,
  OrganizationStateV3,
  OrganizationTeamV3,
  OrganizationV3Bundle,
  PlacementIntent,
  PlacementTaskStateV3,
  PlacementTaskV3,
  OrganizationV3ContractMap,
  CanonicalContractMap,
  SessionBindingHandoffStatus,
  SessionBindingOwnershipStatus,
  SessionBindingRotationState,
  SessionBindingStateV1,
  SessionBindingStatus,
  SessionBindingV1,
  SessionBindingVisibility
} from "./organization-v3-contracts.generated";

export interface ContractValidationError {
  path: string;
  code: string;
  message: string;
}

export const SCHEMA_NAMES: readonly string[];
export function canonicalJson(value: unknown): string;
export function canonicalHash(value: unknown): string;
export function loadSchema(name: string, schemasDir?: string): unknown;
export function validateContract<Name extends keyof CanonicalContractMap>(name: Name, value: unknown, options?: { schemasDir?: string }): { ok: boolean; errors: ContractValidationError[] };
export function validateContract(name: string, value: unknown, options?: { schemasDir?: string }): { ok: boolean; errors: ContractValidationError[] };
export function assertContract<Name extends keyof CanonicalContractMap>(name: Name, value: unknown, options?: { schemasDir?: string }): asserts value is CanonicalContractMap[Name];
export function assertContract(name: string, value: unknown, options?: { schemasDir?: string }): void;
export function validatePhaseApprovalBinding(input?: { phaseReview?: unknown; attestation?: unknown }): { ok: boolean; errors: ContractValidationError[] };
