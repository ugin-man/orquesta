import { X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../features/i18n/I18nProvider';

const OVERLAY_CLOSE_DURATION_MS = 160;

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
  const closeTimerRef = useRef<number | null>(null);
  const closingRef = useRef(false);
  const [closing, setClosing] = useState(false);

  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      onClose();
      return;
    }
    closingRef.current = true;
    setClosing(true);
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      onClose();
    }, OVERLAY_CLOSE_DURATION_MS);
  }, [onClose]);

  useEffect(() => () => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
  }, []);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    if (!panel) return;
    if (modal) (getFocusable(panel)[0] ?? panel).focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        requestClose();
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
  }, [modal, requestClose]);

  const header = (
    <header className="context-overlay__header">
      <div className="context-overlay__heading">
        <span className="eyebrow">ORQUESTA</span>
        <h2>{title}</h2>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      <div className="context-overlay__actions">
        <button type="button" className="icon-button" onClick={requestClose} aria-label={`${t('close')} ${ariaLabel}`} disabled={closing}>
          <X size={18} />
        </button>
      </div>
    </header>
  );

  if (!modal) {
    return (
      <aside ref={panelRef} tabIndex={-1} className={`context-overlay ${className}`} aria-label={ariaLabel} data-motion-state={closing ? 'closing' : 'open'}>
        {header}
        <div className="context-overlay__body">{children}</div>
      </aside>
    );
  }

  return (
    <div className="overlay-backdrop" role="presentation" data-motion-state={closing ? 'closing' : 'open'} onMouseDown={(event) => { if (event.target === event.currentTarget) requestClose(); }}>
      <section ref={panelRef} tabIndex={-1} className={`context-overlay ${className}`} role="dialog" aria-modal="true" aria-label={ariaLabel} data-motion-state={closing ? 'closing' : 'open'}>
        {header}
        <div className="context-overlay__body">{children}</div>
      </section>
    </div>
  );
}
