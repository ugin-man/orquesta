import type {
  RendererAuthority,
  VoiceComposerBinding,
  VoiceOperationStatus,
  VoiceStatus,
} from '../../domain/models';
import { parseVoiceOperationStatus, parseVoiceStatus } from '../../domain/validation';
import type { VoiceTranscriptionBindingInput } from '../../ports/desktop-client';
import {
  NATIVE_COMMANDS,
  invokeNativeRawRequest,
  invokeNativeResult,
  unwrapResult,
  type TauriTransport,
} from './native-bridge';

const MIN_PCM_SAMPLES = 1_600;
const MAX_PCM_SAMPLES = 960_000;

function operationInput(renderer: RendererAuthority, operationRef: string): Record<string, unknown> {
  return { ...renderer, operationRef };
}

async function invokeVoiceStatus(
  transport: TauriTransport,
  command: string,
  input: Record<string, unknown>,
): Promise<VoiceStatus> {
  return parseVoiceStatus(await invokeNativeResult(transport, command, input));
}

export function readVoiceStatusNative(
  transport: TauriTransport,
  renderer: RendererAuthority,
): Promise<VoiceStatus> {
  return invokeVoiceStatus(transport, NATIVE_COMMANDS.voiceStatus, { ...renderer });
}

export function acquireVoiceAssetNative(
  transport: TauriTransport,
  renderer: RendererAuthority,
  assetId: string,
): Promise<VoiceStatus> {
  return invokeVoiceStatus(transport, NATIVE_COMMANDS.acquireVoiceAsset, { ...renderer, assetId });
}

export function cancelVoiceAssetAcquisitionNative(
  transport: TauriTransport,
  renderer: RendererAuthority,
  operationRef: string,
): Promise<VoiceStatus> {
  return invokeVoiceStatus(
    transport,
    NATIVE_COMMANDS.cancelVoiceAssetAcquisition,
    operationInput(renderer, operationRef),
  );
}

export function deleteVoiceAssetNative(
  transport: TauriTransport,
  renderer: RendererAuthority,
  assetId: string,
): Promise<VoiceStatus> {
  return invokeVoiceStatus(transport, NATIVE_COMMANDS.deleteVoiceAsset, { ...renderer, assetId });
}

export async function transcribeVoicePcmNative(
  transport: TauriTransport,
  renderer: RendererAuthority,
  operationRef: string,
  binding: VoiceTranscriptionBindingInput,
  pcm: Uint8Array,
  sampleCount: number,
): Promise<VoiceOperationStatus> {
  if (!Number.isSafeInteger(sampleCount)
    || sampleCount < MIN_PCM_SAMPLES
    || sampleCount > MAX_PCM_SAMPLES
    || pcm.byteLength !== sampleCount * 2) {
    throw new Error('Voice PCM payload is invalid or too short.');
  }
  const body = pcm.slice();
  const bindingHeaders: Record<string, string> = binding.target === 'agent'
    ? {
        'x-orquesta-composer-target': 'agent',
        'x-orquesta-composer-draft-sha256': binding.draftSha256,
        'x-orquesta-composer-project-id': binding.projectId,
        'x-orquesta-composer-agent-id': binding.agentId,
        'x-orquesta-runtime-activation-token': binding.activationToken,
      }
    : {
        'x-orquesta-composer-target': 'launcher',
        'x-orquesta-composer-draft-sha256': binding.draftSha256,
      };
  const raw = await invokeNativeRawRequest<unknown>(
    transport,
    NATIVE_COMMANDS.transcribeVoicePcm,
    body,
    {
      'x-orquesta-schema-version': '1',
      'x-orquesta-renderer-session-id': renderer.rendererSessionId,
      'x-orquesta-renderer-generation': String(renderer.rendererGeneration),
      'x-orquesta-operation-ref': operationRef,
      'x-orquesta-sample-rate-hz': '16000',
      'x-orquesta-channel-count': '1',
      'x-orquesta-sample-format': 'pcm-s16le',
      'x-orquesta-sample-count': String(sampleCount),
      ...bindingHeaders,
    },
  );
  const operation = parseVoiceOperationStatus(unwrapResult(raw));
  if (operation.operationRef !== operationRef) {
    throw new Error('Native voice operation identity changed.');
  }
  const expectedBinding: VoiceComposerBinding = binding.target === 'agent'
    ? {
        state: 'agent', projectId: binding.projectId, agentId: binding.agentId,
        draftSha256: binding.draftSha256,
      }
    : { state: 'launcher', draftSha256: binding.draftSha256 };
  if (JSON.stringify(operation.composerBinding) !== JSON.stringify(expectedBinding)) {
    throw new Error('Native voice Composer binding changed.');
  }
  return operation;
}

export function cancelVoiceTranscriptionNative(
  transport: TauriTransport,
  renderer: RendererAuthority,
  operationRef: string,
): Promise<VoiceStatus> {
  return invokeVoiceStatus(
    transport,
    NATIVE_COMMANDS.cancelVoiceTranscription,
    operationInput(renderer, operationRef),
  );
}

export function acknowledgeVoiceTranscriptionNative(
  transport: TauriTransport,
  renderer: RendererAuthority,
  operationRef: string,
): Promise<VoiceStatus> {
  return invokeVoiceStatus(
    transport,
    NATIVE_COMMANDS.acknowledgeVoiceTranscription,
    operationInput(renderer, operationRef),
  );
}
