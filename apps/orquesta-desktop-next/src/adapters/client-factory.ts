import type { DesktopClient } from '../ports/desktop-client';
import { createTauriDesktopClient } from './tauri-client';

export function createDesktopClient(): DesktopClient {
  // This production factory has no fixture branch or test override.
  return createTauriDesktopClient();
}
