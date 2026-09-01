import { expect, test } from 'vitest';
import executionKernel from '@orquesta/execution-kernel';
import type { PlacementTaskV3 } from '@orquesta/contracts';
import { PlacementTaskPort } from './placement-task-port';

const rootPath = process.env.ORQUESTA_PLACEMENT_TASK_PROCESS_ROOT;
const rawIndex = process.env.ORQUESTA_PLACEMENT_TASK_PROCESS_INDEX;

if (!rootPath || !rawIndex) {
  test.skip('cross-process Placement Task worker requires an explicit parent fixture', () => {});
} else {
  test('appends one unique Placement Task through the public port', async () => {
    const index = Number(rawIndex);
    expect(Number.isSafeInteger(index)).toBe(true);
    const suffix = String(index).padStart(2, '0');
    const base = {
      task_id: `placement:0123456789ab:${suffix}`,
      task_kind: 'specialist_work' as const,
      placement_intent_id: 'PI-0123456789ab',
      assigned_agent_id: `implementation-0123456789ab-${suffix}`,
      owner_agent_id: `implementation-0123456789ab-${suffix}`,
      role_id: 'implementation',
      role_version: 1,
      purpose: `Concurrent append ${suffix}.`,
      acceptance_criteria: ['The unique task is durably present.'],
      state: 'queued' as const,
      dependencies: [],
      blocked_by: [],
      result_summary: null,
      accepted_at: null,
      specialist_report_required: true as const,
      created_at: '2026-08-24T06:00:00.000Z',
      updated_at: '2026-08-24T06:00:00.000Z'
    };
    const task: PlacementTaskV3 = {
      ...base,
      placement_fingerprint: executionKernel.taskFingerprint(base)
    };
    const result = await new PlacementTaskPort(rootPath).reconcilePlacementTasks({
      projectId: 'project-a',
      placementIntentId: 'PI-0123456789ab',
      tasks: [task]
    });
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].task_id).toBe(task.task_id);
  });
}
