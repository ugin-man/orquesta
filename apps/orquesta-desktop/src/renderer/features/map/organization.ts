import type { AgentUiModel } from '../../../contracts/orquesta-ui';
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

export interface OrganizationProjection {
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

export function buildOrganizationProjection(agents: AgentUiModel[]): OrganizationProjection {
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
