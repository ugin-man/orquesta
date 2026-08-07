import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import type { DesktopRuntimeSendInput } from './desktop-codex-service';
import type { DesktopExecutionRuntime } from './desktop-execution-kernel';
import {
  DesktopExecutionShadowController,
  desktopExecutionShadowEnabled
} from './desktop-execution-shadow';

const NOW = new Date('2026-07-31T04:00:00.000Z');

async function projectRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'orquesta-desktop-shadow-'));
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

function request(rootPath: string, index: number, overrides: Partial<DesktopRuntimeSendInput> = {}) {
  return {
    correlationId: `corr-${index}`,
    projectId: 'project-shadow',
    rootPath,
    threadId: null,
    targetAgentId: 'orchestrator',
    text: `Neutral instruction ${index}`,
    localImagePaths: [],
    recommendedModel: null,
    requestedModel: null,
    ...overrides
  };
}

async function readShadow(root: string) {
  return JSON.parse(await readFile(
    path.join(root, '.orquesta', 'state', 'execution-kernel-shadow-v2.json'),
    'utf8'
  ));
}

function shadow(runtime: DesktopExecutionRuntime, environment: NodeJS.ProcessEnv = {
  ORQUESTA_EXECUTION_KERNEL_SHADOW_V2: '1'
}) {
  return new DesktopExecutionShadowController({
    runtime,
    environment,
    now: () => NOW
  });
}

describe('DesktopExecutionShadowController', () => {
  test('is opt-in and never runs beside the active kernel', () => {
    expect(desktopExecutionShadowEnabled({})).toBe(false);
    expect(desktopExecutionShadowEnabled({ ORQUESTA_EXECUTION_KERNEL_SHADOW_V2: '1' })).toBe(true);
    expect(desktopExecutionShadowEnabled({
      ORQUESTA_EXECUTION_KERNEL_SHADOW_V2: '1',
      ORQUESTA_EXECUTION_KERNEL_V2: '1'
    })).toBe(false);
  });

  test('observes one authoritative send without creating an additional turn', async () => {
    const root = await projectRoot();
    const runtime = runtimeDouble();
    const controller = shadow(runtime);
    const input = request(root, 1);

    await expect(controller.execute(input, () => runtime.sendMessage(input))).resolves.toMatchObject({
      threadId: 'thread-1',
      turnId: 'turn-1'
    });
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);

    const state = await readShadow(root);
    expect(state.observations).toHaveLength(1);
    expect(state.observations[0]).toMatchObject({
      predicted_action: 'dispatch',
      actual_action: 'dispatch_accepted',
      divergence: null,
      kernel_tracked: true,
      policy_evidence: {
        source: 'unavailable',
        execution_policy: null,
        reason: 'desktop_runtime_send_has_no_structured_task_intent'
      },
      additional_codex_turns: 0
    });
    expect(state.metrics).toMatchObject({
      observed_dispatches: 1,
      matching_dispatches: 1,
      divergences: 0,
      additional_codex_turns: 0
    });
  });

  test('records a legacy duplicate dispatch as a shadow divergence without blocking it', async () => {
    const root = await projectRoot();
    const runtime = runtimeDouble();
    const controller = shadow(runtime);
    const input = request(root, 1);

    await controller.execute(input, () => runtime.sendMessage(input));
    await controller.execute(input, () => runtime.sendMessage(input));

    const state = await readShadow(root);
    expect(runtime.sendMessage).toHaveBeenCalledTimes(2);
    expect(state.observations[1]).toMatchObject({
      predicted_action: 'suppress_duplicate',
      actual_action: 'dispatch_accepted',
      divergence: 'kernel_suppressed_legacy_dispatched',
      kernel_tracked: false
    });
    expect(state.metrics.divergences).toBe(1);
  });

  test('records capacity disagreement while preserving the existing runtime route', async () => {
    const root = await projectRoot();
    const runtime = runtimeDouble();
    const controller = shadow(runtime);

    for (let index = 1; index <= 3; index += 1) {
      const input = request(root, index);
      await controller.execute(input, () => runtime.sendMessage(input));
    }

    const state = await readShadow(root);
    expect(runtime.sendMessage).toHaveBeenCalledTimes(3);
    expect(state.observations.map((item: { predicted_action: string }) => item.predicted_action))
      .toEqual(['dispatch', 'dispatch', 'wait_for_capacity']);
    expect(state.observations[2].divergence).toBe('kernel_waited_legacy_dispatched');
  });

  test('projects completion into shadow state and recovers it without redispatch', async () => {
    const root = await projectRoot();
    const runtime = runtimeDouble();
    const controller = shadow(runtime);
    const input = request(root, 1);
    await controller.execute(input, () => runtime.sendMessage(input));
    const modelEvidence = {
      recommendedModel: null,
      requestedModel: null,
      appliedModel: 'test-model',
      actualModel: null,
      actualModelEvidence: 'unknown' as const
    };
    await controller.observe({
      kind: 'turn_completed',
      threadId: 'thread-1',
      turnId: 'turn-1',
      text: null,
      targetAgentId: 'orchestrator',
      modelEvidence
    });

    let state = await readShadow(root);
    expect(state.kernel_state.tasks['desktop-corr-1'].state).toBe('verifying');
    expect(state.metrics.completed_turns).toBe(1);

    const recoveringRuntime = runtimeDouble();
    recoveringRuntime.listProjectThreads = vi.fn(async () => [{
      id: 'thread-1',
      cwd: root,
      name: 'Shadow',
      archived: false,
      status: 'idle',
      updatedAt: 1
    }]);
    recoveringRuntime.readTurnStatus = vi.fn(async () => 'completed');
    await shadow(recoveringRuntime).open(root);

    state = await readShadow(root);
    expect(state.metrics.completed_turns).toBe(1);
    expect(recoveringRuntime.sendMessage).not.toHaveBeenCalled();
  });

  test('records an authoritative failure as evidence instead of retrying it', async () => {
    const root = await projectRoot();
    const runtime = runtimeDouble();
    const controller = shadow(runtime);
    const input = request(root, 1);

    await expect(controller.execute(input, async () => {
      throw new Error('runtime offline');
    })).rejects.toThrow(/runtime offline/u);

    const state = await readShadow(root);
    expect(state.observations[0]).toMatchObject({
      predicted_action: 'dispatch',
      actual_action: 'dispatch_failed',
      divergence: 'kernel_dispatch_legacy_failed',
      runtime_status: 'failed'
    });
    expect(state.kernel_state.tasks['desktop-corr-1'].state).toBe('retry_queued');
    expect(state.metrics.actual_failures).toBe(1);
    expect(runtime.sendMessage).not.toHaveBeenCalled();
  });
});
