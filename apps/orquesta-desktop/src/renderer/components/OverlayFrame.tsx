import { X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { useI18n } from '../features/i18n/I18nProvider';

function getFocusable(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(
    'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
  ));
}

export function OverlayFrame({
  title,
  subtitle,
  ariaLabel,
  className = '',
  modal = true,
  onClose,
  children
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  ariaLabel: string;
  className?: string;
  modal?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    if (!panel) return;
    if (modal) (getFocusable(panel)[0] ?? panel).focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (!modal || event.key !== 'Tab') return;
      const items = getFocusable(panel);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      if (modal) previous?.focus?.();
    };
  }, [modal, onClose]);

  const header = (
    <header className="context-overlay__header">
      <div className="context-overlay__heading">
        <span className="eyebrow">ORQUESTA</span>
        <h2>{title}</h2>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      <div className="context-overlay__actions">
        <button type="button" className="icon-button" onClick={onClose} aria-label={`${t('close')} ${ariaLabel}`}>
          <X size={18} />
        </button>
      </div>
    </header>
  );

  if (!modal) {
    return (
      <aside ref={panelRef} tabIndex={-1} className={`context-overlay ${className}`} aria-label={ariaLabel}>
        {header}
        <div className="context-overlay__body">{children}</div>
      </aside>
    );
  }

  return (
    <div className="overlay-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={panelRef} tabIndex={-1} className={`context-overlay ${className}`} role="dialog" aria-modal="true" aria-label={ariaLabel}>
        {header}
        <div className="context-overlay__body">{children}</div>
      </section>
    </div>
  );
}
