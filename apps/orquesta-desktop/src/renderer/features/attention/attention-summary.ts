import type { AttentionUiItem, UserActionKind } from '../../../contracts/orquesta-ui';

export type AttentionSummary = Record<UserActionKind, number> & { total: number };

export function summarizeAttention(items: AttentionUiItem[]): AttentionSummary {
  return items.reduce<AttentionSummary>((summary, item) => {
    summary.total += 1;
    summary[item.actionKind] += 1;
    return summary;
  }, { total: 0, answer: 0, approve: 0, review: 0, do: 0 });
}
