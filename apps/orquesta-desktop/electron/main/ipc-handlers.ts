import { randomUUID } from 'node:crypto';
import type { ConversationPage, ProjectSummary, RuntimeInfoUi, UiActionResult } from '../../src/contracts/bridge';
import type { OrquestaUiSnapshot } from '../../src/contracts/orquesta-ui';
import type { CoreHostStatus } from './core-host';
import { DESKTOP_IPC, type CoreStatus } from '../shared/host-contract';

export interface IpcMainLike {
  handle(channel: string, handler: (event: unknown, input?: unknown) => unknown): void;
}

export interface CoreController {
  status(): CoreHostStatus;
  ping(correlationId: string): Promise<{ correlationId: string }>;
  sendMessage(input: { projectId: string; rootPath: string; threadId: string | null; targetAgentId: string; text: string; localImagePaths: string[] }): Promise<{ correlationId: string; threadId: string; turnId: string; modelEvidence: import('../core/protocol').RuntimeModelEvidence }>;
  listConversation(input: { threadId: string; targetAgentId: string; limit: number }): Promise<ConversationPage>;
  getRuntimeInfo(input: { probe: boolean }): Promise<RuntimeInfoUi>;
}

export interface AttachmentController {
  chooseImages(): Promise<import('../../src/contracts/bridge').ComposerAttachment[]>;
  resolveImagePaths(ids: string[]): string[];
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

function readConversationInput(input: unknown): { targetAgentId: string; limit: number } {
  if (!input || typeof input !== 'object') throw new Error('conversation input is required');
  const value = input as Record<string, unknown>;
  if (typeof value.targetAgentId !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/u.test(value.targetAgentId)) throw new Error('targetAgentId is invalid');
  const limit = value.limit === undefined ? 100 : value.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('limit must be an integer from 1 to 200');
  return { targetAgentId: value.targetAgentId, limit };
}

function readRuntimeInfoInput(input: unknown): { probe: boolean } {
  if (!input || typeof input !== 'object' || typeof (input as Record<string, unknown>).probe !== 'boolean') {
    throw new Error('probe must be boolean');
  }
  return { probe: (input as Record<string, unknown>).probe as boolean };
}

export function registerDesktopIpc(ipcMain: IpcMainLike, coreHost: CoreController, repositories: RepositoryController, attachments: AttachmentController): void {
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
      return {
        status: 'unavailable', correlationId: randomUUID(),
        reason: error instanceof Error ? error.message : String(error), retryable: true
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
}
