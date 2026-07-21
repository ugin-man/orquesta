import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import { setupRunningFixture } from '../../src/fixtures/setup-running';
import { InitialSetupExperience } from '../../src/renderer/features/setup/InitialSetupExperience';

const setup = setupRunningFixture.snapshot.setup!;

describe('InitialSetupExperience', () => {
  test('shows current work, the six real phases, and the next operation', () => {
    const { container } = render(<InitialSetupExperience setup={setup} />);

    expect(screen.getByRole('main', { name: 'Orquesta 初回セットアップ' })).toBeVisible();
    expect(screen.getByRole('heading', { name: setup.currentActivity?.title })).toBeVisible();
    expect(screen.getByText(setup.currentActivity!.detail)).toBeVisible();
    expect(screen.getByText(setup.recentActivities[0]!.title)).toBeVisible();
    expect(screen.getByText(setup.nextActivity!.title)).toBeVisible();

    const phases = screen.getByRole('navigation', { name: 'セットアップ段階' });
    expect(within(phases).getAllByRole('listitem')).toHaveLength(6);
    expect(within(phases).getByText('03')).toBeVisible();
    expect(within(phases).getByText('基盤構築')).toBeVisible();
    expect(container.querySelectorAll('[data-setup-gear]')).toHaveLength(6);
    expect(container.querySelector('[data-setup-gear][data-state="active"]')).not.toBeNull();

    const progress = screen.getByRole('progressbar', { name: 'セットアップ進行状況' });
    expect(progress).toHaveAttribute('aria-valuemin', '1');
    expect(progress).toHaveAttribute('aria-valuemax', '6');
    expect(progress).toHaveAttribute('aria-valuenow', '3');
  });

  test('discloses technical detail only when requested', async () => {
    const user = userEvent.setup();
    render(<InitialSetupExperience setup={setup} />);

    expect(screen.queryByText('.orquesta/setup/session.json')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '技術的な詳細を表示' }));
    expect(screen.getByText('.orquesta/setup/session.json')).toBeVisible();
    expect(screen.getByRole('button', { name: '技術的な詳細を閉じる' })).toBeVisible();
  });

  test('requires confirmation before cancelling setup', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<InitialSetupExperience setup={setup} onCancel={onCancel} />);

    await user.click(screen.getByRole('button', { name: 'セットアップを中止' }));
    const dialog = screen.getByRole('dialog', { name: 'セットアップを中止しますか' });
    expect(dialog).toBeVisible();
    expect(onCancel).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: '中止せず戻る' }));
    expect(screen.queryByRole('dialog', { name: 'セットアップを中止しますか' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'セットアップを中止' }));
    await user.click(screen.getByRole('button', { name: 'セットアップを中止する' }));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
