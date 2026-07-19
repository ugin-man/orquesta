import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import {
  WorkspaceDock,
  type WorkspaceCounts,
  type WorkspaceId
} from '../../src/renderer/features/navigation/WorkspaceDock';

const counts: WorkspaceCounts = {
  attention: 7,
  tasks: 4,
  failures: 2,
  conversation: 3
};

const labels = {
  navigation: 'Workspaces',
  home: 'Home',
  attention: 'Attention',
  tasks: 'Tasks',
  failures: 'Failures',
  conversation: 'Conversation',
  more: 'More'
};

describe('WorkspaceDock', () => {
  test('renders six workspaces in a fixed order and exposes only the active text label', () => {
    render(<WorkspaceDock active="tasks" counts={counts} labels={labels} onSelect={vi.fn()} />);

    const navigation = screen.getByRole('navigation', { name: 'Workspaces' });
    const buttons = within(navigation).getAllByRole('button');

    expect(buttons).toHaveLength(6);
    expect(buttons.map((button) => button.getAttribute('data-workspace'))).toEqual([
      'home',
      'attention',
      'tasks',
      'failures',
      'conversation',
      'more'
    ] satisfies WorkspaceId[]);
    expect(within(buttons[2]).getByText('Tasks')).toBeVisible();
    expect(within(buttons[0]).queryByText('Home')).not.toBeInTheDocument();
    expect(buttons[2]).toHaveAttribute('aria-current', 'page');
    expect(buttons[0]).not.toHaveAttribute('aria-current');

    for (const [button, label] of buttons.map((button, index) => [button, Object.values(labels).slice(1)[index]] as const)) {
      expect(button).toHaveAttribute('title', label);
      expect(button).toHaveAttribute('aria-label', expect.stringContaining(label));
    }
  });

  test('shows counts only for attention, tasks, failures, and conversation and selects a workspace', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<WorkspaceDock active="home" counts={counts} labels={labels} onSelect={onSelect} />);

    const navigation = screen.getByRole('navigation', { name: 'Workspaces' });
    expect(within(navigation).getByTestId('workspace-badge-attention')).toHaveTextContent('7');
    expect(within(navigation).getByTestId('workspace-badge-tasks')).toHaveTextContent('4');
    expect(within(navigation).getByTestId('workspace-badge-failures')).toHaveTextContent('2');
    expect(within(navigation).getByTestId('workspace-badge-conversation')).toHaveTextContent('3');
    expect(within(navigation).queryByTestId('workspace-badge-home')).not.toBeInTheDocument();
    expect(within(navigation).queryByTestId('workspace-badge-more')).not.toBeInTheDocument();

    await user.click(within(navigation).getByRole('button', { name: 'Failures 2' }));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith('failures');
  });
});
