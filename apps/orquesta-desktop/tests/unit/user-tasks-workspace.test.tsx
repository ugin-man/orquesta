import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import type { UiActionResult } from '../../src/contracts/bridge';
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
          onSubmit={vi.fn()}
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

  test('submits a free-text answer and keeps the item pending until canonical state changes', async () => {
    const user = userEvent.setup();
    let finish!: (result: UiActionResult) => void;
    const onSubmit = vi.fn(() => new Promise<UiActionResult>((resolve) => { finish = resolve; }));
    const question = attention({ id: 'Q1', type: 'question', actionKind: 'answer', title: 'Choose the release order', summary: 'Which milestone should ship first?' });

    render(
      <I18nProvider initialLocale="ja">
        <UserTasksWorkspace items={[question]} agents={[]} selectedKind="all" canResolve onSelectKind={vi.fn()} onSubmit={onSubmit} />
      </I18nProvider>
    );

    const answer = screen.getByRole('textbox', { name: '回答を入力' });
    const submit = screen.getByRole('button', { name: '回答を送信' });
    expect(submit).toBeDisabled();
    await user.type(answer, 'フェーズ1から公開する');
    await user.click(submit);
    expect(onSubmit).toHaveBeenCalledWith(question, 'フェーズ1から公開する');
    expect(screen.getByRole('status')).toHaveTextContent('送信中');

    await act(async () => finish({ status: 'accepted', correlationId: 'response-1' }));
    expect(screen.getByRole('status')).toHaveTextContent('反映待ち');
    expect(screen.getByRole('textbox', { name: '回答を入力' })).toHaveValue('フェーズ1から公開する');
  });

  test('preserves a failed answer and exposes retry', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async (): Promise<UiActionResult> => ({ status: 'failed', correlationId: 'response-2', reason: 'Coordinator is offline', retryable: true }));
    const question = attention({ id: 'Q1', type: 'question', actionKind: 'answer', title: 'Choose the release order', summary: 'Which milestone should ship first?' });

    render(
      <I18nProvider initialLocale="ja">
        <UserTasksWorkspace items={[question]} agents={[]} selectedKind="all" canResolve onSelectKind={vi.fn()} onSubmit={onSubmit} />
      </I18nProvider>
    );

    await user.type(screen.getByRole('textbox', { name: '回答を入力' }), '入力を失わない');
    await user.click(screen.getByRole('button', { name: '回答を送信' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Coordinator is offline');
    expect(screen.getByRole('textbox', { name: '回答を入力' })).toHaveValue('入力を失わない');
    expect(screen.getByRole('button', { name: '再送する' })).toBeVisible();
  });

  test('uses explicit choices for approvals, reviews, and manual work', () => {
    const { rerender } = render(
      <I18nProvider initialLocale="ja">
        <UserTasksWorkspace items={[attention({ id: 'A1', type: 'approval', actionKind: 'approve', title: 'Approve', summary: 'Approve the next phase.' })]} agents={[]} selectedKind="all" canResolve onSelectKind={vi.fn()} onSubmit={vi.fn()} />
      </I18nProvider>
    );
    expect(screen.getByRole('button', { name: '承認する' })).toBeVisible();
    expect(screen.getByRole('button', { name: '却下する' })).toBeVisible();

    rerender(
      <I18nProvider initialLocale="ja">
        <UserTasksWorkspace items={[attention({ id: 'R1', type: 'report_review', actionKind: 'review', title: 'Review', summary: 'Review the result.' })]} agents={[]} selectedKind="all" canResolve onSelectKind={vi.fn()} onSubmit={vi.fn()} />
      </I18nProvider>
    );
    expect(screen.getByRole('button', { name: '合格' })).toBeVisible();
    expect(screen.getByRole('button', { name: '修正を依頼' })).toBeVisible();

    rerender(
      <I18nProvider initialLocale="ja">
        <UserTasksWorkspace items={[attention({ id: 'D1', type: 'repair', actionKind: 'do', title: 'Manual', summary: 'Complete the local action.' })]} agents={[]} selectedKind="all" canResolve onSelectKind={vi.fn()} onSubmit={vi.fn()} />
      </I18nProvider>
    );
    expect(screen.getByRole('button', { name: '完了を報告' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'まだできない' })).toBeVisible();
  });
});
