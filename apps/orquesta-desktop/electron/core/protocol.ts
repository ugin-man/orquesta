import type { ConversationPage, RuntimeInfoUi } from '../../src/contracts/bridge';
import { isV4OperationsSnapshot, type AttentionUiItem, type InspectionKind, type InspectionTargetUi, type OrquestaUiSnapshot } from '../../src/contracts/orquesta-ui';
import { isSetupAccountState, isSetupDraft, isSetupProgressEvent, type SetupAccountState, type SetupDraft, type SetupLoginStartResult, type SetupProgressEvent, type SetupStartResult } from '../../src/contracts/setup';

export interface RuntimeModelEvidence {
  recommendedModel: string | null;
  requestedModel: string | null;
  appliedModel: string | null;
  actualModel: string | null;
  actualModelEvidence: 'proven' | 'reported' | 'inferred' | 'unknown';
}

export interface RuntimeNotification {
  kind: 'turn_started' | 'turn_completed' | 'turn_failed' | 'agent_message' | 'model_observed';
  correlationId?: string | null;
  threadId: string;
  turnId: string | null;
  text: string | null;
  targetAgentId: string | null;
  modelEvidence: RuntimeModelEvidence;
}

export interface RuntimeApprovalRequest {
  projectId: string;
  correlationId: string;
  requestId: string;
  method: string;
  threadId: string;
  turnId: string;
  reason: string | null;
  responseOptions: string[];
}

export interface RuntimeSendRequest {
  type: 'runtime.send';
  correlationId: string;
  projectId: string;
  rootPath: string;
  threadId: string | null;
  targetAgentId: string;
  text: string;
  localImagePaths: string[];
  recommendedModel?: string | null;
  requestedModel?: string | null;
}

export interface RuntimeLucaSendRequest {
  type: 'runtime.luca.send';
  correlationId: string;
  projectId: string;
  rootPath: string;
  threadId: string | null;
  prompt: string;
}

export interface RuntimeConversationRequest {
  type: 'runtime.conversation';
  correlationId: string;
  projectId: string;
  rootPath: string;
  targetAgentId: string;
  cursor?: string | null;
  limit: number;
}

export interface RuntimeInfoRequest {
  type: 'runtime.info';
  correlationId: string;
  probe: boolean;
}

export interface SetupAccountReadRequest {
  type: 'setup.account.read';
  correlationId: string;
}

export interface SetupAccountLoginStartRequest {
  type: 'setup.account.login.start';
  correlationId: string;
}

export interface RuntimeLaunchContext {
  source: 'argv' | 'environment' | 'e2e' | 'standalone';
  callingThreadId: string | null;
  legacyMigration?: boolean;
}

export interface SetupStartRequest {
  type: 'setup.start';
  correlationId: string;
  rootPath: string;
  draft: SetupDraft;
  launchContext?: RuntimeLaunchContext;
}

export interface RepositorySelectRequest {
  type: 'repository.select';
  correlationId: string;
  projectId: string;
  rootPath: string;
  launchContext?: RuntimeLaunchContext;
}

export interface RepositorySnapshotRequest {
  type: 'repository.get-snapshot';
  correlationId: string;
}

export interface RepositoryCloseRequest {
  type: 'repository.close';
  correlationId: string;
}

export interface RuntimeApprovalRespondRequest {
  type: 'runtime.approval.respond';
  correlationId: string;
  attentionId: string;
  decision: string;
}

export interface RepositoryAttentionHistoryRequest {
  type: 'repository.attention-history';
  correlationId: string;
}

export interface OrganizationMigrationLine {
  line_id: string;
  display_name: string;
  goal: string;
  deliverable_ids: string[];
  completion_root_ids: string[];
  scope: string[];
  owner_agent_id: string;
  dedicated_lead_agent_id: string | null;
  status: 'active' | 'paused' | 'retired';
  approval_source: 'setup_confirmation' | 'user_approval';
}

export interface OrganizationMigrationTeam {
  team_id: string;
  line_id: string;
  display_name: string;
  purpose: string;
  lifecycle_state: 'active' | 'retired';
}

export interface OrganizationMigrationAssignment {
  agent_id: string;
  team_id: string;
  position: 'lead' | 'member';
  ordinal: number;
}

export interface OrganizationMigrationReadRequest {
  type: 'organization.migration.read';
  correlationId: string;
  projectId: string;
  rootPath: string;
}

export interface OrganizationMigrationApplyRequest {
  type: 'organization.migration.apply';
  correlationId: string;
  projectId: string;
  rootPath: string;
  expectedRevision: number;
  lines: OrganizationMigrationLine[];
  teams: OrganizationMigrationTeam[];
  assignments: OrganizationMigrationAssignment[];
}

export interface OrganizationMigrationResult {
  status: 'not_applicable' | 'current' | 'review_required' | 'complete';
  revision: number;
  unassignedProductionAgentIds: string[];
  diagnostics: unknown[];
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

export interface InspectionReadReportRequest {
  type: 'inspection.read-report';
  correlationId: string;
  projectId: string;
  rootPath: string;
  runId: string;
}

export type CoreDispatchRequest = RuntimeSendRequest | RuntimeLucaSendRequest | RuntimeConversationRequest | RuntimeInfoRequest
  | SetupAccountReadRequest | SetupAccountLoginStartRequest | SetupStartRequest
  | RepositorySelectRequest | RepositorySnapshotRequest | RepositoryCloseRequest
  | RuntimeApprovalRespondRequest | RepositoryAttentionHistoryRequest
  | InspectionStartRequest | InspectionCancelRequest | InspectionReadReportRequest
  | OrganizationMigrationReadRequest | OrganizationMigrationApplyRequest;

export type CoreRequest =
  | { type: 'core.shutdown' }
  | { type: 'core.ping'; correlationId: string }
  | RuntimeSendRequest
  | RuntimeLucaSendRequest
  | RuntimeConversationRequest
  | RuntimeInfoRequest
  | SetupAccountReadRequest
  | SetupAccountLoginStartRequest
  | SetupStartRequest
  | RepositorySelectRequest
  | RepositorySnapshotRequest
  | RepositoryCloseRequest
  | RuntimeApprovalRespondRequest
  | RepositoryAttentionHistoryRequest
  | InspectionStartRequest
  | InspectionCancelRequest
  | InspectionReadReportRequest
  | OrganizationMigrationReadRequest
  | OrganizationMigrationApplyRequest;

export type CoreEvent =
  | { type: 'core.ready'; version: 1 }
  | { type: 'core.pong'; correlationId: string }
  | { type: 'runtime.dispatch.accepted'; correlationId: string; threadId: string; turnId: string; modelEvidence: RuntimeModelEvidence }
  | { type: 'runtime.request.failed'; correlationId: string; reason: string; retryable: boolean }
  | { type: 'runtime.conversation.result'; correlationId: string; page: ConversationPage }
  | { type: 'runtime.info.result'; correlationId: string; info: RuntimeInfoUi }
  | { type: 'setup.account.result'; correlationId: string; account: SetupAccountState }
  | { type: 'setup.account.login.started'; correlationId: string; login: SetupLoginStartResult }
  | { type: 'setup.start.result'; correlationId: string; result: SetupStartResult }
  | { type: 'setup.progress'; progress: SetupProgressEvent }
  | { type: 'runtime.notification'; notification: RuntimeNotification }
  | { type: 'repository.snapshot.result'; correlationId: string; snapshot: OrquestaUiSnapshot }
  | { type: 'repository.snapshot.changed'; snapshot: OrquestaUiSnapshot }
  | { type: 'runtime.approval.accepted'; correlationId: string; attentionId: string; decision: string }
  | { type: 'repository.attention-history.result'; correlationId: string; items: AttentionUiItem[] }
  | { type: 'inspection.action.accepted'; correlationId: string; runId: string }
  | { type: 'inspection.report.result'; correlationId: string; runId: string; markdown: string }
  | { type: 'organization.migration.result'; correlationId: string; result: OrganizationMigrationResult }
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
    && (value.legacyMigration === undefined || typeof value.legacyMigration === 'boolean');
}

function isBoundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
}

function isNullableBoundedText(value: unknown, maximum: number): value is string | null {
  return value === null || (typeof value === 'string' && value.trim().length > 0 && value.length <= maximum);
}

function isBoundedStringArray(value: unknown, maximumItems: number, maximumLength: number): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= maximumItems
    && value.every((item) => isBoundedText(item, maximumLength));
}

function isMigrationLine(value: unknown): value is OrganizationMigrationLine {
  if (!isRecord(value)) return false;
  return isSafeId(value.line_id)
    && isBoundedText(value.display_name, 1_024)
    && isBoundedText(value.goal, 8_192)
    && isBoundedStringArray(value.deliverable_ids, 128, 256)
    && isBoundedStringArray(value.completion_root_ids, 256, 256)
    && isBoundedStringArray(value.scope, 128, 32_768)
    && isSafeId(value.owner_agent_id)
    && (value.dedicated_lead_agent_id === null || isSafeId(value.dedicated_lead_agent_id))
    && ['active', 'paused', 'retired'].includes(String(value.status))
    && ['setup_confirmation', 'user_approval'].includes(String(value.approval_source));
}

function isMigrationTeam(value: unknown): value is OrganizationMigrationTeam {
  if (!isRecord(value)) return false;
  return isSafeId(value.team_id)
    && isSafeId(value.line_id)
    && isBoundedText(value.display_name, 1_024)
    && isBoundedText(value.purpose, 8_192)
    && ['active', 'retired'].includes(String(value.lifecycle_state));
}

function isMigrationAssignment(value: unknown): value is OrganizationMigrationAssignment {
  if (!isRecord(value)) return false;
  return isSafeId(value.agent_id)
    && isSafeId(value.team_id)
    && ['lead', 'member'].includes(String(value.position))
    && Number.isInteger(value.ordinal)
    && Number(value.ordinal) >= 1
    && Number(value.ordinal) <= 1_024;
}

function isMigrationResult(value: unknown): value is OrganizationMigrationResult {
  if (!isRecord(value)) return false;
  return ['not_applicable', 'current', 'review_required', 'complete'].includes(String(value.status))
    && Number.isInteger(value.revision) && Number(value.revision) >= 0
    && Array.isArray(value.unassignedProductionAgentIds)
    && value.unassignedProductionAgentIds.length <= 512
    && value.unassignedProductionAgentIds.every(isSafeId)
    && Array.isArray(value.diagnostics)
    && value.diagnostics.length <= 512;
}

function isModelEvidence(value: unknown): value is RuntimeModelEvidence {
  if (!isRecord(value)) return false;
  return isNullableBoundedText(value.recommendedModel, 256)
    && isNullableBoundedText(value.requestedModel, 256)
    && isNullableBoundedText(value.appliedModel, 256)
    && isNullableBoundedText(value.actualModel, 256)
    && ['proven', 'reported', 'inferred', 'unknown'].includes(String(value.actualModelEvidence));
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
    && Array.isArray(value.attention)
    && Array.isArray(value.phases)
    && Array.isArray(value.recentEvents)
    && Array.isArray(value.inspectionTemplates)
    && Array.isArray(value.inspectionRuns)
    && isV4OperationsSnapshot(value.v4Operations);
}

function isInspectionTarget(value: unknown): value is InspectionStartRequest['target'] {
  if (!isRecord(value) || !['project', 'line', 'team', 'agents'].includes(String(value.kind)) || !Array.isArray(value.ids)) return false;
  if (value.ids.length > 32 || !value.ids.every(isSafeId)) return false;
  if (value.kind === 'project') return value.ids.length === 0;
  if (value.kind === 'line' || value.kind === 'team') return value.ids.length === 1;
  return value.ids.length > 0;
}

function isSetupLoginStartResult(value: unknown): value is SetupLoginStartResult {
  if (!isRecord(value)) return false;
  return ['chatgpt', 'chatgpt_device_code'].includes(String(value.type))
    && isSafeId(value.loginId)
    && (value.authUrl === null || isBoundedText(value.authUrl, 2_048));
}

function isSetupStartResult(value: unknown): value is SetupStartResult {
  if (!isRecord(value)) return false;
  return isSafeId(value.setupId)
    && isBoundedText(value.rootPath, 32_768)
    && ['environment', 'understanding', 'foundation', 'planning', 'specialists', 'operation'].includes(String(value.activePhaseId));
}

export function isCoreRequest(value: unknown): value is CoreRequest {
  if (!isRecord(value)) return false;
  if (value.type === 'core.shutdown') return true;
  if (value.type === 'core.ping') return isCorrelationId(value.correlationId);
  if (value.type === 'runtime.send') {
    return isCorrelationId(value.correlationId) && isSafeId(value.projectId) && isBoundedText(value.rootPath, 32_768)
      && (value.threadId === null || isSafeId(value.threadId)) && isSafeId(value.targetAgentId) && isBoundedText(value.text, 65_536)
      && Array.isArray(value.localImagePaths) && value.localImagePaths.length <= 4
      && value.localImagePaths.every((filePath) => isBoundedText(filePath, 32_768));
  }
  if (value.type === 'runtime.luca.send') {
    return isCorrelationId(value.correlationId) && isSafeId(value.projectId) && isBoundedText(value.rootPath, 32_768)
      && (value.threadId === null || isSafeId(value.threadId)) && isBoundedText(value.prompt, 65_536);
  }
  if (value.type === 'runtime.conversation') {
    return isCorrelationId(value.correlationId) && isSafeId(value.projectId)
      && isBoundedText(value.rootPath, 32_768) && isSafeId(value.targetAgentId)
      && (value.cursor === undefined || value.cursor === null || (typeof value.cursor === 'string'
        && value.cursor.length > 0 && value.cursor.length <= 4_096 && !/[\r\n]/u.test(value.cursor)))
      && typeof value.limit === 'number' && Number.isInteger(value.limit) && value.limit >= 1 && value.limit <= 200;
  }
  if (value.type === 'runtime.info') {
    return isCorrelationId(value.correlationId) && typeof value.probe === 'boolean';
  }
  if (value.type === 'setup.account.read' || value.type === 'setup.account.login.start') {
    return isCorrelationId(value.correlationId);
  }
  if (value.type === 'setup.start') {
    const launchContext = value.launchContext;
    const validLaunchContext = launchContext === undefined || isRuntimeLaunchContext(launchContext);
    return isCorrelationId(value.correlationId) && isBoundedText(value.rootPath, 32_768)
      && isSetupDraft(value.draft) && validLaunchContext;
  }
  if (value.type === 'repository.select') {
    return isCorrelationId(value.correlationId) && isSafeId(value.projectId) && isBoundedText(value.rootPath, 32_768)
      && (value.launchContext === undefined || isRuntimeLaunchContext(value.launchContext));
  }
  if (value.type === 'repository.get-snapshot' || value.type === 'repository.close') {
    return isCorrelationId(value.correlationId);
  }
  if (value.type === 'runtime.approval.respond') {
    return isCorrelationId(value.correlationId) && isSafeId(value.attentionId) && isBoundedText(value.decision, 128);
  }
  if (value.type === 'repository.attention-history') return isCorrelationId(value.correlationId);
  if (value.type === 'organization.migration.read') {
    return isCorrelationId(value.correlationId) && isSafeId(value.projectId) && isBoundedText(value.rootPath, 32_768);
  }
  if (value.type === 'organization.migration.apply') {
    return isCorrelationId(value.correlationId) && isSafeId(value.projectId) && isBoundedText(value.rootPath, 32_768)
      && typeof value.expectedRevision === 'number' && Number.isInteger(value.expectedRevision) && value.expectedRevision >= 0
      && Array.isArray(value.lines) && value.lines.length <= 64 && value.lines.every(isMigrationLine)
      && Array.isArray(value.teams) && value.teams.length <= 128 && value.teams.every(isMigrationTeam)
      && Array.isArray(value.assignments) && value.assignments.length <= 512
      && value.assignments.every(isMigrationAssignment);
  }
  if (value.type === 'inspection.start') {
    return isCorrelationId(value.correlationId) && isSafeId(value.projectId) && isBoundedText(value.rootPath, 32_768)
      && ['external_benchmark', 'adversarial_audit'].includes(String(value.kind))
      && isInspectionTarget(value.target) && isNullableBoundedText(value.focus, 4_096);
  }
  if (value.type === 'inspection.cancel' || value.type === 'inspection.read-report') {
    return isCorrelationId(value.correlationId) && isSafeId(value.projectId) && isBoundedText(value.rootPath, 32_768)
      && isSafeId(value.runId);
  }
  return false;
}

export function isCoreEvent(value: unknown): value is CoreEvent {
  if (!isRecord(value)) return false;
  if (value.type === 'core.ready') return value.version === 1;
  if (value.type === 'core.pong') return isCorrelationId(value.correlationId);
  if (value.type === 'runtime.dispatch.accepted') {
    return isCorrelationId(value.correlationId) && isSafeId(value.threadId) && isSafeId(value.turnId)
      && isModelEvidence(value.modelEvidence);
  }
  if (value.type === 'runtime.request.failed') {
    return isCorrelationId(value.correlationId) && isBoundedText(value.reason, 4_096) && typeof value.retryable === 'boolean';
  }
  if (value.type === 'runtime.conversation.result') {
    return isCorrelationId(value.correlationId) && isRecord(value.page) && Array.isArray(value.page.items);
  }
  if (value.type === 'runtime.info.result') {
    return isCorrelationId(value.correlationId) && isRuntimeInfo(value.info);
  }
  if (value.type === 'setup.account.result') {
    return isCorrelationId(value.correlationId) && isSetupAccountState(value.account);
  }
  if (value.type === 'setup.account.login.started') {
    return isCorrelationId(value.correlationId) && isSetupLoginStartResult(value.login);
  }
  if (value.type === 'setup.start.result') {
    return isCorrelationId(value.correlationId) && isSetupStartResult(value.result);
  }
  if (value.type === 'setup.progress') return isSetupProgressEvent(value.progress);
  if (value.type === 'runtime.notification') {
    const notification = isRecord(value.notification) ? value.notification : null;
    return Boolean(notification && ['turn_started', 'turn_completed', 'turn_failed', 'agent_message', 'model_observed'].includes(String(notification.kind))
      && (notification.correlationId === undefined || notification.correlationId === null || isCorrelationId(notification.correlationId))
      && isSafeId(notification.threadId) && (notification.turnId === null || isSafeId(notification.turnId))
      && (notification.text === null || typeof notification.text === 'string')
      && (notification.targetAgentId === null || isSafeId(notification.targetAgentId))
      && isModelEvidence(notification.modelEvidence));
  }
  if (value.type === 'repository.snapshot.result') {
    return isCorrelationId(value.correlationId) && isRepositorySnapshot(value.snapshot);
  }
  if (value.type === 'repository.snapshot.changed') return isRepositorySnapshot(value.snapshot);
  if (value.type === 'runtime.approval.accepted') {
    return isCorrelationId(value.correlationId) && isSafeId(value.attentionId) && isBoundedText(value.decision, 128);
  }
  if (value.type === 'repository.attention-history.result') {
    return isCorrelationId(value.correlationId) && Array.isArray(value.items);
  }
  if (value.type === 'inspection.action.accepted') {
    return isCorrelationId(value.correlationId) && isSafeId(value.runId);
  }
  if (value.type === 'inspection.report.result') {
    return isCorrelationId(value.correlationId) && isSafeId(value.runId) && isBoundedText(value.markdown, 1_048_576);
  }
  if (value.type === 'organization.migration.result') {
    return isCorrelationId(value.correlationId) && isMigrationResult(value.result);
  }
  return value.type === 'core.stopped';
}
