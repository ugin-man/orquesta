import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import { agent, attention } from '../../src/fixtures/helpers';
import { UserTasksWorkspace } from '../../src/renderer/features/attention/UserTasksWorkspace';
import { I18nProvider } from '../../src/renderer/features/i18n/I18nProvider';

describe('UserTasksWorkspace', () => {
  test('keeps type counts visible and switches the inline detail without leaving the workspace', async () => {
    const user = userEvent.setup();
    const onSelectKind = vi.fn();
    const items = [
      attention({ id: 'Q1', type: 'question', actionKind: 'answer', title: 'Choose the release order', summary: 'Which milestone should ship first?', sourceAgentId: 'manager', taskId: 'T21', priority: 'high' }),
      attention({ id: 'Q2', type: 'question', actionKind: 'answer', title: 'Confirm the empty state', summary: 'Should zero-count types stay visible?', sourceAgentId: 'manager', taskId: 'T22' }),
      attention({ id: 'R1', type: 'report_review', actionKind: 'review', title: 'Review the Home shell', summary: 'Check the visible information hierarchy.', sourceAgentId: 'manager', taskId: 'T20' })
    ];
    const agents = [agent({ id: 'manager', displayName: 'Orquesta 統括者', role: 'coordinator', roleSummary: 'Coordinates work', iconKey: 'manager' })];

    render(
      <I18nProvider initialLocale="ja">
        <UserTasksWorkspace
          items={items}
          agents={agents}
          selectedKind="all"
          canResolve={false}
          onSelectKind={onSelectKind}
          onResolve={vi.fn()}
        />
      </I18nProvider>
    );

    const filters = screen.getByRole('navigation', { name: 'ユーザータスクの種類' });
    expect(within(filters).getByRole('button', { name: 'すべて 3' })).toBeVisible();
    expect(within(filters).getByRole('button', { name: '質問 2' })).toBeVisible();
    expect(within(filters).getByRole('button', { name: '承認 0' })).toBeVisible();
    expect(within(filters).getByRole('button', { name: '確認 1' })).toBeVisible();
    expect(within(filters).getByRole('button', { name: '手動作業 0' })).toBeVisible();

    const list = screen.getByRole('region', { name: 'ユーザータスク一覧' });
    const detail = screen.getByRole('region', { name: 'ユーザータスク詳細' });
    expect(within(detail).getByRole('heading', { name: 'Choose the release order' })).toBeVisible();
    expect(within(detail).getByText('T21')).toBeVisible();
    expect(within(detail).getByText('Orquesta 統括者')).toBeVisible();

    await user.click(within(list).getByRole('button', { name: /Confirm the empty state/ }));
    expect(within(detail).getByRole('heading', { name: 'Confirm the empty state' })).toBeVisible();

    await user.click(within(filters).getByRole('button', { name: '質問 2' }));
    expect(onSelectKind).toHaveBeenCalledWith('answer');
  });
});
