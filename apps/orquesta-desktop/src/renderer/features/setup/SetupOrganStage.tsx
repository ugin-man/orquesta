import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import type { SetupUiSnapshot } from '../../../contracts/orquesta-ui';
import type { Locale } from '../i18n/messages';
import { getSetupCopy } from './setup-localization';
import { createSetupVisualState } from './setup-visual-state';
import './setup-organ-stage.css';

const SetupOrganScene = lazy(async () => {
  const module = await import('./organ/SetupOrganScene');
  return { default: module.SetupOrganScene };
});

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => (
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  ));
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!query) return undefined;
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return reduced;
}

function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || !document.hidden);
  useEffect(() => {
    const update = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return visible;
}

export function SetupOrganStage({ setup, locale = 'ja' }: { setup: SetupUiSnapshot; locale?: Locale }) {
  const reducedMotion = useReducedMotion();
  const pageVisible = usePageVisible();
  const copy = getSetupCopy(locale);
  const state = useMemo(() => createSetupVisualState(setup, reducedMotion, locale), [locale, reducedMotion, setup]);

  return (
    <section className="setup-organ-stage" aria-label={copy.organStage}>
      <Suspense fallback={<div className="setup-organ-stage__loading" role="status">{copy.organLoading}</div>}>
        <SetupOrganScene state={state} active={pageVisible} locale={locale} />
      </Suspense>
    </section>
  );
}
