import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import { I18nProvider } from '../../src/renderer/features/i18n/I18nProvider';
import { ProjectSwitcher } from '../../src/renderer/features/project/ProjectSwitcher';

describe('ProjectSwitcher', () => {
  test('recovers controls and shows the reason when project switching throws', async () => {
    const onSwitch = vi.fn(async () => { throw new Error('IPC disconnected'); });
    render(
      <I18nProvider initialLocale="en">
        <ProjectSwitcher
          projects={[
            { id: 'current', title: 'Current', rootPathLabel: 'C:\\current', status: 'ready', connectionLabel: 'Ready', lastOpenedAt: '2026-07-19T00:00:00Z' },
            { id: 'next', title: 'Next', rootPathLabel: 'C:\\next', status: 'ready', connectionLabel: 'Ready', lastOpenedAt: '2026-07-19T00:00:00Z' }
          ]}
          currentProjectId="current"
          onSwitch={onSwitch}
          onOpenProject={vi.fn()}
          onClose={vi.fn()}
        />
      </I18nProvider>
    );

    await userEvent.click(screen.getByRole('button', { name: /Next/ }));
    expect(await screen.findByText('IPC disconnected')).toBeVisible();
    expect(screen.getByRole('button', { name: /Next/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Open project folder' })).toBeEnabled();
  });
});
