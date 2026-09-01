import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import type { RuntimeApprovalRequest, RuntimeNotification } from './protocol';
import { WorkflowRunController, type WorkflowRuntime } from './workflow-run-controller';
import { readWorkflowState, summarizeWorkflowBatch } from './workflow-store';

const roots: string[] = [];

async function projectRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'orquesta-workflow-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function runtimeDouble(): WorkflowRuntime {
  let sequence = 0;
  return {
    startWorkflowRun: vi.fn(async () => {
      sequence += 1;
      return {
        threadId: `thread-${sequence}`,
        turnId: `turn-${sequence}`,
        runtimeBoundary: { sandbox: 'read-only', approvalPolicy: 'never', webSearchMode: 'disabled' }
      };
    }),
    interruptInspection: vi.fn(async () => undefined),
    readInspectionThread: vi.fn(async () => ({ finalResponse: null, status: 'in_progress' as const })),
    respondToApproval: vi.fn(async ({ requestId, decision }) => ({ requestId, decision }))
  };
}

function notification(kind: RuntimeNotification['kind'], threadId: string, text: string | null = null): RuntimeNotification {
  return {
    kind,
    threadId,
    turnId: threadId.replace('thread', 'turn'),
    text,
    targetAgentId: null,
    modelEvidence: {
      recommendedModel: null,
      requestedModel: null,
      appliedModel: null,
      actualModel: null,
      actualModelEvidence: 'unknown'
    }
  };
}

function ids() {
  let workflow = 0;
  let batch = 0;
  return (kind: 'workflow' | 'batch') => kind === 'workflow' ? `workflow-${++workflow}` : `batch-${++batch}`;
}

describe('WorkflowRunController', () => {
  test('keeps both definitions when users save concurrently', async () => {
    const rootPath = await projectRoot();
    const controller = new WorkflowRunController({ runtime: runtimeDouble(), createId: ids() });
    await Promise.all([
      controller.saveDefinition({ rootPath, workflowId: null, name: 'A', prompt: 'Aを確認', checks: [] }),
      controller.saveDefinition({ rootPath, workflowId: null, name: 'B', prompt: 'Bを確認', checks: [] })
    ]);
    expect((await readWorkflowState(rootPath)).definitions.map((item) => item.name).sort()).toEqual(['A', 'B']);
  });

  test('runs independent temporary threads sequentially and reports transparent reliability metrics', async () => {
    const rootPath = await projectRoot();
    const runtime = runtimeDouble();
    const controller = new WorkflowRunController({ runtime, createId: ids() });
    const definition = await controller.saveDefinition({
      rootPath,
      workflowId: null,
      name: '構造確認',
      prompt: '現在の構造を確認して短く説明する',
      checks: [
        { kind: 'contains', text: '確認済み', caseSensitive: false },
        { kind: 'not_contains', text: '致命的', caseSensitive: false }
      ]
    });

    const { batchId } = await controller.startBatch({ projectId: 'repo-1', rootPath, workflowId: definition.workflowId, repetitions: 2 });
    expect(runtime.startWorkflowRun).toHaveBeenCalledTimes(1);
    await controller.handleRuntimeNotification(notification('agent_message', 'thread-1', '確認済み。問題なし。'));
    await controller.handleRuntimeNotification(notification('turn_completed', 'thread-1'));
    expect(runtime.startWorkflowRun).toHaveBeenCalledTimes(2);
    await controller.handleRuntimeNotification(notification('agent_message', 'thread-2', '確認済み。問題なし。'));
    await controller.handleRuntimeNotification(notification('turn_completed', 'thread-2'));

    const batch = (await readWorkflowState(rootPath)).batches.find((item) => item.batchId === batchId)!;
    expect(batch.status).toBe('completed');
    expect(batch.attempts.map((attempt) => attempt.checkOutcome)).toEqual(['passed', 'passed']);
    expect(summarizeWorkflowBatch(batch)).toMatchObject({
      requestedRuns: 2,
      terminalRuns: 2,
      executionReliabilityPercent: 100,
      successRatePercent: 100,
      outcomeConsistencyPercent: 100
    });
    expect(await readFile(batch.attempts[0].resultPath!, 'utf8')).toBe('確認済み。問題なし。\n');
  });

  test('does not invent a success rate when a workflow has no local checks', async () => {
    const rootPath = await projectRoot();
    const runtime = runtimeDouble();
    const controller = new WorkflowRunController({ runtime, createId: ids() });
    const definition = await controller.saveDefinition({
      rootPath, workflowId: null, name: '自由記述', prompt: '自由に要約する', checks: []
    });
    await controller.startBatch({ projectId: 'repo-1', rootPath, workflowId: definition.workflowId, repetitions: 1 });
    await controller.handleRuntimeNotification(notification('agent_message', 'thread-1', 'これは自然文の結果です。'));
    await controller.handleRuntimeNotification(notification('turn_completed', 'thread-1'));

    const batch = (await readWorkflowState(rootPath)).batches[0];
    expect(batch.attempts[0].checkOutcome).toBe('unassessed');
    expect(summarizeWorkflowBatch(batch)).toMatchObject({
      executionReliabilityPercent: 100,
      successRatePercent: null,
      outcomeConsistencyPercent: null
    });
  });

  test('records a failed attempt and continues the requested repetitions', async () => {
    const rootPath = await projectRoot();
    const runtime = runtimeDouble();
    const controller = new WorkflowRunController({ runtime, createId: ids() });
    const definition = await controller.saveDefinition({
      rootPath, workflowId: null, name: '継続確認', prompt: '一回実行する', checks: []
    });
    await controller.startBatch({ projectId: 'repo-1', rootPath, workflowId: definition.workflowId, repetitions: 2 });
    await controller.handleRuntimeNotification(notification('turn_failed', 'thread-1', 'temporary failure'));
    await controller.handleRuntimeNotification(notification('agent_message', 'thread-2', '二回目は完了'));
    await controller.handleRuntimeNotification(notification('turn_completed', 'thread-2'));

    const batch = (await readWorkflowState(rootPath)).batches[0];
    expect(batch.status).toBe('partial');
    expect(batch.attempts.map((attempt) => attempt.status)).toEqual(['failed', 'completed']);
    expect(summarizeWorkflowBatch(batch)).toMatchObject({ executionReliabilityPercent: 50, failedRuns: 1 });
  });

  test('declines an approval request and keeps the read-only boundary', async () => {
    const rootPath = await projectRoot();
    const runtime = runtimeDouble();
    const controller = new WorkflowRunController({ runtime, createId: ids() });
    const definition = await controller.saveDefinition({
      rootPath, workflowId: null, name: '境界確認', prompt: '読み取りだけする', checks: []
    });
    await controller.startBatch({ projectId: 'repo-1', rootPath, workflowId: definition.workflowId, repetitions: 1 });
    const approval: RuntimeApprovalRequest = {
      projectId: 'repo-1',
      correlationId: 'approval-1',
      requestId: 'request-1',
      providerConnectionId: 'provider-connection-1',
      method: 'item/fileChange/requestApproval',
      threadId: 'thread-1',
      turnId: 'turn-1',
      targetAgentId: 'orchestrator',
      requestedEffect: { kind: 'file_change', itemId: 'item-1' },
      reason: 'write requested',
      responseOptions: ['accept', 'decline'],
      actionFingerprint: 'a'.repeat(64)
    };

    await expect(controller.handleRuntimeApproval(approval)).resolves.toBe(true);
    expect(runtime.respondToApproval).toHaveBeenCalledWith(expect.objectContaining({
      providerConnectionId: 'provider-connection-1', decision: 'decline'
    }));
    expect(runtime.interruptInspection).toHaveBeenCalled();
    expect((await readWorkflowState(rootPath)).batches[0].attempts[0]).toMatchObject({
      status: 'failed', errorCode: 'read_only_boundary_violation'
    });
  });
});
