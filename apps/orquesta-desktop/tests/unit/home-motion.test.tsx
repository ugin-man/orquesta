import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { fixtureCatalog } from '../../src/fixtures';
import { OverlayFrame } from '../../src/renderer/components/OverlayFrame';
import { I18nProvider } from '../../src/renderer/features/i18n/I18nProvider';
import { ProjectLauncher } from '../../src/renderer/features/project/ProjectLauncher';
import { ProjectStatusCard } from '../../src/renderer/features/project/ProjectStatusCard';

function withEnglish(children: React.ReactNode) {
  return <I18nProvider initialLocale="en">{children}</I18nProvider>;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Home interaction motion', () => {
  test('keeps Project Status content mounted and changes the expand icon state', () => {
    const project = fixtureCatalog['active-project'].snapshot.project;
    render(withEnglish(<ProjectStatusCard project={project} agentCount={12} />));

    const panel = screen.getByLabelText(/project status/i);
    const toggle = within(panel).getByRole('button');
    const content = screen.getByTestId('project-status-expanded');
    const icon = screen.getByTestId('project-status-toggle-icon');

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(content).toHaveAttribute('aria-hidden', 'true');
    expect(icon).toHaveAttribute('data-state', 'collapsed');

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(content).toHaveAttribute('aria-hidden', 'false');
    expect(icon).toHaveAttribute('data-state', 'expanded');
  });

  test('keeps Project Launcher actions mounted but unavailable while collapsed', () => {
    const project = fixtureCatalog['active-project'].snapshot.project;
    render(withEnglish(<ProjectLauncher project={project} onSwitchProject={vi.fn()} onOpenProject={vi.fn()} />));

    const launcher = screen.getByLabelText(/project launcher/i);
    const toggle = within(launcher).getByRole('button', { name: /project actions/i });
    const menu = screen.getByTestId('project-launcher-menu');
    const actions = within(menu).getAllByRole('button', { hidden: true });

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(menu).toHaveAttribute('aria-hidden', 'true');
    expect(actions.every((button) => button.tabIndex === -1)).toBe(true);

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(menu).toHaveAttribute('aria-hidden', 'false');
    expect(actions.every((button) => button.tabIndex === 0)).toBe(true);
  });

  test('plays the common close state before notifying the overlay owner', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(withEnglish(
      <OverlayFrame title="Motion review" ariaLabel="Motion review" onClose={onClose}>
        <button type="button">Inside</button>
      </OverlayFrame>
    ));

    fireEvent.click(screen.getByRole('button', { name: /close motion review/i }));

    expect(screen.getByRole('dialog')).toHaveAttribute('data-motion-state', 'closing');
    expect(onClose).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(159));
    expect(onClose).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
