import { Activity, Bell, ChevronRight, GitBranch, Languages, MonitorCog, Play, RefreshCw, Settings2, TerminalSquare, type LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { RuntimeInfoUi } from '../../../contracts/bridge';
import type { ProjectUiModel } from '../../../contracts/orquesta-ui';
import { formatDateTime } from '../../components/format';
import { useI18n } from '../i18n/I18nProvider';

export type SettingsSection = 'display' | 'notifications' | 'codex' | 'startup' | 'status';

export interface SettingsWorkspaceProps {
  project: ProjectUiModel;
  reducedMotion: boolean;
  getRuntimeInfo(input: { probe: boolean }): Promise<RuntimeInfoUi>;
  onOpenRoute(): void;
  onOpenOperations(): void;
  onStartHomeTutorial(): void;
}

function ReadOnlyRow({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return <div className="settings-readonly-row"><span><strong>{label}</strong>{detail ? <small>{detail}</small> : null}</span><em>{value}</em></div>;
}

function UnconfiguredSection({ title, intro, message, icon: Icon }: { title: string; intro: string; message: string; icon: LucideIcon }) {
  return (
    <div className="settings-content__scroll">
      <header><h2>{title}</h2><p>{intro}</p></header>
      <section className="settings-empty-state"><Icon size={22} /><p>{message}</p></section>
    </div>
  );
}

export function SettingsWorkspace({ project, reducedMotion, getRuntimeInfo, onOpenRoute, onOpenOperations, onStartHomeTutorial }: SettingsWorkspaceProps) {
  const { locale, setLocale } = useI18n();
  const [section, setSection] = useState<SettingsSection>('display');
  const [runtimeInfo, setRuntimeInfo] = useState<RuntimeInfoUi | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [runtimeLoading, setRuntimeLoading] = useState(false);
  const copy = locale === 'ja' ? {
    navigation: '設定セクション', display: '表示', notifications: '通知', codex: 'Codex接続', startup: '起動とproject', status: '状態と診断',
    displayIntro: 'この端末で実際に変更できる表示項目です。', language: '表示言語', languageDetail: '選択は次回起動後も保持されます。', homeTutorial: 'ホーム画面のチュートリアル', homeTutorialDetail: '主要な場所と役割をもう一度確認します。', startHomeTutorial: 'ホーム画面のチュートリアルを開始',
    notificationsIntro: '通知方法は、必要な項目を決めてから実装します。', notificationsUnconfigured: '通知設定はまだ設計していません。',
    codexIntro: 'Codex固有の設定は、必要な項目を決めてから実装します。', codexUnconfigured: 'Codex設定はまだ設計していません。',
    startupIntro: 'projectの補助機能と、将来の起動設定をまとめます。', projectRoute: 'Project Route', openProjectRoute: 'Project Routeを開く', routeDetail: '現在のproject段階と既存のroute表示を開きます。', startupUnconfigured: '起動設定はまだ設計していません。',
    statusIntro: '変更する設定ではなく、現在のrepository、表示環境、runtime状態を確認します。', repository: 'Repository status', root: 'Project root', synced: '最終同期', connection: '接続メッセージ', motion: 'OSのmotion設定', detected: '検出値', motionOn: '動きを減らす', motionOff: '標準', scale: '文字と表示倍率', scaleValue: 'OSとアプリの倍率を使用', appServer: 'App Server', delivery: 'Delivery mode', deliveryValue: 'App Server', sendState: '送信状態', available: '利用可能', unavailable: 'Unavailable', notStarted: '未起動', readOnly: 'read-only', unknown: '不明', integrity: '実行環境の確認', reconnect: '接続し直す', checking: '確認中…', model: '実model', notReported: '報告なし',
    operations: 'Operations', openOperations: 'Operationsを開く', operationsDetail: '能力、探索、監査、証拠の詳細を開きます。', capability: '能力', capabilityDetail: 'このprojectに必要な能力と利用候補', acquisition: '探索', acquisitionDetail: '既存資産の探索結果と取得元', audit: '監査', auditDetail: '採用条件、安全境界、判断記録', evidence: '証拠', evidenceDetail: '実行、成果物、受入結果の根拠'
  } : {
    navigation: 'Settings sections', display: 'Display', notifications: 'Notifications', codex: 'Codex connection', startup: 'Startup & project', status: 'Status & diagnostics',
    displayIntro: 'Settings that can actually be changed on this device.', language: 'Display language', languageDetail: 'The selection is saved for the next launch.', homeTutorial: 'Home tutorial', homeTutorialDetail: 'Review the main areas and what they are for.', startHomeTutorial: 'Start tutorial',
    notificationsIntro: 'Notification behavior will be designed before controls are added.', notificationsUnconfigured: 'Notification settings have not been designed yet.',
    codexIntro: 'Codex-specific preferences will be designed before controls are added.', codexUnconfigured: 'Codex settings have not been designed yet.',
    startupIntro: 'Project utilities and future launch preferences live here.', projectRoute: 'Project Route', openProjectRoute: 'Open Project Route', routeDetail: 'Open the current project stages in the existing route view.', startupUnconfigured: 'Startup settings have not been designed yet.',
    statusIntro: 'Inspect current repository, display-environment, and runtime state without presenting it as editable settings.', repository: 'Repository status', root: 'Project root', synced: 'Last synced', connection: 'Connection message', motion: 'OS motion preference', detected: 'Detected', motionOn: 'Reduce motion', motionOff: 'Standard', scale: 'Text and display scale', scaleValue: 'Uses OS and app scale', appServer: 'App Server', delivery: 'Delivery mode', deliveryValue: 'App Server', sendState: 'Send state', available: 'Available', unavailable: 'Unavailable', notStarted: 'Not started', readOnly: 'Read-only', unknown: 'Unknown', integrity: 'Runtime integrity', reconnect: 'Reconnect', checking: 'Checking…', model: 'Actual model', notReported: 'Not reported',
    operations: 'Operations', openOperations: 'Open Operations', operationsDetail: 'Open capability, acquisition, audit, and evidence details.', capability: 'Capability', capabilityDetail: 'Required abilities and available candidates', acquisition: 'Acquisition', acquisitionDetail: 'Existing-asset search results and sources', audit: 'Audit', auditDetail: 'Selection gates, boundaries, and decisions', evidence: 'Evidence', evidenceDetail: 'Runtime, artifact, and acceptance proof'
  };
  const sections: Array<{ id: SettingsSection; label: string; icon: LucideIcon }> = [
    { id: 'display', label: copy.display, icon: MonitorCog },
    { id: 'notifications', label: copy.notifications, icon: Bell },
    { id: 'codex', label: copy.codex, icon: TerminalSquare },
    { id: 'startup', label: copy.startup, icon: Play },
    { id: 'status', label: copy.status, icon: Settings2 }
  ];
  const loadRuntime = useCallback(async (probe: boolean) => {
    setRuntimeLoading(true);
    setRuntimeError(null);
    try {
      setRuntimeInfo(await getRuntimeInfo({ probe }));
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : String(error));
    } finally {
      setRuntimeLoading(false);
    }
  }, [getRuntimeInfo]);

  useEffect(() => {
    if (section === 'status' && !runtimeInfo && !runtimeLoading && !runtimeError) void loadRuntime(false);
  }, [loadRuntime, runtimeError, runtimeInfo, runtimeLoading, section]);

  const runtimeStatus = runtimeInfo?.status === 'ready' ? copy.available : runtimeInfo?.status === 'not_started' ? copy.notStarted : copy.unavailable;

  return (
    <div className="settings-workspace">
      <nav className="settings-sections" aria-label={copy.navigation}>
        {sections.map(({ id, label, icon: Icon }) => <button type="button" key={id} aria-current={section === id ? 'page' : undefined} onClick={() => setSection(id)}><Icon size={17} /><span>{label}</span><ChevronRight size={14} /></button>)}
      </nav>
      <section className="settings-content" aria-label={sections.find((item) => item.id === section)?.label}>
        {section === 'display' ? (
          <div className="settings-content__scroll">
            <header><h2>{copy.display}</h2><p>{copy.displayIntro}</p></header>
            <section className="settings-group">
              <div className="settings-control-row">
                <span><strong>{copy.language}</strong><small>{copy.languageDetail}</small></span>
                <div className="settings-language-control" role="group" aria-label={copy.language}>
                  <button type="button" aria-label="日本語" aria-pressed={locale === 'ja'} onClick={() => setLocale('ja')}><Languages size={14} />JA</button>
                  <button type="button" aria-label="English" aria-pressed={locale === 'en'} onClick={() => setLocale('en')}>EN</button>
                </div>
              </div>
              <div className="settings-control-row">
                <span><strong>{copy.homeTutorial}</strong><small>{copy.homeTutorialDetail}</small></span>
                <button type="button" className="settings-primary-action" aria-label={copy.startHomeTutorial} onClick={onStartHomeTutorial}><Play size={14} />{copy.startHomeTutorial}</button>
              </div>
            </section>
          </div>
        ) : null}
        {section === 'notifications' ? <UnconfiguredSection title={copy.notifications} intro={copy.notificationsIntro} message={copy.notificationsUnconfigured} icon={Bell} /> : null}
        {section === 'codex' ? <UnconfiguredSection title={copy.codex} intro={copy.codexIntro} message={copy.codexUnconfigured} icon={TerminalSquare} /> : null}
        {section === 'startup' ? <div className="settings-content__scroll"><header><h2>{copy.startup}</h2><p>{copy.startupIntro}</p></header><section className="settings-operations-card settings-project-route-card"><div><GitBranch size={18} /><span><strong>{copy.projectRoute}</strong><small>{copy.routeDetail}</small></span></div><button type="button" aria-label={copy.openProjectRoute} onClick={onOpenRoute}>{copy.openProjectRoute}<ChevronRight size={14} /></button></section><p className="settings-unavailable-note">{copy.startupUnconfigured}</p></div> : null}
        {section === 'status' ? <div className="settings-content__scroll"><header><h2>{copy.status}</h2><p>{copy.statusIntro}</p></header><section className="settings-group"><ReadOnlyRow label={copy.repository} value={project.repositoryDisplayState} /><ReadOnlyRow label={copy.root} value={project.rootPathLabel ?? copy.unknown} /><ReadOnlyRow label={copy.synced} value={formatDateTime(project.lastSyncedAt)} /><ReadOnlyRow label={copy.connection} value={project.connectionLabel} /><ReadOnlyRow label={copy.motion} value={`${copy.detected} · ${reducedMotion ? copy.motionOn : copy.motionOff}`} /><ReadOnlyRow label={copy.scale} value={copy.scaleValue} /><ReadOnlyRow label={copy.appServer} value={runtimeLoading && !runtimeInfo ? copy.checking : runtimeError ? copy.unavailable : runtimeStatus} /><ReadOnlyRow label={copy.delivery} value={copy.deliveryValue} /><ReadOnlyRow label={copy.sendState} value={runtimeInfo?.status === 'ready' && project.status !== 'offline' ? copy.available : copy.readOnly} /><ReadOnlyRow label={copy.integrity} value={runtimeInfo?.integrity ?? copy.unknown} /><ReadOnlyRow label={copy.model} value={copy.notReported} />{runtimeError ? <p className="settings-runtime-error" role="status">{runtimeError}</p> : null}<button type="button" className="settings-primary-action" disabled={runtimeLoading} onClick={() => void loadRuntime(true)}><RefreshCw size={15} className={runtimeLoading ? 'is-spinning' : ''} />{runtimeLoading ? copy.checking : copy.reconnect}</button></section><section className="settings-operations-card"><div><Activity size={18} /><span><strong>{copy.operations}</strong><small>{copy.operationsDetail}</small></span></div><button type="button" aria-label={copy.openOperations} onClick={onOpenOperations}>{copy.openOperations}<ChevronRight size={14} /></button><dl><div><dt>{copy.capability}</dt><dd>{copy.capabilityDetail}</dd></div><div><dt>{copy.acquisition}</dt><dd>{copy.acquisitionDetail}</dd></div><div><dt>{copy.audit}</dt><dd>{copy.auditDetail}</dd></div><div><dt>{copy.evidence}</dt><dd>{copy.evidenceDetail}</dd></div></dl></section></div> : null}
      </section>
    </div>
  );
}
