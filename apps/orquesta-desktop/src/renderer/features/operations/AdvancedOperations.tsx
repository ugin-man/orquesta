import { Bot, Database, Languages, ShieldCheck } from 'lucide-react';
import { OverlayFrame } from '../../components/OverlayFrame';
import { useI18n } from '../i18n/I18nProvider';

const sections = [
  { title: 'codexRuntime' as const, detail: 'codexRuntimeDetail' as const, icon: Bot },
  { title: 'repositoryAccess' as const, detail: 'repositoryAccessDetail' as const, icon: Database },
  { title: 'desktopBoundary' as const, detail: 'desktopBoundaryDetail' as const, icon: ShieldCheck }
];

export function AdvancedOperations({ onClose }: { onClose(): void }) {
  const { t, locale, setLocale } = useI18n();
  return (
    <OverlayFrame title={t('advancedOperations')} subtitle={t('operationsIntro')} ariaLabel={t('advancedOperations')} className="operations-overlay" onClose={onClose}>
      <section className="language-control"><div><Languages size={17} /><span><strong>{t('language')}</strong><small>{t('languageDetail')}</small></span></div><div role="group" aria-label={t('language')}><button type="button" className={locale === 'en' ? 'is-active' : ''} onClick={() => setLocale('en')}>{t('english')}</button><button type="button" className={locale === 'ja' ? 'is-active' : ''} onClick={() => setLocale('ja')}>{t('japanese')}</button></div></section>
      <div className="operations-grid">{sections.map(({ title, icon: Icon, detail }) => <article key={title}><span><Icon size={19} /></span><div><strong>{t(title)}</strong><p>{t(detail)}</p></div></article>)}</div>
    </OverlayFrame>
  );
}
