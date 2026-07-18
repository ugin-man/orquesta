import { describe, expect, test } from 'vitest';
import { fixtureCatalog } from '../../src/fixtures';
import { createStableLayout } from '../../src/renderer/features/map/layout';

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
  });
});
