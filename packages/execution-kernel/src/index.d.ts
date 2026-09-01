import type {
  AgentV3,
  FormationReferenceV3,
  FormationV3,
  OrganizationLineV3,
  OrganizationMembershipV3,
  OrganizationParticipantV3,
  OrganizationRelationshipV3,
  OrganizationStateV3,
  OrganizationTeamV3,
  OrganizationV3Bundle
} from "@orquesta/contracts";
import type { PlacementTaskV3 } from "@orquesta/contracts";

export type {
  AgentCreationRef,
  AgentCreationRefKind,
  AgentLifecycleState,
  AgentOrigin,
  AgentRegistryV3,
  AgentV3,
  CoordinationMode,
  FormationReferenceV3,
  FormationState,
  FormationV3,
  OrganizationLineV3,
  OrganizationMembershipV3,
  OrganizationParticipantV3,
  OrganizationPolicyV3,
  OrganizationReferenceV3,
  OrganizationRelationshipV3,
  OrganizationStateV3,
  OrganizationTeamV3,
  OrganizationV3Bundle,
  PlacementIntent
} from "@orquesta/contracts";

export interface ExclusiveProcessLockV1 {
  root_path: string;
  lock_path: string;
  candidate_path: string;
  metadata: {
    schema_version: 1;
    pid: number;
    nonce: string;
    lock_path: string;
    candidate_path: string;
    acquired_at: string;
  };
  details: unknown;
  released: boolean;
  code_prefix: string;
}

export function acquireExclusiveProcessLock(input: {
  rootPath: string;
  lockPath: string;
  codePrefix: string;
  nonce?: () => string;
  now?: () => Date | string;
}): ExclusiveProcessLockV1;
export function releaseExclusiveProcessLock(lock: ExclusiveProcessLockV1): void;
export function publishExclusiveJsonFile(input: {
  rootPath: string;
  filePath: string;
  value: unknown;
  validate: (value: unknown) => void;
  codePrefix: string;
  nonce?: () => string;
}): string;
export function taskFingerprint(task: PlacementTaskV3 | Record<string, unknown>): string;
export function projectRootBindingSha256(projectRoot: string): string;
export function projectExecutionContext(projectRoot: string, projectId: string): {
  project_id: string;
  project_root_binding_sha256: string;
};

export interface DesktopOperationAssignment {
  schema_version: 2;
  status: "operator_input_required";
  assignment_id: string;
  request_id: string;
  source_agent_id: "orchestrator";
  target_agent_id: "user-support";
  execution_context: {
    project_id: string;
    project_root_binding_sha256: string;
  };
  operation: {
    operation_id: string;
    version: number;
    description: string;
    schema_id: string;
    schema_sha256: string;
    instruction_sha256: string;
  };
  orchestrator_intent: string;
  instruction: string;
  template_schema: Record<string, unknown>;
  response_contract: Record<string, unknown>;
}
export const RECEIPT_OPEN: "<orquesta_desktop_operation_template>";
export const RECEIPT_CLOSE: "</orquesta_desktop_operation_template>";
export function createDesktopOperationAssignment(input: {
  productRoot: string;
  projectRoot: string;
  projectId: string;
  operationId: string;
  requestId: string;
  orchestratorIntent: string;
}): DesktopOperationAssignment;
export function createDesktopOperationPrompt(input: {
  productRoot: string;
  assignment: DesktopOperationAssignment;
}): string;
export function parseDesktopOperationTemplateReceipt(input: {
  productRoot: string;
  assignment: DesktopOperationAssignment;
  operatorOutput: string;
}): Record<string, unknown>;
export function rehydrateDesktopOperationAssignment(input: {
  productRoot: string;
  assignment: DesktopOperationAssignment;
}): DesktopOperationAssignment;
export interface PersistentPlacementTaskTransitionInput {
  projectId: string;
  expectedRevision: number;
  taskId: string;
  expectedState: string;
  next: {
    state: string;
    blockedBy: string[];
    resultSummary: string | null;
    acceptedAt: string | null;
    changedAt: string;
  };
}
export interface PersistentPlacementTaskPort {
  readonly project_root_binding_sha256: string;
  inspectPlacementTasks(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  reconcilePlacementTasks(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  transitionPlacementTask(input: PersistentPlacementTaskTransitionInput): Promise<Record<string, unknown>>;
}
export interface PersistentPlacementSessionAdapter {
  readonly project_id: string;
  readonly project_root_binding_sha256: string;
  readonly runtime_authority_id: string;
  findAcceptedBinding(input: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  provisionPersistentAgent(input: Record<string, unknown>): Promise<Record<string, unknown>>;
}
export interface PersistentPlacementControllerAuthority {
  projectRoot: string;
  projectId: string;
  sourceRef: { kind: string; id: string };
  roleCatalog: Array<Record<string, unknown>>;
  organizationStore: OrganizationV3StoreApi;
  taskPort: PersistentPlacementTaskPort;
  sessionAdapter: PersistentPlacementSessionAdapter;
  clock?: () => string;
}
export type PersistentPlacementControllerResult = Record<string, unknown>;
export interface RunDesktopOperationAssignmentInput extends PersistentPlacementControllerAuthority {
  productRoot: string;
  assignment: DesktopOperationAssignment;
  templateReceipt: Record<string, unknown>;
}
export function runDesktopOperationAssignment(
  input: RunDesktopOperationAssignmentInput
): Promise<PersistentPlacementControllerResult>;

export interface OrganizationV3StoreApi {
  readonly project_root_binding_sha256: string;
  inspect(): Record<string, unknown>;
  recover(): Record<string, unknown>;
  initialize(input: { bundle: OrganizationV3Bundle; commandId?: string }): Record<string, unknown>;
  commit(command: OrganizationControllerCommand): Record<string, unknown>;
}
export function createOrganizationV3Store(input: {
  rootPath: string;
  validatedRuntimeBindingSha256?: string | null;
  clock?: () => string;
  failpoint?: string | null;
}): OrganizationV3StoreApi;
export function inspectOrganizationV3(rootPath: string, options?: {
  validatedRuntimeBindingSha256?: string | null;
}): Record<string, unknown>;

export type FoundationBootstrapClassificationStatus =
  | "fresh"
  | "ready"
  | "prepared"
  | "incomplete"
  | "legacy_v2"
  | "mixed_v2"
  | "partial"
  | "unsupported";
export interface FoundationAcceptedSessionBinding {
  status: "accepted";
  agent_id: string;
  thread_id: string;
  session_id: string;
  handoff_turn_id: string;
  accepted_at: string;
  runtime_authority_id: string;
}
export interface FoundationSessionPort {
  readonly project_id: string;
  readonly project_root_binding_sha256: string;
  ensureAuthority(input: {
    projectId: string;
    policy: "create_fresh" | "migrate_only" | "require_existing";
  }): Promise<unknown>;
  findAcceptedFoundationBinding(input: {
    projectId: string;
    bootstrapId: string;
    requestId: string;
    agentId: string;
  }): Promise<FoundationAcceptedSessionBinding | null>;
  provisionFoundationAgent(input: {
    projectId: string;
    bootstrapId: string;
    requestId: string;
    agent: AgentV3;
  }): Promise<FoundationAcceptedSessionBinding>;
}
export interface FoundationBootstrapClassification {
  status: FoundationBootstrapClassificationStatus;
  reason: string;
  no_write: true;
  saga?: Record<string, unknown>;
  organization?: Record<string, unknown>;
  error_code?: string | null;
  legacy_markers?: string[];
  unsupported_authority?: string[];
  transition?: Record<string, unknown> | null;
}
export interface FoundationBootstrapResult {
  status: "ready" | "migration_required" | "unsupported" | "recovery_required" | "repair_required";
  classification: FoundationBootstrapClassificationStatus;
  reason?: string;
  no_write: boolean;
  project_id?: string;
  bootstrap_id?: string;
  agent_ids?: string[];
  organization_revision?: number;
  organization_head_hash?: string;
  saga_revision?: number;
  session_bindings?: Record<string, FoundationAcceptedSessionBinding>;
}
export const BOOTSTRAP_PHASES: readonly [
  "organization_initialized_with_provisioning_agents",
  "foundation_sessions_provisioning",
  "foundation_sessions_bound",
  "organization_agents_activated",
  "complete"
];
export const FOUNDATION_BOOTSTRAP_CLASSIFICATIONS: readonly [
  "fresh", "ready", "prepared", "incomplete", "legacy_v2", "mixed_v2", "partial", "unsupported"
];
export function classifyFoundationBootstrapV3(input: {
  projectRoot: string;
  projectId?: string | null;
  organizationStore?: OrganizationV3StoreApi | null;
  validatedRuntimeBindingSha256?: string | null;
}): FoundationBootstrapClassification;
export function runFoundationBootstrapV3(input: {
  projectRoot: string;
  projectId: string;
  validatedRuntimeBindingSha256?: string | null;
  bootstrapId?: string | null;
  userDisplayName?: string;
  organizationStore?: OrganizationV3StoreApi | null;
  sessionPort: FoundationSessionPort;
  sessionAuthorityPolicy: "create_fresh" | "migrate_only" | "require_existing";
  clock?: () => Date | string;
  failpoint?: string | null;
}): Promise<FoundationBootstrapResult>;

export const PERSISTENT_AGENT_PLACEMENT_OPERATION_ID: "organization.agent-placement.persistent.v1";
export interface RunPersistentAgentPlacementInput extends PersistentPlacementControllerAuthority {
  productRoot: string;
  template: Record<string, unknown>;
}
export function runPersistentAgentPlacement(
  input: RunPersistentAgentPlacementInput
): Promise<PersistentPlacementControllerResult>;

export interface KernelTaskDefinition {
  task_id: string;
  dependencies?: string[];
  priority?: number | null;
  created_at?: string | null;
  execution_revision?: number;
  cycle_id?: string;
  state?: string;
}

export interface KernelTaskRecord {
  task_id: string;
  dependencies: string[];
  priority: number | null;
  created_at: string | null;
  execution_revision: number;
  cycle_id: string;
  execution_key: string;
  state: string;
  blocker_reason: string | null;
  attempt: number;
  dispatch_id: string | null;
  correlation_id: string | null;
  thread_id: string | null;
  turn_id: string | null;
  retry_at: string | null;
  last_error: string | null;
  actual_model: string | null;
  actual_model_evidence_ref: string | null;
  model_evidence: Record<string, unknown> | null;
  runtime_profile: Record<string, unknown> | null;
  runtime_status: string | null;
  claimed_at: string | null;
  dispatch_accepted_at: string | null;
  turn_started_at: string | null;
  last_progress_at: string | null;
  finished_at: string | null;
}

export interface KernelState {
  version: 1;
  revision: number;
  max_concurrent: number;
  tasks: Record<string, KernelTaskRecord>;
  applied_event_ids: string[];
  recent_events: Array<Record<string, unknown>>;
  updated_at: string | null;
}

export interface KernelDispatchResult {
  task_id: string;
  execution_key: string;
  dispatch_id: string;
  attempt: number;
  status: string;
  accepted_at?: string;
  retry_at?: string;
  correlation_id?: string | null;
  thread_id?: string | null;
  turn_id?: string | null;
  model_evidence?: Record<string, unknown> | null;
  runtime_profile?: Record<string, unknown> | null;
}

export interface CutoverObservation {
  observation_id?: string;
  evidence_kind: "live" | "synthetic" | "unclassified";
  surface: "desktop_runtime_send" | "orquesta_task_dispatch";
  scenario?: "independent" | "dependency_blocked" | "capacity_blocked"
    | "duplicate_active" | "recovery" | "failure_retry" | "unknown_task";
  task_origin?: "known" | "unknown";
  predicted_action: "dispatch" | "wait_for_capacity" | "wait_for_dependency"
    | "suppress_duplicate";
  expected_action: "dispatch" | "wait_for_capacity" | "wait_for_dependency"
    | "suppress_duplicate";
  predicted_dispatch_id?: string | null;
  actual_action?: string | null;
  actual_thread_id?: string | null;
  actual_turn_id?: string | null;
  additional_codex_turns: number;
  recovered_without_redispatch?: boolean | null;
  retry_bounded?: boolean | null;
}

export interface CutoverBenchmarkCase {
  case_id?: string;
  evidence_kind: "live" | "synthetic" | "unclassified";
  task_origin: "known" | "unknown";
  execution_mode: "solo_direct" | "bounded_parallel";
  quality_passed: boolean;
  quality_benefit?: boolean;
  plain: { wall_time_ms: number | null; total_tokens: number | null };
  kernel: { wall_time_ms: number | null; total_tokens: number | null };
}

export interface CutoverEvaluation {
  schema_version: 1;
  evaluator: "orquesta_execution_kernel_cutover";
  status: "pass" | "fail" | "insufficient_evidence";
  cutover_allowed: boolean;
  requirements: Record<string, number>;
  summary: Record<string, number>;
  gates: Array<{
    name: string;
    status: "pass" | "fail" | "insufficient";
    details: Record<string, unknown>;
  }>;
}

export const DEFAULT_REQUIREMENTS: Readonly<Record<string, number>>;
export const REQUIRED_SCENARIOS: readonly string[];

export interface OrganizationV3Issue {
  code: string;
  path: string;
  message: string;
  severity: "error";
}
export type OrganizationControllerCommandKind = "apply_organization_decision" | "register_persistent_agents" | "set_persistent_agent_lifecycle" | "start_workflow" | "start_inspection" | "retire_formation";
export interface OrganizationControllerCommandBase<K extends OrganizationControllerCommandKind, P> {
  command_id: string;
  kind: K;
  expected_revision: number;
  expected_head_hash: string;
  payload: P;
}
export interface ApplyOrganizationDecisionPayload {
  decision_id: string;
  lines: OrganizationLineV3[];
  teams: OrganizationTeamV3[];
  memberships: OrganizationMembershipV3[];
  relationships: OrganizationRelationshipV3[];
  replace_lines: OrganizationLineV3[];
  replace_teams: OrganizationTeamV3[];
  replace_memberships: OrganizationMembershipV3[];
  replace_relationships: OrganizationRelationshipV3[];
}
export type PersistentProvisioningAgentV3 = Omit<AgentV3, "lifecycle_state" | "origin" | "created_from_ref" | "retired_at"> & {
  lifecycle_state: "provisioning";
  origin: "controller";
  created_from_ref: { kind: "task"; id: string };
  retired_at: null;
};
export type WorkflowProvisioningAgentV3 = Omit<AgentV3, "lifecycle_state" | "origin" | "created_from_ref" | "retired_at"> & {
  lifecycle_state: "provisioning";
  origin: "workflow";
  created_from_ref: { kind: "workflow_run"; id: string };
  retired_at: null;
};
export type InspectionProvisioningAgentV3 = Omit<AgentV3, "lifecycle_state" | "origin" | "created_from_ref" | "retired_at"> & {
  lifecycle_state: "provisioning";
  origin: "inspection";
  created_from_ref: { kind: "inspection"; id: string };
  retired_at: null;
};
export interface PersistentAgentPlacementEvidence {
  agent_id: string;
  placement_intent_id: string;
  executable_task_id: string;
}
export interface RegisterPersistentAgentsPayload {
  agents: PersistentProvisioningAgentV3[];
  lines: OrganizationLineV3[];
  teams: OrganizationTeamV3[];
  memberships: OrganizationMembershipV3[];
  relationships: OrganizationRelationshipV3[];
  placement_evidence: PersistentAgentPlacementEvidence[];
}
export interface AcceptedAgentSessionBinding {
  status: "accepted";
  agent_id: string;
  thread_id: string;
  session_id: string;
  accepted_at: string;
}
export interface SetPersistentAgentLifecyclePayload {
  agent_id: string;
  lifecycle_state: AgentV3["lifecycle_state"];
  changed_at: string;
  accepted_session_binding: AcceptedAgentSessionBinding | null;
}
export interface StartWorkflowFormationPayload {
  agents: WorkflowProvisioningAgentV3[];
  formation: FormationV3;
}
export interface StartInspectionFormationPayload {
  agents: InspectionProvisioningAgentV3[];
  formation: FormationV3;
}
export interface RetireFormationPayload {
  formation_id: string;
  retired_at: string;
}
export type OrganizationControllerPayload = ApplyOrganizationDecisionPayload | RegisterPersistentAgentsPayload | SetPersistentAgentLifecyclePayload | StartWorkflowFormationPayload | StartInspectionFormationPayload | RetireFormationPayload;
export type OrganizationControllerCommand =
  | OrganizationControllerCommandBase<"apply_organization_decision", ApplyOrganizationDecisionPayload>
  | OrganizationControllerCommandBase<"register_persistent_agents", RegisterPersistentAgentsPayload>
  | OrganizationControllerCommandBase<"set_persistent_agent_lifecycle", SetPersistentAgentLifecyclePayload>
  | OrganizationControllerCommandBase<"start_workflow", StartWorkflowFormationPayload>
  | OrganizationControllerCommandBase<"start_inspection", StartInspectionFormationPayload>
  | OrganizationControllerCommandBase<"retire_formation", RetireFormationPayload>;
export interface OrganizationMutationBase {
  expectedRevision: number;
  expectedHeadHash: string;
}
export const FOUNDATION_AGENT_IDS: readonly ["orchestrator", "orquesta-admin", "user-support"];
export function validateOrganizationV3Bundle(input: unknown): { ok: boolean; issues: OrganizationV3Issue[] };
export function assertOrganizationV3Bundle(input: OrganizationV3Bundle): OrganizationV3Bundle;
export function createOrganizationV3Bundle(input: OrganizationV3Bundle): OrganizationV3Bundle;
export function createFoundationOrganizationV3Bundle(input: { createdAt: string; bootstrapId?: string; userDisplayName?: string }): OrganizationV3Bundle;
export function organizationV3HeadHash(bundle: OrganizationV3Bundle): string;
export function applyOrganizationControllerCommand(input: { bundle: OrganizationV3Bundle; command: OrganizationControllerCommand; appliedCommandIds?: string[] }): { status: "applied" | "already_applied" | "no_change"; bundle: OrganizationV3Bundle; head_hash: string; command_id: string };
export function registerPersistentAgentsCommand(input: OrganizationMutationBase & { agents: PersistentProvisioningAgentV3[]; placementEvidence: PersistentAgentPlacementEvidence[]; lines?: OrganizationLineV3[]; teams?: OrganizationTeamV3[]; memberships?: OrganizationMembershipV3[]; relationships?: OrganizationRelationshipV3[] }): OrganizationControllerCommand;
export function applyOrganizationDecisionCommand(input: OrganizationMutationBase & { decisionId: string; lines?: OrganizationLineV3[]; teams?: OrganizationTeamV3[]; memberships?: OrganizationMembershipV3[]; relationships?: OrganizationRelationshipV3[]; replaceLines?: OrganizationLineV3[]; replaceTeams?: OrganizationTeamV3[]; replaceMemberships?: OrganizationMembershipV3[]; replaceRelationships?: OrganizationRelationshipV3[] }): OrganizationControllerCommand;
export function setPersistentAgentLifecycleCommand(input: OrganizationMutationBase & { agentId: string; lifecycleState: AgentV3["lifecycle_state"]; changedAt: string; acceptedSessionBinding?: AcceptedAgentSessionBinding }): OrganizationControllerCommand;
export function startWorkflowFormationCommand(input: OrganizationMutationBase & { workflowRunId: string; scopeRef: FormationReferenceV3; memberAgentIds: string[]; coordinationMode: FormationV3["coordination_mode"]; leadAgentId: string | null; createdAt: string; agents?: WorkflowProvisioningAgentV3[] }): OrganizationControllerCommand;
export function startInspectionFormationCommand(input: OrganizationMutationBase & { sourceTaskId: string; scopeRef: FormationReferenceV3; memberAgentIds: string[]; targetRefs: FormationReferenceV3[]; coordinationMode: FormationV3["coordination_mode"]; leadAgentId: string | null; createdAt: string; agents?: InspectionProvisioningAgentV3[] }): OrganizationControllerCommand;
export function retireFormationCommand(input: OrganizationMutationBase & { formationId: string; retiredAt: string }): OrganizationControllerCommand;

export function evaluateExecutionKernelCutover(input?: {
  observations?: CutoverObservation[];
  benchmark_cases?: CutoverBenchmarkCase[];
  requirements?: Partial<Record<string, number>>;
}): CutoverEvaluation;

export function createKernelState(input?: {
  maxConcurrent?: number;
  updatedAt?: string | null;
}): KernelState;

export function reconcileTasks(
  state: KernelState,
  tasks: KernelTaskDefinition[],
  input?: { now?: string | null },
): KernelState;

export function reconcileContextReceiptV2(input: {
  projectControlPlane: Record<string, unknown>;
  taskEnvelope: Record<string, unknown>;
  contextPack: Record<string, unknown>;
  contextReceipt: Record<string, unknown>;
  terminalOutcomeCompleted?: boolean;
  priorBranchDeltaIds?: string[];
  observedAt?: string;
}): {
  branch_delta: Record<string, unknown>;
  project_control_plane: Record<string, unknown>;
  duplicate: boolean;
  notification: {
    wake_orchestrator: boolean;
    notify_user: boolean;
    attention: string;
    reason: string;
  };
};

export function applyKernelEvent(
  state: KernelState,
  event: Record<string, unknown>,
): KernelState;

export function executionKernelEnabled(
  environment?: Record<string, string | undefined>,
): boolean;

export function claimDispatch(
  state: KernelState,
  input: { taskId: string; now?: string | null },
): {
  state: KernelState;
  dispatch: {
    task_id: string;
    execution_key: string;
    dispatch_id: string;
    attempt: number;
  };
  claimed: boolean;
};

export function retryDelayMs(
  attempt: number,
  options?: Record<string, number>,
): number;

export function planDispatchTick(input: {
  state: KernelState;
  tasks: KernelTaskDefinition[];
  now?: string | number | Date;
  limit?: number;
}): {
  state: KernelState;
  dispatches: Array<{
    task_id: string;
    execution_key: string;
    dispatch_id: string;
    attempt: number;
  }>;
  considered: number;
  available_slots: number;
  observed_at: string;
};

export function runDispatchTick(input: {
  state: KernelState;
  tasks: KernelTaskDefinition[];
  adapter: {
    start(dispatch: {
      task_id: string;
      execution_key: string;
      dispatch_id: string;
      attempt: number;
    }): Promise<Record<string, unknown>>;
  };
  now?: string | number | Date;
  limit?: number;
  retry?: Record<string, number>;
}): Promise<{
  state: KernelState;
  results: KernelDispatchResult[];
  considered: number;
  available_slots_before_claim: number;
}>;
