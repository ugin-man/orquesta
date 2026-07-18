import { describe, expect, it } from 'vitest';
import { fixtureCatalog } from '../../src/fixtures';
import { buildMapLayout, taskHasActiveEvidence } from '../../src/renderer/features/map/layout';

describe('map layout', () => {
  it('creates a stable unique position for every agent', () => {
    const snapshot = fixtureCatalog['large-roster'].snapshot;
    const first = buildMapLayout(snapshot.agents, snapshot.tasks);
    const second = buildMapLayout(snapshot.agents, snapshot.tasks);
    expect(first.nodes).toEqual(second.nodes);
    expect(first.nodes).toHaveLength(35);
    const points = new Set(first.nodes.map((node) => `${node.x.toFixed(2)}:${node.y.toFixed(2)}`));
    expect(points.size).toBe(35);
    expect(first.bounds.width).toBeGreaterThan(900);
  });

  it('animates only work with observed runtime evidence', () => {
    const active = fixtureCatalog['active-project'].snapshot.tasks.find((task) => task.id === 'T68');
    const dispatchOnly = fixtureCatalog['unknown-evidence'].snapshot.tasks.find((task) => task.id === 'U12');
    expect(active && taskHasActiveEvidence(active)).toBe(true);
    expect(dispatchOnly && taskHasActiveEvidence(dispatchOnly)).toBe(false);
  });
});
