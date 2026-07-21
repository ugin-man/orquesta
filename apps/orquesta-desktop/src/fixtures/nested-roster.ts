import type { FixtureDefinition } from './types';
import { agent, fixtureInspectionTemplates, fixtureV4Operations, observedAt, phase } from './helpers';

const roleAgent = (
  id: string,
  displayName: string,
  role: string,
  assignedByAgentId: string,
  iconKey = 'code'
) => agent({
  id,
  displayName,
  role,
  roleSummary: `${role} team member`,
  iconKey,
  assignedByAgentId
});

const agents = [
  agent({ id: 'orchestrator', displayName: 'Orchestrator', role: 'Orchestrator', roleSummary: 'Multi-Agent Coordinator', iconKey: 'network', assignedByAgentId: 'user' }),
  ...Array.from({ length: 4 }, (_, index) => roleAgent(`implementation-${index + 1}`, `Implementation ${index + 1}`, 'Implementation Specialist', 'orchestrator')),
  roleAgent('design-lead', 'Design Lead', 'Product Designer', 'orchestrator', 'pen'),
  ...Array.from({ length: 3 }, (_, index) => roleAgent(`design-sub-${index + 1}`, `Design Sub-agent ${index + 1}`, 'Design Researcher', 'design-lead', 'search')),
  roleAgent('depth-1', 'Delegation Level 1', 'Research Lead', 'orchestrator', 'route'),
  roleAgent('depth-2', 'Delegation Level 2', 'Researcher', 'depth-1', 'search'),
  roleAgent('depth-3', 'Delegation Level 3', 'Analyst', 'depth-2', 'chart'),
  roleAgent('depth-4', 'Delegation Level 4', 'Reviewer', 'depth-3', 'shield'),
  roleAgent('depth-5', 'Delegation Level 5', 'Verifier', 'depth-4', 'scan'),
  roleAgent('missing-parent', 'Missing Parent', 'Recovery Probe', 'not-installed', 'flask'),
  roleAgent('cycle-a', 'Cycle A', 'Cycle Probe', 'cycle-b', 'route'),
  roleAgent('cycle-b', 'Cycle B', 'Cycle Probe', 'cycle-a', 'route'),
  roleAgent('release-reviewer', 'Release Reviewer', 'Reviewer', 'orchestrator', 'shield')
];

export const nestedRosterFixture: FixtureDefinition = {
  snapshot: {
    project: {
      id: 'nested-roster', title: 'Nested Delegation Simulation', rootPathLabel: '~/projects/nested-roster',
      status: 'ready', connectionLabel: 'Prototype snapshot ready', isDemoData: true, repositoryDisplayState: 'demo', lastSyncedAt: observedAt,
      currentPhaseId: 'nested-phase', agentCount: agents.length, provenWorkingAgentCount: 0,
      summary: 'Deep, repeated, and malformed delegation without hidden agents', nextMilestone: 'Hierarchy recovery validation'
    },
    agents,
    tasks: [],
    attention: [],
    failures: [],
    phases: [phase({ id: 'nested-phase', title: 'Hierarchy validation', summary: 'Keep every nested agent visible', status: 'current', ownerAgentIds: ['orchestrator'], itemCount: agents.length })],
    recentEvents: [],
    v4Operations: fixtureV4Operations,
    inspectionTemplates: fixtureInspectionTemplates,
    inspectionRuns: []
  },
  conversations: { orchestrator: [] }, attentionHistory: [], agentProposals: [], lastOpenedAt: observedAt
};
