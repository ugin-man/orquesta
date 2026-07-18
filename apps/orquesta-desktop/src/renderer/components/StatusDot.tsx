import type { AgentUiStatus, ProjectStatus } from '../../contracts/orquesta-ui';

export function StatusDot({ status, label }: { status: AgentUiStatus | ProjectStatus | 'neutral' | 'danger' | 'success'; label?: string }) {
  return <span className={`status-dot status-dot--${status}`} aria-label={label} title={label} />;
}
