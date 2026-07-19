import type { FixtureDefinition } from './types';
import { agent, fixtureV4Operations, observedAt, phase } from './helpers';

const agents = [
  agent({ id: 'orchestrator', displayName: 'Orchestrator', role: 'Orchestrator', roleSummary: 'Multi-Agent Coordinator', iconKey: 'network', assignedByAgentId: 'user' }),
  ...Array.from({ length: 79 }, (_, index) => {
    const number = String(index + 1).padStart(2, '0');
    return agent({
      id: `wide-agent-${number}`,
      displayName: `Specialist ${number}`,
      role: 'Specialist',
      roleSummary: 'Parallel workstream specialist',
      iconKey: index % 3 === 0 ? 'code' : index % 3 === 1 ? 'search' : 'chart',
      assignedByAgentId: 'orchestrator'
    });
  })
];

export const wideRosterFixture: FixtureDefinition = {
  snapshot: {
    project: {
      id: 'wide-roster', title: 'Wide Roster Simulation', rootPathLabel: '~/projects/wide-roster',
      status: 'ready', connectionLabel: 'Prototype snapshot ready', isDemoData: true, repositoryDisplayState: 'demo', lastSyncedAt: observedAt,
      currentPhaseId: 'wide-phase', agentCount: agents.length, provenWorkingAgentCount: 0,
      summary: 'Eighty individual agents in one wide organization', nextMilestone: 'Wide fit validation'
    },
    agents,
    tasks: [],
    attention: [],
    phases: [phase({ id: 'wide-phase', title: 'Capacity validation', summary: 'Keep eighty agents visible', status: 'current', ownerAgentIds: ['orchestrator'], itemCount: agents.length })],
    recentEvents: [],
    v4Operations: fixtureV4Operations
  },
  conversations: { orchestrator: [] }, attentionHistory: [], agentProposals: [], lastOpenedAt: observedAt
};
