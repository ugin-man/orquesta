import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { HomeTutorialOverlay } from '../../src/renderer/features/tutorial/HomeTutorialOverlay';
import { measureTutorialTargets, tutorialTargetProps } from '../../src/renderer/features/tutorial/home-tutorial-targets';

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({})
  } as DOMRect;
}

describe('HomeTutorialOverlay', () => {
  afterEach(() => {
    document.querySelectorAll('[data-orquesta-tutorial-target]').forEach((element) => element.remove());
    vi.restoreAllMocks();
  });

  test('measures only visible registered targets', () => {
    const visible = document.createElement('div');
    Object.assign(visible, tutorialTargetProps('project-status'));
    visible.setAttribute('data-orquesta-tutorial-target', 'project-status');
    vi.spyOn(visible, 'getBoundingClientRect').mockReturnValue(rect(20, 30, 100, 60));
    document.body.append(visible);

    expect(measureTutorialTargets(document, ['missing', 'project-status'])).toEqual([
      { id: 'project-status', left: 20, top: 30, width: 100, height: 60 }
    ]);
  });

  test('renders one mask hole for each present target and Japanese controls', async () => {
    document.body.innerHTML = [
      '<div data-orquesta-tutorial-target="project-launcher"></div>',
      '<div data-orquesta-tutorial-target="project-status"></div>'
    ].join('');
    for (const element of document.querySelectorAll('div')) {
      vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(rect(20, 20, 100, 60));
    }

    render(<HomeTutorialOverlay stepIndex={5} locale="ja" reducedMotion={false} onBack={vi.fn()} onNext={vi.fn()} onSkip={vi.fn()} />);

    expect(await screen.findByRole('dialog', { name: 'Project操作と状態' })).toBeVisible();
    expect(screen.getAllByTestId('tutorial-hole')).toHaveLength(2);
    expect(screen.getByText('6 / 7')).toBeVisible();
    expect(screen.getByRole('button', { name: '戻る' })).toBeVisible();
    expect(screen.getByRole('button', { name: '次へ' })).toBeVisible();
  });

  test('uses English copy and labels the final action Complete', async () => {
    const target = document.createElement('button');
    target.setAttribute('data-orquesta-tutorial-target', 'luca');
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(rect(100, 100, 80, 40));
    document.body.append(target);

    render(<HomeTutorialOverlay stepIndex={6} locale="en" reducedMotion onBack={vi.fn()} onNext={vi.fn()} onSkip={vi.fn()} />);

    expect(await screen.findByRole('dialog', { name: 'Ask Luca' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Complete' })).toBeVisible();
  });

  test('constrains a long card inside the viewport beside a bottom target', async () => {
    const target = document.createElement('nav');
    target.setAttribute('data-orquesta-tutorial-target', 'dock');
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(rect(30, 650, 300, 40));
    document.body.append(target);

    render(<HomeTutorialOverlay stepIndex={4} locale="en" reducedMotion onBack={vi.fn()} onNext={vi.fn()} onSkip={vi.fn()} />);

    const dialog = await screen.findByRole('dialog', { name: 'Switch workspaces' });
    expect(dialog.style.maxHeight).not.toBe('');
    expect(Number.parseFloat(dialog.style.top) + Number.parseFloat(dialog.style.maxHeight)).toBeLessThanOrEqual(window.innerHeight - 28);
  });

  test('handles arrows, Escape, and keeps Tab focus inside the card', async () => {
    const target = document.createElement('div');
    target.setAttribute('data-orquesta-tutorial-target', 'composer');
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(rect(200, 500, 600, 120));
    document.body.append(target);
    const onBack = vi.fn();
    const onNext = vi.fn();
    const onSkip = vi.fn();
    const user = userEvent.setup();

    render(<HomeTutorialOverlay stepIndex={1} locale="en" reducedMotion onBack={onBack} onNext={onNext} onSkip={onSkip} />);
    const skip = await screen.findByRole('button', { name: 'Skip' });
    const next = screen.getByRole('button', { name: 'Next' });

    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(onBack).toHaveBeenCalledOnce();
    expect(onNext).toHaveBeenCalledOnce();

    next.focus();
    await user.tab();
    expect(document.activeElement).toBe(skip);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Back' }));

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onSkip).toHaveBeenCalledOnce();
  });

  test('advances once when every target for a page is missing', async () => {
    const onNext = vi.fn();
    render(<HomeTutorialOverlay stepIndex={0} locale="en" reducedMotion onBack={vi.fn()} onNext={onNext} onSkip={vi.fn()} />);

    await vi.waitFor(() => expect(onNext).toHaveBeenCalledOnce());
  });
});
