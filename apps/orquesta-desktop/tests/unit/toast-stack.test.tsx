import { describe, expect, test } from 'vitest';
import type { RuntimeUiEvent } from '../../src/contracts/orquesta-ui';
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
});
