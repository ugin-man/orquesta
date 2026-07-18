import { Activity, Database, Languages, ListTree, Plug, Settings2, SlidersHorizontal } from 'lucide-react';
import { OverlayFrame } from '../../components/OverlayFrame';
import { useI18n } from '../i18n/I18nProvider';

const sections = [
  { key: 'controlPlane' as const, icon: SlidersHorizontal, detail: 'Runtime controls are added during Electron integration.' },
  { key: 'rawTaskState' as const, icon: Database, detail: 'Typed projections prevent raw state from leaking into Home components.' },
  { key: 'eventLog' as const, icon: ListTree, detail: 'Full event evidence stays outside the home dashboard.' },
  { key: 'setup' as const, icon: Settings2, detail: 'Project registry and directory selection are integration work.' },
  { key: 'pluginsDesktop' as const, icon: Plug, detail: 'Desktop plugin and preload settings will live behind typed IPC.' },
  { key: 'diagnostics' as const, icon: Activity, detail: 'No secrets or state dumps are exposed by this prototype.' }
];

export function AdvancedOperations({ onClose }: { onClose(): void }) {
  const { t, locale, setLocale } = useI18n();
  return (
    <OverlayFrame title={t('advancedOperations')} subtitle={t('operationsIntro')} ariaLabel={t('advancedOperations')} className="operations-overlay" onClose={onClose}>
      <section className="language-control"><div><Languages size={17} /><span><strong>{t('language')}</strong><small>UI strings are kept outside components.</small></span></div><div role="group" aria-label={t('language')}><button type="button" className={locale === 'en' ? 'is-active' : ''} onClick={() => setLocale('en')}>{t('english')}</button><button type="button" className={locale === 'ja' ? 'is-active' : ''} onClick={() => setLocale('ja')}>{t('japanese')}</button></div></section>
      <div className="operations-grid">{sections.map(({ key, icon: Icon, detail }) => <article key={key}><span><Icon size={19} /></span><div><strong>{t(key)}</strong><p>{detail}</p><small>{t('prototypeOnly')}</small></div></article>)}</div>
    </OverlayFrame>
  );
}
