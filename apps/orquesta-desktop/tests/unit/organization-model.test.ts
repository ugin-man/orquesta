import { describe, expect, test } from 'vitest';
import { agent } from '../../src/fixtures/helpers';
import { fixtureCatalog } from '../../src/fixtures';
import { buildOrganizationProjection } from '../../src/renderer/features/map/organization';

describe('explicit organization model', () => {
  test('builds line, team, and role clusters from canonical organization data', () => {
    const base = fixtureCatalog['active-project'].snapshot;
    const agents = [
      agent({ id: 'orchestrator', displayName: '統括者', role: 'orchestrator', roleSummary: 'Coordinate', iconKey: 'network', roleId: 'orchestrator', organizationScope: 'project', organizationParentAgentId: 'user', assignedByAgentId: 'user' }),
      agent({ id: 'user-support', displayName: '利用者支援係', role: 'user-support', roleSummary: 'Support', iconKey: 'user', roleId: 'user-support', organizationScope: 'project', organizationParentAgentId: 'user', assignedByAgentId: 'user' }),
      agent({ id: 'orquesta-admin', displayName: '管理係', role: 'orquesta-admin', roleSummary: 'Admin', iconKey: 'database', roleId: 'orquesta-admin', organizationScope: 'project', organizationParentAgentId: 'user', assignedByAgentId: 'user' }),
      agent({ id: 'implementation-001', displayName: '実装係1', role: 'implementation', roleSummary: 'Desktop implementation', iconKey: 'code', roleId: 'implementation', teamId: 'desktop-implementation', lineId: 'desktop-line', position: 'lead', membershipOrdinal: 1, organizationScope: 'line', lifecycleState: 'active', organizationParentAgentId: 'orchestrator', assignedByAgentId: 'orchestrator' }),
      agent({ id: 'implementation-002', displayName: '実装係2', role: 'implementation', roleSummary: 'Desktop implementation', iconKey: 'code', roleId: 'implementation', teamId: 'desktop-implementation', lineId: 'desktop-line', position: 'member', membershipOrdinal: 2, organizationScope: 'line', lifecycleState: 'retired', organizationParentAgentId: 'implementation-001', assignedByAgentId: 'implementation-001' }),
      agent({ id: 'implementation-004', displayName: '実装係4', role: 'implementation', roleSummary: 'Core implementation', iconKey: 'code', roleId: 'implementation', teamId: 'core-implementation', lineId: 'core-line', position: 'member', membershipOrdinal: 1, organizationScope: 'line', lifecycleState: 'provisioning', organizationParentAgentId: 'orchestrator', assignedByAgentId: 'orchestrator' })
    ];
    const snapshot = {
      ...base,
      agents,
      organization: {
        revision: 12,
        source: 'explicit' as const,
        diagnostics: [],
        lines: [
          { id: 'desktop-line', displayName: 'Desktop', goal: 'Build Desktop', status: 'active', ownerAgentId: 'orchestrator', dedicatedLeadAgentId: 'implementation-001', displayOrder: 1, approvalSource: 'setup_confirmation' },
          { id: 'core-line', displayName: 'Core', goal: 'Build Core', status: 'active', ownerAgentId: 'orchestrator', dedicatedLeadAgentId: null, displayOrder: 2, approvalSource: 'setup_confirmation' }
        ],
        teams: [
          { id: 'desktop-implementation', lineId: 'desktop-line', displayName: 'Desktop 実装', purpose: 'Renderer', lifecycleState: 'active', displayOrder: 1 },
          { id: 'core-implementation', lineId: 'core-line', displayName: 'Core 実装', purpose: 'Core', lifecycleState: 'active', displayOrder: 1 }
        ],
        relationships: agents.filter((item) => item.organizationParentAgentId && item.organizationParentAgentId !== 'user').map((item) => ({ id: `rel-${item.id}`, type: 'reports_to', fromAgentId: item.id, toAgentId: item.organizationParentAgentId! })),
        lineProposals: []
      }
    };

    const projection = buildOrganizationProjection(snapshot);

    expect(projection.source).toBe('explicit');
    expect(projection.revision).toBe(12);
    expect(projection.coreAgentIds).toEqual(['orchestrator', 'user-support', 'orquesta-admin']);
    expect(projection.lines.map((line) => line.id)).toEqual(['desktop-line', 'core-line']);
    expect(projection.lines[0].teams[0].roleClusters).toEqual([
      expect.objectContaining({ roleId: 'implementation', agentIds: ['implementation-001', 'implementation-002'] })
    ]);
    expect(projection.lines[1].teams[0].roleClusters).toEqual([
      expect.objectContaining({ roleId: 'implementation', agentIds: ['implementation-004'] })
    ]);
    expect(projection.unassignedAgentIds).toEqual([]);
    expect(projection.lines.flatMap((line) => line.agentIds).sort()).toEqual([
      'implementation-001', 'implementation-002', 'implementation-004'
    ]);
  });

  test('groups same-role agents by role data instead of display names', () => {
    const agents = ['alpha', 'beta', 'gamma'].map((id, index) => agent({
      id,
      displayName: `Unrelated ${index}`,
      role: `opaque-${index}`,
      roleSummary: 'Opaque display data',
      iconKey: 'code',
      roleId: 'implementation',
      teamId: 'desktop-implementation',
      lineId: 'desktop-line',
      organizationParentAgentId: index === 0 ? 'orchestrator' : 'alpha',
      assignedByAgentId: index === 0 ? 'orchestrator' : 'alpha'
    }));
    const projection = buildOrganizationProjection([
      agent({ id: 'orchestrator', displayName: '統括者', role: 'orchestrator', roleSummary: 'Coordinate', iconKey: 'network', roleId: 'orchestrator', assignedByAgentId: 'user' }),
      ...agents
    ]);

    expect(projection.groups.find((group) => group.id === 'implementation')?.agentIds).toEqual(['alpha', 'beta', 'gamma']);
    expect(projection.parentByAgentId.get('beta')).toBe('alpha');
  });
});
