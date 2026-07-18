import { describe, expect, test } from 'vitest';
import { agent } from '../../src/fixtures/helpers';
import { buildOrganizationProjection, productionGroupFor } from '../../src/renderer/features/map/organization';

function makeAgent(id: string, role: string, assignedByAgentId: string | null) {
  return agent({
    id,
    displayName: id,
    role,
    roleSummary: `${role} mission`,
    iconKey: 'code',
    assignedByAgentId
  });
}

describe('buildOrganizationProjection', () => {
  test('separates the command spine, admin satellite, support branch, and production groups', () => {
    const projection = buildOrganizationProjection([
      makeAgent('orchestrator', 'orchestrator', 'user'),
      makeAgent('orquesta-admin', 'orquesta-admin', 'orchestrator'),
      makeAgent('user-liaison', 'user-liaison', 'orchestrator'),
      makeAgent('vision-curator', 'vision-curator', 'orchestrator'),
      makeAgent('error-concierge', 'error-concierge', 'orchestrator'),
      makeAgent('implementation-001', 'implementation', 'orchestrator'),
      makeAgent('implementation-002', 'implementation', 'orchestrator'),
      makeAgent('implementation-003', 'implementation', 'implementation-001')
    ]);

    expect(projection.parentByAgentId.get('orchestrator')).toBe('user');
    expect(projection.parentByAgentId.get('orquesta-admin')).toBe('user');
    expect(projection.parentByAgentId.get('user-liaison')).toBe('user');
    expect(projection.parentByAgentId.get('vision-curator')).toBe('user-liaison');
    expect(projection.parentByAgentId.get('error-concierge')).toBe('user-liaison');
    expect(projection.laneByAgentId.get('orquesta-admin')).toBe('utility');
    expect(projection.laneByAgentId.get('vision-curator')).toBe('support');
    expect(projection.groupByAgentId.get('implementation-001')).toBe('implementation');
    expect(projection.groupByAgentId.get('implementation-002')).toBe('implementation');
    expect(projection.groupByAgentId.get('implementation-003')).toBe('implementation');
    expect(projection.parentByAgentId.get('implementation-003')).toBe('implementation-001');
    expect(projection.groups.find((group) => group.id === 'implementation')?.agentIds).toEqual([
      'implementation-001',
      'implementation-002',
      'implementation-003'
    ]);
  });

  test('classifies production roles deterministically and keeps unknown roles visible', () => {
    expect(productionGroupFor(makeAgent('implementation-001', 'implementation', 'orchestrator'))).toBe('implementation');
    expect(productionGroupFor(makeAgent('dashboard-ux-001', 'dashboard-ux', 'orchestrator'))).toBe('design');
    expect(productionGroupFor(makeAgent('bootstrap-qa-001', 'bootstrap-qa', 'orchestrator'))).toBe('qa');
    expect(productionGroupFor(makeAgent('docs-release-001', 'docs-release', 'orchestrator'))).toBe('docs');
    expect(productionGroupFor(makeAgent('protocol-architect-001', 'protocol-architect', 'orchestrator'))).toBe('protocol');
    expect(productionGroupFor(makeAgent('research-001', 'research', 'orchestrator'))).toBe('research');
    expect(productionGroupFor(makeAgent('unfamiliar-001', 'unfamiliar', 'orchestrator'))).toBe('other');

    const projection = buildOrganizationProjection([
      makeAgent('orchestrator', 'orchestrator', 'user'),
      makeAgent('unfamiliar-001', 'unfamiliar', 'missing-parent')
    ]);
    expect(projection.groupByAgentId.get('unfamiliar-001')).toBe('other');
    expect(projection.parentByAgentId.get('unfamiliar-001')).toBe('orchestrator');
    expect(projection.diagnostics).toContainEqual({ agentId: 'unfamiliar-001', kind: 'missing_parent' });
  });

  test('does not change organization when only work state changes', () => {
    const agents = [
      makeAgent('orchestrator', 'orchestrator', 'user'),
      makeAgent('implementation-001', 'implementation', 'orchestrator'),
      makeAgent('implementation-002', 'implementation', 'implementation-001')
    ];
    const first = buildOrganizationProjection(agents);
    const second = buildOrganizationProjection(agents.map((item, index) => ({
      ...item,
      status: index === 1 ? 'working' as const : item.status,
      currentTaskId: index === 1 ? 'T200' : item.currentTaskId,
      currentTaskTitle: index === 1 ? 'Changed task' : item.currentTaskTitle
    })));

    expect([...second.parentByAgentId]).toEqual([...first.parentByAgentId]);
    expect([...second.groupByAgentId]).toEqual([...first.groupByAgentId]);
    expect(second.groups).toEqual(first.groups);
  });
});
