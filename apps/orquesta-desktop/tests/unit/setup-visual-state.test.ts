import { describe, expect, test } from 'vitest';
import { setupRunningFixture } from '../../src/fixtures/setup-running';
import { createSetupVisualState } from '../../src/renderer/features/setup/setup-visual-state';

describe('setup visual state', () => {
  test('maps the canonical six setup phases to cumulative organ mechanisms', () => {
    const visual = createSetupVisualState(setupRunningFixture.snapshot.setup!, false);

    expect(visual.activePhaseId).toBe(3);
    expect(visual.lifecycle).toBe('running');
    expect(visual.overallProgress).toBe(50);
    expect(visual.phases.map((phase) => [phase.id, phase.status])).toEqual([
      [1, 'complete'],
      [2, 'complete'],
      [3, 'active'],
      [4, 'waiting'],
      [5, 'waiting'],
      [6, 'waiting']
    ]);
    expect(visual.logs).toHaveLength(3);
    expect(visual.logs.at(-1)?.state).toBe('running');
  });

  test('keeps a blocked phase visible without advancing later mechanisms', () => {
    const setup = setupRunningFixture.snapshot.setup!;
    const visual = createSetupVisualState({
      ...setup,
      status: 'blocked',
      phases: setup.phases.map((phase) => phase.order === 3
        ? { ...phase, status: 'blocked' as const }
        : phase),
      currentActivity: setup.currentActivity
        ? { ...setup.currentActivity, status: 'failed' as const }
        : null
    }, true);

    expect(visual.lifecycle).toBe('blocked');
    expect(visual.activePhaseId).toBe(3);
    expect(visual.reducedMotion).toBe(true);
    expect(visual.phases[2]?.status).toBe('blocked');
    expect(visual.phases[3]?.status).toBe('waiting');
  });
});
