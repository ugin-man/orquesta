import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test } from 'vitest';
import { agent, task } from '../../src/fixtures/helpers';
import {
  createDefaultTaskRecordView,
  TaskRecordsWorkspace,
  type TaskRecordView
} from '../../src/renderer/features/records/TaskRecordsWorkspace';
import { I18nProvider } from '../../src/renderer/features/i18n/I18nProvider';

const agents = [
  agent({ id: 'coder', displayName: 'Coder', role: 'Implementation', roleSummary: 'Builds product code', iconKey: 'code' }),
  agent({ id: 'analyst', displayName: 'Analyst', role: 'Research', roleSummary: 'Investigates source material', iconKey: 'chart' })
];

const tasks = [
  task({ id: 'T1', title: 'Implement task records', state: 'in_progress', ownerAgentId: 'coder', progressSummary: 'Building the records grid.', progressPercent: 45, updatedAt: '2026-07-19T09:00:00Z' }),
  task({ id: 'T2', title: 'Blocked sync', state: 'blocked', ownerAgentId: 'analyst', blockedBy: ['API unavailable'], progressSummary: 'Waiting for the source.', updatedAt: '2026-07-18T09:00:00Z' }),
  task({ id: 'T3', title: 'Accepted foundation', state: 'accepted', ownerAgentId: 'coder', reportPath: '.orquesta/reports/T3.md', updatedAt: '2026-07-17T09:00:00Z' }),
  task({ id: 'T4', title: 'Failed import', state: 'failed', ownerAgentId: 'analyst', progressSummary: 'Parser rejected the input.', updatedAt: '2026-07-16T09:00:00Z' })
];

function Harness({ initialView = createDefaultTaskRecordView() }: { initialView?: TaskRecordView }) {
  const [view, setView] = useState(initialView);
  return (
    <I18nProvider initialLocale="en">
      <TaskRecordsWorkspace tasks={tasks} agents={agents} view={view} onViewChange={setView} />
    </I18nProvider>
  );
}

describe('TaskRecordsWorkspace', () => {
  test('separates incomplete, completed, and all tasks', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const scopes = screen.getByRole('navigation', { name: 'Task scopes' });
    expect(within(scopes).getByRole('button', { name: 'Incomplete 3' })).toHaveAttribute('aria-current', 'page');
    expect(within(scopes).getByRole('button', { name: 'Completed 1' })).toBeVisible();
    expect(within(scopes).getByRole('button', { name: 'All 4' })).toBeVisible();
    expect(screen.getByRole('button', { name: /T1 · Implement task records/ })).toBeVisible();
    expect(screen.queryByRole('button', { name: /T3 · Accepted foundation/ })).not.toBeInTheDocument();

    await user.click(within(scopes).getByRole('button', { name: 'Completed 1' }));
    expect(screen.getByRole('button', { name: /T3 · Accepted foundation/ })).toBeVisible();
    expect(screen.queryByRole('button', { name: /T1 · Implement task records/ })).not.toBeInTheDocument();
  });

  test('filters, searches, and opens task details inside Records', async () => {
    const user = userEvent.setup();
    render(<Harness initialView={{ ...createDefaultTaskRecordView(), scope: 'all' }} />);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Agent' }), 'analyst');
    await user.selectOptions(screen.getByRole('combobox', { name: 'State' }), 'blocked');
    expect(screen.getByRole('button', { name: /T2 · Blocked sync/ })).toBeVisible();
    expect(screen.queryByRole('button', { name: /T4 · Failed import/ })).not.toBeInTheDocument();

    await user.selectOptions(screen.getByRole('combobox', { name: 'State' }), 'all');
    await user.type(screen.getByRole('searchbox', { name: 'Search tasks' }), 'T4');
    expect(screen.getByRole('button', { name: /T4 · Failed import/ })).toBeVisible();
    expect(screen.queryByRole('button', { name: /T2 · Blocked sync/ })).not.toBeInTheDocument();

    await user.clear(screen.getByRole('searchbox', { name: 'Search tasks' }));
    await user.click(screen.getByRole('button', { name: /T2 · Blocked sync/ }));
    const detail = screen.getByRole('region', { name: 'Task T2 detail' });
    expect(within(detail).getByText('API unavailable')).toBeVisible();
    expect(screen.getByTestId('task-record-layout')).toHaveClass('task-record-layout--detail-open');

    await user.click(within(detail).getByRole('button', { name: 'Close task detail' }));
    expect(screen.queryByRole('region', { name: 'Task T2 detail' })).not.toBeInTheDocument();
  });
});
