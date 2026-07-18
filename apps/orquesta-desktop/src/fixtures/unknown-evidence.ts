import type { FixtureDefinition } from './types';
import { agent, attention, observedAt, phase, task } from './helpers';

export const unknownEvidenceFixture: FixtureDefinition = {
  snapshot: {
    project: {
      id: 'unknown-evidence', title: 'Migration Planning', rootPathLabel: '~/projects/migration', status: 'ready', connectionLabel: 'Snapshot ready · runtime evidence incomplete',
      isDemoData: true, lastSyncedAt: observedAt, currentPhaseId: 'phase-plan', agentCount: 3, provenWorkingAgentCount: 0,
      summary: 'Assigned work is waiting for start evidence', nextMilestone: 'Observe the first runtime turn'
    },
    agents: [
      agent({ id: 'orchestrator', displayName: 'Orchestrator', role: 'Orchestrator', roleSummary: 'Multi-Agent Coordinator', iconKey: 'network', status: 'assigned_waiting', statusLabel: 'Assigned · waiting', currentTaskId: 'U11', currentTaskTitle: 'Coordinate migration planning', assignedByAgentId: 'user', statusEvidence: 'reported' }),
      agent({ id: 'planner', displayName: 'Planner', role: 'Planner', roleSummary: 'Systems Planning', iconKey: 'route', status: 'assigned_waiting', statusLabel: 'Assigned · waiting', currentTaskId: 'U12', currentTaskTitle: 'Prepare migration outline', assignedByAgentId: 'orchestrator', statusEvidence: 'reported', lastEvidenceAt: null, lastHeartbeatAt: null }),
      agent({ id: 'reviewer', displayName: 'Reviewer', role: 'Reviewer', roleSummary: 'QA & Validation', iconKey: 'shield' }),
      agent({ id: 'researcher', displayName: 'Researcher', role: 'Researcher', roleSummary: 'Web & Knowledge', iconKey: 'search' })
    ],
    tasks: [
      task({ id: 'U11', title: 'Coordinate migration planning', state: 'dispatch_accepted', ownerAgentId: 'orchestrator', assignedByAgentId: 'user', handoffSent: true, dispatchAccepted: true, turnStarted: false, progressObserved: false, actualModel: null, actualModelEvidence: 'unknown' }),
      task({ id: 'U12', title: 'Prepare migration outline', state: 'dispatch_accepted', ownerAgentId: 'planner', assignedByAgentId: 'orchestrator', handoffSent: true, dispatchAccepted: true, turnStarted: false, progressObserved: false, recommendedModel: 'gpt-5.6-pro', requestedModel: 'gpt-5.6-pro', actualModel: null, actualModelEvidence: 'unknown', expectedArtifact: 'Migration outline', acceptanceChecks: ['Dependencies are explicit.'] })
    ],
    attention: [attention({ id: 'U-A1', type: 'direction', title: 'Runtime evidence pending', summary: 'Dispatch was accepted, but no turn-start event has been observed.', sourceAgentId: 'orchestrator', taskId: 'U12', priority: 'low', primaryActionLabel: 'Inspect' })],
    phases: [phase({ id: 'phase-plan', title: 'Planning', summary: 'Prepare migration route', status: 'current', ownerAgentIds: ['planner'], itemCount: 4, completedItemCount: 0 })],
    recentEvents: []
  },
  conversations: { orchestrator: [] },
  attentionHistory: [],
  agentProposals: [],
  lastOpenedAt: observedAt
};
