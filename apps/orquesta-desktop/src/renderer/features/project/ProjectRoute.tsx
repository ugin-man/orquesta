import { CircleCheck, CircleDashed, CircleDot, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import type { ProjectPhaseUiModel, ProjectUiModel } from '../../../contracts/orquesta-ui';
import { OverlayFrame } from '../../components/OverlayFrame';
import { useI18n } from '../i18n/I18nProvider';

function PhaseIcon({ status }: { status: ProjectPhaseUiModel['status'] }) {
  if (status === 'done') return <CircleCheck size={18} />;
  if (status === 'current') return <CircleDot size={18} />;
  if (status === 'blocked') return <TriangleAlert size={18} />;
  return <CircleDashed size={18} />;
}

export function ProjectRoute({ project, phases, onClose }: { project: ProjectUiModel; phases: ProjectPhaseUiModel[]; onClose(): void }) {
  const { t } = useI18n();
  const [selectedId, setSelectedId] = useState(project.currentPhaseId ?? phases[0]?.id ?? null);
  const selected = phases.find((phase) => phase.id === selectedId) ?? phases[0];
  return (
    <OverlayFrame title={t('projectRoute')} subtitle={project.title} ariaLabel={t('projectRoute')} className="project-route-overlay" onClose={onClose}>
      <div className="project-route">
        <div className="project-route__track">
          {phases.map((phase, index) => (
            <button type="button" key={phase.id} className={`route-phase route-phase--${phase.status}${phase.id === selectedId ? ' is-selected' : ''}`} onClick={() => setSelectedId(phase.id)}>
              <span className="route-phase__line" aria-hidden="true" />
              <span className="route-phase__icon"><PhaseIcon status={phase.status} /></span>
              <strong>{phase.title}</strong>
              <small>{phase.completedItemCount}/{phase.itemCount}</small>
              <em>{phase.status}</em>
            </button>
          ))}
        </div>
        {selected ? (
          <section className="phase-detail">
            <header><div><small>{t('phaseDetails')}</small><h3>{selected.title}</h3></div><span>{selected.status}</span></header>
            <p>{selected.summary}</p>
            <dl><div><dt>Items</dt><dd>{selected.completedItemCount} / {selected.itemCount}</dd></div><div><dt>Owners</dt><dd>{selected.ownerAgentIds.join(', ') || '—'}</dd></div></dl>
          </section>
        ) : null}
      </div>
    </OverlayFrame>
  );
}
