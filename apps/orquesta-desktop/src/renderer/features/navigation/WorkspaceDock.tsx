import {
  Bell,
  CircleEllipsis,
  House,
  ListTodo,
  MessageCircle,
  TriangleAlert,
  type LucideIcon
} from 'lucide-react';

export type WorkspaceId = 'home' | 'attention' | 'tasks' | 'failures' | 'conversation' | 'more';

export interface WorkspaceCounts {
  attention: number;
  tasks: number;
  failures: number;
  conversation: number;
}

export interface WorkspaceLabels extends Record<WorkspaceId, string> {
  navigation: string;
}

export interface WorkspaceDockProps {
  active: WorkspaceId;
  counts: WorkspaceCounts;
  labels: WorkspaceLabels;
  onSelect: (workspace: WorkspaceId) => void;
}

interface WorkspaceDefinition {
  id: WorkspaceId;
  icon: LucideIcon;
}

const workspaces: readonly WorkspaceDefinition[] = [
  { id: 'home', icon: House },
  { id: 'attention', icon: Bell },
  { id: 'tasks', icon: ListTodo },
  { id: 'failures', icon: TriangleAlert },
  { id: 'conversation', icon: MessageCircle },
  { id: 'more', icon: CircleEllipsis }
];

function workspaceCount(id: WorkspaceId, counts: WorkspaceCounts): number | undefined {
  if (id === 'home' || id === 'more') {
    return undefined;
  }
  return counts[id] > 0 ? counts[id] : undefined;
}

export function WorkspaceDock({ active, counts, labels, onSelect }: WorkspaceDockProps) {
  return (
    <nav className="workspace-dock" aria-label={labels.navigation}>
      {workspaces.map(({ id, icon: Icon }) => {
        const label = labels[id];
        const count = workspaceCount(id, counts);
        const selected = active === id;
        const accessibleLabel = count === undefined ? label : `${label} ${count}`;

        return (
          <button
            key={id}
            type="button"
            className={`workspace-dock-item${selected ? ' is-active' : ''}`}
            data-workspace={id}
            aria-current={selected ? 'page' : undefined}
            aria-label={accessibleLabel}
            title={label}
            onClick={() => onSelect(id)}
          >
            <Icon className="workspace-dock-icon" aria-hidden="true" />
            {selected ? <span className="workspace-dock-label">{label}</span> : null}
            {count === undefined ? null : (
              <span
                className="workspace-dock-badge"
                data-testid={`workspace-badge-${id}`}
                aria-hidden="true"
              >
                {count}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
