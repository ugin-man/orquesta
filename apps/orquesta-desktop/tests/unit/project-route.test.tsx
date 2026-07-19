import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { fixtureCatalog } from '../../src/fixtures';
import { formatDateTime } from '../../src/renderer/components/format';
import { I18nProvider } from '../../src/renderer/features/i18n/I18nProvider';
import { ProjectRoute } from '../../src/renderer/features/project/ProjectRoute';

describe('ProjectRoute', () => {
  test('shows the current snapshot source and refreshes its sync time when project props change', () => {
    const snapshot = fixtureCatalog['active-project'].snapshot;
    const view = render(
      <I18nProvider initialLocale="en">
        <ProjectRoute project={{ ...snapshot.project, repositoryDisplayState: 'snapshot', lastSyncedAt: '2026-07-18T01:00:00.000Z' }} phases={snapshot.phases} onClose={vi.fn()} />
      </I18nProvider>
    );

    expect(screen.getByText('Repository state loaded')).toBeVisible();
    expect(screen.getByText(formatDateTime('2026-07-18T01:00:00.000Z'))).toBeVisible();

    view.rerender(
      <I18nProvider initialLocale="en">
        <ProjectRoute project={{ ...snapshot.project, repositoryDisplayState: 'watching', lastSyncedAt: '2026-07-18T02:30:00.000Z' }} phases={snapshot.phases} onClose={vi.fn()} />
      </I18nProvider>
    );
    expect(screen.getByText('Watching state files')).toBeVisible();
    expect(screen.getByText(formatDateTime('2026-07-18T02:30:00.000Z'))).toBeVisible();
  });
});
