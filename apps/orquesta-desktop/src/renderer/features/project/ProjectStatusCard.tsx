import { ArrowRight, Expand, FolderCog, GitBranch, MoreHorizontal } from 'lucide-react';
import { useState } from 'react';
import type { ProjectPhaseUiModel, ProjectUiModel } from '../../../contracts/orquesta-ui';
import { StatusDot } from '../../components/StatusDot';
import { useI18n } from '../i18n/I18nProvider';

export function ProjectStatusCard({ project, phases, onOpenRoute, onSwitchProject, onOpenOperations }: {
  project: ProjectUiModel;
  phases: ProjectPhaseUiModel[];
  onOpenRoute(): void;
  onSwitchProject(): void;
  onOpenOperations(): void;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const current = phases.find((phase) => phase.id === project.currentPhaseId) ?? phases.find((phase) => phase.status === 'current');
  const connectionTone = project.status === 'working' || project.status === 'ready' ? 'success' : project.status;
  const blocked = phases.find((phase) => phase.status === 'blocked');
  const runAction = (action: () => void) => {
    setExpanded(false);
    action();
  };
  return (
    <section className={`floating-panel project-status${expanded ? ' is-expanded' : ''}`} aria-label={t('projectStatus')}>
      <button type="button" className="project-status__summary" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
        <header><span>{t('projectStatus')} <StatusDot status={connectionTone} label={project.connectionLabel} /></span><Expand size={13} aria-hidden="true" /></header>
        <strong>{project.title}</strong>
        <p>{project.agentCount} {t('agents')} <i /> {project.provenWorkingAgentCount} {t('working').toLowerCase()}</p>
      </button>
      {expanded ? (
        <div className="project-status__expanded">
          <dl>
            <div><dt>{t('currentPhase')}</dt><dd>{current?.title ?? t('unknown')}</dd></div>
            <div><dt>{t('nextMilestone')}</dt><dd>{project.nextMilestone ?? t('unknown')}</dd></div>
            {blocked ? <div><dt>{t('blocked')}</dt><dd>{blocked.title}</dd></div> : null}
          </dl>
          <button type="button" onClick={() => runAction(onOpenRoute)}><GitBranch size={15} />{t('openProjectRoute')}<ArrowRight size={14} /></button>
          <button type="button" onClick={() => runAction(onSwitchProject)}><FolderCog size={15} />{t('switchProject')}<ArrowRight size={14} /></button>
          <button type="button" onClick={() => runAction(onOpenOperations)}><MoreHorizontal size={15} />{t('openOperations')}<ArrowRight size={14} /></button>
        </div>
      ) : null}
    </section>
  );
}
