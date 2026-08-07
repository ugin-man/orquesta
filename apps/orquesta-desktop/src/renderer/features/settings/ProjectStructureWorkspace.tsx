import { Archive, BookOpen, CheckCircle2, FileCheck2, FolderTree, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import type { ProjectStructureSourceUi, ProjectStructureUiSnapshot } from '../../../contracts/orquesta-ui';
import { formatDateTime } from '../../components/format';
import { useI18n } from '../i18n/I18nProvider';

type StructureView = 'current' | 'history' | 'warnings' | 'context' | 'migration';

function SourceList({ sources, empty }: { sources: ProjectStructureSourceUi[]; empty: string }) {
  if (!sources.length) return <p className="project-structure-empty">{empty}</p>;
  return <div className="project-structure-list">{sources.map((source) => (
    <article key={`${source.lifecycle}:${source.sourceRef}`}>
      <code>{source.sourceRef}</code>
      <small>{source.componentId ?? 'unassigned'} · {source.authority} · {source.readPolicy}</small>
    </article>
  ))}</div>;
}

export function ProjectStructureWorkspace({ structure }: { structure?: ProjectStructureUiSnapshot }) {
  const { locale } = useI18n();
  const [view, setView] = useState<StructureView>('current');
  const copy = locale === 'ja' ? {
    title: 'Project structure', intro: '正本、旧版、構造上の問題、専門家の参照資料、移行結果を読み取り専用で確認します。',
    unavailable: 'このprojectには構造インベントリがまだありません。Core側で構造監査を実行すると、ここに結果が表示されます。',
    current: '現在の正本', history: '旧版と隔離', warnings: '構造警告', context: '専門家の資料', migration: 'Migration Plan',
    indexed: '索引済み', canonical: '正本', retired: '旧版・隔離', issues: '警告', contexts: '資料セット',
    currentIntro: '現在の正本として扱われているファイルです。表示は最大64件です。', noCurrent: '正本として分類されたファイルはありません。',
    historyIntro: 'superseded、archived、quarantined、削除候補として通常の参照から外れたファイルです。', noHistory: '旧版または隔離されたファイルはありません。',
    currentCount: 'current', supersededCount: 'superseded', archivedCount: 'archived', quarantinedCount: 'quarantined', deleteCount: '削除候補',
    warningsIntro: '構造監査が検出した問題です。suggestionは自動変更を要求しません。', noWarnings: 'errorとwarningはありません。',
    contextIntro: 'タスクごとに専門家へ渡されたrequired readingです。完了済みタスクも履歴として残します。', noContext: '専門家へ渡された参照資料は記録されていません。', active: '稼働対象', recorded: '履歴', owner: '担当',
    contextIndex: '初期コンテキスト索引', candidateSources: '候補', excludedSources: '除外',
    migrationIntro: '承認済みの物理移行と検証、ロールバック可能性を確認します。', noMigration: 'Migration Planはありません。',
    plan: 'Plan', result: 'Result', status: '状態', operations: '操作', destructive: '破壊操作', approval: '承認', verification: '検証', rollback: 'Rollback', appliedAt: '適用日時',
    passed: '通過', warning: '要確認', notRun: '未実行', healthy: '正常', attention: '要確認', blocked: '停止', generated: '生成'
  } : {
    title: 'Project structure', intro: 'Inspect canonical sources, retired material, structure issues, specialist reading, and migration evidence without modifying files.',
    unavailable: 'This project does not have a structure inventory yet. Run the Core structure audit to populate this view.',
    current: 'Current canon', history: 'Retired & quarantined', warnings: 'Structure warnings', context: 'Specialist reading', migration: 'Migration Plan',
    indexed: 'Indexed', canonical: 'Canonical', retired: 'Retired', issues: 'Issues', contexts: 'Context sets',
    currentIntro: 'Files currently classified as canonical. The display is bounded to 64 entries.', noCurrent: 'No files are classified as canonical.',
    historyIntro: 'Files excluded from normal reads as superseded, archived, quarantined, or delete candidates.', noHistory: 'No retired or quarantined files are recorded.',
    currentCount: 'current', supersededCount: 'superseded', archivedCount: 'archived', quarantinedCount: 'quarantined', deleteCount: 'delete candidates',
    warningsIntro: 'Issues found by the structure audit. Suggestions do not authorize automatic changes.', noWarnings: 'No errors or warnings are recorded.',
    contextIntro: 'Required reading passed to specialists per task. Completed tasks remain visible as history.', noContext: 'No specialist reading is recorded.', active: 'Active', recorded: 'Recorded', owner: 'Owner',
    contextIndex: 'Initial context index', candidateSources: 'Candidates', excludedSources: 'Excluded',
    migrationIntro: 'Review the approved physical migration, verification, and rollback evidence.', noMigration: 'No Migration Plan is recorded.',
    plan: 'Plan', result: 'Result', status: 'Status', operations: 'Operations', destructive: 'Destructive', approval: 'Approval', verification: 'Verification', rollback: 'Rollback', appliedAt: 'Applied at',
    passed: 'Passed', warning: 'Review', notRun: 'Not run', healthy: 'Healthy', attention: 'Attention', blocked: 'Blocked', generated: 'Generated'
  };
  if (!structure?.available) {
    return <div className="settings-content__scroll project-structure-workspace"><header><h2>{copy.title}</h2><p>{copy.intro}</p></header><section className="settings-empty-state"><FolderTree size={22} /><p>{structure?.limitation ?? copy.unavailable}</p></section></div>;
  }
  const retiredCount = structure.lifecycleCounts.superseded
    + structure.lifecycleCounts.archived
    + structure.lifecycleCounts.quarantined
    + structure.lifecycleCounts.deleteCandidate;
  const statusLabel = structure.status === 'healthy' ? copy.healthy : structure.status === 'attention' ? copy.attention : copy.blocked;
  const views: Array<{ id: StructureView; label: string; icon: typeof FolderTree; count?: number }> = [
    { id: 'current', label: copy.current, icon: FileCheck2, count: structure.canonicalSourceCount },
    { id: 'history', label: copy.history, icon: Archive, count: retiredCount },
    { id: 'warnings', label: copy.warnings, icon: ShieldAlert, count: structure.issueCounts.error + structure.issueCounts.warning + structure.issueCounts.suggestion },
    { id: 'context', label: copy.context, icon: BookOpen, count: structure.specialistContexts.length },
    { id: 'migration', label: copy.migration, icon: CheckCircle2 }
  ];
  return (
    <div className="settings-content__scroll project-structure-workspace">
      <header><div><h2>{copy.title}</h2><p>{copy.intro}</p></div><span className={`project-structure-status is-${structure.status}`}>{statusLabel}</span></header>
      <section className="project-structure-stats" aria-label={copy.title}>
        <div><strong>{structure.indexedFileCount}</strong><span>{copy.indexed}</span></div>
        <div><strong>{structure.canonicalSourceCount}</strong><span>{copy.canonical}</span></div>
        <div><strong>{retiredCount}</strong><span>{copy.retired}</span></div>
        <div><strong>{structure.issueCounts.error + structure.issueCounts.warning}</strong><span>{copy.issues}</span></div>
        <div><strong>{structure.specialistContexts.length}</strong><span>{copy.contexts}</span></div>
      </section>
      <nav className="project-structure-tabs" aria-label={copy.title}>
        {views.map(({ id, label, icon: Icon, count }) => <button type="button" key={id} aria-current={view === id ? 'page' : undefined} onClick={() => setView(id)}><Icon size={14} /><span>{label}</span>{typeof count === 'number' ? <em>{count}</em> : null}</button>)}
      </nav>
      <section className="project-structure-panel">
        {view === 'current' ? <><header><h3>{copy.current}</h3><p>{copy.currentIntro}</p></header><SourceList sources={structure.canonicalSources} empty={copy.noCurrent} /></> : null}
        {view === 'history' ? <><header><h3>{copy.history}</h3><p>{copy.historyIntro}</p></header><dl className="project-structure-counts"><div><dt>{copy.currentCount}</dt><dd>{structure.lifecycleCounts.current}</dd></div><div><dt>{copy.supersededCount}</dt><dd>{structure.lifecycleCounts.superseded}</dd></div><div><dt>{copy.archivedCount}</dt><dd>{structure.lifecycleCounts.archived}</dd></div><div><dt>{copy.quarantinedCount}</dt><dd>{structure.lifecycleCounts.quarantined}</dd></div><div><dt>{copy.deleteCount}</dt><dd>{structure.lifecycleCounts.deleteCandidate}</dd></div></dl><SourceList sources={structure.retiredSources} empty={copy.noHistory} /></> : null}
        {view === 'warnings' ? <><header><h3>{copy.warnings}</h3><p>{copy.warningsIntro}</p></header>{structure.issues.length ? <div className="project-structure-list">{structure.issues.map((issue, index) => <article key={`${issue.code}:${index}`} className={`is-${issue.severity}`}><strong>{issue.code}</strong><p>{issue.message}</p>{issue.sourceRefs.length ? <small>{issue.sourceRefs.join(' · ')}</small> : null}</article>)}</div> : <p className="project-structure-empty">{copy.noWarnings}</p>}</> : null}
        {view === 'context' ? <><header><h3>{copy.context}</h3><p>{copy.contextIntro}</p></header><div className="project-structure-context-index"><strong>{copy.contextIndex}</strong><span>{structure.contextOverview.viewId ?? '—'}</span><small>{copy.candidateSources} {structure.contextOverview.candidateSourceCount} · {copy.excludedSources} {structure.contextOverview.excludedSourceCount}</small></div>{structure.specialistContexts.length ? <div className="project-structure-contexts">{structure.specialistContexts.map((context) => <article key={context.taskId}><header><span><strong>{context.taskId}</strong><small>{context.taskTitle}</small></span><em className={context.active ? 'is-active' : ''}>{context.active ? copy.active : copy.recorded}</em></header><p>{copy.owner}: {context.ownerAgentId ?? '—'} · {context.taskState}</p><ul>{context.requiredReading.map((source) => <li key={source}><code>{source}</code></li>)}</ul></article>)}</div> : <p className="project-structure-empty">{copy.noContext}</p>}</> : null}
        {view === 'migration' ? <><header><h3>{copy.migration}</h3><p>{copy.migrationIntro}</p></header>{structure.migration ? <dl className="project-structure-migration"><div><dt>{copy.plan}</dt><dd>{structure.migration.planId ?? '—'}</dd></div><div><dt>{copy.result}</dt><dd>{structure.migration.resultId ?? '—'}</dd></div><div><dt>{copy.status}</dt><dd>{structure.migration.status}</dd></div><div><dt>{copy.operations}</dt><dd>{structure.migration.operationCount}</dd></div><div><dt>{copy.destructive}</dt><dd>{structure.migration.destructiveOperationCount}</dd></div><div><dt>{copy.approval}</dt><dd>{structure.migration.approvalDecision ?? '—'}</dd></div><div><dt>{copy.verification}</dt><dd>{structure.migration.verificationStatus === 'passed' ? copy.passed : structure.migration.verificationStatus === 'warning' ? copy.warning : copy.notRun}</dd></div><div><dt>{copy.rollback}</dt><dd>{structure.migration.rollbackStepCount}</dd></div><div><dt>{copy.appliedAt}</dt><dd>{formatDateTime(structure.migration.appliedAt)}</dd></div></dl> : <p className="project-structure-empty">{copy.noMigration}</p>}</> : null}
      </section>
      <footer className="project-structure-generated">{copy.generated}: {formatDateTime(structure.generatedAt)}</footer>
    </div>
  );
}
