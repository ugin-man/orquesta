import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import { setupRunningFixture } from '../../src/fixtures/setup-running';
import { InitialSetupExperience } from '../../src/renderer/features/setup/InitialSetupExperience';

const setup = setupRunningFixture.snapshot.setup!;

describe('InitialSetupExperience', () => {
  test('uses English for every Orquesta-owned setup label in English mode', async () => {
    const user = userEvent.setup();
    const { container } = render(<InitialSetupExperience setup={{ ...setup, projectRootLabel: 'C:\\Projects\\Orquesta' }} locale="en" />);

    expect(screen.getByRole('main', { name: 'Orquesta initial setup' })).toBeVisible();
    expect(screen.getByRole('navigation', { name: 'Setup phases' })).toBeVisible();
    expect(screen.getByRole('progressbar', { name: 'Setup progress' })).toBeVisible();
    expect(screen.getByText('Foundation')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Show technical details' }));
    await user.click(screen.getByRole('button', { name: 'Stop setup' }));
    expect(screen.getByRole('dialog', { name: 'Stop initial setup?' })).toBeVisible();
    expect(container.textContent).not.toMatch(/[\u3040-\u30ff\u3400-\u9fff]/u);
  });

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
    expect(container.querySelectorAll('[data-setup-phase]')).toHaveLength(6);
    expect(container.querySelector('[data-setup-phase][data-state="active"]')).not.toBeNull();
    expect(screen.getByRole('region', { name: 'パイプオルガン構築状況' })).toBeVisible();
    expect(screen.queryByRole('button', { name: /Auto|Blocked|Complete|Phase/u })).not.toBeInTheDocument();
    expect(screen.getAllByTestId('setup-log-entry').length).toBeLessThanOrEqual(6);

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
