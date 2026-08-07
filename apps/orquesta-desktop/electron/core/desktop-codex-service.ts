import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as canonicalAdapterModule from '@orquesta/codex-adapter';
import type { ConversationMessage, ConversationPage, RuntimeInfoUi } from '../../src/contracts/bridge';
import type { AgentSessionGeneration } from './project-thread-reconciler';
import type { LucaAnswerPayload } from '../../src/contracts/luca';
import type { InspectionKind } from '../../src/contracts/orquesta-ui';
import type { SetupAccountState, SetupLoginStartResult } from '../../src/contracts/setup';
import { LUCA_TARGET_AGENT_ID } from '../shared/luca-runtime-profile';
import { MessageLedger, type MessageDeliveryState, type MessageLedgerWriter } from './message-ledger';
import type { RuntimeApprovalRequest, RuntimeModelEvidence, RuntimeNotification as DesktopRuntimeNotification } from './protocol';
import type { InspectionRuntimeBoundary } from './inspection-run-store';
import type { ProjectCodexThread } from './project-thread-reconciler';
import {
  ConversationProjectionStore,
  type ConversationProjectionReader,
  type ConversationProjectionRecord
} from './conversation-projection-store';
import { resolveDesktopSdkPackageRoot } from './runtime-location';
import { verifyDesktopRuntimeIntegrity } from './runtime-integrity';

type UnknownRecord = Record<string, unknown>;

export interface CanonicalCodexAdapter {
  createThread(input: UnknownRecord): Promise<UnknownRecord>;
  resumeThread(input: UnknownRecord): Promise<UnknownRecord>;
  setThreadName(input: UnknownRecord): Promise<UnknownRecord>;
  listThreads?(input: UnknownRecord): Promise<UnknownRecord>;
  startTurn(input: UnknownRecord): Promise<UnknownRecord>;
  interruptTurn(input: UnknownRecord): Promise<UnknownRecord>;
  readThread(input: UnknownRecord): Promise<UnknownRecord>;
  listThreadTurns?(input: UnknownRecord): Promise<UnknownRecord>;
  readAccount(input: UnknownRecord): Promise<UnknownRecord>;
  startLogin(input: UnknownRecord): Promise<UnknownRecord>;
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
  conversationProjection?: ConversationProjectionReader | null;
  conversationProjectionRoot?: string;
  codexHome?: string;
}

export interface DesktopRuntimeSendInput {
  correlationId: string;
  projectId: string;
  rootPath: string;
  threadId: string | null;
  targetAgentId: string;
  threadTitle?: string | null;
  text: string;
  localImagePaths: string[];
  recommendedModel: string | null;
  requestedModel: string | null;
  effort?: 'low' | 'medium' | 'high' | null;
  onThreadReady?: (threadId: string) => Promise<void> | void;
}

export interface DesktopLucaSendInput {
  correlationId: string;
  projectId: string;
  rootPath: string;
  threadId: string | null;
  prompt: string;
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

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function routeText(targetAgentId: string, text: string): string {
  return targetAgentId === 'orchestrator'
    ? text
    : `<orquesta_target agent_id="${targetAgentId}">\n${text}\n</orquesta_target>`;
}

function parseRouteText(text: string): { targetAgentId: string; text: string } {
  const match = /^<orquesta_target agent_id="([a-zA-Z0-9._:-]{1,128})">\n([\s\S]*)\n<\/orquesta_target>$/u.exec(text);
  return match ? { targetAgentId: match[1], text: match[2] } : { targetAgentId: 'orchestrator', text };
}

interface PendingDelivery {
  rootPath: string;
  messageId: string;
  correlationId: string;
  projectId: string;
  targetAgentId: string;
  threadId: string | null;
  turnId: string | null;
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
  defaultTargetAgentId = 'orchestrator'
): ConversationMessage[] {
  const turns = Array.isArray(thread.turns) ? thread.turns.flatMap((turn) => record(turn) ?? []) : [];
  const messages: ConversationMessage[] = [];
  for (const turn of turns) {
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
        let visibleText = routed.text;
        if (targetAgentId === LUCA_TARGET_AGENT_ID) {
          try {
            const envelope = record(JSON.parse(routed.text));
            const request = record(envelope?.request);
            visibleText = nonEmptyString(request?.displayQuestion) ?? routed.text;
          } catch {
            visibleText = routed.text;
          }
        }
        messages.push({
          id: nonEmptyString(item.id) ?? `user-${messages.length}`,
          role: 'user',
          targetAgentId,
          authorLabel: 'You',
          text: visibleText,
          createdAt: isoFromSeconds(turn.startedAt, fallback),
          evidenceLabel: 'Codex thread history'
        });
      } else if (item.type === 'agentMessage') {
        const text = nonEmptyString(item.text);
        if (!text) continue;
        const lucaAnswer = targetAgentId === LUCA_TARGET_AGENT_ID ? parseLucaAnswer(text) : null;
        messages.push(Object.assign({
          id: nonEmptyString(item.id) ?? `agent-${messages.length}`,
          role: 'agent',
          targetAgentId,
          authorLabel: targetAgentId === LUCA_TARGET_AGENT_ID ? 'Luca' : targetAgentId,
          text: lucaAnswer?.answer ?? text,
          createdAt: isoFromSeconds(turn.completedAt ?? turn.startedAt, fallback),
          evidenceLabel: lucaAnswer ? 'Luca structured answer' : 'Codex thread history'
        }, targetAgentId === LUCA_TARGET_AGENT_ID
          ? { lucaAnswer, structured: Boolean(lucaAnswer) }
          : {}));
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
          evidenceLabel: 'Codex thread history'
        });
      }
    }
  }
  return messages;
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

function projectStoredConversationMessage(
  item: ConversationProjectionRecord,
  defaultTargetAgentId: string
): ConversationMessage {
  const targetAgentId = item.targetAgentId ?? defaultTargetAgentId;
  let visibleText = item.text;
  if (item.role === 'user' && targetAgentId === LUCA_TARGET_AGENT_ID) {
    try {
      const envelope = record(JSON.parse(item.text));
      const request = record(envelope?.request);
      visibleText = nonEmptyString(request?.displayQuestion) ?? item.text;
    } catch {
      visibleText = item.text;
    }
  }
  const lucaAnswer = item.role === 'agent' && targetAgentId === LUCA_TARGET_AGENT_ID
    ? parseLucaAnswer(item.text)
    : null;
  return Object.assign({
    id: item.id,
    role: item.role,
    targetAgentId,
    authorLabel: item.role === 'user' ? 'You' : targetAgentId === LUCA_TARGET_AGENT_ID ? 'Luca' : targetAgentId,
    text: lucaAnswer?.answer ?? visibleText,
    createdAt: item.createdAt,
    evidenceLabel: lucaAnswer ? 'Luca structured answer' : 'Orquesta conversation projection'
  }, targetAgentId === LUCA_TARGET_AGENT_ID && item.role === 'agent'
    ? { lucaAnswer, structured: Boolean(lucaAnswer) }
    : {});
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
  private readonly evidenceByThread = new Map<string, RuntimeModelEvidence>();
  private readonly loadedThreadSignatures = new Map<string, string>();
  private readonly projectByThread = new Map<string, string>();
  private readonly targetByThread = new Map<string, string>();
  private readonly pendingApprovals = new Map<string, RuntimeApprovalRequest>();
  private readonly seenAgentMessages = new Set<string>();
  private readonly turnStartedAtByTurn = new Map<string, number>();
  private readonly messageLedger: MessageLedgerWriter | null;
  private readonly conversationProjection: ConversationProjectionReader | null;
  private readonly deliveryByCorrelation = new Map<string, PendingDelivery>();
  private eventQueue: Promise<void> = Promise.resolve();
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
    this.conversationProjection = options.conversationProjection === undefined
      ? options.conversationProjectionRoot
        ? new ConversationProjectionStore({
            storageRoot: options.conversationProjectionRoot,
            codexHome: options.codexHome,
            now: this.options.now
          })
        : null
      : options.conversationProjection;
  }

  subscribe(listener: (notification: DesktopRuntimeNotification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeApprovals(listener: (approval: RuntimeApprovalRequest) => void): () => void {
    this.approvalListeners.add(listener);
    return () => this.approvalListeners.delete(listener);
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

  async readAccount(): Promise<SetupAccountState> {
    try {
      const adapter = await this.adapter();
      const result = requireSuccessfulResult(await adapter.readAccount({ correlationId: randomUUID() }), 'readAccount');
      const requiresOpenaiAuth = result.requires_openai_auth;
      if (typeof requiresOpenaiAuth !== 'boolean') throw new Error('App Server account response is incomplete');
      if (result.account_type === 'chatgpt') {
        return { status: 'authenticated', accountType: 'chatgpt', requiresOpenaiAuth };
      }
      if (result.account_type === 'apiKey') {
        return { status: 'authenticated', accountType: 'api_key', requiresOpenaiAuth };
      }
      return { status: 'unauthenticated', accountType: null, requiresOpenaiAuth };
    } catch (error) {
      return {
        status: 'unavailable',
        accountType: null,
        requiresOpenaiAuth: null,
        reason: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async startChatGptLogin(): Promise<SetupLoginStartResult> {
    const adapter = await this.adapter();
    const result = requireSuccessfulResult(await adapter.startLogin({
      correlationId: randomUUID(),
      loginType: 'chatgpt'
    }), 'startLogin');
    const loginId = nonEmptyString(result.login_id);
    if (!loginId || result.login_type !== 'chatgpt') throw new Error('App Server login response is incomplete');
    return { type: 'chatgpt', loginId, authUrl: nullableString(result.auth_url) };
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
              runtimeRoot: path.join(resourcesPath, 'codex-runtime')
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
              this.eventQueue = this.eventQueue
                .then(() => this.handleAdapterEvent(event))
                .catch(() => undefined);
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
  }> {
    const delivery: PendingDelivery = {
      rootPath: input.rootPath,
      messageId: input.correlationId,
      correlationId: input.correlationId,
      projectId: input.projectId,
      targetAgentId: input.targetAgentId,
      threadId: input.threadId,
      turnId: null
    };
    this.deliveryByCorrelation.set(input.correlationId, delivery);
    await this.recordDelivery(delivery, 'queued');
    try {
      const result = await this.dispatchMessage(input);
      delivery.threadId = result.threadId;
      delivery.turnId = result.turnId;
      await this.recordDelivery(delivery, 'dispatch_accepted');
      return result;
    } catch (error) {
      await this.recordDelivery(delivery, 'failed', error instanceof Error ? error.name : 'dispatch_failed');
      this.deliveryByCorrelation.delete(input.correlationId);
      throw error;
    }
  }

  private async dispatchMessage(input: DesktopRuntimeSendInput): Promise<{
    threadId: string;
    turnId: string;
    modelEvidence: RuntimeModelEvidence;
  }> {
    const adapter = await this.adapter();
    const params: UnknownRecord = { cwd: input.rootPath };
    if (input.requestedModel) params.model = input.requestedModel;
    const loadSignature = JSON.stringify([
      input.rootPath.replaceAll('\\', '/').toLowerCase(),
      input.recommendedModel,
      input.requestedModel
    ]);
    const canReuseLoadedThread = Boolean(input.threadId)
      && this.loadedThreadSignatures.get(input.threadId!) === loadSignature;
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
    this.loadedThreadSignatures.set(threadId, loadSignature);
    const threadTitle = nonEmptyString(input.threadTitle);
    if (threadTitle) {
      const nameResult = await adapter.setThreadName({
        correlationId: `${input.correlationId}:name`,
        threadId,
        name: threadTitle
      });
      const failedName = record(nameResult);
      if (failedName?.ok !== false || failedName.status !== 'unsupported') {
        requireSuccessfulResult(nameResult, 'setThreadName');
      }
    }
    await input.onThreadReady?.(threadId);
    const evidence = threadResult
      ? modelEvidenceFromThreadResult(threadResult, input.recommendedModel, input.requestedModel)
      : structuredClone(this.evidenceByThread.get(threadId) ?? unknownModelEvidence());
    this.evidenceByThread.set(threadId, evidence);
    this.projectByThread.set(threadId, input.projectId);
    this.targetByThread.set(threadId, input.targetAgentId);
    const turnStartedAt = this.options.now().getTime();
    let turnResult: UnknownRecord;
    try {
      turnResult = requireSuccessfulResult(await adapter.startTurn({
        correlationId: input.correlationId,
        threadId,
        input: [
          { type: 'text', text: routeText(input.targetAgentId, input.text), text_elements: [] },
          ...input.localImagePaths.map((filePath) => ({ type: 'localImage', path: filePath }))
        ],
        ...(input.effort ? { params: { effort: input.effort } } : {})
      }), 'startTurn');
    } catch (error) {
      // If App Server discarded its in-memory task state, the next explicit retry
      // must resume from durable storage instead of trusting the local cache.
      this.loadedThreadSignatures.delete(threadId);
      throw error;
    }
    const turnId = nonEmptyString(turnResult.turn_id);
    if (!turnId) throw new Error('Codex App Server did not accept the turn');
    this.turnStartedAtByTurn.set(`${threadId}:${turnId}`, turnStartedAt);
    this.runtimeStarted = true;
    return { threadId, turnId, modelEvidence: structuredClone(evidence) };
  }

  async sendLucaQuestion(input: DesktopLucaSendInput): Promise<{
    threadId: string;
    turnId: string;
    modelEvidence: RuntimeModelEvidence;
  }> {
    return this.sendMessage({
      correlationId: input.correlationId,
      projectId: input.projectId,
      rootPath: input.rootPath,
      threadId: input.threadId,
      targetAgentId: LUCA_TARGET_AGENT_ID,
      text: input.prompt,
      localImagePaths: [],
      recommendedModel: null,
      requestedModel: null,
      effort: null
    });
  }

  async startInspection(input: DesktopInspectionStartInput): Promise<{
    threadId: string;
    turnId: string;
    runtimeBoundary: InspectionRuntimeBoundary;
  }> {
    if (this.shutdownRequested) throw new Error('Codex runtime is shutting down');
    const adapter = await this.adapter();
    const runtimeBoundary: InspectionRuntimeBoundary = {
      sandbox: 'read-only',
      approvalPolicy: 'never',
      webSearchMode: input.kind === 'external_benchmark' ? 'live' : 'disabled'
    };
    const threadResult = requireSuccessfulResult(await adapter.createThread({
      correlationId: `${input.correlationId}:thread`,
      params: {
        cwd: input.rootPath,
        sandbox: runtimeBoundary.sandbox,
        approvalPolicy: runtimeBoundary.approvalPolicy,
        webSearchMode: runtimeBoundary.webSearchMode
      }
    }), 'createThread');
    const threadId = nonEmptyString(threadResult.thread_id);
    if (!threadId) throw new Error('Codex App Server did not return a thread id');
    const profile = record(threadResult.runtime_profile);
    if (profile?.sandbox !== runtimeBoundary.sandbox
      || profile.approval_policy !== runtimeBoundary.approvalPolicy
      || profile.requested_web_search_mode !== runtimeBoundary.webSearchMode) {
      throw new Error('read_only_boundary_violation: Codex App Server did not apply the requested inspection profile');
    }
    this.evidenceByThread.set(threadId, unknownModelEvidence());
    this.projectByThread.set(threadId, input.projectId);
    const turnResult = requireSuccessfulResult(await adapter.startTurn({
      correlationId: input.correlationId,
      threadId,
      input: [{ type: 'text', text: input.prompt, text_elements: [] }]
    }), 'startTurn');
    const turnId = nonEmptyString(turnResult.turn_id);
    if (!turnId) throw new Error('Codex App Server did not accept the inspection turn');
    this.runtimeStarted = true;
    return { threadId, turnId, runtimeBoundary: structuredClone(runtimeBoundary) };
  }

  async interruptInspection(input: { correlationId: string; threadId: string; turnId: string }): Promise<void> {
    if (this.shutdownRequested) throw new Error('Codex runtime is shutting down');
    const adapter = await this.adapter();
    requireSuccessfulResult(await adapter.interruptTurn(input), 'interruptTurn');
  }

  async readInspectionThread(input: { correlationId: string; threadId: string }): Promise<{
    finalResponse: string | null;
    completed: boolean;
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
    const messages = projectConversation(thread, this.options.now()).filter((message) => message.role === 'agent');
    return {
      finalResponse: messages.at(-1)?.text ?? null,
      completed: latestTurn?.status === 'completed' || latestTurn?.status === 'failed'
    };
  }

  async listConversation(input: {
    correlationId: string;
    threadId: string;
    targetAgentId: string;
    cursor?: string | null;
    limit: number;
  }): Promise<ConversationPage> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 200) {
      throw new Error('Conversation limit must be an integer from 1 to 200');
    }
    if (this.conversationProjection) {
      try {
        const projected = await this.conversationProjection.listPage({
          threadId: input.threadId,
          targetAgentId: input.targetAgentId,
          cursor: input.cursor ?? null,
          limit: input.limit
        });
        if (projected) {
          const messages = projected.items
            .map((item) => projectStoredConversationMessage(item, input.targetAgentId))
            .filter((message) => message.targetAgentId === input.targetAgentId);
          for (const message of messages) {
            if (message.role === 'agent') this.seenAgentMessages.add(`${input.threadId}:${message.id}`);
          }
          return { items: messages, nextCursor: projected.nextCursor };
        }
      } catch (error) {
        if (input.cursor?.startsWith('projection:')) throw error;
        // A missing, stale, or unreadable local projection falls back to Codex history.
      }
    }
    const adapter = await this.adapter();
    if (adapter.listThreadTurns) {
      const result = requireSuccessfulResult(await adapter.listThreadTurns({
        correlationId: input.correlationId,
        threadId: input.threadId,
        cursor: input.cursor ?? null,
        limit: Math.min(input.limit, 50),
        sortDirection: 'desc',
        itemsView: 'summary'
      }), 'listThreadTurns');
      const newestFirst = Array.isArray(result.turns) ? result.turns.flatMap((value) => record(value) ?? []) : [];
      const messages = projectConversation(
        { turns: [...newestFirst].reverse() },
        this.options.now(),
        input.targetAgentId
      ).filter((message) => message.targetAgentId === input.targetAgentId);
      for (const message of messages) {
        if (message.role === 'agent') this.seenAgentMessages.add(`${input.threadId}:${message.id}`);
      }
      this.runtimeStarted = true;
      return { items: messages, nextCursor: nullableString(result.next_cursor) };
    }
    const result = requireSuccessfulResult(await adapter.readThread({
      correlationId: input.correlationId,
      threadId: input.threadId,
      includeTurns: true
    }), 'readThread');
    const thread = record(result.thread);
    if (!thread) throw new Error('Codex App Server returned invalid thread history');
    this.runtimeStarted = true;
    const messages = projectConversation(thread, this.options.now(), input.targetAgentId)
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
    return { items: messages.slice(start, end), nextCursor: start > 0 ? `before:${start}` : null };
  }

  async listLogicalConversation(input: {
    correlationId: string;
    targetAgentId: string;
    generations: AgentSessionGeneration[];
    cursor?: string | null;
    limit: number;
  }): Promise<ConversationPage> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 200) {
      throw new Error('Conversation limit must be an integer from 1 to 200');
    }
    const generations = [...input.generations]
      .filter((generation) => generation.threadId)
      .sort((left, right) => left.generation - right.generation || left.threadId.localeCompare(right.threadId));
    if (!generations.length) return { items: [], nextCursor: null };

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
      limit: input.limit
    });
    const projected = page.items.map((message) => ({
      ...message,
      id: `${generation.threadId}:${message.id}`,
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
    return { items: [...projected, ...boundary], nextCursor };
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
        integrity: this.integrity
      };
    }
  }

  async respondToApproval(input: { correlationId: string; requestId: string; decision: string }): Promise<{
    requestId: string;
    decision: string;
  }> {
    if (this.shutdownRequested) throw new Error('Codex runtime is shutting down');
    const approval = this.pendingApprovals.get(input.requestId);
    if (!approval) throw new Error('No pending Codex approval request matches this id');
    if (!approval.responseOptions.includes(input.decision)) {
      throw new Error('Decision is not a response option supplied by Codex');
    }
    const adapter = await this.adapter();
    requireSuccessfulResult(await adapter.respondToApproval({
      correlationId: approval.correlationId,
      requestId: approval.requestId,
      method: approval.method,
      threadId: approval.threadId,
      turnId: approval.turnId,
      decision: input.decision
    }), 'respondToApproval');
    this.pendingApprovals.delete(input.requestId);
    return { requestId: input.requestId, decision: input.decision };
  }

  private evidence(threadId: string): RuntimeModelEvidence {
    return structuredClone(this.evidenceByThread.get(threadId) ?? unknownModelEvidence());
  }

  private async recordDelivery(
    delivery: PendingDelivery,
    state: MessageDeliveryState,
    errorCode: string | null = null
  ): Promise<void> {
    await this.messageLedger?.record({ ...delivery, state, errorCode });
  }

  private async handleAdapterEvent(event: UnknownRecord): Promise<void> {
    const type = nonEmptyString(event.type);
    const threadId = nonEmptyString(event.thread_id);
    if (!type || !threadId) return;
    const turnId = nullableString(event.turn_id);
    const correlationId = nonEmptyString(event.correlation_id);
    const delivery = correlationId ? this.deliveryByCorrelation.get(correlationId) : null;
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
    if (type === 'approval_requested') {
      const projectId = this.projectByThread.get(threadId);
      const correlationId = nonEmptyString(event.correlation_id);
      const requestId = nonEmptyString(event.request_id);
      const method = nonEmptyString(event.method);
      const responseOptions = Array.isArray(event.response_options)
        ? event.response_options.flatMap((option) => nonEmptyString(option) ?? [])
        : [];
      if (!projectId || !correlationId || !turnId || !requestId || !method || responseOptions.length === 0 || responseOptions.length > 16) return;
      if (this.pendingApprovals.has(requestId)) return;
      const approval: RuntimeApprovalRequest = {
        projectId,
        correlationId,
        requestId,
        method,
        threadId,
        turnId,
        reason: nullableString(event.reason),
        responseOptions
      };
      this.pendingApprovals.set(requestId, approval);
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
      if (turnId) this.turnStartedAtByTurn.set(`${threadId}:${turnId}`, this.options.now().getTime());
      this.emit({ kind: 'turn_started', correlationId, threadId, turnId, text: null, targetAgentId, modelEvidence: this.evidence(threadId) });
      return;
    }
    if (type === 'runtime_error') {
      if (event.will_retry === true) return;
      if (turnId) this.turnStartedAtByTurn.delete(`${threadId}:${turnId}`);
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
      if (this.conversationProjection) {
        const projected = await this.conversationProjection.listPage({
          threadId,
          targetAgentId,
          cursor: null,
          limit: 4
        });
        newestAgentMessage = projected?.items
          .map((item) => projectStoredConversationMessage(item, targetAgentId))
          .filter((message) => message.role === 'agent').at(-1) ?? null;
        const startedAt = turnId ? this.turnStartedAtByTurn.get(`${threadId}:${turnId}`) : null;
        if (newestAgentMessage && startedAt
          && Date.parse(newestAgentMessage.createdAt) + 5_000 < startedAt) {
          newestAgentMessage = null;
        }
      }
      if (!newestAgentMessage || this.seenAgentMessages.has(`${threadId}:${newestAgentMessage.id}`)) {
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
      }
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
            modelEvidence: this.evidence(threadId)
          });
        }
      }
    } catch {
      // Completion remains truthful even when the follow-up history read is unavailable.
    }
    const completionStatus = nullableString(event.status);
    if (turnId) this.turnStartedAtByTurn.delete(`${threadId}:${turnId}`);
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
        const adapter = this.adapterPromise ? await this.adapterPromise.catch(() => null) : null;
        this.unsubscribeAdapter?.();
        this.unsubscribeAdapter = null;
        if (adapter) await adapter.shutdown({ correlationId: 'desktop-runtime-shutdown' });
        this.pendingApprovals.clear();
        this.approvalListeners.clear();
        this.listeners.clear();
      })();
    }
    return this.shutdownPromise;
  }
}
