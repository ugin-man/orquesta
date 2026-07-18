import type { DesktopHostApi, DesktopHostInfo } from '../shared/host-contract';
import { DESKTOP_IPC } from '../shared/host-contract';

export type IpcInvoke = (channel: string, input?: unknown) => Promise<unknown>;

function isDesktopHostInfo(value: unknown): value is DesktopHostInfo {
  if (!value || typeof value !== 'object') return false;
  const info = value as Record<string, unknown>;
  return info.platform === 'win32' && ['starting', 'ready', 'stopped'].includes(String(info.coreStatus));
}

export function createDesktopHostApi(invoke: IpcInvoke): DesktopHostApi {
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
    }
  };
}
