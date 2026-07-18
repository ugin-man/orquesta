import { describe, expect, test } from 'vitest';
import { fixtureCatalog } from '../../src/fixtures';

describe('renderer fixtures', () => {
  test('active project exposes the complete seven-node roster', () => {
    const fixture = fixtureCatalog['active-project'];
    expect(fixture.snapshot.agents).toHaveLength(7);
    expect(new Set(fixture.snapshot.agents.map((agent) => agent.id)).size).toBe(7);
    expect(fixture.snapshot.project.isDemoData).toBe(true);
  });

  test('all-idle contains no claimed activity or attention', () => {
    const fixture = fixtureCatalog['all-idle'];
    expect(fixture.snapshot.agents.every((agent) => agent.status === 'standby')).toBe(true);
    expect(fixture.snapshot.tasks).toHaveLength(0);
    expect(fixture.snapshot.attention).toHaveLength(0);
  });

  test('attention-heavy meets the internal-scroll fixture minimums', () => {
    const fixture = fixtureCatalog['attention-heavy'];
    expect(fixture.snapshot.attention.length).toBeGreaterThanOrEqual(40);
    expect(fixture.attentionHistory.length).toBeGreaterThanOrEqual(100);
  });

  test('large-roster keeps thirty-five individual agents', () => {
    const fixture = fixtureCatalog['large-roster'];
    expect(fixture.snapshot.agents).toHaveLength(35);
    expect(new Set(fixture.snapshot.agents.map((agent) => agent.id)).size).toBe(35);
    expect(fixture.snapshot.agents.some((agent) => agent.assignedByAgentId?.startsWith('agent-'))).toBe(true);
  });

  test('nested-roster exercises deep, repeated, and malformed delegation', () => {
    const agents = fixtureCatalog['nested-roster'].snapshot.agents;
    const byId = new Map(agents.map((agent) => [agent.id, agent]));
    expect(agents.filter((agent) => agent.role === 'Implementation Specialist')).toHaveLength(4);
    expect(agents.filter((agent) => agent.assignedByAgentId === 'design-lead')).toHaveLength(3);
    expect(byId.get('depth-5')?.assignedByAgentId).toBe('depth-4');
    expect(byId.get('missing-parent')?.assignedByAgentId).toBe('not-installed');
    expect(byId.get('cycle-a')?.assignedByAgentId).toBe('cycle-b');
    expect(byId.get('cycle-b')?.assignedByAgentId).toBe('cycle-a');
  });

  test('wide-roster retains eighty unique visible candidates', () => {
    const agents = fixtureCatalog['wide-roster'].snapshot.agents;
    expect(agents).toHaveLength(80);
    expect(new Set(agents.map((agent) => agent.id))).toHaveLength(80);
  });

  test('offline snapshot stops proven work claims', () => {
    const fixture = fixtureCatalog['offline-project'];
    expect(fixture.snapshot.project.provenWorkingAgentCount).toBe(0);
    expect(fixture.snapshot.agents.every((agent) => agent.status !== 'working')).toBe(true);
    expect(fixture.snapshot.agents.every((agent) => agent.statusEvidence === 'unknown')).toBe(true);
  });

  test('unknown evidence distinguishes dispatch from turn start', () => {
    const task = fixtureCatalog['unknown-evidence'].snapshot.tasks.find((item) => item.id === 'U12');
    expect(task).toMatchObject({ dispatchAccepted: true, turnStarted: false, progressObserved: false, actualModel: null, actualModelEvidence: 'unknown' });
  });

  test('long Japanese fixture contains deliberately long labels', () => {
    const fixture = fixtureCatalog['long-japanese-text'];
    expect(fixture.snapshot.project.title.length).toBeGreaterThan(30);
    expect(fixture.snapshot.tasks.some((task) => task.title.length > 35)).toBe(true);
  });

  test('toast title and task chip do not repeat the same task id', () => {
    const event = fixtureCatalog['active-project'].snapshot.recentEvents[0];
    expect(event.taskId).toBeTruthy();
    expect(event.title).not.toContain(event.taskId ?? '');
  });

});
