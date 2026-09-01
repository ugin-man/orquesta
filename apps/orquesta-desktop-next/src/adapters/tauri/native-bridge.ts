import {
  NATIVE_BRIDGE_SCHEMA_VERSION,
  NATIVE_BRIDGE_TAURI,
  NATIVE_BINARY_TRANSPORTS,
  NATIVE_COMMANDS,
  NATIVE_EVENTS,
} from '../../../../../packages/contracts/generated/desktop/native-bridge-contract';
import { isRecord } from '../../domain/validation';

if (NATIVE_BRIDGE_SCHEMA_VERSION !== 1
  || NATIVE_BRIDGE_TAURI.argumentKey !== 'input'
  || NATIVE_BRIDGE_TAURI.rejectUnknownCommands !== true
  || NATIVE_BRIDGE_TAURI.responseEnvelope.schemaVersion !== 1
  || NATIVE_BRIDGE_TAURI.responseEnvelope.resultKey !== 'result') {
  throw new Error('Native bridge contract v1 is invalid or unsupported.');
}

export { NATIVE_BINARY_TRANSPORTS, NATIVE_COMMANDS, NATIVE_EVENTS };

export interface TauriEvent<T = unknown> {
  payload: T;
}

export interface TauriTransport {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  invokeRawRequest<T>(command: string, body: Uint8Array, headers: Readonly<Record<string, string>>): Promise<T>;
  invokeRawResponse(command: string, args: Record<string, unknown>): Promise<unknown>;
  listen<T>(event: string, listener: (event: TauriEvent<T>) => void): Promise<() => void>;
}

export interface StructuredNativeError {
  code: string;
  message: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

export function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

export function nativeArgs(input: Record<string, unknown>): Record<string, unknown> {
  return { input: { schemaVersion: 1, ...input } };
}

type NativeBodyMode = 'json_envelope' | 'raw_octet_stream';

const KNOWN_NATIVE_COMMANDS = new Set<string>(Object.values(NATIVE_COMMANDS));
const BINARY_TRANSPORT_BY_WIRE = new Map<string, Readonly<{ request: NativeBodyMode; response: NativeBodyMode }>>(
  Object.entries(NATIVE_BINARY_TRANSPORTS).map(([name, transport]) => [
    NATIVE_COMMANDS[name as keyof typeof NATIVE_COMMANDS], transport,
  ]),
);

function requireBodyMode(command: string, request: NativeBodyMode, response: NativeBodyMode): void {
  if (!KNOWN_NATIVE_COMMANDS.has(command)) throw new Error(`Unknown native command: ${command}`);
  const actual = BINARY_TRANSPORT_BY_WIRE.get(command) ?? {
    request: 'json_envelope' as const,
    response: 'json_envelope' as const,
  };
  if (actual.request !== request || actual.response !== response) {
    throw new Error(`Native command body mode mismatch: ${command}`);
  }
}

export function invokeNative<T>(transport: TauriTransport, command: string, input: Record<string, unknown>): Promise<T> {
  requireBodyMode(command, 'json_envelope', 'json_envelope');
  return transport.invoke<T>(command, nativeArgs(input));
}

export function invokeNativeRawRequest<T>(
  transport: TauriTransport,
  command: string,
  body: Uint8Array,
  headers: Readonly<Record<string, string>>,
): Promise<T> {
  requireBodyMode(command, 'raw_octet_stream', 'json_envelope');
  return transport.invokeRawRequest<T>(command, body, headers);
}

export async function invokeNativeRawResponse(
  transport: TauriTransport,
  command: string,
  input: Record<string, unknown>,
): Promise<ArrayBuffer> {
  requireBodyMode(command, 'json_envelope', 'raw_octet_stream');
  const value = await transport.invokeRawResponse(command, nativeArgs(input));
  const byteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')?.get;
  let size: number;
  try {
    size = byteLength?.call(value) as number;
    ArrayBuffer.prototype.slice.call(value, 0, 0);
  } catch {
    throw new Error('Native raw response is not an exact ArrayBuffer.');
  }
  if (!Number.isSafeInteger(size) || size < 1) {
    throw new Error('Native raw response size is invalid.');
  }
  return value as ArrayBuffer;
}

export function unwrapResult(value: unknown): unknown {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || !Object.hasOwn(value, 'result')
    || Object.keys(value).some((key) => key !== 'schemaVersion' && key !== 'result')) {
    throw new Error('Native response envelope is invalid.');
  }
  return value.result;
}

export async function invokeNativeResult(
  transport: TauriTransport,
  command: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  return unwrapResult(await invokeNative<unknown>(transport, command, input));
}

export function structuredNativeError(error: unknown): StructuredNativeError | null {
  if (isRecord(error) && typeof error.code === 'string' && typeof error.message === 'string') {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable === true,
      details: isRecord(error.details) ? error.details : undefined,
    };
  }
  if (error instanceof Error) {
    const candidate = error as Error & { code?: unknown; retryable?: unknown; details?: unknown };
    if (typeof candidate.code === 'string') {
      return {
        code: candidate.code,
        message: error.message,
        retryable: candidate.retryable === true,
        details: isRecord(candidate.details) ? candidate.details : undefined,
      };
    }
  }
  return null;
}

export function asError(error: unknown): Error {
  if (error instanceof Error) return error;
  const native = structuredNativeError(error);
  return new Error(native?.message ?? String(error));
}

export async function defaultTransport(): Promise<TauriTransport> {
  const [{ invoke }, { listen }] = await Promise.all([
    import('@tauri-apps/api/core'),
    import('@tauri-apps/api/event'),
  ]);
  return {
    invoke: (command, args) => invoke(command, args),
    invokeRawRequest: (command, body, headers) => invoke(command, body, { headers }),
    invokeRawResponse: (command, args) => invoke<unknown>(command, args),
    listen: (event, listener) => listen(event, listener),
  };
}
