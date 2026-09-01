import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import * as canonicalAdapterModule from '@orquesta/codex-adapter';
import type { ConversationActivityBackfillRecord, ConversationMessage, ConversationPage, RuntimeInfoUi } from '../contracts/bridge';
import type { AgentSessionGeneration, ProjectCodexThread } from './session-binding-resolver';
import type { LucaAnswerPayload } from '../contracts/luca';
import type { InspectionKind } from '../contracts/orquesta-ui';
import { LUCA_TARGET_AGENT_ID } from '../shared/luca-runtime-profile';
import {
  MessageLedger,
  type MessageDeliveryRecord,
  type MessageDeliveryState,
  type MessageLedgerWriter,
  migrateLegacyMessageLedger,
  type LegacyMessageLedgerMigrationResult
} from './message-ledger-v2';
import {
  isCoreEvent,
  RUNTIME_APPROVAL_RETENTION_LIMIT,
  type RuntimeApprovalRequest,
  type RuntimeModelEvidence,
  type RuntimeNotification as DesktopRuntimeNotification
} from './protocol';
import type { InspectionRuntimeBoundary } from './inspection-run-store';
import { resolveDesktopSdkPackageRoot } from './runtime-location';
import { verifyDesktopRuntimeIntegrity } from './runtime-integrity';
import { portableJoin } from '../shared/portable-path';
import {
  AttachmentCapabilityBroker,
  attachmentToolDefinition,
  providerAttachmentGuide,
  type DispatchPrivateAttachment,
  type PreparedAttachmentDispatch
} from './attachment-capability-broker';

type UnknownRecord = Record<string, unknown>;

export interface CanonicalCodexAdapter {
  createThread(input: UnknownRecord): Promise<UnknownRecord>;
  resumeThread(input: UnknownRecord): Promise<UnknownRecord>;
  setThreadName(input: UnknownRecord): Promise<UnknownRecord>;
  listThreads?(input: UnknownRecord): Promise<UnknownRecord>;
  startTurn(input: UnknownRecord): Promise<UnknownRecord>;
  steerTurn(input: UnknownRecord): Promise<UnknownRecord>;
  interruptTurn(input: UnknownRecord): Promise<UnknownRecord>;
  readThread(input: UnknownRecord): Promise<UnknownRecord>;
  listThreadTurns?(input: UnknownRecord): Promise<UnknownRecord>;
  runtimeInfo(input: UnknownRecord): Promise<UnknownRecord>;
  respondToApproval(input: UnknownRecord): Promise<UnknownRecord>;
  shutdown(input: UnknownRecord): Promise<UnknownRecord>;
  subscribeEvents(input: { correlationId: string; listener(event: UnknownRecord): void }): Promise<UnknownRecord>;
}

export interface DesktopCodexServiceOptions {
  adapter?: CanonicalCodexAdapter;
  adapterFactory?: (input: { sdkPackageRoot: string }) => CanonicalCodexAdapter;
  packaged?: boolean;
  appRoot?: string;
  resourcesPath?: string;
  verifyIntegrity?: typeof verifyDesktopRuntimeIntegrity;
  now?: () => Date;
  messageLedger?: MessageLedgerWriter | null;
}

export interface DesktopRuntimeSendInput {
  messageId?: string;
  actionFingerprint?: string;
  correlationId: string;
  projectId: string;
  rootPath: string;
  threadId: string | null;
  targetAgentId: string;
  threadTitle?: string | null;
  text: string;
  attachments: DispatchPrivateAttachment[];
  attachmentToolState?: 'supported' | 'unsupported';
  selectedContextIds?: string[];
  recommendedModel: string | null;
  requestedModel: string | null;
  effort?: 'low' | 'medium' | 'high' | null;
  onThreadReady?: (threadId: string) => Promise<void> | void;
}

export interface DesktopInspectionStartInput {
  correlationId: string;
  projectId: string;
  rootPath: string;
  kind: InspectionKind;
  prompt: string;
}

function record(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function comparableAbsolutePath(value: string): string {
  const absolute = path.resolve(value);
  const withoutWindowsDevicePrefix = process.platform === 'win32'
    ? absolute.replace(/^\\\\\?\\UNC\\/iu, '\\\\').replace(/^\\\\\?\\/u, '')
    : absolute;
  return process.platform === 'win32' ? withoutWindowsDevicePrefix.toLowerCase() : withoutWindowsDevicePrefix;
}

function selectedProjectThreadBoundary(rootPath: string): UnknownRecord {
  const cwd = path.resolve(rootPath);
  return {
    cwd,
    runtimeWorkspaceRoots: [cwd],
    config: {
      project_root_markers: [],
      notify: [],
      features: { memories: false },
      memories: { generate_memories: false, use_memories: false }
    }
  };
}

function requiredAbsolutePathArray(value: unknown, code: string): string[] {
  if (!Array.isArray(value)
    || value.some((entry) => typeof entry !== 'string' || !entry.trim() || !path.isAbsolute(entry.trim()))) {
    throw new Error(`${code}: Codex App Server returned invalid selected-project path diagnostics`);
  }
  return value.map((entry) => (entry as string).trim());
}

function pathIsWithin(candidate: string, root: string): boolean {
  const normalizedCandidate = comparableAbsolutePath(candidate);
  const normalizedRoot = comparableAbsolutePath(root);
  return normalizedCandidate === normalizedRoot
    || normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
}

function requireSelectedProjectRuntimeProfile(result: UnknownRecord, rootPath: string): UnknownRecord {
  const profile = record(result.runtime_profile);
  const actualCwd = nonEmptyString(profile?.cwd);
  if (!actualCwd || comparableAbsolutePath(actualCwd) !== comparableAbsolutePath(rootPath)) {
    throw new Error('provider_project_root_mismatch: Codex App Server did not apply the selected project root');
  }
  const workspaceRoots = requiredAbsolutePathArray(
    profile?.runtime_workspace_roots,
    'provider_workspace_roots_mismatch'
  );
  if (workspaceRoots.length !== 1
    || comparableAbsolutePath(workspaceRoots[0]) !== comparableAbsolutePath(rootPath)) {
    throw new Error('provider_workspace_roots_mismatch: Codex App Server did not isolate the selected project root');
  }
  const instructionSources = requiredAbsolutePathArray(
    profile?.instruction_sources,
    'provider_instruction_sources_invalid'
  );
  const ancestorInstruction = instructionSources.find((source) => (
    !pathIsWithin(source, rootPath) && pathIsWithin(rootPath, path.dirname(source))
  ));
  if (ancestorInstruction) {
    throw new Error('provider_ancestor_instruction_source: Codex App Server loaded instructions above the selected project root');
  }
  return profile;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export interface DesktopRuntimeSteerInput {
  correlationId: string;
  projectId: string;
  rootPath: string;
  targetAgentId: string;
  threadId: string;
  turnId: string;
  text: string;
}

export function providerThreadSourceIdentity(input: {
  projectId: string;
  messageId: string;
  actionFingerprint: string;
}): string {
  if (!/^[a-f0-9]{64}$/u.test(input.actionFingerprint) || !input.projectId || !input.messageId) {
    throw new Error('provider_thread_source_identity_invalid');
  }
  return `orquesta:${createHash('sha256')
    .update('orquesta.provider-thread-source.v1\0', 'utf8')
    .update(input.projectId, 'utf8')
    .update('\0', 'utf8')
    .update(input.messageId, 'utf8')
    .update('\0', 'utf8')
    .update(input.actionFingerprint, 'utf8')
    .digest('hex')}`;
}

function requireCompleteThreadTurns(value: unknown, limit: number): UnknownRecord[] {
  if (!Array.isArray(value) || value.length > limit) {
    throw new Error('Codex App Server returned an invalid bounded turn page');
  }
  return value.map((turnValue) => {
    const turn = record(turnValue);
    if (!turn || !nonEmptyString(turn.id) || !nonEmptyString(turn.status) || !Array.isArray(turn.items)) {
      throw new Error('Codex App Server returned an incomplete turn history record');
    }
    for (const itemValue of turn.items) {
      const item = record(itemValue);
      if (!item || !nonEmptyString(item.id) || !nonEmptyString(item.type)) {
        throw new Error('Codex App Server returned an incomplete turn item');
      }
    }
    return turn;
  });
}

const ORCHESTRATOR_RUNTIME_CONTRACT = [
  '<orquesta_runtime_contract version="1">',
  'Reassess whether the currently accepted team fits this request before doing product work, and reuse a suitable specialist when possible. The Desktop conversation path does not yet expose the canonical PlacementIntent execution operation. If capability or parallel ownership is missing, report one bounded placement need with purpose, capability, scope, lifetime, and reason, then stop the affected dispatch. Do not invent a specialist, emit a storage template, or mutate project state. A specialist is operational only after the controller has committed its task and Organization V3 record and SessionBinding confirms an accepted current owner. The orchestrator coordinates and accepts specialist work, and implements directly only when the work is genuinely small.',
  '</orquesta_runtime_contract>'
].join('\n');
const ORCHESTRATOR_TURN = /^<orquesta_runtime_contract version="1">\n[\s\S]*?\n<\/orquesta_runtime_contract>\n<orquesta_user_message>\n([\s\S]*)\n<\/orquesta_user_message>$/u;
const FOUNDATION_RECEIPT_MESSAGE = /^<orquesta_foundation_receipt(?:\s[^<>]*)?\s*\/>$/u;

function routeText(targetAgentId: string, text: string): string {
  const foundationAssignment = text.startsWith('<orquesta_foundation_assignment version="1">\n')
    && text.endsWith('\n</orquesta_foundation_assignment>');
  if (foundationAssignment) {
    return `<orquesta_target agent_id="${targetAgentId}">\n${text}\n</orquesta_target>`;
  }
  return targetAgentId === 'orchestrator'
    ? `${ORCHESTRATOR_RUNTIME_CONTRACT}\n<orquesta_user_message>\n${text}\n</orquesta_user_message>`
    : `<orquesta_target agent_id="${targetAgentId}">\n${text}\n</orquesta_target>`;
}

function parseRouteText(text: string): { targetAgentId: string; text: string } {
  const orchestrator = ORCHESTRATOR_TURN.exec(text);
  if (orchestrator) return { targetAgentId: 'orchestrator', text: orchestrator[1] };
  const match = /^<orquesta_target agent_id="([a-zA-Z0-9._:-]{1,128})">\n([\s\S]*)\n<\/orquesta_target>$/u.exec(text);
  return match ? { targetAgentId: match[1], text: match[2] } : { targetAgentId: 'orchestrator', text };
}

interface PendingDelivery {
  rootPath: string;
  messageId: string;
  actionFingerprint: string;
  correlationId: string;
  projectId: string;
  targetAgentId: string;
  threadId: string | null;
  turnId: string | null;
}

const DISPATCH_CACHE_LIMIT = 200;
const APPROVAL_ID_DOMAIN = 'orquesta.desktop.approval.identity.v2';
const ADAPTER_APPROVAL_ID_PATTERN = /^adapter-approval-[a-f0-9]{64}$/u;

interface ApprovalResponseAttempt {
  providerConnectionId: string;
  decision: string;
  status: 'responding' | 'accepted' | 'definitive_failure' | 'outcome_unknown';
  promise: Promise<{ requestId: string; providerConnectionId: string; decision: string }>;
  result: { requestId: string; providerConnectionId: string; decision: string } | null;
  error: Error | null;
}

export interface ApprovalActionFingerprintInput {
  adapterRequestId: string;
  projectId: string;
  providerConnectionId: string;
  method: string;
  correlationId: string;
  threadId: string;
  turnId: string;
  targetAgentId: string | null;
  requestedEffect: { kind: string; itemId: string };
  responseOptions: string[];
}

function approvalIdentityString(value: string, label: string, maximumLength = 1_024): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximumLength) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
  return `{${entries.join(',')}}`;
}

function runtimeTurnKey(threadId: string, turnId: string): string {
  return canonicalJson([threadId, turnId]);
}

export function approvalActionFingerprint(approval: ApprovalActionFingerprintInput): string {
  if (!ADAPTER_APPROVAL_ID_PATTERN.test(approval.adapterRequestId)) {
    throw new Error('Adapter approval identity is invalid');
  }
  approvalIdentityString(approval.projectId, 'Approval project ID');
  approvalIdentityString(approval.providerConnectionId, 'Approval provider connection ID');
  approvalIdentityString(approval.method, 'Approval method');
  approvalIdentityString(approval.correlationId, 'Approval correlation ID');
  approvalIdentityString(approval.threadId, 'Approval thread ID');
  approvalIdentityString(approval.turnId, 'Approval turn ID');
  if (approval.targetAgentId !== null) {
    approvalIdentityString(approval.targetAgentId, 'Approval target agent ID', 128);
  }
  approvalIdentityString(approval.requestedEffect.kind, 'Approval effect kind', 128);
  approvalIdentityString(approval.requestedEffect.itemId, 'Approval effect item ID');
  if (approval.responseOptions.length < 1 || approval.responseOptions.length > 16
    || new Set(approval.responseOptions).size !== approval.responseOptions.length) {
    throw new Error('Approval response options are invalid');
  }
  for (const option of approval.responseOptions) approvalIdentityString(option, 'Approval response option', 128);
  const material = {
    domain: APPROVAL_ID_DOMAIN,
    schemaVersion: 1,
    adapterRequestId: approval.adapterRequestId,
    requestedEffect: approval.requestedEffect,
    projectId: approval.projectId,
    providerConnectionId: approval.providerConnectionId,
    method: approval.method,
    correlationId: approval.correlationId,
    threadId: approval.threadId,
    turnId: approval.turnId,
    targetAgentId: approval.targetAgentId,
    responseOptions: approval.responseOptions
  };
  return createHash('sha256').update(canonicalJson(material), 'utf8').digest('hex');
}

export function publicApprovalId(actionFingerprint: string): string {
  if (!/^[a-f0-9]{64}$/u.test(actionFingerprint)) throw new Error('Approval fingerprint is invalid');
  return `approval-${actionFingerprint}`;
}

export interface DispatchFingerprintInput {
  runtimeProjectId: string;
  targetAgentId: string;
  text: string;
  orderedAttachmentContentSha256: string[];
  selectedContextIds: string[];
  effort: 'low' | 'medium' | 'high' | null;
  recommendedModel: string | null;
  requestedModel: string | null;
}

export function dispatchActionFingerprint(input: DispatchFingerprintInput): string {
  const material = {
    schemaVersion: 1,
    runtimeProjectId: input.runtimeProjectId,
    targetAgentId: input.targetAgentId,
    text: input.text,
    orderedAttachmentContentSha256: [...input.orderedAttachmentContentSha256],
    selectedContextIds: [...input.selectedContextIds],
    additionalParams: {
      effort: input.effort,
      recommendedModel: input.recommendedModel,
      requestedModel: input.requestedModel
    }
  };
  return createHash('sha256').update(canonicalJson(material), 'utf8').digest('hex');
}

export async function dispatchActionFingerprintForSend(input: DesktopRuntimeSendInput): Promise<string> {
  const orderedAttachmentContentSha256 = input.attachments.map((attachment) => attachment.sha256);
  return dispatchActionFingerprint({
    runtimeProjectId: input.projectId,
    targetAgentId: input.targetAgentId,
    text: input.text,
    orderedAttachmentContentSha256,
    selectedContextIds: input.selectedContextIds ?? [],
    effort: input.effort ?? null,
    recommendedModel: input.recommendedModel,
    requestedModel: input.requestedModel
  });
}

export class DispatchTerminalError extends Error {
  readonly code: string;
  readonly details: { terminalOutcome: 'failed'; messageId: string; actionFingerprint: string };

  constructor(code: string, message: string, messageId: string, actionFingerprint: string) {
    super(message);
    this.name = 'DispatchTerminalError';
    this.code = code;
    this.details = { terminalOutcome: 'failed', messageId, actionFingerprint };
  }
}

export class DispatchOutcomeUnknownError extends Error {
  readonly code = 'dispatch_outcome_unknown';
  readonly outcomeUnknown = true;
  readonly details: { providerAccepted: true; threadId: string; turnId: string } | null;

  constructor(error: unknown, receipt: { threadId: string; turnId: string } | null = null) {
    super(error instanceof Error ? error.message : String(error), { cause: error });
    this.name = 'DispatchOutcomeUnknownError';
    this.details = receipt ? { providerAccepted: true, ...receipt } : null;
  }
}

class ApprovalTerminalExpiredError extends Error {
  constructor() {
    super('Codex approval request expired when its turn became terminal');
    this.name = 'ApprovalTerminalExpiredError';
  }
}

interface DispatchAttempt {
  actionFingerprint: string;
  promise: Promise<{
    threadId: string;
    turnId: string;
    modelEvidence: RuntimeModelEvidence;
    attachmentToolState: 'supported' | 'unsupported';
  }>;
}

function encodeLogicalConversationCursor(generationIndex: number, localCursor: string | null): string {
  return `logical:${Buffer.from(JSON.stringify({ version: 1, generationIndex, localCursor }), 'utf8').toString('base64url')}`;
}

function decodeLogicalConversationCursor(value: string): { generationIndex: number; localCursor: string | null } {
  if (!value.startsWith('logical:')) throw new Error('Conversation cursor is invalid');
  try {
    const parsed = record(JSON.parse(Buffer.from(value.slice('logical:'.length), 'base64url').toString('utf8')));
    const generationIndex = parsed?.generationIndex;
    const localCursor = parsed?.localCursor;
    if (parsed?.version !== 1 || !Number.isSafeInteger(generationIndex) || Number(generationIndex) < 0
      || (localCursor !== null && typeof localCursor !== 'string')) {
      throw new Error('invalid logical cursor');
    }
    return { generationIndex: Number(generationIndex), localCursor: localCursor as string | null };
  } catch {
    throw new Error('Conversation cursor is invalid');
  }
}

function isoFromSeconds(value: unknown, fallback: Date): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? new Date(value * 1_000).toISOString()
    : fallback.toISOString();
}

function modelEvidenceFromThreadResult(
  result: UnknownRecord,
  recommendedModel: string | null,
  requestedModel: string | null
): RuntimeModelEvidence {
  const model = record(result.model_evidence);
  return {
    recommendedModel: nullableString(model?.recommended_model) ?? recommendedModel,
    requestedModel: nullableString(model?.requested_model) ?? requestedModel,
    appliedModel: nullableString(model?.applied_model),
    actualModel: null,
    actualModelEvidence: 'unknown'
  };
}

function unknownModelEvidence(): RuntimeModelEvidence {
  return {
    recommendedModel: null,
    requestedModel: null,
    appliedModel: null,
    actualModel: null,
    actualModelEvidence: 'unknown'
  };
}

function requireSuccessfulResult(result: UnknownRecord, operation: string): UnknownRecord {
  if (result.ok === true) return result;
  const error = record(result.error);
  throw new Error(nonEmptyString(error?.message) ?? `${operation} failed`);
}

export function projectConversation(
  thread: UnknownRecord,
  fallback: Date,
  defaultTargetAgentId = 'orchestrator',
  options: { includeFoundationReceipts?: boolean } = {}
): ConversationMessage[] {
  const turns = Array.isArray(thread.turns) ? thread.turns.flatMap((turn) => record(turn) ?? []) : [];
  const messages: ConversationMessage[] = [];
  for (const turn of turns) {
    const turnId = nonEmptyString(turn.id);
    const items = Array.isArray(turn.items) ? turn.items.flatMap((item) => record(item) ?? []) : [];
    let targetAgentId = defaultTargetAgentId;
    for (const item of items) {
      if (item.type === 'userMessage') {
        const content = Array.isArray(item.content) ? item.content.flatMap((entry) => record(entry) ?? []) : [];
        const rawText = content
          .filter((entry) => entry.type === 'text')
          .map((entry) => nonEmptyString(entry.text) ?? '')
          .join('\n')
          .trim();
        if (!rawText) continue;
        const routed = parseRouteText(rawText);
        targetAgentId = routed.targetAgentId === 'orchestrator' && defaultTargetAgentId !== 'orchestrator'
          ? defaultTargetAgentId
          : routed.targetAgentId;
        // Native SQLite persists the exact Renderer-authored user message before
        // dispatch. Provider user items contain routing and attachment guidance,
        // so they are never a visible conversation authority.
      } else if (item.type === 'agentMessage') {
        const text = nonEmptyString(item.text);
        if (!text) continue;
        // Foundation receipts are a machine-to-machine bootstrap handshake, not
        // assistant prose. Keep them available only to the bootstrap verifier;
        // every user-facing conversation projection excludes the reserved tag.
        if (!options.includeFoundationReceipts && FOUNDATION_RECEIPT_MESSAGE.test(text)) continue;
        const lucaAnswer = targetAgentId === LUCA_TARGET_AGENT_ID ? parseLucaAnswer(text) : null;
        const message: ConversationMessage = {
          id: nonEmptyString(item.id) ?? `agent-${messages.length}`,
          role: 'agent',
          targetAgentId,
          authorLabel: targetAgentId === LUCA_TARGET_AGENT_ID ? 'Luca' : targetAgentId,
          text: lucaAnswer?.answer ?? text,
          createdAt: isoFromSeconds(turn.completedAt ?? turn.startedAt, fallback),
          evidenceLabel: lucaAnswer ? 'Luca structured answer' : 'Codex thread history',
          turnId
        };
        if (targetAgentId === LUCA_TARGET_AGENT_ID) {
          message.lucaAnswer = lucaAnswer;
          message.structured = Boolean(lucaAnswer);
        }
        messages.push(message);
      } else if (item.type === 'systemMessage') {
        const content = Array.isArray(item.content) ? item.content.flatMap((entry) => record(entry) ?? []) : [];
        const text = nonEmptyString(item.text) ?? content
          .filter((entry) => entry.type === 'text')
          .map((entry) => nonEmptyString(entry.text) ?? '')
          .join('\n')
          .trim();
        if (!text) continue;
        messages.push({
          id: nonEmptyString(item.id) ?? `system-${messages.length}`,
          role: 'system',
          targetAgentId,
          authorLabel: 'System',
          text,
          createdAt: isoFromSeconds(turn.completedAt ?? turn.startedAt, fallback),
          evidenceLabel: 'Codex thread history',
          turnId
        });
      }
    }
  }
  return messages;
}

export class AttachmentPreDispatchError extends Error {
  readonly code: string;
  readonly outcomeUnknown = false;

  constructor(error: unknown) {
    const candidate = error instanceof Error ? error.message : '';
    const code = /^attachment_[a-z0-9_]{1,127}$/u.test(candidate)
      ? candidate
      : 'attachment_read_failed';
    super(code);
    this.name = 'AttachmentPreDispatchError';
    this.code = code;
  }
}

class ApprovalPreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalPreflightError';
  }
}

export class ApprovalOutcomeUnknownError extends Error {
  readonly code = 'approval_outcome_unknown';
  readonly outcomeUnknown = true;

  constructor(error: unknown) {
    super(error instanceof Error ? error.message : String(error), { cause: error });
    this.name = 'ApprovalOutcomeUnknownError';
  }
}

class DispatchRecoveredAcceptance extends Error {
  readonly record: MessageDeliveryRecord;

  constructor(record: MessageDeliveryRecord) {
    super('Another Core process already durably accepted this exact provider dispatch');
    this.name = 'DispatchRecoveredAcceptance';
    this.record = record;
  }
}

const historicalActivityItemTypes = new Set([
  'commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall',
  'collabAgentToolCall', 'webSearch', 'plan'
]);
const historicalActivityEventTypes = new Set<ConversationActivityBackfillRecord['eventType']>([
  'tool.started', 'tool.completed', 'tool.failed',
  'command.started', 'command.completed', 'command.failed',
  'file.change.started', 'file.change.completed', 'file.change.failed',
  'diff.updated', 'plan.updated'
]);

function historicalOccurredAt(turn: UnknownRecord, completed: boolean, fallback: Date): string {
  return isoFromSeconds(
    completed ? turn.completedAt ?? turn.startedAt : turn.startedAt,
    fallback
  );
}

export function projectStructuredActivities(
  thread: UnknownRecord,
  threadId: string,
  targetAgentId: string,
  fallback: Date
): ConversationActivityBackfillRecord[] {
  const normalize = canonicalAdapterModule.normalizeAppServerFrame as (input: UnknownRecord) => UnknownRecord;
  const turns = Array.isArray(thread.turns) ? thread.turns.flatMap((turn) => record(turn) ?? []) : [];
  const activities: ConversationActivityBackfillRecord[] = [];
  let sequence = 0;
  for (const turn of turns) {
    const turnId = nonEmptyString(turn.id);
    if (!turnId) continue;
    const items = Array.isArray(turn.items) ? turn.items.flatMap((item) => record(item) ?? []) : [];
    const turnDiffs: string[] = [];
    for (const item of items) {
      const itemType = nonEmptyString(item.type);
      if (!itemType || !historicalActivityItemTypes.has(itemType)) continue;
      const completed = item.status !== 'inProgress';
      const occurredAt = historicalOccurredAt(turn, completed, fallback);
      const method = completed ? 'item/completed' : 'item/started';
      sequence += 1;
      const normalized = normalize({
        streamId: `history:${threadId}`,
        direction: 'provider_to_client',
        sequence,
        frame: {
          method,
          params: {
            threadId,
            turnId,
            [completed ? 'completedAtMs' : 'startedAtMs']: Date.parse(occurredAt),
            item,
          },
        },
      });
      const eventType = nonEmptyString(normalized.event_type) as ConversationActivityBackfillRecord['eventType'] | null;
      const scope = record(normalized.scope);
      const payload = record(normalized.payload);
      if (eventType && historicalActivityEventTypes.has(eventType) && payload) {
        activities.push({
          eventType,
          threadId,
          turnId,
          itemId: nonEmptyString(scope?.item_id),
          targetAgentId,
          occurredAt,
          payload: { ...structuredClone(payload), visibility: 'public' },
        });
        if (activities.length > 1_000) {
          throw new Error('Codex history structured activity page exceeds its bounded limit');
        }
      }
      if (itemType === 'fileChange' && Array.isArray(item.changes)) {
        for (const change of item.changes) {
          const diff = nonEmptyString(record(change)?.diff);
          if (diff) turnDiffs.push(diff);
        }
      }
    }
    if (turnDiffs.length > 0) {
      const occurredAt = historicalOccurredAt(turn, true, fallback);
      sequence += 1;
      const normalized = normalize({
        streamId: `history:${threadId}`,
        direction: 'provider_to_client',
        sequence,
        frame: { method: 'turn/diff/updated', params: { threadId, turnId, diff: turnDiffs.join('\n') } },
      });
      const payload = record(normalized.payload);
      if (!payload) throw new Error('Codex history diff normalization produced no public payload');
      activities.push({
        eventType: 'diff.updated', threadId, turnId, itemId: null, targetAgentId,
        occurredAt, payload: { ...structuredClone(payload), visibility: 'public' },
      });
      if (activities.length > 1_000) {
        throw new Error('Codex history structured activity page exceeds its bounded limit');
      }
    }
  }
  return activities;
}

function parseLucaAnswer(text: string): LucaAnswerPayload | null {
  try {
    const value = record(JSON.parse(text));
    if (!value || typeof value.answer !== 'string' || !Array.isArray(value.points)
      || !value.points.every((item) => typeof item === 'string')
      || !Array.isArray(value.uncertainties) || !value.uncertainties.every((item) => typeof item === 'string')
      || !Array.isArray(value.references)) return null;
    const references = value.references.flatMap((item) => {
      const reference = record(item);
      if (!reference || !['project', 'phase', 'task', 'failure', 'inspection', 'agent', 'attention'].includes(String(reference.kind))
        || typeof reference.id !== 'string' || typeof reference.label !== 'string') return [];
      return [{ kind: reference.kind, id: reference.id, label: reference.label } as LucaAnswerPayload['references'][number]];
    });
    if (references.length !== value.references.length) return null;
    return { answer: value.answer, points: value.points, uncertainties: value.uncertainties, references };
  } catch {
    return null;
  }
}

export function projectLucaConversation(thread: UnknownRecord, fallback: Date): ConversationMessage[] {
  return projectConversation(thread, fallback, LUCA_TARGET_AGENT_ID);
}

const defaultFactory = (input: { sdkPackageRoot: string }) => {
  const factory = (canonicalAdapterModule as unknown as {
    createAppServerAdapter(options: { sdkPackageRoot: string }): CanonicalCodexAdapter;
  }).createAppServerAdapter;
  return factory(input);
};

export class DesktopCodexService {
  private readonly options: Required<Pick<DesktopCodexServiceOptions, 'packaged' | 'now'>> & DesktopCodexServiceOptions;
  private readonly providedAdapter: CanonicalCodexAdapter | null;
  private adapterPromise: Promise<CanonicalCodexAdapter> | null = null;
  private unsubscribeAdapter: (() => void) | null = null;
  private readonly listeners = new Set<(notification: DesktopRuntimeNotification) => void>();
  private readonly approvalListeners = new Set<(approval: RuntimeApprovalRequest) => void>();
  private readonly approvalExpirationListeners = new Set<(threadId: string, turnId: string) => void>();
  private readonly evidenceByThread = new Map<string, RuntimeModelEvidence>();
  private readonly loadedThreadSignatures = new Map<string, { signature: string; providerConnectionId: string }>();
  private readonly projectByThread = new Map<string, string>();
  private readonly targetByThread = new Map<string, string>();
  private readonly pendingApprovals = new Map<string, RuntimeApprovalRequest>();
  private readonly adapterApprovalIds = new Map<string, string>();
  private readonly publicApprovalIdsByAdapter = new Map<string, string>();
  // Same-sidecar-lifetime transport single-flight mirror only. Native SQLite
  // owns durable response claims, restart recovery, and retry authority.
  private readonly approvalResponses = new Map<string, ApprovalResponseAttempt>();
  private readonly seenAgentMessages = new Set<string>();
  private readonly turnStartedAtByTurn = new Map<string, number>();
  private readonly messageLedger: MessageLedgerWriter | null;
  private readonly deliveryByCorrelation = new Map<string, PendingDelivery>();
  private readonly dispatchByMessage = new Map<string, DispatchAttempt>();
  private readonly activeOperations = new Set<Promise<unknown>>();
  private readonly attachmentBroker = new AttachmentCapabilityBroker();
  private eventQueue: Promise<void> = Promise.resolve();
  private eventDrainError: Error | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private runtimeStarted = false;
  private shutdownRequested = false;
  private integrity: RuntimeInfoUi['integrity'] = 'unverified';

  constructor(options: DesktopCodexServiceOptions = {}) {
    this.options = {
      packaged: options.packaged ?? false,
      now: options.now ?? (() => new Date()),
      ...options
    };
    this.providedAdapter = options.adapter ?? null;
    this.messageLedger = options.messageLedger === undefined
      ? (this.providedAdapter ? null : new MessageLedger({ now: this.options.now }))
      : options.messageLedger;
  }

  subscribe(listener: (notification: DesktopRuntimeNotification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeApprovals(listener: (approval: RuntimeApprovalRequest) => void): () => void {
    this.approvalListeners.add(listener);
    return () => this.approvalListeners.delete(listener);
  }

  subscribeApprovalExpirations(listener: (threadId: string, turnId: string) => void): () => void {
    this.approvalExpirationListeners.add(listener);
    return () => this.approvalExpirationListeners.delete(listener);
  }

  async selectAttachmentAuthority(sealedRoot: string): Promise<void> {
    await this.attachmentBroker.selectSealedRoot(sealedRoot);
  }

  async clearAttachmentAuthority(): Promise<void> {
    await this.attachmentBroker.clearSealedRoot();
  }

  /** Explicit project upgrade boundary; ordinary reads and sends never invoke it. */
  async migrateMessageDeliveryStorage(rootPath: string): Promise<LegacyMessageLedgerMigrationResult> {
    return migrateLegacyMessageLedger(rootPath);
  }

  async listProjectThreads(rootPath: string): Promise<ProjectCodexThread[]> {
    const adapter = await this.adapter();
    if (!adapter.listThreads) throw new Error('Codex adapter does not support persisted thread listing');
    const all: ProjectCodexThread[] = [];
    for (const archived of [false, true]) {
      let cursor: string | null = null;
      do {
        const params: UnknownRecord = {
          cwd: rootPath,
          archived,
          limit: 100,
          sortKey: 'updated_at',
          sortDirection: 'desc',
          useStateDbOnly: true
        };
        if (cursor) params.cursor = cursor;
        const result = requireSuccessfulResult(await adapter.listThreads({
          correlationId: randomUUID(),
          params
        }), 'listThreads');
        const threads = Array.isArray(result.threads) ? result.threads : [];
        for (const value of threads) {
          const thread = record(value);
          const id = nonEmptyString(thread?.id);
          const cwd = nonEmptyString(thread?.cwd);
          if (!id || !cwd) continue;
          const statusRecord = record(thread?.status);
          const status = nonEmptyString(statusRecord?.type) ?? nonEmptyString(thread?.status) ?? 'notLoaded';
          all.push({
            id,
            cwd,
            name: nullableString(thread?.name),
            archived,
            status,
            updatedAt: typeof thread?.updatedAt === 'number' || typeof thread?.updatedAt === 'string'
              ? thread.updatedAt
              : null
          });
        }
        cursor = nullableString(result.next_cursor);
      } while (cursor);
    }
    return all;
  }

  async setThreadName(input: { correlationId: string; threadId: string; name: string }): Promise<void> {
    const name = nonEmptyString(input.name);
    if (!name) throw new Error('Thread name must not be empty');
    const adapter = await this.adapter();
    const result = await adapter.setThreadName({
      correlationId: input.correlationId,
      threadId: input.threadId,
      name
    });
    const response = record(result);
    if (response?.ok === false && response.status === 'unsupported') return;
    requireSuccessfulResult(result, 'setThreadName');
  }

  async readTurnStatus(threadId: string, turnId: string): Promise<string | null> {
    const adapter = await this.adapter();
    const result = requireSuccessfulResult(await adapter.readThread({
      correlationId: randomUUID(),
      threadId,
      includeTurns: true
    }), 'readThread');
    const thread = record(result.thread);
    const turns = Array.isArray(thread?.turns) ? thread.turns.flatMap((turn) => record(turn) ?? []) : [];
    const turn = turns.find((candidate) => nonEmptyString(candidate.id) === turnId);
    return nonEmptyString(turn?.status) ?? nonEmptyString(record(turn?.status)?.type);
  }

  private emit(notification: DesktopRuntimeNotification): void {
    for (const listener of this.listeners) listener(structuredClone(notification));
  }

  private emitApproval(approval: RuntimeApprovalRequest): void {
    for (const listener of this.approvalListeners) listener(structuredClone(approval));
  }

  private async adapter(): Promise<CanonicalCodexAdapter> {
    if (!this.adapterPromise) {
      this.adapterPromise = (async () => {
        if (this.options.packaged) {
          const resourcesPath = this.options.resourcesPath;
          if (!resourcesPath) throw new Error('Packaged Codex resources path is unavailable');
          try {
            await (this.options.verifyIntegrity ?? verifyDesktopRuntimeIntegrity)({
              runtimeRoot: portableJoin(resourcesPath, 'codex-runtime')
            });
            this.integrity = 'verified';
          } catch (error) {
            this.integrity = 'failed';
            throw error;
          }
        }
        const adapter = this.providedAdapter ?? (this.options.adapterFactory ?? defaultFactory)({
          sdkPackageRoot: resolveDesktopSdkPackageRoot({
            packaged: this.options.packaged,
            appRoot: this.options.appRoot ?? process.cwd(),
            resourcesPath: this.options.resourcesPath ?? ''
          })
        });
        const subscriptionResult = requireSuccessfulResult(
          await adapter.subscribeEvents({
            correlationId: 'desktop-runtime-events',
            listener: (event) => {
              if (event.type === 'provider_connection') {
                const notification = {
                  kind: 'provider_connection',
                  providerConnectionId: event.provider_connection_id,
                  state: event.state,
                };
                const frame = { type: 'runtime.notification', notification };
                // Connection invalidation must not wait for an older thread's
                // disk write. This uses the same transport, not another queue.
                if (isCoreEvent(frame) && frame.type === 'runtime.notification') this.emit(frame.notification);
                return;
              }
              this.eventQueue = this.eventQueue
                .then(() => this.handleAdapterEvent(event))
                .catch((error: unknown) => {
                  this.eventDrainError ??= error instanceof Error ? error : new Error(String(error));
                });
            }
          }),
          'subscribeEvents'
        );
        const subscription = record(subscriptionResult.subscription);
        this.unsubscribeAdapter = typeof subscription?.unsubscribe === 'function'
          ? subscription.unsubscribe as () => void
          : null;
        return adapter;
      })().catch((error) => {
        this.adapterPromise = null;
        throw error;
      });
    }
    return this.adapterPromise;
  }

  async sendMessage(input: DesktopRuntimeSendInput): Promise<{
    threadId: string;
    turnId: string;
    modelEvidence: RuntimeModelEvidence;
    attachmentToolState: 'supported' | 'unsupported';
  }> {
    if (this.shutdownRequested) throw new Error('Codex runtime is shutting down');
    const messageId = input.messageId ?? input.correlationId;
    const selectedContextIds = input.selectedContextIds ?? [];
    const computedFingerprint = await dispatchActionFingerprintForSend({
      ...input,
      messageId,
      selectedContextIds
    });
    if (this.shutdownRequested) throw new Error('Codex runtime is shutting down');
    if (input.actionFingerprint && input.actionFingerprint !== computedFingerprint) {
      throw new Error('message_action_fingerprint_mismatch');
    }
    const normalized: DesktopRuntimeSendInput & {
      messageId: string;
      actionFingerprint: string;
      selectedContextIds: string[];
    } = {
      ...input,
      messageId,
      actionFingerprint: computedFingerprint,
      selectedContextIds
    };
    const dispatchKey = `${path.resolve(input.rootPath)}\u0000${messageId}`;
    const current = this.dispatchByMessage.get(dispatchKey);
    if (current) {
      if (current.actionFingerprint !== computedFingerprint) {
        throw new Error('message_action_fingerprint_mismatch');
      }
      return current.promise;
    }
    const promise = this.performSendMessage(normalized);
    this.trackActiveOperation(promise);
    this.dispatchByMessage.set(dispatchKey, { actionFingerprint: computedFingerprint, promise });
    while (this.dispatchByMessage.size > DISPATCH_CACHE_LIMIT) {
      const oldest = this.dispatchByMessage.keys().next().value as string | undefined;
      if (!oldest || oldest === dispatchKey) break;
      this.dispatchByMessage.delete(oldest);
    }
    return promise;
  }

  private trackActiveOperation<T>(operation: Promise<T>): Promise<T> {
    this.activeOperations.add(operation);
    void operation.then(
      () => this.activeOperations.delete(operation),
      () => this.activeOperations.delete(operation)
    );
    return operation;
  }

  private async performSendMessage(input: DesktopRuntimeSendInput & {
    messageId: string;
    actionFingerprint: string;
    selectedContextIds: string[];
  }): Promise<{
    threadId: string;
    turnId: string;
    modelEvidence: RuntimeModelEvidence;
    attachmentToolState: 'supported' | 'unsupported';
  }> {
    const delivery: PendingDelivery = {
      rootPath: input.rootPath,
      messageId: input.messageId,
      actionFingerprint: input.actionFingerprint,
      correlationId: input.correlationId,
      projectId: input.projectId,
      targetAgentId: input.targetAgentId,
      // A delivery claim always starts unbound. Even when the caller already
      // knows the durable thread, the ledger must first record `queued`, then
      // admit that thread through `thread_ready` before turn/start can be
      // claimed. Pre-binding here made every second message structurally
      // invalid because `queued` deliberately forbids a thread id.
      threadId: null,
      turnId: null
    };
    this.deliveryByCorrelation.set(input.correlationId, delivery);
    const prior = this.messageLedger?.read
      ? await this.messageLedger.read({ rootPath: input.rootPath, messageId: input.messageId })
      : null;
    let recoverableThreadId: string | null = null;
    if (prior) {
      if (prior.action_fingerprint !== input.actionFingerprint
        || prior.project_id !== input.projectId
        || prior.target_agent_id !== input.targetAgentId) {
        this.deliveryByCorrelation.delete(input.correlationId);
        throw new Error('message_action_fingerprint_mismatch');
      }
      if (['dispatch_accepted', 'turn_started', 'completed'].includes(prior.state)
        && prior.thread_id && prior.turn_id) {
        this.deliveryByCorrelation.delete(input.correlationId);
        return {
          threadId: prior.thread_id,
          turnId: prior.turn_id,
          modelEvidence: this.evidence(prior.thread_id),
          attachmentToolState: input.attachmentToolState ?? (input.threadId ? 'unsupported' : 'supported')
        };
      }
      if (prior.state === 'failed') {
        this.deliveryByCorrelation.delete(input.correlationId);
        throw new DispatchTerminalError(
          prior.error_code ?? 'dispatch_failed',
          'The Core delivery ledger recorded a definitive dispatch failure.',
          input.messageId,
          input.actionFingerprint
        );
      }
      if (prior.schema_version === 3 && prior.state === 'thread_ready' && prior.thread_id) {
        recoverableThreadId = prior.thread_id;
        delivery.threadId = prior.thread_id;
      } else {
        this.deliveryByCorrelation.delete(input.correlationId);
        throw new DispatchOutcomeUnknownError(
          new Error(`A prior ${prior.state} dispatch has no durable terminal acknowledgment; automatic retry is blocked`)
        );
      }
    }
    if (!prior) {
      const claimed = await this.recordDelivery(delivery, 'queued');
      if (!claimed) {
        this.deliveryByCorrelation.delete(input.correlationId);
        throw new DispatchOutcomeUnknownError(
          new Error('Another Core process already claimed this exact provider dispatch')
        );
      }
    }
    if (this.shutdownRequested) {
      await this.recordDelivery(delivery, 'failed', 'runtime_shutting_down');
      this.deliveryByCorrelation.delete(input.correlationId);
      throw new DispatchTerminalError(
        'runtime_shutting_down',
        'The runtime began shutting down before dispatch was admitted.',
        input.messageId,
        input.actionFingerprint
      );
    }
    try {
      const result = await this.dispatchMessage({
        ...input,
        threadId: recoverableThreadId ?? input.threadId,
        onThreadReady: async (threadId) => {
          delivery.threadId = threadId;
          await this.recordDelivery(delivery, 'thread_ready');
          await input.onThreadReady?.(threadId);
        },
        onTurnStarting: async (threadId) => {
          delivery.threadId = threadId;
          const claimed = await this.recordDelivery(delivery, 'turn_starting');
          if (!claimed) {
            const latest = this.messageLedger?.read
              ? await this.messageLedger.read({ rootPath: input.rootPath, messageId: input.messageId })
              : null;
            if (latest
              && latest.action_fingerprint === input.actionFingerprint
              && latest.project_id === input.projectId
              && latest.target_agent_id === input.targetAgentId
              && ['dispatch_accepted', 'turn_started', 'completed'].includes(latest.state)
              && latest.thread_id
              && latest.turn_id) {
              throw new DispatchRecoveredAcceptance(latest);
            }
            throw new DispatchOutcomeUnknownError(
              new Error('Another Core process already claimed turn/start for this exact provider dispatch')
            );
          }
        }
      });
      delivery.threadId = result.threadId;
      delivery.turnId = result.turnId;
      await this.recordDelivery(delivery, 'dispatch_accepted');
      return result;
    } catch (error) {
      if (error instanceof AttachmentPreDispatchError) {
        await this.recordDelivery(delivery, 'failed', error.code);
        this.deliveryByCorrelation.delete(input.correlationId);
        throw error;
      }
      if (error instanceof DispatchOutcomeUnknownError && error.details?.providerAccepted) {
        delivery.threadId = error.details.threadId;
        delivery.turnId = error.details.turnId;
        try {
          await this.recordDelivery(delivery, 'dispatch_accepted');
        } catch {
          // The exact Provider receipt remains attached to the outcome-unknown
          // failure even if this local projection cannot be advanced.
        }
      }
      this.deliveryByCorrelation.delete(input.correlationId);
      if (error instanceof DispatchRecoveredAcceptance) {
        return {
          threadId: error.record.thread_id as string,
          turnId: error.record.turn_id as string,
          modelEvidence: this.evidence(error.record.thread_id as string),
          attachmentToolState: input.attachmentToolState ?? (input.threadId ? 'unsupported' : 'supported')
        };
      }
      throw error instanceof DispatchTerminalError || error instanceof DispatchOutcomeUnknownError
        ? error
        : new DispatchOutcomeUnknownError(error);
    }
  }

  async reconcileDispatch(input: {
    projectId: string;
    rootPath: string;
    messageId: string;
    actionFingerprint: string;
  }): Promise<{ threadId: string; turnId: string; modelEvidence: RuntimeModelEvidence }> {
    if (!/^[a-f0-9]{64}$/u.test(input.actionFingerprint)) {
      throw new Error('message_action_fingerprint_invalid');
    }
    if (!this.messageLedger?.read) throw new Error('dispatch_reconciliation_unavailable');
    const record = await this.messageLedger.read({ rootPath: input.rootPath, messageId: input.messageId });
    if (!record) {
      throw new DispatchTerminalError(
        'dispatch_not_recorded',
        'The dispatch never entered the Core delivery ledger.',
        input.messageId,
        input.actionFingerprint
      );
    }
    if (record.action_fingerprint !== input.actionFingerprint || record.project_id !== input.projectId) {
      throw new Error('message_action_fingerprint_mismatch');
    }
    if (['dispatch_accepted', 'turn_started', 'completed'].includes(record.state)
      && record.thread_id && record.turn_id) {
      return {
        threadId: record.thread_id,
        turnId: record.turn_id,
        modelEvidence: this.evidence(record.thread_id)
      };
    }
    if (record.state === 'failed') {
      throw new DispatchTerminalError(
        record.error_code ?? 'dispatch_failed',
        'The Core delivery ledger recorded a definitive dispatch failure.',
        input.messageId,
        input.actionFingerprint
      );
    }
    throw new Error('dispatch_outcome_unknown');
  }

  private async dispatchMessage(input: DesktopRuntimeSendInput & {
    onTurnStarting?: (threadId: string) => Promise<void> | void;
  }): Promise<{
    threadId: string;
    turnId: string;
    modelEvidence: RuntimeModelEvidence;
    attachmentToolState: 'supported' | 'unsupported';
  }> {
    const adapter = await this.adapter();
    let preparedAttachments: Awaited<ReturnType<AttachmentCapabilityBroker['prepareDispatch']>>;
    try {
      preparedAttachments = await this.attachmentBroker.prepareDispatch(input.attachments);
    } catch (error) {
      throw new AttachmentPreDispatchError(error);
    }
    const attachmentGuide = providerAttachmentGuide(preparedAttachments);
    const projectBoundary = selectedProjectThreadBoundary(input.rootPath);
    const params: UnknownRecord = { ...projectBoundary };
    if (!input.threadId) params.dynamicTools = [attachmentToolDefinition()];
    if (input.requestedModel) params.model = input.requestedModel;
    if (!input.threadId && input.actionFingerprint) {
      params.threadSource = providerThreadSourceIdentity({
        projectId: input.projectId,
        messageId: input.messageId ?? input.correlationId,
        actionFingerprint: input.actionFingerprint
      });
    }
    const loadSignature = JSON.stringify([
      projectBoundary,
      input.recommendedModel,
      input.requestedModel
    ]);
    const providerRuntime = requireSuccessfulResult(await adapter.runtimeInfo({
      correlationId: `${input.correlationId}:provider`,
      probe: true
    }), 'runtimeInfo');
    const providerConnectionId = nonEmptyString(providerRuntime.provider_connection_id);
    if (!providerConnectionId) throw new Error('Codex App Server provider connection identity is unavailable');
    const canReuseLoadedThread = Boolean(input.threadId)
      && this.loadedThreadSignatures.get(input.threadId!)?.signature === loadSignature
      && this.loadedThreadSignatures.get(input.threadId!)?.providerConnectionId === providerConnectionId;
    const threadResult = canReuseLoadedThread
      ? null
      : requireSuccessfulResult(
          await (input.threadId
            ? adapter.resumeThread({
                correlationId: `${input.correlationId}:thread`,
                threadId: input.threadId,
                recommendedModel: input.recommendedModel,
                requestedModel: input.requestedModel,
                params: { ...params, excludeTurns: true }
              })
            : adapter.createThread({
                correlationId: `${input.correlationId}:thread`,
                recommendedModel: input.recommendedModel,
                requestedModel: input.requestedModel,
                params
              })),
          input.threadId ? 'resumeThread' : 'createThread'
        );
    const threadId = canReuseLoadedThread ? input.threadId! : nonEmptyString(threadResult?.thread_id);
    if (!threadId) throw new Error('Codex App Server did not return a thread id');
    if (threadResult) requireSelectedProjectRuntimeProfile(threadResult, input.rootPath);
    this.loadedThreadSignatures.set(threadId, {
      signature: loadSignature,
      providerConnectionId: nonEmptyString(threadResult?.provider_connection_id) ?? providerConnectionId
    });
    await input.onThreadReady?.(threadId);
    const threadTitle = nonEmptyString(input.threadTitle);
    if (threadTitle) {
      try {
        const nameResult = await adapter.setThreadName({
          correlationId: `${input.correlationId}:name`,
          threadId,
          name: threadTitle
        });
        const failedName = record(nameResult);
        if (failedName?.ok !== false || failedName.status !== 'unsupported') {
          requireSuccessfulResult(nameResult, 'setThreadName');
        }
      } catch (error) {
        console.warn('Optional Codex thread naming failed after durable thread admission', error);
      }
    }
    const evidence = threadResult
      ? modelEvidenceFromThreadResult(threadResult, input.recommendedModel, input.requestedModel)
      : structuredClone(this.evidenceByThread.get(threadId) ?? unknownModelEvidence());
    this.evidenceByThread.set(threadId, evidence);
    this.projectByThread.set(threadId, input.projectId);
    this.targetByThread.set(threadId, input.targetAgentId);
    await input.onTurnStarting?.(threadId);
    const turnStartedAt = this.options.now().getTime();
    let turnResult: UnknownRecord;
    const dynamicToolHandlerFactory = preparedAttachments.textAttachments.length > 0
      ? Object.assign(
          (scope: Parameters<AttachmentCapabilityBroker['bindTurn']>[1]) => (
            this.attachmentBroker.bindTurn(preparedAttachments, scope)
          ),
          { preflight: () => this.attachmentBroker.preflightTurnBinding(preparedAttachments) }
        )
      : null;
    try {
      const rawTurnResult = record(await adapter.startTurn({
        correlationId: input.correlationId,
        threadId,
        input: [
          { type: 'text', text: routeText(input.targetAgentId, input.text), text_elements: [] },
          ...(attachmentGuide ? [{ type: 'text', text: attachmentGuide, text_elements: [] }] : []),
          ...input.attachments
            .filter((attachment) => attachment.kind === 'image')
            .map((attachment) => ({ type: 'localImage', path: attachment.sealedAbsolutePath }))
        ],
        params: {
          clientUserMessageId: input.messageId ?? input.correlationId,
          ...(input.effort ? { effort: input.effort } : {})
        },
        dynamicToolHandlerFactory
      }));
      const rawEvidence = record(rawTurnResult?.evidence);
      const rawError = record(rawTurnResult?.error);
      const rawErrorCode = nonEmptyString(rawError?.code);
      const acceptedThreadId = nonEmptyString(rawTurnResult?.thread_id);
      const acceptedTurnId = nonEmptyString(rawTurnResult?.turn_id);
      if (rawTurnResult?.ok === false && rawEvidence?.dispatch_accepted !== true
        && rawErrorCode && /^attachment_[a-z0-9_]{1,127}$/u.test(rawErrorCode)) {
        throw new AttachmentPreDispatchError(new Error(rawErrorCode));
      }
      if (rawTurnResult?.ok === false && rawEvidence?.dispatch_accepted === true
        && acceptedThreadId && acceptedTurnId) {
        throw new DispatchOutcomeUnknownError(
          new Error(nonEmptyString(record(rawTurnResult.error)?.message) ?? 'Dynamic attachment tool admission failed after Provider accepted the turn'),
          { threadId: acceptedThreadId, turnId: acceptedTurnId }
        );
      }
      turnResult = requireSuccessfulResult(rawTurnResult, 'startTurn');
      if (preparedAttachments.textAttachments.length > 0 && !preparedAttachments.bound) {
        throw new Error('dynamic_tool_handler_not_bound');
      }
    } catch (error) {
      this.attachmentBroker.abortPrepared(preparedAttachments);
      // If App Server discarded its in-memory task state, the next explicit retry
      // must resume from durable storage instead of trusting the local cache.
      this.loadedThreadSignatures.delete(threadId);
      throw error;
    }
    const turnId = nonEmptyString(turnResult.turn_id);
    if (!turnId) throw new Error('Codex App Server did not accept the turn');
    this.turnStartedAtByTurn.set(runtimeTurnKey(threadId, turnId), turnStartedAt);
    this.runtimeStarted = true;
    if (preparedAttachments.textAttachments.length === 0) {
      this.attachmentBroker.abortPrepared(preparedAttachments);
    }
    return {
      threadId,
      turnId,
      modelEvidence: structuredClone(evidence),
      attachmentToolState: input.threadId
        ? input.attachmentToolState ?? 'unsupported'
        : 'supported'
    };
  }

  private async startReadOnlyEphemeralRun(input: {
    correlationId: string;
    projectId: string;
    rootPath: string;
    prompt: string;
    webSearchMode: InspectionRuntimeBoundary['webSearchMode'];
    purpose: 'inspection' | 'workflow';
  }): Promise<{
    threadId: string;
    turnId: string;
    runtimeBoundary: InspectionRuntimeBoundary;
  }> {
    if (this.shutdownRequested) throw new Error('Codex runtime is shutting down');
    const adapter = await this.adapter();
    const runtimeBoundary: InspectionRuntimeBoundary = {
      sandbox: 'read-only',
      approvalPolicy: 'never',
      webSearchMode: input.webSearchMode
    };
    const threadResult = requireSuccessfulResult(await adapter.createThread({
      correlationId: `${input.correlationId}:thread`,
      params: {
        ...selectedProjectThreadBoundary(input.rootPath),
        sandbox: runtimeBoundary.sandbox,
        approvalPolicy: runtimeBoundary.approvalPolicy,
        webSearchMode: runtimeBoundary.webSearchMode
      }
    }), 'createThread');
    const threadId = nonEmptyString(threadResult.thread_id);
    if (!threadId) throw new Error('Codex App Server did not return a thread id');
    const profile = requireSelectedProjectRuntimeProfile(threadResult, input.rootPath);
    if (profile?.sandbox !== runtimeBoundary.sandbox
      || profile.approval_policy !== runtimeBoundary.approvalPolicy
      || profile.requested_web_search_mode !== runtimeBoundary.webSearchMode) {
      throw new Error(`read_only_boundary_violation: Codex App Server did not apply the requested ${input.purpose} profile`);
    }
    this.evidenceByThread.set(threadId, unknownModelEvidence());
    this.projectByThread.set(threadId, input.projectId);
    const turnResult = requireSuccessfulResult(await adapter.startTurn({
      correlationId: input.correlationId,
      threadId,
      input: [{ type: 'text', text: input.prompt, text_elements: [] }]
    }), 'startTurn');
    const turnId = nonEmptyString(turnResult.turn_id);
    if (!turnId) throw new Error(`Codex App Server did not accept the ${input.purpose} turn`);
    this.runtimeStarted = true;
    return { threadId, turnId, runtimeBoundary: structuredClone(runtimeBoundary) };
  }

  async startInspection(input: DesktopInspectionStartInput): Promise<{
    threadId: string;
    turnId: string;
    runtimeBoundary: InspectionRuntimeBoundary;
  }> {
    return this.startReadOnlyEphemeralRun({
      ...input,
      webSearchMode: input.kind === 'external_benchmark' ? 'live' : 'disabled',
      purpose: 'inspection'
    });
  }

  async startWorkflowRun(input: {
    correlationId: string;
    projectId: string;
    rootPath: string;
    prompt: string;
  }): Promise<{
    threadId: string;
    turnId: string;
    runtimeBoundary: InspectionRuntimeBoundary;
  }> {
    return this.startReadOnlyEphemeralRun({ ...input, webSearchMode: 'disabled', purpose: 'workflow' });
  }

  async interruptInspection(input: { correlationId: string; threadId: string; turnId: string }): Promise<void> {
    await this.interruptTurn(input);
  }

  async steerTurn(input: DesktopRuntimeSteerInput): Promise<{ threadId: string; turnId: string }> {
    if (this.shutdownRequested) throw new Error('Codex runtime is shutting down');
    const adapter = await this.adapter();
    const result = requireSuccessfulResult(await adapter.steerTurn({
      correlationId: input.correlationId,
      threadId: input.threadId,
      turnId: input.turnId,
      input: [{ type: 'text', text: routeText(input.targetAgentId, input.text), text_elements: [] }]
    }), 'steerTurn');
    const threadId = nonEmptyString(result.thread_id);
    const turnId = nonEmptyString(result.turn_id);
    if (threadId !== input.threadId || turnId !== input.turnId) {
      throw new Error('Codex App Server returned a mismatched steered turn');
    }
    return { threadId, turnId };
  }

  async interruptTurn(input: { correlationId: string; threadId: string; turnId: string }): Promise<void> {
    if (this.shutdownRequested) throw new Error('Codex runtime is shutting down');
    const adapter = await this.adapter();
    requireSuccessfulResult(await adapter.interruptTurn(input), 'interruptTurn');
  }

  async readInspectionThread(input: { correlationId: string; threadId: string }): Promise<{
    finalResponse: string | null;
    status: 'in_progress' | 'completed' | 'failed' | 'unknown';
  }> {
    const adapter = await this.adapter();
    const result = adapter.listThreadTurns
      ? requireSuccessfulResult(await adapter.listThreadTurns({
          correlationId: input.correlationId,
          threadId: input.threadId,
          cursor: null,
          limit: 1,
          sortDirection: 'desc',
          itemsView: 'summary'
        }), 'listThreadTurns')
      : requireSuccessfulResult(await adapter.readThread({
          correlationId: input.correlationId,
          threadId: input.threadId,
          includeTurns: true
        }), 'readThread');
    const pagedTurns = Array.isArray(result.turns) ? result.turns.flatMap((value) => record(value) ?? []) : null;
    const thread = pagedTurns ? { turns: [...pagedTurns].reverse() } : record(result.thread);
    if (!thread) throw new Error('Codex App Server returned invalid inspection thread history');
    const turns = Array.isArray(thread.turns) ? thread.turns.flatMap((value) => record(value) ?? []) : [];
    const latestTurn = turns.at(-1) ?? null;
    const latestStatus = nonEmptyString(latestTurn?.status)?.toLowerCase() ?? null;
    const messages = projectConversation(thread, this.options.now()).filter((message) => message.role === 'agent');
    return {
      finalResponse: messages.at(-1)?.text ?? null,
      status: latestStatus === 'completed'
        ? 'completed'
        : ['failed', 'cancelled', 'interrupted'].includes(latestStatus ?? '')
          ? 'failed'
          : ['in_progress', 'running', 'active', 'started'].includes(latestStatus ?? '')
            ? 'in_progress'
            : 'unknown'
    };
  }

  async listConversation(input: {
    correlationId: string;
    threadId: string;
    targetAgentId: string;
    cursor?: string | null;
    limit: number;
    includeStructuredActivities?: boolean;
    includeFoundationReceipts?: boolean;
  }): Promise<ConversationPage> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 200) {
      throw new Error('Conversation limit must be an integer from 1 to 200');
    }
    const adapter = await this.adapter();
    if (input.includeStructuredActivities && !adapter.listThreadTurns) {
      throw new Error('Codex App Server cannot provide bounded structured activity history');
    }
    if (adapter.listThreadTurns) {
      const result = requireSuccessfulResult(await adapter.listThreadTurns({
        correlationId: input.correlationId,
        threadId: input.threadId,
        cursor: input.cursor ?? null,
        limit: Math.min(input.limit, 50),
        sortDirection: 'desc',
        itemsView: input.includeStructuredActivities ? 'full' : 'summary'
      }), 'listThreadTurns');
      const newestFirst = input.includeStructuredActivities
        ? requireCompleteThreadTurns(result.turns, Math.min(input.limit, 50))
        : Array.isArray(result.turns) ? result.turns.flatMap((value) => record(value) ?? []) : [];
      const pageThread = { turns: [...newestFirst].reverse() };
      const messages = projectConversation(
        pageThread,
        this.options.now(),
        input.targetAgentId,
        { includeFoundationReceipts: input.includeFoundationReceipts }
      ).filter((message) => message.targetAgentId === input.targetAgentId);
      for (const message of messages) {
        if (message.role === 'agent') this.seenAgentMessages.add(`${input.threadId}:${message.id}`);
      }
      this.runtimeStarted = true;
      return {
        items: messages,
        nextCursor: nullableString(result.next_cursor),
        ...(input.includeStructuredActivities ? {
          activities: projectStructuredActivities(pageThread, input.threadId, input.targetAgentId, this.options.now()),
          structuredActivitiesComplete: true,
        } : {}),
      };
    }
    const result = requireSuccessfulResult(await adapter.readThread({
      correlationId: input.correlationId,
      threadId: input.threadId,
      includeTurns: true
    }), 'readThread');
    const thread = record(result.thread);
    if (!thread) throw new Error('Codex App Server returned invalid thread history');
    this.runtimeStarted = true;
    const messages = projectConversation(
      thread,
      this.options.now(),
      input.targetAgentId,
      { includeFoundationReceipts: input.includeFoundationReceipts }
    )
      .filter((message) => message.targetAgentId === input.targetAgentId);
    for (const message of messages) {
      if (message.role === 'agent') this.seenAgentMessages.add(`${input.threadId}:${message.id}`);
    }
    let end = messages.length;
    if (input.cursor) {
      const match = /^before:(\d+)$/u.exec(input.cursor);
      if (!match) throw new Error('Conversation cursor is invalid');
      end = Number(match[1]);
      if (!Number.isSafeInteger(end) || end < 0 || end > messages.length) throw new Error('Conversation cursor is invalid');
    }
    const start = Math.max(0, end - input.limit);
    return {
      items: messages.slice(start, end),
      nextCursor: start > 0 ? `before:${start}` : null,
    };
  }

  async listLogicalConversation(input: {
    correlationId: string;
    targetAgentId: string;
    generations: AgentSessionGeneration[];
    cursor?: string | null;
    limit: number;
    includeStructuredActivities?: boolean;
  }): Promise<ConversationPage> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 200) {
      throw new Error('Conversation limit must be an integer from 1 to 200');
    }
    const generations = [...input.generations]
      .filter((generation) => generation.threadId)
      .sort((left, right) => left.generation - right.generation || left.threadId.localeCompare(right.threadId));
    if (!generations.length) return {
      items: [], nextCursor: null,
      ...(input.includeStructuredActivities ? { activities: [], structuredActivitiesComplete: true } : {}),
    };

    let generationIndex = generations.length - 1;
    let localCursor: string | null = null;
    if (input.cursor) {
      const decoded = decodeLogicalConversationCursor(input.cursor);
      generationIndex = decoded.generationIndex;
      if (!Number.isSafeInteger(generationIndex) || generationIndex < 0 || generationIndex >= generations.length) {
        throw new Error('Conversation cursor is invalid');
      }
      localCursor = decoded.localCursor;
    }

    // A logical page never crosses a session-generation boundary. A short current
    // generation must not cause the same request to open a potentially huge archived
    // predecessor; the user explicitly pages across that boundary instead.
    const generation = generations[generationIndex];
    const page = await this.listConversation({
      correlationId: `${input.correlationId}:generation:${generation.generation}`,
      threadId: generation.threadId,
      targetAgentId: input.targetAgentId,
      cursor: localCursor,
      limit: input.limit,
      includeStructuredActivities: input.includeStructuredActivities,
    });
    const projected = page.items.map((message) => ({
      ...message,
      id: `${generation.threadId}:${message.id}`,
      sourceMessageId: message.id,
      kind: 'message' as const,
      threadId: generation.threadId,
      sessionGeneration: generation.generation
    }));
    const boundary = generationIndex < generations.length - 1 && localCursor === null
      ? [{
          id: `session-boundary:${generation.threadId}:${generations[generationIndex + 1].threadId}`,
          kind: 'session_boundary' as const,
          role: 'system' as const,
          targetAgentId: input.targetAgentId,
          authorLabel: 'Orquesta',
          text: 'Execution session continued in a fresh context.',
          createdAt: generations[generationIndex + 1].createdAt ?? generations[generationIndex + 1].updatedAt ?? new Date(0).toISOString(),
          evidenceLabel: null,
          threadId: generations[generationIndex + 1].threadId,
          sessionGeneration: generations[generationIndex + 1].generation,
          sessionBoundary: {
            fromGeneration: generation.generation,
            toGeneration: generations[generationIndex + 1].generation
          }
        }]
      : [];
    const nextCursor = page.nextCursor
      ? encodeLogicalConversationCursor(generationIndex, page.nextCursor)
      : generationIndex > 0
        ? encodeLogicalConversationCursor(generationIndex - 1, null)
        : null;
    return {
      items: [...projected, ...boundary],
      nextCursor,
      ...(input.includeStructuredActivities ? {
        activities: page.activities ?? [],
        structuredActivitiesComplete: page.structuredActivitiesComplete === true,
      } : {}),
    };
  }

  async getRuntimeInfo({ probe }: { probe: boolean }): Promise<RuntimeInfoUi> {
    try {
      const adapter = await this.adapter();
      const result = requireSuccessfulResult(await adapter.runtimeInfo({
        correlationId: probe ? 'desktop-runtime-probe' : 'desktop-runtime-info',
        probe
      }), 'runtimeInfo');
      if (probe) this.runtimeStarted = true;
      return {
        status: this.runtimeStarted ? 'ready' : 'not_started',
        adapter: 'app_server',
        sdkVersion: nullableString(result.sdk_version),
        codexVersion: nullableString(result.codex_version),
        runtimeVersion: nullableString(result.runtime_package_version),
        targetTriple: nullableString(result.target_triple),
        platformFamily: nullableString(result.platform_family),
        platformOs: nullableString(result.platform_os),
        userAgent: nullableString(result.user_agent),
        providerConnectionId: nullableString(result.provider_connection_id),
        integrity: this.integrity
      };
    } catch {
      return {
        status: 'unavailable',
        adapter: 'app_server',
        sdkVersion: null,
        codexVersion: null,
        runtimeVersion: null,
        targetTriple: null,
        platformFamily: null,
        platformOs: null,
        userAgent: null,
        providerConnectionId: null,
        integrity: this.integrity
      };
    }
  }

  async respondToApproval(input: {
    correlationId: string;
    requestId: string;
    providerConnectionId: string;
    decision: string;
  }): Promise<{
    requestId: string;
    providerConnectionId: string;
    decision: string;
  }> {
    if (this.shutdownRequested) throw new Error('Codex runtime is shutting down');
    const previous = this.approvalResponses.get(input.requestId);
    if (previous) {
      if (previous.status === 'definitive_failure') {
        // Nothing reached Provider. Native released the exact durable claim,
        // so a new response (including a changed decision) is safe.
        this.approvalResponses.delete(input.requestId);
      } else {
        if (previous.providerConnectionId !== input.providerConnectionId
          || previous.decision !== input.decision) {
          throw new Error('Approval response does not match the previously submitted decision');
        }
        if (previous.status === 'accepted' && previous.result) return structuredClone(previous.result);
        if (previous.status === 'outcome_unknown' && previous.error) throw previous.error;
        return previous.promise;
      }
    }
    const approval = this.pendingApprovals.get(input.requestId);
    if (!approval) throw new Error('No pending Codex approval request matches this id');
    if (approval.providerConnectionId !== input.providerConnectionId) {
      throw new ApprovalPreflightError('Approval provider connection does not match the pending request');
    }
    if (!approval.responseOptions.includes(input.decision)) {
      throw new Error('Decision is not a response option supplied by Codex');
    }
    const adapterRequestId = this.adapterApprovalIds.get(input.requestId);
    if (!adapterRequestId) throw new Error('Pending approval adapter identity is unavailable');

    let resolveAttempt!: (value: {
      requestId: string;
      providerConnectionId: string;
      decision: string;
    }) => void;
    let rejectAttempt!: (error: Error) => void;
    const promise = new Promise<{
      requestId: string;
      providerConnectionId: string;
      decision: string;
    }>((resolve, reject) => {
      resolveAttempt = resolve;
      rejectAttempt = reject;
    });
    // A second response can arrive while adapter initialization is awaiting. Publish
    // the single-flight attempt before crossing that boundary.
    const attempt: ApprovalResponseAttempt = {
      providerConnectionId: input.providerConnectionId,
      decision: input.decision,
      status: 'responding',
      promise,
      result: null,
      error: null
    };
    if (!this.makeApprovalCacheRoom()) {
      throw new Error('Approval response cache is at capacity');
    }
    this.approvalResponses.set(input.requestId, attempt);
    this.trackActiveOperation(promise);
    void (async () => {
      try {
        const adapter = await this.adapter();
        const stillPending = this.pendingApprovals.get(input.requestId);
        if (stillPending?.actionFingerprint !== approval.actionFingerprint
          || stillPending?.providerConnectionId !== input.providerConnectionId
          || this.adapterApprovalIds.get(input.requestId) !== adapterRequestId) {
          throw new ApprovalTerminalExpiredError();
        }
        const adapterResult = await adapter.respondToApproval({
          correlationId: approval.correlationId,
          requestId: adapterRequestId,
          method: approval.method,
          threadId: approval.threadId,
          turnId: approval.turnId,
          decision: input.decision
        });
        if (adapterResult.ok !== true) {
          const evidence = record(adapterResult.evidence);
          if (evidence?.approval_response_phase === 'pre_provider') {
            const adapterError = record(adapterResult.error);
            throw new ApprovalPreflightError(
              nonEmptyString(adapterError?.message) ?? 'Approval response failed before provider write'
            );
          }
        }
        requireSuccessfulResult(adapterResult, 'respondToApproval');
        const result = {
          requestId: input.requestId,
          providerConnectionId: input.providerConnectionId,
          decision: input.decision
        };
        attempt.status = 'accepted';
        attempt.result = result;
        this.pendingApprovals.delete(input.requestId);
        this.adapterApprovalIds.delete(input.requestId);
        this.publicApprovalIdsByAdapter.delete(adapterRequestId);
        resolveAttempt(structuredClone(result));
      } catch (error) {
        if (error instanceof ApprovalTerminalExpiredError || error instanceof ApprovalPreflightError) {
          attempt.status = 'definitive_failure';
          attempt.error = error;
          rejectAttempt(error);
        } else {
          const unknown = new ApprovalOutcomeUnknownError(error);
          attempt.status = 'outcome_unknown';
          attempt.error = unknown;
          rejectAttempt(unknown);
        }
      }
    })();
    return promise;
  }

  private makeApprovalCacheRoom(): boolean {
    while (this.approvalResponses.size >= RUNTIME_APPROVAL_RETENTION_LIMIT) {
      const evictable = [...this.approvalResponses.entries()]
        .find(([, attempt]) => attempt.status === 'accepted' || attempt.status === 'definitive_failure')?.[0];
      if (!evictable) return false;
      this.approvalResponses.delete(evictable);
    }
    return true;
  }

  private expireApprovals(threadId: string, turnId: string | null): void {
    if (!turnId) return;
    for (const [requestId, approval] of this.pendingApprovals) {
      if (approval.threadId !== threadId || approval.turnId !== turnId) continue;
      this.pendingApprovals.delete(requestId);
      const adapterRequestId = this.adapterApprovalIds.get(requestId);
      this.adapterApprovalIds.delete(requestId);
      if (adapterRequestId) this.publicApprovalIdsByAdapter.delete(adapterRequestId);
    }
    for (const listener of this.approvalExpirationListeners) listener(threadId, turnId);
  }

  private evidence(threadId: string): RuntimeModelEvidence {
    return structuredClone(this.evidenceByThread.get(threadId) ?? unknownModelEvidence());
  }

  private async recordDelivery(
    delivery: PendingDelivery,
    state: MessageDeliveryState,
    errorCode: string | null = null
  ): Promise<boolean> {
    return await this.messageLedger?.record({ ...delivery, state, errorCode }) ?? true;
  }

  private async handleAdapterEvent(event: UnknownRecord): Promise<void> {
    const type = nonEmptyString(event.type);
    const threadId = nonEmptyString(event.thread_id);
    if (!type || !threadId) return;
    const turnId = nullableString(event.turn_id);
    const correlationId = nonEmptyString(event.correlation_id);
    const projectId = this.projectByThread.get(threadId);
    // App Server subscriptions are connection-wide. Only frames for a thread
    // explicitly admitted by this Desktop service may reach delivery state,
    // approvals, conversation projection, or controller notifications. A
    // matching correlation id is not sufficient because it is caller input and
    // must never be allowed to rebind a pending delivery onto another thread.
    if (!projectId) return;
    const pendingDelivery = correlationId ? this.deliveryByCorrelation.get(correlationId) : null;
    const delivery = pendingDelivery?.threadId === threadId ? pendingDelivery : null;
    if (type === 'approval_expired' || type === 'turn_completed'
      || (type === 'runtime_error' && event.will_retry !== true)) {
      this.expireApprovals(threadId, turnId);
    }
    if (delivery) {
      delivery.threadId = threadId;
      delivery.turnId = turnId ?? delivery.turnId;
      if (type === 'dispatch_accepted') {
        await this.recordDelivery(delivery, 'dispatch_accepted');
        return;
      }
      if (type === 'turn_started') await this.recordDelivery(delivery, 'turn_started');
      if (type === 'runtime_error' && event.will_retry !== true) {
        await this.recordDelivery(delivery, 'failed', 'runtime_error');
        this.deliveryByCorrelation.delete(correlationId);
      }
      if (type === 'turn_completed') {
        const status = nullableString(event.status);
        const succeeded = !status || status === 'completed';
        await this.recordDelivery(delivery, succeeded ? 'completed' : 'failed', succeeded ? null : `turn_${status}`);
        this.deliveryByCorrelation.delete(correlationId);
      }
    }
    const targetAgentId = this.targetByThread.get(threadId) ?? null;
    if (type === 'provider_event') {
      const providerEvent = record(event.provider_event);
      if (!providerEvent) return;
      this.emit({
        kind: 'provider_event',
        correlationId,
        threadId,
        turnId,
        text: null,
        targetAgentId,
        occurredAt: this.options.now().toISOString(),
        providerEvent,
        modelEvidence: this.evidence(threadId)
      });
      return;
    }
    if (type === 'approval_requested') {
      const providerConnectionId = nonEmptyString(event.provider_connection_id);
      const correlationId = nonEmptyString(event.correlation_id);
      const adapterRequestId = nonEmptyString(event.request_id);
      const method = nonEmptyString(event.method);
      const requestedEffectRecord = record(event.requested_effect);
      const requestedEffectKind = nonEmptyString(requestedEffectRecord?.kind);
      const requestedEffectItemId = nonEmptyString(requestedEffectRecord?.item_id);
      const responseOptions = Array.isArray(event.response_options)
        ? event.response_options.flatMap((option) => nonEmptyString(option) ?? [])
        : [];
      if (!providerConnectionId || !correlationId || !turnId || !adapterRequestId
        || !ADAPTER_APPROVAL_ID_PATTERN.test(adapterRequestId) || !method
        || !requestedEffectKind || !requestedEffectItemId || responseOptions.length === 0 || responseOptions.length > 16) return;
      const fingerprintIdentity: ApprovalActionFingerprintInput = {
        adapterRequestId,
        projectId,
        providerConnectionId,
        correlationId,
        method,
        threadId,
        turnId,
        targetAgentId,
        requestedEffect: { kind: requestedEffectKind, itemId: requestedEffectItemId },
        responseOptions
      };
      const actionFingerprint = approvalActionFingerprint(fingerprintIdentity);
      const requestId = publicApprovalId(actionFingerprint);
      const existingPublicId = this.publicApprovalIdsByAdapter.get(adapterRequestId);
      if (existingPublicId && existingPublicId !== requestId) return;
      const known = this.pendingApprovals.get(requestId);
      if (known || this.approvalResponses.has(requestId)) return;
      const approval: RuntimeApprovalRequest = {
        projectId,
        providerConnectionId,
        correlationId,
        method,
        threadId,
        turnId,
        targetAgentId,
        requestedEffect: { kind: requestedEffectKind, itemId: requestedEffectItemId },
        reason: nullableString(event.reason),
        responseOptions,
        requestId,
        actionFingerprint
      };
      this.pendingApprovals.set(requestId, approval);
      this.adapterApprovalIds.set(requestId, adapterRequestId);
      this.publicApprovalIdsByAdapter.set(adapterRequestId, requestId);
      this.emitApproval(approval);
      return;
    }
    if (type === 'model_observed') {
      const model = nonEmptyString(event.model);
      if (!model) return;
      const evidence = this.evidence(threadId);
      evidence.actualModel = model;
      evidence.actualModelEvidence = 'proven';
      this.evidenceByThread.set(threadId, evidence);
      this.emit({ kind: 'model_observed', correlationId, threadId, turnId, text: null, targetAgentId, modelEvidence: evidence });
      return;
    }
    if (type === 'turn_started') {
      if (turnId) this.turnStartedAtByTurn.set(runtimeTurnKey(threadId, turnId), this.options.now().getTime());
      this.emit({ kind: 'turn_started', correlationId, threadId, turnId, text: null, targetAgentId, modelEvidence: this.evidence(threadId) });
      return;
    }
    if (type === 'runtime_error') {
      if (event.will_retry === true) return;
      if (turnId) this.turnStartedAtByTurn.delete(runtimeTurnKey(threadId, turnId));
      this.emit({
        kind: 'turn_failed', correlationId, threadId, turnId,
        text: nonEmptyString(event.message) ?? 'Codex turn failed.',
        targetAgentId,
        modelEvidence: this.evidence(threadId)
      });
      return;
    }
    if (type !== 'turn_completed') return;

    try {
      let newestAgentMessage: ConversationMessage | null = null;
      const adapter = await this.adapter();
      const historyCorrelationId = `${nonEmptyString(event.correlation_id) ?? 'desktop-completed'}:history`;
      const result = adapter.listThreadTurns
        ? requireSuccessfulResult(await adapter.listThreadTurns({
            correlationId: historyCorrelationId,
            threadId,
            cursor: null,
            limit: 1,
            sortDirection: 'desc',
            itemsView: 'summary'
          }), 'listThreadTurns')
        : requireSuccessfulResult(await adapter.readThread({
            correlationId: historyCorrelationId,
            threadId,
            includeTurns: true
          }), 'readThread');
      const pagedTurns = Array.isArray(result.turns) ? result.turns.flatMap((value) => record(value) ?? []) : null;
      const history = pagedTurns ? { turns: [...pagedTurns].reverse() } : record(result.thread);
      newestAgentMessage = history
        ? projectConversation(history, this.options.now(), targetAgentId)
            .filter((message) => message.role === 'agent').at(-1) ?? null
        : null;
      if (newestAgentMessage) {
        const key = `${threadId}:${newestAgentMessage.id}`;
        if (!this.seenAgentMessages.has(key)) {
          this.seenAgentMessages.add(key);
          this.emit({
            kind: 'agent_message',
            correlationId,
            threadId,
            turnId,
            text: newestAgentMessage.text,
            targetAgentId: newestAgentMessage.targetAgentId,
            itemId: newestAgentMessage.id,
            occurredAt: newestAgentMessage.createdAt,
            modelEvidence: this.evidence(threadId)
          });
        }
      }
    } catch {
      // Completion remains truthful even when the follow-up history read is unavailable.
    }
    const completionStatus = nullableString(event.status);
    if (turnId) this.turnStartedAtByTurn.delete(runtimeTurnKey(threadId, turnId));
    this.emit({
      kind: completionStatus && completionStatus !== 'completed' ? 'turn_failed' : 'turn_completed',
      correlationId,
      threadId,
      turnId,
      text: completionStatus && completionStatus !== 'completed' ? `Codex turn ${completionStatus}.` : null,
      targetAgentId,
      modelEvidence: this.evidence(threadId)
    });
  }

  shutdown(): Promise<void> {
    if (!this.shutdownPromise) {
      this.shutdownRequested = true;
      this.shutdownPromise = (async () => {
        let shutdownError: Error | null = null;
        try {
          const adapter = this.adapterPromise ? await this.adapterPromise.catch(() => null) : null;
          if (adapter) requireSuccessfulResult(
            await adapter.shutdown({ correlationId: 'desktop-runtime-shutdown' }),
            'shutdown'
          );
        } catch (error) {
          shutdownError = error instanceof Error ? error : new Error(String(error));
        }
        await Promise.allSettled([...this.activeOperations]);
        await this.eventQueue;
        const eventDrainError = this.eventDrainError;
        this.unsubscribeAdapter?.();
        this.unsubscribeAdapter = null;
        this.pendingApprovals.clear();
        this.adapterApprovalIds.clear();
        this.publicApprovalIdsByAdapter.clear();
        this.approvalResponses.clear();
        this.approvalListeners.clear();
        this.approvalExpirationListeners.clear();
        this.listeners.clear();
        if (shutdownError) throw shutdownError;
        if (eventDrainError) {
          throw new Error('Desktop runtime event and ledger drain failed', { cause: eventDrainError });
        }
      })();
    }
    return this.shutdownPromise;
  }
}
