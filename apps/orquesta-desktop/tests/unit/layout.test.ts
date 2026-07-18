import { describe, expect, test } from 'vitest';
import { fixtureCatalog } from '../../src/fixtures';
import { agent } from '../../src/fixtures/helpers';
import { createStableLayout } from '../../src/renderer/features/map/layout';

function makeAgent(id: string, assignedByAgentId: string | null) {
  return agent({ id, displayName: id, role: 'Worker', roleSummary: 'Worker', iconKey: 'code', assignedByAgentId });
}

function expectNoNodeCollisions(layout: ReturnType<typeof createStableLayout>) {
  const points = [...layout.agentPositions.entries()];
  for (let leftIndex = 0; leftIndex < points.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < points.length; rightIndex += 1) {
      const left = points[leftIndex][1];
      const right = points[rightIndex][1];
      const overlaps = Math.abs(left.x - right.x) < layout.nodeWidth
        && Math.abs(left.y - right.y) < layout.nodeHeight;
      expect(overlaps, `${points[leftIndex][0]} overlaps ${points[rightIndex][0]}`).toBe(false);
    }
  }
}

describe('stable map layout', () => {
  test('returns one stable coordinate for every agent', () => {
    const agents = fixtureCatalog['active-project'].snapshot.agents;
    const first = createStableLayout(agents);
    const second = createStableLayout(agents.map((agent) => ({ ...agent, status: agent.status === 'working' ? 'standby' : agent.status })));
    expect(first.agentPositions.size).toBe(agents.length);
    for (const agent of agents) expect(second.agentPositions.get(agent.id)).toEqual(first.agentPositions.get(agent.id));
  });

  test('large roster remains individual and uses compact world geometry', () => {
    const agents = fixtureCatalog['large-roster'].snapshot.agents;
    const layout = createStableLayout(agents);
    expect(layout.compact).toBe(true);
    expect(layout.agentPositions.size).toBe(35);
    expect(layout.width).toBeGreaterThan(1200);
    const directReportYs = agents
      .filter((item) => item.assignedByAgentId === 'orchestrator')
      .map((item) => layout.agentPositions.get(item.id)?.y);
    expect(new Set(directReportYs)).toHaveLength(1);
    expectNoNodeCollisions(layout);
  });

  test('wraps eighty direct reports without dropping or colliding nodes', () => {
    const agents = [makeAgent('orchestrator', 'user')];
    for (let index = 0; index < 79; index += 1) {
      agents.push(makeAgent(`worker-${String(index).padStart(2, '0')}`, 'orchestrator'));
    }
    const layout = createStableLayout(agents);

    expect(layout.agentPositions.size).toBe(80);
    expect(layout.width).toBeLessThanOrEqual(3000);
    expectNoNodeCollisions(layout);
  });

  test('grows vertically for deep delegation and emits one parent edge per agent', () => {
    const agents = [makeAgent('orchestrator', 'user')];
    let parent = 'orchestrator';
    for (let depth = 1; depth <= 8; depth += 1) {
      const id = `depth-${depth}`;
      agents.push(makeAgent(id, parent));
      parent = id;
    }
    const layout = createStableLayout(agents);

    expect(layout.height).toBeGreaterThan(1500);
    expect(layout.edges).toHaveLength(agents.length);
    expectNoNodeCollisions(layout);
  });
});
