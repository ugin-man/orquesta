import { describe, expect, test } from 'vitest';
import { inspectionPosition, inspectionScreenPosition } from '../../src/renderer/features/map/inspection-layout';
import { createStableLayout } from '../../src/renderer/features/map/layout';
import { adaptiveTwoLineFixture } from '../../src/fixtures/adaptive-organization';
import { inspectionRunningFixture } from '../../src/fixtures/inspection-running';

describe('inspection map layout', () => {
  test('places external comparison left and adversarial audit right of the orchestrator', () => {
    expect(inspectionPosition('external_benchmark', { x: 500, y: 300 }, 126)).toEqual({ x: 311, y: 300 });
    expect(inspectionPosition('adversarial_audit', { x: 500, y: 300 }, 126)).toEqual({ x: 689, y: 300 });
  });

  test('keeps enough screen-space clearance when fit zoom shrinks world distances faster than node visuals', () => {
    expect(inspectionScreenPosition('external_benchmark', { x: 720, y: 300 }, 0.32, 0.62)).toEqual({ x: 628.86, y: 300 });
    expect(inspectionScreenPosition('adversarial_audit', { x: 720, y: 300 }, 0.32, 0.62)).toEqual({ x: 811.14, y: 300 });
  });

  test('leaves canonical agents and organization layout unchanged', () => {
    const baseline = createStableLayout(adaptiveTwoLineFixture.snapshot);
    const withInspections = createStableLayout(inspectionRunningFixture.snapshot);

    expect(inspectionRunningFixture.snapshot.agents).toHaveLength(adaptiveTwoLineFixture.snapshot.agents.length);
    expect([...withInspections.agentPositions]).toEqual([...baseline.agentPositions]);
  });
});
