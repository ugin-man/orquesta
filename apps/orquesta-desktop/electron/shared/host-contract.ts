import type { ComposerAttachment, ConversationPage, ConversationQuery, ProjectSummary, UiActionResult } from '../../src/contracts/bridge';
import type { OrquestaUiSnapshot } from '../../src/contracts/orquesta-ui';
import type { RuntimeNotification } from '../core/protocol';

export type CoreStatus = 'starting' | 'ready' | 'stopped';

export interface DesktopHostInfo {
  platform: 'win32';
  coreStatus: CoreStatus;
}

export interface DesktopHostApi {
  getHostInfo(): Promise<DesktopHostInfo>;
  pingCore(correlationId: string): Promise<{ correlationId: string }>;
  getRepositorySnapshot(): Promise<OrquestaUiSnapshot>;
  listRepositories(): Promise<ProjectSummary[]>;
  switchRepository(projectId: string): Promise<UiActionResult>;
  openRepository(): Promise<UiActionResult>;
  selectImageAttachments(): Promise<ComposerAttachment[]>;
  subscribeRepository(listener: (snapshot: OrquestaUiSnapshot) => void): () => void;
  sendMessage(input: { targetAgentId: string; text: string; attachmentIds: string[]; selectedContextIds: string[] }): Promise<UiActionResult>;
  listConversation(input: ConversationQuery): Promise<ConversationPage>;
  subscribeRuntime(listener: (notification: RuntimeNotification) => void): () => void;
}

export const DESKTOP_IPC = {
  getHostInfo: 'orquesta.desktop.get-host-info',
  pingCore: 'orquesta.desktop.ping-core',
  getRepositorySnapshot: 'orquesta.desktop.repository.get-snapshot',
  listRepositories: 'orquesta.desktop.repository.list',
  switchRepository: 'orquesta.desktop.repository.switch',
  openRepository: 'orquesta.desktop.repository.open',
  selectImageAttachments: 'orquesta.desktop.attachment.select-images',
  repositoryChanged: 'orquesta.desktop.repository.changed',
  sendMessage: 'orquesta.desktop.runtime.send-message',
  listConversation: 'orquesta.desktop.runtime.list-conversation',
  runtimeChanged: 'orquesta.desktop.runtime.changed'
} as const;
