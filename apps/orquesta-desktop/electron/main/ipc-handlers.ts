import { randomUUID } from 'node:crypto';
import type { ConversationPage, ProjectSummary, RuntimeInfoUi, UiActionResult } from '../../src/contracts/bridge';
import type { AttentionUiItem, OrquestaUiSnapshot } from '../../src/contracts/orquesta-ui';
import type { CoreHostStatus } from './core-host';
import { DESKTOP_IPC, type CoreStatus } from '../shared/host-contract';

export interface IpcMainLike {
  handle(channel: string, handler: (event: unknown, input?: unknown) => unknown): void;
}

export interface CoreController {
  status(): CoreHostStatus;
  ping(correlationId: string): Promise<{ correlationId: string }>;
  sendMessage(input: { projectId: string; rootPath: string; threadId: string | null; targetAgentId: string; text: string; localImagePaths: string[] }): Promise<{ correlationId: string; threadId: string; turnId: string; modelEvidence: import('../core/protocol').RuntimeModelEvidence }>;
  listConversation(input: { threadId: string; targetAgentId: string; cursor?: string | null; limit: number }): Promise<ConversationPage>;
  getRuntimeInfo(input: { probe: boolean }): Promise<RuntimeInfoUi>;
  respondRuntimeApproval(input: { attentionId: string; decision: string }): Promise<{ correlationId: string }>;
  listAttentionHistory(): Promise<AttentionUiItem[]>;
}

export interface AttachmentController {
  chooseImages(): Promise<import('../../src/contracts/bridge').ComposerAttachment[]>;
  resolveImagePaths(ids: string[]): string[];
}

export interface ExternalController {
  openExternal(url: string): Promise<unknown>;
}

export interface RepositoryController {
  getSnapshot(): Promise<OrquestaUiSnapshot>;
  listProjects(): Promise<ProjectSummary[]>;
  switchProject(projectId: string): Promise<UiActionResult>;
  openProject(): Promise<UiActionResult>;
  getCurrentRuntimeContext(): { projectId: string; rootPath: string; threadId: string | null } | null;
  setCoordinatorThread(projectId: string, threadId: string): Promise<void>;
}

function publicCoreStatus(status: CoreHostStatus): CoreStatus {
  return status === 'stopping' ? 'stopped' : status;
}

function readCorrelationId(input: unknown): string {
  if (!input || typeof input !== 'object') throw new Error('correlationId is required');
  const correlationId = (input as Record<string, unknown>).correlationId;
  if (typeof correlationId !== 'string' || !correlationId || correlationId.length > 128) {
    throw new Error('correlationId must contain 1-128 characters');
  }
  return correlationId;
}

function readProjectId(input: unknown): string {
  if (!input || typeof input !== 'object') throw new Error('projectId is required');
  const projectId = (input as Record<string, unknown>).projectId;
  if (typeof projectId !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/u.test(projectId)) {
    throw new Error('projectId must contain 1-128 safe identifier characters');
  }
  return projectId;
}

function readMessageInput(input: unknown): { targetAgentId: string; text: string; attachmentIds: string[] } {
  if (!input || typeof input !== 'object') throw new Error('message input is required');
  const value = input as Record<string, unknown>;
  if (typeof value.targetAgentId !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/u.test(value.targetAgentId)) throw new Error('targetAgentId is invalid');
  if (typeof value.text !== 'string' || !value.text.trim() || value.text.length > 65_536) throw new Error('text must contain 1-65536 characters');
  if (!Array.isArray(value.attachmentIds) || !Array.isArray(value.selectedContextIds)) throw new Error('message context arrays are required');
  if (value.attachmentIds.length > 4 || !value.attachmentIds.every((id) => typeof id === 'string' && /^[a-zA-Z0-9._:-]{1,128}$/u.test(id))) throw new Error('attachmentIds are invalid');
  return { targetAgentId: value.targetAgentId, text: value.text.trim(), attachmentIds: value.attachmentIds };
}

function readConversationInput(input: unknown): { targetAgentId: string; cursor: string | null; limit: number } {
  if (!input || typeof input !== 'object') throw new Error('conversation input is required');
  const value = input as Record<string, unknown>;
  if (typeof value.targetAgentId !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/u.test(value.targetAgentId)) throw new Error('targetAgentId is invalid');
  const limit = value.limit === undefined ? 100 : value.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('limit must be an integer from 1 to 200');
  const cursor = value.cursor === undefined ? null : value.cursor;
  if (cursor !== null && (typeof cursor !== 'string' || !/^before:\d+$/u.test(cursor))) throw new Error('cursor is invalid');
  return { targetAgentId: value.targetAgentId, cursor, limit };
}

function readRuntimeInfoInput(input: unknown): { probe: boolean } {
  if (!input || typeof input !== 'object' || typeof (input as Record<string, unknown>).probe !== 'boolean') {
    throw new Error('probe must be boolean');
  }
  return { probe: (input as Record<string, unknown>).probe as boolean };
}

function readRuntimeApprovalInput(input: unknown): { id: string; decision: string } {
  if (!input || typeof input !== 'object') throw new Error('Runtime approval response is required');
  const value = input as Record<string, unknown>;
  if (typeof value.id !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/u.test(value.id)) {
    throw new Error('Runtime approval id is invalid');
  }
  if (typeof value.decision !== 'string' || !value.decision.trim() || value.decision.length > 128) {
    throw new Error('Runtime approval decision is invalid');
  }
  return { id: value.id, decision: value.decision };
}

function readCodexDraftInput(input: unknown): { targetAgentId: string; text: string } {
  if (!input || typeof input !== 'object') throw new Error('Codex draft input is required');
  const value = input as Record<string, unknown>;
  if (typeof value.targetAgentId !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/u.test(value.targetAgentId)) {
    throw new Error('Codex draft targetAgentId is invalid');
  }
  if (typeof value.text !== 'string' || !value.text.trim() || value.text.length > 65_536) {
    throw new Error('Codex draft text must contain 1-65536 characters');
  }
  return { targetAgentId: value.targetAgentId, text: value.text.trim() };
}

function draftPrompt(input: { targetAgentId: string; text: string }): string {
  return input.targetAgentId === 'orchestrator'
    ? input.text
    : `<orquesta_target agent_id="${input.targetAgentId}">\n${input.text}\n</orquesta_target>`;
}

export function registerDesktopIpc(
  ipcMain: IpcMainLike,
  coreHost: CoreController,
  repositories: RepositoryController,
  attachments: AttachmentController,
  external?: ExternalController
): void {
  ipcMain.handle(DESKTOP_IPC.getHostInfo, async () => ({
    platform: 'win32' as const,
    coreStatus: publicCoreStatus(coreHost.status())
  }));
  ipcMain.handle(DESKTOP_IPC.pingCore, async (_event, input) => coreHost.ping(readCorrelationId(input)));
  ipcMain.handle(DESKTOP_IPC.getRepositorySnapshot, async () => repositories.getSnapshot());
  ipcMain.handle(DESKTOP_IPC.listRepositories, async () => repositories.listProjects());
  ipcMain.handle(DESKTOP_IPC.switchRepository, async (_event, input) => repositories.switchProject(readProjectId(input)));
  ipcMain.handle(DESKTOP_IPC.openRepository, async () => repositories.openProject());
  ipcMain.handle(DESKTOP_IPC.selectImageAttachments, async () => attachments.chooseImages());
  ipcMain.handle(DESKTOP_IPC.sendMessage, async (_event, input) => {
    const message = readMessageInput(input);
    const context = repositories.getCurrentRuntimeContext();
    if (!context) return { status: 'unavailable', correlationId: randomUUID(), reason: 'Open an Orquesta project before sending a message.', retryable: false } satisfies UiActionResult;
    try {
      const localImagePaths = attachments.resolveImagePaths(message.attachmentIds);
      const { attachmentIds: _attachmentIds, ...messageWithoutIds } = message;
      const result = await coreHost.sendMessage({ ...context, ...messageWithoutIds, localImagePaths });
      await repositories.setCoordinatorThread(context.projectId, result.threadId).catch(() => undefined);
      return { status: 'accepted', correlationId: result.correlationId } satisfies UiActionResult;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const runtimeUnavailable = /runtime|integrity|package|codex app server/i.test(detail);
      return {
        status: 'unavailable', correlationId: randomUUID(),
        reason: runtimeUnavailable
          ? `Codex runtime is unavailable. Message was not sent. ${detail}`
          : `Message was not sent. ${detail}`,
        retryable: true
      } satisfies UiActionResult;
    }
  });
  ipcMain.handle(DESKTOP_IPC.listConversation, async (_event, input) => {
    const query = readConversationInput(input);
    const context = repositories.getCurrentRuntimeContext();
    if (!context?.threadId) return { items: [], nextCursor: null } satisfies ConversationPage;
    return coreHost.listConversation({ threadId: context.threadId, ...query });
  });
  ipcMain.handle(DESKTOP_IPC.getRuntimeInfo, async (_event, input) => coreHost.getRuntimeInfo(readRuntimeInfoInput(input)));
  ipcMain.handle(DESKTOP_IPC.respondRuntimeApproval, async (_event, input) => {
    const response = readRuntimeApprovalInput(input);
    try {
      const accepted = await coreHost.respondRuntimeApproval({ attentionId: response.id, decision: response.decision });
      return { status: 'accepted', correlationId: accepted.correlationId } satisfies UiActionResult;
    } catch (error) {
      return {
        status: 'rejected', correlationId: randomUUID(),
        reason: error instanceof Error ? error.message : String(error), retryable: false
      } satisfies UiActionResult;
    }
  });
  ipcMain.handle(DESKTOP_IPC.listAttentionHistory, async () => coreHost.listAttentionHistory());
  ipcMain.handle(DESKTOP_IPC.openCodexDraft, async (_event, input) => {
    const draft = readCodexDraftInput(input);
    const context = repositories.getCurrentRuntimeContext();
    if (!context) {
      return {
        status: 'unavailable', correlationId: randomUUID(),
        reason: 'Open an Orquesta project before creating a Codex draft.', retryable: false
      } satisfies UiActionResult;
    }
    if (!external) {
      return {
        status: 'unavailable', correlationId: randomUUID(),
        reason: 'Codex draft opening is unavailable.', retryable: true
      } satisfies UiActionResult;
    }
    const url = new URL('codex://threads/new');
    url.searchParams.set('prompt', draftPrompt(draft));
    url.searchParams.set('path', context.rootPath);
    try {
      await external.openExternal(url.toString());
      return { status: 'accepted', correlationId: randomUUID() } satisfies UiActionResult;
    } catch (error) {
      return {
        status: 'failed', correlationId: randomUUID(),
        reason: error instanceof Error ? error.message : String(error), retryable: true
      } satisfies UiActionResult;
    }
  });
}
