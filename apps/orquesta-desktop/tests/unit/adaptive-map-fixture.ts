import type { OrquestaUiSnapshot } from '../../src/contracts/orquesta-ui';
import { fixtureCatalog } from '../../src/fixtures';
import { agent, task } from '../../src/fixtures/helpers';

export function adaptiveTwoLineSnapshot(): OrquestaUiSnapshot {
  const base = fixtureCatalog['active-project'].snapshot;
  const agents = [
    agent({ id: 'orchestrator', displayName: '統括者', role: 'orchestrator', roleSummary: 'Coordinate', iconKey: 'network', roleId: 'orchestrator', organizationScope: 'project', organizationParentAgentId: 'user', assignedByAgentId: 'user' }),
    agent({ id: 'user-support', displayName: '利用者支援係', role: 'user-support', roleSummary: 'Support', iconKey: 'user', roleId: 'user-support', organizationScope: 'project', organizationParentAgentId: 'user', assignedByAgentId: 'user' }),
    agent({ id: 'orquesta-admin', displayName: '管理係', role: 'orquesta-admin', roleSummary: 'Admin', iconKey: 'database', roleId: 'orquesta-admin', organizationScope: 'project', organizationParentAgentId: 'user', assignedByAgentId: 'user' }),
    agent({ id: 'implementation-001', displayName: '実装係1', role: 'implementation', roleSummary: 'Desktop', iconKey: 'code', roleId: 'implementation', teamId: 'desktop-implementation', lineId: 'desktop-line', position: 'member', membershipOrdinal: 1, organizationScope: 'line', lifecycleState: 'active', currentTaskId: 'T68', currentTaskTitle: 'Desktop treeを実装する', organizationParentAgentId: 'orchestrator', assignedByAgentId: 'orchestrator' }),
    agent({ id: 'implementation-002', displayName: '実装係2', role: 'implementation', roleSummary: 'Desktop', iconKey: 'code', roleId: 'implementation', teamId: 'desktop-implementation', lineId: 'desktop-line', position: 'member', membershipOrdinal: 2, organizationScope: 'line', lifecycleState: 'retired', organizationParentAgentId: 'implementation-001', assignedByAgentId: 'implementation-001' }),
    agent({ id: 'implementation-004', displayName: '実装係4', role: 'implementation', roleSummary: 'Core', iconKey: 'code', roleId: 'implementation', teamId: 'core-implementation', lineId: 'core-line', position: 'member', membershipOrdinal: 1, organizationScope: 'line', lifecycleState: 'provisioning', currentTaskId: 'T90', currentTaskTitle: 'Core tree契約を実装する', organizationParentAgentId: 'orchestrator', assignedByAgentId: 'orchestrator' })
  ];
  return {
    ...base,
    project: { ...base.project, id: 'adaptive-two-line', title: 'Adaptive two-line project', agentCount: agents.length },
    agents,
    tasks: [
      task({ id: 'T68', title: 'Desktop treeを実装する', state: 'in_progress', ownerAgentId: 'implementation-001', assignedByAgentId: 'orchestrator', turnStarted: true, progressObserved: true }),
      task({ id: 'T90', title: 'Core tree契約を実装する', state: 'assigned', ownerAgentId: 'implementation-004', assignedByAgentId: 'orchestrator', handoffSent: true })
    ],
    organization: {
      revision: 12,
      source: 'explicit',
      diagnostics: [],
      lines: [
        { id: 'desktop-line', displayName: 'Desktop', goal: 'Build Desktop', status: 'active', ownerAgentId: 'orchestrator', dedicatedLeadAgentId: 'implementation-001', displayOrder: 1, approvalSource: 'setup_confirmation' },
        { id: 'core-line', displayName: 'Core', goal: 'Build Core', status: 'active', ownerAgentId: 'orchestrator', dedicatedLeadAgentId: 'implementation-004', displayOrder: 2, approvalSource: 'setup_confirmation' }
      ],
      teams: [
        { id: 'desktop-implementation', lineId: 'desktop-line', displayName: 'Desktop 実装', purpose: 'Renderer', lifecycleState: 'active', displayOrder: 1 },
        { id: 'core-implementation', lineId: 'core-line', displayName: 'Core 実装', purpose: 'Core', lifecycleState: 'active', displayOrder: 1 }
      ],
      relationships: [
        { id: 'R1', type: 'reports_to', fromAgentId: 'implementation-001', toAgentId: 'orchestrator' },
        { id: 'R2', type: 'reports_to', fromAgentId: 'implementation-002', toAgentId: 'implementation-001' },
        { id: 'R3', type: 'reports_to', fromAgentId: 'implementation-004', toAgentId: 'orchestrator' }
      ],
      lineProposals: []
    }
  };
}
