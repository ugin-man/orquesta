import { describe, expect, test } from 'vitest';
import { fixtureCatalog } from '../../src/fixtures';
import { activeItems } from '../../src/renderer/features/now/NowCardStack';

describe('Now evidence filtering', () => {
  test('requires both proven task activity and a currently working agent', () => {
    const fixture = fixtureCatalog['active-project'].snapshot;
    const staleAgents = fixture.agents.map((agent) => ({ ...agent, status: 'stale' as const }));

    expect(activeItems(staleAgents, fixture.tasks, true)).toEqual([]);
    expect(activeItems(fixture.agents, fixture.tasks, true).every(({ agent }) => agent.status === 'working')).toBe(true);
  });
});
