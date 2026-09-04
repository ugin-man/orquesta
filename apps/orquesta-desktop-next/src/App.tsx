import { useEffect, useMemo, useRef, useState } from 'react';
import { ApplicationStore } from './application/store';
import { useApplicationStore } from './application/use-application-store';
import { createDesktopClient } from './adapters/client-factory';
import type { DesktopClient } from './ports/desktop-client';
import {
  WorkspaceView,
  type NotificationSettingsResult,
} from './features/workspace/WorkspaceView';
import { selectApplicationSurface } from './application/selectors';
import { userMessageCopy } from './presentation/user-copy';
import { NotificationCoordinator, type NotificationGateway } from './application/notification-coordinator';
import { TauriNotificationGateway } from './adapters/tauri-notification-gateway';
import { isTauri } from '@tauri-apps/api/core';
import { WindowChrome } from './features/window/WindowChrome';

function queryLocale(): 'ja' | 'en' | null {
  try {
    const query = new URLSearchParams(window.location.search).get('lang');
    return query === 'ja' || query === 'en' ? query : null;
  } catch {
    return null;
  }
}

function storedLocale(): 'ja' | 'en' | null {
  try {
    const stored = window.localStorage.getItem('orquesta.desktop-next.locale');
    return stored === 'ja' || stored === 'en' ? stored : null;
  } catch {
    return null;
  }
}

function navigatorLocale(): 'ja' | 'en' {
  return window.navigator.languages?.some((locale) => locale.toLowerCase().startsWith('ja')) ? 'ja' : 'en';
}

function initialLocale(browserPreview: boolean): 'ja' | 'en' {
  return (browserPreview ? queryLocale() : null) ?? storedLocale() ?? navigatorLocale();
}

function previewWindowChrome(browserPreview: boolean): boolean {
  if (!browserPreview) return false;
  try {
    return new URLSearchParams(window.location.search).get('windowChrome') === '1';
  } catch {
    return false;
  }
}

function useMediaPreference(query: string): boolean {
  const read = () => typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
  const [matches, setMatches] = useState(read);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener?.('change', update);
    return () => media.removeEventListener?.('change', update);
  }, [query]);
  return matches;
}

export function App({
  client,
  browserPreview = false,
  notificationGateway,
}: {
  client?: DesktopClient;
  browserPreview?: boolean;
  notificationGateway?: NotificationGateway;
}) {
  const store = useMemo(() => new ApplicationStore(client ?? createDesktopClient()), [client]);
  const gateway = useMemo(
    () => notificationGateway ?? new TauriNotificationGateway(),
    [notificationGateway],
  );
  const notificationCoordinator = useMemo(() => new NotificationCoordinator(gateway), [gateway]);
  const nativeWindow = isTauri();
  const windowChromeVisible = nativeWindow || previewWindowChrome(browserPreview);
  const state = useApplicationStore(store);
  const previewLocale = useMemo(() => browserPreview ? queryLocale() : null, [browserPreview]);
  const [locale, setLocaleState] = useState<'ja' | 'en'>(() => initialLocale(browserPreview));
  const localeMigrationRevisionRef = useRef<number | null>(null);
  const systemDark = useMediaPreference('(prefers-color-scheme: dark)');
  const systemReducedMotion = useMediaPreference('(prefers-reduced-motion: reduce)');
  const surface = selectApplicationSurface(state);
  useEffect(() => {
    if (state.settings?.locale && !previewLocale) setLocaleState(state.settings.locale);
  }, [previewLocale, state.settings?.locale]);
  useEffect(() => {
    const settings = state.settings;
    if (!settings || state.settingsUpdating) return;
    if (settings.locale) {
      try { window.localStorage.removeItem('orquesta.desktop-next.locale'); } catch { /* retired optional preference */ }
      return;
    }
    if (localeMigrationRevisionRef.current === settings.revision) return;
    localeMigrationRevisionRef.current = settings.revision;
    // Query parameters are a temporary preview override, not a durable legacy
    // preference. Only the retired browser value (or OS locale fallback)
    // is migrated into Native settings.
    const candidate = storedLocale() ?? navigatorLocale();
    void store.updateSettings({
      locale: candidate,
      theme: settings.theme,
      reducedMotion: settings.reducedMotion,
      notificationsEnabled: settings.notificationsEnabled,
      navigationCompact: settings.navigationCompact,
      workLedgerOpen: settings.workLedgerOpen,
    });
  }, [state.settings, state.settingsUpdating, store]);
  const setLocale = (next: 'ja' | 'en') => {
    const settings = state.settings;
    if (!settings || state.settingsUpdating) return;
    void store.updateSettings({
      locale: next,
      theme: settings.theme,
      reducedMotion: settings.reducedMotion,
      notificationsEnabled: settings.notificationsEnabled,
      navigationCompact: settings.navigationCompact,
      workLedgerOpen: settings.workLedgerOpen,
    }).then((saved) => { if (saved) setLocaleState(next); });
  };
  const theme = state.settings?.theme ?? 'system';
  const resolvedTheme = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;
  const reducedMotion = Boolean(state.settings?.reducedMotion || systemReducedMotion);
  useEffect(() => {
    void notificationCoordinator.observe(state, locale, {
      visible: document.visibilityState === 'visible',
      focused: typeof document.hasFocus === 'function' ? document.hasFocus() : true,
    });
  }, [locale, notificationCoordinator, state]);
  const setNotificationsEnabled = async (enabled: boolean): Promise<NotificationSettingsResult> => {
    if (enabled) {
      try {
        let granted = await gateway.isPermissionGranted();
        if (!granted) granted = await gateway.requestPermission() === 'granted';
        if (!granted) return 'permission_denied';
      } catch {
        return 'permission_denied';
      }
    }
    const current = store.getState().settings;
    if (!current) return 'save_failed';
    const saved = await store.updateSettings({
      locale: current.locale ?? locale,
      theme: current.theme,
      reducedMotion: current.reducedMotion,
      notificationsEnabled: enabled,
      navigationCompact: current.navigationCompact,
      workLedgerOpen: current.workLedgerOpen,
    });
    return saved ? 'saved' : 'save_failed';
  };

  return (
    <div
      className="application-root"
      lang={locale}
      data-theme={resolvedTheme}
      data-reduced-motion={reducedMotion ? 'true' : 'false'}
      data-native-window={windowChromeVisible ? 'true' : 'false'}
    >
      {windowChromeVisible && <WindowChrome locale={locale} interactive={nativeWindow} />}
      <div className="application-content">
        {surface === 'startup' && (
          <main className="startup-screen" aria-live="polite">
            <span className="identity-rule" />
            <p>ORQUESTA DESKTOP NEXT</p>
            <h1>{locale === 'ja' ? 'Orquestaを準備しています' : 'PREPARING ORQUESTA'}</h1>
            <div className="startup-progress"><i /><i /><i /></div>
            <small>{locale === 'ja' ? 'プロジェクトを読み込んでいます' : 'LOADING YOUR PROJECTS'}</small>
          </main>
        )}
        {surface === 'workspace' && <WorkspaceView state={state} store={store} locale={locale} onLocaleChange={setLocale} onNotificationsChange={setNotificationsEnabled} browserPreview={browserPreview} />}
        {surface === 'failure' && (
          <main className="failure-screen" id="main-content">
            <span>ORQUESTA COULD NOT START</span>
            <h1>{locale === 'ja' ? 'Orquestaを起動できませんでした。' : 'Orquesta could not start.'}</h1>
            <p>{state.error ? userMessageCopy(state.error, locale) : (locale === 'ja' ? 'もう一度読み込んでください。' : 'Please try loading again.')}</p>
            {state.rendererAuthority && <button type="button" onClick={() => void store.refreshProjects()}>{locale === 'ja' ? 'もう一度読み込む' : 'TRY AGAIN'}</button>}
          </main>
        )}
      </div>
    </div>
  );
}
