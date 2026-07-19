import type { RuntimeUiEvent } from '../../../contracts/orquesta-ui';

const DEDUPE_WINDOW_MS = 5_000;
const MAX_VISIBLE_TOASTS = 3;

function eventTime(event: RuntimeUiEvent): number {
  const parsed = Date.parse(event.createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function eventKey(event: RuntimeUiEvent): string {
  return `${event.tone}|${event.title}|${event.message}|${event.taskId ?? ''}`;
}

export function visibleToastQueue(items: RuntimeUiEvent[]): { visible: RuntimeUiEvent[]; hiddenCount: number; suppressedIds: string[] } {
  const sorted = items.map((item, index) => ({ item, index })).sort((left, right) => eventTime(right.item) - eventTime(left.item) || right.index - left.index);
  const newestKeptAt = new Map<string, number>();
  const suppressedIds: string[] = [];
  const unique = sorted.flatMap(({ item }) => {
    const key = eventKey(item);
    const time = eventTime(item);
    const previous = newestKeptAt.get(key);
    if (previous !== undefined && previous - time <= DEDUPE_WINDOW_MS) {
      suppressedIds.push(item.id);
      return [];
    }
    newestKeptAt.set(key, time);
    return [item];
  });

  return {
    visible: unique.slice(0, MAX_VISIBLE_TOASTS),
    hiddenCount: Math.max(0, unique.length - MAX_VISIBLE_TOASTS),
    suppressedIds
  };
}
