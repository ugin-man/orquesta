import type {
  AgentExecution,
  ConversationActiveTurn,
  ConversationActivity,
} from '../../domain/models';
import { compareConversationActivityOrder } from '../../domain/exact-order';

export function mergeConversationActivities(
  earlier: readonly ConversationActivity[],
  later: readonly ConversationActivity[],
): ConversationActivity[] {
  const activities = new Map<string, ConversationActivity>();
  for (const activity of earlier) activities.set(activity.id, activity);
  for (const activity of later) activities.set(activity.id, activity);
  return [...activities.values()].sort(compareConversationActivityOrder);
}

export function latestActiveTurn(
  turns: readonly ConversationActiveTurn[],
): ConversationActiveTurn | null {
  return turns.reduce<ConversationActiveTurn | null>((latest, turn) => (
    !latest || turn.lastJournalSequence > latest.lastJournalSequence ? turn : latest
  ), null);
}

export function executionFromProjection(
  projectId: string,
  targetAgentId: string,
  activeTurn: ConversationActiveTurn | null,
  latestTurn: { threadId: string; turnId: string; state: string; lastJournalSequence: number } | null,
  previous: AgentExecution | null,
  observedAt: string,
): AgentExecution | null {
  if (activeTurn) {
    const phase = activeTurn.state === 'accepted' ? 'accepted'
      : activeTurn.state === 'interrupting' ? 'stopping' : 'working';
    return {
      executionId: `turn:${activeTurn.threadId}:${activeTurn.turnId}`,
      projectId,
      targetAgentId,
      phase,
      source: 'projection',
      summary: previous?.summary ?? 'Codex turn',
      updatedAt: observedAt,
      dispatchId: previous?.dispatchId ?? null,
      threadId: activeTurn.threadId,
      turnId: activeTurn.turnId,
      lastJournalSequence: activeTurn.lastJournalSequence,
      canInterrupt: phase !== 'stopping',
    };
  }
  const matchesPrevious = latestTurn && previous
    && previous.threadId === latestTurn.threadId
    && previous.turnId === latestTurn.turnId;
  const completesCurrentOptimisticDispatch = latestTurn && previous
    && previous.source === 'optimistic'
    && previous.phase === 'queueing'
    && previous.threadId === null
    && previous.turnId === null
    && previous.lastJournalSequence !== null
    && latestTurn.lastJournalSequence > previous.lastJournalSequence;
  if (!latestTurn || (!matchesPrevious && !completesCurrentOptimisticDispatch)
    || !['completed', 'failed', 'interrupted', 'cancelled'].includes(latestTurn.state)) return previous;
  const phase = latestTurn.state === 'failed' ? 'failed'
    : ['interrupted', 'cancelled'].includes(latestTurn.state) ? 'interrupted' : 'completed';
  return {
    ...previous,
    executionId: `turn:${latestTurn.threadId}:${latestTurn.turnId}`,
    threadId: latestTurn.threadId,
    turnId: latestTurn.turnId,
    phase,
    source: 'projection',
    updatedAt: observedAt,
    lastJournalSequence: latestTurn.lastJournalSequence,
    canInterrupt: false,
  };
}
