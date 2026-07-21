import path from 'node:path';
import * as canonicalAdapterModule from '@orquesta/codex-adapter';
import type { ConversationMessage, ConversationPage, RuntimeInfoUi } from '../../src/contracts/bridge';
import type { InspectionKind } from '../../src/contracts/orquesta-ui';
import type { RuntimeApprovalRequest, RuntimeModelEvidence, RuntimeNotification as DesktopRuntimeNotification } from './protocol';
import type { InspectionRuntimeBoundary } from './inspection-run-store';
import { resolveDesktopSdkPackageRoot } from './runtime-location';
import { verifyDesktopRuntimeIntegrity } from './runtime-integrity';

type UnknownRecord = Record<string, unknown>;

export interface CanonicalCodexAdapter {
  createThread(input: UnknownRecord): Promise<UnknownRecord>;
  resumeThread(input: UnknownRecord): Promise<UnknownRecord>;
  startTurn(input: UnknownRecord): Promise<UnknownRecord>;
  interruptTurn(input: UnknownRecord): Promise<UnknownRecord>;
  readThread(input: UnknownRecord): Promise<UnknownRecord>;
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
}

export interface DesktopRuntimeSendInput {
  correlationId: string;
  projectId: string;
  rootPath: string;
  threadId: string | null;
  targetAgentId: string;
  text: string;
  localImagePaths: string[];
  recommendedModel: string | null;
  requestedModel: string | null;
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

function projectConversation(thread: UnknownRecord, fallback: Date): ConversationMessage[] {
  const turns = Array.isArray(thread.turns) ? thread.turns.flatMap((turn) => record(turn) ?? []) : [];
  const messages: ConversationMessage[] = [];
  for (const turn of turns) {
    const items = Array.isArray(turn.items) ? turn.items.flatMap((item) => record(item) ?? []) : [];
    let targetAgentId = 'orchestrator';
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
        targetAgentId = routed.targetAgentId;
        messages.push({
          id: nonEmptyString(item.id) ?? `user-${messages.length}`,
          role: 'user',
          targetAgentId,
          authorLabel: 'You',
          text: routed.text,
          createdAt: isoFromSeconds(turn.startedAt, fallback),
          evidenceLabel: 'Codex thread history'
        });
      } else if (item.type === 'agentMessage') {
        const text = nonEmptyString(item.text);
        if (!text) continue;
        messages.push({
          id: nonEmptyString(item.id) ?? `agent-${messages.length}`,
          role: 'agent',
          targetAgentId,
          authorLabel: 'Coordinator',
          text,
          createdAt: isoFromSeconds(turn.completedAt ?? turn.startedAt, fallback),
          evidenceLabel: 'Codex thread history'
        });
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
  private readonly projectByThread = new Map<string, string>();
  private readonly pendingApprovals = new Map<string, RuntimeApprovalRequest>();
  private readonly seenAgentMessages = new Set<string>();
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
  }

  subscribe(listener: (notification: DesktopRuntimeNotification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeApprovals(listener: (approval: RuntimeApprovalRequest) => void): () => void {
    this.approvalListeners.add(listener);
    return () => this.approvalListeners.delete(listener);
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
    const adapter = await this.adapter();
    const params: UnknownRecord = { cwd: input.rootPath };
    if (input.requestedModel) params.model = input.requestedModel;
    const threadResult = requireSuccessfulResult(
      await (input.threadId
        ? adapter.resumeThread({
            correlationId: `${input.correlationId}:thread`,
            threadId: input.threadId,
            recommendedModel: input.recommendedModel,
            requestedModel: input.requestedModel,
            params
          })
        : adapter.createThread({
            correlationId: `${input.correlationId}:thread`,
            recommendedModel: input.recommendedModel,
            requestedModel: input.requestedModel,
            params
          })),
      input.threadId ? 'resumeThread' : 'createThread'
    );
    const threadId = nonEmptyString(threadResult.thread_id);
    if (!threadId) throw new Error('Codex App Server did not return a thread id');
    const evidence = modelEvidenceFromThreadResult(threadResult, input.recommendedModel, input.requestedModel);
    this.evidenceByThread.set(threadId, evidence);
    this.projectByThread.set(threadId, input.projectId);
    const turnResult = requireSuccessfulResult(await adapter.startTurn({
      correlationId: input.correlationId,
      threadId,
      input: [
        { type: 'text', text: routeText(input.targetAgentId, input.text), text_elements: [] },
        ...input.localImagePaths.map((filePath) => ({ type: 'localImage', path: filePath }))
      ]
    }), 'startTurn');
    const turnId = nonEmptyString(turnResult.turn_id);
    if (!turnId) throw new Error('Codex App Server did not accept the turn');
    this.runtimeStarted = true;
    return { threadId, turnId, modelEvidence: structuredClone(evidence) };
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
    const result = requireSuccessfulResult(await adapter.readThread({
      correlationId: input.correlationId,
      threadId: input.threadId,
      includeTurns: true
    }), 'readThread');
    const thread = record(result.thread);
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
    const adapter = await this.adapter();
    const result = requireSuccessfulResult(await adapter.readThread({
      correlationId: input.correlationId,
      threadId: input.threadId,
      includeTurns: true
    }), 'readThread');
    const thread = record(result.thread);
    if (!thread) throw new Error('Codex App Server returned invalid thread history');
    this.runtimeStarted = true;
    const messages = projectConversation(thread, this.options.now())
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

  private async handleAdapterEvent(event: UnknownRecord): Promise<void> {
    const type = nonEmptyString(event.type);
    const threadId = nonEmptyString(event.thread_id);
    if (!type || !threadId) return;
    const turnId = nullableString(event.turn_id);
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
      this.emit({ kind: 'model_observed', threadId, turnId, text: null, targetAgentId: null, modelEvidence: evidence });
      return;
    }
    if (type === 'turn_started') {
      this.emit({ kind: 'turn_started', threadId, turnId, text: null, targetAgentId: null, modelEvidence: this.evidence(threadId) });
      return;
    }
    if (type === 'runtime_error') {
      this.emit({
        kind: 'turn_failed', threadId, turnId,
        text: nonEmptyString(event.message) ?? 'Codex turn failed.',
        targetAgentId: null,
        modelEvidence: this.evidence(threadId)
      });
      return;
    }
    if (type !== 'turn_completed') return;

    const adapter = await this.adapter();
    try {
      const result = requireSuccessfulResult(await adapter.readThread({
        correlationId: `${nonEmptyString(event.correlation_id) ?? 'desktop-completed'}:history`,
        threadId,
        includeTurns: true
      }), 'readThread');
      const history = record(result.thread);
      const newestAgentMessage = history
        ? projectConversation(history, this.options.now()).filter((message) => message.role === 'agent').at(-1)
        : null;
      if (newestAgentMessage) {
        const key = `${threadId}:${newestAgentMessage.id}`;
        if (!this.seenAgentMessages.has(key)) {
          this.seenAgentMessages.add(key);
          this.emit({
            kind: 'agent_message',
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
    this.emit({ kind: 'turn_completed', threadId, turnId, text: null, targetAgentId: null, modelEvidence: this.evidence(threadId) });
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
