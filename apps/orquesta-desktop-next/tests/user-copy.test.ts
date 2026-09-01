import { describe, expect, test } from 'vitest';
import {
  agentStatusCopy,
  attentionActionCopy,
  attentionPresentationCopy,
  attentionTypeCopy,
  conversationActivityKindCopy,
  evidenceTypeCopy,
  fileChangeKindCopy,
  planStepStatusCopy,
  uiStateCopy,
  userMessageCopy,
  workflowAttemptStatusCopy,
  workflowBatchStatusCopy,
  workflowCheckOutcomeCopy,
} from '../src/presentation/user-copy';
import { userMessage } from '../src/application/user-message';
import type { AttentionItem } from '../src/domain/models';

describe('user-facing copy boundary', () => {
  test('translates known internal states instead of rendering raw enum values', () => {
    expect(agentStatusCopy('assigned_waiting', 'ja')).toBe('開始待ち');
    expect(agentStatusCopy('assigned_waiting', 'en')).toBe('Waiting to start');
    expect(conversationActivityKindCopy('file_change', 'ja')).toBe('ファイル変更');
    expect(planStepStatusCopy('inProgress', 'en')).toBe('In progress');
    expect(workflowBatchStatusCopy('cancelling', 'ja')).toBe('停止中');
    expect(workflowAttemptStatusCopy('starting', 'en')).toBe('Starting');
    expect(workflowCheckOutcomeCopy('unassessed', 'ja')).toBe('未評価');
    expect(attentionTypeCopy('report_review', 'en')).toBe('Report review');
    expect(attentionActionCopy('approve', 'ja')).toBe('内容を確認');
    expect(attentionActionCopy('do', 'en')).toBe('Open');
  });

  test('uses controlled fallback copy for open-ended native values', () => {
    expect(uiStateCopy('unknown_native_enum', 'ja')).toBe('状態不明');
    expect(uiStateCopy('unknown_native_enum', 'en')).toBe('Unknown state');
    expect(fileChangeKindCopy('provider_specific_change', 'ja')).toBe('ファイル変更');
    expect(evidenceTypeCopy('provider_specific_evidence', 'en')).toBe('Work record');
  });

  test('renders semantic application messages only at the locale-aware surface', () => {
    expect(userMessageCopy(userMessage('dispatch_state_unknown'), 'ja')).toContain('送信状態');
    expect(userMessageCopy(userMessage('dispatch_state_unknown'), 'en')).toContain('send state');
    expect(userMessageCopy(userMessage('attachment_batch_rejected'), 'ja')).toContain('追加していません');
    expect(userMessageCopy(userMessage('attachment_batch_rejected'), 'en')).toContain('none were attached');
    expect(userMessageCopy(userMessage('project_metadata_directory_selected'), 'ja')).toContain('一つ上');
    expect(userMessageCopy(userMessage('project_recent_forget_active'), 'en')).toContain('Stop it first');
  });

  test('creates runtime approval presentation copy only at the Desktop locale boundary', () => {
    const item: AttentionItem = {
      id: 'runtime-approval:req-1', sourceKind: 'runtime_approval', type: 'approval', actionKind: 'approve', priority: 'blocker',
      title: null, summary: null, sourceAgentId: 'orchestrator', taskId: null, blocking: true,
      createdAt: '2026-08-28T00:00:00.000Z', resolvedAt: null, resolutionDecision: null,
      runtimeApproval: {
        requestedEffectKind: 'file_change', responseOptions: ['accept', 'decline'],
      },
    };
    expect(attentionPresentationCopy(item, 'ja')).toEqual({
      title: 'ファイル変更の確認',
      summary: 'このプロジェクトのファイルを変更してよいか確認してください。',
    });
    expect(attentionPresentationCopy(item, 'en').title).toBe('Review file changes');
  });
});
