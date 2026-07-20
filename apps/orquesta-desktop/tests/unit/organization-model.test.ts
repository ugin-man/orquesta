import { describe, expect, test } from 'vitest';
import { agent } from '../../src/fixtures/helpers';
import { buildOrganizationProjection } from '../../src/renderer/features/map/organization';

describe('explicit organization model', () => {
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
