import type { ConversationMessage } from '../../domain/models';
import { compareConversationEntryOrder } from '../../domain/exact-order';

export function mergeConversationMessages(
  earlier: readonly ConversationMessage[],
  later: readonly ConversationMessage[],
): ConversationMessage[] {
  const messages = new Map<string, ConversationMessage>();
  for (const message of earlier) messages.set(message.id, message);
  for (const message of later) messages.set(message.id, message);
  return [...messages.values()].sort(compareConversationEntryOrder);
}
