import { FolderOpen, MapPin, RotateCw } from 'lucide-react';
import { useState } from 'react';
import type { ProjectSummary, UiActionResult } from '../../../contracts/bridge';
import { OverlayFrame } from '../../components/OverlayFrame';
import { formatDateTime } from '../../components/format';
import { StatusDot } from '../../components/StatusDot';
import { useI18n } from '../i18n/I18nProvider';

export function ProjectSwitcher({ projects, currentProjectId, onSwitch, onOpenProject, onClose }: {
  projects: ProjectSummary[];
  currentProjectId: string;
  onSwitch(id: string): Promise<UiActionResult>;
  onOpenProject(): Promise<UiActionResult>;
  onClose(): void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const switchProject = async (id: string) => {
    setBusy(id); setMessage(null);
    const result = await onSwitch(id);
    setBusy(null);
    if (result.status === 'accepted') onClose(); else setMessage(result.reason);
  };
  const openProject = async () => {
    setBusy('open-project'); setMessage(null);
    const result = await onOpenProject();
    setBusy(null);
    if (result.status === 'accepted') onClose(); else setMessage(result.reason);
  };
  return (
    <OverlayFrame title={t('switchProjectTitle')} subtitle={t('recentProjects')} ariaLabel={t('switchProjectTitle')} className="project-switcher-overlay" onClose={onClose}>
      <div className="project-list">
        {projects.map((project) => (
          <button type="button" key={project.id} className={`project-list__item${project.id === currentProjectId ? ' is-current' : ''}`} onClick={() => void switchProject(project.id)} disabled={busy !== null}>
            <span className="project-list__icon"><FolderOpen size={20} /></span>
            <span className="project-list__copy"><strong>{project.title}</strong><small><MapPin size={12} />{project.rootPathLabel ?? t('pathUnavailable')}</small><em>{project.connectionLabel} · {formatDateTime(project.lastOpenedAt)}</em></span>
            <span className="project-list__status"><StatusDot status={project.status} />{project.id === currentProjectId ? t('currentProject') : busy === project.id ? <RotateCw className="is-spinning" size={15} /> : project.status}</span>
          </button>
        ))}
      </div>
      <button type="button" className="secondary-action" onClick={() => void openProject()} disabled={busy !== null}><FolderOpen size={16} />{t('openProjectFolder')}</button>
      {message ? <p className="inline-message">{message}</p> : null}
    </OverlayFrame>
  );
}
