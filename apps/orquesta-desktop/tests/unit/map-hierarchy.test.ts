import { describe, expect, test } from 'vitest';
import { agent } from '../../src/fixtures/helpers';
import { buildAgentHierarchy } from '../../src/renderer/features/map/hierarchy';

function makeAgent(id: string, assignedByAgentId: string | null) {
  return agent({
    id,
    displayName: id,
    role: 'Specialist',
    roleSummary: 'Specialist',
    iconKey: 'code',
    assignedByAgentId
  });
}

describe('buildAgentHierarchy', () => {
  test('projects nested delegation without dropping idle agents', () => {
    const hierarchy = buildAgentHierarchy([
      makeAgent('orchestrator', 'user'),
      makeAgent('design', 'orchestrator'),
      makeAgent('implementation-a', 'design'),
      makeAgent('implementation-b', 'design'),
      makeAgent('review', 'orchestrator')
    ]);

    expect(hierarchy.rootIds).toEqual(['orchestrator']);
    expect(hierarchy.childrenByParentId.get('orchestrator')).toEqual(['design', 'review']);
    expect(hierarchy.childrenByParentId.get('design')).toEqual(['implementation-a', 'implementation-b']);
    expect(hierarchy.depthByAgentId.get('implementation-a')).toBe(3);
    expect(hierarchy.diagnostics).toEqual([]);
  });

  test('repairs missing parents, self references, and cycles while keeping every agent once', () => {
    const hierarchy = buildAgentHierarchy([
      makeAgent('orchestrator', 'user'),
      makeAgent('missing', 'not-present'),
      makeAgent('self', 'self'),
      makeAgent('cycle-a', 'cycle-b'),
      makeAgent('cycle-b', 'cycle-a')
    ]);
    const listed = [...hierarchy.childrenByParentId.values()].flat();

    expect(listed.sort()).toEqual(['cycle-a', 'cycle-b', 'missing', 'orchestrator', 'self']);
    expect(new Set(listed).size).toBe(5);
    expect(hierarchy.diagnostics.map((item) => `${item.agentId}:${item.kind}`).sort()).toEqual([
      'cycle-a:cycle',
      'cycle-b:cycle',
      'missing:missing_parent',
      'self:self_parent'
    ]);
    expect(hierarchy.depthByAgentId.size).toBe(5);
  });

  test('does not change structure when only runtime status changes', () => {
    const agents = [
      makeAgent('orchestrator', 'user'),
      makeAgent('worker', 'orchestrator')
    ];
    const first = buildAgentHierarchy(agents);
    const second = buildAgentHierarchy(agents.map((item) => ({ ...item, status: 'working' })));

    expect([...second.parentByAgentId]).toEqual([...first.parentByAgentId]);
    expect([...second.depthByAgentId]).toEqual([...first.depthByAgentId]);
  });
});
