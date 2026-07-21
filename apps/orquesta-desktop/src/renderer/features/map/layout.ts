import type { AgentUiModel, OrquestaUiSnapshot } from '../../../contracts/orquesta-ui';
import type { AgentHierarchy, HierarchyParentId } from './hierarchy';
import {
  buildOrganizationProjection,
  type OrganizationLineProjection,
  type OrganizationProjection,
  type OrganizationTeamProjection,
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

export interface MapRegionLayout {
  id: string;
  kind: 'line' | 'team' | 'role' | 'proposal' | 'diagnostic';
  parentId: string | null;
  label: string;
  meta?: string;
  agentIds: string[];
  x: number;
  y: number;
  width: number;
  height: number;
  headerHeight: number;
  inputPort: Point;
  responsibleAgentId?: string | null;
}

export interface MapLineLayout extends MapRegionLayout {
  kind: 'line';
  teamIds: string[];
  ownerAgentId: string;
  dedicatedLeadAgentId: string | null;
  responsibleAgentId: string | null;
}

export interface MapLayout {
  width: number;
  height: number;
  center: Point;
  user: Point;
  agentPositions: Map<string, Point>;
  groups: MapGroupLayout[];
  regions: MapRegionLayout[];
  lines: MapLineLayout[];
  edges: Array<{
    id: string;
    parentId: HierarchyParentId;
    childId: string;
    from: Point;
    to: Point;
    kind: MapEdgeKind;
    lineId?: string;
    teamId?: string;
    responsibleAgentId?: string;
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

function createLegacyLayout(agents: AgentUiModel[]): MapLayout {
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
    regions: [],
    lines: [],
    edges: shiftedEdges,
    hierarchy: hierarchyView(organization),
    organization,
    nodeWidth: NODE_WIDTH,
    nodeHeight: NODE_HEIGHT,
    outerRadius: Math.max(width, height) / 2 - WORLD_MARGIN_X,
    compact: shiftedPositions.size > 12
  };
}

interface LocalAdaptiveLayout {
  width: number;
  height: number;
  positions: Map<string, Point>;
  regions: MapRegionLayout[];
}

interface LocalLineLayout extends LocalAdaptiveLayout {
  line: OrganizationLineProjection;
}

const ADAPTIVE_HEADER_HEIGHT = 58;
const ADAPTIVE_PADDING_X = 36;
const ADAPTIVE_PADDING_BOTTOM = 36;
const ADAPTIVE_REGION_GAP = 34;
const ADAPTIVE_LINE_GAP_X = 92;
const ADAPTIVE_LINE_GAP_Y = 96;

function translateRegion(region: MapRegionLayout, dx: number, dy: number): MapRegionLayout {
  return {
    ...region,
    x: region.x + dx,
    y: region.y + dy,
    inputPort: translated(region.inputPort, dx, dy)
  };
}

function layoutRoleCluster(team: OrganizationTeamProjection, cluster: OrganizationTeamProjection['roleClusters'][number]): LocalAdaptiveLayout {
  const columns = Math.max(1, Math.round(Math.sqrt(cluster.agentIds.length)));
  const rows = Math.max(1, Math.ceil(cluster.agentIds.length / columns));
  const width = columns * NODE_WIDTH + Math.max(0, columns - 1) * HORIZONTAL_GAP;
  const roleHeaderHeight = team.roleClusters.length > 1 ? 32 : 0;
  const height = roleHeaderHeight + rows * NODE_HEIGHT + Math.max(0, rows - 1) * ROW_GAP;
  const positions = new Map<string, Point>();
  cluster.agentIds.forEach((agentId, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    positions.set(agentId, {
      x: NODE_WIDTH / 2 + column * (NODE_WIDTH + HORIZONTAL_GAP),
      y: roleHeaderHeight + NODE_HEIGHT / 2 + row * (NODE_HEIGHT + ROW_GAP)
    });
  });
  return {
    width,
    height,
    positions,
    regions: [{
      id: `role:${cluster.id}`,
      kind: 'role',
      parentId: `team:${team.id}`,
      label: cluster.roleId,
      agentIds: [...cluster.agentIds],
      x: 0,
      y: 0,
      width,
      height,
      headerHeight: roleHeaderHeight,
      inputPort: { x: width / 2, y: 0 }
    }]
  };
}

function layoutAdaptiveTeam(team: OrganizationTeamProjection): LocalAdaptiveLayout {
  if (team.agentIds.length < 3) {
    const width = team.agentIds.length > 0
      ? team.agentIds.length * NODE_WIDTH + Math.max(0, team.agentIds.length - 1) * HORIZONTAL_GAP
      : 0;
    const height = team.agentIds.length > 0 ? NODE_HEIGHT : 0;
    const positions = new Map<string, Point>();
    team.agentIds.forEach((agentId, index) => positions.set(agentId, {
      x: NODE_WIDTH / 2 + index * (NODE_WIDTH + HORIZONTAL_GAP),
      y: NODE_HEIGHT / 2
    }));
    return {
      width,
      height,
      positions,
      regions: [{
        id: `team:${team.id}`,
        kind: 'team',
        parentId: team.lineId ? `line:${team.lineId}` : null,
        label: team.displayName,
        agentIds: [...team.agentIds],
        x: 0,
        y: 0,
        width,
        height,
        headerHeight: 0,
        inputPort: { x: width / 2, y: 0 },
        responsibleAgentId: null
      }]
    };
  }
  const clusterLayouts = team.roleClusters.map((cluster) => layoutRoleCluster(team, cluster));
  const contentWidth = Math.max(NODE_WIDTH, ...clusterLayouts.map((layout) => layout.width));
  const positions = new Map<string, Point>();
  const regions: MapRegionLayout[] = [];
  let y = ADAPTIVE_HEADER_HEIGHT + ADAPTIVE_REGION_GAP;
  for (const clusterLayout of clusterLayouts) {
    const x = ADAPTIVE_PADDING_X + (contentWidth - clusterLayout.width) / 2;
    translatePositions(positions, clusterLayout.positions, x, y);
    regions.push(...clusterLayout.regions.map((region) => translateRegion(region, x, y)));
    y += clusterLayout.height + ADAPTIVE_REGION_GAP;
  }
  if (!clusterLayouts.length) y += NODE_HEIGHT;
  const width = contentWidth + ADAPTIVE_PADDING_X * 2;
  const height = y - ADAPTIVE_REGION_GAP + ADAPTIVE_PADDING_BOTTOM;
  regions.unshift({
    id: `team:${team.id}`,
    kind: 'team',
    parentId: team.lineId ? `line:${team.lineId}` : null,
    label: team.displayName,
    agentIds: [...team.agentIds],
    x: 0,
    y: 0,
    width,
    height,
    headerHeight: ADAPTIVE_HEADER_HEIGHT,
    inputPort: { x: width / 2, y: 0 },
    responsibleAgentId: team.leadAgentId
  });
  return { width, height, positions, regions };
}

function layoutAdaptiveLine(line: OrganizationLineProjection): LocalLineLayout {
  const teamLayouts = line.teams.map((team) => layoutAdaptiveTeam(team));
  const columns = teamLayouts.length <= 1 ? 1 : Math.min(2, Math.ceil(Math.sqrt(teamLayouts.length)));
  const rows: Array<{ layouts: LocalAdaptiveLayout[]; width: number; height: number }> = [];
  for (const layout of teamLayouts) {
    let row = rows.at(-1);
    if (!row || row.layouts.length >= columns) {
      row = { layouts: [], width: 0, height: 0 };
      rows.push(row);
    }
    row.width = row.layouts.length ? row.width + ADAPTIVE_REGION_GAP + layout.width : layout.width;
    row.height = Math.max(row.height, layout.height);
    row.layouts.push(layout);
  }
  const contentWidth = Math.max(0, ...rows.map((row) => row.width));
  const positions = new Map<string, Point>();
  const regions: MapRegionLayout[] = [];
  let y = 0;
  for (const row of rows) {
    let x = (contentWidth - row.width) / 2;
    for (const teamLayout of row.layouts) {
      translatePositions(positions, teamLayout.positions, x, y);
      regions.push(...teamLayout.regions.map((region) => translateRegion(region, x, y)));
      x += teamLayout.width + ADAPTIVE_REGION_GAP;
    }
    y += row.height + ADAPTIVE_REGION_GAP;
  }
  const width = contentWidth;
  const height = rows.length ? y - ADAPTIVE_REGION_GAP : 0;
  return { line, width, height, positions, regions };
}

function createAdaptiveLayout(snapshot: OrquestaUiSnapshot): MapLayout {
  const agents = snapshot.agents;
  const organization = buildOrganizationProjection(snapshot);
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const localLines = organization.lines.map(layoutAdaptiveLine);
  const columns = localLines.length <= 1 ? 1 : localLines.length === 2 ? 2 : Math.ceil(Math.sqrt(localLines.length));
  const lineRows: Array<{ lines: LocalLineLayout[]; width: number; height: number }> = [];
  for (const line of localLines) {
    let row = lineRows.at(-1);
    if (!row || row.lines.length >= columns) {
      row = { lines: [], width: 0, height: 0 };
      lineRows.push(row);
    }
    row.width = row.lines.length ? row.width + ADAPTIVE_LINE_GAP_X + line.width : line.width;
    row.height = Math.max(row.height, line.height);
    row.lines.push(line);
  }

  const productionWidth = lineRows.length ? Math.max(...lineRows.map((row) => row.width)) : NODE_WIDTH * 3;
  const coreX = Math.max(640, productionWidth / 2 + WORLD_MARGIN_X);
  const user: Point = { x: coreX, y: 100 };
  const agentPositions = new Map<string, Point>();
  const orchestratorId = organization.coreAgentIds.find((agentId) => agentById.get(agentId)?.roleId === 'orchestrator' || agentId === 'orchestrator');
  if (orchestratorId) agentPositions.set(orchestratorId, { x: coreX, y: 430 });
  const satelliteIds = organization.coreAgentIds.filter((agentId) => agentId !== orchestratorId);
  satelliteIds.forEach((agentId, index) => {
    const direction = index % 2 === 0 ? -1 : 1;
    const distance = 260 + Math.floor(index / 2) * 190;
    agentPositions.set(agentId, { x: coreX + direction * distance, y: 240 + Math.floor(index / 4) * 170 });
  });

  const regions: MapRegionLayout[] = [];
  const lines: MapLineLayout[] = [];
  const productionTop = 760;
  let lineY = productionTop;
  for (const row of lineRows) {
    let lineX = coreX - row.width / 2;
    for (const local of row.lines) {
      translatePositions(agentPositions, local.positions, lineX, lineY);
      const lineRegion: MapLineLayout = {
        id: local.line.id,
        kind: 'line',
        parentId: null,
        label: local.line.displayName,
        meta: local.line.dedicatedLeadAgentId
          ? `${local.line.status} · Lead ${agentById.get(local.line.dedicatedLeadAgentId)?.displayName ?? local.line.dedicatedLeadAgentId}`
          : `${local.line.status} · Owner ${agentById.get(local.line.ownerAgentId)?.displayName ?? local.line.ownerAgentId}`,
        agentIds: [...local.line.agentIds],
        teamIds: local.line.teams.map((team) => team.id),
        ownerAgentId: local.line.ownerAgentId,
        dedicatedLeadAgentId: local.line.dedicatedLeadAgentId,
        responsibleAgentId: local.line.responsibleAgentId,
        x: lineX,
        y: lineY,
        width: local.width,
        height: local.height,
        headerHeight: 0,
        inputPort: { x: lineX + local.width / 2, y: lineY }
      };
      lines.push(lineRegion);
      regions.push(lineRegion, ...local.regions.map((region) => translateRegion(region, lineX, lineY)));
      lineX += local.width + ADAPTIVE_LINE_GAP_X;
    }
    lineY += row.height + ADAPTIVE_LINE_GAP_Y;
  }

  const proposalWidth = 300;
  const proposalHeight = 108;
  const proposalX = coreX + productionWidth / 2 + ADAPTIVE_LINE_GAP_X;
  organization.lineProposals.forEach((proposal, index) => {
    const y = productionTop + index * (proposalHeight + ADAPTIVE_REGION_GAP);
    regions.push({
      id: `proposal:${proposal.id}`,
      kind: 'proposal',
      parentId: null,
      label: proposal.displayName,
      agentIds: [],
      x: proposalX,
      y,
      width: proposalWidth,
      height: proposalHeight,
      headerHeight: 42,
      inputPort: { x: proposalX + proposalWidth / 2, y }
    });
  });

  if (organization.unassignedAgentIds.length) {
    const diagnosticY = lineY + ADAPTIVE_REGION_GAP;
    const columns = Math.max(1, Math.ceil(Math.sqrt(organization.unassignedAgentIds.length * 1.4)));
    const rows = Math.ceil(organization.unassignedAgentIds.length / columns);
    const diagnosticWidth = columns * NODE_WIDTH + Math.max(0, columns - 1) * HORIZONTAL_GAP + ADAPTIVE_PADDING_X * 2;
    const diagnosticHeight = ADAPTIVE_HEADER_HEIGHT + ADAPTIVE_REGION_GAP + rows * NODE_HEIGHT + Math.max(0, rows - 1) * ROW_GAP + ADAPTIVE_PADDING_BOTTOM;
    const diagnosticX = coreX - diagnosticWidth / 2;
    organization.unassignedAgentIds.forEach((agentId, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      agentPositions.set(agentId, {
        x: diagnosticX + ADAPTIVE_PADDING_X + NODE_WIDTH / 2 + column * (NODE_WIDTH + HORIZONTAL_GAP),
        y: diagnosticY + ADAPTIVE_HEADER_HEIGHT + ADAPTIVE_REGION_GAP + NODE_HEIGHT / 2 + row * (NODE_HEIGHT + ROW_GAP)
      });
    });
    regions.push({
      id: 'diagnostic:unassigned',
      kind: 'diagnostic',
      parentId: null,
      label: 'Organization issues',
      agentIds: [...organization.unassignedAgentIds],
      x: diagnosticX,
      y: diagnosticY,
      width: diagnosticWidth,
      height: diagnosticHeight,
      headerHeight: ADAPTIVE_HEADER_HEIGHT,
      inputPort: { x: coreX, y: diagnosticY }
    });
  }

  const edges: MapLayout['edges'] = [];
  for (const coreAgentId of organization.coreAgentIds) {
    const point = agentPositions.get(coreAgentId);
    if (!point) continue;
    const parentId = organization.parentByAgentId.get(coreAgentId) ?? 'user';
    const parentPoint = parentId === 'user' ? user : agentPositions.get(parentId);
    if (!parentPoint) continue;
    edges.push({
      id: `core:${parentId}:${coreAgentId}`,
      parentId,
      childId: coreAgentId,
      from: parentPoint,
      to: point,
      kind: coreAgentId === orchestratorId ? 'spine' : coreAgentId === 'orquesta-admin' ? 'admin' : 'support'
    });
  }
  for (const line of lines) {
    const owner = agentPositions.get(line.ownerAgentId) ?? (orchestratorId ? agentPositions.get(orchestratorId) : undefined) ?? user;
    const responsible = line.responsibleAgentId ? agentPositions.get(line.responsibleAgentId) : undefined;
    const teamAnchors = line.teamIds.flatMap((teamId) => {
      const teamRegion = regions.find((region) => region.id === `team:${teamId}`);
      const agentId = teamRegion?.responsibleAgentId ?? teamRegion?.agentIds[0];
      const point = agentId ? agentPositions.get(agentId) : undefined;
      return teamRegion && agentId && point ? [{ teamId, agentId, point }] : [];
    });
    if (!responsible || !line.responsibleAgentId) {
      for (const team of teamAnchors) {
        edges.push({
          id: `team:${line.id}:${team.teamId}`,
          parentId: line.ownerAgentId,
          childId: team.agentId,
          from: owner,
          to: team.point,
          kind: 'production',
          lineId: line.id,
          teamId: team.teamId,
          responsibleAgentId: team.agentId
        });
      }
      continue;
    }
    edges.push({
      id: `line:${line.ownerAgentId}:${line.id}`,
      parentId: line.ownerAgentId,
      childId: line.responsibleAgentId,
      from: owner,
      to: responsible,
      kind: 'production',
      lineId: line.id,
      responsibleAgentId: line.responsibleAgentId
    });
    for (const team of teamAnchors) {
      if (team.agentId === line.responsibleAgentId) continue;
      edges.push({
        id: `team:${line.id}:${team.teamId}`,
        parentId: line.responsibleAgentId,
        childId: team.agentId,
        from: responsible,
        to: team.point,
        kind: 'production',
        lineId: line.id,
        teamId: team.teamId,
        responsibleAgentId: team.agentId
      });
    }
  }
  for (const [childId, parentId] of organization.parentByAgentId) {
    if (parentId === 'user' || parentId === orchestratorId) continue;
    const child = agentById.get(childId);
    const parent = agentById.get(parentId);
    if (!child?.lineId || child.lineId !== parent?.lineId) continue;
    const from = agentPositions.get(parentId);
    const to = agentPositions.get(childId);
    if (from && to) edges.push({ id: `reports:${parentId}:${childId}`, parentId, childId, from, to, kind: 'delegation' });
  }

  const nodePoints = [user, ...agentPositions.values()];
  const minNodeX = Math.min(...nodePoints.map((point) => point.x - NODE_WIDTH / 2), ...regions.map((region) => region.x));
  const maxNodeX = Math.max(...nodePoints.map((point) => point.x + NODE_WIDTH / 2), ...regions.map((region) => region.x + region.width));
  const minNodeY = Math.min(...nodePoints.map((point) => point.y - NODE_HEIGHT / 2), ...regions.map((region) => region.y));
  const maxNodeY = Math.max(...nodePoints.map((point) => point.y + NODE_HEIGHT / 2), ...regions.map((region) => region.y + region.height));
  const contentWidth = maxNodeX - minNodeX;
  const contentHeight = maxNodeY - minNodeY;
  const width = Math.max(1200, contentWidth + WORLD_MARGIN_X * 2);
  const height = Math.max(900, contentHeight + WORLD_MARGIN_Y * 2);
  const dx = (width - contentWidth) / 2 - minNodeX;
  const dy = (height - contentHeight) / 2 - minNodeY;
  const shiftedPositions = new Map<string, Point>();
  for (const [id, point] of agentPositions) shiftedPositions.set(id, translated(point, dx, dy));
  const shiftedRegions = regions.map((region) => translateRegion(region, dx, dy));
  const shiftedLines = lines.map((line) => translateRegion(line, dx, dy) as MapLineLayout);
  const shiftedEdges = edges.map((edge) => ({ ...edge, from: translated(edge.from, dx, dy), to: translated(edge.to, dx, dy) }));
  const shiftedUser = translated(user, dx, dy);
  const center = (orchestratorId ? shiftedPositions.get(orchestratorId) : undefined) ?? shiftedUser;

  return {
    width,
    height,
    center,
    user: shiftedUser,
    agentPositions: shiftedPositions,
    groups: [],
    regions: shiftedRegions,
    lines: shiftedLines,
    edges: shiftedEdges,
    hierarchy: hierarchyView(organization),
    organization,
    nodeWidth: NODE_WIDTH,
    nodeHeight: NODE_HEIGHT,
    outerRadius: Math.max(width, height) / 2 - WORLD_MARGIN_X,
    compact: shiftedPositions.size > 12
  };
}

export function createStableLayout(input: AgentUiModel[] | OrquestaUiSnapshot): MapLayout {
  if (Array.isArray(input)) return createLegacyLayout(input);
  return input.organization?.source === 'explicit' ? createAdaptiveLayout(input) : createLegacyLayout(input.agents);
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
