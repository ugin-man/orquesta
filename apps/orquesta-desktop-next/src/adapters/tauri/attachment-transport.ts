import type { ComposerAttachment, RendererAuthority } from '../../domain/models';
import { isRecord, parseAttachments } from '../../domain/validation';
import type { AttachmentBinarySource } from '../../ports/desktop-client';
import {
  NATIVE_COMMANDS,
  invokeNative,
  invokeNativeRawRequest,
  invokeNativeRawResponse,
  invokeNativeResult,
  unwrapResult,
  type TauriTransport,
} from './native-bridge';
import { createUuidValue } from './session-transport';

function createSlotId(): string {
  return createUuidValue();
}

function parseImportResult(
  value: unknown,
  selectionId: string,
  expectedFileCount: number,
): ComposerAttachment[] {
  if (!isRecord(value) || Object.keys(value).length !== 4
    || !Object.hasOwn(value, 'attachments') || value.selectionId !== selectionId
    || typeof value.fileCount !== 'number' || !Number.isInteger(value.fileCount)
    || typeof value.stagedCount !== 'number' || !Number.isInteger(value.stagedCount)
    || value.fileCount !== expectedFileCount
    || value.stagedCount < 0 || value.stagedCount > value.fileCount) {
    throw new Error('Attachment import response is invalid.');
  }
  const attachments = parseAttachments(value, selectionId);
  if (attachments.length !== value.stagedCount) throw new Error('Attachment import response is inconsistent.');
  return attachments;
}

function parseStageAck(value: unknown, selectionId: string, slotId: string): void {
  if (!isRecord(value) || Object.keys(value).length !== 3
    || value.selectionId !== selectionId || value.slotId !== slotId || value.staged !== true) {
    throw new Error('Attachment stage response is invalid.');
  }
}

export async function importAttachmentsNative(
  transport: TauriTransport,
  renderer: RendererAuthority,
  selectionId: string,
  files: readonly AttachmentBinarySource[],
): Promise<ComposerAttachment[]> {
  if (!Array.isArray(files) || files.length < 1) {
    throw new Error('Select at least one file.');
  }
  const manifest = files.map((file) => {
    if (typeof file !== 'object' || file === null
      || typeof file.name !== 'string' || file.name.trim() === ''
      || !Number.isSafeInteger(file.size) || file.size < 1) {
      throw new Error('Attachment name and size are invalid.');
    }
    return { slotId: createSlotId(), displayName: file.name, sizeBytes: file.size };
  });
  try {
    const began = unwrapResult(await invokeNative<unknown>(
      transport,
      NATIVE_COMMANDS.beginAttachmentImport,
      { ...renderer, selectionId, files: manifest },
    ));
    parseImportResult(began, selectionId, files.length);
    for (let index = 0; index < files.length; index += 1) {
      const buffer = await files[index].arrayBuffer();
      if (buffer.byteLength !== manifest[index].sizeBytes) {
        throw new Error('Attachment bytes changed while they were being prepared.');
      }
      const raw = await invokeNativeRawRequest<unknown>(
        transport,
        NATIVE_COMMANDS.stageAttachmentBytes,
        new Uint8Array(buffer),
        {
          'x-orquesta-schema-version': '1',
          'x-orquesta-renderer-session-id': renderer.rendererSessionId,
          'x-orquesta-renderer-generation': String(renderer.rendererGeneration),
          'x-orquesta-selection-id': selectionId,
          'x-orquesta-slot-id': manifest[index].slotId,
        },
      );
      parseStageAck(unwrapResult(raw), selectionId, manifest[index].slotId);
    }
    const finished = unwrapResult(await invokeNative<unknown>(
      transport,
      NATIVE_COMMANDS.finishAttachmentImport,
      { ...renderer, selectionId },
    ));
    const attachments = parseImportResult(finished, selectionId, files.length);
    if (attachments.length !== files.length) throw new Error('Attachment import finished with an incomplete result.');
    return attachments;
  } catch (error) {
    try {
      await abandonAttachmentSelectionNative(transport, renderer, selectionId);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Attachment import and cleanup both failed.');
    }
    throw error;
  }
}

export function readAttachmentPreviewNative(
  transport: TauriTransport,
  renderer: RendererAuthority,
  selectionId: string,
  publicId: string,
): Promise<ArrayBuffer> {
  return invokeNativeRawResponse(transport, NATIVE_COMMANDS.readAttachmentPreview, {
    ...renderer,
    selectionId,
    publicId,
  });
}

export async function abandonAttachmentSelectionNative(
  transport: TauriTransport,
  renderer: RendererAuthority,
  selectionId: string,
): Promise<void> {
  const result = await invokeNativeResult(transport, NATIVE_COMMANDS.abandonAttachmentSelection, { ...renderer, selectionId });
  if (result !== null) throw new Error('Native attachment cancellation response is invalid.');
}

export async function forgetAttachmentNative(
  transport: TauriTransport,
  renderer: RendererAuthority,
  selectionId: string,
  publicId: string,
): Promise<void> {
  const result = await invokeNativeResult(transport, NATIVE_COMMANDS.forgetAttachment, {
    ...renderer,
    selectionId,
    publicId,
  });
  if (result !== null) throw new Error('Native attachment forget response is invalid.');
}
