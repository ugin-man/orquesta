import type { AttentionUiItem, UserActionKind } from '../../../contracts/orquesta-ui';

export type AttentionSummary = Record<UserActionKind, number> & { total: number };

const priorityRank: Record<AttentionUiItem['priority'], number> = { blocker: 0, high: 1, medium: 2, low: 3 };

export function summarizeAttention(items: AttentionUiItem[]): AttentionSummary {
  return items.reduce<AttentionSummary>((summary, item) => {
    summary.total += 1;
    summary[item.actionKind] += 1;
    return summary;
  }, { total: 0, answer: 0, approve: 0, review: 0, do: 0 });
}

export function sortAttentionItems(items: AttentionUiItem[]): AttentionUiItem[] {
  return [...items].sort((a, b) => Number(b.blocking) - Number(a.blocking)
    || priorityRank[a.priority] - priorityRank[b.priority]
    || Date.parse(b.createdAt) - Date.parse(a.createdAt));
}
