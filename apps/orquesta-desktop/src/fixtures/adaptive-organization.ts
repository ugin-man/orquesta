import type {
  AgentUiModel,
  OrganizationLineProposalUiModel,
  OrganizationLineUiModel,
  OrganizationTeamUiModel,
  TaskUiModel
} from '../contracts/orquesta-ui';
import { agent, fixtureInspectionTemplates, fixtureV4Operations, observedAt, phase, task } from './helpers';
import type { FixtureDefinition } from './types';

interface AdaptiveFixtureOptions {
  id: string;
  title: string;
  totalAgents: number;
  lineCount: number;
  lifecycleMix?: boolean;
  pendingProposal?: boolean;
}

const roleDefinitions = [
  { id: 'implementation', label: 'Implementation', iconKey: 'code' },
  { id: 'design', label: 'Design', iconKey: 'pen' }
] as const;

function foundationAgents(): AgentUiModel[] {
  return [
    agent({
      id: 'orchestrator', displayName: 'Orchestrator', role: 'Orchestrator', roleSummary: 'Coordinates the complete project', iconKey: 'network',
      status: 'working', statusLabel: 'Working', assignedByAgentId: 'user', roleId: 'orchestrator', organizationScope: 'project',
      organizationParentAgentId: 'user', lifecycleState: 'active', displayOrder: 0
    }),
    agent({
      id: 'user-support', displayName: 'User Support', role: 'User Support', roleSummary: 'Bridges user questions and operational decisions', iconKey: 'user',
      assignedByAgentId: 'user', roleId: 'user-support', organizationScope: 'project', organizationParentAgentId: 'user', lifecycleState: 'active', displayOrder: 1
    }),
    agent({
      id: 'orquesta-admin', displayName: 'Orquesta Admin', role: 'Orquesta Admin', roleSummary: 'Explains project and task state', iconKey: 'database',
      assignedByAgentId: 'user', roleId: 'orquesta-admin', organizationScope: 'project', organizationParentAgentId: 'user', lifecycleState: 'active', displayOrder: 2
    })
  ];
}

function buildAdaptiveFixture(options: AdaptiveFixtureOptions): FixtureDefinition {
  const agents = foundationAgents();
  const lines: OrganizationLineUiModel[] = [];
  const teams: OrganizationTeamUiModel[] = [];
  const teamMemberCount = new Map<string, number>();
  const leadByTeam = new Map<string, string>();
  const specialistCount = Math.max(0, options.totalAgents - agents.length);

  for (let lineIndex = 0; lineIndex < options.lineCount; lineIndex += 1) {
    const lineId = `line-${String(lineIndex + 1).padStart(2, '0')}`;
    lines.push({
      id: lineId,
      displayName: lineIndex === 0 ? 'Desktop line' : lineIndex === 1 ? 'Core line' : `Delivery line ${lineIndex + 1}`,
      goal: `Own independent delivery stream ${lineIndex + 1}`,
      status: 'active',
      ownerAgentId: 'orchestrator',
      dedicatedLeadAgentId: null,
      displayOrder: lineIndex + 1,
      approvalSource: 'fixture'
    });
    roleDefinitions.forEach((role, roleIndex) => teams.push({
      id: `${lineId}-${role.id}`,
      lineId,
      displayName: `${role.label} team`,
      purpose: `${role.label} work for ${lineId}`,
      lifecycleState: 'active',
      displayOrder: roleIndex + 1
    }));
  }

  const lifecycleStates: Array<NonNullable<AgentUiModel['lifecycleState']>> = ['active', 'provisioning', 'retired', 'superseded', 'proposed'];
  for (let index = 0; index < specialistCount; index += 1) {
    const lineIndex = options.lineCount ? index % options.lineCount : 0;
    const role = roleDefinitions[Math.floor(index / Math.max(1, options.lineCount)) % roleDefinitions.length];
    const lineId = `line-${String(lineIndex + 1).padStart(2, '0')}`;
    const teamId = `${lineId}-${role.id}`;
    const ordinal = (teamMemberCount.get(teamId) ?? 0) + 1;
    teamMemberCount.set(teamId, ordinal);
    const id = `${role.id}-${String(lineIndex + 1).padStart(2, '0')}-${String(ordinal).padStart(2, '0')}`;
    const leadId = leadByTeam.get(teamId);
    if (!leadId) leadByTeam.set(teamId, id);
    const working = index < Math.min(8, specialistCount);
    const lifecycleState = options.lifecycleMix ? lifecycleStates[index % lifecycleStates.length] : 'active';
    const currentTaskId = working ? `AT${String(index + 1).padStart(3, '0')}` : null;
    agents.push(agent({
      id,
      displayName: `${role.id === 'implementation' ? 'Coder' : 'Designer'} ${String(ordinal).padStart(2, '0')}`,
      role: role.label,
      roleSummary: `${role.label} specialist`,
      iconKey: role.iconKey,
      roleId: role.id,
      lineId,
      teamId,
      position: 'member',
      membershipOrdinal: ordinal,
      displayOrder: ordinal,
      organizationScope: 'line',
      organizationParentAgentId: leadId ?? 'orchestrator',
      assignedByAgentId: leadId ?? 'orchestrator',
      lifecycleState,
      operationalStatus: options.lifecycleMix && index % lifecycleStates.length === 1 && index % 2 === 1 ? 'provisioning_failed' : 'ready',
      status: working ? 'working' : lifecycleState === 'retired' || lifecycleState === 'superseded' ? 'standby' : 'standby',
      statusLabel: working ? 'Working' : lifecycleState === 'retired' ? 'Retired' : lifecycleState === 'superseded' ? 'Superseded' : 'Idle',
      currentTaskId,
      currentTaskTitle: currentTaskId ? `${role.label} work package ${index + 1}` : null,
      expectedArtifact: currentTaskId ? `${role.label} evidence ${index + 1}` : null
    }));
  }

  for (const item of agents) {
    if (!item.teamId) continue;
    item.position = (teamMemberCount.get(item.teamId) ?? 0) >= 3 && item.membershipOrdinal === 1 ? 'lead' : 'member';
  }
  for (const line of lines) {
    if (lines.length < 2) {
      line.dedicatedLeadAgentId = null;
      continue;
    }
    const lineAgents = agents.filter((item) => item.lineId === line.id);
    line.dedicatedLeadAgentId = lineAgents.find((item) => item.position === 'lead')?.id ?? lineAgents[0]?.id ?? null;
  }

  const tasks: TaskUiModel[] = agents.flatMap((item) => item.currentTaskId ? [task({
    id: item.currentTaskId,
    title: item.currentTaskTitle ?? item.currentTaskId,
    state: 'in_progress',
    ownerAgentId: item.id,
    assignedByAgentId: item.organizationParentAgentId ?? 'orchestrator',
    handoffSent: true,
    dispatchAccepted: true,
    turnStarted: true,
    progressObserved: true,
    progressPercent: 20 + (item.membershipOrdinal ?? 1) * 7,
    startedAt: observedAt
  })] : []);
  const lineProposals: OrganizationLineProposalUiModel[] = options.pendingProposal ? [{
    id: `${options.id}-proposal`,
    lineId: 'line-proposed',
    displayName: 'Mobile line',
    goal: 'Create an independent mobile delivery stream',
    reason: 'The work has a separate release boundary',
    status: 'approval_wait',
    ownerAgentId: 'orchestrator'
  }] : [];

  return {
    snapshot: {
      project: {
        id: options.id,
        title: options.title,
        rootPathLabel: `~/projects/${options.id}`,
        status: 'working',
        connectionLabel: 'Adaptive organization fixture',
        isDemoData: true,
        repositoryDisplayState: 'demo',
        lastSyncedAt: observedAt,
        currentPhaseId: 'adaptive-map',
        agentCount: agents.length,
        provenWorkingAgentCount: agents.filter((item) => item.status === 'working').length,
        summary: `${agents.length} visible agents across ${lines.length} production lines`,
        nextMilestone: 'Adaptive organization map review'
      },
      agents,
      tasks,
      attention: [],
      failures: [],
      phases: [phase({
        id: 'adaptive-map',
        title: 'Adaptive map',
        summary: 'Validate canonical line and team rendering',
        status: 'current',
        ownerAgentIds: ['orchestrator'],
        itemCount: agents.length,
        completedItemCount: 0
      })],
      recentEvents: [],
      v4Operations: fixtureV4Operations,
      inspectionTemplates: fixtureInspectionTemplates,
      inspectionRuns: [],
      organization: {
        revision: 24,
        source: 'explicit',
        diagnostics: [],
        lines,
        teams,
        relationships: agents.flatMap((item) => item.organizationParentAgentId && item.organizationParentAgentId !== 'user' ? [{
          id: `reports:${item.id}:${item.organizationParentAgentId}`,
          type: 'reports_to',
          fromAgentId: item.id,
          toAgentId: item.organizationParentAgentId
        }] : []),
        lineProposals
      }
    },
    conversations: { orchestrator: [] },
    attentionHistory: [],
    agentProposals: [],
    lastOpenedAt: observedAt
  };
}

export const adaptiveFoundationFixture = buildAdaptiveFixture({
  id: 'adaptive-foundation', title: 'Foundation only', totalAgents: 3, lineCount: 0
});
export const adaptiveSingleLineFixture = buildAdaptiveFixture({
  id: 'adaptive-single-line', title: 'Single production line', totalAgents: 9, lineCount: 1
});
export const adaptiveTwoLineFixture = buildAdaptiveFixture({
  id: 'adaptive-two-line', title: 'Two independent production lines', totalAgents: 13, lineCount: 2
});
export const adaptiveLifecycleFixture = buildAdaptiveFixture({
  id: 'adaptive-lifecycle', title: 'Lifecycle and proposal states', totalAgents: 15, lineCount: 2, lifecycleMix: true, pendingProposal: true
});
export const adaptiveThirtyFiveFixture = buildAdaptiveFixture({
  id: 'adaptive-35-roster', title: 'Adaptive 35-agent organization', totalAgents: 35, lineCount: 2, lifecycleMix: true
});
export const adaptiveLargeRosterFixture = buildAdaptiveFixture({
  id: 'adaptive-large-roster', title: 'Adaptive 80-agent organization', totalAgents: 80, lineCount: 4, lifecycleMix: true, pendingProposal: true
});

export const adaptiveFixtureScenarios = {
  foundation: adaptiveFoundationFixture,
  singleLine: adaptiveSingleLineFixture,
  twoLine: adaptiveTwoLineFixture,
  lifecycle: adaptiveLifecycleFixture,
  thirtyFive: adaptiveThirtyFiveFixture,
  large: adaptiveLargeRosterFixture
} as const;
