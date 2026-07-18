export type CoreStatus = 'starting' | 'ready' | 'stopped';

export interface DesktopHostInfo {
  platform: 'win32';
  coreStatus: CoreStatus;
}

export interface DesktopHostApi {
  getHostInfo(): Promise<DesktopHostInfo>;
  pingCore(correlationId: string): Promise<{ correlationId: string }>;
}

export const DESKTOP_IPC = {
  getHostInfo: 'orquesta.desktop.get-host-info',
  pingCore: 'orquesta.desktop.ping-core'
} as const;
