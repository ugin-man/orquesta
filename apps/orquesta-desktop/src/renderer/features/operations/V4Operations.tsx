import { Activity, Boxes, History, Languages, PackageSearch, ShieldAlert } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RuntimeInfoUi } from '../../../contracts/bridge';
import type { V4OperationsSnapshot } from '../../../contracts/orquesta-ui';
import { OverlayFrame } from '../../components/OverlayFrame';
import { useI18n } from '../i18n/I18nProvider';
import { AcquisitionPanel } from './AcquisitionPanel';
import { AuditPanel } from './AuditPanel';
import { CapabilityPanel } from './CapabilityPanel';
import { EvidencePanel } from './EvidencePanel';

const tabs = [
  { id: 'capability', label: 'capabilityTab', icon: Boxes },
  { id: 'acquisition', label: 'acquisitionTab', icon: PackageSearch },
  { id: 'audit', label: 'auditTab', icon: History },
  { id: 'evidence', label: 'evidenceTab', icon: Activity },
] as const;
type TabId = typeof tabs[number]['id'];

export function V4Operations({ operations, getRuntimeInfo, onClose }: {
  operations: V4OperationsSnapshot;
  getRuntimeInfo(input: { probe: boolean }): Promise<RuntimeInfoUi>;
  onClose(): void;
}) {
  const { t, locale, setLocale } = useI18n();
  const [activeTab, setActiveTab] = useState<TabId>('capability');
  const [runtimeInfo, setRuntimeInfo] = useState<RuntimeInfoUi | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const loadRuntime = useCallback(async (probe: boolean) => {
    setRefreshing(true);
    setRuntimeError(null);
    try {
      setRuntimeInfo(await getRuntimeInfo({ probe }));
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : String(error));
    } finally {
      setRefreshing(false);
    }
  }, [getRuntimeInfo]);

  useEffect(() => { void loadRuntime(false); }, [loadRuntime]);

  const selectTab = (index: number) => {
    const tab = tabs[index];
    if (!tab) return;
    setActiveTab(tab.id);
    tabRefs.current[index]?.focus();
  };
  const onTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === 'ArrowRight') { event.preventDefault(); selectTab((index + 1) % tabs.length); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); selectTab((index - 1 + tabs.length) % tabs.length); }
    else if (event.key === 'Home') { event.preventDefault(); selectTab(0); }
    else if (event.key === 'End') { event.preventDefault(); selectTab(tabs.length - 1); }
  };

  const panel = activeTab === 'capability' ? <CapabilityPanel operations={operations} />
    : activeTab === 'acquisition' ? <AcquisitionPanel operations={operations} />
      : activeTab === 'audit' ? <AuditPanel operations={operations} />
        : <EvidencePanel operations={operations} runtimeInfo={runtimeInfo} runtimeError={runtimeError} refreshing={refreshing} onRefresh={() => void loadRuntime(true)} />;

  return (
    <OverlayFrame title={t('operationsTitle')} subtitle={t('operationsSubtitle')} ariaLabel={t('operationsTitle')} className="operations-overlay operations-overlay--bounded" onClose={onClose}>
      <div className="operations-shell">
        <div className="operations-toolbar">
          <div className={`operations-availability operations-availability--${operations.available ? 'ready' : 'unavailable'}`}><i /><span><strong>{operations.available ? t('canonicalV4State') : t('v4Unavailable')}</strong><small>{t('revision')} {operations.revision}</small></span></div>
          <section className="language-control"><div><Languages size={15} /><span><strong>{t('language')}</strong><small>{t('languageDetail')}</small></span></div><div role="group" aria-label={t('language')}><button type="button" className={locale === 'en' ? 'is-active' : ''} aria-label="English" onClick={() => setLocale('en')}>EN</button><button type="button" className={locale === 'ja' ? 'is-active' : ''} aria-label="日本語" onClick={() => setLocale('ja')}>JA</button></div></section>
        </div>

        {!operations.available ? <div className="operations-unavailable" role="status"><ShieldAlert size={18} /><div><strong>{t('v4Unavailable')}</strong><p>{operations.limitation ?? t('unknown')}</p></div></div> : null}

        <div className="operations-tabs" role="tablist" aria-label={t('operationsViews')}>
          {tabs.map((tab, index) => { const Icon = tab.icon; return <button key={tab.id} ref={(node) => { tabRefs.current[index] = node; }} type="button" role="tab" id={`operations-tab-${tab.id}`} aria-controls={`operations-panel-${tab.id}`} aria-selected={activeTab === tab.id} tabIndex={activeTab === tab.id ? 0 : -1} className={activeTab === tab.id ? 'is-active' : ''} onClick={() => setActiveTab(tab.id)} onKeyDown={(event) => onTabKeyDown(event, index)}><Icon size={15} />{t(tab.label)}</button>; })}
        </div>

        <section className="operations-panel__scroll" role="tabpanel" tabIndex={0} id={`operations-panel-${activeTab}`} aria-labelledby={`operations-tab-${activeTab}`}>
          {operations.available ? panel : <div className="operations-empty"><ShieldAlert size={24} /><strong>{t('v4Unavailable')}</strong><p>{operations.limitation ?? t('unknown')}</p></div>}
        </section>
      </div>
    </OverlayFrame>
  );
}
