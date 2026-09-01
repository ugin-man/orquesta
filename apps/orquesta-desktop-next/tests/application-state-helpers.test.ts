import { describe, expect, test } from 'vitest';
import { mergeConversationActivities } from '../src/application/reducers/activity-reducer';
import { openAttentionItems } from '../src/application/reducers/attention-reducer';
import { mergeConversationMessages } from '../src/application/reducers/conversation-reducer';
import type { ConversationActivity, ConversationMessage } from '../src/domain/models';

describe('application state helper contracts', () => {
  test('uses one exact total order for canonically equivalent Unicode identities', () => {
    const composed = 'é';
    const decomposed = 'e\u0301';
    const messages = [composed, decomposed].map((id) => ({
      id,
      createdAt: '2026-08-24T00:00:00.000Z',
    })) as ConversationMessage[];
    const activities = [composed, decomposed].map((id) => ({
      id,
      createdAt: '2026-08-24T00:00:00.000Z',
      lastJournalSequence: 1,
    })) as ConversationActivity[];

    expect(mergeConversationMessages([], messages).map(({ id }) => id)).toEqual(
      mergeConversationMessages([], [...messages].reverse()).map(({ id }) => id),
    );
    expect(mergeConversationActivities([], activities).map(({ id }) => id)).toEqual(
      mergeConversationActivities([], [...activities].reverse()).map(({ id }) => id),
    );
  });

  test('keeps a Native-classified stale legacy approval out of the actionable decision queue', () => {
    const items = openAttentionItems([], [{
      requestKey: 'legacy-approval-1',
      agentId: 'orchestrator',
      requestKind: 'attention.approval_requested' as const,
      responseOptions: [],
      prompt: null,
      createdAt: '2026-08-24T00:00:00.000Z',
      requestedEffectKind: null,
      responsePhase: null,
      recoveryState: 'stale',
    }]);

    expect(items).toEqual([]);
  });
});
