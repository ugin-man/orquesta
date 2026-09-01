import type { ApplicationState } from './state';
import {
  collectUserSignals,
  expectedUserSignalStreams,
  UserSignalTracker,
  type UserSignal,
} from '../presentation/user-signals';

export interface NotificationGateway {
  isPermissionGranted(): Promise<boolean>;
  requestPermission(): Promise<'granted' | 'denied' | 'default'>;
  notify(input: { title: string; body: string }): Promise<void>;
}

interface NotificationEnvironment {
  visible: boolean;
  focused: boolean;
}

export class NotificationCoordinator {
  readonly #gateway: NotificationGateway;
  readonly #tracker = new UserSignalTracker();

  constructor(gateway: NotificationGateway) {
    this.#gateway = gateway;
  }

  async observe(
    state: ApplicationState,
    locale: 'ja' | 'en',
    environment: NotificationEnvironment,
  ): Promise<void> {
    if (state.runtimeAuthority && !state.userSignalsBaselineReady) {
      this.#tracker.reset();
      return;
    }
    const signals = collectUserSignals(state, locale);
    const fresh = this.#tracker.observe(signals, expectedUserSignalStreams(state));
    for (const signal of fresh) {
      if (!state.settings?.notificationsEnabled) continue;
      if (this.#isVisibleInCurrentConversation(signal, state, environment)) continue;
      try {
        await this.#gateway.notify({
          title: signal.notificationTitle,
          body: signal.notificationBody,
        });
      } catch {
        // The identity is already consumed. An uncertain OS delivery is never retried blindly.
      }
    }
  }

  #isVisibleInCurrentConversation(
    signal: UserSignal,
    state: ApplicationState,
    environment: NotificationEnvironment,
  ): boolean {
    if (!environment.visible || !environment.focused) return false;
    return signal.targetAgentId === null || signal.targetAgentId === state.selectedAgentId;
  }
}
