import type { ApplicationState } from '../application/state';
import { userMessageCopy } from './user-copy';

export type UserSignalKind = 'final_reply' | 'question' | 'approval' | 'failure';

export interface UserSignal {
  key: string;
  streamKey: string;
  cursor: string | null;
  kind: UserSignalKind;
  targetAgentId: string | null;
  announcement: string;
  notificationTitle: string;
  notificationBody: string;
}

interface StreamWatermark {
  cursor: string | null;
  cursorlessIdentity: string | null;
}

const MAX_SEEN_SIGNAL_IDENTITIES = 512;

export class UserSignalTracker {
  readonly #seen = new Map<string, true>();
  readonly #streams = new Map<string, StreamWatermark>();
  #baselineEstablished = false;

  reset(): void {
    this.#seen.clear();
    this.#streams.clear();
    this.#baselineEstablished = false;
  }

  observe(signals: UserSignal[], expectedStreams: string[]): UserSignal[] {
    const establishingBaseline = !this.#baselineEstablished;
    const expected = new Set(expectedStreams);
    for (const streamKey of this.#streams.keys()) {
      if (!expected.has(streamKey)) this.#streams.delete(streamKey);
    }
    for (const streamKey of expectedStreams) {
      if (this.#streams.has(streamKey)) continue;
      if (establishingBaseline) this.#initializeStream(streamKey, signals);
      else this.#streams.set(streamKey, { cursor: null, cursorlessIdentity: null });
    }
    this.#baselineEstablished = true;
    const fresh: UserSignal[] = [];
    for (const signal of [...signals].sort((left, right) => (
      (left.cursor ?? left.key).localeCompare(right.cursor ?? right.key)
    ))) {
      if (!expected.has(signal.streamKey)) continue;
      if (this.#seen.has(signal.key)) continue;
      const stream = this.#streams.get(signal.streamKey);
      if (!stream) continue;
      this.#remember(signal.key);
      if (signal.cursor && stream.cursor && signal.cursor <= stream.cursor) continue;
      if (signal.cursor) stream.cursor = signal.cursor;
      else {
        if (stream.cursorlessIdentity === signal.key) continue;
        stream.cursorlessIdentity = signal.key;
      }
      fresh.push(signal);
    }
    return fresh;
  }

  #initializeStream(streamKey: string, signals: UserSignal[]): void {
    if (this.#streams.has(streamKey)) return;
    let highWatermark: string | null = null;
    let cursorlessIdentity: string | null = null;
    for (const signal of signals) {
      if (signal.streamKey !== streamKey) continue;
      this.#remember(signal.key);
      if (signal.cursor && (!highWatermark || signal.cursor > highWatermark)) highWatermark = signal.cursor;
      if (!signal.cursor) cursorlessIdentity = signal.key;
    }
    this.#streams.set(streamKey, { cursor: highWatermark, cursorlessIdentity });
  }

  #remember(key: string): void {
    this.#seen.delete(key);
    this.#seen.set(key, true);
    while (this.#seen.size > MAX_SEEN_SIGNAL_IDENTITIES) {
      const oldest = this.#seen.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#seen.delete(oldest);
    }
  }
}

export function expectedUserSignalStreams(state: ApplicationState): string[] {
  const streams = new Set(['application']);
  const projectId = state.snapshot?.project.id ?? state.selectedProjectId;
  if (!projectId) return [...streams];
  streams.add(`project:${projectId}`);
  for (const agent of state.snapshot?.agents ?? []) {
    streams.add(`conversation:${projectId}:${agent.id}`);
  }
  for (const conversation of state.historyConversations) {
    streams.add(`conversation:${projectId}:${conversation.targetAgentId}`);
  }
  if (state.selectedAgentId) streams.add(`conversation:${projectId}:${state.selectedAgentId}`);
  return [...streams];
}

function boundedLabel(value: string | null | undefined, fallback: string): string {
  const normalized = value?.replace(/\s+/gu, ' ').trim();
  return (normalized || fallback).slice(0, 80);
}

function projectContext(state: ApplicationState): { id: string } {
  return { id: state.snapshot?.project.id ?? state.selectedProjectId ?? 'none' };
}

function agentLabel(state: ApplicationState, agentId: string | null): string {
  return boundedLabel(
    state.snapshot?.agents.find((agent) => agent.id === agentId)?.displayName,
    'Agent',
  );
}

function cursor(timestamp: string, key: string): string {
  return `${timestamp}:${key}`;
}

export function collectUserSignals(state: ApplicationState, locale: 'ja' | 'en'): UserSignal[] {
  const project = projectContext(state);
  const projectStream = `project:${project.id}`;
  const signals: UserSignal[] = [];

  for (const message of state.messages) {
    if (message.role !== 'agent' || message.status === 'running') continue;
    const key = `message:${project.id}:${message.targetAgentId}:${message.id}`;
    const agent = agentLabel(state, message.targetAgentId);
    signals.push({
      key,
      streamKey: `conversation:${project.id}:${message.targetAgentId}`,
      cursor: cursor(message.createdAt, key),
      kind: 'final_reply',
      targetAgentId: message.targetAgentId,
      announcement: `${message.authorLabel}: ${message.text.slice(0, 240)}`,
      notificationTitle: locale === 'ja' ? '新しい返信' : 'New reply',
      notificationBody: locale === 'ja'
        ? 'Orquestaに新しい返信があります。'
        : 'A new reply is ready in Orquesta.',
    });
  }

  for (const conversation of state.historyConversations) {
    if (conversation.lastRole !== 'agent') continue;
    const key = `message:${project.id}:${conversation.targetAgentId}:${conversation.lastMessageId}`;
    const agent = agentLabel(state, conversation.targetAgentId);
    signals.push({
      key,
      streamKey: `conversation:${project.id}:${conversation.targetAgentId}`,
      cursor: cursor(conversation.updatedAt, key),
      kind: 'final_reply',
      targetAgentId: conversation.targetAgentId,
      announcement: locale === 'ja' ? `${agent}から新しい返信があります。` : `${agent} has a new reply.`,
      notificationTitle: locale === 'ja' ? '新しい返信' : 'New reply',
      notificationBody: locale === 'ja'
        ? 'Orquestaに新しい返信があります。'
        : 'A new reply is ready in Orquesta.',
    });
  }

  for (const request of state.projectedPendingRequests) {
    const isQuestion = request.requestKind === 'attention.user_input_requested';
    const key = `request:${project.id}:${request.requestKey}`;
    const agent = agentLabel(state, request.agentId);
    signals.push({
      key,
      streamKey: projectStream,
      cursor: cursor(request.createdAt, key),
      kind: isQuestion ? 'question' : 'approval',
      targetAgentId: request.agentId,
      announcement: isQuestion
        ? (locale === 'ja' ? 'エージェントから質問があります。' : 'An agent has a question.')
        : (locale === 'ja' ? '確認が必要な操作があります。' : 'An action needs your review.'),
      notificationTitle: isQuestion
        ? (locale === 'ja' ? '質問があります' : 'Question waiting')
        : (locale === 'ja' ? '確認が必要です' : 'Review needed'),
      notificationBody: isQuestion
        ? (locale === 'ja' ? 'Orquestaで回答を待っている質問があります。' : 'A question is waiting for an answer in Orquesta.')
        : (locale === 'ja' ? 'Orquestaに確認待ちの操作があります。' : 'An action is waiting for review in Orquesta.'),
    });
  }

  for (const execution of Object.values(state.executions)) {
    if (execution.phase !== 'failed') continue;
    const key = `failure:${project.id}:${execution.executionId}`;
    const agent = agentLabel(state, execution.targetAgentId);
    signals.push({
      key,
      streamKey: projectStream,
      cursor: cursor(execution.updatedAt, key),
      kind: 'failure',
      targetAgentId: execution.targetAgentId,
      announcement: locale === 'ja' ? `${agent}の作業が失敗しました。` : `${agent}'s work failed.`,
      notificationTitle: locale === 'ja' ? '作業を確認してください' : 'Work needs attention',
      notificationBody: locale === 'ja'
        ? 'Orquestaで完了できなかった処理があります。'
        : 'An operation could not be completed in Orquesta.',
    });
  }

  if (state.error) {
    const key = `error:${state.error.id}:${'remaining' in state.error ? state.error.remaining : ''}`;
    signals.push({
      key,
      streamKey: 'application',
      cursor: null,
      kind: 'failure',
      targetAgentId: state.selectedAgentId,
      announcement: userMessageCopy(state.error, locale),
      notificationTitle: locale === 'ja' ? 'Orquestaを確認してください' : 'Check Orquesta',
      notificationBody: locale === 'ja'
        ? 'Orquestaで完了できなかった処理があります。'
        : 'An operation could not be completed in Orquesta.',
    });
  }

  return signals;
}
