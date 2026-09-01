import { describe, expect, test } from 'vitest';
import {
  fitsMessageTextPolicy,
  parseAttachments,
  parseConversationSnapshot,
  parseHistoryConversationPage,
  parseVoiceStatus,
} from '../src/domain/validation';

const RECEIPT = '<orquesta_foundation_receipt version="1" agent_id="orchestrator" status="accepted" />';

function projectionMessage(messageId: string, role: 'user' | 'agent', text: string) {
  return {
    messageId,
    threadId: 'thread-1',
    turnId: 'turn-1',
    targetAgentId: 'orchestrator',
    role,
    text,
    createdAt: `2026-08-28T00:00:0${messageId.length}.000Z`,
    journalSequence: messageId.length,
    origin: 'journal',
  };
}

describe('conversation display boundary', () => {
  test('removes only exact agent foundation receipts from current and streaming conversation', () => {
    const snapshot = parseConversationSnapshot({
      projectId: 'project-1',
      targetAgentId: 'orchestrator',
      streamId: 'stream-1',
      appliedJournalSequence: 5,
      projectionRevision: 5,
      syncState: 'current',
      items: [
        projectionMessage('agent-receipt', 'agent', RECEIPT),
        projectionMessage('user-literal', 'user', RECEIPT),
        projectionMessage('agent-normal', 'agent', '通常の返答です。'),
        projectionMessage('agent-near-match', 'agent', `${RECEIPT} 補足`),
      ],
      streamingItems: [{
        messageId: 'streaming-receipt',
        threadId: 'thread-2',
        turnId: 'turn-2',
        itemId: 'item-2',
        targetAgentId: 'orchestrator',
        role: 'agent',
        text: RECEIPT,
        createdAt: '2026-08-28T00:01:00.000Z',
        updatedAt: '2026-08-28T00:01:01.000Z',
        lastJournalSequence: 6,
      }],
      activities: [],
      activeTurns: [],
      latestTurn: null,
      olderCursor: null,
      activityOlderCursor: null,
      pendingRequestOlderCursor: null,
      pendingRequests: [],
      resolvedRequests: [],
    });

    expect(snapshot.items.map((message) => message.id)).toHaveLength(3);
    expect(snapshot.items.map((message) => message.id)).toEqual(expect.arrayContaining([
      'user-literal', 'agent-normal', 'agent-near-match',
    ]));
  });

  test('removes persisted foundation receipts from History without deleting ordinary messages', () => {
    const page = parseHistoryConversationPage({
      projectId: 'project-1',
      targetAgentId: 'orchestrator',
      query: null,
      items: [
        projectionMessage('agent-receipt', 'agent', `  ${RECEIPT}\n`),
        projectionMessage('user-literal', 'user', RECEIPT),
        projectionMessage('agent-normal', 'agent', '履歴に残す返答です。'),
      ],
      nextCursor: null,
    });

    expect(page.items.map((message) => message.id)).toEqual(['user-literal', 'agent-normal']);
  });

  test('drops legacy provider approval reasons but keeps explicit user-input questions', () => {
    const snapshot = parseConversationSnapshot({
      projectId: 'project-1',
      targetAgentId: 'orchestrator',
      streamId: 'stream-1',
      appliedJournalSequence: 5,
      projectionRevision: 5,
      syncState: 'current',
      items: [],
      streamingItems: [],
      activities: [],
      activeTurns: [],
      latestTurn: null,
      olderCursor: null,
      activityOlderCursor: null,
      pendingRequestOlderCursor: null,
      pendingRequests: [{
        requestKey: 'approval-1', agentId: 'orchestrator',
        requestKind: 'attention.approval_requested',
        responseOptions: ['accept', 'decline'], prompt: 'internal provider command and path',
        createdAt: '2026-08-28T00:00:00.000Z', requestedEffectKind: 'command_execution',
        responsePhase: null, recoveryState: 'stale',
      }, {
        requestKey: 'question-1', agentId: 'orchestrator',
        requestKind: 'attention.user_input_requested',
        responseOptions: ['continue'], prompt: 'どちらの案にしますか？',
        createdAt: '2026-08-28T00:00:00.000Z', requestedEffectKind: null,
        responsePhase: null, recoveryState: 'stale',
      }],
      resolvedRequests: [],
    });

    expect(snapshot.pendingRequests.map((request) => request.prompt)).toEqual([
      null,
      'どちらの案にしますか？',
    ]);
  });
});

function voiceAsset(
  assetId: string,
  kind: 'native_binary_bundle' | 'model',
  phase: 'absent' | 'installed',
) {
  return {
    assetId,
    kind,
    phase,
    downloadedBytes: phase === 'installed' ? 1 : 0,
    expectedBytes: 1,
    operationRef: null,
    lastErrorCode: null,
  };
}

function voiceStatusFixture() {
  return {
    schemaVersion: 2,
    revision: 1,
    providerId: 'whisper.cpp-local',
    binaryAssetId: 'binary',
    initialModelAssetId: 'initial',
    comparisonModelAssetId: 'comparison',
    requiredAssetsReady: true,
    assets: [
      voiceAsset('binary', 'native_binary_bundle', 'installed'),
      voiceAsset('initial', 'model', 'installed'),
      voiceAsset('comparison', 'model', 'absent'),
    ],
    operations: [],
  };
}

describe('voice status boundary', () => {
  test('preserves native asset kinds and allows an absent optional comparison model', () => {
    const status = parseVoiceStatus(voiceStatusFixture());
    expect(status.requiredAssetsReady).toBe(true);
    expect(status.assets.map((asset) => asset.kind)).toEqual(['native_binary_bundle', 'model', 'model']);
  });

  test('accepts a not-ready catalog when one required asset is absent', () => {
    const input = voiceStatusFixture();
    input.requiredAssetsReady = false;
    input.assets[1] = voiceAsset('initial', 'model', 'absent');
    expect(parseVoiceStatus(input).requiredAssetsReady).toBe(false);
  });

  test.each([
    ['duplicate roles', (input: ReturnType<typeof voiceStatusFixture>) => { input.comparisonModelAssetId = 'initial'; }],
    ['missing role asset', (input: ReturnType<typeof voiceStatusFixture>) => { input.assets.pop(); }],
    ['wrong role kind', (input: ReturnType<typeof voiceStatusFixture>) => { input.assets[0] = voiceAsset('binary', 'model', 'installed'); }],
    ['readiness mismatch', (input: ReturnType<typeof voiceStatusFixture>) => { input.requiredAssetsReady = false; }],
  ])('rejects %s', (_label, corrupt) => {
    const input = voiceStatusFixture();
    corrupt(input);
    expect(() => parseVoiceStatus(input)).toThrow();
  });

  test('uses the generated UTF-8 byte limit instead of a JavaScript character estimate', () => {
    expect(fitsMessageTextPolicy('a'.repeat(65_536))).toBe(true);
    expect(fitsMessageTextPolicy('あ'.repeat(21_846))).toBe(false);

    const accepted: any = voiceStatusFixture();
    accepted.operations = [{
      operationRef: 'voice-operation-1',
      composerBinding: { state: 'launcher', draftSha256: 'a'.repeat(64) },
      phase: 'transcribed',
      durationMs: 1_000,
      transcript: 'あ'.repeat(21_845),
      lastErrorCode: null,
    }];
    expect(parseVoiceStatus(accepted).operations[0].transcript).toHaveLength(21_845);

    const oversized = structuredClone(accepted);
    oversized.operations[0].transcript = 'あ'.repeat(21_846);
    expect(() => parseVoiceStatus(oversized)).toThrow('Native voice operation status is invalid.');
  });
});

describe('attachment content policy boundary', () => {
  const selectionId = 'selection-1';
  const response = (overrides: Record<string, unknown> = {}) => ({
    selectionId,
    attachments: [{
      publicId: 'attachment-1',
      displayName: 'source.tsx',
      kind: 'text',
      mediaType: 'text/typescript',
      sizeBytes: 1,
      ...overrides,
    }],
  });

  test('requires extension, kind, media type, and size to agree with the generated policy', () => {
    expect(parseAttachments(response(), selectionId)[0].mediaType).toBe('text/typescript');
    expect(() => parseAttachments(response({ mediaType: 'text/plain' }), selectionId)).toThrow();
    expect(() => parseAttachments(response({ kind: 'image', mediaType: 'image/png' }), selectionId)).toThrow();
    expect(() => parseAttachments(response({ sizeBytes: 524_289 }), selectionId)).toThrow();
  });
});
