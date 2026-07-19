import type { ProjectUiModel } from '../../../contracts/orquesta-ui';
import { formatDateTime } from '../../components/format';
import { useI18n } from '../i18n/I18nProvider';

export function RepositoryStatusPill({ project }: { project: ProjectUiModel }) {
  const { t } = useI18n();
  const label = {
    watching: t('repositoryWatching'),
    snapshot: t('repositorySnapshot'),
    offline: t('repositoryOffline'),
    demo: t('demoData'),
    error: t('repositoryError')
  }[project.repositoryDisplayState];
  const synced = project.lastSyncedAt ? formatDateTime(project.lastSyncedAt) : t('unknown');

  return (
    <span
      className={`repository-status-pill repository-status-pill--${project.repositoryDisplayState}`}
      aria-label={label}
      title={`${project.connectionLabel} · ${t('lastSynced')} ${synced}`}
    >
      <i aria-hidden="true" />{label}
    </span>
  );
}
