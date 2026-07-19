import { Expand } from 'lucide-react';
import { useState } from 'react';
import type { ProjectUiModel } from '../../../contracts/orquesta-ui';
import { formatDateTime } from '../../components/format';
import { StatusDot } from '../../components/StatusDot';
import { useI18n } from '../i18n/I18nProvider';

export function ProjectStatusCard({ project, agentCount }: {
  project: ProjectUiModel;
  agentCount: number;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const connectionTone = project.status === 'working' || project.status === 'ready' ? 'success' : project.status;
  return (
    <section className={`floating-panel project-status${expanded ? ' is-expanded' : ''}`} aria-label={t('projectStatus')}>
      <button type="button" className="project-status__summary" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
        <header><span>{t('projectStatus')} <StatusDot status={connectionTone} label={project.connectionLabel} /></span><Expand size={13} aria-hidden="true" /></header>
        <strong>{project.title}</strong>
        <p>{agentCount} {t('agents')} <i /> {project.provenWorkingAgentCount} {t('provenWorking')}</p>
      </button>
      {expanded ? (
        <div className="project-status__expanded">
          <dl>
            <div><dt>{t('status')}</dt><dd>{project.connectionLabel}</dd></div>
            <div><dt>{t('lastSynced')}</dt><dd>{project.lastSyncedAt ? formatDateTime(project.lastSyncedAt) : t('unknown')}</dd></div>
            <div><dt>{t('nextMilestone')}</dt><dd>{project.nextMilestone ?? t('unknown')}</dd></div>
          </dl>
        </div>
      ) : null}
    </section>
  );
}
