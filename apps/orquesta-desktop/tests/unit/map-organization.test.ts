import { describe, expect, test } from 'vitest';
import { agent } from '../../src/fixtures/helpers';
import { buildOrganizationProjection, productionGroupFor } from '../../src/renderer/features/map/organization';
import { adaptiveTwoLineSnapshot } from './adaptive-map-fixture';

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

  test('keeps proposals outside active lines and diagnoses invalid explicit membership and cycles', () => {
    const base = adaptiveTwoLineSnapshot();
    const implementationOne = base.agents.find((item) => item.id === 'implementation-001')!;
    const implementationTwo = base.agents.find((item) => item.id === 'implementation-002')!;
    const snapshot = {
      ...base,
      agents: [
        ...base.agents.map((item) => item.id === implementationOne.id
          ? { ...item, organizationParentAgentId: implementationTwo.id }
          : item.id === implementationTwo.id
            ? { ...item, organizationParentAgentId: implementationOne.id, lineId: 'core-line', teamId: 'core-implementation' }
            : item),
        { ...implementationOne, id: 'missing-line-agent', displayName: 'Missing line', lineId: 'missing-line', teamId: 'desktop-implementation' },
        { ...implementationOne, id: 'missing-team-agent', displayName: 'Missing team', lineId: 'desktop-line', teamId: 'missing-team' }
      ],
      organization: {
        ...base.organization!,
        lineProposals: [{
          id: 'decision-propose-mobile',
          lineId: 'mobile-line',
          displayName: 'Mobile line',
          goal: 'Build mobile client',
          reason: 'Independent delivery path',
          status: 'approval_wait' as const,
          ownerAgentId: 'orchestrator'
        }]
      }
    };

    const projection = buildOrganizationProjection(snapshot);
    const placedIds = projection.lines.flatMap((line) => line.agentIds);

    expect(projection.lines.map((line) => line.id)).not.toContain('mobile-line');
    expect(projection.lineProposals).toEqual([expect.objectContaining({ lineId: 'mobile-line', status: 'approval_wait' })]);
    expect(placedIds.filter((id) => id === 'implementation-002')).toHaveLength(1);
    expect(projection.lines.find((line) => line.id === 'core-line')?.agentIds).toContain('implementation-002');
    expect(projection.lines.find((line) => line.id === 'desktop-line')?.agentIds).not.toContain('implementation-002');
    expect(projection.unassignedAgentIds).toEqual(expect.arrayContaining(['missing-line-agent', 'missing-team-agent']));
    expect(projection.sourceDiagnostics).toEqual(expect.arrayContaining([
      'missing_line:missing-line-agent:missing-line',
      'missing_team:missing-team-agent:missing-team'
    ]));
    expect(projection.diagnostics).toEqual(expect.arrayContaining([
      { agentId: 'implementation-001', kind: 'cycle' },
      { agentId: 'implementation-002', kind: 'cycle' }
    ]));
  });

  test('diagnoses legacy lead violations instead of inventing renderer leadership', () => {
    const base = adaptiveTwoLineSnapshot();
    const snapshot = {
      ...base,
      agents: base.agents.map((item) => item.id === 'implementation-001' ? { ...item, position: 'lead' as const } : item),
      organization: {
        ...base.organization!,
        lines: base.organization!.lines.map((line) => line.id === 'core-line' ? { ...line, dedicatedLeadAgentId: 'missing-agent' } : line)
      }
    };

    const projection = buildOrganizationProjection(snapshot);

    expect(projection.lines[0].teams[0].leadAgentId).toBeNull();
    expect(projection.lines.find((line) => line.id === 'core-line')?.responsibleAgentId).toBeNull();
    expect(projection.sourceDiagnostics).toEqual(expect.arrayContaining([
      'invalid_team_lead:desktop-implementation:expected_0:found_1',
      'invalid_line_lead:core-line:missing-agent',
      'missing_line_lead:core-line'
    ]));
  });
});
