import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import {
  WorkspaceDock,
  type WorkspaceCounts,
  type WorkspaceId
} from '../../src/renderer/features/navigation/WorkspaceDock';

const counts: WorkspaceCounts = {
  userTasks: 7
};

const labels = {
  navigation: 'Workspaces',
  home: 'Home',
  'user-tasks': 'User Tasks',
  records: 'Records',
  settings: 'Settings',
  more: 'More'
};

describe('WorkspaceDock', () => {
  test('renders five workspaces in a fixed order and exposes only the active text label', () => {
    render(<WorkspaceDock active="records" counts={counts} labels={labels} onSelect={vi.fn()} />);

    const navigation = screen.getByRole('navigation', { name: 'Workspaces' });
    const buttons = within(navigation).getAllByRole('button');

    expect(buttons).toHaveLength(5);
    expect(buttons.map((button) => button.getAttribute('data-workspace'))).toEqual([
      'home',
      'user-tasks',
      'records',
      'settings',
      'more'
    ] satisfies WorkspaceId[]);
    expect(within(buttons[2]).getByText('Records')).toBeVisible();
    expect(within(buttons[0]).queryByText('Home')).not.toBeInTheDocument();
    expect(buttons[2]).toHaveAttribute('aria-current', 'page');
    expect(buttons[0]).not.toHaveAttribute('aria-current');

    for (const [button, label] of buttons.map((button, index) => [button, Object.values(labels).slice(1)[index]] as const)) {
      expect(button).toHaveAttribute('title', label);
      expect(button).toHaveAttribute('aria-label', expect.stringContaining(label));
    }
  });

  test('shows a count only for User Tasks and selects Records', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<WorkspaceDock active="home" counts={counts} labels={labels} onSelect={onSelect} />);

    const navigation = screen.getByRole('navigation', { name: 'Workspaces' });
    expect(within(navigation).getByTestId('workspace-badge-user-tasks')).toHaveTextContent('7');
    expect(within(navigation).queryByTestId('workspace-badge-home')).not.toBeInTheDocument();
    expect(within(navigation).queryByTestId('workspace-badge-records')).not.toBeInTheDocument();
    expect(within(navigation).queryByTestId('workspace-badge-settings')).not.toBeInTheDocument();
    expect(within(navigation).queryByTestId('workspace-badge-more')).not.toBeInTheDocument();

    await user.click(within(navigation).getByRole('button', { name: 'Records' }));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith('records');
  });
});
