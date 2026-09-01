import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import {
  DesktopExecutionKernelController,
  desktopExecutionKernelEnabled,
  type DesktopExecutionRuntime
} from './desktop-execution-kernel';

async function projectRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'orquesta-desktop-kernel-'));
  await mkdir(path.join(root, '.orquesta', 'state'), { recursive: true });
  return root;
}

function runtimeDouble(): DesktopExecutionRuntime {
  let count = 0;
  return {
    sendMessage: vi.fn(async (input) => {
      count += 1;
      return {
        threadId: input.threadId ?? `thread-${count}`,
        turnId: `turn-${count}`,
        modelEvidence: {
          recommendedModel: input.recommendedModel,
          requestedModel: input.requestedModel,
          appliedModel: 'test-model',
          actualModel: null,
          actualModelEvidence: 'unknown'
        }
      };
    }),
    listProjectThreads: vi.fn(async () => []),
    readTurnStatus: vi.fn(async () => null)
  };
}

function request(rootPath: string, index: number) {
  return {
    correlationId: `corr-${index}`,
    projectId: 'project-1',
    rootPath,
    threadId: null,
    targetAgentId: 'orchestrator',
    text: `Task ${index}`,
    attachments: [],
    recommendedModel: null,
    requestedModel: null
  };
}

describe('DesktopExecutionKernelController', () => {
  test('is disabled by default and enabled only through the V2 flag', () => {
    expect(desktopExecutionKernelEnabled({})).toBe(false);
    expect(desktopExecutionKernelEnabled({ ORQUESTA_EXECUTION_KERNEL_V2: '1' })).toBe(true);
  });

  test('rejects saturated work before mutation and retains history when later capacity frees up', async () => {
    const root = await projectRoot();
    const runtime = runtimeDouble();
    const controller = new DesktopExecutionKernelController({
      runtime,
      environment: { ORQUESTA_EXECUTION_KERNEL_V2: '1' },
      now: () => new Date('2026-07-31T01:00:00.000Z')
    });

    await expect(controller.dispatch(request(root, 1))).resolves.toMatchObject({
      threadId: 'thread-1', turnId: 'turn-1'
    });
    await expect(controller.dispatch(request(root, 2))).resolves.toMatchObject({
      threadId: 'thread-2', turnId: 'turn-2'
    });
    await expect(controller.dispatch(request(root, 3))).rejects.toThrow(/capacity is full/u);
    const saturated = JSON.parse(await readFile(
      path.join(root, '.orquesta', 'state', 'execution-kernel-v2.json'),
      'utf8'
    ));
    expect(Object.keys(saturated.tasks)).toHaveLength(2);
    expect(saturated.tasks).not.toHaveProperty('desktop-corr-3');
    const modelEvidence = {
      recommendedModel: null, requestedModel: null, appliedModel: 'test-model', actualModel: null,
      actualModelEvidence: 'unknown' as const
    };
    await controller.observe({
      kind: 'turn_started', threadId: 'thread-1', turnId: 'turn-1', text: null,
      targetAgentId: 'orchestrator', modelEvidence
    });
    await controller.observe({
      kind: 'turn_completed', threadId: 'thread-1', turnId: 'turn-1', text: null,
      targetAgentId: 'orchestrator', modelEvidence
    });
    await expect(controller.dispatch(request(root, 4))).resolves.toMatchObject({
      threadId: 'thread-3', turnId: 'turn-3'
    });

    const state = JSON.parse(await readFile(
      path.join(root, '.orquesta', 'state', 'execution-kernel-v2.json'),
      'utf8'
    ));
    expect(Object.keys(state.tasks)).toHaveLength(3);
    expect(state.tasks['desktop-corr-1']).toMatchObject({
      state: 'verifying',
      thread_id: 'thread-1',
      turn_id: 'turn-1'
    });
    expect(state.tasks['desktop-corr-4']).toMatchObject({
      state: 'dispatching', thread_id: 'thread-3', turn_id: 'turn-3'
    });
    expect(runtime.sendMessage).toHaveBeenCalledTimes(3);
    expect(runtime.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ text: 'Task 3' }));
  });

  test('projects correlated runtime notifications without changing the Desktop event route', async () => {
    const root = await projectRoot();
    const runtime = runtimeDouble();
    const controller = new DesktopExecutionKernelController({
      runtime,
      environment: { ORQUESTA_EXECUTION_KERNEL_V2: '1' },
      now: () => new Date('2026-07-31T01:00:00.000Z')
    });
    await controller.dispatch(request(root, 1));
    const modelEvidence = {
      recommendedModel: null,
      requestedModel: null,
      appliedModel: 'test-model',
      actualModel: null,
      actualModelEvidence: 'unknown' as const
    };
    await controller.observe({
      kind: 'turn_started', threadId: 'thread-1', turnId: 'turn-1',
      text: null, targetAgentId: 'orchestrator', modelEvidence
    });
    await controller.observe({
      kind: 'agent_message', threadId: 'thread-1', turnId: 'turn-1',
      text: 'Done.', targetAgentId: 'orchestrator', modelEvidence
    });
    await controller.observe({
      kind: 'turn_completed', threadId: 'thread-1', turnId: 'turn-1',
      text: null, targetAgentId: 'orchestrator', modelEvidence
    });

    const state = JSON.parse(await readFile(
      path.join(root, '.orquesta', 'state', 'execution-kernel-v2.json'),
      'utf8'
    ));
    expect(state.tasks['desktop-corr-1']).toMatchObject({
      state: 'verifying',
      runtime_status: 'completed'
    });
  });

  test('recovers a completed real turn without starting another turn', async () => {
    const root = await projectRoot();
    const firstRuntime = runtimeDouble();
    const first = new DesktopExecutionKernelController({
      runtime: firstRuntime,
      environment: { ORQUESTA_EXECUTION_KERNEL_V2: '1' },
      now: () => new Date('2026-07-31T01:00:00.000Z')
    });
    await first.dispatch(request(root, 1));

    const recoveringRuntime = runtimeDouble();
    recoveringRuntime.listProjectThreads = vi.fn(async () => [{
      id: 'thread-1',
      cwd: root,
      name: 'Proof',
      archived: false,
      status: 'idle',
      updatedAt: 1
    }]);
    recoveringRuntime.readTurnStatus = vi.fn(async () => 'completed');
    const recovered = new DesktopExecutionKernelController({
      runtime: recoveringRuntime,
      environment: { ORQUESTA_EXECUTION_KERNEL_V2: '1' },
      now: () => new Date('2026-07-31T01:01:00.000Z')
    });
    await recovered.open(root);

    const state = JSON.parse(await readFile(
      path.join(root, '.orquesta', 'state', 'execution-kernel-v2.json'),
      'utf8'
    ));
    expect(state.tasks['desktop-corr-1'].state).toBe('verifying');
    expect(recoveringRuntime.sendMessage).not.toHaveBeenCalled();
  });

  test('does not overwrite an unreadable persisted kernel state', async () => {
    const root = await projectRoot();
    const file = path.join(root, '.orquesta', 'state', 'execution-kernel-v2.json');
    await writeFile(file, '{broken', 'utf8');
    const controller = new DesktopExecutionKernelController({
      runtime: runtimeDouble(),
      environment: { ORQUESTA_EXECUTION_KERNEL_V2: '1' }
    });

    await expect(controller.open(root)).rejects.toThrow();
    await expect(readFile(file, 'utf8')).resolves.toBe('{broken');
  });
});
