import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import { fixtureCatalog } from '../../src/fixtures';
import { attention } from '../../src/fixtures/helpers';
import { AttentionCard } from '../../src/renderer/features/attention/AttentionCard';
import { I18nProvider } from '../../src/renderer/features/i18n/I18nProvider';

describe('AttentionCard', () => {
  test('hides canonical mutation controls in read-only repository mode', () => {
    const snapshot = fixtureCatalog['active-project'].snapshot;
    render(
      <I18nProvider initialLocale="en">
        <AttentionCard
          items={snapshot.attention}
          agents={snapshot.agents}
          canResolve={false}
          onOpenItem={vi.fn()}
          onResolve={vi.fn()}
          onOpenAll={vi.fn()}
          onViewHistory={vi.fn()}
        />
      </I18nProvider>
    );
    expect(screen.queryByRole('button', { name: 'Resolve' })).not.toBeInTheDocument();
  });

  test('shows exactly the response options supplied by a runtime approval request', async () => {
    const snapshot = fixtureCatalog['active-project'].snapshot;
    const approval = {
      ...snapshot.attention[0],
      id: 'runtime-approval-1',
      type: 'approval' as const,
      runtimeApproval: {
        requestId: 'approval-1',
        method: 'item/fileChange/requestApproval',
        threadId: 'thread-1',
        turnId: 'turn-1',
        responseOptions: ['accept', 'acceptForSession', 'decline', 'cancel']
      }
    };
    const onResolve = vi.fn();
    render(
      <I18nProvider initialLocale="en">
        <AttentionCard
          items={[approval]}
          agents={snapshot.agents}
          canResolve
          onOpenItem={vi.fn()}
          onResolve={onResolve}
          onOpenAll={vi.fn()}
          onViewHistory={vi.fn()}
        />
      </I18nProvider>
    );

    for (const decision of approval.runtimeApproval.responseOptions) {
      expect(screen.getByRole('button', { name: decision })).toBeInTheDocument();
    }
    expect(screen.queryByRole('button', { name: 'Resolve' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'acceptForSession' }));
    expect(onResolve).toHaveBeenCalledWith(approval, 'acceptForSession');
  });

  test('shows total, non-zero action counts, and only the highest-priority five items', async () => {
    const onOpenAll = vi.fn();
    const items = [
      attention({ id: 'q1', type: 'question', actionKind: 'answer', title: 'Question 1', summary: 'One' }),
      attention({ id: 'q2', type: 'question', actionKind: 'answer', title: 'Question 2', summary: 'Two' }),
      attention({ id: 'r1', type: 'report_review', actionKind: 'review', title: 'Review 1', summary: 'Three', priority: 'blocker' }),
      attention({ id: 'd1', type: 'repair', actionKind: 'do', title: 'Task 1', summary: 'Four' }),
      attention({ id: 'd2', type: 'repair', actionKind: 'do', title: 'Task 2', summary: 'Five' }),
      attention({ id: 'd3', type: 'repair', actionKind: 'do', title: 'Task 3', summary: 'Six', priority: 'low' })
    ];
    render(
      <I18nProvider initialLocale="ja">
        <AttentionCard items={items} agents={[]} canResolve={false} onOpenItem={vi.fn()} onResolve={vi.fn()} onOpenAll={onOpenAll} onViewHistory={vi.fn()} />
      </I18nProvider>
    );

    expect(screen.getByText('要対応 6')).toBeVisible();
    expect(screen.getByText('回答 2')).toBeVisible();
    expect(screen.getByText('確認 1')).toBeVisible();
    expect(screen.queryByText(/承認 0/)).not.toBeInTheDocument();
    expect(screen.getAllByRole('article')).toHaveLength(5);
    expect(screen.queryByText('Task 3')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '要対応をすべて開く' }));
    expect(onOpenAll).toHaveBeenCalledOnce();
  });
});
