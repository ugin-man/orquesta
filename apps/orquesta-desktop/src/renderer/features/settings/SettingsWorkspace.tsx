import { Activity, Bell, ChevronRight, Languages, MonitorCog, Play, RefreshCw, Settings2, TerminalSquare } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { RuntimeInfoUi } from '../../../contracts/bridge';
import type { ProjectUiModel } from '../../../contracts/orquesta-ui';
import { formatDateTime } from '../../components/format';
import { useI18n } from '../i18n/I18nProvider';

export type SettingsSection = 'display' | 'notifications' | 'codex' | 'startup' | 'details';

export interface SettingsWorkspaceProps {
  project: ProjectUiModel;
  reducedMotion: boolean;
  getRuntimeInfo(input: { probe: boolean }): Promise<RuntimeInfoUi>;
  onOpenOperations(): void;
}

function ReadOnlyRow({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return <div className="settings-readonly-row"><span><strong>{label}</strong>{detail ? <small>{detail}</small> : null}</span><em>{value}</em></div>;
}

export function SettingsWorkspace({ project, reducedMotion, getRuntimeInfo, onOpenOperations }: SettingsWorkspaceProps) {
  const { locale, setLocale } = useI18n();
  const [section, setSection] = useState<SettingsSection>('display');
  const [runtimeInfo, setRuntimeInfo] = useState<RuntimeInfoUi | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [runtimeLoading, setRuntimeLoading] = useState(false);
  const copy = locale === 'ja' ? {
    navigation: '設定セクション', display: '表示', notifications: '通知', codex: 'Codex接続', startup: '起動とproject', details: '詳細と診断',
    displayIntro: 'この端末での見え方を設定します。', language: '表示言語', languageDetail: '選択は次回起動後も保持されます。', motion: '動きを減らす', detected: 'OS設定を使用', motionOn: '有効', motionOff: '無効', scale: '文字と表示倍率', scaleValue: 'OSとアプリの倍率を使用', scaleDetail: '表示倍率はWindows側とアプリのzoomに従います。',
    notificationsIntro: '通知の現在動作を確認します。書き込み契約がない項目は変更できません。', temporary: '一時通知', temporaryValue: '表示中', temporaryDetail: '実行中の更新やエラーを画面内に表示します。', priority: 'ユーザータスクの強調', priorityValue: '現在の標準動作', priorityDetail: '質問、承認、確認、手作業はユーザータスクへ集約されます。', unavailableSetting: 'この項目の保存契約はまだありません。',
    codexIntro: 'Codex App Serverとdesktop hostの接続状態です。', appServer: 'App Server', delivery: 'Delivery mode', deliveryValue: 'App Server', sendState: '送信状態', available: '利用可能', unavailable: 'Unavailable', notStarted: '未起動', readOnly: 'read-only', unknown: '不明', integrity: '実行環境の確認', reconnect: '接続し直す', checking: '確認中…', model: '実model', notReported: '報告なし',
    startupIntro: '起動時のproject動作です。現在はdesktop hostが管理しています。', previousProject: '前回のproject', hostManaged: 'host管理', previousProjectDetail: '保存済みprojectがある場合はhostが復元します。', selector: 'project選択', homeLauncher: 'Home左上から開く', selectorDetail: '実際の切り替えはProject Launcherで行います。',
    detailsIntro: 'repositoryの読込状態と高度な運用情報を確認します。', repository: 'Repository status', root: 'Project root', synced: '最終同期', connection: '接続メッセージ', operations: 'Operations', openOperations: 'Operationsを開く', operationsDetail: '能力、探索、監査、証拠の詳細を開きます。', capability: '能力', capabilityDetail: 'このprojectに必要な能力と利用候補', acquisition: '探索', acquisitionDetail: '既存資産の探索結果と取得元', audit: '監査', auditDetail: '採用条件、安全境界、判断記録', evidence: '証拠', evidenceDetail: '実行、成果物、受入結果の根拠'
  } : {
    navigation: 'Settings sections', display: 'Display', notifications: 'Notifications', codex: 'Codex connection', startup: 'Startup & project', details: 'Details & diagnostics',
    displayIntro: 'Control how this desktop appears on this device.', language: 'Display language', languageDetail: 'The selection is saved for the next launch.', motion: 'Reduce motion', detected: 'Uses OS preference', motionOn: 'On', motionOff: 'Off', scale: 'Text and display scale', scaleValue: 'Uses OS and app scale', scaleDetail: 'Windows scaling and the app zoom determine the final size.',
    notificationsIntro: 'Review current notification behavior. Items without a write contract remain read-only.', temporary: 'Temporary notifications', temporaryValue: 'Shown', temporaryDetail: 'Runtime updates and errors appear inside the desktop.', priority: 'User Task emphasis', priorityValue: 'Current default', priorityDetail: 'Questions, approvals, reviews, and manual work are collected under User Tasks.', unavailableSetting: 'No persistent setting contract is available yet.',
    codexIntro: 'Connection state for the Codex App Server and desktop host.', appServer: 'App Server', delivery: 'Delivery mode', deliveryValue: 'App Server', sendState: 'Send state', available: 'Available', unavailable: 'Unavailable', notStarted: 'Not started', readOnly: 'Read-only', unknown: 'Unknown', integrity: 'Runtime integrity', reconnect: 'Reconnect', checking: 'Checking…', model: 'Actual model', notReported: 'Not reported',
    startupIntro: 'Project behavior at launch. The desktop host currently owns these choices.', previousProject: 'Previous project', hostManaged: 'Host managed', previousProjectDetail: 'The host restores a saved project when one is available.', selector: 'Project selection', homeLauncher: 'Home top-left launcher', selectorDetail: 'Project switching stays in the Project Launcher.',
    detailsIntro: 'Inspect repository state and advanced operating information.', repository: 'Repository status', root: 'Project root', synced: 'Last synced', connection: 'Connection message', operations: 'Operations', openOperations: 'Open Operations', operationsDetail: 'Open capability, acquisition, audit, and evidence details.', capability: 'Capability', capabilityDetail: 'Required abilities and available candidates', acquisition: 'Acquisition', acquisitionDetail: 'Existing-asset search results and sources', audit: 'Audit', auditDetail: 'Selection gates, boundaries, and decisions', evidence: 'Evidence', evidenceDetail: 'Runtime, artifact, and acceptance proof'
  };
  const sections: Array<{ id: SettingsSection; label: string; icon: typeof MonitorCog }> = [
    { id: 'display', label: copy.display, icon: MonitorCog },
    { id: 'notifications', label: copy.notifications, icon: Bell },
    { id: 'codex', label: copy.codex, icon: TerminalSquare },
    { id: 'startup', label: copy.startup, icon: Play },
    { id: 'details', label: copy.details, icon: Settings2 }
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
    if (section === 'codex' && !runtimeInfo && !runtimeLoading && !runtimeError) void loadRuntime(false);
  }, [loadRuntime, runtimeError, runtimeInfo, runtimeLoading, section]);

  const runtimeStatus = runtimeInfo?.status === 'ready' ? copy.available : runtimeInfo?.status === 'not_started' ? copy.notStarted : copy.unavailable;

  return (
    <div className="settings-workspace">
      <nav className="settings-sections" aria-label={copy.navigation}>
        {sections.map(({ id, label, icon: Icon }) => <button type="button" key={id} aria-current={section === id ? 'page' : undefined} onClick={() => setSection(id)}><Icon size={17} /><span>{label}</span><ChevronRight size={14} /></button>)}
      </nav>
      <section className="settings-content" aria-label={sections.find((item) => item.id === section)?.label}>
        {section === 'display' ? <div className="settings-content__scroll"><header><h2>{copy.display}</h2><p>{copy.displayIntro}</p></header><section className="settings-group"><div className="settings-control-row"><span><strong>{copy.language}</strong><small>{copy.languageDetail}</small></span><div className="settings-language-control" role="group" aria-label={copy.language}><button type="button" aria-label="日本語" aria-pressed={locale === 'ja'} onClick={() => setLocale('ja')}><Languages size={14} />JA</button><button type="button" aria-label="English" aria-pressed={locale === 'en'} onClick={() => setLocale('en')}>EN</button></div></div><ReadOnlyRow label={copy.motion} value={`${copy.detected} · ${reducedMotion ? copy.motionOn : copy.motionOff}`} /><ReadOnlyRow label={copy.scale} value={copy.scaleValue} detail={copy.scaleDetail} /></section></div> : null}
        {section === 'notifications' ? <div className="settings-content__scroll"><header><h2>{copy.notifications}</h2><p>{copy.notificationsIntro}</p></header><section className="settings-group"><ReadOnlyRow label={copy.temporary} value={copy.temporaryValue} detail={copy.temporaryDetail} /><ReadOnlyRow label={copy.priority} value={copy.priorityValue} detail={copy.priorityDetail} /><p className="settings-unavailable-note">{copy.unavailableSetting}</p></section></div> : null}
        {section === 'codex' ? <div className="settings-content__scroll"><header><h2>{copy.codex}</h2><p>{copy.codexIntro}</p></header><section className="settings-group"><ReadOnlyRow label={copy.appServer} value={runtimeLoading && !runtimeInfo ? copy.checking : runtimeError ? copy.unavailable : runtimeStatus} /><ReadOnlyRow label={copy.delivery} value={copy.deliveryValue} /><ReadOnlyRow label={copy.sendState} value={runtimeInfo?.status === 'ready' && project.status !== 'offline' ? copy.available : copy.readOnly} /><ReadOnlyRow label={copy.integrity} value={runtimeInfo?.integrity ?? copy.unknown} /><ReadOnlyRow label={copy.model} value={copy.notReported} />{runtimeError ? <p className="settings-runtime-error" role="status">{runtimeError}</p> : null}<button type="button" className="settings-primary-action" disabled={runtimeLoading} onClick={() => void loadRuntime(true)}><RefreshCw size={15} className={runtimeLoading ? 'is-spinning' : ''} />{runtimeLoading ? copy.checking : copy.reconnect}</button></section></div> : null}
        {section === 'startup' ? <div className="settings-content__scroll"><header><h2>{copy.startup}</h2><p>{copy.startupIntro}</p></header><section className="settings-group"><ReadOnlyRow label={copy.previousProject} value={copy.hostManaged} detail={copy.previousProjectDetail} /><ReadOnlyRow label={copy.selector} value={copy.homeLauncher} detail={copy.selectorDetail} /><p className="settings-unavailable-note">{copy.unavailableSetting}</p></section></div> : null}
        {section === 'details' ? <div className="settings-content__scroll"><header><h2>{copy.details}</h2><p>{copy.detailsIntro}</p></header><section className="settings-group"><ReadOnlyRow label={copy.repository} value={project.repositoryDisplayState} /><ReadOnlyRow label={copy.root} value={project.rootPathLabel ?? copy.unknown} /><ReadOnlyRow label={copy.synced} value={formatDateTime(project.lastSyncedAt)} /><ReadOnlyRow label={copy.connection} value={project.connectionLabel} /></section><section className="settings-operations-card"><div><Activity size={18} /><span><strong>{copy.operations}</strong><small>{copy.operationsDetail}</small></span></div><button type="button" aria-label={copy.openOperations} onClick={onOpenOperations}>{copy.openOperations}<ChevronRight size={14} /></button><dl><div><dt>{copy.capability}</dt><dd>{copy.capabilityDetail}</dd></div><div><dt>{copy.acquisition}</dt><dd>{copy.acquisitionDetail}</dd></div><div><dt>{copy.audit}</dt><dd>{copy.auditDetail}</dd></div><div><dt>{copy.evidence}</dt><dd>{copy.evidenceDetail}</dd></div></dl></section></div> : null}
      </section>
    </div>
  );
}
