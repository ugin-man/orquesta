import type { RendererAuthority, RuntimeStatus } from '../../domain/models';
import { isRecord, parseRendererAuthority, parseRuntimeStatus } from '../../domain/validation';
import {
  NATIVE_COMMANDS, asError, invokeNative, invokeNativeResult, structuredNativeError, unwrapResult,
  type TauriTransport,
} from './native-bridge';

const CANCEL_SETTLE_TIMEOUT_MS = 1_500;

export interface RendererIdentity {
  current: string;
  previous: string | null;
}

function createUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') throw new Error('Secure UUID generation is unavailable.');
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function canonicalUuid(value: unknown): string | null {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
    ? value
    : null;
}

export function createRendererIdentity(): RendererIdentity {
  return { current: createUuid(), previous: null };
}

function replaceRendererIdentityFromNative(
  recoveryRendererSessionId: unknown,
  recoveryPreviousSessionId: unknown,
  resumeExactPending: boolean,
): RendererIdentity | null {
  const recoveryPrevious = recoveryPreviousSessionId === null
    ? null
    : canonicalUuid(recoveryPreviousSessionId);
  if (recoveryPreviousSessionId !== null && !recoveryPrevious) return null;
  const recoveryCurrent = resumeExactPending
    ? canonicalUuid(recoveryRendererSessionId)
    : createUuid();
  if (!recoveryCurrent || recoveryCurrent === recoveryPrevious) return null;
  return { current: recoveryCurrent, previous: recoveryPrevious };
}

export function createUuidValue(): string { return createUuid(); }

export function abortError(): DOMException { return new DOMException('The operation was aborted.', 'AbortError'); }

export function waitForRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function settleBestEffort(promise: Promise<unknown>, milliseconds = CANCEL_SETTLE_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    void promise.then(() => { clearTimeout(timer); resolve(); }, () => { clearTimeout(timer); resolve(); });
  });
}

export async function cancelRendererSessionNative(
  transport: TauriTransport,
  input: { rendererSessionId: string; rendererGeneration: number | null },
): Promise<RuntimeStatus> {
  const result = await invokeNativeResult(transport, NATIVE_COMMANDS.cancelRendererSession, input);
  if (!isRecord(result) || typeof result.cancelled !== 'boolean') throw new Error('Native renderer cancellation response is invalid.');
  return parseRuntimeStatus(result.runtimeStatus);
}

export async function openRendererSessionNative(input: {
  getTransport: () => Promise<TauriTransport>;
  identity: RendererIdentity;
  signal: AbortSignal;
  isDisposed: () => boolean;
  cancelAdmission: () => Promise<void>;
}): Promise<RendererAuthority> {
  let delay = 25;
  let nativeRecoveryUsed = false;
  const cancelOnAbort = () => { void input.cancelAdmission(); };
  input.signal.addEventListener('abort', cancelOnAbort, { once: true });
  try {
    while (!input.signal.aborted && !input.isDisposed()) {
      let raw: unknown;
      try {
        raw = await invokeNative<unknown>(await input.getTransport(), NATIVE_COMMANDS.openRendererSession, {
          rendererSessionId: input.identity.current,
          expectedPreviousSessionId: input.identity.previous,
        });
      } catch (error) {
        if (input.signal.aborted || input.isDisposed()) throw abortError();
        const native = structuredNativeError(error);
        if (native && !nativeRecoveryUsed) {
          const details = native.details;
          const hasPrevious = details !== undefined
            && Object.prototype.hasOwnProperty.call(details, 'recoveryPreviousSessionId');
          const resumeExactPending = native.code === 'renderer_session_recovery_required';
          const rotateRejectedCandidate = native.code === 'renderer_session_retired'
            || native.code === 'renderer_session_compare_failed';
          const replacement = hasPrevious && (resumeExactPending || rotateRejectedCandidate)
            ? replaceRendererIdentityFromNative(
                details?.recoveryRendererSessionId,
                details?.recoveryPreviousSessionId,
                resumeExactPending,
              )
            : null;
          if (replacement) {
            input.identity.current = replacement.current;
            input.identity.previous = replacement.previous;
            nativeRecoveryUsed = true;
            delay = 25;
            continue;
          }
        }
        if (native) throw asError(error);
        await waitForRetry(delay, input.signal);
        delay = Math.min(delay * 2, 500);
        continue;
      }
      if (input.signal.aborted || input.isDisposed()) {
        void input.cancelAdmission();
        throw abortError();
      }
      try {
        const renderer = parseRendererAuthority(unwrapResult(raw));
        if (renderer.rendererSessionId !== input.identity.current) throw new Error('Native renderer session response does not match the caller identity.');
        return renderer;
      } catch (error) {
        await input.cancelAdmission();
        throw error;
      }
    }
    throw abortError();
  } finally {
    input.signal.removeEventListener('abort', cancelOnAbort);
  }
}
