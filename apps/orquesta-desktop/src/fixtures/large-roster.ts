import type { FixtureDefinition } from './types';
import { agent, fixtureV4Operations, observedAt, phase, task } from './helpers';

const roles = ['Analyst', 'Connector', 'Coder', 'Writer', 'Researcher', 'Reviewer', 'Planner', 'Designer', 'Tester', 'Auditor'];
const icons = ['chart', 'database', 'code', 'file', 'search', 'shield', 'route', 'pen', 'flask', 'scan'];
const agents = [agent({ id: 'orchestrator', displayName: 'Orchestrator', role: 'Orchestrator', roleSummary: 'Multi-Agent Coordinator', iconKey: 'network', status: 'working', statusLabel: 'Working', currentTaskId: 'L0', currentTaskTitle: 'Coordinate large roster', assignedByAgentId: 'user' })];
const tasks = [task({ id: 'L0', title: 'Coordinate large roster', state: 'in_progress', ownerAgentId: 'orchestrator', assignedByAgentId: 'user', dispatchAccepted: true, turnStarted: true, progressObserved: true, progressPercent: 25, actualModel: 'gpt-5.6-pro', actualModelEvidence: 'proven' })];
for (let index = 1; index < 35; index += 1) {
  const working = index <= 5;
  const role = roles[(index - 1) % roles.length];
  const id = `agent-${String(index).padStart(2, '0')}`;
  const taskId = working ? `L${index}` : null;
  const assignedByAgentId = index <= 5 ? 'orchestrator' : index <= 14 ? 'agent-01' : index <= 24 ? 'agent-02' : 'agent-15';
  agents.push(agent({
    id, displayName: `${role} ${String(index).padStart(2, '0')}`, role, roleSummary: `${role} specialist`, iconKey: icons[(index - 1) % icons.length],
    status: working ? 'working' : 'standby', statusLabel: working ? 'Working' : 'Idle', currentTaskId: taskId, currentTaskTitle: working ? `Large-roster workstream ${index}` : null,
    assignedByAgentId, expectedArtifact: working ? `Workstream ${index} report` : null
  }));
  if (working) tasks.push(task({ id: taskId!, title: `Large-roster workstream ${index}`, state: 'in_progress', ownerAgentId: id, assignedByAgentId: 'orchestrator', handoffSent: true, dispatchAccepted: true, turnStarted: true, progressObserved: true, progressPercent: index * 11, actualModel: 'gpt-5.4-mini', actualModelEvidence: 'reported', startedAt: observedAt }));
}

export const largeRosterFixture: FixtureDefinition = {
  snapshot: {
    project: { id: 'large-roster', title: 'Large Roster Simulation', rootPathLabel: '~/projects/large-roster', status: 'working', connectionLabel: 'Prototype snapshot ready', isDemoData: true, repositoryDisplayState: 'demo', lastSyncedAt: observedAt, currentPhaseId: 'L-phase', agentCount: 35, provenWorkingAgentCount: 6, summary: 'Thirty-five individual agents; no aggregation', nextMilestone: 'Fit and navigation validation' },
    agents,
    tasks,
    attention: [],
    phases: [phase({ id: 'L-phase', title: 'Capacity test', summary: 'Validate a 35-agent map', status: 'current', ownerAgentIds: ['orchestrator'], itemCount: 35, completedItemCount: 4 })],
    recentEvents: [],
    v4Operations: fixtureV4Operations
  },
  conversations: { orchestrator: [] }, attentionHistory: [], agentProposals: [], lastOpenedAt: observedAt
};
