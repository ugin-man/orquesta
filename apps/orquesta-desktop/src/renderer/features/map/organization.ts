import type {
  AgentUiModel,
  OrganizationLineProposalUiModel,
  OrganizationLineUiModel,
  OrganizationTeamUiModel,
  OrquestaUiSnapshot
} from '../../../contracts/orquesta-ui';
import { buildAgentHierarchy, type HierarchyDiagnosticKind, type HierarchyParentId } from './hierarchy';

export const PRODUCTION_GROUP_ORDER = [
  'implementation',
  'design',
  'qa',
  'docs',
  'protocol',
  'research',
  'other'
] as const;

export type ProductionGroupId = typeof PRODUCTION_GROUP_ORDER[number];
export type OrganizationLane = 'authority' | 'utility' | 'support' | 'production';

export interface OrganizationGroup {
  id: ProductionGroupId;
  agentIds: string[];
  rootAgentIds: string[];
}

export interface OrganizationRoleCluster {
  id: string;
  roleId: string;
  agentIds: string[];
}

export interface OrganizationTeamProjection extends OrganizationTeamUiModel {
  agentIds: string[];
  roleClusters: OrganizationRoleCluster[];
  leadAgentId: string | null;
}

export interface OrganizationLineProjection extends OrganizationLineUiModel {
  agentIds: string[];
  teams: OrganizationTeamProjection[];
  responsibleAgentId: string | null;
}

export interface OrganizationProjection {
  source: 'explicit' | 'legacy';
  revision: number;
  coreAgentIds: string[];
  lines: OrganizationLineProjection[];
  lineProposals: OrganizationLineProposalUiModel[];
  unassignedAgentIds: string[];
  sourceDiagnostics: string[];
  rootIds: string[];
  parentByAgentId: Map<string, HierarchyParentId>;
  childrenByParentId: Map<HierarchyParentId, string[]>;
  depthByAgentId: Map<string, number>;
  laneByAgentId: Map<string, OrganizationLane>;
  groupByAgentId: Map<string, ProductionGroupId>;
  groups: OrganizationGroup[];
  diagnostics: Array<{ agentId: string; kind: HierarchyDiagnosticKind }>;
}

const FOUNDATION_IDS = new Set([
  'orchestrator',
  'orquesta-admin',
  'user-support',
  'user-liaison',
  'vision-curator',
  'error-concierge'
]);
const LEGACY_SUPERSEDED_SUPPORT_IDS = new Set(['user-liaison', 'vision-curator', 'error-concierge']);

function signal(agent: AgentUiModel): string {
  return `${agent.roleId ?? ''} ${agent.id} ${agent.role}`.toLowerCase();
}

export function productionGroupFor(agent: AgentUiModel): ProductionGroupId {
  const value = signal(agent);
  if (/implementation|\bbuild\b|\bcoder\b|developer/u.test(value)) return 'implementation';
  if (/dashboard|design|visual|\bui\b|\bux\b|art/u.test(value)) return 'design';
  if (/bootstrap|\bqa\b|quality|review|test/u.test(value)) return 'qa';
  if (/docs|documentation|release|writer|publishing/u.test(value)) return 'docs';
  if (/protocol|architect|schema|specification/u.test(value)) return 'protocol';
  if (/research|scout|acquisition|analysis|analyst/u.test(value)) return 'research';
  return 'other';
}

function laneFor(agent: AgentUiModel): OrganizationLane {
  const roleId = agent.roleId ?? agent.role;
  if (agent.id === 'orchestrator' || roleId === 'orchestrator') return 'authority';
  if (agent.id === 'orquesta-admin' || roleId === 'orquesta-admin') return 'utility';
  if (agent.id === 'user-support' || roleId === 'user-support' || agent.id === 'user-liaison' || agent.id === 'vision-curator' || agent.id === 'error-concierge') return 'support';
  return 'production';
}

function buildLegacyOrganizationProjection(agents: AgentUiModel[]): OrganizationProjection {
  const uniqueAgents: AgentUiModel[] = [];
  const agentById = new Map<string, AgentUiModel>();
  for (const item of agents) {
    if (agentById.has(item.id)) continue;
    agentById.set(item.id, item);
    uniqueAgents.push(item);
  }

  const orderById = new Map(uniqueAgents.map((item, index) => [item.id, index]));
  const base = buildAgentHierarchy(uniqueAgents);
  const hasOrchestrator = agentById.has('orchestrator');
  const parentByAgentId = new Map<string, HierarchyParentId>();
  const laneByAgentId = new Map<string, OrganizationLane>();

  for (const item of uniqueAgents) {
    const lane = laneFor(item);
    laneByAgentId.set(item.id, lane);
    if (item.organizationParentAgentId && (item.organizationParentAgentId === 'user' || agentById.has(item.organizationParentAgentId))) {
      parentByAgentId.set(item.id, item.organizationParentAgentId);
    } else if (item.id === 'orchestrator') {
      parentByAgentId.set(item.id, 'user');
    } else if (item.id === 'orquesta-admin' || item.id === 'user-liaison') {
      parentByAgentId.set(item.id, 'user');
    } else if (item.id === 'vision-curator' || item.id === 'error-concierge') {
      parentByAgentId.set(item.id, agentById.has('user-liaison') ? 'user-liaison' : 'user');
    } else {
      const baseParent = base.parentByAgentId.get(item.id);
      const productionParent = baseParent && baseParent !== 'user' && !FOUNDATION_IDS.has(baseParent) && agentById.has(baseParent)
        ? baseParent
        : null;
      parentByAgentId.set(item.id, productionParent ?? (hasOrchestrator ? 'orchestrator' : 'user'));
    }
  }

  const childrenByParentId = new Map<HierarchyParentId, string[]>([['user', []]]);
  for (const item of uniqueAgents) childrenByParentId.set(item.id, []);
  for (const item of uniqueAgents) {
    const parentId = parentByAgentId.get(item.id) ?? (hasOrchestrator ? 'orchestrator' : 'user');
    const children = childrenByParentId.get(parentId) ?? [];
    children.push(item.id);
    childrenByParentId.set(parentId, children);
  }
  for (const children of childrenByParentId.values()) {
    children.sort((left, right) =>
      (orderById.get(left) ?? Number.MAX_SAFE_INTEGER) - (orderById.get(right) ?? Number.MAX_SAFE_INTEGER)
      || left.localeCompare(right));
  }

  const depthByAgentId = new Map<string, number>();
  const queue = (childrenByParentId.get('user') ?? []).map((agentId) => ({ agentId, depth: 1 }));
  while (queue.length) {
    const current = queue.shift()!;
    if (depthByAgentId.has(current.agentId)) continue;
    depthByAgentId.set(current.agentId, current.depth);
    for (const childId of childrenByParentId.get(current.agentId) ?? []) {
      queue.push({ agentId: childId, depth: current.depth + 1 });
    }
  }

  const groupByAgentId = new Map<string, ProductionGroupId>();
  for (const item of uniqueAgents) {
    if (laneByAgentId.get(item.id) !== 'production') continue;
    let rootId = item.id;
    let parentId = parentByAgentId.get(rootId);
    const visited = new Set<string>([rootId]);
    while (parentId && parentId !== 'user' && parentId !== 'orchestrator' && laneByAgentId.get(parentId) === 'production' && !visited.has(parentId)) {
      rootId = parentId;
      visited.add(parentId);
      parentId = parentByAgentId.get(rootId);
    }
    groupByAgentId.set(item.id, productionGroupFor(agentById.get(rootId) ?? item));
  }

  const groups = PRODUCTION_GROUP_ORDER.flatMap((id) => {
    const agentIds = uniqueAgents.filter((item) => groupByAgentId.get(item.id) === id).map((item) => item.id);
    if (!agentIds.length) return [];
    const roots = agentIds.filter((agentId) => {
      const parentId = parentByAgentId.get(agentId);
      return !parentId || parentId === 'orchestrator' || parentId === 'user' || groupByAgentId.get(parentId) !== id;
    });
    return [{ id, agentIds, rootAgentIds: roots }];
  });

  return {
    source: 'legacy',
    revision: 0,
    coreAgentIds: uniqueAgents.filter((item) => laneByAgentId.get(item.id) !== 'production').map((item) => item.id),
    lines: [],
    lineProposals: [],
    unassignedAgentIds: [],
    sourceDiagnostics: ['legacy_inferred_organization'],
    rootIds: [...(childrenByParentId.get('user') ?? [])],
    parentByAgentId,
    childrenByParentId,
    depthByAgentId,
    laneByAgentId,
    groupByAgentId,
    groups,
    diagnostics: base.diagnostics
  };
}

const CORE_ORDER = new Map([
  ['orchestrator', 0],
  ['user-support', 1],
  ['orquesta-admin', 2]
]);

function orderedAgents(agentIds: string[], agentById: Map<string, AgentUiModel>): string[] {
  return [...agentIds].sort((leftId, rightId) => {
    const left = agentById.get(leftId);
    const right = agentById.get(rightId);
    const leftLead = left?.position === 'lead' ? 0 : 1;
    const rightLead = right?.position === 'lead' ? 0 : 1;
    return leftLead - rightLead
      || (left?.membershipOrdinal ?? Number.MAX_SAFE_INTEGER) - (right?.membershipOrdinal ?? Number.MAX_SAFE_INTEGER)
      || (left?.displayOrder ?? Number.MAX_SAFE_INTEGER) - (right?.displayOrder ?? Number.MAX_SAFE_INTEGER)
      || leftId.localeCompare(rightId);
  });
}

function explicitParentMaps(agents: AgentUiModel[]): Pick<OrganizationProjection, 'rootIds' | 'parentByAgentId' | 'childrenByParentId' | 'depthByAgentId' | 'diagnostics'> {
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const parentByAgentId = new Map<string, HierarchyParentId>();
  const diagnosticByAgentId = new Map<string, HierarchyDiagnosticKind>();
  for (const agent of agents) {
    const candidate = agent.organizationParentAgentId;
    if (candidate === 'user') {
      parentByAgentId.set(agent.id, 'user');
    } else if (candidate && candidate !== agent.id && agentById.has(candidate)) {
      parentByAgentId.set(agent.id, candidate);
    } else {
      parentByAgentId.set(agent.id, 'user');
      if (candidate === agent.id) diagnosticByAgentId.set(agent.id, 'self_parent');
      else if (candidate) diagnosticByAgentId.set(agent.id, 'missing_parent');
    }
  }

  const visitState = new Map<string, 'visiting' | 'visited'>();
  const stack: string[] = [];
  const cycleAgentIds = new Set<string>();
  const visit = (agentId: string) => {
    if (visitState.get(agentId) === 'visited') return;
    if (visitState.get(agentId) === 'visiting') {
      const cycleStart = stack.lastIndexOf(agentId);
      for (const cycleId of stack.slice(Math.max(0, cycleStart))) cycleAgentIds.add(cycleId);
      return;
    }
    visitState.set(agentId, 'visiting');
    stack.push(agentId);
    const parentId = parentByAgentId.get(agentId);
    if (parentId && parentId !== 'user') visit(parentId);
    stack.pop();
    visitState.set(agentId, 'visited');
  };
  for (const agent of agents) visit(agent.id);
  for (const agentId of cycleAgentIds) {
    parentByAgentId.set(agentId, 'user');
    diagnosticByAgentId.set(agentId, 'cycle');
  }

  const childrenByParentId = new Map<HierarchyParentId, string[]>([['user', []]]);
  for (const agent of agents) childrenByParentId.set(agent.id, []);
  for (const [agentId, parentId] of parentByAgentId) {
    const children = childrenByParentId.get(parentId) ?? [];
    children.push(agentId);
    childrenByParentId.set(parentId, children);
  }
  for (const children of childrenByParentId.values()) children.sort((left, right) => left.localeCompare(right));

  const depthByAgentId = new Map<string, number>();
  const queue = (childrenByParentId.get('user') ?? []).map((agentId) => ({ agentId, depth: 1 }));
  while (queue.length) {
    const current = queue.shift()!;
    if (depthByAgentId.has(current.agentId)) continue;
    depthByAgentId.set(current.agentId, current.depth);
    for (const childId of childrenByParentId.get(current.agentId) ?? []) queue.push({ agentId: childId, depth: current.depth + 1 });
  }

  return {
    rootIds: [...(childrenByParentId.get('user') ?? [])],
    parentByAgentId,
    childrenByParentId,
    depthByAgentId,
    diagnostics: agents.flatMap((agent) => {
      const kind = diagnosticByAgentId.get(agent.id);
      return kind ? [{ agentId: agent.id, kind }] : [];
    })
  };
}

function buildExplicitOrganizationProjection(snapshot: OrquestaUiSnapshot): OrganizationProjection {
  const organization = snapshot.organization!;
  const uniqueAgents = snapshot.agents.filter((agent, index, agents) => (
    !(agent.lifecycleState === 'superseded' && LEGACY_SUPERSEDED_SUPPORT_IDS.has(agent.id))
    && agents.findIndex((candidate) => candidate.id === agent.id) === index
  ));
  const agentById = new Map(uniqueAgents.map((agent) => [agent.id, agent]));
  const hierarchy = explicitParentMaps(uniqueAgents);
  const laneByAgentId = new Map<string, OrganizationLane>();
  const coreAgentIds = uniqueAgents
    .filter((agent) => agent.organizationScope === 'project' || (!agent.lineId && CORE_ORDER.has(agent.roleId ?? agent.id)))
    .sort((left, right) => (CORE_ORDER.get(left.roleId ?? left.id) ?? 100) - (CORE_ORDER.get(right.roleId ?? right.id) ?? 100)
      || (left.displayOrder ?? Number.MAX_SAFE_INTEGER) - (right.displayOrder ?? Number.MAX_SAFE_INTEGER)
      || left.id.localeCompare(right.id))
    .map((agent) => agent.id);
  const coreSet = new Set(coreAgentIds);
  for (const agent of uniqueAgents) {
    const roleId = agent.roleId ?? agent.id;
    const lane: OrganizationLane = roleId === 'orchestrator'
      ? 'authority'
      : roleId === 'orquesta-admin'
        ? 'utility'
        : coreSet.has(agent.id)
          ? 'support'
          : 'production';
    laneByAgentId.set(agent.id, lane);
  }

  const leadershipDiagnostics: string[] = [];
  const activeLineCount = organization.lines.filter((line) => line.status === 'active').length;
  const lines = [...organization.lines]
    .sort((left, right) => left.displayOrder - right.displayOrder || left.id.localeCompare(right.id))
    .map((line): OrganizationLineProjection => {
      const teams = organization.teams
        .filter((team) => team.lineId === line.id)
        .sort((left, right) => left.displayOrder - right.displayOrder || left.id.localeCompare(right.id))
        .map((team): OrganizationTeamProjection => {
          const teamAgentIds = orderedAgents(
            uniqueAgents.filter((agent) => agent.teamId === team.id && agent.lineId === line.id).map((agent) => agent.id),
            agentById
          );
          const roleIds = [...new Set(teamAgentIds.map((agentId) => agentById.get(agentId)?.roleId ?? agentById.get(agentId)?.role ?? 'specialist'))];
           const roleClusters = roleIds.map((roleId): OrganizationRoleCluster => ({
            id: `${team.id}:${roleId}`,
            roleId,
            agentIds: teamAgentIds.filter((agentId) => (agentById.get(agentId)?.roleId ?? agentById.get(agentId)?.role ?? 'specialist') === roleId)
           }));
          const leadIds = teamAgentIds.filter((agentId) => agentById.get(agentId)?.position === 'lead');
          const requiredLeadCount = team.lifecycleState === 'active' && teamAgentIds.length >= 3 ? 1 : 0;
          const leadAgentId = leadIds.length === requiredLeadCount && requiredLeadCount === 1 ? leadIds[0] : null;
          if (leadIds.length !== requiredLeadCount) leadershipDiagnostics.push(`invalid_team_lead:${team.id}:expected_${requiredLeadCount}:found_${leadIds.length}`);
          return { ...team, agentIds: teamAgentIds, roleClusters, leadAgentId };
        });
      const agentIds = teams.flatMap((team) => team.agentIds);
      const responsibleAgentId = line.dedicatedLeadAgentId && agentIds.includes(line.dedicatedLeadAgentId)
        ? line.dedicatedLeadAgentId
        : null;
      if (line.dedicatedLeadAgentId && !responsibleAgentId) leadershipDiagnostics.push(`invalid_line_lead:${line.id}:${line.dedicatedLeadAgentId}`);
      if (activeLineCount >= 2 && line.status === 'active' && agentIds.length > 0 && !responsibleAgentId) leadershipDiagnostics.push(`missing_line_lead:${line.id}`);
      return { ...line, teams, agentIds, responsibleAgentId };
    });
  const placedIds = new Set([...coreAgentIds, ...lines.flatMap((line) => line.agentIds)]);
  const unassignedAgentIds = uniqueAgents.filter((agent) => !placedIds.has(agent.id)).map((agent) => agent.id);
  const lineIds = new Set(organization.lines.map((line) => line.id));
  const teamById = new Map(organization.teams.map((team) => [team.id, team]));
  const membershipDiagnostics = uniqueAgents.flatMap((agent) => {
    if (!unassignedAgentIds.includes(agent.id)) return [];
    if (agent.lineId && !lineIds.has(agent.lineId)) return [`missing_line:${agent.id}:${agent.lineId}`];
    if (agent.teamId && !teamById.has(agent.teamId)) return [`missing_team:${agent.id}:${agent.teamId}`];
    const team = agent.teamId ? teamById.get(agent.teamId) : undefined;
    if (team && team.lineId !== agent.lineId) return [`team_line_mismatch:${agent.id}:${agent.teamId}:${agent.lineId ?? 'none'}`];
    return [`unassigned_agent:${agent.id}`];
  });
  const teamDiagnostics = organization.teams.flatMap((team) => team.lineId && !lineIds.has(team.lineId)
    ? [`team_missing_line:${team.id}:${team.lineId}`]
    : []);

  return {
    source: 'explicit',
    revision: organization.revision,
    coreAgentIds,
    lines,
    lineProposals: [...organization.lineProposals],
    unassignedAgentIds,
    sourceDiagnostics: [...organization.diagnostics, ...teamDiagnostics, ...membershipDiagnostics, ...leadershipDiagnostics],
    ...hierarchy,
    laneByAgentId,
    groupByAgentId: new Map(),
    groups: []
  };
}

export function buildOrganizationProjection(input: AgentUiModel[] | OrquestaUiSnapshot): OrganizationProjection {
  if (Array.isArray(input)) return buildLegacyOrganizationProjection(input);
  if (input.organization?.source === 'explicit') return buildExplicitOrganizationProjection(input);
  const legacy = buildLegacyOrganizationProjection(input.agents);
  return {
    ...legacy,
    revision: input.organization?.revision ?? 0,
    sourceDiagnostics: input.organization?.diagnostics ?? legacy.sourceDiagnostics,
    lineProposals: input.organization?.lineProposals ?? []
  };
}
