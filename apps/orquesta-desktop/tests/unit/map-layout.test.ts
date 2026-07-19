import { describe, expect, it } from 'vitest';
import { fixtureCatalog } from '../../src/fixtures';
import { buildMapLayout, createStableLayout, groupBoundsForPositions, orthogonalPath, taskHasActiveEvidence } from '../../src/renderer/features/map/layout';

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

  it('uses straight orthogonal commands for organization links', () => {
    const path = orthogonalPath({ x: 40, y: 20 }, { x: 180, y: 140 });
    expect(path).toBe('M 40 20 V 80 H 180 V 140');
    expect(path).not.toContain('C');
  });

  it('routes grouped roots to the top of the agent instead of through its center', () => {
    const snapshot = fixtureCatalog['large-roster'].snapshot;
    const layout = createStableLayout(snapshot.agents);
    const group = layout.groups.find((candidate) => candidate.agentIds.length > 1);
    expect(group).toBeDefined();

    const rootEdge = layout.edges.find((edge) => edge.parentId === `group:${group!.id}`);
    const rootPosition = rootEdge ? layout.agentPositions.get(rootEdge.childId) : undefined;
    expect(rootEdge).toBeDefined();
    expect(rootPosition).toBeDefined();
    expect(rootEdge!.to.y).toBe(rootPosition!.y - layout.nodeHeight / 2);
  });

  it('keeps useful frame padding after grouped agents are moved', () => {
    const snapshot = fixtureCatalog['large-roster'].snapshot;
    const layout = createStableLayout(snapshot.agents);
    const group = layout.groups.find((candidate) => candidate.agentIds.length > 1)!;
    const positions = new Map(layout.agentPositions);
    const first = positions.get(group.agentIds[0])!;
    positions.set(group.agentIds[0], { x: first.x - 80, y: first.y - 120 });

    const bounds = groupBoundsForPositions(group, positions, layout.nodeWidth, layout.nodeHeight);
    const groupPoints = group.agentIds.map((agentId) => positions.get(agentId)!).filter(Boolean);
    const left = Math.min(...groupPoints.map((point) => point.x - layout.nodeWidth / 2));
    const top = Math.min(...groupPoints.map((point) => point.y - layout.nodeHeight / 2));
    const right = Math.max(...groupPoints.map((point) => point.x + layout.nodeWidth / 2));
    const bottom = Math.max(...groupPoints.map((point) => point.y + layout.nodeHeight / 2));

    expect(bounds.x).toBe(left - 52);
    expect(bounds.y).toBe(top - 92);
    expect(bounds.x + bounds.width).toBe(right + 52);
    expect(bounds.y + bounds.height).toBe(bottom + 44);
  });
});
