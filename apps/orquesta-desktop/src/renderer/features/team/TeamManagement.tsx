import { Check, Plus, ShieldCheck, UsersRound } from 'lucide-react';
import { useState } from 'react';
import type { AgentProposal, UiActionResult } from '../../../contracts/bridge';
import type { AgentUiModel } from '../../../contracts/orquesta-ui';
import { AgentGlyph } from '../../components/AgentGlyph';
import { OverlayFrame } from '../../components/OverlayFrame';
import { useI18n } from '../i18n/I18nProvider';

export function TeamManagement({ agents, proposals, onApprove, onClose }: {
  agents: AgentUiModel[];
  proposals: AgentProposal[];
  onApprove(id: string): Promise<UiActionResult>;
  onClose(): void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState<string | null>(null);
  const [approved, setApproved] = useState<Set<string>>(new Set());
  const approve = async (id: string) => {
    setBusy(id);
    const result = await onApprove(id);
    setBusy(null);
    if (result.status === 'accepted') setApproved((current) => new Set(current).add(id));
  };
  return (
    <OverlayFrame title={t('teamManagement')} subtitle="Prototype roster proposal review" ariaLabel={t('teamManagement')} className="team-overlay" onClose={onClose}>
      <div className="team-layout">
        <section><h3><UsersRound size={16} />{t('currentRoster')} <span>{agents.length}</span></h3><div className="roster-list">{agents.map((agent) => <article key={agent.id}><span><AgentGlyph iconKey={agent.iconKey} size={18} /></span><div><strong>{agent.displayName}</strong><small>{agent.roleSummary} · {agent.statusLabel}</small></div></article>)}</div></section>
        <section><h3><Plus size={16} />{t('proposedRoles')} <span>{proposals.length}</span></h3><div className="proposal-list">{proposals.length ? proposals.map((proposal) => (
          <article key={proposal.id}><header><div><strong>{proposal.displayName}</strong><small>{proposal.role}</small></div><ShieldCheck size={17} /></header><p>{proposal.reason}</p><dl><div><dt>Scope</dt><dd>{proposal.contextScope}</dd></div><div><dt>Capacity</dt><dd>{proposal.capacityLabel}</dd></div></dl><button type="button" onClick={() => void approve(proposal.id)} disabled={busy === proposal.id || approved.has(proposal.id)}>{approved.has(proposal.id) ? <><Check size={14} />{t('approved')}</> : busy === proposal.id ? '…' : t('approve')}</button></article>
        )) : <div className="empty-detail">No new role proposals.</div>}</div></section>
      </div>
    </OverlayFrame>
  );
}
