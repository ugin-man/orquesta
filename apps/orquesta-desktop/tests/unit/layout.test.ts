import { describe, expect, test } from 'vitest';
import { fixtureCatalog } from '../../src/fixtures';
import { agent } from '../../src/fixtures/helpers';
import { createStableLayout } from '../../src/renderer/features/map/layout';

function makeAgent(id: string, assignedByAgentId: string | null, role = 'Worker') {
  return agent({ id, displayName: id, role, roleSummary: role, iconKey: 'code', assignedByAgentId });
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
    expect(layout.groups.length).toBeGreaterThan(1);
    expect(layout.edges.every((edge) => ['spine', 'admin', 'support', 'production', 'delegation'].includes(edge.kind))).toBe(true);
    expectNoNodeCollisions(layout);
  });

  test('keeps same-role implementation agents inside one visible production group', () => {
    const agents = [
      makeAgent('orchestrator', 'user', 'orchestrator'),
      makeAgent('orquesta-admin', 'orchestrator', 'orquesta-admin'),
      makeAgent('user-liaison', 'orchestrator', 'user-liaison'),
      makeAgent('vision-curator', 'orchestrator', 'vision-curator'),
      makeAgent('error-concierge', 'orchestrator', 'error-concierge'),
      makeAgent('implementation-001', 'orchestrator', 'implementation'),
      makeAgent('implementation-002', 'orchestrator', 'implementation'),
      makeAgent('implementation-003', 'implementation-001', 'implementation')
    ];

    const layout = createStableLayout(agents);
    const implementation = layout.groups.find((group) => group.id === 'implementation');

    expect(implementation?.agentIds).toEqual(['implementation-001', 'implementation-002', 'implementation-003']);
    expect(layout.agentPositions.get('orquesta-admin')!.x).toBeLessThan(layout.user.x);
    expect(layout.agentPositions.get('user-liaison')!.x).toBeGreaterThan(layout.user.x);
    expect(layout.agentPositions.size).toBe(agents.length);
    expectNoNodeCollisions(layout);
  });

  test('wraps eighty direct reports without dropping or colliding nodes', () => {
    const agents = [makeAgent('orchestrator', 'user')];
    for (let index = 0; index < 79; index += 1) {
      agents.push(makeAgent(`worker-${String(index).padStart(2, '0')}`, 'orchestrator', 'implementation'));
    }
    const layout = createStableLayout(agents);

    expect(layout.agentPositions.size).toBe(80);
    expect(layout.width).toBeLessThanOrEqual(4200);
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
    expect(layout.edges.length).toBeGreaterThanOrEqual(agents.length);
    expectNoNodeCollisions(layout);
  });
});
