import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { RuntimeUiEvent } from '../../src/contracts/orquesta-ui';
import { I18nProvider } from '../../src/renderer/features/i18n/I18nProvider';
import { ToastStack } from '../../src/renderer/features/toast/ToastStack';
import { visibleToastQueue } from '../../src/renderer/features/toast/toast-queue';

function toast(input: Partial<RuntimeUiEvent> & Pick<RuntimeUiEvent, 'id' | 'title' | 'message'>): RuntimeUiEvent {
  return { tone: 'neutral', taskId: null, createdAt: '2026-07-19T00:00:00.000Z', ...input };
}

describe('visibleToastQueue', () => {
  test('deduplicates repeated events within five seconds and summarizes overflow above three', () => {
    const result = visibleToastQueue([
      toast({ id: '1', title: 'Done', message: 'T1', createdAt: '2026-07-19T00:00:00.000Z' }),
      toast({ id: '2', title: 'Done', message: 'T1', createdAt: '2026-07-19T00:00:03.000Z' }),
      toast({ id: '3', title: 'Failed', message: 'T2', createdAt: '2026-07-19T00:00:04.000Z' }),
      toast({ id: '4', title: 'Question', message: 'Q1', createdAt: '2026-07-19T00:00:05.000Z' }),
      toast({ id: '5', title: 'Reply', message: 'C1', createdAt: '2026-07-19T00:00:06.000Z' })
    ]);

    expect(result.visible.map((item) => item.id)).toEqual(['5', '4', '3']);
    expect(result.hiddenCount).toBe(1);
    expect(result.suppressedIds).toEqual(['1']);
  });

  test('keeps the same event when it recurs outside the dedupe window', () => {
    const result = visibleToastQueue([
      toast({ id: 'old', title: 'Done', message: 'T1', createdAt: '2026-07-19T00:00:00.000Z' }),
      toast({ id: 'new', title: 'Done', message: 'T1', createdAt: '2026-07-19T00:00:06.000Z' })
    ]);

    expect(result.visible.map((item) => item.id)).toEqual(['new', 'old']);
    expect(result.hiddenCount).toBe(0);
  });

  test('localizes the hidden notification count in the active language', () => {
    const toasts = Array.from({ length: 5 }, (_, index) => toast({
      id: String(index),
      title: `Event ${index}`,
      message: `Message ${index}`,
      createdAt: `2026-07-19T00:00:0${index}.000Z`
    }));

    render(
      <I18nProvider initialLocale="en">
        <ToastStack toasts={toasts} onDismiss={vi.fn()} />
      </I18nProvider>
    );

    expect(screen.getByText('2 more notifications')).toBeVisible();
    expect(screen.queryByText('ほか2件')).not.toBeInTheDocument();
  });
});
