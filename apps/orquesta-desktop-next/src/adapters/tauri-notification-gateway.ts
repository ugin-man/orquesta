import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';
import type { NotificationGateway } from '../application/notification-coordinator';

export class TauriNotificationGateway implements NotificationGateway {
  isPermissionGranted(): Promise<boolean> {
    return isPermissionGranted();
  }

  requestPermission(): Promise<'granted' | 'denied' | 'default'> {
    return requestPermission();
  }

  async notify(input: { title: string; body: string }): Promise<void> {
    sendNotification(input);
  }
}
