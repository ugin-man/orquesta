import type { DispatchRecovery, DispatchSendResult, RuntimeAuthority } from '../../domain/models';
import { isRecord, parseDispatchRecovery } from '../../domain/validation';
import type { SendMessageInput, SteerTurnInput } from '../../ports/desktop-client';
import { NATIVE_COMMANDS, invokeNative, unwrapResult, type TauriTransport } from './native-bridge';

export interface RuntimeTransportGuard {
  authority: RuntimeAuthority;
  runtimeGeneration: string;
  statusRevision: number;
}

export async function invokeRuntimeMethod(
  transport: TauriTransport,
  guard: RuntimeTransportGuard,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const raw = await invokeNative<unknown>(transport, NATIVE_COMMANDS.runtimeCall, {
    ...guard.authority,
    runtimeGeneration: guard.runtimeGeneration,
    expectedStatusRevision: guard.statusRevision,
    method,
    params,
    timeoutMs: null,
  });
  return unwrapResult(raw);
}

export async function dispatchMessageNative(
  transport: TauriTransport,
  guard: RuntimeTransportGuard,
  dispatchId: string,
  input: SendMessageInput,
): Promise<DispatchSendResult> {
  const raw = await invokeNative<unknown>(transport, NATIVE_COMMANDS.runtimeSend, {
    ...guard.authority,
    runtimeGeneration: guard.runtimeGeneration,
    expectedStatusRevision: guard.statusRevision,
    messageId: dispatchId,
    runtimeProjectId: guard.authority.projectId,
    targetAgentId: input.targetAgentId,
    text: input.text,
    threadId: null,
    threadTitle: null,
    attachmentRefs: input.attachmentRefs,
    selectedContextIds: [],
    additionalParams: {
      effort: input.effort,
      recommendedModel: null,
      requestedModel: input.model,
      sandbox: input.accessMode === 'full_access' ? 'danger-full-access' : 'workspace-write',
      approvalPolicy: input.accessMode === 'full_access' ? 'never' : 'on-request',
      serviceTier: input.serviceTier === 'fast' ? 'fast' : null,
    },
  });
  const result = unwrapResult(raw);
  if (!isRecord(result)) throw new Error('Native dispatch response is invalid.');
  const runtimeResult = result.runtimeResult;
  if (!isRecord(runtimeResult)
    || typeof runtimeResult.threadId !== 'string' || runtimeResult.threadId.length === 0 || runtimeResult.threadId.length > 128
    || typeof runtimeResult.turnId !== 'string' || runtimeResult.turnId.length === 0 || runtimeResult.turnId.length > 128) throw new Error('Dispatch receipt is invalid.');
  const dispatchRecovery = parseDispatchRecovery(result.dispatchRecovery ?? null);
  return {
    receipt: {
      dispatchId,
      threadId: runtimeResult.threadId,
      turnId: runtimeResult.turnId,
    },
    dispatchRecovery,
  };
}

export function recoveryFromNativeError(error: unknown): DispatchRecovery | null | undefined {
  const details = isRecord(error) && isRecord(error.details) ? error.details : null;
  if (!details || !('dispatchRecovery' in details)) return undefined;
  if (details.dispatchRecovery === null) return null;
  return parseDispatchRecovery(details.dispatchRecovery) ?? undefined;
}

export async function interruptTurnNative(
  transport: TauriTransport,
  guard: RuntimeTransportGuard,
  input: { targetAgentId: string; threadId: string; turnId: string },
): Promise<void> {
  const raw = await invokeNative<unknown>(transport, NATIVE_COMMANDS.interruptTurn, {
    ...guard.authority,
    runtimeGeneration: guard.runtimeGeneration,
    expectedStatusRevision: guard.statusRevision,
    ...input,
  });
  const result = unwrapResult(raw);
  if (!isRecord(result) || result.status !== 'interrupting'
    || result.targetAgentId !== input.targetAgentId
    || result.threadId !== input.threadId
    || result.turnId !== input.turnId) throw new Error('Native turn interrupt response is invalid.');
}

export async function steerTurnNative(
  transport: TauriTransport,
  guard: RuntimeTransportGuard,
  input: SteerTurnInput,
): Promise<void> {
  const raw = await invokeNative<unknown>(transport, NATIVE_COMMANDS.steerTurn, {
    ...guard.authority,
    runtimeGeneration: guard.runtimeGeneration,
    expectedStatusRevision: guard.statusRevision,
    ...input,
  });
  const result = unwrapResult(raw);
  if (!isRecord(result) || result.status !== 'accepted'
    || result.steerId !== input.steerId
    || result.targetAgentId !== input.targetAgentId
    || result.threadId !== input.threadId
    || result.turnId !== input.turnId) throw new Error('Native turn Steer response is invalid.');
}
