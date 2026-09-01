import { createHash } from 'node:crypto';
import {
  createDomainEventEnvelopeV1,
  type DomainEventEnvelopeInputV1,
} from '../../../packages/local-core/src/contracts/domain-event-envelope';

type JsonRecord = Record<string, unknown>;

type CoordinatorOptions = {
  notify(value: JsonRecord): void;
  now?: () => string;
  suspendedBufferLimit?: number;
  suspendedBufferBytes?: number;
};

function projectionMessageId(threadId: string, sourceMessageId: string): string {
  return `projection-message-v1-${createHash('sha256')
    .update(`orquesta.projection.message.v1\0${threadId}\0${sourceMessageId}`, 'utf8')
    .digest('hex')}`;
}

function projectionTurnLifecycleItemId(threadId: string, turnId: string, kind: string): string {
  return `projection-turn-lifecycle-v1-${createHash('sha256')
    .update(`orquesta.projection.turn-lifecycle.v1\0${threadId}\0${turnId}\0${kind}`, 'utf8')
    .digest('hex')}`;
}

type Binding = {
  projectId: string;
  runtimeGeneration: string;
  activationToken: string;
  rendererSessionId: string;
  rendererGeneration: number;
  expectedStatusRevision: number;
};

type CoordinatorEventInput = Omit<DomainEventEnvelopeInputV1, 'projectId'>;

const providerKinds = new Set([
  'turn.started',
  'turn.completed',
  'item.started',
  'item.completed',
  'provider.failure',
  'model.observed',
  'message.agent.delta',
  'tool.started',
  'tool.completed',
  'tool.failed',
  'command.started',
  'command.completed',
  'command.failed',
  'file.change.started',
  'file.change.completed',
  'file.change.failed',
  'diff.updated',
  'plan.updated',
]);

function record(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function number(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => text(entry) ?? [])
    : [];
}

function boundedString(value: unknown, maximum: number, allowEmpty = false): string | null {
  return typeof value === 'string' && value.length <= maximum && !value.includes('\0')
    && (allowEmpty || value.length > 0) ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function publicProviderPayload(eventType: string, value: unknown, itemId: string | null): JsonRecord | null {
  const payload = record(value);
  if (!payload) return null;
  const nullableText = (entry: unknown, maximum: number): string | null | undefined => {
    if (entry === null) return null;
    return boundedString(entry, maximum) ?? undefined;
  };
  const nullableNonNegative = (entry: unknown): number | null | undefined => {
    if (entry === null) return null;
    return nonNegativeInteger(entry) ?? undefined;
  };
  if (eventType === 'message.agent.delta') {
    const delta = boundedString(payload.delta, 64 * 1024);
    return delta ? { delta } : null;
  }
  if (eventType === 'turn.started' || eventType === 'turn.completed') {
    const turnId = nullableText(payload.turn_id, 128);
    const status = nullableText(payload.status, 128);
    const itemCount = nullableNonNegative(payload.item_count);
    if (turnId === undefined || status === undefined || itemCount === undefined
      || payload.content_omitted !== true) return null;
    return { turn_id: turnId, status, item_count: itemCount, content_omitted: true };
  }
  if (eventType === 'item.started' || eventType === 'item.completed') {
    const payloadItemId = nullableText(payload.item_id, 128);
    const itemType = nullableText(payload.item_type, 256);
    const itemStatus = nullableText(payload.item_status, 128);
    if (payloadItemId === undefined || itemType === undefined || itemStatus === undefined
      || payload.content_omitted !== true) return null;
    return { item_id: payloadItemId, item_type: itemType, item_status: itemStatus, content_omitted: true };
  }
  if (eventType === 'provider.failure') {
    const code = payload.code === null || typeof payload.code === 'number' && Number.isSafeInteger(payload.code)
      ? payload.code : boundedString(payload.code, 256);
    const digest = payload.message_sha256 === null ? null
      : typeof payload.message_sha256 === 'string' && /^[a-f0-9]{64}$/u.test(payload.message_sha256)
        ? payload.message_sha256 : undefined;
    const willRetry = payload.will_retry;
    if (code === undefined || ![null, true, false].includes(willRetry as null | boolean)
      || typeof payload.message_present !== 'boolean' || digest === undefined) return null;
    return { code, will_retry: willRetry, message_present: payload.message_present, message_sha256: digest };
  }
  if (eventType === 'model.observed') {
    const fromModel = nullableText(payload.from_model, 256);
    const toModel = nullableText(payload.to_model, 256);
    if (fromModel === undefined || toModel === undefined || typeof payload.reason_present !== 'boolean') return null;
    return { from_model: fromModel, to_model: toModel, reason_present: payload.reason_present };
  }

  const kindByEvent: Record<string, string> = {
    'tool.started': 'tool', 'tool.completed': 'tool', 'tool.failed': 'tool',
    'command.started': 'command', 'command.completed': 'command', 'command.failed': 'command',
    'file.change.started': 'file_change', 'file.change.completed': 'file_change', 'file.change.failed': 'file_change',
    'diff.updated': 'diff', 'plan.updated': 'plan',
  };
  const activityKind = kindByEvent[eventType];
  const title = boundedString(payload.title, 4 * 1024);
  const state = boundedString(payload.activity_state, 128);
  if (!activityKind || payload.activity_kind !== activityKind || !title || !state) return null;
  const expectedState = eventType.endsWith('.started') ? ['running', 'unknown']
    : eventType.endsWith('.completed') ? ['completed', 'unknown']
      : eventType.endsWith('.failed') ? ['failed', 'declined', 'unknown'] : ['running', 'completed', 'updated', 'unknown'];
  if (!expectedState.includes(state)) return null;
  const common = { activity_kind: activityKind, activity_state: state, title };
  if (activityKind === 'command') {
    const commandName = boundedString(payload.command_name, 256);
    const actions = Array.isArray(payload.action_types) && payload.action_types.length <= 16
      && payload.action_types.every((entry) => Boolean(boundedString(entry, 256)))
      ? [...payload.action_types] : null;
    const duration = nullableNonNegative(payload.duration_ms);
    const outputBytes = nonNegativeInteger(payload.output_bytes);
    const outputText = nullableText(payload.output_text, 16_384);
    const exitCode = payload.exit_code === null || Number.isSafeInteger(payload.exit_code) ? payload.exit_code : undefined;
    if (!commandName || !actions || duration === undefined || outputBytes === null || outputText === undefined || exitCode === undefined
      || typeof payload.action_types_truncated !== 'boolean' || typeof payload.output_present !== 'boolean'
      || typeof payload.output_truncated !== 'boolean' || typeof payload.output_redacted !== 'boolean'
      || (payload.output_present ? typeof outputText !== 'string' : outputText !== null)
      || (!payload.output_present && outputBytes !== 0)
      || payload.cwd_omitted !== true || payload.command_arguments_omitted !== true || payload.content_omitted !== true) return null;
    return { ...common, command_name: commandName, action_types: actions,
      action_types_truncated: payload.action_types_truncated, exit_code: exitCode, duration_ms: duration,
      output_present: payload.output_present, output_bytes: outputBytes, output_text: outputText,
      output_truncated: payload.output_truncated, output_redacted: payload.output_redacted, cwd_omitted: true,
      command_arguments_omitted: true, content_omitted: true };
  }
  if (activityKind === 'tool') {
    const toolKind = boundedString(payload.tool_kind, 64);
    const toolName = boundedString(payload.tool_name, 256);
    const namespace = nullableText(payload.tool_namespace, 256);
    const duration = nullableNonNegative(payload.duration_ms);
    if (!toolKind || !['mcpToolCall', 'dynamicToolCall', 'collabAgentToolCall', 'webSearch'].includes(toolKind)
      || !toolName || namespace === undefined || duration === undefined
      || ![null, true, false].includes(payload.success as null | boolean)
      || payload.arguments_omitted !== true || payload.result_omitted !== true || payload.content_omitted !== true) return null;
    return { ...common, tool_kind: toolKind, tool_name: toolName, tool_namespace: namespace,
      duration_ms: duration, success: payload.success, arguments_omitted: true, result_omitted: true, content_omitted: true };
  }
  if (activityKind === 'file_change') {
    if (!Array.isArray(payload.changes) || payload.changes.length > 128) return null;
    const changes = payload.changes.flatMap((entry) => {
      const change = record(entry);
      const pathValue = boundedString(change?.path, 2_048);
      const changeKind = boundedString(change?.kind, 256);
      const originalBytes = nonNegativeInteger(change?.original_bytes);
      const addedLines = nonNegativeInteger(change?.added_lines);
      const removedLines = nonNegativeInteger(change?.removed_lines);
      return change && pathValue && changeKind && originalBytes !== null && addedLines !== null && removedLines !== null
        ? [{ path: pathValue, kind: changeKind, original_bytes: originalBytes, added_lines: addedLines, removed_lines: removedLines }]
        : [];
    });
    const changeCount = nonNegativeInteger(payload.change_count);
    if (changes.length !== payload.changes.length || changeCount === null || typeof payload.changes_truncated !== 'boolean'
      || payload.content_omitted !== true
      || (!payload.changes_truncated && changeCount !== changes.length)
      || (payload.changes_truncated && changeCount <= changes.length)) return null;
    return { ...common, changes, change_count: changeCount,
      changes_truncated: payload.changes_truncated, content_omitted: true };
  }
  if (activityKind === 'diff') {
    const originalBytes = nonNegativeInteger(payload.original_bytes);
    const addedLines = nonNegativeInteger(payload.added_lines);
    const removedLines = nonNegativeInteger(payload.removed_lines);
    if (originalBytes === null || addedLines === null || removedLines === null || payload.content_omitted !== true) return null;
    return { ...common, original_bytes: originalBytes, added_lines: addedLines, removed_lines: removedLines, content_omitted: true };
  }
  if (itemId) {
    const planText = boundedString(payload.text, 16_384, true);
    const originalBytes = nonNegativeInteger(payload.original_bytes);
    if (planText === null || originalBytes === null || typeof payload.truncated !== 'boolean' || typeof payload.redacted !== 'boolean') return null;
    return { ...common, text: planText, original_bytes: originalBytes, truncated: payload.truncated, redacted: payload.redacted };
  }
  if (!Array.isArray(payload.steps) || payload.steps.length > 64) return null;
  const steps = payload.steps.flatMap((entry) => {
    const step = record(entry);
    const status = boundedString(step?.status, 128);
    const stepText = boundedString(step?.text, 2_048, true);
    return step && status && ['pending', 'inProgress', 'completed'].includes(status) && stepText !== null
      && typeof step.truncated === 'boolean' && typeof step.redacted === 'boolean'
      ? [{ status, text: stepText, truncated: step.truncated, redacted: step.redacted }] : [];
  });
  const stepCount = nonNegativeInteger(payload.step_count);
  const explanation = nullableText(payload.explanation, 4_096);
  if (steps.length !== payload.steps.length || stepCount === null || explanation === undefined
    || typeof payload.steps_truncated !== 'boolean' || typeof payload.explanation_truncated !== 'boolean'
    || typeof payload.explanation_redacted !== 'boolean'
    || (!payload.steps_truncated && stepCount !== steps.length)
    || (payload.steps_truncated && stepCount <= steps.length)) return null;
  return { ...common, steps, step_count: stepCount, steps_truncated: payload.steps_truncated,
    explanation, explanation_truncated: payload.explanation_truncated,
    explanation_redacted: payload.explanation_redacted };
}

function providerPhase(eventType: string): string {
  if (eventType.endsWith('.started')) return 'started';
  if (eventType.endsWith('.completed')) return 'completed';
  if (eventType.endsWith('.failed')) return 'failed';
  if (eventType === 'provider.failure') return 'failed';
  if (eventType === 'message.agent.delta') return 'streaming';
  return 'observed';
}

export class ProjectionEventCoordinator {
  readonly #notify: (value: JsonRecord) => void;
  readonly #now: () => string;
  readonly #suspendedBufferLimit: number;
  readonly #suspendedBufferBytes: number;
  #binding: Binding | null = null;
  #suspended = false;
  readonly #bufferedDuringSuspend: CoordinatorEventInput[][] = [];
  #bufferedEventCount = 0;
  #bufferedByteCount = 0;
  #fault: Error | null = null;

  constructor(options: CoordinatorOptions) {
    this.#notify = options.notify;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#suspendedBufferLimit = options.suspendedBufferLimit ?? 100_000;
    this.#suspendedBufferBytes = options.suspendedBufferBytes ?? 4 * 1024 * 1024;
    if (!Number.isSafeInteger(this.#suspendedBufferLimit) || this.#suspendedBufferLimit < 1) {
      throw new TypeError('Projection suspended-event buffer limit must be a positive safe integer');
    }
    if (!Number.isSafeInteger(this.#suspendedBufferBytes) || this.#suspendedBufferBytes < 1) {
      throw new TypeError('Projection suspended-event byte limit must be a positive safe integer');
    }
  }

  bind(input: Binding): void {
    const projectId = text(input.projectId);
    const runtimeGeneration = text(input.runtimeGeneration);
    const activationToken = text(input.activationToken);
    const rendererSessionId = text(input.rendererSessionId);
    if (!projectId || !runtimeGeneration || !activationToken || !rendererSessionId
      || !Number.isSafeInteger(input.rendererGeneration) || input.rendererGeneration < 0
      || !Number.isSafeInteger(input.expectedStatusRevision) || input.expectedStatusRevision < 0) {
      throw new TypeError('Projection event binding requires exact native runtime authority');
    }
    const previous = this.#binding;
    const exact = previous?.projectId === projectId
      && previous.runtimeGeneration === runtimeGeneration
      && previous.activationToken === activationToken
      && previous.rendererSessionId === rendererSessionId
      && previous.rendererGeneration === input.rendererGeneration
      && previous.expectedStatusRevision === input.expectedStatusRevision;
    if (exact && !this.#suspended) {
      return;
    }
    const sameStream = previous?.projectId === projectId
      && previous.runtimeGeneration === runtimeGeneration;
    if (sameStream && this.#fault) {
      throw this.#fault;
    }
    this.#binding = {
      projectId,
      runtimeGeneration,
      activationToken,
      rendererSessionId,
      rendererGeneration: input.rendererGeneration,
      expectedStatusRevision: input.expectedStatusRevision,
    };
    this.#suspended = false;
    if (!sameStream) {
      this.#fault = null;
      this.#bufferedDuringSuspend.length = 0;
      this.#bufferedEventCount = 0;
      this.#bufferedByteCount = 0;
    }
    if (this.#bufferedDuringSuspend.length > 0) {
      const bufferedBatches = this.#bufferedDuringSuspend.splice(0);
      this.#bufferedEventCount = 0;
      this.#bufferedByteCount = 0;
      // The sidecar writes the bind ACK in this call stack. Deferring the flush
      // guarantees ACK-before-new-frame ordering so Native can release its
      // projection transition barrier without deadlocking the stdout reader.
      queueMicrotask(() => {
        for (const batch of bufferedBatches) this.#append(batch);
      });
    }
  }

  suspend(input: Binding): void {
    const binding = this.#binding;
    if (!binding
      || binding.projectId !== input.projectId
      || binding.runtimeGeneration !== input.runtimeGeneration
      || binding.activationToken !== input.activationToken
      || binding.rendererSessionId !== input.rendererSessionId
      || binding.rendererGeneration !== input.rendererGeneration
      || binding.expectedStatusRevision !== input.expectedStatusRevision) {
      throw new TypeError('Projection event suspend requires the exact current native authority');
    }
    this.#suspended = true;
  }

  unbind(): void {
    this.#binding = null;
    this.#suspended = false;
    this.#bufferedDuringSuspend.length = 0;
    this.#bufferedEventCount = 0;
    this.#bufferedByteCount = 0;
    this.#fault = null;
  }

  observeCoreEvent(value: unknown): void {
    const event = record(value);
    if (!event || !this.#binding || this.#fault) return;
    try {
      if (event.type === 'runtime.notification') {
        this.#observeRuntimeNotification(record(event.notification));
      } else if (event.type === 'runtime.approval.requested') {
        this.#observeApproval(record(event.approval));
      } else if (event.type === 'runtime.approval.expired') {
        this.#observeApprovalExpiration(event);
      }
    } catch (error) {
      this.#fail(error);
    }
  }

  observeResponse(method: string, params: JsonRecord, resultEvent: JsonRecord): void {
    if (!this.#binding || this.#fault) return;
    if (method === 'runtime.send' && resultEvent.type === 'runtime.dispatch.accepted') {
      const sourceMessageId = text(params.messageId);
      const messageText = text(params.text);
      const threadId = text(resultEvent.threadId);
      const turnId = text(resultEvent.turnId);
      if (!sourceMessageId || !messageText || !threadId || !turnId) return;
      const messageId = projectionMessageId(threadId, sourceMessageId);
      try {
        const targetAgentId = text(params.targetAgentId);
        const acceptedItemId = projectionTurnLifecycleItemId(threadId, turnId, 'turn.accepted');
        this.#append([{
          sourceRuntime: 'orquesta_core',
          sourceCursor: null,
          agentId: targetAgentId,
          taskId: null,
          threadId,
          turnId,
          itemId: acceptedItemId,
          kind: 'turn.accepted',
          phase: 'accepted',
          occurredAt: this.#now(),
          payload: { status: 'accepted', visibility: 'public' },
          evidenceRef: null,
        }, {
          sourceRuntime: 'orquesta_core',
          sourceCursor: null,
          agentId: targetAgentId,
          taskId: null,
          threadId,
          turnId,
          itemId: sourceMessageId,
          kind: 'conversation.message',
          phase: 'completed',
          occurredAt: this.#now(),
          payload: {
            messageId,
            role: 'user',
            text: messageText,
            targetAgentId,
            visibility: 'public',
          },
          evidenceRef: null,
        }]);
      } catch (error) {
        this.#fail(error);
      }
      return;
    }
    if (method === 'runtime.turn.steer'
      && resultEvent.type === 'runtime.turn.steer.accepted') {
      const steerId = text(resultEvent.steerId);
      const messageText = text(params.text);
      const targetAgentId = text(params.targetAgentId);
      const threadId = text(resultEvent.threadId);
      const turnId = text(resultEvent.turnId);
      if (!steerId || !messageText || !targetAgentId || !threadId || !turnId) return;
      try {
        this.#append({
          sourceRuntime: 'orquesta_core',
          sourceCursor: null,
          agentId: targetAgentId,
          taskId: null,
          threadId,
          turnId,
          itemId: steerId,
          kind: 'conversation.message',
          phase: 'completed',
          occurredAt: this.#now(),
          payload: {
            messageId: projectionMessageId(threadId, steerId),
            role: 'user',
            text: messageText,
            targetAgentId,
            visibility: 'public',
          },
          evidenceRef: null,
        });
      } catch (error) {
        this.#fail(error);
      }
      return;
    }
    if (method === 'runtime.turn.interrupt'
      && resultEvent.type === 'runtime.turn.interrupt.accepted') {
      const targetAgentId = text(params.targetAgentId);
      const threadId = text(resultEvent.threadId);
      const turnId = text(resultEvent.turnId);
      if (!targetAgentId || !threadId || !turnId) return;
      try {
        const interruptItemId = projectionTurnLifecycleItemId(threadId, turnId, 'turn.interrupt_accepted');
        this.#append({
          sourceRuntime: 'orquesta_core',
          sourceCursor: null,
          agentId: targetAgentId,
          taskId: null,
          threadId,
          turnId,
          itemId: interruptItemId,
          kind: 'turn.interrupt_accepted',
          phase: 'interrupting',
          occurredAt: this.#now(),
          payload: { status: 'interrupting', visibility: 'public' },
          evidenceRef: null,
        });
      } catch (error) {
        this.#fail(error);
      }
      return;
    }
    // Native SQLite owns approval response claims and terminal transitions.
    // Core acknowledgements must never create a second projection-resolution path.
  }

  #observeRuntimeNotification(notification: JsonRecord | null): void {
    if (!notification) return;
    const kind = text(notification.kind);
    if (kind === 'provider_event') {
      const providerEvent = record(notification.providerEvent);
      const eventType = text(providerEvent?.event_type);
      const providerStreamId = text(providerEvent?.provider_stream_id);
      const providerSequence = number(providerEvent?.provider_sequence);
      if (!eventType || !providerKinds.has(eventType) || !providerStreamId
        || providerSequence === null || providerSequence < 1) return;
      const scope = record(providerEvent?.scope);
      const payload = record(providerEvent?.payload);
      const threadId = text(scope?.thread_id) ?? text(notification.threadId);
      const itemId = text(scope?.item_id);
      const targetAgentId = text(notification.targetAgentId);
      // Inspection/workflow runs deliberately have no conversation owner. Their
      // provider frames remain available to their controllers, but must not enter
      // the user conversation journal or block its projection outbox.
      if (!targetAgentId) return;
      const safePayload = publicProviderPayload(eventType, payload, itemId);
      if (!safePayload) return;
      const projectedPayload = eventType === 'message.agent.delta'
        ? {
            messageId: threadId && itemId ? projectionMessageId(threadId, itemId) : null,
            role: 'agent',
            delta: safePayload.delta,
            targetAgentId,
            visibility: 'public',
          }
        : { ...safePayload, visibility: 'public' };
      this.#append({
        sourceRuntime: 'codex_app_server',
        sourceCursor: `${providerStreamId}:${providerSequence}`,
        agentId: targetAgentId,
        taskId: null,
        threadId,
        turnId: text(scope?.turn_id) ?? text(notification.turnId),
        itemId,
        kind: eventType,
        phase: providerPhase(eventType),
        occurredAt: text(notification.occurredAt) ?? this.#now(),
        payload: projectedPayload,
        evidenceRef: null,
      });
      return;
    }
    if (kind !== 'agent_message') return;
    const sourceMessageId = text(notification.itemId);
    const threadId = text(notification.threadId);
    const messageText = text(notification.text);
    const targetAgentId = text(notification.targetAgentId);
    // Final messages from ownerless inspection/workflow runs must follow the
    // same boundary as their provider deltas: controllers may consume them,
    // but they are not part of the user's agent conversation.
    if (!sourceMessageId || !threadId || !messageText || !targetAgentId) return;
    const messageId = projectionMessageId(threadId, sourceMessageId);
    this.#append({
      sourceRuntime: 'orquesta_core',
      sourceCursor: null,
      agentId: targetAgentId,
      taskId: null,
      threadId,
      turnId: text(notification.turnId),
      itemId: sourceMessageId,
      kind: 'conversation.message',
      phase: 'completed',
      occurredAt: text(notification.occurredAt) ?? this.#now(),
      payload: {
        messageId,
        role: 'agent',
        text: messageText,
        targetAgentId,
        visibility: 'public',
      },
      evidenceRef: null,
    });
  }

  #observeApproval(approval: JsonRecord | null): void {
    if (!approval) return;
    const requestId = text(approval.requestId);
    const threadId = text(approval.threadId);
    const turnId = text(approval.turnId);
    const method = text(approval.method);
    const providerConnectionId = text(approval.providerConnectionId);
    const responseOptions = stringArray(approval.responseOptions);
    if (!requestId || !threadId || !turnId || !method || !providerConnectionId || responseOptions.length === 0) return;
    const requestKey = `runtime-approval-${requestId}`;
    this.#append({
      sourceRuntime: 'orquesta_core',
      sourceCursor: null,
      agentId: text(approval.targetAgentId),
      taskId: null,
      threadId,
      turnId,
      itemId: requestKey,
      kind: 'attention.approval_requested',
      phase: 'pending',
      occurredAt: this.#now(),
      payload: {
        requestKey,
        requestId,
        providerConnectionId,
        method,
        // Provider approval reasons can contain commands, paths, or other
        // implementation detail. The renderer derives bounded copy from the
        // typed requestedEffect instead of publishing that provider text.
        prompt: null,
        responseOptions,
        requestedEffect: record(approval.requestedEffect),
        visibility: 'public',
      },
      evidenceRef: null,
    });
  }

  #observeApprovalExpiration(event: JsonRecord): void {
    const threadId = text(event.threadId);
    const turnId = text(event.turnId);
    if (!threadId || !turnId) return;
    this.#append({
      sourceRuntime: 'orquesta_core',
      sourceCursor: null,
      agentId: null,
      taskId: null,
      threadId,
      turnId,
      itemId: projectionTurnLifecycleItemId(threadId, turnId, 'attention.request_expired'),
      kind: 'attention.request_resolved',
      phase: 'expired',
      occurredAt: this.#now(),
      payload: { resolution: 'expired', visibility: 'public' },
      evidenceRef: null,
    });
  }

  #append(input: CoordinatorEventInput | CoordinatorEventInput[]): void {
    const binding = this.#binding;
    if (!binding) return;
    const inputs = Array.isArray(input) ? input : [input];
    if (this.#suspended) {
      const inputBytes = Buffer.byteLength(JSON.stringify(inputs), 'utf8');
      if (this.#bufferedEventCount + inputs.length > this.#suspendedBufferLimit
        || this.#bufferedByteCount + inputBytes > this.#suspendedBufferBytes) {
        this.#fail(new Error('Projection event suspended-event buffer exceeded its bound'));
        return;
      }
      this.#bufferedDuringSuspend.push([...inputs]);
      this.#bufferedEventCount += inputs.length;
      this.#bufferedByteCount += inputBytes;
      return;
    }
    const events = inputs.map((event) => (
      createDomainEventEnvelopeV1({ ...event, projectId: binding.projectId }) as unknown as JsonRecord
    ));
    this.#notify({
      protocolVersion: 1,
      type: 'projection.events.ingest',
      event: {
        projectId: binding.projectId,
        runtimeGeneration: binding.runtimeGeneration,
        activationToken: binding.activationToken,
        rendererSessionId: binding.rendererSessionId,
        rendererGeneration: binding.rendererGeneration,
        expectedStatusRevision: binding.expectedStatusRevision,
        events,
      },
    });
  }

  #fail(error: unknown): void {
    this.#fault = error instanceof Error ? error : new Error(String(error));
    this.#notify({
      protocolVersion: 1,
      type: 'projection.fault',
      event: {
        projectId: this.#binding?.projectId ?? null,
        code: 'projection_journal_fault',
        message: this.#fault.message.slice(0, 1024),
      },
    });
  }
}
