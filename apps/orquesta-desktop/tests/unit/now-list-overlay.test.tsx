import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { agent, task } from '../../src/fixtures/helpers';
import { I18nProvider } from '../../src/renderer/features/i18n/I18nProvider';
import { NowListOverlay } from '../../src/renderer/features/now/NowListOverlay';

describe('NowListOverlay', () => {
  test('uses the same proven-working evidence filter as the Home Now card', () => {
    render(
      <I18nProvider initialLocale="ja">
        <NowListOverlay
          agents={[
            agent({
              id: 'reviewer',
              displayName: '確認係',
              role: 'reviewer',
              roleSummary: 'Reviews completed work.',
              iconKey: 'shield',
              status: 'report_ready',
              statusEvidence: 'proven',
              currentTaskId: 'T-review'
            })
          ]}
          tasks={[
            task({
              id: 'T-review',
              title: 'Review submitted report',
              state: 'report_ready',
              turnStarted: true,
              progressObserved: true
            })
          ]}
          onOpenTask={vi.fn()}
          onClose={vi.fn()}
        />
      </I18nProvider>
    );

    expect(screen.queryByText(/T-review/u)).not.toBeInTheDocument();
  });
});
