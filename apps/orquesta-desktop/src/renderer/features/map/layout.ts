import type { AgentUiModel } from '../../../contracts/orquesta-ui';
import type { AgentHierarchy, HierarchyParentId } from './hierarchy';
import {
  buildOrganizationProjection,
  type OrganizationProjection,
  type ProductionGroupId
} from './organization';

export interface Point {
  x: number;
  y: number;
}

export type MapEdgeKind = 'spine' | 'admin' | 'support' | 'production' | 'delegation';

export interface MapGroupLayout {
  id: ProductionGroupId;
  agentIds: string[];
  x: number;
  y: number;
  width: number;
  height: number;
  anchor: Point;
}

export interface MapLayout {
  width: number;
  height: number;
  center: Point;
  user: Point;
  agentPositions: Map<string, Point>;
  groups: MapGroupLayout[];
  edges: Array<{
    id: string;
    parentId: HierarchyParentId;
    childId: string;
    from: Point;
    to: Point;
    kind: MapEdgeKind;
  }>;
  hierarchy: AgentHierarchy;
  organization: OrganizationProjection;
  nodeWidth: number;
  nodeHeight: number;
  outerRadius: number;
  compact: boolean;
}

const NODE_WIDTH = 168;
const NODE_HEIGHT = 140;
const HORIZONTAL_GAP = 56;
const LEVEL_GAP = 104;
const ROW_GAP = 68;
const GROUP_PADDING_X = 52;
const GROUP_PADDING_TOP = 92;
const GROUP_PADDING_BOTTOM = 44;
const GROUP_GAP_X = 72;
const GROUP_GAP_Y = 88;
const WORLD_MARGIN_X = 120;
const WORLD_MARGIN_Y = 84;

interface LocalBox {
  width: number;
  height: number;
  positions: Map<string, Point>;
}

interface UnshiftedGroup extends MapGroupLayout {
  positions: Map<string, Point>;
}

function translatePositions(target: Map<string, Point>, source: Map<string, Point>, x: number, y: number) {
  for (const [id, point] of source) target.set(id, { x: point.x + x, y: point.y + y });
}

function rowsForBoxes(boxes: LocalBox[], maxColumns: number): Array<{ boxes: LocalBox[]; width: number; height: number }> {
  const rows: Array<{ boxes: LocalBox[]; width: number; height: number }> = [];
  for (const box of boxes) {
    let row = rows.at(-1);
    if (!row || row.boxes.length >= maxColumns) {
      row = { boxes: [], width: 0, height: 0 };
      rows.push(row);
    }
    row.width = row.boxes.length ? row.width + HORIZONTAL_GAP + box.width : box.width;
    row.height = Math.max(row.height, box.height);
    row.boxes.push(box);
  }
  return rows;
}

function layoutProductionSubtree(agentId: string, organization: OrganizationProjection, allowedIds: Set<string>): LocalBox {
  const children = (organization.childrenByParentId.get(agentId) ?? []).filter((id) => allowedIds.has(id));
  if (!children.length) {
    return {
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      positions: new Map([[agentId, { x: NODE_WIDTH / 2, y: NODE_HEIGHT / 2 }]])
    };
  }

  const childBoxes = children.map((childId) => layoutProductionSubtree(childId, organization, allowedIds));
  const columns = Math.max(1, Math.ceil(Math.sqrt(childBoxes.length * 1.4)));
  const rows = rowsForBoxes(childBoxes, columns);
  const width = Math.max(NODE_WIDTH, ...rows.map((row) => row.width));
  const positions = new Map<string, Point>([[agentId, { x: width / 2, y: NODE_HEIGHT / 2 }]]);
  let y = NODE_HEIGHT + LEVEL_GAP;
  for (const row of rows) {
    let x = (width - row.width) / 2;
    for (const box of row.boxes) {
      translatePositions(positions, box.positions, x, y);
      x += box.width + HORIZONTAL_GAP;
    }
    y += row.height + ROW_GAP;
  }
  return { width, height: y - ROW_GAP, positions };
}

function layoutProductionGroup(group: OrganizationProjection['groups'][number], organization: OrganizationProjection): UnshiftedGroup {
  const allowedIds = new Set(group.agentIds);
  const roots = group.rootAgentIds.length ? group.rootAgentIds : [group.agentIds[0]];
  const rootBoxes = roots.map((rootId) => layoutProductionSubtree(rootId, organization, allowedIds));
  const columns = Math.max(1, Math.ceil(Math.sqrt(rootBoxes.length * 1.35)));
  const rows = rowsForBoxes(rootBoxes, columns);
  const forestWidth = Math.max(NODE_WIDTH, ...rows.map((row) => row.width));
  const positions = new Map<string, Point>();
  let y = GROUP_PADDING_TOP;
  for (const row of rows) {
    let x = GROUP_PADDING_X + (forestWidth - row.width) / 2;
    for (const box of row.boxes) {
      translatePositions(positions, box.positions, x, y);
      x += box.width + HORIZONTAL_GAP;
    }
    y += row.height + ROW_GAP;
  }

  for (const agentId of group.agentIds) {
    if (positions.has(agentId)) continue;
    positions.set(agentId, { x: GROUP_PADDING_X + NODE_WIDTH / 2, y: y + NODE_HEIGHT / 2 });
    y += NODE_HEIGHT + ROW_GAP;
  }

  const width = forestWidth + GROUP_PADDING_X * 2;
  const height = y - ROW_GAP + GROUP_PADDING_BOTTOM;
  return {
    id: group.id,
    agentIds: [...group.agentIds],
    x: 0,
    y: 0,
    width,
    height,
    anchor: { x: width / 2, y: 0 },
    positions
  };
}

function groupRows(groups: UnshiftedGroup[]): Array<{ groups: UnshiftedGroup[]; width: number; height: number }> {
  const columns = groups.length <= 6 ? Math.max(1, groups.length) : 3;
  const rows: Array<{ groups: UnshiftedGroup[]; width: number; height: number }> = [];
  for (const group of groups) {
    let row = rows.at(-1);
    if (!row || row.groups.length >= columns) {
      row = { groups: [], width: 0, height: 0 };
      rows.push(row);
    }
    row.width = row.groups.length ? row.width + GROUP_GAP_X + group.width : group.width;
    row.height = Math.max(row.height, group.height);
    row.groups.push(group);
  }
  return rows;
}

function hierarchyView(organization: OrganizationProjection): AgentHierarchy {
  return {
    rootIds: organization.rootIds,
    parentByAgentId: organization.parentByAgentId,
    childrenByParentId: organization.childrenByParentId,
    depthByAgentId: organization.depthByAgentId,
    diagnostics: organization.diagnostics
  };
}

function translated(point: Point, dx: number, dy: number): Point {
  return { x: point.x + dx, y: point.y + dy };
}

export function groupBoundsForPositions(
  group: MapGroupLayout,
  positions: Map<string, Point>,
  nodeWidth: number,
  nodeHeight: number
): MapGroupLayout {
  const points = group.agentIds.flatMap((agentId) => {
    const point = positions.get(agentId);
    return point ? [point] : [];
  });
  if (!points.length) return group;
  const x = Math.min(...points.map((point) => point.x - nodeWidth / 2)) - GROUP_PADDING_X;
  const y = Math.min(...points.map((point) => point.y - nodeHeight / 2)) - GROUP_PADDING_TOP;
  const right = Math.max(...points.map((point) => point.x + nodeWidth / 2)) + GROUP_PADDING_X;
  const bottom = Math.max(...points.map((point) => point.y + nodeHeight / 2)) + GROUP_PADDING_BOTTOM;
  return { ...group, x, y, width: right - x, height: bottom - y, anchor: { x: (x + right) / 2, y } };
}

export function createStableLayout(agents: AgentUiModel[]): MapLayout {
  const organization = buildOrganizationProjection(agents);
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const productionGroups = organization.groups.map((group) => layoutProductionGroup(group, organization));
  const rows = groupRows(productionGroups);
  const productionWidth = rows.length ? Math.max(...rows.map((row) => row.width)) : NODE_WIDTH;
  const coreX = Math.max(560, productionWidth / 2 + WORLD_MARGIN_X);
  const user: Point = { x: coreX, y: 94 };
  const orchestrator: Point = { x: coreX, y: 500 };
  const productionTop = 1050;
  const agentPositions = new Map<string, Point>();
  if (agentById.has('orchestrator')) agentPositions.set('orchestrator', orchestrator);
  if (agentById.has('orquesta-admin')) agentPositions.set('orquesta-admin', { x: coreX - 310, y: 118 });
  if (agentById.has('user-liaison')) agentPositions.set('user-liaison', { x: coreX + 400, y: 142 });
  if (agentById.has('vision-curator')) agentPositions.set('vision-curator', { x: coreX + 318, y: 340 });
  if (agentById.has('error-concierge')) agentPositions.set('error-concierge', { x: coreX + 518, y: 340 });

  const groups: MapGroupLayout[] = [];
  let groupY = productionTop;
  for (const row of rows) {
    let groupX = coreX - row.width / 2;
    for (const group of row.groups) {
      const positioned: MapGroupLayout = {
        id: group.id,
        agentIds: [...group.agentIds],
        x: groupX,
        y: groupY,
        width: group.width,
        height: group.height,
        anchor: { x: groupX + group.width / 2, y: groupY }
      };
      groups.push(positioned);
      translatePositions(agentPositions, group.positions, groupX, groupY);
      groupX += group.width + GROUP_GAP_X;
    }
    groupY += row.height + GROUP_GAP_Y;
  }

  for (const agent of agents) {
    if (agentPositions.has(agent.id)) continue;
    const index = agentPositions.size;
    agentPositions.set(agent.id, { x: coreX + ((index % 3) - 1) * (NODE_WIDTH + HORIZONTAL_GAP), y: groupY + Math.floor(index / 3) * (NODE_HEIGHT + ROW_GAP) });
  }

  const edges: MapLayout['edges'] = [];
  if (agentById.has('orchestrator')) {
    edges.push({ id: 'spine:user:orchestrator', parentId: 'user', childId: 'orchestrator', from: user, to: orchestrator, kind: 'spine' });
  }
  const adminPoint = agentPositions.get('orquesta-admin');
  if (adminPoint) edges.push({ id: 'admin:user:orquesta-admin', parentId: 'user', childId: 'orquesta-admin', from: user, to: adminPoint, kind: 'admin' });
  const liaisonPoint = agentPositions.get('user-liaison');
  if (liaisonPoint) edges.push({ id: 'support:user:user-liaison', parentId: 'user', childId: 'user-liaison', from: user, to: liaisonPoint, kind: 'support' });
  for (const id of ['vision-curator', 'error-concierge']) {
    const point = agentPositions.get(id);
    if (!point) continue;
    const parentPoint = liaisonPoint ?? user;
    edges.push({ id: `support:${liaisonPoint ? 'user-liaison' : 'user'}:${id}`, parentId: liaisonPoint ? 'user-liaison' : 'user', childId: id, from: parentPoint, to: point, kind: 'support' });
  }
  for (const group of groups) {
    edges.push({ id: `production:orchestrator:${group.id}`, parentId: 'orchestrator', childId: `group:${group.id}`, from: orchestrator, to: group.anchor, kind: 'production' });
    const sourceGroup = organization.groups.find((candidate) => candidate.id === group.id);
    for (const rootAgentId of sourceGroup?.rootAgentIds ?? []) {
      const rootPoint = agentPositions.get(rootAgentId);
      if (!rootPoint) continue;
      edges.push({
        id: `delegation:group:${group.id}:${rootAgentId}`,
        parentId: `group:${group.id}`,
        childId: rootAgentId,
        from: group.anchor,
        to: { x: rootPoint.x, y: rootPoint.y - NODE_HEIGHT / 2 },
        kind: 'delegation'
      });
    }
  }
  for (const [childId, parentId] of organization.parentByAgentId) {
    if (organization.laneByAgentId.get(childId) !== 'production' || parentId === 'user' || parentId === 'orchestrator') continue;
    if (organization.laneByAgentId.get(parentId) !== 'production') continue;
    const from = agentPositions.get(parentId);
    const to = agentPositions.get(childId);
    if (from && to) edges.push({ id: `delegation:${parentId}:${childId}`, parentId, childId, from, to, kind: 'delegation' });
  }

  const nodePoints = [user, ...agentPositions.values()];
  const minNodeX = Math.min(...nodePoints.map((point) => point.x - NODE_WIDTH / 2), ...groups.map((group) => group.x));
  const maxNodeX = Math.max(...nodePoints.map((point) => point.x + NODE_WIDTH / 2), ...groups.map((group) => group.x + group.width));
  const minNodeY = Math.min(...nodePoints.map((point) => point.y - NODE_HEIGHT / 2), ...groups.map((group) => group.y));
  const maxNodeY = Math.max(...nodePoints.map((point) => point.y + NODE_HEIGHT / 2), ...groups.map((group) => group.y + group.height));
  const contentWidth = maxNodeX - minNodeX;
  const contentHeight = maxNodeY - minNodeY;
  const width = Math.max(1200, contentWidth + WORLD_MARGIN_X * 2);
  const height = Math.max(900, contentHeight + WORLD_MARGIN_Y * 2);
  const dx = (width - contentWidth) / 2 - minNodeX;
  const dy = (height - contentHeight) / 2 - minNodeY;

  const shiftedPositions = new Map<string, Point>();
  for (const [id, point] of agentPositions) shiftedPositions.set(id, translated(point, dx, dy));
  const shiftedGroups = groups.map((group) => ({
    ...group,
    x: group.x + dx,
    y: group.y + dy,
    anchor: translated(group.anchor, dx, dy)
  }));
  const shiftedEdges = edges.map((edge) => ({ ...edge, from: translated(edge.from, dx, dy), to: translated(edge.to, dx, dy) }));
  const shiftedUser = translated(user, dx, dy);
  const center = shiftedPositions.get('orchestrator') ?? shiftedPositions.values().next().value ?? shiftedUser;

  return {
    width,
    height,
    center,
    user: shiftedUser,
    agentPositions: shiftedPositions,
    groups: shiftedGroups,
    edges: shiftedEdges,
    hierarchy: hierarchyView(organization),
    organization,
    nodeWidth: NODE_WIDTH,
    nodeHeight: NODE_HEIGHT,
    outerRadius: Math.max(width, height) / 2 - WORLD_MARGIN_X,
    compact: agents.length > 12
  };
}

export function orthogonalPath(from: Point, to: Point, axis: 'vertical' | 'horizontal' = 'vertical'): string {
  if (axis === 'horizontal') {
    const midX = from.x + (to.x - from.x) / 2;
    return `M ${from.x} ${from.y} H ${midX} V ${to.y} H ${to.x}`;
  }
  const midY = from.y + (to.y - from.y) / 2;
  return `M ${from.x} ${from.y} V ${midY} H ${to.x} V ${to.y}`;
}

export const edgePath = orthogonalPath;

export function midpoint(from: Point, to: Point, bias = 0.52): Point {
  return {
    x: from.x + (to.x - from.x) * bias,
    y: from.y + (to.y - from.y) * bias
  };
}

export interface MapNodeLayout {
  agentId: string;
  x: number;
  y: number;
}

export interface LegacyMapLayout {
  nodes: MapNodeLayout[];
  bounds: { x: number; y: number; width: number; height: number };
}

export function taskHasActiveEvidence(task: { turnStarted: boolean; progressObserved: boolean }): boolean {
  return task.turnStarted || task.progressObserved;
}

export function buildMapLayout(agents: AgentUiModel[], _tasks: unknown[]): LegacyMapLayout {
  const layout = createStableLayout(agents);
  return {
    nodes: agents.flatMap((agent) => {
      const point = layout.agentPositions.get(agent.id);
      return point ? [{ agentId: agent.id, x: point.x, y: point.y }] : [];
    }),
    bounds: { x: 0, y: 0, width: layout.width, height: layout.height }
  };
}
