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

export interface SessionRotationPolicy {
  prepare_at: number;
  pending_at: number;
  required_at: number;
}

export interface SessionRotationRecord {
  session_id: string;
  thread_id: string;
  agent_id: string | null;
  session_generation: number;
  compaction_count: number;
  rotation_state: string;
  ownership_status: "owner" | "candidate" | "superseded" | string;
  accepts_new_work: boolean;
  replaces_session_id: string | null;
  replaced_by_session_id: string | null;
  handoff_manifest_path: string | null;
  handoff_manifest_hash: string | null;
  successor_receipt_path: string | null;
  successor_receipt_hash: string | null;
  last_compaction: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface SessionRotationRegistry {
  schema_version: 1;
  revision: number;
  policy: SessionRotationPolicy;
  sessions: Record<string, SessionRotationRecord>;
  applied_event_ids: string[];
  updated_at: string | null;
}

export const DEFAULT_SESSION_ROTATION_POLICY: Readonly<SessionRotationPolicy>;
export const ROTATION_STATES: readonly string[];
export function normalizeRotationPolicy(input?: Partial<SessionRotationPolicy>): Readonly<SessionRotationPolicy>;
export function rotationStateForCount(count: number, policy?: Partial<SessionRotationPolicy>): string;
export function createSessionRotationRegistry(input?: { policy?: Partial<SessionRotationPolicy>; updated_at?: string }): SessionRotationRegistry;
export function recordCompaction(registry: SessionRotationRegistry, event: Record<string, unknown>): {
  registry: SessionRotationRegistry;
  duplicate: boolean;
  threshold_crossed: string | null;
  session: SessionRotationRecord | null;
};
export function beginSessionDrain(registry: SessionRotationRegistry, input: Record<string, unknown>): SessionRotationRegistry;
export function markSessionCheckpointed(registry: SessionRotationRegistry, input: Record<string, unknown>): SessionRotationRegistry;
export function registerSessionSuccessor(registry: SessionRotationRegistry, input: Record<string, unknown>): SessionRotationRegistry;
export function verifySuccessorReceipt(registry: SessionRotationRegistry, input: Record<string, unknown>): {
  valid: boolean;
  reasons: string[];
  successor: SessionRotationRecord;
};
export function markSuccessorVerified(registry: SessionRotationRegistry, input: Record<string, unknown>): SessionRotationRegistry;
export function activateSessionSuccessor(registry: SessionRotationRegistry, input: Record<string, unknown>): SessionRotationRegistry;
export function selectActiveAgentSession(sessions: Array<Record<string, unknown>>, agentId: string): Record<string, unknown> | null;

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
