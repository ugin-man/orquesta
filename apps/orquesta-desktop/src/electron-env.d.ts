import type { DesktopHostApi } from '../electron/shared/host-contract';

declare global {
  interface Window {
    orquestaDesktop: DesktopHostApi;
  }
}

export {};
