import type { ConversationPage, RuntimeInfoUi } from '../contracts/bridge';
import { type AttentionUiItem, type InspectionKind, type InspectionTargetUi, type OrquestaUiSnapshot } from '../contracts/orquesta-ui';
import type { WorkflowCatalog, WorkflowCheck } from './workflow-store';
import {
  ATTACHMENTS_PER_DISPATCH,
  ATTACHMENT_SOURCE_BYTES_PER_TURN,
  isAttachmentDisplayName,
  isDispatchAttachmentWithinPolicy,
  type DispatchPrivateAttachment,
} from './attachment-capability-broker';
import { NATIVE_CONTENT_POLICY } from '../../../contracts/generated/desktop/native-bridge-contract';

export interface RuntimeModelEvidence {
  recommendedModel: string | null;
  requestedModel: string | null;
  appliedModel: string | null;
  actualModel: string | null;
  actualModelEvidence: 'proven' | 'reported' | 'inferred' | 'unknown';
}

// The service response journal and repository resolution journal intentionally
// share this insertion-ordered retention contract. Increasing only one side
// would make a retry appear resolvable in one layer and forgotten in the other.
export const RUNTIME_APPROVAL_RETENTION_LIMIT = 200;

export interface RuntimeThreadNotification {
  kind: 'turn_started' | 'turn_completed' | 'turn_failed' | 'agent_message'
    | 'model_observed' | 'provider_event';
  correlationId?: string | null;
  threadId: string;
  turnId: string | null;
  text: string | null;
  targetAgentId: string | null;
  modelEvidence: RuntimeModelEvidence;
  itemId?: string | null;
  occurredAt?: string | null;
  providerEvent?: Record<string, unknown> | null;
}

export type RuntimeNotification = RuntimeThreadNotification | {
  kind: 'provider_connection';
  providerConnectionId: string;
  state: 'connected' | 'disconnected';
};

export interface RuntimeApprovalRequest {
  projectId: string;
  providerConnectionId: string;
  correlationId: string;
  requestId: string;
  method: string;
  threadId: string;
  turnId: string;
  targetAgentId: string | null;
  requestedEffect: { kind: string; itemId: string };
  reason: string | null;
  responseOptions: string[];
  actionFingerprint: string;
}

export interface RuntimeSendRequest {
  type: 'runtime.send';
  correlationId: string;
  messageId?: string;
  actionFingerprint?: string;
  projectId: string;
  rootPath: string;
  threadId: string | null;
  targetAgentId: string;
  text: string;
  attachments: DispatchPrivateAttachment[];
  selectedContextIds?: string[];
  recommendedModel?: string | null;
  requestedModel?: string | null;
  effort?: 'low' | 'medium' | 'high' | null;
}

export interface RuntimeDispatchReconcileRequest {
  type: 'runtime.dispatch.reconcile';
  correlationId: string;
  projectId: string;
  rootPath: string;
  messageId: string;
  actionFingerprint: string;
}

export interface RuntimeTurnInterruptRequest {
  type: 'runtime.turn.interrupt';
  correlationId: string;
  projectId: string;
  rootPath: string;
  targetAgentId: string;
  threadId: string;
  turnId: string;
}

export interface RuntimeTurnSteerRequest {
  type: 'runtime.turn.steer';
  correlationId: string;
  steerId: string;
  projectId: string;
  rootPath: string;
  targetAgentId: string;
  threadId: string;
  turnId: string;
  text: string;
}

export interface RuntimeConversationRequest {
  type: 'runtime.conversation';
  correlationId: string;
  projectId: string;
  rootPath: string;
  targetAgentId: string;
  cursor?: string | null;
  limit: number;
  includeStructuredActivities?: boolean;
}

export interface RuntimeInfoRequest {
  type: 'runtime.info';
  correlationId: string;
  probe: boolean;
}

export interface RuntimeLaunchContext {
  source: 'argv' | 'environment' | 'e2e' | 'standalone';
  callingThreadId: string | null;
}

export interface ProjectBootstrapRequest {
  type: 'project.bootstrap';
  correlationId: string;
}

export interface ProjectBootstrapResult {
  status: 'ready' | 'migration_required' | 'unsupported' | 'recovery_required';
  no_write: boolean;
  reason: string | null;
  classification?: string | null;
}

export interface RepositorySelectRequest {
  type: 'repository.select';
  correlationId: string;
  projectId: string;
  rootPath: string;
  attachmentSealedRoot: string;
  launchContext?: RuntimeLaunchContext;
}

export interface RepositorySnapshotRequest {
  type: 'repository.get-snapshot';
  correlationId: string;
}

export interface BusinessWorkOrdersReadRequest {
  type: 'business.work-orders.read';
  correlationId: string;
  projectId: string;
  consumer: {
    name: string;
    major: number;
    minMinor: number;
    requiredFeatures: string[];
  };
  afterCursor: null | {
    journalSequence: number;
    lastBatchId: string | null;
    journalHash: string;
    projectionHash: string;
  };
  query: { kind: 'index'; limit?: number; afterKey?: string | null };
}

export interface RuntimeApprovalRespondRequest {
  type: 'runtime.approval.respond';
  correlationId: string;
  attentionId: string;
  requestId: string;
  decision: string;
  providerConnectionId: string;
}

export interface InspectionStartRequest {
  type: 'inspection.start';
  correlationId: string;
  projectId: string;
  rootPath: string;
  kind: InspectionKind;
  target: { kind: InspectionTargetUi['kind']; ids: string[] };
  focus: string | null;
}

export interface InspectionCancelRequest {
  type: 'inspection.cancel';
  correlationId: string;
  projectId: string;
  rootPath: string;
  runId: string;
}

export interface WorkflowCatalogReadRequest {
  type: 'workflow.catalog.read';
  correlationId: string;
  projectId: string;
  rootPath: string;
}

export interface WorkflowDefinitionSaveRequest {
  type: 'workflow.definition.save';
  correlationId: string;
  projectId: string;
  rootPath: string;
  workflowId: string | null;
  name: string;
  prompt: string;
  checks: WorkflowCheck[];
}

export interface WorkflowBatchStartRequest {
  type: 'workflow.batch.start';
  correlationId: string;
  projectId: string;
  rootPath: string;
  workflowId: string;
  repetitions: number;
}

export interface WorkflowBatchCancelRequest {
  type: 'workflow.batch.cancel';
  correlationId: string;
  projectId: string;
  rootPath: string;
  batchId: string;
}

export interface WorkflowResultReadRequest {
  type: 'workflow.result.read';
  correlationId: string;
  projectId: string;
  rootPath: string;
  batchId: string;
  attemptId: string;
}

export type CoreDispatchRequest = RuntimeSendRequest | RuntimeDispatchReconcileRequest | RuntimeTurnInterruptRequest | RuntimeTurnSteerRequest | RuntimeConversationRequest | RuntimeInfoRequest
  | ProjectBootstrapRequest
  | RepositorySelectRequest | RepositorySnapshotRequest
  | RuntimeApprovalRespondRequest
  | InspectionStartRequest | InspectionCancelRequest
  | WorkflowCatalogReadRequest | WorkflowDefinitionSaveRequest | WorkflowBatchStartRequest | WorkflowBatchCancelRequest | WorkflowResultReadRequest
  | BusinessWorkOrdersReadRequest;

export type CoreRequest =
  | { type: 'core.shutdown' }
  | RuntimeSendRequest
  | RuntimeDispatchReconcileRequest
  | RuntimeTurnInterruptRequest
  | RuntimeTurnSteerRequest
  | RuntimeConversationRequest
  | RuntimeInfoRequest
  | ProjectBootstrapRequest
  | RepositorySelectRequest
  | RepositorySnapshotRequest
  | RuntimeApprovalRespondRequest
  | InspectionStartRequest
  | InspectionCancelRequest
  | WorkflowCatalogReadRequest
  | WorkflowDefinitionSaveRequest
  | WorkflowBatchStartRequest
  | WorkflowBatchCancelRequest
  | WorkflowResultReadRequest
  | BusinessWorkOrdersReadRequest;

export type CoreEvent =
  | { type: 'core.ready'; version: 1 }
  | { type: 'runtime.dispatch.accepted'; correlationId: string; threadId: string; turnId: string; modelEvidence: RuntimeModelEvidence }
  | { type: 'runtime.turn.interrupt.accepted'; correlationId: string; targetAgentId: string; threadId: string; turnId: string }
  | { type: 'runtime.turn.steer.accepted'; correlationId: string; steerId: string; targetAgentId: string; threadId: string; turnId: string }
  | { type: 'runtime.request.failed'; correlationId: string; reason: string; retryable: boolean; errorCode?: string | null; outcomeUnknown?: boolean; details?: Record<string, unknown> | null }
  | { type: 'runtime.conversation.result'; correlationId: string; page: ConversationPage }
  | { type: 'runtime.info.result'; correlationId: string; info: RuntimeInfoUi }
  | { type: 'project.bootstrap.result'; correlationId: string; result: ProjectBootstrapResult }
  | { type: 'runtime.notification'; notification: RuntimeNotification }
  | { type: 'runtime.approval.requested'; approval: RuntimeApprovalRequest }
  | { type: 'runtime.approval.expired'; threadId: string; turnId: string }
  | { type: 'repository.snapshot.result'; correlationId: string; snapshot: OrquestaUiSnapshot }
  | { type: 'repository.snapshot.changed'; snapshot: OrquestaUiSnapshot }
  | {
      type: 'runtime.approval.accepted';
      correlationId: string;
      attentionId: string;
      requestId: string;
      providerConnectionId: string;
      decision: string;
    }
  | { type: 'business.work-orders.result'; correlationId: string; result: Record<string, unknown> }
  | { type: 'inspection.action.accepted'; correlationId: string; runId: string }
  | { type: 'workflow.catalog.result'; correlationId: string; catalog: WorkflowCatalog }
  | { type: 'workflow.catalog.changed'; catalog: WorkflowCatalog }
  | { type: 'workflow.action.result'; correlationId: string; workflowId: string | null; batchId: string | null }
  | { type: 'workflow.result.result'; correlationId: string; batchId: string; attemptId: string; output: string }
  | { type: 'core.stopped' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isCorrelationId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,128}$/u.test(value);
}

function isRuntimeLaunchContext(value: unknown): value is RuntimeLaunchContext {
  return isRecord(value)
    && ['argv', 'environment', 'e2e', 'standalone'].includes(String(value.source))
    && (value.callingThreadId === null || isSafeId(value.callingThreadId))
    && hasOnlyKeys(value, ['source', 'callingThreadId']);
}

function isBoundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
}

function isNullableBoundedText(value: unknown, maximum: number): value is string | null {
  return value === null || (typeof value === 'string' && value.trim().length > 0 && value.length <= maximum);
}

function isWorkflowCheck(value: unknown): value is WorkflowCheck {
  return isRecord(value)
    && (value.kind === 'contains' || value.kind === 'not_contains')
    && isBoundedText(value.text, 1_024)
    && typeof value.caseSensitive === 'boolean';
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isNullableProviderText(value: unknown, maximum: number): boolean {
  return value === null || typeof value === 'string' && value.length > 0
    && value.length <= maximum && !value.includes('\0');
}

function isProviderText(value: unknown, maximum: number, allowEmpty = false): boolean {
  return typeof value === 'string' && value.length <= maximum && !value.includes('\0')
    && (allowEmpty || value.length > 0);
}

function isNonNegativeSafeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isNullableNonNegativeSafeInteger(value: unknown): boolean {
  return value === null || isNonNegativeSafeInteger(value);
}

function activityStateMatches(eventType: string, state: unknown): boolean {
  if (state === 'unknown') return true;
  if (eventType.endsWith('.started')) return state === 'running';
  if (eventType.endsWith('.completed')) return state === 'completed';
  if (eventType.endsWith('.failed')) return state === 'failed' || state === 'declined';
  return state === 'running' || state === 'completed' || state === 'updated';
}

function isStructuredProviderActivity(eventType: string, payload: Record<string, unknown>, itemId: unknown): boolean {
  const kindByEvent: Record<string, string> = {
    'tool.started': 'tool', 'tool.completed': 'tool', 'tool.failed': 'tool',
    'command.started': 'command', 'command.completed': 'command', 'command.failed': 'command',
    'file.change.started': 'file_change', 'file.change.completed': 'file_change', 'file.change.failed': 'file_change',
    'diff.updated': 'diff', 'plan.updated': 'plan',
  };
  const kind = kindByEvent[eventType];
  if (!kind || payload.activity_kind !== kind || !activityStateMatches(eventType, payload.activity_state)
    || !isProviderText(payload.title, 4_096)) return false;
  const common = ['activity_kind', 'activity_state', 'title'];
  if (kind === 'command') {
    return hasOnlyKeys(payload, [...common, 'command_name', 'action_types', 'action_types_truncated', 'exit_code',
      'duration_ms', 'output_present', 'output_bytes', 'output_text', 'output_truncated', 'output_redacted',
      'cwd_omitted', 'command_arguments_omitted', 'content_omitted'])
      && isProviderText(payload.command_name, 256)
      && Array.isArray(payload.action_types) && payload.action_types.length <= 16
      && payload.action_types.every((entry) => isProviderText(entry, 256))
      && typeof payload.action_types_truncated === 'boolean'
      && (payload.exit_code === null || Number.isSafeInteger(payload.exit_code))
      && isNullableNonNegativeSafeInteger(payload.duration_ms)
      && typeof payload.output_present === 'boolean' && isNonNegativeSafeInteger(payload.output_bytes)
      && isNullableProviderText(payload.output_text, 16_384)
      && typeof payload.output_truncated === 'boolean' && typeof payload.output_redacted === 'boolean'
      && (payload.output_present ? typeof payload.output_text === 'string' : payload.output_text === null)
      && (payload.output_present || payload.output_bytes === 0)
      && payload.cwd_omitted === true && payload.command_arguments_omitted === true && payload.content_omitted === true;
  }
  if (kind === 'tool') {
    return hasOnlyKeys(payload, [...common, 'tool_kind', 'tool_name', 'tool_namespace', 'duration_ms', 'success',
      'arguments_omitted', 'result_omitted', 'content_omitted'])
      && ['mcpToolCall', 'dynamicToolCall', 'collabAgentToolCall', 'webSearch'].includes(String(payload.tool_kind))
      && isProviderText(payload.tool_name, 256) && isNullableProviderText(payload.tool_namespace, 256)
      && isNullableNonNegativeSafeInteger(payload.duration_ms)
      && (payload.success === null || typeof payload.success === 'boolean')
      && payload.arguments_omitted === true && payload.result_omitted === true && payload.content_omitted === true;
  }
  if (kind === 'file_change') {
    if (!hasOnlyKeys(payload, [...common, 'changes', 'change_count', 'changes_truncated', 'content_omitted'])
      || !Array.isArray(payload.changes) || payload.changes.length > 128
      || !isNonNegativeSafeInteger(payload.change_count) || typeof payload.changes_truncated !== 'boolean'
      || payload.content_omitted !== true) return false;
    if ((!payload.changes_truncated && payload.change_count !== payload.changes.length)
      || (payload.changes_truncated && Number(payload.change_count) <= payload.changes.length)) return false;
    return payload.changes.every((entry) => isRecord(entry)
      && hasOnlyKeys(entry, ['path', 'kind', 'original_bytes', 'added_lines', 'removed_lines'])
      && isProviderText(entry.path, 2_048) && isProviderText(entry.kind, 256)
      && isNonNegativeSafeInteger(entry.original_bytes) && isNonNegativeSafeInteger(entry.added_lines)
      && isNonNegativeSafeInteger(entry.removed_lines));
  }
  if (kind === 'diff') {
    return hasOnlyKeys(payload, [...common, 'original_bytes', 'added_lines', 'removed_lines', 'content_omitted'])
      && isNonNegativeSafeInteger(payload.original_bytes) && isNonNegativeSafeInteger(payload.added_lines)
      && isNonNegativeSafeInteger(payload.removed_lines) && payload.content_omitted === true;
  }
  if (itemId !== null) {
    return hasOnlyKeys(payload, [...common, 'text', 'original_bytes', 'truncated', 'redacted'])
      && isProviderText(payload.text, 16_384, true) && isNonNegativeSafeInteger(payload.original_bytes)
      && typeof payload.truncated === 'boolean' && typeof payload.redacted === 'boolean';
  }
  if (!hasOnlyKeys(payload, [...common, 'steps', 'step_count', 'steps_truncated', 'explanation',
    'explanation_truncated', 'explanation_redacted'])
    || !Array.isArray(payload.steps) || payload.steps.length > 64
    || !isNonNegativeSafeInteger(payload.step_count) || typeof payload.steps_truncated !== 'boolean'
    || !isNullableProviderText(payload.explanation, 4_096)
    || typeof payload.explanation_truncated !== 'boolean' || typeof payload.explanation_redacted !== 'boolean') return false;
  if ((!payload.steps_truncated && payload.step_count !== payload.steps.length)
    || (payload.steps_truncated && Number(payload.step_count) <= payload.steps.length)) return false;
  return payload.steps.every((entry) => isRecord(entry)
    && hasOnlyKeys(entry, ['status', 'text', 'truncated', 'redacted'])
    && ['pending', 'inProgress', 'completed'].includes(String(entry.status))
    && isProviderText(entry.text, 2_048, true)
    && typeof entry.truncated === 'boolean' && typeof entry.redacted === 'boolean');
}

function isPublicProviderEvent(value: unknown): boolean {
  if (!isRecord(value) || !isProviderText(value.provider_stream_id, 1_024)
    || !Number.isSafeInteger(value.provider_sequence) || Number(value.provider_sequence) < 1
    || !isProviderText(value.event_type, 128) || !isRecord(value.scope) || !isRecord(value.payload)) return false;
  const eventType = String(value.event_type);
  const scope = value.scope;
  if (!hasOnlyKeys(scope, ['thread_id', 'turn_id', 'item_id'])
    || !(scope.thread_id === null || isSafeId(scope.thread_id))
    || !(scope.turn_id === null || isSafeId(scope.turn_id))
    || !(scope.item_id === null || isSafeId(scope.item_id))) return false;
  const payload = value.payload;
  if (eventType === 'message.agent.delta') {
    return hasOnlyKeys(payload, ['item_id', 'delta'])
      && (payload.item_id === null || isSafeId(payload.item_id))
      && isProviderText(payload.delta, 64 * 1024);
  }
  if (['tool.started', 'tool.completed', 'tool.failed', 'command.started', 'command.completed', 'command.failed',
    'file.change.started', 'file.change.completed', 'file.change.failed', 'diff.updated', 'plan.updated'].includes(eventType)) {
    return isStructuredProviderActivity(eventType, payload, scope.item_id);
  }
  if (eventType === 'turn.started' || eventType === 'turn.completed') {
    return hasOnlyKeys(payload, ['turn_id', 'status', 'item_count', 'content_omitted'])
      && isNullableProviderText(payload.turn_id, 128) && isNullableProviderText(payload.status, 128)
      && isNullableNonNegativeSafeInteger(payload.item_count) && payload.content_omitted === true;
  }
  if (eventType === 'item.started' || eventType === 'item.completed') {
    return hasOnlyKeys(payload, ['item_id', 'item_type', 'item_status', 'content_omitted'])
      && (payload.item_id === null || isSafeId(payload.item_id))
      && isNullableProviderText(payload.item_type, 256) && isNullableProviderText(payload.item_status, 128)
      && payload.content_omitted === true;
  }
  if (eventType === 'provider.failure') {
    return hasOnlyKeys(payload, ['code', 'will_retry', 'message_present', 'message_sha256'])
      && (payload.code === null || Number.isSafeInteger(payload.code) || isProviderText(payload.code, 256))
      && (payload.will_retry === null || typeof payload.will_retry === 'boolean')
      && typeof payload.message_present === 'boolean'
      && (payload.message_sha256 === null || typeof payload.message_sha256 === 'string' && /^[a-f0-9]{64}$/u.test(payload.message_sha256));
  }
  if (eventType === 'model.observed') {
    return hasOnlyKeys(payload, ['from_model', 'to_model', 'reason_present'])
      && isNullableProviderText(payload.from_model, 256) && isNullableProviderText(payload.to_model, 256)
      && typeof payload.reason_present === 'boolean';
  }
  return false;
}

function isModelEvidence(value: unknown): value is RuntimeModelEvidence {
  if (!isRecord(value)) return false;
  return isNullableBoundedText(value.recommendedModel, 256)
    && isNullableBoundedText(value.requestedModel, 256)
    && isNullableBoundedText(value.appliedModel, 256)
    && isNullableBoundedText(value.actualModel, 256)
    && ['proven', 'reported', 'inferred', 'unknown'].includes(String(value.actualModelEvidence));
}

function isAttentionUiItem(value: unknown): value is AttentionUiItem {
  if (!isRecord(value)
    || !isSafeId(value.id)
    || !['user_question', 'user_task', 'user_action'].includes(String(value.sourceKind))
    || !['question', 'approval', 'report_review', 'repair', 'error', 'direction'].includes(String(value.type))
    || !['answer', 'approve', 'review', 'do'].includes(String(value.actionKind))
    || !['low', 'medium', 'high', 'blocker'].includes(String(value.priority))
    || !(value.sourceAgentId === null || isSafeId(value.sourceAgentId))
    || !(value.taskId === null || isSafeId(value.taskId))
    || typeof value.blocking !== 'boolean'
    || !isBoundedText(value.createdAt, 256)
    || !isNullableBoundedText(value.resolvedAt, 256)
    || !isNullableBoundedText(value.resolutionDecision, 256)) return false;
  return (value.runtimeApproval === null || value.runtimeApproval === undefined)
    && isBoundedText(value.title, 1_024)
    && isBoundedText(value.summary, 16_384);
}

function isRuntimeInfo(value: unknown): value is RuntimeInfoUi {
  if (!isRecord(value)) return false;
  return ['not_started', 'ready', 'unavailable'].includes(String(value.status))
    && value.adapter === 'app_server'
    && isNullableBoundedText(value.sdkVersion, 128)
    && isNullableBoundedText(value.codexVersion, 128)
    && isNullableBoundedText(value.runtimeVersion, 128)
    && isNullableBoundedText(value.targetTriple, 256)
    && isNullableBoundedText(value.platformFamily, 128)
    && isNullableBoundedText(value.platformOs, 128)
    && isNullableBoundedText(value.userAgent, 512)
    && isNullableBoundedText(value.providerConnectionId, 1_024)
    && ['verified', 'unverified', 'failed'].includes(String(value.integrity));
}

function isRepositorySnapshot(value: unknown): value is OrquestaUiSnapshot {
  if (!isRecord(value) || !isRecord(value.project)) return false;
  return isSafeId(value.project.id)
    && isBoundedText(value.project.title, 1_024)
    && (value.project.rootPathLabel === null || isBoundedText(value.project.rootPathLabel, 32_768))
    && ['ready', 'working', 'blocked', 'offline', 'unknown'].includes(String(value.project.status))
    && Array.isArray(value.agents)
    && Array.isArray(value.tasks)
    && Array.isArray(value.attention) && value.attention.every(isAttentionUiItem)
    && Array.isArray(value.phases)
    && Array.isArray(value.recentEvents)
    && Array.isArray(value.inspectionTemplates)
    && Array.isArray(value.inspectionRuns);
}

function isInspectionTarget(value: unknown): value is InspectionStartRequest['target'] {
  if (!isRecord(value) || !['project', 'line', 'team', 'agents'].includes(String(value.kind)) || !Array.isArray(value.ids)) return false;
  if (value.ids.length > 32 || !value.ids.every(isSafeId)) return false;
  if (value.kind === 'project') return value.ids.length === 0;
  if (value.kind === 'line' || value.kind === 'team') return value.ids.length === 1;
  return value.ids.length > 0;
}

function isProjectBootstrapResult(value: unknown): value is ProjectBootstrapResult {
  if (!isRecord(value)) return false;
  return ['ready', 'migration_required', 'unsupported', 'recovery_required'].includes(String(value.status))
    && typeof value.no_write === 'boolean'
    && (value.reason === null || isBoundedText(value.reason, 4_096))
    && (value.classification === undefined || value.classification === null
      || isBoundedText(value.classification, 128));
}

function isDispatchPrivateAttachment(value: unknown): value is DispatchPrivateAttachment {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'attachmentStoreHandle', 'kind', 'displayName', 'mediaType', 'sealedAbsolutePath', 'sizeBytes', 'sha256', 'encoding'
  ])) return false;
  if (!isBoundedText(value.attachmentStoreHandle, 256) || !isAttachmentDisplayName(value.displayName)
    || !isBoundedText(value.mediaType, 256) || !isBoundedText(value.sealedAbsolutePath, 32_768)
    || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256)
    || !Number.isSafeInteger(value.sizeBytes) || Number(value.sizeBytes) <= 0) return false;
  return isDispatchAttachmentWithinPolicy(value as unknown as DispatchPrivateAttachment);
}

function isBoundedUtf8Text(value: unknown, maximumBytes: number): value is string {
  return typeof value === 'string' && value.trim().length > 0
    && Buffer.byteLength(value, 'utf8') <= maximumBytes;
}

export function isCoreRequest(value: unknown): value is CoreRequest {
  if (!isRecord(value)) return false;
  if (value.type === 'core.shutdown') return true;
  if (value.type === 'runtime.send') {
    const hasDispatchIdentity = value.messageId !== undefined || value.actionFingerprint !== undefined
      || value.selectedContextIds !== undefined;
    const validDispatchIdentity = !hasDispatchIdentity || (
      isSafeId(value.messageId)
      && typeof value.actionFingerprint === 'string' && /^[a-f0-9]{64}$/u.test(value.actionFingerprint)
      && Array.isArray(value.selectedContextIds) && value.selectedContextIds.length <= 128
      && value.selectedContextIds.every(isSafeId)
    );
    return validDispatchIdentity && isCorrelationId(value.correlationId) && isSafeId(value.projectId) && isBoundedText(value.rootPath, 32_768)
      && (value.threadId === null || isSafeId(value.threadId)) && isSafeId(value.targetAgentId)
      && isBoundedUtf8Text(value.text, NATIVE_CONTENT_POLICY.message.maxUtf8Bytes)
      && Array.isArray(value.attachments) && value.attachments.length <= ATTACHMENTS_PER_DISPATCH
      && value.attachments.every(isDispatchPrivateAttachment)
      && new Set(value.attachments.map((attachment) => attachment.attachmentStoreHandle)).size === value.attachments.length
      && value.attachments.filter((attachment) => attachment.kind === 'text')
        .reduce((total, attachment) => total + attachment.sizeBytes, 0) <= ATTACHMENT_SOURCE_BYTES_PER_TURN
      && (value.effort === undefined || value.effort === null || ['low', 'medium', 'high'].includes(String(value.effort)));
  }
  if (value.type === 'runtime.dispatch.reconcile') {
    return isCorrelationId(value.correlationId) && isSafeId(value.projectId) && isBoundedText(value.rootPath, 32_768)
      && isSafeId(value.messageId) && typeof value.actionFingerprint === 'string'
      && /^[a-f0-9]{64}$/u.test(value.actionFingerprint);
  }
  if (value.type === 'runtime.turn.interrupt') {
    return isCorrelationId(value.correlationId) && isSafeId(value.projectId)
      && isBoundedText(value.rootPath, 32_768) && isSafeId(value.targetAgentId)
      && isSafeId(value.threadId) && isSafeId(value.turnId);
  }
  if (value.type === 'runtime.turn.steer') {
    return isCorrelationId(value.correlationId) && isSafeId(value.steerId)
      && isSafeId(value.projectId) && isBoundedText(value.rootPath, 32_768)
      && isSafeId(value.targetAgentId) && isSafeId(value.threadId) && isSafeId(value.turnId)
      && isBoundedUtf8Text(value.text, NATIVE_CONTENT_POLICY.message.maxUtf8Bytes);
  }
  if (value.type === 'runtime.conversation') {
    return isCorrelationId(value.correlationId) && isSafeId(value.projectId)
      && isBoundedText(value.rootPath, 32_768) && isSafeId(value.targetAgentId)
      && (value.cursor === undefined || value.cursor === null || (typeof value.cursor === 'string'
        && value.cursor.length > 0 && value.cursor.length <= 4_096 && !/[\r\n]/u.test(value.cursor)))
      && typeof value.limit === 'number' && Number.isInteger(value.limit) && value.limit >= 1 && value.limit <= 200
      && (value.includeStructuredActivities === undefined || typeof value.includeStructuredActivities === 'boolean');
  }
  if (value.type === 'runtime.info') {
    return isCorrelationId(value.correlationId) && typeof value.probe === 'boolean';
  }
  if (value.type === 'project.bootstrap') {
    return hasOnlyKeys(value, ['type', 'correlationId']) && isCorrelationId(value.correlationId);
  }
  if (value.type === 'repository.select') {
    return hasOnlyKeys(value, ['type', 'correlationId', 'projectId', 'rootPath', 'attachmentSealedRoot', 'launchContext'])
      && isCorrelationId(value.correlationId) && isSafeId(value.projectId) && isBoundedText(value.rootPath, 32_768)
      && isBoundedText(value.attachmentSealedRoot, 32_768)
      && (value.launchContext === undefined || isRuntimeLaunchContext(value.launchContext));
  }
  if (value.type === 'repository.get-snapshot') {
    return isCorrelationId(value.correlationId);
  }
  if (value.type === 'business.work-orders.read') {
    const consumer = isRecord(value.consumer) ? value.consumer : null;
    const cursor = value.afterCursor === null
      ? null
      : isRecord(value.afterCursor) ? value.afterCursor : undefined;
    const query = isRecord(value.query) ? value.query : null;
    const validCursor = cursor !== undefined && (cursor === null || (
      Number.isSafeInteger(cursor.journalSequence) && Number(cursor.journalSequence) >= 0
      && (cursor.lastBatchId === null || isSafeId(cursor.lastBatchId))
      && typeof cursor.journalHash === 'string' && /^[a-f0-9]{64}$/u.test(cursor.journalHash)
      && typeof cursor.projectionHash === 'string' && /^[a-f0-9]{64}$/u.test(cursor.projectionHash)
    ));
    return !Object.hasOwn(value, 'rootPath')
      && isCorrelationId(value.correlationId) && isSafeId(value.projectId)
      && Boolean(consumer && isBoundedText(consumer.name, 128)
        && consumer.major === 1
        && Number.isSafeInteger(consumer.minMinor) && Number(consumer.minMinor) >= 0
        && Array.isArray(consumer.requiredFeatures)
        && consumer.requiredFeatures.length <= 32
        && consumer.requiredFeatures.every((feature) => isBoundedText(feature, 128)))
      && validCursor
      && Boolean(query && query.kind === 'index'
        && (query.limit === undefined || (Number.isSafeInteger(query.limit)
          && Number(query.limit) >= 1 && Number(query.limit) <= 25))
        && (query.afterKey === undefined || query.afterKey === null || isSafeId(query.afterKey)));
  }
  if (value.type === 'runtime.approval.respond') {
    return isCorrelationId(value.correlationId) && isSafeId(value.attentionId)
      && isSafeId(value.requestId) && isBoundedText(value.decision, 128)
      && isSafeId(value.providerConnectionId);
  }
  if (value.type === 'inspection.start') {
    return isCorrelationId(value.correlationId) && isSafeId(value.projectId) && isBoundedText(value.rootPath, 32_768)
      && ['external_benchmark', 'adversarial_audit'].includes(String(value.kind))
      && isInspectionTarget(value.target) && isNullableBoundedText(value.focus, 4_096);
  }
  if (value.type === 'inspection.cancel') {
    return isCorrelationId(value.correlationId) && isSafeId(value.projectId) && isBoundedText(value.rootPath, 32_768)
      && isSafeId(value.runId);
  }
  if (value.type === 'workflow.catalog.read') {
    return isCorrelationId(value.correlationId) && isSafeId(value.projectId) && isBoundedText(value.rootPath, 32_768);
  }
  if (value.type === 'workflow.definition.save') {
    return isCorrelationId(value.correlationId) && isSafeId(value.projectId) && isBoundedText(value.rootPath, 32_768)
      && (value.workflowId === null || isSafeId(value.workflowId))
      && isBoundedText(value.name, 256) && isBoundedText(value.prompt, 65_536)
      && Array.isArray(value.checks) && value.checks.length <= 16 && value.checks.every(isWorkflowCheck);
  }
  if (value.type === 'workflow.batch.start') {
    return isCorrelationId(value.correlationId) && isSafeId(value.projectId) && isBoundedText(value.rootPath, 32_768)
      && isSafeId(value.workflowId) && Number.isInteger(value.repetitions)
      && Number(value.repetitions) >= 1 && Number(value.repetitions) <= 50;
  }
  if (value.type === 'workflow.batch.cancel') {
    return isCorrelationId(value.correlationId) && isSafeId(value.projectId) && isBoundedText(value.rootPath, 32_768)
      && isSafeId(value.batchId);
  }
  if (value.type === 'workflow.result.read') {
    return isCorrelationId(value.correlationId) && isSafeId(value.projectId) && isBoundedText(value.rootPath, 32_768)
      && isSafeId(value.batchId) && isSafeId(value.attemptId);
  }
  return false;
}

export function isCoreEvent(value: unknown): value is CoreEvent {
  if (!isRecord(value)) return false;
  if (value.type === 'core.ready') return value.version === 1;
  if (value.type === 'runtime.dispatch.accepted') {
    return isCorrelationId(value.correlationId) && isSafeId(value.threadId) && isSafeId(value.turnId)
      && isModelEvidence(value.modelEvidence);
  }
  if (value.type === 'runtime.request.failed') {
    const details = value.details;
    const validDetails = details === undefined || details === null || isRecord(details);
    return validDetails && isCorrelationId(value.correlationId) && isBoundedText(value.reason, 4_096)
      && typeof value.retryable === 'boolean'
      && (value.errorCode === undefined || value.errorCode === null || isSafeId(value.errorCode))
      && (value.outcomeUnknown === undefined || typeof value.outcomeUnknown === 'boolean');
  }
  if (value.type === 'runtime.conversation.result') {
    if (!isCorrelationId(value.correlationId) || !isRecord(value.page)
      || !Array.isArray(value.page.items) || value.page.items.length > 200
      || !(value.page.nextCursor === null || isBoundedText(value.page.nextCursor, 4_096))) return false;
    if (value.page.structuredActivitiesComplete !== undefined
      && typeof value.page.structuredActivitiesComplete !== 'boolean') return false;
    if (value.page.activities === undefined) return true;
    if (!Array.isArray(value.page.activities) || value.page.activities.length > 1_000) return false;
    const eventTypes = new Set([
      'tool.started', 'tool.completed', 'tool.failed',
      'command.started', 'command.completed', 'command.failed',
      'file.change.started', 'file.change.completed', 'file.change.failed',
      'diff.updated', 'plan.updated'
    ]);
    return value.page.activities.every((activity) => isRecord(activity)
      && eventTypes.has(String(activity.eventType))
      && isSafeId(activity.threadId) && isSafeId(activity.turnId)
      && (activity.itemId === null || isSafeId(activity.itemId))
      && isSafeId(activity.targetAgentId)
      && isBoundedText(activity.occurredAt, 128)
      && isRecord(activity.payload));
  }
  if (value.type === 'runtime.info.result') {
    return isCorrelationId(value.correlationId) && isRuntimeInfo(value.info);
  }
  if (value.type === 'workflow.catalog.result') {
    return isCorrelationId(value.correlationId) && isRecord(value.catalog)
      && value.catalog.version === 1 && Array.isArray(value.catalog.definitions) && Array.isArray(value.catalog.batches);
  }
  if (value.type === 'workflow.catalog.changed') {
    return isRecord(value.catalog) && value.catalog.version === 1
      && Array.isArray(value.catalog.definitions) && Array.isArray(value.catalog.batches);
  }
  if (value.type === 'workflow.action.result') {
    return isCorrelationId(value.correlationId)
      && (value.workflowId === null || isSafeId(value.workflowId))
      && (value.batchId === null || isSafeId(value.batchId));
  }
  if (value.type === 'workflow.result.result') {
    return isCorrelationId(value.correlationId) && isSafeId(value.batchId) && isSafeId(value.attemptId)
      && isBoundedText(value.output, 1_048_576);
  }
  if (value.type === 'project.bootstrap.result') {
    return isCorrelationId(value.correlationId) && isProjectBootstrapResult(value.result);
  }
  if (value.type === 'runtime.notification') {
    const notification = isRecord(value.notification) ? value.notification : null;
    const kind = String(notification?.kind ?? '');
    if (kind === 'provider_connection') {
      return Boolean(notification && isSafeId(notification.providerConnectionId)
        && hasOnlyKeys(notification, ['kind', 'providerConnectionId', 'state'])
        && ['connected', 'disconnected'].includes(String(notification.state)));
    }
    const providerEventValid = kind !== 'provider_event'
      || isPublicProviderEvent(notification?.providerEvent);
    return Boolean(notification && [
      'turn_started', 'turn_completed', 'turn_failed', 'agent_message',
      'model_observed', 'provider_event'
    ].includes(kind)
      && (notification.correlationId === undefined || notification.correlationId === null || isCorrelationId(notification.correlationId))
      && isSafeId(notification.threadId) && (notification.turnId === null || isSafeId(notification.turnId))
      && (notification.text === null || typeof notification.text === 'string')
      && (notification.targetAgentId === null || isSafeId(notification.targetAgentId))
      && (notification.itemId === undefined || notification.itemId === null || isSafeId(notification.itemId))
      && (notification.occurredAt === undefined || notification.occurredAt === null || typeof notification.occurredAt === 'string')
      && providerEventValid
      && isModelEvidence(notification.modelEvidence));
  }
  if (value.type === 'runtime.turn.interrupt.accepted') {
    return isCorrelationId(value.correlationId) && isSafeId(value.targetAgentId)
      && isSafeId(value.threadId) && isSafeId(value.turnId);
  }
  if (value.type === 'runtime.turn.steer.accepted') {
    return isCorrelationId(value.correlationId) && isSafeId(value.steerId)
      && isSafeId(value.targetAgentId) && isSafeId(value.threadId) && isSafeId(value.turnId);
  }
  if (value.type === 'runtime.approval.requested') {
    const approval = isRecord(value.approval) ? value.approval : null;
    const requestedEffect = isRecord(approval?.requestedEffect) ? approval.requestedEffect : null;
    return Boolean(approval && isSafeId(approval.projectId) && isCorrelationId(approval.correlationId)
      && isSafeId(approval.requestId) && isSafeId(approval.providerConnectionId)
      && isBoundedText(approval.method, 256)
      && isSafeId(approval.threadId) && isSafeId(approval.turnId)
      && (approval.targetAgentId === null || isSafeId(approval.targetAgentId))
      && requestedEffect && isBoundedText(requestedEffect.kind, 256) && isSafeId(requestedEffect.itemId)
      && (approval.reason === null || isBoundedText(approval.reason, 16_384))
      && Array.isArray(approval.responseOptions) && approval.responseOptions.length > 0
      && approval.responseOptions.every((option) => isBoundedText(option, 128))
      && isBoundedText(approval.actionFingerprint, 128));
  }
  if (value.type === 'runtime.approval.expired') {
    return isSafeId(value.threadId) && isSafeId(value.turnId);
  }
  if (value.type === 'repository.snapshot.result') {
    return isCorrelationId(value.correlationId) && isRepositorySnapshot(value.snapshot);
  }
  if (value.type === 'repository.snapshot.changed') return isRepositorySnapshot(value.snapshot);
  if (value.type === 'runtime.approval.accepted') {
    return isCorrelationId(value.correlationId) && isSafeId(value.attentionId)
      && isSafeId(value.requestId) && isSafeId(value.providerConnectionId)
      && isBoundedText(value.decision, 128);
  }
  if (value.type === 'business.work-orders.result') {
    return isCorrelationId(value.correlationId) && isRecord(value.result);
  }
  if (value.type === 'inspection.action.accepted') {
    return isCorrelationId(value.correlationId) && isSafeId(value.runId);
  }
  return value.type === 'core.stopped';
}
