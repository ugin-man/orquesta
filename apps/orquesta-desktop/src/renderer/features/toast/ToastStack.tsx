import { X } from 'lucide-react';
import { useEffect } from 'react';
import type { RuntimeUiEvent } from '../../../contracts/orquesta-ui';
import { useI18n } from '../i18n/I18nProvider';
import { visibleToastQueue } from './toast-queue';

function Toast({ toast, onDismiss }: { toast: RuntimeUiEvent; onDismiss(id: string): void }) {
  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(toast.id), toast.tone === 'danger' ? 6000 : 4500);
    return () => window.clearTimeout(timer);
  }, [onDismiss, toast.id, toast.tone]);
  return (
    <article className={`toast toast--${toast.tone}`} role="status">
      <span className="toast__dot" />
      <div><header><strong>{toast.title}</strong><span>{toast.taskId ?? ''}</span></header><p>{toast.message}</p></div>
      <button type="button" className="icon-button icon-button--small" onClick={() => onDismiss(toast.id)} aria-label="Dismiss notification"><X size={15} /></button>
    </article>
  );
}

export function ToastStack({ toasts, onDismiss }: { toasts: RuntimeUiEvent[]; onDismiss(id: string): void }) {
  const { t } = useI18n();
  const queue = visibleToastQueue(toasts);
  const suppressedKey = queue.suppressedIds.join('|');
  useEffect(() => {
    for (const id of queue.suppressedIds) onDismiss(id);
  }, [onDismiss, suppressedKey]);
  return (
    <section className="toast-stack" aria-live="polite" aria-label="Notifications">
      {queue.hiddenCount ? <div className="toast-overflow">{t('toastOverflow').replace('{count}', String(queue.hiddenCount))}</div> : null}
      {[...queue.visible].reverse().map((toast) => <Toast key={toast.id} toast={toast} onDismiss={onDismiss} />)}
    </section>
  );
}
