export function compareExactText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function compareConversationEntryOrder(
  left: { createdAt: string; id: string },
  right: { createdAt: string; id: string },
): number {
  return compareExactText(left.createdAt, right.createdAt)
    || compareExactText(left.id, right.id);
}

export function compareConversationActivityOrder(
  left: { createdAt: string; lastJournalSequence: number; id: string },
  right: { createdAt: string; lastJournalSequence: number; id: string },
): number {
  return compareExactText(left.createdAt, right.createdAt)
    || left.lastJournalSequence - right.lastJournalSequence
    || compareExactText(left.id, right.id);
}
