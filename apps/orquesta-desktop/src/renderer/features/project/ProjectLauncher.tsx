import { ChevronDown, FolderOpen, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import type { ProjectUiModel } from '../../../contracts/orquesta-ui';
import { useI18n } from '../i18n/I18nProvider';

export function ProjectLauncher({ project, onSwitchProject, onOpenProject }: {
  project: ProjectUiModel;
  onSwitchProject(): void;
  onOpenProject(): void;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const run = (action: () => void) => {
    setExpanded(false);
    action();
  };

  return (
    <section className={`project-launcher${expanded ? ' is-expanded' : ''}`} aria-label={t('projectLauncher')}>
      <button
        type="button"
        className="project-launcher__summary"
        aria-label={t('projectActions')}
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span><FolderOpen size={15} aria-hidden="true" /></span>
        <span className="project-launcher__copy"><strong>{project.title}</strong><small title={project.rootPathLabel ?? t('pathUnavailable')}>{project.rootPathLabel ?? t('pathUnavailable')}</small></span>
        <ChevronDown className="project-launcher__toggle-icon" size={14} aria-hidden="true" />
      </button>
      <div className="project-launcher__menu" data-testid="project-launcher-menu" aria-hidden={!expanded}>
        <div className="project-launcher__menu-inner">
          <button type="button" tabIndex={expanded ? 0 : -1} onClick={() => run(onSwitchProject)}><RefreshCw size={14} />{t('switchProject')}</button>
          <button type="button" tabIndex={expanded ? 0 : -1} onClick={() => run(onOpenProject)}><FolderOpen size={14} />{t('openProjectFolder')}</button>
        </div>
      </div>
    </section>
  );
}
