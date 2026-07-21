import { FileText, Search, ShieldAlert, Square } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { StartInspectionUiInput, UiActionResult } from '../../../contracts/bridge';
import type {
  AgentUiModel,
  InspectionRunUiModel,
  InspectionTargetUi,
  InspectionTemplateUiModel,
  OrganizationUiSnapshot
} from '../../../contracts/orquesta-ui';
import { useI18n } from '../i18n/I18nProvider';

function inspectionName(kind: InspectionTemplateUiModel['kind'], t: (key: string) => string): string {
  return t(kind === 'external_benchmark' ? 'externalBenchmark' : 'adversarialAudit');
}

function statusLabel(run: InspectionRunUiModel | null, t: (key: string) => string): string {
  if (!run) return t('inspectionIdle');
  if (run.status === 'queued') return t('inspectionQueued');
  if (run.status === 'running') return t('inspectionRunning');
  if (run.status === 'cancelling') return t('inspectionCancelling');
  if (run.status === 'failed') return t('inspectionFailed');
  return t('inspectionComplete');
}

export function InspectionTemplateCard({
  template,
  activeRun,
  agents,
  organization,
  busy,
  onStart,
  onCancel,
  onOpenReport
}: {
  template: InspectionTemplateUiModel;
  activeRun: InspectionRunUiModel | null;
  agents: AgentUiModel[];
  organization?: OrganizationUiSnapshot;
  busy: boolean;
  onStart(input: StartInspectionUiInput): Promise<UiActionResult>;
  onCancel(runId: string): Promise<UiActionResult>;
  onOpenReport(runId: string): void;
}) {
  const { t } = useI18n();
  const [focus, setFocus] = useState('');
  const [scope, setScope] = useState<InspectionTargetUi['kind']>('project');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const name = inspectionName(template.kind, t);
  const isExternal = template.kind === 'external_benchmark';
  const lines = organization?.lines ?? [];
  const teams = organization?.teams ?? [];
  const target = useMemo<StartInspectionUiInput['target']>(() => {
    if (scope === 'project') return { kind: 'project', ids: [] };
    return { kind: scope, ids: selectedIds };
  }, [scope, selectedIds]);
  const targetValid = target.kind === 'project'
    || ((target.kind === 'line' || target.kind === 'team') && target.ids.length === 1)
    || (target.kind === 'agents' && target.ids.length > 0);
  const changeScope = (next: InspectionTargetUi['kind']) => {
    setScope(next);
    if (next === 'line') setSelectedIds(lines[0] ? [lines[0].id] : []);
    else if (next === 'team') setSelectedIds(teams[0] ? [teams[0].id] : []);
    else setSelectedIds([]);
  };
  const launch = () => onStart({
    kind: template.kind,
    target: isExternal ? { kind: 'project', ids: [] } : target,
    focus: isExternal && focus.trim() ? focus.trim() : null
  });
  const Icon = isExternal ? Search : ShieldAlert;

  return (
    <article className={`inspection-template-card inspection-template-card--${template.color}`} data-inspection-kind={template.kind}>
      <div className="inspection-template-card__identity">
        <span className="inspection-template-card__icon" aria-hidden="true"><Icon size={18} /></span>
        <div>
          <h4>{name}</h4>
          <p>{t(isExternal ? 'externalBenchmarkSummary' : 'adversarialAuditSummary')}</p>
        </div>
      </div>
      <div className="inspection-template-card__meta">
        <span><i />{t('readOnly')}</span>
        <strong>{statusLabel(activeRun, t)}</strong>
      </div>

      {!activeRun ? (
        <div className="inspection-template-card__controls">
          {isExternal ? (
            <label>
              <span>{t('optionalFocus')}</span>
              <input
                aria-label={t('optionalFocus')}
                value={focus}
                maxLength={4_096}
                placeholder={t('focusPlaceholder')}
                onChange={(event) => setFocus(event.target.value)}
              />
            </label>
          ) : (
            <>
              <label>
                <span>{t('auditScope')}</span>
                <select aria-label={t('auditScope')} value={scope} onChange={(event) => changeScope(event.target.value as InspectionTargetUi['kind'])}>
                  <option value="project">{t('scopeProject')}</option>
                  <option value="line" disabled={!lines.length}>{t('scopeLine')}</option>
                  <option value="team" disabled={!teams.length}>{t('scopeTeam')}</option>
                  <option value="agents">{t('scopeAgents')}</option>
                </select>
              </label>
              {scope === 'line' ? (
                <select aria-label={t('scopeLine')} value={selectedIds[0] ?? ''} onChange={(event) => setSelectedIds(event.target.value ? [event.target.value] : [])}>
                  {lines.map((line) => <option key={line.id} value={line.id}>{line.displayName}</option>)}
                </select>
              ) : null}
              {scope === 'team' ? (
                <select aria-label={t('scopeTeam')} value={selectedIds[0] ?? ''} onChange={(event) => setSelectedIds(event.target.value ? [event.target.value] : [])}>
                  {teams.map((team) => <option key={team.id} value={team.id}>{team.displayName}</option>)}
                </select>
              ) : null}
              {scope === 'agents' ? (
                <div className="inspection-agent-picker" role="group" aria-label={t('scopeAgents')}>
                  {agents.map((agent) => (
                    <label key={agent.id}>
                      <input
                        type="checkbox"
                        checked={selectedIds.includes(agent.id)}
                        onChange={(event) => setSelectedIds((current) => event.target.checked
                          ? [...current, agent.id]
                          : current.filter((id) => id !== agent.id))}
                      />
                      <span>{agent.displayName}</span>
                    </label>
                  ))}
                </div>
              ) : null}
            </>
          )}
          <button
            type="button"
            className="inspection-template-card__primary"
            aria-label={t(isExternal ? 'launchExternalBenchmark' : 'launchAdversarialAudit')}
            disabled={busy || !targetValid}
            onClick={() => void launch()}
          >
            <Icon size={14} />{busy ? '…' : t('launchInspection')}
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="inspection-template-card__cancel"
          aria-label={t(isExternal ? 'cancelExternalBenchmark' : 'cancelAdversarialAudit')}
          disabled={busy || activeRun.status === 'cancelling'}
          onClick={() => void onCancel(activeRun.runId)}
        >
          <Square size={12} />{t('cancelInspection')}
        </button>
      )}

      {template.lastReportRunId ? (
        <button
          type="button"
          className="inspection-template-card__report"
          aria-label={t(isExternal ? 'externalLastReport' : 'auditLastReport')}
          onClick={() => onOpenReport(template.lastReportRunId!)}
        >
          <FileText size={13} />{t('lastReport')}
        </button>
      ) : null}
    </article>
  );
}
