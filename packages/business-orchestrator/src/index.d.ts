export type AcceptanceVerificationMode = "deterministic" | "mixed" | "human_only";
export type VerificationRequirementKind = "deterministic" | "human";
export type ReviewMinimum = "light" | "normal" | "strict";
export type BusinessBranchRole = "work" | "integration";
export type BusinessBranchIsolation = "read-only" | "worktree" | "sandbox" | "remote";
export type BusinessPermissionMode = "read-only" | "workspace-write";
export type ProviderSelectionMode = "fixed" | "fallback_allowed";
export type RetryableRuntimeObservationName = "branch.dispatch.not_sent";
export type CommandActorType = "user" | "orchestrator";
export type RuntimeObservationActorType = "runtime" | "provider" | "verifier";
export type EffectSettlementObservationName = "provider.effect.settlement.recorded";
export type EffectSendExpiryObservationName = "provider.effect.send_expiration.recorded";
export type EffectPresendFailureObservationName = "provider.effect.presend_failure.recorded";
export type EffectSettlementSource = "worker_result" | "recovery_probe";
export type EffectPresendFailureReason =
  | "packet_integrity_failed"
  | "authority_failed"
  | "driver_capability_failed";
export type WorkOrderCommandName =
  | "work_order.start"
  | "work_order.cancel.request"
  | "work_order.resume"
  | "branch.retry.request"
  | "user_input.resolve"
  | "acceptance.decision.record";
export type RuntimeObservationName =
  | "work_order.started"
  | "work_order.cancelled"
  | "provider.effect.delivery.recorded"
  | "branch.dispatch.accepted"
  | "branch.dispatch.not_sent"
  | "branch.progress"
  | "branch.result.submitted"
  | "branch.failed"
  | "branch.timed_out"
  | "branch.delivery_unknown"
  | "branch.cancelled"
  | "user_input.requested"
  | "verification.recorded"
  | "review.recorded"
  | "provider.rate_limited"
  | "provider.unavailable";

/**
 * Historical callbacks remain replayable but cannot create new writes. The
 * V2 settlement successor is the only live provider callback contract because
 * it binds callback-owned fencing or an authoritative recovery probe.
 */
export type LiveRuntimeObservationNameV1 =
  | "work_order.cancelled"
  | "branch.timed_out"
  | "verification.recorded"
  | "review.recorded";
export type LiveRuntimeObservationName =
  | LiveRuntimeObservationNameV1
  | EffectSettlementObservationName
  | EffectSendExpiryObservationName
  | EffectPresendFailureObservationName;

export interface ContentAddressedArtifactRefV1 {
  id: string;
  hash: string;
}

export interface BusinessAcceptanceCriterionV1 {
  criterion_id: string;
  description: string;
  verification: AcceptanceVerificationMode;
  verification_requirements: BusinessVerificationRequirementV1[];
}

export interface BusinessVerificationRequirementV1 {
  kind: VerificationRequirementKind;
  verification_ref: ContentAddressedArtifactRefV1;
}

export interface BusinessAcceptancePolicyV1 {
  criteria: BusinessAcceptanceCriterionV1[];
  review_minimum: ReviewMinimum;
}

export interface BusinessWorkOrderBranchV1 {
  branch_ref: string;
  /**
   * The trusted processor must dereference these content-addressed contracts,
   * verify their hashes, and enforce their authority/effect ceilings before execution.
   */
  task_intent_ref: ContentAddressedArtifactRefV1;
  execution_plan_ref: ContentAddressedArtifactRefV1;
  context_pack_ref: ContentAddressedArtifactRefV1;
  dependencies: string[];
  role: BusinessBranchRole;
  parallelizable: boolean;
  isolation: BusinessBranchIsolation;
  assignee_ref: string;
  provider_ref: string;
  permission_mode: BusinessPermissionMode;
}

export interface BusinessRetryPolicyV1 {
  max_attempts: number;
  attempt_timeout_ms: number;
  max_elapsed_ms: number;
  backoff_initial_ms: number;
  backoff_max_ms: number;
  /** Delivery ambiguity is reconciled, never automatically retried. */
  retryable_observations: RetryableRuntimeObservationName[];
}

export interface BusinessLeasePolicyV1 {
  lease_duration_ms: number;
  heartbeat_interval_ms: number;
  max_recovery_probes: number;
}

export interface BusinessProviderPolicyV1 {
  allowed_provider_refs: string[];
  selection: ProviderSelectionMode;
}

export interface BusinessWorkOrderPlanV1Input {
  version: 1;
  /** Optional assertion; generated from the canonical content when omitted. */
  plan_snapshot_id?: string;
  /** Optional assertion; generated from the canonical content when omitted. */
  plan_hash?: string;
  project_ref: string;
  revision: number;
  supersedes_plan_ref: string | null;
  title: string;
  desired_outcome: string;
  acceptance_policy: BusinessAcceptancePolicyV1;
  /**
   * The trusted processor must dereference these content-addressed contracts,
   * verify their hashes, and enforce their authority/effect ceilings before execution.
   */
  task_intent_ref: ContentAddressedArtifactRefV1;
  execution_plan_ref: ContentAddressedArtifactRefV1;
  context_pack_ref: ContentAddressedArtifactRefV1;
  branches: BusinessWorkOrderBranchV1[];
  integration_branch_ref: string | null;
  max_concurrency: number;
  context_duplication_budget_tokens: number;
  retry_policy: BusinessRetryPolicyV1;
  lease_policy: BusinessLeasePolicyV1;
  provider_policy: BusinessProviderPolicyV1;
  permission_mode: BusinessPermissionMode;
}

export interface BusinessWorkOrderPlanV1
  extends Omit<BusinessWorkOrderPlanV1Input, "plan_snapshot_id" | "plan_hash"> {
  plan_snapshot_id: string;
  plan_hash: string;
}

/**
 * Caller-supplied identity metadata. It is not proof of authorization;
 * authorization must be performed by the trusted command processor.
 */
export interface ActorIdentityV1<TType extends string> {
  type: TType;
  actor_id: string;
}

export type EmptyPayloadV1 = Record<string, never>;
export interface WorkOrderReasonPayloadV1 { reason: string }
export interface BranchRetryRequestPayloadV1 {
  branch_ref: string;
  failed_attempt: number;
  reason: string;
}
export interface UserInputResolvePayloadV1 {
  request_id: string;
  response_ref: ContentAddressedArtifactRefV1;
}
export interface AcceptanceDecisionRecordPayloadV1 {
  decision: "accepted" | "rejected";
  evidence_refs: string[];
  comment: string;
}

export interface WorkOrderCommandPayloadMapV1 {
  "work_order.start": EmptyPayloadV1;
  "work_order.cancel.request": WorkOrderReasonPayloadV1;
  "work_order.resume": WorkOrderReasonPayloadV1;
  "branch.retry.request": BranchRetryRequestPayloadV1;
  "user_input.resolve": UserInputResolvePayloadV1;
  "acceptance.decision.record": AcceptanceDecisionRecordPayloadV1;
}

export interface CommandEnvelopeVariantV1<
  TName extends WorkOrderCommandName,
  TPayload,
> {
  version: 1;
  command_id: string;
  work_order_id: string;
  plan_snapshot_ref: string;
  plan_hash: string;
  expected_work_order_revision: number;
  actor: ActorIdentityV1<CommandActorType>;
  name: TName;
  payload: TPayload;
  /** Canonical hash of the exact normalized payload; not an authorization proof. */
  payload_hash: string;
}

export type CommandEnvelopeV1 = {
  [TName in WorkOrderCommandName]: CommandEnvelopeVariantV1<
    TName,
    WorkOrderCommandPayloadMapV1[TName]
  >
}[WorkOrderCommandName];

export interface WorkOrderCancelledObservationPayloadV1 { reason: string }
export interface BranchAttemptObservationPayloadV1 { branch_ref: string; attempt: number }
export type ProviderEffectDeliveryClassificationV2 =
  | "accepted"
  | "not_sent"
  | "delivery_unknown";
export interface ProviderEffectDeliveryRecordedObservationPayloadV2
  extends BranchAttemptObservationPayloadV1 {
  effect_id: string;
  effect_contract_version: 2;
  effect_kind:
    | "provider.thread.create"
    | "provider.turn.start"
    | "provider.user_input.submit"
    | "provider.turn.cancel";
  dispatch_id: string;
  classification: ProviderEffectDeliveryClassificationV2;
}
export interface WorkerFencingTokenV2 {
  lease_id: string;
  owner_id: string;
  generation: number;
}
export interface RecoveryProbeSettlementProvenanceV2 {
  probe_receipt_ref: ContentAddressedArtifactRefV1;
  mutation_idempotency_key: string;
}
export interface ProviderEffectSettlementCommonPayloadV2
  extends ProviderEffectDeliveryRecordedObservationPayloadV2 {
  settlement_source: EffectSettlementSource;
}
export interface ProviderEffectWorkerSettlementPayloadV2
  extends ProviderEffectSettlementCommonPayloadV2 {
  settlement_source: "worker_result";
  /** Content-addressed normalized worker result; raw provider output is never journaled. */
  worker_result_ref: ContentAddressedArtifactRefV1;
  /** Callback-owned token. The boundary compares it but never replaces it with projection state. */
  worker_fencing_token: WorkerFencingTokenV2;
}
export interface ProviderEffectRecoveryProbeSettlementPayloadV2
  extends ProviderEffectSettlementCommonPayloadV2 {
  settlement_source: "recovery_probe";
  recovery_probe: RecoveryProbeSettlementProvenanceV2;
}
export type ProviderEffectSettlementRecordedObservationPayloadV2 =
  | ProviderEffectWorkerSettlementPayloadV2
  | ProviderEffectRecoveryProbeSettlementPayloadV2;
export interface ProviderEffectSendExpirationRecordedObservationPayloadV2
  extends BranchAttemptObservationPayloadV1 {
  effect_id: string;
  effect_contract_version: 2;
  effect_kind:
    | "provider.thread.create"
    | "provider.turn.start"
    | "provider.user_input.submit"
    | "provider.turn.cancel";
  dispatch_id: string;
  /** The exact callback-owned token whose durable sending window elapsed. */
  expired_fencing_token: WorkerFencingTokenV2;
  lease_expires_at: string;
  /** Content-addressed control-plane evidence; callbacks cannot author expiry. */
  expiry_receipt_ref: ContentAddressedArtifactRefV1;
}
export interface ProviderEffectPresendFailureRecordedObservationPayloadV2
  extends BranchAttemptObservationPayloadV1 {
  effect_id: string;
  effect_contract_version: 2;
  effect_kind:
    | "provider.thread.create"
    | "provider.turn.start"
    | "provider.user_input.submit"
    | "provider.turn.cancel";
  dispatch_id: string;
  /** The exact claimed lease that was rejected before any provider mutation. */
  claimed_fencing_token: WorkerFencingTokenV2;
  failure_reason: EffectPresendFailureReason;
  /** Content-addressed control-plane failure evidence; raw failure text is never journaled. */
  failure_record_ref: ContentAddressedArtifactRefV1;
}
export interface BranchDispatchAcceptedObservationPayloadV1
  extends BranchAttemptObservationPayloadV1 { dispatch_id: string }
export interface BranchDispatchNotSentObservationPayloadV1
  extends BranchAttemptObservationPayloadV1 { dispatch_id: string; reason: string }
export interface BranchProgressObservationPayloadV1
  extends BranchAttemptObservationPayloadV1 { message: string }
export interface BranchResultSubmittedObservationPayloadV1
  extends BranchAttemptObservationPayloadV1 {
  artifact_refs: ContentAddressedArtifactRefV1[];
  evidence_refs: string[];
}
export interface BranchFailedObservationPayloadV1
  extends BranchAttemptObservationPayloadV1 { failure_code: string }
export interface BranchTimedOutObservationPayloadV1
  extends BranchAttemptObservationPayloadV1 { timeout_ms: number }
export interface BranchDeliveryUnknownObservationPayloadV1
  extends BranchAttemptObservationPayloadV1 { dispatch_id: string; detail: string }
export interface BranchCancelledObservationPayloadV1
  extends BranchAttemptObservationPayloadV1 { reason: string }
export interface UserInputRequestedObservationPayloadV1 {
  branch_ref: string;
  request_id: string;
  prompt_ref: ContentAddressedArtifactRefV1;
}
export interface VerificationRecordedObservationPayloadV1 {
  branch_ref: string;
  criterion_id: string;
  verification_ref: ContentAddressedArtifactRefV1;
  kind: VerificationRequirementKind;
  status: "passed" | "failed";
  evidence_refs: string[];
}
export interface ReviewRecordedObservationFindingsV1 {
  critical: number;
  important: number;
  minor: number;
}
export interface ReviewRecordedObservationPayloadV1 {
  branch_ref: string;
  review_id: string;
  status: "accepted" | "rejected";
  findings: ReviewRecordedObservationFindingsV1;
  evidence_refs: string[];
}
export interface ProviderRateLimitedObservationPayloadV1
  extends BranchAttemptObservationPayloadV1 { retry_after_ms: number }
export interface ProviderUnavailableObservationPayloadV1
  extends BranchAttemptObservationPayloadV1 { detail: string }
export interface RuntimeObservationPayloadMapV1 {
  "work_order.started": EmptyPayloadV1;
  "work_order.cancelled": WorkOrderCancelledObservationPayloadV1;
  "provider.effect.delivery.recorded": ProviderEffectDeliveryRecordedObservationPayloadV2;
  "branch.dispatch.accepted": BranchDispatchAcceptedObservationPayloadV1;
  "branch.dispatch.not_sent": BranchDispatchNotSentObservationPayloadV1;
  "branch.progress": BranchProgressObservationPayloadV1;
  "branch.result.submitted": BranchResultSubmittedObservationPayloadV1;
  "branch.failed": BranchFailedObservationPayloadV1;
  "branch.timed_out": BranchTimedOutObservationPayloadV1;
  "branch.delivery_unknown": BranchDeliveryUnknownObservationPayloadV1;
  "branch.cancelled": BranchCancelledObservationPayloadV1;
  "user_input.requested": UserInputRequestedObservationPayloadV1;
  "verification.recorded": VerificationRecordedObservationPayloadV1;
  "review.recorded": ReviewRecordedObservationPayloadV1;
  "provider.rate_limited": ProviderRateLimitedObservationPayloadV1;
  "provider.unavailable": ProviderUnavailableObservationPayloadV1;
}

export interface RuntimeObservationEnvelopeVariantV1<
  TName extends RuntimeObservationName,
  TPayload,
> {
  version: 1;
  observation_id: string;
  work_order_id: string;
  plan_snapshot_ref: string;
  plan_hash: string;
  work_order_revision: number;
  actor: ActorIdentityV1<RuntimeObservationActorType>;
  name: TName;
  payload: TPayload;
  /** Canonical hash of the exact normalized payload; not an authorization proof. */
  payload_hash: string;
}

export type RuntimeObservationEnvelopeV1 = {
  [TName in RuntimeObservationName]: RuntimeObservationEnvelopeVariantV1<
    TName,
    RuntimeObservationPayloadMapV1[TName]
  >
}[RuntimeObservationName];

export type LiveRuntimeObservationEnvelopeV1 = {
  [TName in LiveRuntimeObservationNameV1]: RuntimeObservationEnvelopeVariantV1<
    TName,
    RuntimeObservationPayloadMapV1[TName]
  >
}[LiveRuntimeObservationNameV1];

export interface EffectSettlementObservationEnvelopeV2 {
  version: 2;
  observation_id: string;
  work_order_id: string;
  plan_snapshot_ref: string;
  plan_hash: string;
  work_order_revision: number;
  actor: ActorIdentityV1<"runtime">;
  name: EffectSettlementObservationName;
  payload: ProviderEffectSettlementRecordedObservationPayloadV2;
  /** Canonical hash of the exact normalized payload; not an authorization proof. */
  payload_hash: string;
}

export interface EffectSendExpiryObservationEnvelopeV2 {
  version: 2;
  observation_id: string;
  work_order_id: string;
  plan_snapshot_ref: string;
  plan_hash: string;
  work_order_revision: number;
  actor: ActorIdentityV1<"runtime">;
  name: EffectSendExpiryObservationName;
  payload: ProviderEffectSendExpirationRecordedObservationPayloadV2;
  /** Canonical hash of the exact normalized payload; not an authorization proof. */
  payload_hash: string;
}

export interface EffectPresendFailureObservationEnvelopeV2 {
  version: 2;
  observation_id: string;
  work_order_id: string;
  plan_snapshot_ref: string;
  plan_hash: string;
  work_order_revision: number;
  actor: ActorIdentityV1<"runtime">;
  name: EffectPresendFailureObservationName;
  payload: ProviderEffectPresendFailureRecordedObservationPayloadV2;
  /** Canonical hash of the exact normalized payload; not an authorization proof. */
  payload_hash: string;
}

export type BusinessRuntimeObservationEnvelope =
  | RuntimeObservationEnvelopeV1
  | EffectSettlementObservationEnvelopeV2
  | EffectSendExpiryObservationEnvelopeV2
  | EffectPresendFailureObservationEnvelopeV2;

export const ACCEPTANCE_VERIFICATION_MODES: readonly AcceptanceVerificationMode[];
export const BRANCH_ISOLATION_MODES: readonly BusinessBranchIsolation[];
export const BRANCH_ROLES: readonly BusinessBranchRole[];
export const BUSINESS_ENGINE_CONTRACT_VERSION: 2;
export const BUSINESS_WORK_ORDER_PLAN_VERSION: 1;
export const COMMAND_ACTOR_TYPES: readonly CommandActorType[];
export const COMMAND_ENVELOPE_VERSION: 1;
export const CONTRACT_LIMITS: Readonly<{
  max_plan_bytes: number;
  max_envelope_bytes: number;
  max_payload_bytes: number;
  max_input_depth: number;
  max_input_nodes: number;
  max_branches: number;
  max_acceptance_criteria: number;
  max_verification_requirements_per_criterion: number;
  max_review_findings_per_severity: number;
  max_dependencies_per_branch: number;
  max_provider_refs: number;
  max_evidence_refs: number;
  max_ref_bytes: number;
  max_text_bytes: number;
}>;
export const EFFECT_SETTLEMENT_OBSERVATION_ENVELOPE_VERSION: 2;
export const EFFECT_SETTLEMENT_OBSERVATION_NAMES:
  readonly EffectSettlementObservationName[];
export const EFFECT_SETTLEMENT_SOURCES: readonly EffectSettlementSource[];
export const EFFECT_SEND_EXPIRY_OBSERVATION_NAMES:
  readonly EffectSendExpiryObservationName[];
export const EFFECT_PRESEND_FAILURE_OBSERVATION_NAMES:
  readonly EffectPresendFailureObservationName[];
export const PERMISSION_MODES: readonly BusinessPermissionMode[];
export const PROVIDER_SELECTION_MODES: readonly ProviderSelectionMode[];
export const RETRYABLE_RUNTIME_OBSERVATIONS: readonly RetryableRuntimeObservationName[];
export const REVIEW_MINIMUMS: readonly ReviewMinimum[];
export const RUNTIME_OBSERVATION_ACTOR_TYPES: readonly RuntimeObservationActorType[];
export const RUNTIME_OBSERVATION_ENVELOPE_VERSION: 1;
export const RUNTIME_OBSERVATION_NAMES: readonly RuntimeObservationName[];
export const WORK_ORDER_COMMAND_NAMES: readonly WorkOrderCommandName[];

export class ContractValidationError extends TypeError {
  readonly code: "ERR_ORQUESTA_CONTRACT_VALIDATION";
  readonly path: string;
  readonly reason: string;
}

export function normalizeBusinessWorkOrderPlanV1(
  input: BusinessWorkOrderPlanV1Input,
): Readonly<BusinessWorkOrderPlanV1>;

export function normalizeBusinessRuntimeObservationEnvelope(
  input: BusinessRuntimeObservationEnvelope,
): Readonly<BusinessRuntimeObservationEnvelope>;

export function normalizeCommandEnvelopeV1(
  input: CommandEnvelopeV1,
): Readonly<CommandEnvelopeV1>;

export function normalizeEffectSettlementObservationEnvelopeV2(
  input: EffectSettlementObservationEnvelopeV2,
): Readonly<EffectSettlementObservationEnvelopeV2>;

export function normalizeRuntimeObservationEnvelopeV1(
  input: RuntimeObservationEnvelopeV1,
): Readonly<RuntimeObservationEnvelopeV1>;

export interface BusinessAcceptanceBranchResultV1 {
  branch_ref: string;
  status: string;
  artifact_refs: ContentAddressedArtifactRefV1[];
  evidence_refs: string[];
}

export interface BusinessAcceptanceCriterionResultV1 {
  criterion_id: string;
  status: string;
  evidence_refs: string[];
}

export interface BusinessAcceptanceReviewFindingsV1 {
  critical: number;
  important: number;
  minor: number;
}

export interface BusinessAcceptanceReviewV1 {
  /** Integration branch when present; otherwise the plan's sole work branch. */
  branch_ref: string;
  review_id: string;
  /** Derived by the trusted projector from authenticated observation.actor.actor_id. */
  reviewer_ref: string;
  status: string;
  findings: BusinessAcceptanceReviewFindingsV1;
  evidence_refs: string[];
}

export interface BusinessAcceptanceVerificationCheckV1 {
  /** Integration branch when present; otherwise the plan's sole work branch. */
  branch_ref: string;
  criterion_id: string;
  kind: VerificationRequirementKind;
  /** Derived by the trusted projector from authenticated observation.actor.actor_id. */
  verifier_ref: string;
  /** Must exactly match a verification requirement in the bound plan criterion. */
  verification_ref: ContentAddressedArtifactRefV1;
  status: "passed";
  evidence_refs: string[];
}

/**
 * SECURITY: this snapshot MUST come from a trusted EventStore projector that
 * authenticates verifier principals and resolves every evidence/event ref.
 * The acceptance evaluator checks structural and policy binding only; it is
 * not an authorization boundary and cannot prove that a referenced record
 * exists.
 */
export interface BusinessAcceptanceSnapshotV1 {
  work_order_id: string;
  project_ref: string;
  plan_snapshot_id: string;
  plan_hash: string;
  plan_revision: number;
  work_order_revision: number;
  branches: BusinessAcceptanceBranchResultV1[];
  criterion_results: BusinessAcceptanceCriterionResultV1[];
  reviews: BusinessAcceptanceReviewV1[];
  pending_attention_refs: string[];
  open_risk_refs: string[];
  unverified_refs: string[];
  verification_checks: BusinessAcceptanceVerificationCheckV1[];
}

export interface BusinessAcceptanceInputV1 {
  plan: BusinessWorkOrderPlanV1Input;
  snapshot: BusinessAcceptanceSnapshotV1;
}

export interface BusinessAcceptanceResultV1 {
  accepted: boolean;
  reason_codes: string[];
  evidence_refs: string[];
}

export function evaluateBusinessAcceptanceV1(
  input: BusinessAcceptanceInputV1,
): BusinessAcceptanceResultV1;

/** Compatibility alias for the preview package. Prefer the versioned API. */
export const evaluateBusinessAcceptance: typeof evaluateBusinessAcceptanceV1;

export type BusinessWorkOrderStateName =
  | "starting"
  | "running"
  | "paused"
  | "awaiting_acceptance"
  | "cancelling"
  | "accepted"
  | "failed"
  | "cancelled";

export type BusinessBranchStateName =
  | "blocked"
  | "ready"
  | "dispatch_pending"
  | "running"
  | "waiting_for_user"
  | "verifying"
  | "accepted"
  | "retryable"
  | "delivery_unknown"
  | "cancelling"
  | "failed"
  | "cancelled";

export type BusinessJsonPrimitive = string | number | boolean | null;
export type BusinessJsonValue =
  | BusinessJsonPrimitive
  | readonly BusinessJsonValue[]
  | { readonly [key: string]: BusinessJsonValue };

export type BusinessObservationReceiptSourceV1 =
  | "observation"
  | "provider_settlement";

export interface BusinessProjectedObservationReceiptBaseV1 {
  source_id: string;
  source_type: BusinessObservationReceiptSourceV1;
  identity_hash: string;
  payload_hash: string;
  work_order_id: string;
  applied_revision: number;
  batch_id: string;
  event_ids: readonly string[];
  result: BusinessJsonValue;
  /** Hashes of every event in the atomically closed input. */
  event_hashes: Readonly<Record<string, string>>;
}

export interface BusinessGenericObservationReceiptV1
  extends BusinessProjectedObservationReceiptBaseV1 {
  source_type: "observation";
}

export type BusinessProviderSettlementIngressKindV1 =
  | "worker_result"
  | "recovery_probe"
  | "expiry_receipt"
  | "control_plane_failure";

export interface BusinessProviderSettlementEffectBindingV1 {
  effect_id: string;
  effect_contract_version: 2;
  effect_kind: BusinessProviderMutatingEffectKindV2;
  branch_ref: string;
  attempt: number;
  dispatch_id: string;
  mutation_idempotency_key: string;
}

/**
 * Projector-verified closure for one post-cutover provider-settlement batch.
 * It binds the journal-global epoch, exact Effect V2 identity, ingress
 * provenance, shared settlement policy, and complete domain-event manifest.
 */
export interface BusinessProviderSettlementReceiptBundleV1 {
  bundle_schema_version: 1;
  settlement_contract_version: 2;
  cutover_id: string;
  observation_name:
    | EffectSettlementObservationName
    | EffectSendExpiryObservationName
    | EffectPresendFailureObservationName;
  effect_binding: BusinessProviderSettlementEffectBindingV1;
  ingress_kind: BusinessProviderSettlementIngressKindV1;
  provenance_ref: ContentAddressedArtifactRefV1;
  effective_classification: ProviderEffectDeliveryClassificationV2;
  settlement_policy_hash: string | null;
  domain_event_manifest_hash: string;
}

export interface BusinessProviderSettlementReceiptV1
  extends BusinessProjectedObservationReceiptBaseV1 {
  source_type: "provider_settlement";
  settlement_bundle: BusinessProviderSettlementReceiptBundleV1;
}

export type BusinessProjectedObservationReceiptV1 =
  | BusinessGenericObservationReceiptV1
  | BusinessProviderSettlementReceiptV1;

export interface BusinessEventV1 {
  event_id: string;
  schema_version: 1;
  type: string;
  payload: Readonly<Record<string, unknown>>;
  evidence_refs: readonly string[];
}

export interface BusinessProjectionBatchV1 {
  batch_id: string;
  events: readonly BusinessEventV1[];
  readonly [key: string]: unknown;
}

export interface BusinessProjectedBranchV1 {
  branch_ref: string;
  state: BusinessBranchStateName;
  attempt: number;
  dispatch_id: string | null;
  cancel_effect_id: string | null;
  pending_user_input_effect_id: string | null;
  pending_user_input_response_ref: ContentAddressedArtifactRefV1 | null;
  readonly [key: string]: unknown;
}

export interface BusinessProjectedWorkOrderV1 {
  work_order_id: string;
  engine_contract_version: 1 | 2;
  plan_snapshot_ref: string;
  plan_hash: string;
  plan: BusinessWorkOrderPlanV1;
  revision: number;
  status: BusinessWorkOrderStateName;
  branches: Readonly<Record<string, BusinessProjectedBranchV1>>;
  pending_projection_input: Readonly<Record<string, unknown>> | null;
  readonly [key: string]: unknown;
}

export interface BusinessProjectionV1 {
  schema_version: 2;
  work_orders: Readonly<Record<string, BusinessProjectedWorkOrderV1>>;
  command_receipts: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  observation_receipts: Readonly<
    Record<string, Readonly<BusinessProjectedObservationReceiptV1>>
  >;
  internal_receipts: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  outbox: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  late_observations: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  provider_settlement_epoch: Readonly<BusinessProviderSettlementEpochV1> | null;
  /** Latest receipt-closed provider-entry window for each Effect V2. */
  provider_entry_windows: Readonly<
    Record<string, Readonly<BusinessProviderEntryWindowIndexV1>>
  >;
}

export const BUSINESS_EVENT_SCHEMA_VERSION: 1;
export const BUSINESS_PROJECTION_VERSION: 2;
export const BUSINESS_EVENT_TYPES: readonly string[];
export const WORK_ORDER_STATES: readonly BusinessWorkOrderStateName[];
export const BRANCH_STATES: readonly BusinessBranchStateName[];
export const TERMINAL_WORK_ORDER_STATES: readonly BusinessWorkOrderStateName[];
export const OUTBOX_IMMUTABLE_FIELDS: readonly string[];

export class BusinessProjectionError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export function initialBusinessProjectionV1(): Readonly<BusinessProjectionV1>;

export function projectBusinessEventV1(
  projection: BusinessProjectionV1,
  event: BusinessEventV1,
  batch?: BusinessProjectionBatchV1,
): Readonly<BusinessProjectionV1>;

export function replayBusinessProjectionV1(
  entries: readonly (BusinessEventV1 | BusinessProjectionBatchV1)[],
  initialProjection?: BusinessProjectionV1,
): Readonly<BusinessProjectionV1>;

export type BusinessProjectionReducerV1 = (
  state: BusinessProjectionV1,
  event: BusinessEventV1,
  batch?: BusinessProjectionBatchV1,
) => Readonly<BusinessProjectionV1>;

export interface BusinessProjectionConfigurationV1 {
  initialState: Readonly<BusinessProjectionV1>;
  reducers: Readonly<Record<string, BusinessProjectionReducerV1>>;
}

/** The canonical EventStore projector configuration used by every boundary. */
export function businessProjectionConfigurationV1(): BusinessProjectionConfigurationV1;

export type BusinessProviderSettlementCutoverActionV1 =
  "provider_settlement.v2.activate";
export type BusinessProviderSettlementCutoverSourceTypeV1 =
  "provider_settlement_cutover";

export interface BusinessProviderSettlementCutoverEnvelopeV1 {
  version: 1;
  cutover_id: string;
  actor: ActorIdentityV1<"system">;
  settlement_contract_version: 2;
  send_authorization_contract_version: 2;
  /**
   * Hash of the exact normalized intent
   * `{ settlement_contract_version: 2, send_authorization_contract_version: 2 }`.
   */
  payload_hash: string;
}

export interface BusinessProviderSettlementCutoverPendingInputV1 {
  work_order_id: string;
  source_id: string;
  source_type: string;
  batch_id: string;
}

export type BusinessProviderSettlementCutoverUnsafeEffectReasonV1 =
  | "in_flight_or_ambiguous"
  | "legacy_unresolved";

export interface BusinessProviderSettlementCutoverUnsafeEffectV1 {
  effect_id: string;
  effect_contract_version: number;
  status: string;
  reason: BusinessProviderSettlementCutoverUnsafeEffectReasonV1;
}

export interface BusinessProviderSettlementProjectedReadinessV1 {
  readiness_schema_version: 1;
  journal_sequence: number;
  pre_cutover_projection_hash: string;
  provider_settlement_epoch: Readonly<BusinessProviderSettlementEpochV1> | null;
  send_authorization_contract_version: 2;
  pending_projection_inputs:
    readonly BusinessProviderSettlementCutoverPendingInputV1[];
  unsafe_provider_effects:
    readonly BusinessProviderSettlementCutoverUnsafeEffectV1[];
}

export interface BusinessProviderSettlementCutoverReadinessAssessmentV1 {
  assessment_schema_version: 1;
  status: "ready";
  event_store_recovery: "clean";
  settlement_ingress: "stopped";
  provider_reactors: "stopped";
  send_authorization_contract_version: 2;
  projected_readiness: BusinessProviderSettlementProjectedReadinessV1;
}

export interface BusinessProviderSettlementCutoverReadinessEvidenceV1 {
  readiness_assessment_ref: ContentAddressedArtifactRefV1;
  assessment: BusinessProviderSettlementCutoverReadinessAssessmentV1;
}

export interface BusinessProviderSettlementCutoverResultV1 {
  status: "activated";
  settlement_contract_version: 2;
  send_authorization_contract_version: 2;
}

export interface BusinessProviderSettlementCutoverReceiptV1 {
  cutover_id: string;
  source_type: BusinessProviderSettlementCutoverSourceTypeV1;
  identity_hash: string;
  payload_hash: string;
  batch_id: string;
  applied_journal_sequence: number;
  event_ids: readonly [string];
  result: BusinessProviderSettlementCutoverResultV1;
  occurred_at: string;
}

export interface BusinessProviderSettlementEpochV1 {
  epoch_schema_version: 1;
  settlement_contract_version: 2;
  send_authorization_contract_version: 2;
  cutover_id: string;
  legacy_tail_sequence: number;
  activation_journal_sequence: number;
  activation_batch_id: string;
  activation_event_id: string;
  activation_receipt_event_id: string;
  activation_batch_core_hash: string;
  pre_cutover_projection_hash: string;
  readiness_assessment_ref: ContentAddressedArtifactRefV1;
  activated_at: string;
  receipt: BusinessProviderSettlementCutoverReceiptV1;
}

export interface BusinessProviderSettlementActivatedPayloadV1 {
  cutover_id: string;
  cutover_schema_version: 1;
  settlement_contract_version: 2;
  send_authorization_contract_version: 2;
  pre_cutover_projection_hash: string;
  readiness_assessment_ref: ContentAddressedArtifactRefV1;
  occurred_at: string;
}

export interface BusinessProviderSettlementActivatedEventV1
  extends Omit<BusinessEventV1, "type" | "payload" | "evidence_refs"> {
  type: "business.provider_settlement.v2_activated";
  payload: BusinessProviderSettlementActivatedPayloadV1;
  evidence_refs: readonly [string];
}

export interface BusinessProviderSettlementCutoverReceivedEventV1
  extends Omit<BusinessEventV1, "type" | "payload" | "evidence_refs"> {
  type: "business.provider_settlement.cutover_received";
  payload: BusinessProviderSettlementCutoverReceiptV1;
  evidence_refs: readonly [];
}

export interface BusinessProviderSettlementCutoverBatchRequestV1 {
  expected_revision: number;
  batch_id: string;
  actor: { type: "system"; id: string };
  correlation_id: string;
  events: readonly [
    BusinessProviderSettlementActivatedEventV1,
    BusinessProviderSettlementCutoverReceivedEventV1,
  ];
}

export interface BusinessProviderSettlementCutoverBuiltBatchV1 {
  request: BusinessProviderSettlementCutoverBatchRequestV1;
  epoch: BusinessProviderSettlementEpochV1;
  result: BusinessProviderSettlementCutoverResultV1;
  identity_hash: string;
  readiness: BusinessProviderSettlementCutoverReadinessEvidenceV1;
}

export interface BusinessProviderSettlementCutoverPrincipalV1 {
  type: "system";
  id: string;
}

export interface BusinessProviderSettlementCutoverAuthorityV1 {
  authorized: true;
  principal_type: "system";
  principal_id: string;
  action: BusinessProviderSettlementCutoverActionV1;
  cutover_id: string;
  settlement_contract_version: 2;
  send_authorization_contract_version: 2;
}

export interface BusinessProviderSettlementCutoverAuthorizerV1 {
  authenticate(input: {
    authentication: unknown;
    signal: AbortSignal;
  }):
    | BusinessProviderSettlementCutoverPrincipalV1
    | { principal: BusinessProviderSettlementCutoverPrincipalV1 }
    | null
    | Promise<
      | BusinessProviderSettlementCutoverPrincipalV1
      | { principal: BusinessProviderSettlementCutoverPrincipalV1 }
      | null
    >;
  authorize(input: {
    principal: BusinessProviderSettlementCutoverPrincipalV1;
    action: BusinessProviderSettlementCutoverActionV1;
    cutover: Readonly<BusinessProviderSettlementCutoverEnvelopeV1>;
    projection: Readonly<BusinessProjectionV1>;
    watermark: Readonly<{ journal_sequence: number }>;
    signal: AbortSignal;
  }):
    | BusinessProviderSettlementCutoverAuthorityV1
    | null
    | Promise<BusinessProviderSettlementCutoverAuthorityV1 | null>;
}

export interface BusinessProviderSettlementCutoverResolversV1 {
  resolveReadiness(input: {
    cutover: Readonly<BusinessProviderSettlementCutoverEnvelopeV1>;
    principal: Readonly<BusinessProviderSettlementCutoverPrincipalV1>;
    authority: Readonly<BusinessProviderSettlementCutoverAuthorityV1>;
    projected_readiness: Readonly<BusinessProviderSettlementProjectedReadinessV1>;
    signal: AbortSignal;
  }):
    | BusinessProviderSettlementCutoverReadinessEvidenceV1
    | Promise<BusinessProviderSettlementCutoverReadinessEvidenceV1>;
}

export type BusinessProviderSettlementCutoverProjectionConfigurationV1 =
  | Readonly<BusinessProjectionConfigurationV1>
  | Readonly<Record<string, unknown>>;

export interface BusinessProviderSettlementCutoverProjectionAdapterV1 {
  configuration: BusinessProviderSettlementCutoverProjectionConfigurationV1;
  prevalidateCutoverBatch(input: {
    projection: Readonly<BusinessProjectionV1>;
    request: Readonly<BusinessProviderSettlementCutoverBatchRequestV1>;
    expected_epoch: Readonly<BusinessProviderSettlementEpochV1>;
    signal: AbortSignal;
  }):
    | BusinessProjectionV1
    | Readonly<BusinessProjectionV1>
    | Promise<BusinessProjectionV1 | Readonly<BusinessProjectionV1>>;
}

export interface BusinessProviderSettlementCutoverEventStorePortV1 {
  replay(
    configuration: BusinessProviderSettlementCutoverProjectionConfigurationV1,
    control?: { signal: AbortSignal },
  ):
    | BusinessReplayResultV1
    | Promise<BusinessReplayResultV1>;
  commit(request: Readonly<BusinessProviderSettlementCutoverBatchRequestV1>):
    | Readonly<{
      status: "committed" | "idempotent";
      [key: string]: unknown;
    }>
    | Promise<Readonly<{
      status: "committed" | "idempotent";
      [key: string]: unknown;
    }>>;
}

export interface BusinessProviderSettlementCutoverBoundaryOptionsV1 {
  eventStore: BusinessProviderSettlementCutoverEventStorePortV1;
  authorizer: BusinessProviderSettlementCutoverAuthorizerV1;
  resolvers: BusinessProviderSettlementCutoverResolversV1;
  /** Test seam only; production defaults to the canonical Business projector. */
  projectionAdapter?: BusinessProviderSettlementCutoverProjectionAdapterV1;
  clock?: () => string;
  maxGlobalCasRetries?: number;
  dependencyTimeoutMs?: number;
}

export interface BusinessProviderSettlementCutoverBoundaryV1 {
  execute(input: {
    cutover: BusinessProviderSettlementCutoverEnvelopeV1;
    authentication: unknown;
    /** Honored before commit; a started durable commit is reconciled by receipt. */
    signal?: AbortSignal;
  }): Promise<Readonly<BusinessProviderSettlementCutoverResultV1>>;
}

export type BusinessProviderSettlementCutoverBoundaryErrorCodeV1 =
  | "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_ABORTED"
  | "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_ACTOR_BINDING_MISMATCH"
  | "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_ACTOR_INVALID"
  | "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_ALREADY_ACTIVATED"
  | "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_AUTHENTICATION_FAILED"
  | "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_AUTHENTICATION_INVALID"
  | "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_AUTHORIZATION_DENIED"
  | "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_BATCH_INVALID"
  | "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_CLOCK_INVALID"
  | "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_COMMIT_FAILED"
  | "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_COMMIT_OUTCOME_UNKNOWN"
  | "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_DEPENDENCY_TIMEOUT"
  | "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_EVENT_STORE_RESULT_INVALID"
  | "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_GLOBAL_CAS_EXHAUSTED"
  | "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_HASH_MISMATCH"
  | "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_ID_CONFLICT"
  | "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_INVALID"
  | "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_NOT_READY"
  | "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_PREVALIDATION_FAILED"
  | "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_PREVALIDATION_INVALID"
  | "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_PROJECTION_INVALID"
  | "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_READINESS_HASH_MISMATCH"
  | "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_READINESS_INVALID"
  | "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_READINESS_RESOLUTION_FAILED"
  | "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_READINESS_STALE"
  | "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_RECEIPT_INVALID"
  | "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_RECEIPT_MISSING"
  | "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_REPLAY_FAILED"
  | "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_VERSION";

export class BusinessProviderSettlementCutoverBoundaryError extends Error {
  constructor(
    code: BusinessProviderSettlementCutoverBoundaryErrorCodeV1,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  );
  readonly code: BusinessProviderSettlementCutoverBoundaryErrorCodeV1;
  readonly details: Readonly<Record<string, unknown>>;
}

export const PROVIDER_SETTLEMENT_CUTOVER_ACTION:
  BusinessProviderSettlementCutoverActionV1;
export const PROVIDER_SETTLEMENT_CUTOVER_ENVELOPE_VERSION: 1;
export const PROVIDER_SETTLEMENT_CUTOVER_PROJECTION_SCHEMA_VERSION: 2;
export const PROVIDER_SETTLEMENT_CUTOVER_RECEIVED_EVENT:
  "business.provider_settlement.cutover_received";
export const PROVIDER_SETTLEMENT_CUTOVER_SCHEMA_VERSION: 1;
export const PROVIDER_SETTLEMENT_CUTOVER_SOURCE_TYPE:
  BusinessProviderSettlementCutoverSourceTypeV1;
export const PROVIDER_SETTLEMENT_ACTIVATED_EVENT:
  "business.provider_settlement.v2_activated";
export const PROVIDER_SETTLEMENT_CONTRACT_VERSION: 2;

export function normalizeProviderSettlementCutoverEnvelopeV1(
  input: BusinessProviderSettlementCutoverEnvelopeV1,
): Readonly<BusinessProviderSettlementCutoverEnvelopeV1>;

export function deriveProviderSettlementCutoverReadinessV1(
  projection: BusinessProjectionV1,
  journalSequence: number,
): Readonly<BusinessProviderSettlementProjectedReadinessV1>;

export function normalizeProviderSettlementCutoverReadinessEvidenceV1(
  input: BusinessProviderSettlementCutoverReadinessEvidenceV1,
  expectedProjectedReadiness: BusinessProviderSettlementProjectedReadinessV1,
): Readonly<BusinessProviderSettlementCutoverReadinessEvidenceV1>;

export function normalizeProviderSettlementEpochV1(
  input: BusinessProviderSettlementEpochV1,
): Readonly<BusinessProviderSettlementEpochV1>;

export function buildProviderSettlementCutoverBatchV1(input: {
  cutover: BusinessProviderSettlementCutoverEnvelopeV1;
  principal: BusinessProviderSettlementCutoverPrincipalV1;
  projection: BusinessProjectionV1;
  journal_sequence: number;
  readiness: BusinessProviderSettlementCutoverReadinessEvidenceV1;
  occurred_at: string;
}): Readonly<BusinessProviderSettlementCutoverBuiltBatchV1>;

export function deriveProviderSettlementEpochFromBatchV1(
  request: BusinessProviderSettlementCutoverBatchRequestV1,
): Readonly<BusinessProviderSettlementEpochV1>;

/**
 * Activates the journal-global V2 settlement suffix. It records no provider
 * mutation, starts no reactor, and changes no Work Order revision.
 */
export function createBusinessProviderSettlementCutoverBoundary(
  options: BusinessProviderSettlementCutoverBoundaryOptionsV1,
): Readonly<BusinessProviderSettlementCutoverBoundaryV1>;

export interface BusinessDecisionV1<
  TResult extends BusinessJsonValue = BusinessJsonValue,
> {
  events: readonly BusinessEventV1[];
  result: TResult;
}

export class BusinessDecisionError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export function decideWorkOrderV1<
  TResult extends BusinessJsonValue = BusinessJsonValue,
>(
  state: BusinessProjectedWorkOrderV1 | null,
  input: CommandEnvelopeV1 | BusinessRuntimeObservationEnvelope,
  trustedFacts: Readonly<Record<string, unknown>>,
): Readonly<BusinessDecisionV1<TResult>>;

export const decideWorkOrder: typeof decideWorkOrderV1;

export interface BusinessPrincipalV1 {
  type: "agent" | "user" | "system";
  id: string;
}

export interface BusinessReplayResultV1 {
  state: BusinessProjectionV1;
  watermark: { journal_sequence: number; readonly [key: string]: unknown };
  readonly [key: string]: unknown;
}

export interface BusinessEventStorePortV1 {
  replay(configuration?: Readonly<Record<string, unknown>>):
    | BusinessReplayResultV1
    | Promise<BusinessReplayResultV1>;
  commit(request: Readonly<Record<string, unknown>>):
    | Readonly<{ status: "committed" | "idempotent"; [key: string]: unknown }>
    | Promise<Readonly<{ status: "committed" | "idempotent"; [key: string]: unknown }>>;
}

export interface BusinessCommandAuthorizerV1 {
  authenticate(input: { authentication: unknown; signal: AbortSignal }):
    | BusinessPrincipalV1
    | { principal: BusinessPrincipalV1 }
    | null
    | Promise<BusinessPrincipalV1 | { principal: BusinessPrincipalV1 } | null>;
  authorize(input: Readonly<Record<string, unknown>>):
    | BusinessCommandAuthorityV1
    | null
    | Promise<BusinessCommandAuthorityV1 | null>;
}

export interface BusinessCommandAuthorityV1 {
  authorized: true;
  principal_type: BusinessPrincipalV1["type"];
  principal_id: string;
  project_ref: string;
  permission_mode: BusinessPermissionMode;
  allowed_provider_refs: readonly string[];
  allowed_effects: readonly string[];
}

export interface BusinessCommandResolversV1 {
  resolvePlan(input: Readonly<Record<string, unknown>>): unknown | Promise<unknown>;
  resolveProject(input: Readonly<Record<string, unknown>>): unknown | Promise<unknown>;
  resolvePlanArtifacts(input: Readonly<Record<string, unknown>>): unknown | Promise<unknown>;
  resolveCommandFacts(input: Readonly<Record<string, unknown>>): unknown | Promise<unknown>;
}

export type BusinessWorkOrderDeciderV1 = (
  state: BusinessProjectedWorkOrderV1 | null,
  input: CommandEnvelopeV1,
  trustedFacts: Readonly<Record<string, unknown>>,
) => Readonly<BusinessDecisionV1> | Promise<Readonly<BusinessDecisionV1>>;

export interface BusinessCommandBoundaryOptionsV1 {
  eventStore: BusinessEventStorePortV1;
  authorizer: BusinessCommandAuthorizerV1;
  resolvers: BusinessCommandResolversV1;
  decider: BusinessWorkOrderDeciderV1;
  clock?: () => string;
  maxGlobalCasRetries?: number;
  /** Bound for authentication, authorization, resolution, replay, and decision reads. */
  dependencyTimeoutMs?: number;
}

export interface BusinessCommandBoundaryV1 {
  execute(input: {
    command: CommandEnvelopeV1;
    authentication: unknown;
    /** Honored before commit; a started durable commit is always reconciled. */
    signal?: AbortSignal;
  }): Promise<BusinessJsonValue>;
}

export const REQUIRED_PROVIDER_EFFECTS: readonly string[];

export class BusinessCommandBoundaryError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;
}

/**
 * Persists an authenticated command decision and its receipt atomically. This
 * boundary records provider intent only; it never performs provider effects.
 */
export function createBusinessCommandBoundary(
  options: BusinessCommandBoundaryOptionsV1,
): Readonly<BusinessCommandBoundaryV1>;

export interface BusinessObservationAuthorityV1 {
  authorized: true;
  principal_type: BusinessPrincipalV1["type"];
  principal_id: string;
  project_ref: string;
  work_order_id: string;
  plan_snapshot_ref: string;
  plan_hash: string;
  allowed_observation_names: readonly string[];
  allowed_branch_refs: readonly string[];
  allowed_provider_refs: readonly string[];
  allowed_verifier_refs: readonly string[];
}

export interface BusinessObservationAuthorizerV1 {
  authenticate(input: { authentication: unknown; signal: AbortSignal }):
    | BusinessPrincipalV1
    | { principal: BusinessPrincipalV1 }
    | null
    | Promise<BusinessPrincipalV1 | { principal: BusinessPrincipalV1 } | null>;
  authorize(input: Readonly<Record<string, unknown>>):
    | BusinessObservationAuthorityV1
    | null
    | Promise<BusinessObservationAuthorityV1 | null>;
}

export interface BusinessObservationResolversV1 {
  resolveProject(input: Readonly<Record<string, unknown>>): unknown | Promise<unknown>;
  /**
   * Returns only the name-specific fact whitelist. Current delivery results
   * must attest the projection-derived effect ID and idempotency key exactly.
   * V2 worker settlement must also repeat the callback-owned token and
   * content-addressed worker result; the current projection lease is never
   * supplied to this resolver as callback provenance. A pre-send failure must
   * return a trusted attestation that binds the projected Effect, claimed
   * token, bounded reason, content-addressed PFR, and evidence set.
   */
  resolveObservationFacts(input: Readonly<Record<string, unknown>>):
    | Readonly<Record<string, unknown>>
    | Promise<Readonly<Record<string, unknown>>>;
}

export interface BusinessObservationBoundaryOptionsV1 {
  eventStore: BusinessEventStorePortV1;
  authorizer: BusinessObservationAuthorizerV1;
  resolvers: BusinessObservationResolversV1;
  clock?: () => string;
  maxGlobalCasRetries?: number;
  dependencyTimeoutMs?: number;
}

export interface BusinessObservationBoundaryV1 {
  execute(input: {
    observation:
      | LiveRuntimeObservationEnvelopeV1
      | EffectSettlementObservationEnvelopeV2
      | EffectSendExpiryObservationEnvelopeV2
      | EffectPresendFailureObservationEnvelopeV2;
    authentication: unknown;
    replay_only?: false;
    /** Honored before commit; a started durable commit is always reconciled. */
    signal?: AbortSignal;
  }): Promise<BusinessJsonValue>;
  /**
   * Recovers an already-stored exact receipt for any historical envelope. It
   * never authorizes a new withheld callback or a new V1 aggregate write.
   */
  execute(input: {
    observation: BusinessRuntimeObservationEnvelope;
    authentication: unknown;
    replay_only: true;
    /** Honored before commit; a started durable commit is always reconciled. */
    signal?: AbortSignal;
  }): Promise<BusinessJsonValue>;
}

export class BusinessObservationBoundaryError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export const LIVE_RUNTIME_OBSERVATION_NAMES: readonly LiveRuntimeObservationName[];

/**
 * Authenticates and atomically records enabled host, verifier, and Effect V2
 * settlement facts. New provider settlement requires the durable journal-global
 * cutover; legacy turn callbacks remain replay-only. The boundary has no
 * provider mutation capability.
 */
export function createBusinessObservationBoundary(
  options: BusinessObservationBoundaryOptionsV1,
): Readonly<BusinessObservationBoundaryV1>;

export type BusinessInternalActionNameV1 =
  | "outbox.claim"
  | "outbox.send.begin"
  | "outbox.lease.renew"
  | "outbox.requeue";

export interface BusinessOutboxClaimPayloadV1 {
  effect_id: string;
  lease_id: string;
  owner_id: string;
}

export interface BusinessOutboxLeaseTokenPayloadV1
  extends BusinessOutboxClaimPayloadV1 {
  generation: number;
}

export interface BusinessOutboxRequeuePayloadV1
  extends BusinessOutboxLeaseTokenPayloadV1 {
  reason: string;
}

export interface BusinessInternalActionPayloadMapV1 {
  "outbox.claim": BusinessOutboxClaimPayloadV1;
  "outbox.send.begin": BusinessOutboxLeaseTokenPayloadV1;
  "outbox.lease.renew": BusinessOutboxLeaseTokenPayloadV1;
  "outbox.requeue": BusinessOutboxRequeuePayloadV1;
}

export interface BusinessInternalActionEnvelopeVariantV1<
  TName extends BusinessInternalActionNameV1,
> {
  version: 1;
  internal_action_id: string;
  work_order_id: string;
  plan_snapshot_ref: string;
  plan_hash: string;
  expected_work_order_revision: number;
  actor: ActorIdentityV1<"system">;
  name: TName;
  payload: BusinessInternalActionPayloadMapV1[TName];
  /** Canonical hash of the exact normalized payload; not an authorization proof. */
  payload_hash: string;
}

export type BusinessInternalActionEnvelopeV1 = {
  [TName in BusinessInternalActionNameV1]:
    BusinessInternalActionEnvelopeVariantV1<TName>;
}[BusinessInternalActionNameV1];

export interface BusinessInternalActionAuthorityV1 {
  authorized: true;
  principal_type: "system";
  principal_id: string;
  work_order_id: string;
  effect_id: string;
  action: BusinessInternalActionNameV1;
}

export interface BusinessInternalActionAuthorizerV1 {
  authenticate(input: { authentication: unknown; signal: AbortSignal }):
    | BusinessPrincipalV1
    | { principal: BusinessPrincipalV1 }
    | null
    | Promise<BusinessPrincipalV1 | { principal: BusinessPrincipalV1 } | null>;
  authorize(input: Readonly<Record<string, unknown>>):
    | BusinessInternalActionAuthorityV1
    | null
    | Promise<BusinessInternalActionAuthorityV1 | null>;
}

export interface BusinessInternalActionResolversV1 {
  /** Returns the exact current immutable effect, status, and lease projection. */
  resolveEffectFacts(input: Readonly<Record<string, unknown>>):
    | Readonly<Record<string, unknown>>
    | Promise<Readonly<Record<string, unknown>>>;
}

export interface BusinessInternalActionBoundaryOptionsV1 {
  eventStore: BusinessEventStorePortV1;
  authorizer: BusinessInternalActionAuthorizerV1;
  resolvers: BusinessInternalActionResolversV1;
  /** Required by `outbox.send.begin`; omitted/null keeps that action disabled. */
  packetStore?: Pick<BusinessDispatchPacketStoreV1, "verifyForSendAuthorization"> | null;
  clock?: () => string;
  maxGlobalCasRetries?: number;
  dependencyTimeoutMs?: number;
}

export interface BusinessInternalActionResultBaseV1 {
  internal_action_id: string;
  work_order_id: string;
  work_order_revision: number;
  effect_id: string;
  action: BusinessInternalActionNameV1;
  outbox_status: string;
}

export interface BusinessOutboxClaimResultV1
  extends BusinessInternalActionResultBaseV1 {
  action: "outbox.claim";
  outbox_status: "claimed";
  fencing_token: WorkerFencingTokenV2;
}

export interface BusinessOutboxSendBeginResultV1
  extends BusinessInternalActionResultBaseV1 {
  action: "outbox.send.begin";
  outbox_status: "sending";
  fencing_token: WorkerFencingTokenV2;
  packet_verification_receipt: BusinessDispatchPacketVerificationReceiptV1;
  send_authorization_bundle: BusinessSendAuthorizationBundleV1;
}

export interface BusinessOutboxClaimedLeaseRenewResultV1
  extends BusinessInternalActionResultBaseV1 {
  action: "outbox.lease.renew";
  outbox_status: "claimed";
}

export interface BusinessOutboxSendingLeaseRenewResultV1
  extends BusinessInternalActionResultBaseV1 {
  action: "outbox.lease.renew";
  outbox_status: "sending";
  fencing_token: WorkerFencingTokenV2;
  provider_entry_window_continuation: BusinessProviderEntryWindowContinuationV1;
}

export type BusinessOutboxLeaseRenewResultV1 =
  | BusinessOutboxClaimedLeaseRenewResultV1
  | BusinessOutboxSendingLeaseRenewResultV1;

export interface BusinessOutboxRequeueResultV1
  extends BusinessInternalActionResultBaseV1 {
  action: "outbox.requeue";
  outbox_status: "pending";
}

/**
 * Exact replay returns the receipt bytes originally committed. Early V1/V2
 * internal receipts predate callback fencing, packet authorization, SAB, and
 * PEW continuation fields; the boundary never synthesizes those fields from
 * today's mutable state.
 */
export interface BusinessHistoricalInternalActionResultV1
  extends BusinessInternalActionResultBaseV1 {
  fencing_token?: WorkerFencingTokenV2;
  packet_verification_receipt?: BusinessDispatchPacketVerificationReceiptV1;
  send_authorization_bundle?: BusinessSendAuthorizationBundleV1;
  provider_entry_window_continuation?: BusinessProviderEntryWindowContinuationV1;
}

export type BusinessInternalActionResultV1 =
  | BusinessHistoricalInternalActionResultV1
  | BusinessOutboxClaimResultV1
  | BusinessOutboxSendBeginResultV1
  | BusinessOutboxLeaseRenewResultV1
  | BusinessOutboxRequeueResultV1;

export interface BusinessInternalActionBoundaryV1 {
  execute(input: {
    internal_action: BusinessInternalActionEnvelopeV1;
    authentication: unknown;
    /** Honored before commit; a started durable commit is always reconciled. */
    signal?: AbortSignal;
  }): Promise<Readonly<BusinessInternalActionResultV1>>;
}

export const INTERNAL_ACTION_ENVELOPE_VERSION: 1;
export const INTERNAL_ACTION_NAMES: readonly BusinessInternalActionNameV1[];

export class BusinessInternalActionBoundaryError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export function normalizeInternalActionEnvelopeV1(
  input: unknown,
): Readonly<BusinessInternalActionEnvelopeV1>;

/**
 * Persists system-authorized claim, verified send-begin, renewal, and pre-send
 * requeue transitions with exact receipts. Send-begin requires an active
 * settlement epoch, the current unexpired lease, and an exact PacketStore
 * verification receipt. It does not invoke a provider or start a process.
 */
export function createBusinessInternalActionBoundary(
  options: BusinessInternalActionBoundaryOptionsV1,
): Readonly<BusinessInternalActionBoundaryV1>;

export type BusinessProviderMutatingEffectKindV2 =
  | "provider.thread.create"
  | "provider.turn.start"
  | "provider.user_input.submit"
  | "provider.turn.cancel";

export interface BusinessDispatchPacketStoreLimitsV1 {
  max_packet_bytes: number;
  max_input_depth: number;
  max_input_nodes: number;
  max_string_bytes: number;
  max_array_items: number;
  max_ref_bytes: number;
  max_runtime_ms: number;
  max_output_bytes: number;
  max_tool_calls: number;
}

export interface BusinessDispatchPacketWorkOrderV1 {
  work_order_id: string;
  work_order_revision: number;
  engine_contract_version: 2;
}

export interface BusinessDispatchPacketPlanV1 {
  plan_snapshot_ref: string;
  plan_hash: string;
}

export interface BusinessDispatchPacketBranchV1 {
  branch_ref: string;
  next_attempt: number;
  task_intent_ref: ContentAddressedArtifactRefV1;
  execution_plan_ref: ContentAddressedArtifactRefV1;
  attempt_packet_ref: ContentAddressedArtifactRefV1 | null;
}

export interface BusinessDispatchPacketProviderV1 {
  provider_ref: string;
  configuration_ref: ContentAddressedArtifactRefV1;
}

export interface BusinessDispatchPacketWorkspaceV1 {
  workspace_ref: string;
  checkpoint_ref: ContentAddressedArtifactRefV1;
  isolation_mode: BusinessBranchIsolation;
}

export interface BusinessDispatchPacketContextV1 {
  context_pack_ref: ContentAddressedArtifactRefV1;
  context_manifest_ref: ContentAddressedArtifactRefV1;
  request_payload: BusinessJsonValue;
  user_input_request_id: string | null;
  user_input_response_ref: ContentAddressedArtifactRefV1 | null;
}

export interface BusinessDispatchPacketAuthorityV1 {
  authority_ref: ContentAddressedArtifactRefV1;
  principal_type: "agent" | "user" | "system";
  principal_id: string;
  project_ref: string;
  permission_mode: BusinessPermissionMode;
  allowed_provider_refs: string[];
  allowed_effects: string[];
}

export interface BusinessDispatchPacketEffectCeilingV1 {
  allowed_effect_kinds: BusinessProviderMutatingEffectKindV2[];
  deadline_at: string;
  max_runtime_ms: number;
  max_output_bytes: number;
  max_tool_calls: number;
}

export interface BusinessDispatchPacketV1 {
  schema_version: 1;
  work_order: BusinessDispatchPacketWorkOrderV1;
  plan: BusinessDispatchPacketPlanV1;
  branch: BusinessDispatchPacketBranchV1;
  provider: BusinessDispatchPacketProviderV1;
  workspace: BusinessDispatchPacketWorkspaceV1;
  context: BusinessDispatchPacketContextV1;
  authority: BusinessDispatchPacketAuthorityV1;
  effect_ceiling: BusinessDispatchPacketEffectCeilingV1;
}

export interface BusinessProviderRuntimeIdentityV2 {
  operation_id: string | null;
  thread_id: string | null;
  turn_id: string | null;
}

/** The exact immutable Effect V2 identity accepted by PacketStore verification. */
export interface BusinessProviderEffectIdentityV2 {
  effect_id: string;
  effect_contract_version: 2;
  work_order_id: string;
  branch_ref: string;
  attempt: number;
  dispatch_id: string;
  effect_kind: BusinessProviderMutatingEffectKindV2;
  origin_source_id: string;
  operation_scope_hash: string;
  operation_generation: number;
  generation_predecessor_effect_id: string | null;
  provider_ref: string;
  packet_ref: string;
  packet_hash: string;
  predecessor_effect_id: string | null;
  predecessor_delivery_hash: string | null;
  target_runtime_identity: BusinessProviderRuntimeIdentityV2 | null;
  idempotency_key: string;
  created_at: string;
}

/**
 * Immutable provider-operation scope re-derived from one Effect V2. This is
 * repeated at the PacketStore and journal boundaries; it is not caller-chosen
 * provider-entry authority.
 */
export interface BusinessSendAuthorizationOperationScopeBindingV2 {
  effect_kind: BusinessProviderMutatingEffectKindV2;
  provider_ref: string;
  packet_ref: string;
  packet_hash: string;
  predecessor_effect_id: string | null;
  predecessor_delivery_hash: string | null;
  target_runtime_identity: BusinessProviderRuntimeIdentityV2 | null;
  request_id: string | null;
  response_ref: ContentAddressedArtifactRefV1 | null;
}

export interface BusinessSendAuthorizationEventPayloadV2 {
  work_order_id: string;
  plan_snapshot_ref: string;
  plan_hash: string;
  source_id: string;
  prior_work_order_revision: number;
  target_work_order_revision: number;
  occurred_at: string;
  effect_id: string;
  effect: BusinessProviderEffectIdentityV2;
  lease_id: string;
  lease_owner_id: string;
  lease_generation: number;
  lease_expires_at: string;
  packet_verification_receipt: BusinessDispatchPacketVerificationReceiptV1;
  provider_settlement_cutover_id: string;
  operation_scope_binding: BusinessSendAuthorizationOperationScopeBindingV2;
  send_authorization_contract_version: 2;
}

/** Exact content-addressed `business.outbox.send_begun` domain event. */
export interface BusinessSendAuthorizationEventV1
  extends Omit<BusinessEventV1, "type" | "payload" | "evidence_refs"> {
  type: "business.outbox.send_begun";
  payload: BusinessSendAuthorizationEventPayloadV2;
  evidence_refs: readonly [];
}

/**
 * Receipt-bound Send Authorization Bundle. The package exposes the data shape
 * through send-begin results but keeps its creators and resolvers internal.
 */
export interface BusinessSendAuthorizationBundleV1 {
  bundle_version: 1;
  authorization_contract_version: 2;
  authorization_kind: "committed_outbox_send_begin";
  send_event: BusinessSendAuthorizationEventV1;
  send_event_ref: ContentAddressedArtifactRefV1;
  batch_id: string;
  domain_event_manifest_hash: string;
  bundle_ref: ContentAddressedArtifactRefV1;
}

/** PacketStore proof used specifically for constructing a send authorization. */
export interface BusinessDispatchPacketSendAuthorizationVerificationV1 {
  authorization_verification_version: 1;
  packet_verification_receipt: BusinessDispatchPacketVerificationReceiptV1;
  operation_scope_binding: BusinessSendAuthorizationOperationScopeBindingV2;
}

export interface BusinessProviderEntryWindowLeaseV1 {
  lease_id: string;
  owner_id: string;
  generation: number;
  claimed_at: string;
  heartbeat_at: string;
  expires_at: string;
}

export interface BusinessProviderEntryWindowLeaseRenewedPayloadV1 {
  work_order_id: string;
  plan_snapshot_ref: string;
  plan_hash: string;
  source_id: string;
  prior_work_order_revision: number;
  target_work_order_revision: number;
  occurred_at: string;
  effect_id: string;
  effect: BusinessProviderEffectIdentityV2;
  lease: BusinessProviderEntryWindowLeaseV1;
}

export interface BusinessProviderEntryWindowLeaseRenewedEventV1
  extends Omit<BusinessEventV1, "type" | "payload" | "evidence_refs"> {
  type: "business.outbox.lease_renewed";
  payload: BusinessProviderEntryWindowLeaseRenewedPayloadV1;
  evidence_refs: readonly [];
}

export interface BusinessProviderEntryWindowCommonV1 {
  provider_entry_window_version: 1;
  send_authorization_bundle_ref: ContentAddressedArtifactRefV1;
  committed_send_authorization_hash: string;
  effect_id: string;
  authorized_fencing_token: WorkerFencingTokenV2;
  window_sequence: number;
  lease_expires_at: string;
  source_event_ref: ContentAddressedArtifactRefV1;
  batch_id: string;
  domain_event_manifest_hash: string;
  window_ref: ContentAddressedArtifactRefV1;
}

export interface BusinessProviderEntryWindowAnchorV1
  extends BusinessProviderEntryWindowCommonV1 {
  window_kind: "send_begin";
  window_sequence: 0;
  previous_window_ref: null;
  previous_lease_expires_at: null;
  source_event: BusinessSendAuthorizationEventV1;
}

export interface BusinessProviderEntryWindowContinuationV1
  extends BusinessProviderEntryWindowCommonV1 {
  window_kind: "same_token_sending_lease_renewal";
  previous_window_ref: ContentAddressedArtifactRefV1;
  previous_lease_expires_at: string;
  source_event: BusinessProviderEntryWindowLeaseRenewedEventV1;
}

export type BusinessProviderEntryWindowV1 =
  | BusinessProviderEntryWindowAnchorV1
  | BusinessProviderEntryWindowContinuationV1;

/** Latest projector-derived, receipt-closed pointer for one PEW chain. */
export interface BusinessProviderEntryWindowIndexV1 {
  index_version: 1;
  effect_id: string;
  send_authorization_bundle_ref: ContentAddressedArtifactRefV1;
  committed_send_authorization_hash: string;
  authorized_fencing_token: WorkerFencingTokenV2;
  current_window_ref: ContentAddressedArtifactRefV1;
  current_window_sequence: number;
  current_lease_expires_at: string;
  send_authorization_receipt_id: string;
  send_authorization_receipt_ref: ContentAddressedArtifactRefV1;
  current_window_receipt_id: string;
  current_window_receipt_ref: ContentAddressedArtifactRefV1;
}

export interface BusinessDispatchPacketVerificationBindingV1 {
  work_order_id: string;
  work_order_revision: number;
  engine_contract_version: 2;
  plan_snapshot_ref: string;
  plan_hash: string;
  branch_ref: string;
  next_attempt: number;
  task_intent_ref: ContentAddressedArtifactRefV1;
  execution_plan_ref: ContentAddressedArtifactRefV1;
  dispatch_packet_ref: ContentAddressedArtifactRefV1;
  provider_ref: string;
  provider_configuration_ref: ContentAddressedArtifactRefV1;
  workspace_ref: string;
  workspace_checkpoint_ref: ContentAddressedArtifactRefV1;
  isolation_mode: BusinessBranchIsolation;
  context_pack_ref: ContentAddressedArtifactRefV1;
  context_manifest_ref: ContentAddressedArtifactRefV1;
  context_binding_hash: string;
  authority_ref: ContentAddressedArtifactRefV1;
  principal_type: "agent" | "user" | "system";
  principal_id: string;
  project_ref: string;
  permission_mode: BusinessPermissionMode;
  authority_ceiling_hash: string;
  effect_ceiling_hash: string;
}

export interface BusinessDispatchPacketVerificationReceiptV1 {
  schema_version: 1;
  disposition: "verified";
  failure_class: null;
  failure_taxonomy_version: 1;
  delivery_disposition: "not_evaluated";
  verification_scope: "packet_integrity_and_effect_binding_only";
  retry_authorization: "not_evaluated";
  packet_ref: ContentAddressedArtifactRefV1;
  packet_binding: BusinessDispatchPacketVerificationBindingV1;
  effect_identity: BusinessProviderEffectIdentityV2;
  dispatch_identity_hash: string;
  effect_identity_hash: string;
  effect_identifier_seed_hash: string;
  generation_binding_hash: string;
  receipt_ref: string;
  receipt_hash: string;
}

export interface BusinessDispatchPacketStoreSecurityProofV1 {
  proof_version: 1;
  platform: string;
  root_realpath: string;
  privacy_enforcement: string;
  owner_only_directories: true;
  owner_only_files: true;
  private_acl_verified: true;
  symlink_components_rejected: true;
  no_follow_reads: true;
  exclusive_temp_creation: true;
  atomic_no_replace_rename: true;
  file_fsync: true;
  directory_fsync: true;
  coordinated_recovery: true;
  directory_handle_pinned: true;
}

export interface BusinessDispatchPacketStoreRecoveryProofV1 {
  recovery_version: 1;
  root_realpath: string;
  exclusive_recovery: true;
  stale_temps_handled: true;
  directory_fsynced: true;
}

/** Node.js Buffer-compatible bytes required by the storage boundary. */
export interface BusinessDispatchPacketStoreBytesV1 extends Uint8Array {
  equals(other: Uint8Array): boolean;
}

export type BusinessPacketStoreMaybePromise<T> = T | Promise<T>;

export interface BusinessDispatchPacketStorePlatformAdapterV1<
  TStoreHandle = unknown,
  TFileHandle = unknown,
> {
  openStore(input: { root_path: string }): BusinessPacketStoreMaybePromise<{
    handle: TStoreHandle;
    proof: BusinessDispatchPacketStoreSecurityProofV1;
  }>;
  recoverInterruptedWrites(input: {
    store_handle: TStoreHandle;
    target_name: string;
    temp_prefix: string;
  }): BusinessPacketStoreMaybePromise<BusinessDispatchPacketStoreRecoveryProofV1>;
  readFileNoFollow(input: {
    store_handle: TStoreHandle;
    name: string;
    max_bytes: number;
  }): BusinessPacketStoreMaybePromise<BusinessDispatchPacketStoreBytesV1>;
  openTempExclusive(input: {
    store_handle: TStoreHandle;
    name: string;
    mode: 384;
  }): BusinessPacketStoreMaybePromise<TFileHandle>;
  writeAll(input: {
    file_handle: TFileHandle;
    bytes: BusinessDispatchPacketStoreBytesV1;
  }): BusinessPacketStoreMaybePromise<void>;
  fsyncFile(input: { file_handle: TFileHandle }): BusinessPacketStoreMaybePromise<void>;
  closeFile(input: { file_handle: TFileHandle }): BusinessPacketStoreMaybePromise<void>;
  renameTempNoReplace(input: {
    store_handle: TStoreHandle;
    from_name: string;
    to_name: string;
  }): BusinessPacketStoreMaybePromise<void>;
  unlinkTempNoFollow(input: {
    store_handle: TStoreHandle;
    name: string;
  }): BusinessPacketStoreMaybePromise<void>;
  fsyncDirectory(input: {
    store_handle: TStoreHandle;
  }): BusinessPacketStoreMaybePromise<void>;
  closeStore(input: {
    store_handle: TStoreHandle;
  }): BusinessPacketStoreMaybePromise<void>;
}

export interface BusinessDispatchPacketStoreOptionsV1<
  TStoreHandle = unknown,
  TFileHandle = unknown,
> {
  root_path: string;
  platform_adapter: BusinessDispatchPacketStorePlatformAdapterV1<
    TStoreHandle,
    TFileHandle
  >;
  /** Every override may only lower the built-in ceiling. */
  limits?: Readonly<Partial<BusinessDispatchPacketStoreLimitsV1>>;
}

export interface BusinessDispatchPacketStoreV1 {
  create(
    input: BusinessDispatchPacketV1,
  ): Promise<Readonly<ContentAddressedArtifactRefV1>>;
  read(
    packet_ref: ContentAddressedArtifactRefV1,
  ): Promise<Readonly<BusinessDispatchPacketV1>>;
  verifyForEffect(
    effect: BusinessProviderEffectIdentityV2,
  ): Promise<Readonly<BusinessDispatchPacketVerificationReceiptV1>>;
  verifyForSendAuthorization(
    effect: BusinessProviderEffectIdentityV2,
  ): Promise<Readonly<BusinessDispatchPacketSendAuthorizationVerificationV1>>;
}

export type BusinessPacketStoreFailureClassV1 =
  | "packet_invalid"
  | "packet_missing"
  | "packet_tampered"
  | "capability_mismatch"
  | "policy_mismatch"
  | "storage_unavailable"
  | "durability_uncertain";

export type BusinessPacketStoreErrorCodeV1 =
  | "BUSINESS_PACKET_STORE_CONFIGURATION_INVALID"
  | "BUSINESS_PACKET_STORE_UNTRUSTED_PLATFORM"
  | "BUSINESS_PACKET_STORE_SECURITY_UNVERIFIED"
  | "BUSINESS_PACKET_STORE_RECOVERY_FAILED"
  | "BUSINESS_PACKET_STORE_WRITE_FAILED"
  | "BUSINESS_PACKET_STORE_DURABILITY_UNCERTAIN"
  | "BUSINESS_PACKET_STORE_PATH_UNSAFE"
  | "BUSINESS_DISPATCH_PACKET_INVALID"
  | "BUSINESS_DISPATCH_PACKET_LIMIT"
  | "BUSINESS_DISPATCH_PACKET_REFERENCE_INVALID"
  | "BUSINESS_DISPATCH_PACKET_NOT_FOUND"
  | "BUSINESS_DISPATCH_PACKET_TAMPERED"
  | "BUSINESS_DISPATCH_PACKET_CONFLICT"
  | "BUSINESS_DISPATCH_PACKET_CAPABILITY_MISMATCH"
  | "BUSINESS_DISPATCH_PACKET_POLICY_MISMATCH"
  | "BUSINESS_DISPATCH_PACKET_EFFECT_BINDING";

export class BusinessPacketStoreError extends Error {
  readonly code: BusinessPacketStoreErrorCodeV1;
  readonly disposition: "rejected";
  readonly failure_class: BusinessPacketStoreFailureClassV1;
  readonly retry_authorization: "not_evaluated";
  readonly details: Readonly<Record<string, unknown>>;
}

export const DISPATCH_PACKET_CONTRACT_VERSION: 1;
export const DISPATCH_PACKET_VERIFICATION_RECEIPT_VERSION: 1;
export const DISPATCH_PACKET_STORE_LIMITS:
  Readonly<BusinessDispatchPacketStoreLimitsV1>;

export function normalizeDispatchPacketV1(
  input: BusinessDispatchPacketV1,
  limits?: Readonly<Partial<BusinessDispatchPacketStoreLimitsV1>>,
): Readonly<BusinessDispatchPacketV1>;

export function normalizeDispatchPacketVerificationReceiptV1(
  input: BusinessDispatchPacketVerificationReceiptV1,
  limits?: Readonly<Partial<BusinessDispatchPacketStoreLimitsV1>>,
): Readonly<BusinessDispatchPacketVerificationReceiptV1>;

export function normalizeDispatchPacketSendAuthorizationVerificationV1(
  input: BusinessDispatchPacketSendAuthorizationVerificationV1,
  limits?: Readonly<Partial<BusinessDispatchPacketStoreLimitsV1>>,
): Readonly<BusinessDispatchPacketSendAuthorizationVerificationV1>;

export function createDispatchPacketStore<TStoreHandle, TFileHandle>(
  options: BusinessDispatchPacketStoreOptionsV1<TStoreHandle, TFileHandle>,
): Readonly<BusinessDispatchPacketStoreV1>;

export type DispatchPacketV1 = BusinessDispatchPacketV1;
export type DispatchPacketVerificationReceiptV1 =
  BusinessDispatchPacketVerificationReceiptV1;
export type DispatchPacketStoreV1 = BusinessDispatchPacketStoreV1;
export type DispatchPacketStoreOptionsV1<
  TStoreHandle = unknown,
  TFileHandle = unknown,
> = BusinessDispatchPacketStoreOptionsV1<TStoreHandle, TFileHandle>;
export type DispatchPacketStorePlatformAdapterV1<
  TStoreHandle = unknown,
  TFileHandle = unknown,
> = BusinessDispatchPacketStorePlatformAdapterV1<TStoreHandle, TFileHandle>;

export interface BusinessDesktopSourceCursorV1 {
  journalSequence: number;
  lastBatchId: string | null;
  journalHash: string;
  projectionHash: string;
}

export interface BusinessDesktopReadConsumerV1 {
  name: "orquesta.business-work-orders.read";
  major: 1;
  minMinor: number;
  requiredFeatures: string[];
}

export interface BusinessDesktopIndexQueryV1 {
  kind: "index";
  limit?: number;
  afterKey?: string | null;
}

export interface BusinessDesktopReadRequestV1 {
  projectId: string;
  consumer: BusinessDesktopReadConsumerV1;
  afterCursor: BusinessDesktopSourceCursorV1 | null;
  query: BusinessDesktopIndexQueryV1;
}

export interface BusinessDesktopReadResultV1 {
  schemaVersion: 1;
  runtimeProjectId: string;
  continuity: "initial" | "unchanged" | "advanced";
  cursor: BusinessDesktopSourceCursorV1;
  capability: Readonly<Record<string, unknown>>;
  businessProjectScope: Readonly<{
    mode: "none" | "single" | "multiple";
    projectRefs: string[];
  }>;
  providerSettlement: Readonly<{ active: boolean; cutoverId: string | null }>;
  page: Readonly<{
    kind: "index";
    items: ReadonlyArray<Readonly<Record<string, unknown>>>;
    nextAfterKey: string | null;
  }>;
}

export class BusinessDesktopReadError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export const BUSINESS_DESKTOP_READ_SCHEMA_VERSION: 1;
export const BUSINESS_DESKTOP_READ_CONSUMER: "orquesta.business-work-orders.read";
export const BUSINESS_DESKTOP_READ_FEATURES: readonly string[];
export const BUSINESS_DESKTOP_READ_LIMITS: Readonly<{
  maxResultBytes: 1048576;
  indexPageSize: 25;
  branchPageSize: 64;
  recordPageSize: 16;
}>;

export function createBusinessDesktopReadResultV1(input: {
  request: BusinessDesktopReadRequestV1;
  projection: BusinessProjectionV1;
  cursor: BusinessDesktopSourceCursorV1;
  continuity: "initial" | "unchanged" | "advanced" | "diverged" | "rewound";
  runtimeProjectId: string;
}): Readonly<BusinessDesktopReadResultV1>;
