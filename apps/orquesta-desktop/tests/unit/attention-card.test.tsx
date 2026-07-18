import { render, screen } from '@testing-library/react';
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
});
