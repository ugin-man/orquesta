import type { ProjectSummary, UiActionResult } from '../../src/contracts/bridge';
import type { OrquestaUiSnapshot } from '../../src/contracts/orquesta-ui';
import type { DesktopHostApi, DesktopHostInfo } from '../shared/host-contract';
import { DESKTOP_IPC } from '../shared/host-contract';

export type IpcInvoke = (channel: string, input?: unknown) => Promise<unknown>;
export type IpcSubscribe = (channel: string, listener: (payload: unknown) => void) => () => void;

function isDesktopHostInfo(value: unknown): value is DesktopHostInfo {
  if (!value || typeof value !== 'object') return false;
  const info = value as Record<string, unknown>;
  return info.platform === 'win32' && ['starting', 'ready', 'stopped'].includes(String(info.coreStatus));
}

function isRepositorySnapshot(value: unknown): value is OrquestaUiSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Record<string, unknown>;
  const project = snapshot.project && typeof snapshot.project === 'object' ? snapshot.project as Record<string, unknown> : null;
  return Boolean(
    project && typeof project.id === 'string' && typeof project.title === 'string'
    && Array.isArray(snapshot.agents) && Array.isArray(snapshot.tasks)
    && Array.isArray(snapshot.attention) && Array.isArray(snapshot.phases) && Array.isArray(snapshot.recentEvents)
  );
}

function isProjectSummary(value: unknown): value is ProjectSummary {
  if (!value || typeof value !== 'object') return false;
  const project = value as Record<string, unknown>;
  return typeof project.id === 'string' && typeof project.title === 'string' && typeof project.lastOpenedAt === 'string';
}

function isActionResult(value: unknown): value is UiActionResult {
  if (!value || typeof value !== 'object') return false;
  const action = value as Record<string, unknown>;
  if (typeof action.correlationId !== 'string') return false;
  if (action.status === 'accepted') return true;
  return ['unsupported', 'unavailable', 'rejected', 'failed'].includes(String(action.status))
    && typeof action.reason === 'string' && typeof action.retryable === 'boolean';
}

function safeProjectId(projectId: string): boolean {
  return /^[a-zA-Z0-9._:-]{1,128}$/u.test(projectId);
}

export function createDesktopHostApi(invoke: IpcInvoke, subscribe: IpcSubscribe): DesktopHostApi {
  return {
    async getHostInfo() {
      const result = await invoke(DESKTOP_IPC.getHostInfo);
      if (!isDesktopHostInfo(result)) throw new Error('Desktop host returned invalid host information');
      return result;
    },
    async pingCore(correlationId) {
      if (!correlationId || correlationId.length > 128) {
        throw new Error('correlationId must contain 1-128 characters');
      }
      const result = await invoke(DESKTOP_IPC.pingCore, { correlationId });
      if (
        !result ||
        typeof result !== 'object' ||
        (result as Record<string, unknown>).correlationId !== correlationId
      ) {
        throw new Error('Desktop host returned an invalid Core ping response');
      }
      return { correlationId };
    },
    async getRepositorySnapshot() {
      const snapshot = await invoke(DESKTOP_IPC.getRepositorySnapshot);
      if (!isRepositorySnapshot(snapshot)) throw new Error('Desktop host returned an invalid repository snapshot');
      return snapshot;
    },
    async listRepositories() {
      const projects = await invoke(DESKTOP_IPC.listRepositories);
      if (!Array.isArray(projects) || !projects.every(isProjectSummary)) throw new Error('Desktop host returned an invalid project list');
      return projects;
    },
    async switchRepository(projectId) {
      if (!safeProjectId(projectId)) throw new Error('projectId must contain 1-128 safe identifier characters');
      const action = await invoke(DESKTOP_IPC.switchRepository, { projectId });
      if (!isActionResult(action)) throw new Error('Desktop host returned an invalid switch result');
      return action;
    },
    async openRepository() {
      const action = await invoke(DESKTOP_IPC.openRepository);
      if (!isActionResult(action)) throw new Error('Desktop host returned an invalid open result');
      return action;
    },
    subscribeRepository(listener) {
      return subscribe(DESKTOP_IPC.repositoryChanged, (payload) => {
        if (isRepositorySnapshot(payload)) listener(payload);
      });
    }
  };
}
