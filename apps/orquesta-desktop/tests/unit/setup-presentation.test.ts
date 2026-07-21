import { describe, expect, test } from 'vitest';
import { setupRunningFixture } from '../../src/fixtures/setup-running';
import { applySetupProgress } from '../../src/renderer/features/setup/setup-presentation';

describe('setup progress presentation', () => {
  test('advances the visible setup without waiting for a repository debounce', () => {
    const next = applySetupProgress(setupRunningFixture.snapshot.setup!, {
      setupId: 'SETUP-1',
      phaseId: 'planning',
      status: 'active',
      message: '最初の実行可能作業を設計しています。',
      occurredAt: '2026-07-22T00:00:04.000Z'
    });

    expect(next.currentPhaseId).toBe('planning');
    expect(next.phases.map((phase) => phase.status)).toEqual([
      'complete', 'complete', 'complete', 'active', 'waiting', 'waiting'
    ]);
    expect(next.currentActivity?.detail).toBe('最初の実行可能作業を設計しています。');
  });

  test('turns a failed progress event into a visible blocked phase', () => {
    const next = applySetupProgress(setupRunningFixture.snapshot.setup!, {
      setupId: 'SETUP-1',
      phaseId: 'foundation',
      status: 'failed',
      message: '状態を保存できません。',
      occurredAt: '2026-07-22T00:00:04.000Z'
    });

    expect(next.status).toBe('blocked');
    expect(next.phases[2]?.status).toBe('blocked');
    expect(next.currentActivity?.status).toBe('failed');
  });
});
