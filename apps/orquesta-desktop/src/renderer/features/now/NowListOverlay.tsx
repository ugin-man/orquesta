import { ArrowRight } from 'lucide-react';
import type { AgentUiModel, TaskUiModel } from '../../../contracts/orquesta-ui';
import { OverlayFrame } from '../../components/OverlayFrame';
import { statusLabel } from '../../components/format';
import { useI18n } from '../i18n/I18nProvider';
import { activeItems } from './NowCardStack';

export function NowListOverlay({ agents, tasks, onOpenTask, onOpenAllRecords, onClose }: {
  agents: AgentUiModel[];
  tasks: TaskUiModel[];
  onOpenTask(taskId: string): void;
  onOpenAllRecords(): void;
  onClose(): void;
}) {
  const { t } = useI18n();
  const active = activeItems(agents, tasks, true);
  return (
    <OverlayFrame title={t('activeWork')} ariaLabel={t('activeWork')} className="now-list-overlay" onClose={onClose}>
      <div className="overlay-list">
        {active.map(({ agent, task }) => (
          <button type="button" key={task.id} className="overlay-list__item" onClick={() => onOpenTask(task.id)}>
            <div><strong>{task.id} · {task.title}</strong><span>{agent.displayName} · {statusLabel(task.state)}</span></div>
            <span>{task.progressPercent == null ? '—' : `${task.progressPercent}%`}</span>
          </button>
        ))}
      </div>
      <footer className="quick-view-footer">
        <button type="button" className="quick-view-footer__action" onClick={onOpenAllRecords}>{t('viewAllRecords')}<ArrowRight size={15} /></button>
      </footer>
    </OverlayFrame>
  );
}
