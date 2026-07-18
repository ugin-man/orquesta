import type { ProjectSummary, UiActionResult } from '../../src/contracts/bridge';
import type { OrquestaUiSnapshot } from '../../src/contracts/orquesta-ui';

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
  subscribeRepository(listener: (snapshot: OrquestaUiSnapshot) => void): () => void;
}

export const DESKTOP_IPC = {
  getHostInfo: 'orquesta.desktop.get-host-info',
  pingCore: 'orquesta.desktop.ping-core',
  getRepositorySnapshot: 'orquesta.desktop.repository.get-snapshot',
  listRepositories: 'orquesta.desktop.repository.list',
  switchRepository: 'orquesta.desktop.repository.switch',
  openRepository: 'orquesta.desktop.repository.open',
  repositoryChanged: 'orquesta.desktop.repository.changed'
} as const;
