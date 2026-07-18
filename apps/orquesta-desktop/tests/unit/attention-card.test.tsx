import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import { fixtureCatalog } from '../../src/fixtures';
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
});
