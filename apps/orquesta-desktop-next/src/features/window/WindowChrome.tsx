import { type MouseEvent as ReactMouseEvent } from 'react';
import { Minus, Square, X } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';

type WindowAction = 'minimize' | 'toggleMaximize' | 'close' | 'startDragging';

export function WindowChrome({
  locale,
  interactive = true,
}: {
  locale: 'ja' | 'en';
  interactive?: boolean;
}) {
  const labels = locale === 'ja'
    ? { group: 'ウィンドウ操作', minimize: '最小化', maximize: '最大化または元に戻す', close: '閉じる' }
    : { group: 'Window controls', minimize: 'Minimize', maximize: 'Maximize or restore', close: 'Close' };

  const perform = (action: WindowAction) => {
    if (!interactive) return;
    const appWindow = getCurrentWindow();
    void appWindow[action]().catch((error: unknown) => {
      console.error(`window_${action}_failed`, error);
    });
  };

  const beginDrag = (event: ReactMouseEvent<HTMLSpanElement>) => {
    if (event.button !== 0) return;
    perform('startDragging');
  };

  return (
    <div className="native-window-chrome" aria-label={labels.group}>
      <span className="native-window-drag-strip" data-tauri-drag-region aria-hidden="true" onMouseDown={beginDrag} />
      <div className="native-window-controls">
        <button type="button" onClick={() => perform('minimize')} aria-label={labels.minimize} title={labels.minimize}>
          <Minus aria-hidden="true" />
        </button>
        <button type="button" onClick={() => perform('toggleMaximize')} aria-label={labels.maximize} title={labels.maximize}>
          <Square aria-hidden="true" />
        </button>
        <button type="button" className="native-window-close" onClick={() => perform('close')} aria-label={labels.close} title={labels.close}>
          <X aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
