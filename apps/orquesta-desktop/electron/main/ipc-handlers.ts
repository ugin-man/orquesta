import type { CoreHostStatus } from './core-host';
import { DESKTOP_IPC, type CoreStatus } from '../shared/host-contract';
import type { ProjectSummary, UiActionResult } from '../../src/contracts/bridge';
import type { OrquestaUiSnapshot } from '../../src/contracts/orquesta-ui';

export interface IpcMainLike {
  handle(channel: string, handler: (event: unknown, input?: unknown) => unknown): void;
}

export interface CoreController {
  status(): CoreHostStatus;
  ping(correlationId: string): Promise<{ correlationId: string }>;
}

export interface RepositoryController {
  getSnapshot(): Promise<OrquestaUiSnapshot>;
  listProjects(): Promise<ProjectSummary[]>;
  switchProject(projectId: string): Promise<UiActionResult>;
  openProject(): Promise<UiActionResult>;
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

export function registerDesktopIpc(ipcMain: IpcMainLike, coreHost: CoreController, repositories: RepositoryController): void {
  ipcMain.handle(DESKTOP_IPC.getHostInfo, async () => ({
    platform: 'win32' as const,
    coreStatus: publicCoreStatus(coreHost.status())
  }));
  ipcMain.handle(DESKTOP_IPC.pingCore, async (_event, input) => coreHost.ping(readCorrelationId(input)));
  ipcMain.handle(DESKTOP_IPC.getRepositorySnapshot, async () => repositories.getSnapshot());
  ipcMain.handle(DESKTOP_IPC.listRepositories, async () => repositories.listProjects());
  ipcMain.handle(DESKTOP_IPC.switchRepository, async (_event, input) => repositories.switchProject(readProjectId(input)));
  ipcMain.handle(DESKTOP_IPC.openRepository, async () => repositories.openProject());
}
