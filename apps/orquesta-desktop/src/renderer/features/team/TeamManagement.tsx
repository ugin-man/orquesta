import { Check, Plus, ShieldCheck, UsersRound } from 'lucide-react';
import { useState } from 'react';
import type { AgentProposal, StartInspectionUiInput, UiActionResult } from '../../../contracts/bridge';
import type {
  AgentUiModel,
  InspectionRunUiModel,
  InspectionTemplateUiModel,
  OrganizationUiSnapshot
} from '../../../contracts/orquesta-ui';
import { AgentGlyph } from '../../components/AgentGlyph';
import { OverlayFrame } from '../../components/OverlayFrame';
import { useI18n } from '../i18n/I18nProvider';
import { InspectionTemplateCard } from './InspectionTemplateCard';

export function TeamManagement({
  agents,
  proposals,
  inspectionTemplates,
  inspectionRuns,
  organization,
  onApprove,
  onStartInspection,
  onCancelInspection,
  onOpenInspectionReport,
  onClose
}: {
  agents: AgentUiModel[];
  proposals: AgentProposal[];
  inspectionTemplates: InspectionTemplateUiModel[];
  inspectionRuns: InspectionRunUiModel[];
  organization?: OrganizationUiSnapshot;
  onApprove(id: string): Promise<UiActionResult>;
  onStartInspection(input: StartInspectionUiInput): Promise<UiActionResult>;
  onCancelInspection(runId: string): Promise<UiActionResult>;
  onOpenInspectionReport(runId: string): void;
  onClose(): void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState<string | null>(null);
  const [approved, setApproved] = useState<Set<string>>(new Set());
  const [inspectionBusy, setInspectionBusy] = useState<string | null>(null);
  const approve = async (id: string) => {
    setBusy(id);
    const result = await onApprove(id);
    setBusy(null);
    if (result.status === 'accepted') setApproved((current) => new Set(current).add(id));
  };
  const startInspection = async (input: StartInspectionUiInput) => {
    setInspectionBusy(input.kind);
    try {
      return await onStartInspection(input);
    } finally {
      setInspectionBusy(null);
    }
  };
  const cancelInspection = async (runId: string, kind: string) => {
    setInspectionBusy(kind);
    try {
      return await onCancelInspection(runId);
    } finally {
      setInspectionBusy(null);
    }
  };
  return (
    <OverlayFrame title={t('teamManagement')} subtitle={t('teamIntro')} ariaLabel={t('teamManagement')} className="team-overlay" onClose={onClose}>
      <div className="team-layout">
        <section>
          <h3><UsersRound size={16} />{t('currentRoster')} <span>{agents.length}</span></h3>
          <div className="roster-list">{agents.map((agent) => (
            <article key={agent.id}>
              <span><AgentGlyph iconKey={agent.iconKey} size={18} /></span>
              <div><strong>{agent.displayName}</strong><small>{agent.roleSummary} · {agent.statusLabel}</small></div>
            </article>
          ))}</div>
        </section>
        <section className="team-candidates">
          <h3><Plus size={16} />{t('proposedRoles')} <span>{proposals.length + inspectionTemplates.length}</span></h3>
          <section className="inspection-template-section" aria-label={t('inspectionAgents')}>
            <header><strong>{t('inspectionAgents')}</strong><small>{t('inspectionAgentsDetail')}</small></header>
            <div className="inspection-template-list">
              {inspectionTemplates.map((template) => {
                const activeRun = template.activeRunId
                  ? inspectionRuns.find((run) => run.runId === template.activeRunId) ?? null
                  : null;
                return (
                  <InspectionTemplateCard
                    key={template.kind}
                    template={template}
                    activeRun={activeRun}
                    agents={agents}
                    organization={organization}
                    busy={inspectionBusy === template.kind}
                    onStart={startInspection}
                    onCancel={(runId) => cancelInspection(runId, template.kind)}
                    onOpenReport={onOpenInspectionReport}
                  />
                );
              })}
            </div>
          </section>
          <section className="role-proposal-section" aria-label={t('roleProposals')}>
            <header><strong>{t('roleProposals')}</strong></header>
            <div className="proposal-list">{proposals.length ? proposals.map((proposal) => (
              <article key={proposal.id}>
                <header><div><strong>{proposal.displayName}</strong><small>{proposal.role}</small></div><ShieldCheck size={17} /></header>
                <p>{proposal.reason}</p>
                <dl><div><dt>Scope</dt><dd>{proposal.contextScope}</dd></div><div><dt>Capacity</dt><dd>{proposal.capacityLabel}</dd></div></dl>
                <button type="button" onClick={() => void approve(proposal.id)} disabled={busy === proposal.id || approved.has(proposal.id)}>
                  {approved.has(proposal.id) ? <><Check size={14} />{t('approved')}</> : busy === proposal.id ? '…' : t('approve')}
                </button>
              </article>
            )) : <div className="empty-detail">{t('noRoleProposals')}</div>}</div>
          </section>
        </section>
      </div>
    </OverlayFrame>
  );
}
