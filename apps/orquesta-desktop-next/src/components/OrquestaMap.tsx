import { Bot, Focus, GitBranch, LifeBuoy, Network, Orbit, RotateCcw, Search, UserRound, ZoomIn, ZoomOut } from 'lucide-react';
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import type { AgentSummary, ProjectParticipantSummary, TaskSummary, WorkspaceSnapshot } from '../domain/models';
import { selectCurrentUserOrchestratorId } from '../application/selectors';
import { agentStatusCopy } from '../presentation/user-copy';

interface OrquestaMapProps {
  snapshot: WorkspaceSnapshot;
  selectedAgentId: string | null;
  onSelectAgent(agentId: string): void;
  locale: 'ja' | 'en';
  sessionState?: OrquestaMapSessionState;
  onSessionStateChange?(state: OrquestaMapSessionState): void;
}

interface Point { x: number; y: number }
interface MapBounds extends Point { width: number; height: number }
type ManualPositions = Record<string, Point>;
export type MapLayoutMode = 'tree' | 'radial';
type ManualPositionsByMode = Record<MapLayoutMode, ManualPositions>;

export interface OrquestaMapSessionState {
  layoutMode: MapLayoutMode;
  manualPositionsByMode: ManualPositionsByMode;
}

interface SafeHierarchy {
  parentById: Map<string, string | null>;
  children: Map<string, AgentSummary[]>;
  roots: AgentSummary[];
  depthById: Map<string, number>;
}

export interface TreeClusterSlot extends Point {
  row: number;
}

export interface MapAgentNode {
  agent: AgentSummary;
  task: TaskSummary | null;
  modelLabel: string;
  x: number;
  y: number;
  depth: number;
  active: boolean;
}

export interface MapHumanNode {
  id: string;
  participant: ProjectParticipantSummary;
  x: number;
  y: number;
}

export interface MapLineRegion {
  id: string;
  label: string;
  count: number;
  color: string;
  center: Point;
  radius: number;
  startAngle: number;
  endAngle: number;
  labelPoint: Point;
}

export interface MapDiagnostics {
  orphanParentAgentIds: string[];
  cycleAgentIds: string[];
  unassignedLineAgentIds: string[];
}

export type MapEdgeKind = 'organization' | 'assignment' | 'human-authority' | 'user-support' | 'luca-access';

export interface MapAgentEdge {
  id: string;
  source: string;
  target: string;
  active: boolean;
  kind: MapEdgeKind;
}

export interface OrquestaMapLayout {
  nodes: MapAgentNode[];
  people: MapHumanNode[];
  edges: MapAgentEdge[];
  lines: MapLineRegion[];
  diagnostics: MapDiagnostics;
  bounds: MapBounds;
}

const ACTIVE_TASK_STATES = new Set(['turn_started', 'in_progress']);
const NODE_WIDTH = 184;
const NODE_HEIGHT = 104;
const HORIZONTAL_GAP = 208;
const VERTICAL_GAP = 210;
const TREE_CLUSTER_THRESHOLD = 4;
const TREE_CLUSTER_ROW_GAP = 142;
const MAX_TREE_CLUSTER_COLUMNS = 64;
const TREE_CLUSTER_STAGGER = .82;
const HUMAN_Y = 94;
const AGENT_ROOT_Y = 286;
const PARTICIPANT_GAP = 238;
const USER_SERVICE_GAP = 208;
const RADIAL_CENTER_Y = 88;
const RADIAL_RING_GAP = 210;
const RADIAL_BASE_RADIUS = 270;
const RADIAL_NODE_ARC_GAP = NODE_WIDTH + 24;
const RADIAL_LINE_GAP = Math.PI / 36;
const LINE_COLORS = ['#514fdf', '#417b9d', '#7556a6', '#3f806d', '#9a5b70', '#8a6a36'];

function operationalAgent(agent: AgentSummary, offline: boolean): AgentSummary {
  if (!offline || !['working', 'assigned_waiting', 'approval_wait'].includes(agent.status)) return agent;
  return { ...agent, status: 'stale' };
}

export function taskForAgent(snapshot: WorkspaceSnapshot, agentId: string): TaskSummary | null {
  const agent = snapshot.agents.find((candidate) => candidate.id === agentId);
  if (!agent) return null;
  return snapshot.tasks.find((task) => task.id === agent.currentTaskId)
    ?? snapshot.tasks.find((task) => task.ownerAgentId === agentId)
    ?? null;
}

export function formatModelLabel(model: string | null | undefined): string {
  if (!model) return 'UNOBSERVED';
  const normalized = model.trim().toLowerCase();
  if (normalized.includes('sol')) return 'SOL';
  if (normalized.includes('terra')) return 'TERRA';
  if (normalized.includes('luna')) return 'LUNA';
  if (normalized.includes('faber') || normalized.includes('fabul')) return 'FABER';
  return model.replace(/^gpt[-_]?/i, '').replaceAll('_', ' ').toUpperCase();
}

export function agentModelLabel(snapshot: WorkspaceSnapshot, agentId: string): string {
  const task = taskForAgent(snapshot, agentId);
  return formatModelLabel(task?.actualModel ?? task?.requestedModel ?? task?.recommendedModel);
}

export function wheelZoomFactor(deltaY: number, deltaMode: number): number {
  const modeMultiplier = deltaMode === 1 ? 16 : deltaMode === 2 ? 240 : 1;
  const normalizedDelta = Math.max(-180, Math.min(180, deltaY * modeMultiplier));
  if (Math.abs(normalizedDelta) < .01) return 1;
  return Math.max(.62, Math.min(1.62, Math.exp(-normalizedDelta * .0036)));
}

export function treeClusterRowCounts(count: number): number[] {
  const safeCount = Math.max(0, Math.floor(count));
  if (safeCount === 0) return [];
  const triangularWidth = Math.ceil((Math.sqrt(8 * safeCount + 1) - 1) / 2);
  const columns = Math.min(MAX_TREE_CLUSTER_COLUMNS, Math.max(2, triangularWidth));
  if (safeCount > columns * (columns + 1) / 2) {
    return Array.from({ length: Math.ceil(safeCount / columns) }, (_, row) => Math.min(columns, safeCount - row * columns));
  }
  const rows: number[] = [];
  let remaining = safeCount;
  let rowWidth = columns;
  while (remaining > 0) {
    const rowCount = Math.min(rowWidth, remaining);
    rows.push(rowCount);
    remaining -= rowCount;
    rowWidth = Math.max(1, rowWidth - 1);
  }
  return rows;
}

export function buildTreeClusterSlots(count: number): TreeClusterSlot[] {
  const rowCounts = treeClusterRowCounts(count);
  if (rowCounts.length === 0) return [];
  const columns = rowCounts[0];
  const usedRays: number[] = [];
  const slots: TreeClusterSlot[] = [];
  rowCounts.forEach((rowCount, row) => {
    const y = VERTICAL_GAP + row * TREE_CLUSTER_ROW_GAP;
    let shift = 0;
    if (row > 0) {
      for (let attempt = 0; attempt < 96; attempt += 1) {
        const phase = ((row + 1 + attempt * 1.61803398875) * .61803398875) % 1;
        const candidateShift = (phase - .5) * HORIZONTAL_GAP * TREE_CLUSTER_STAGGER;
        const candidateRays = Array.from({ length: rowCount }, (_, column) => {
          const centeredColumn = column - (rowCount - 1) / 2;
          return (centeredColumn * HORIZONTAL_GAP + candidateShift) / y;
        });
        if (candidateRays.every((ray) => usedRays.every((used) => Math.abs(ray - used) > 1e-5))) {
          shift = candidateShift;
          break;
        }
      }
    }
    for (let column = 0; column < rowCount; column += 1) {
      const centeredColumn = column - (rowCount - 1) / 2;
      const x = centeredColumn * HORIZONTAL_GAP + shift;
      slots.push({ x, y, row });
      usedRays.push(x / y);
    }
  });
  return slots;
}

function agentOrder(left: AgentSummary, right: AgentSummary): number {
  return (left.lineId ?? '').localeCompare(right.lineId ?? '')
    || (left.teamId ?? '').localeCompare(right.teamId ?? '')
    || left.displayName.localeCompare(right.displayName)
    || left.id.localeCompare(right.id);
}

type UserServiceKind = 'luca' | 'user-support' | null;

function userServiceKind(agent: AgentSummary): UserServiceKind {
  const id = agent.id.toLocaleLowerCase();
  const name = agent.displayName.toLocaleLowerCase();
  if (id === 'orquesta-admin' || id === 'luca' || name === 'luca') return 'luca';
  if (id === 'user-support' || id === 'user_support' || name === 'user support') return 'user-support';
  return null;
}

function boundsForNodes(nodes: Array<Pick<MapAgentNode, 'x' | 'y'>>): MapBounds {
  if (nodes.length === 0) return { x: 0, y: 0, width: 760, height: 480 };
  const minX = Math.min(...nodes.map((node) => node.x)) - NODE_WIDTH * .72;
  const maxX = Math.max(...nodes.map((node) => node.x)) + NODE_WIDTH * .72;
  const minY = Math.min(...nodes.map((node) => node.y)) - NODE_HEIGHT * .82;
  const maxY = Math.max(...nodes.map((node) => node.y)) + NODE_HEIGHT * .9;
  return { x: minX, y: minY, width: Math.max(760, maxX - minX), height: Math.max(440, maxY - minY) };
}

function lineLabel(lineId: string): string {
  return lineId === '__unassigned__' ? 'UNASSIGNED' : lineId.replaceAll(/[-_]+/g, ' ').toUpperCase();
}

function diagnoseOrganization(agents: AgentSummary[], coordinator: AgentSummary | null): MapDiagnostics {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const orphanParentAgentIds = agents
    .filter((agent) => agent.parentAgentId && (!byId.has(agent.parentAgentId) || agent.parentAgentId === agent.id))
    .map((agent) => agent.id)
    .sort();
  const cycleAgentIds = new Set<string>();
  for (const agent of agents) {
    const path: string[] = [];
    const pathIndex = new Map<string, number>();
    let current: AgentSummary | undefined = agent;
    while (current) {
      const seenAt = pathIndex.get(current.id);
      if (seenAt !== undefined) {
        path.slice(seenAt).forEach((id) => cycleAgentIds.add(id));
        break;
      }
      pathIndex.set(current.id, path.length);
      path.push(current.id);
      current = current.parentAgentId ? byId.get(current.parentAgentId) : undefined;
    }
  }
  return {
    orphanParentAgentIds,
    cycleAgentIds: [...cycleAgentIds].sort(),
    unassignedLineAgentIds: agents
      .filter((agent) => agent.id !== coordinator?.id && !agent.lineId)
      .map((agent) => agent.id)
      .sort(),
  };
}

function buildSafeHierarchy(agents: AgentSummary[], coordinator: AgentSummary | null, diagnostics: MapDiagnostics): SafeHierarchy {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const cyclic = new Set(diagnostics.cycleAgentIds);
  const parentById = new Map<string, string | null>();
  for (const agent of agents) {
    const candidate = agent.parentAgentId;
    const valid = agent.id !== coordinator?.id
      && Boolean(candidate)
      && candidate !== agent.id
      && byId.has(candidate!)
      && !cyclic.has(agent.id);
    parentById.set(agent.id, valid ? candidate! : null);
  }

  const children = new Map<string, AgentSummary[]>();
  for (const agent of agents) {
    const parent = parentById.get(agent.id);
    if (!parent) continue;
    children.set(parent, [...(children.get(parent) ?? []), agent]);
  }
  for (const members of children.values()) members.sort(agentOrder);

  const depthById = new Map<string, number>();
  const depthOf = (agentId: string): number => {
    const cached = depthById.get(agentId);
    if (cached !== undefined) return cached;
    const parent = parentById.get(agentId);
    const depth = agentId === coordinator?.id ? 0 : parent ? depthOf(parent) + 1 : 1;
    depthById.set(agentId, depth);
    return depth;
  };
  agents.forEach((agent) => depthOf(agent.id));
  return {
    parentById,
    children,
    roots: agents.filter((agent) => !parentById.get(agent.id)).sort(agentOrder),
    depthById,
  };
}

function buildRadialPositions(agents: AgentSummary[], coordinator: AgentSummary | null, hierarchy: SafeHierarchy): {
  positions: Map<string, Point & { depth: number }>;
  lines: MapLineRegion[];
} {
  const positions = new Map<string, Point & { depth: number }>();
  if (coordinator) positions.set(coordinator.id, { x: 0, y: RADIAL_CENTER_Y, depth: 0 });

  const radialAgents = agents.filter((agent) => agent.id !== coordinator?.id).sort(agentOrder);
  const grouped = new Map<string, AgentSummary[]>();
  for (const agent of radialAgents) {
    const id = agent.lineId || '__unassigned__';
    grouped.set(id, [...(grouped.get(id) ?? []), agent]);
  }
  const groups = [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right));
  const total = Math.max(1, radialAgents.length);
  let cursor = -Math.PI / 2;
  const angleById = new Map<string, number>();
  const groupGeometry: Array<{
    id: string;
    members: AgentSummary[];
    lineIndex: number;
    startAngle: number;
    endAngle: number;
  }> = [];

  groups.forEach(([id, rawMembers], lineIndex) => {
    const members = rawMembers.slice().sort(agentOrder);
    const sector = Math.PI * 2 * members.length / total;
    const startAngle = cursor + Math.min(RADIAL_LINE_GAP, sector * .08);
    const endAngle = cursor + sector - Math.min(RADIAL_LINE_GAP, sector * .08);
    const span = Math.max(1e-6, endAngle - startAngle);
    const memberIds = new Set(members.map((member) => member.id));
    const localChildren = new Map<string, AgentSummary[]>();
    for (const member of members) {
      const parent = hierarchy.parentById.get(member.id);
      if (!parent || !memberIds.has(parent)) continue;
      localChildren.set(parent, [...(localChildren.get(parent) ?? []), member]);
    }
    for (const children of localChildren.values()) children.sort(agentOrder);
    const roots = members.filter((member) => {
      const parent = hierarchy.parentById.get(member.id);
      return !parent || !memberIds.has(parent);
    });
    const weightById = new Map<string, number>();
    const subtreeWeight = (agentId: string): number => {
      const cached = weightById.get(agentId);
      if (cached !== undefined) return cached;
      const children = localChildren.get(agentId) ?? [];
      const weight = children.length ? children.reduce((sum, child) => sum + subtreeWeight(child.id), 0) : 1;
      weightById.set(agentId, weight);
      return weight;
    };
    const allocate = (member: AgentSummary, intervalStart: number, intervalEnd: number) => {
      angleById.set(member.id, intervalStart + (intervalEnd - intervalStart) / 2);
      const children = localChildren.get(member.id) ?? [];
      if (children.length === 0) return;
      const totalWeight = children.reduce((sum, child) => sum + subtreeWeight(child.id), 0);
      let childCursor = intervalStart;
      children.forEach((child) => {
        const childSpan = (intervalEnd - intervalStart) * subtreeWeight(child.id) / totalWeight;
        allocate(child, childCursor, childCursor + childSpan);
        childCursor += childSpan;
      });
    }
    const rootWeight = roots.reduce((sum, root) => sum + subtreeWeight(root.id), 0) || 1;
    let rootCursor = startAngle;
    roots.forEach((root) => {
      const rootSpan = span * subtreeWeight(root.id) / rootWeight;
      allocate(root, rootCursor, rootCursor + rootSpan);
      rootCursor += rootSpan;
    });
    groupGeometry.push({ id, members, lineIndex, startAngle, endAngle });
    cursor += sector;
  });

  const membersByDepth = new Map<number, AgentSummary[]>();
  for (const agent of radialAgents) {
    const depth = hierarchy.depthById.get(agent.id) ?? 1;
    membersByDepth.set(depth, [...(membersByDepth.get(depth) ?? []), agent]);
  }
  let previousRadius = RADIAL_BASE_RADIUS - RADIAL_RING_GAP;
  const radiusByDepth = new Map<number, number>();
  for (const [depth, members] of [...membersByDepth.entries()].sort(([left], [right]) => left - right)) {
    const angles = members.map((member) => angleById.get(member.id) ?? 0).sort((left, right) => left - right);
    let minimumGap = Number.POSITIVE_INFINITY;
    if (angles.length > 1) {
      for (let index = 1; index < angles.length; index += 1) minimumGap = Math.min(minimumGap, angles[index] - angles[index - 1]);
      minimumGap = Math.min(minimumGap, Math.PI * 2 - (angles[angles.length - 1] - angles[0]));
    }
    const readableRadius = Number.isFinite(minimumGap) && minimumGap > 1e-6 ? RADIAL_NODE_ARC_GAP / minimumGap : 0;
    const baseRadius = RADIAL_BASE_RADIUS + Math.max(0, depth - 1) * RADIAL_RING_GAP;
    const radius = Math.max(baseRadius, readableRadius, previousRadius + RADIAL_RING_GAP);
    radiusByDepth.set(depth, radius);
    previousRadius = radius;
  }

  for (const agent of radialAgents) {
    const depth = hierarchy.depthById.get(agent.id) ?? 1;
    const angle = angleById.get(agent.id) ?? 0;
    const radius = radiusByDepth.get(depth) ?? RADIAL_BASE_RADIUS;
    positions.set(agent.id, {
      x: Math.cos(angle) * radius,
      y: RADIAL_CENTER_Y + Math.sin(angle) * radius,
      depth,
    });
  }

  const lines = groupGeometry.map(({ id, members, lineIndex, startAngle, endAngle }) => {
    const outerRadius = Math.max(RADIAL_BASE_RADIUS, ...members.map((member) => radiusByDepth.get(hierarchy.depthById.get(member.id) ?? 1) ?? RADIAL_BASE_RADIUS));
    const radius = outerRadius + 62;
    const labelRadius = radius + 42;
    const middleAngle = startAngle + (endAngle - startAngle) / 2;
    return {
      id,
      label: lineLabel(id),
      count: members.length,
      color: LINE_COLORS[lineIndex % LINE_COLORS.length],
      center: { x: 0, y: RADIAL_CENTER_Y },
      radius,
      startAngle,
      endAngle,
      labelPoint: {
        x: Math.cos(middleAngle) * labelRadius,
        y: RADIAL_CENTER_Y + Math.sin(middleAngle) * labelRadius,
      },
    };
  });

  for (const agent of agents) {
    if (!positions.has(agent.id)) positions.set(agent.id, { x: 0, y: RADIAL_CENTER_Y, depth: hierarchy.depthById.get(agent.id) ?? 0 });
  }
  return { positions, lines };
}

interface TreeBlock {
  positions: Map<string, Point>;
  minX: number;
  maxX: number;
  maxY: number;
}

function chooseTreeRowShift(row: number, rootsX: number[], rootY: number, usedRays: number[]): number {
  if (row === 0 || rootY === 0) return 0;
  for (let attempt = 0; attempt < 96; attempt += 1) {
    const phase = ((row + 1 + attempt * 1.61803398875) * .61803398875) % 1;
    const shift = (phase - .5) * HORIZONTAL_GAP * TREE_CLUSTER_STAGGER;
    const rays = rootsX.map((x) => (x + shift) / rootY);
    if (rays.every((ray) => usedRays.every((used) => Math.abs(ray - used) > 1e-5))) return shift;
  }
  return (row % 2 === 0 ? 1 : -1) * HORIZONTAL_GAP * .41;
}

function layoutTreeBlock(agent: AgentSummary, hierarchy: SafeHierarchy): TreeBlock {
  const descendants = hierarchy.children.get(agent.id) ?? [];
  const positions = new Map<string, Point>([[agent.id, { x: 0, y: 0 }]]);
  if (descendants.length === 0) return { positions, minX: 0, maxX: 0, maxY: 0 };
  if (descendants.length >= TREE_CLUSTER_THRESHOLD && descendants.every((child) => (hierarchy.children.get(child.id) ?? []).length === 0)) {
    const slots = buildTreeClusterSlots(descendants.length);
    descendants.forEach((child, index) => positions.set(child.id, slots[index]));
    return {
      positions,
      minX: Math.min(0, ...slots.map((slot) => slot.x)),
      maxX: Math.max(0, ...slots.map((slot) => slot.x)),
      maxY: Math.max(...slots.map((slot) => slot.y)),
    };
  }

  const childBlocks = descendants.map((child) => layoutTreeBlock(child, hierarchy));
  const rowCounts = descendants.length >= TREE_CLUSTER_THRESHOLD ? treeClusterRowCounts(descendants.length) : [descendants.length];
  const usedRays: number[] = [];
  let blockIndex = 0;
  let rowRootY = VERTICAL_GAP;

  rowCounts.forEach((rowCount, row) => {
    const rowBlocks = childBlocks.slice(blockIndex, blockIndex + rowCount);
    const rowWidth = rowBlocks.reduce((sum, block) => sum + (block.maxX - block.minX), 0) + Math.max(0, rowBlocks.length - 1) * HORIZONTAL_GAP;
    let cursor = -rowWidth / 2;
    const rootXs = rowBlocks.map((block) => {
      const rootX = cursor - block.minX;
      cursor += block.maxX - block.minX + HORIZONTAL_GAP;
      return rootX;
    });
    const shift = chooseTreeRowShift(row, rootXs, rowRootY, usedRays);
    let rowMaxY = 0;
    rowBlocks.forEach((block, index) => {
      const childRootX = rootXs[index] + shift;
      for (const [id, point] of block.positions) positions.set(id, { x: point.x + childRootX, y: point.y + rowRootY });
      usedRays.push(childRootX / rowRootY);
      rowMaxY = Math.max(rowMaxY, block.maxY);
    });
    blockIndex += rowCount;
    rowRootY += rowMaxY + TREE_CLUSTER_ROW_GAP;
  });

  const points = [...positions.values()];
  return {
    positions,
    minX: Math.min(...points.map((point) => point.x)),
    maxX: Math.max(...points.map((point) => point.x)),
    maxY: Math.max(...points.map((point) => point.y)),
  };
}

function buildTreePositions(orderedRoots: AgentSummary[], hierarchy: SafeHierarchy): Map<string, Point & { depth: number }> {
  const blocks = orderedRoots.map((root) => layoutTreeBlock(root, hierarchy));
  const positions = new Map<string, Point & { depth: number }>();
  if (blocks.length === 0) return positions;
  const rowCounts = blocks.length >= TREE_CLUSTER_THRESHOLD ? treeClusterRowCounts(blocks.length) : [blocks.length];
  let blockIndex = 0;
  let rowRootY = 0;
  rowCounts.forEach((rowCount) => {
    const rowBlocks = blocks.slice(blockIndex, blockIndex + rowCount);
    const rowWidth = rowBlocks.reduce((sum, block) => sum + (block.maxX - block.minX), 0) + Math.max(0, rowBlocks.length - 1) * HORIZONTAL_GAP;
    let cursor = -rowWidth / 2;
    let rowMaxY = 0;
    rowBlocks.forEach((block) => {
      const rootX = cursor - block.minX;
      for (const [id, point] of block.positions) positions.set(id, {
        x: point.x + rootX,
        y: point.y + rowRootY + AGENT_ROOT_Y,
        depth: hierarchy.depthById.get(id) ?? 0,
      });
      cursor += block.maxX - block.minX + HORIZONTAL_GAP;
      rowMaxY = Math.max(rowMaxY, block.maxY);
    });
    blockIndex += rowCount;
    rowRootY += rowMaxY + TREE_CLUSTER_ROW_GAP;
  });
  return positions;
}

export function buildOrquestaMapLayout(snapshot: WorkspaceSnapshot, mode: MapLayoutMode = 'tree'): OrquestaMapLayout {
  const offline = snapshot.project.status === 'offline' || snapshot.project.status === 'unknown';
  const agents = snapshot.agents.map((agent) => operationalAgent(agent, offline));
  const serviceAgents = agents.filter((agent) => userServiceKind(agent));
  const organizationAgents = agents.filter((agent) => !userServiceKind(agent));
  const byId = new Map(organizationAgents.map((agent) => [agent.id, agent]));
  const coordinatorId = selectCurrentUserOrchestratorId(snapshot);
  const coordinator = organizationAgents.find((agent) => agent.id === coordinatorId) ?? null;
  const diagnostics = diagnoseOrganization(organizationAgents, coordinator);
  const hierarchy = buildSafeHierarchy(organizationAgents, coordinator, diagnostics);
  const roots = hierarchy.roots;
  const otherRoots = roots.filter((agent) => agent.id !== coordinator?.id);
  const split = Math.ceil(otherRoots.length / 2);
  const orderedRoots = coordinator
    ? [...otherRoots.slice(0, split), coordinator, ...otherRoots.slice(split)]
    : otherRoots;

  const positions = new Map<string, Point & { depth: number }>();
  let lineRegions: MapLineRegion[] = [];

  if (mode === 'radial') {
    const radial = buildRadialPositions(organizationAgents, coordinator, hierarchy);
    radial.positions.forEach((point, id) => positions.set(id, point));
    lineRegions = radial.lines;
  } else {
    buildTreePositions(orderedRoots, hierarchy).forEach((point, id) => positions.set(id, point));
  }

  const participants: ProjectParticipantSummary[] = snapshot.participants;
  const participantGroups = new Map<string, ProjectParticipantSummary[]>();
  for (const participant of participants) {
    const target = participant.orchestratorAgentId && byId.has(participant.orchestratorAgentId)
      ? participant.orchestratorAgentId
      : '';
    participantGroups.set(target, [...(participantGroups.get(target) ?? []), participant]);
  }
  const people: MapHumanNode[] = [];
  const radialTop = lineRegions.length
    ? Math.min(...lineRegions.map((line) => line.center.y - line.radius)) - 128
    : RADIAL_CENTER_Y - RADIAL_BASE_RADIUS - 128;
  for (const [target, members] of participantGroups) {
    const targetX = positions.get(target)?.x ?? 0;
    const targetY = mode === 'radial' ? radialTop : HUMAN_Y;
    members.forEach((participant, index) => people.push({
      id: `human:${participant.id}`,
      participant,
      x: targetX + (index - (members.length - 1) / 2) * PARTICIPANT_GAP,
      y: targetY,
    }));
  }

  const organizationLeft = positions.size ? Math.min(...[...positions.values()].map((point) => point.x)) : 0;
  const peopleLeft = people.length ? Math.min(...people.map((person) => person.x)) : 0;
  const serviceLeftAnchor = people.length ? peopleLeft : organizationLeft;
  serviceAgents.slice().sort(agentOrder).forEach((agent, index) => {
    positions.set(agent.id, {
      x: serviceLeftAnchor - (serviceAgents.length - index) * USER_SERVICE_GAP,
      y: people[0]?.y ?? HUMAN_Y,
      depth: -1,
    });
  });

  const taskByAgent = new Map(snapshot.tasks.filter((task) => task.ownerAgentId).map((task) => [task.ownerAgentId!, task]));
  const nodes = agents.map((agent) => {
    const task = (agent.currentTaskId ? snapshot.tasks.find((candidate) => candidate.id === agent.currentTaskId) : null)
      ?? taskByAgent.get(agent.id)
      ?? null;
    const point = positions.get(agent.id) ?? { x: 0, y: AGENT_ROOT_Y, depth: 0 };
    return {
      agent,
      task,
      modelLabel: formatModelLabel(task?.actualModel ?? task?.requestedModel ?? task?.recommendedModel),
      x: point.x,
      y: point.y,
      depth: point.depth,
      active: agent.status === 'working' || Boolean(task && ACTIVE_TASK_STATES.has(task.state)),
    };
  });

  const agentIds = new Set(nodes.map((node) => node.agent.id));
  const humanIdByParticipant = new Map(people.map((person) => [person.participant.id, person.id]));
  const edges = new Map<string, MapAgentEdge>();
  const addEdge = (source: string, target: string, kind: MapEdgeKind, active = false) => {
    const id = `edge:${source}:${target}`;
    const existing = edges.get(id);
    edges.set(id, { id, source, target, kind: existing?.kind ?? kind, active: Boolean(existing?.active || active) });
  };

  for (const node of nodes) {
    const parent = hierarchy.parentById.get(node.agent.id);
    if (parent && agentIds.has(parent) && !userServiceKind(node.agent)) addEdge(parent, node.agent.id, 'organization');
  }
  for (const person of people) {
    const target = person.participant.orchestratorAgentId && agentIds.has(person.participant.orchestratorAgentId)
      ? person.participant.orchestratorAgentId
      : null;
    if (target) addEdge(person.id, target, 'human-authority');
  }
  for (const service of serviceAgents) {
    const kind = userServiceKind(service);
    const targets = kind === 'user-support'
      ? people
      : people.filter((person) => person.participant.isCurrentUser).slice(0, 1);
    for (const person of targets.length ? targets : people.slice(0, 1)) {
      addEdge(service.id, person.id, kind === 'luca' ? 'luca-access' : 'user-support');
    }
  }
  for (const node of nodes) {
    const sourceIdentity = node.task?.assignedByAgentId;
    if (!node.active || !sourceIdentity || sourceIdentity === node.agent.id) continue;
    const source = agentIds.has(sourceIdentity) ? sourceIdentity : humanIdByParticipant.get(sourceIdentity);
    if (source) addEdge(source, node.agent.id, 'assignment', true);
  }

  return {
    nodes,
    people,
    edges: [...edges.values()],
    lines: lineRegions,
    diagnostics,
    bounds: boundsForNodes([...nodes, ...people, ...lineRegions.map((line) => line.labelPoint)]),
  };
}

function defaultLayoutMode(snapshot: WorkspaceSnapshot): MapLayoutMode {
  return snapshot.agents.filter((agent) => !userServiceKind(agent)).length >= 12 ? 'radial' : 'tree';
}

function cameraFor(bounds: MapBounds): MapBounds {
  const padding = 54;
  return { x: bounds.x - padding, y: bounds.y - padding, width: bounds.width + padding * 2, height: bounds.height + padding * 2 };
}

function lineArcPath(line: MapLineRegion): string {
  const start = {
    x: line.center.x + Math.cos(line.startAngle) * line.radius,
    y: line.center.y + Math.sin(line.startAngle) * line.radius,
  };
  const end = {
    x: line.center.x + Math.cos(line.endAngle) * line.radius,
    y: line.center.y + Math.sin(line.endAngle) * line.radius,
  };
  const largeArc = line.endAngle - line.startAngle > Math.PI ? 1 : 0;
  return `M ${start.x} ${start.y} A ${line.radius} ${line.radius} 0 ${largeArc} 1 ${end.x} ${end.y}`;
}

function edgePath(source: MapAgentNode | MapHumanNode, target: MapAgentNode | MapHumanNode, kind: MapEdgeKind, mode: MapLayoutMode): string {
  if (kind === 'user-support' || kind === 'luca-access') {
    const direction = target.x >= source.x ? 1 : -1;
    const startX = source.x + direction * 31;
    const endX = target.x - direction * 38;
    const middleX = startX + (endX - startX) * .5;
    const bend = kind === 'luca-access' ? -62 : 24;
    return `M ${startX} ${source.y} C ${middleX} ${source.y + bend}, ${middleX} ${target.y + bend}, ${endX} ${target.y}`;
  }
  if (mode === 'radial' && kind !== 'human-authority') {
    const dx = target.x - source.x;
    const dy = target.y - source.y;
    const distance = Math.max(1, Math.hypot(dx, dy));
    const ux = dx / distance;
    const uy = dy / distance;
    const startX = source.x + ux * 30;
    const startY = source.y + uy * 30;
    const endX = target.x - ux * 35;
    const endY = target.y - uy * 35;
    const curve = kind === 'assignment' ? Math.min(72, distance * .14) : 0;
    const px = -uy * curve;
    const py = ux * curve;
    return `M ${startX} ${startY} C ${startX + dx * .38 + px} ${startY + dy * .38 + py}, ${startX + dx * .62 + px} ${startY + dy * .62 + py}, ${endX} ${endY}`;
  }
  const sourceOffset = 'participant' in source ? 38 : 28;
  const targetOffset = 'participant' in target ? 38 : 35;
  const direction = target.y >= source.y ? 1 : -1;
  const startY = source.y + direction * sourceOffset;
  const endY = target.y - direction * targetOffset;
  const dx = target.x - source.x;
  const dy = endY - startY;
  const firstControlX = source.x + dx * .34;
  const secondControlX = source.x + dx * .82;
  return `M ${source.x} ${startY} C ${firstControlX} ${startY + dy * .24}, ${secondControlX} ${startY + dy * .76}, ${target.x} ${endY}`;
}

function AgentIcon({ agent }: { agent: AgentSummary }) {
  if (agent.id === 'orchestrator' || agent.role.toLowerCase().includes('orchestrator')) return <Network aria-hidden="true" />;
  if (agent.id === 'orquesta-admin' || agent.id === 'user-support') return <LifeBuoy aria-hidden="true" />;
  return <Bot aria-hidden="true" />;
}

export function OrquestaMap({
  snapshot,
  selectedAgentId,
  onSelectAgent,
  locale,
  sessionState,
  onSessionStateChange,
}: OrquestaMapProps) {
  const initialLayoutMode = sessionState?.layoutMode ?? defaultLayoutMode(snapshot);
  const initialManualPositions: ManualPositionsByMode = sessionState
    ? {
        tree: { ...sessionState.manualPositionsByMode.tree },
        radial: { ...sessionState.manualPositionsByMode.radial },
      }
    : { tree: {}, radial: {} };
  const [layoutMode, setLayoutMode] = useState<MapLayoutMode>(initialLayoutMode);
  const autoLayout = useMemo(() => buildOrquestaMapLayout(snapshot, layoutMode), [snapshot, layoutMode]);
  const [manualPositions, setManualPositions] = useState<ManualPositions>(initialManualPositions[initialLayoutMode]);
  const manualPositionsRef = useRef(manualPositions);
  const manualPositionsByModeRef = useRef<ManualPositionsByMode>(initialManualPositions);
  const nodes = useMemo(() => autoLayout.nodes.map((node) => ({ ...node, ...(manualPositions[node.agent.id] ?? {}) })), [autoLayout.nodes, manualPositions]);
  const people = useMemo(() => autoLayout.people.map((person) => ({ ...person, ...(manualPositions[person.id] ?? {}) })), [autoLayout.people, manualPositions]);
  const currentBounds = useMemo(() => boundsForNodes([...nodes, ...people]), [nodes, people]);
  const fittedCamera = useMemo(() => cameraFor(currentBounds), [currentBounds]);
  const [camera, setCamera] = useState<MapBounds>(() => fittedCamera);
  const [zoomLevel, setZoomLevel] = useState(1);
  const zoomRef = useRef(1);
  const [query, setQuery] = useState('');
  const stageRef = useRef<HTMLDivElement>(null);
  const panRef = useRef<{ pointerId: number; x: number; y: number; camera: MapBounds } | null>(null);
  const nodeDragRef = useRef<{ pointerId: number; agentId: string; x: number; y: number; start: Point; moved: boolean } | null>(null);
  const suppressClickRef = useRef(false);
  const nodeById = useMemo(() => new Map<string, MapAgentNode | MapHumanNode>([
    ...nodes.map((node) => [node.agent.id, node] as const),
    ...people.map((person) => [person.id, person] as const),
  ]), [nodes, people]);
  const coordinatorId = selectCurrentUserOrchestratorId(snapshot);
  const organizationLineCount = useMemo(() => new Set(
    nodes
      .filter((node) => node.agent.id !== coordinatorId && !userServiceKind(node.agent))
      .map((node) => node.agent.lineId)
      .filter((lineId): lineId is string => Boolean(lineId)),
  ).size, [coordinatorId, nodes]);
  const denseLineLabels = organizationLineCount > 24;
  const overview = zoomLevel < .7 || camera.width > 1_600 || camera.height > 1_000;
  const microOverview = zoomLevel < .3
    || camera.width > 9_000
    || camera.height > 5_600
    || (denseLineLabels && nodes.length > 400 && zoomLevel <= 1);
  const maximumZoom = Math.min(128, Math.max(3.2, fittedCamera.width / 650, fittedCamera.height / 410));
  const offline = snapshot.project.status === 'offline' || snapshot.project.status === 'unknown';
  const warningCount = autoLayout.diagnostics.orphanParentAgentIds.length
    + autoLayout.diagnostics.cycleAgentIds.length
    + autoLayout.diagnostics.unassignedLineAgentIds.length;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const agentMatches = normalizedQuery ? nodes.filter((node) => node.agent.displayName.toLocaleLowerCase().includes(normalizedQuery)) : [];
  const peopleMatches = normalizedQuery ? people.filter((person) => {
    const displayName = person.participant.isCurrentUser && locale === 'ja' ? 'あなた' : person.participant.displayName;
    return displayName.toLocaleLowerCase().includes(normalizedQuery);
  }) : [];
  const viewportCulling = nodes.length > 400 && !microOverview;
  const viewportMargin = Math.max(220, Math.min(520, Math.max(camera.width, camera.height) * .18));
  const insideViewport = useCallback((point: Point) => !viewportCulling || (
    point.x >= camera.x - viewportMargin
    && point.x <= camera.x + camera.width + viewportMargin
    && point.y >= camera.y - viewportMargin
    && point.y <= camera.y + camera.height + viewportMargin
  ), [camera, viewportCulling, viewportMargin]);
  const renderedNodes = useMemo(() => nodes.filter(insideViewport), [insideViewport, nodes]);
  const renderedPeople = useMemo(() => people.filter(insideViewport), [insideViewport, people]);
  const renderedNodeIds = useMemo(() => new Set([
    ...renderedNodes.map((node) => node.agent.id),
    ...renderedPeople.map((person) => person.id),
  ]), [renderedNodes, renderedPeople]);
  const renderedEdges = useMemo(() => autoLayout.edges.filter((edge) => {
    if (denseLineLabels && microOverview && (edge.kind === 'organization' || edge.kind === 'assignment')) return false;
    if (!viewportCulling) return true;
    return renderedNodeIds.has(edge.source) && renderedNodeIds.has(edge.target);
  }), [autoLayout.edges, denseLineLabels, microOverview, renderedNodeIds, viewportCulling]);
  const renderedLines = denseLineLabels && !microOverview ? [] : autoLayout.lines;

  const fit = useCallback(() => {
    setCamera(fittedCamera);
    zoomRef.current = 1;
    setZoomLevel(1);
  }, [fittedCamera]);

  const publishSessionState = (mode: MapLayoutMode) => {
    onSessionStateChange?.({
      layoutMode: mode,
      manualPositionsByMode: {
        tree: { ...manualPositionsByModeRef.current.tree },
        radial: { ...manualPositionsByModeRef.current.radial },
      },
    });
  };

  const zoom = useCallback((factor: number, anchor: Point = { x: .5, y: .5 }) => {
    const currentZoom = zoomRef.current;
    const nextZoom = Math.max(.12, Math.min(maximumZoom, currentZoom * factor));
    const appliedFactor = nextZoom / currentZoom;
    if (Math.abs(appliedFactor - 1) < .001) return;
    setCamera((current) => {
      const width = current.width / appliedFactor;
      const height = current.height / appliedFactor;
      const anchorX = Math.max(0, Math.min(1, anchor.x));
      const anchorY = Math.max(0, Math.min(1, anchor.y));
      return {
        x: current.x + (current.width - width) * anchorX,
        y: current.y + (current.height - height) * anchorY,
        width,
        height,
      };
    });
    zoomRef.current = nextZoom;
    setZoomLevel(nextZoom);
  }, [maximumZoom]);

  const changeLayoutMode = (mode: MapLayoutMode) => {
    if (mode === layoutMode) return;
    const positions = manualPositionsByModeRef.current[mode];
    const nextAutoLayout = buildOrquestaMapLayout(snapshot, mode);
    const nextPoints = [
      ...nextAutoLayout.nodes.map((node) => ({ ...node, ...(positions[node.agent.id] ?? {}) })),
      ...nextAutoLayout.people.map((person) => ({ ...person, ...(positions[person.id] ?? {}) })),
    ];
    manualPositionsRef.current = positions;
    setManualPositions(positions);
    setLayoutMode(mode);
    setCamera(cameraFor(boundsForNodes(nextPoints)));
    zoomRef.current = 1;
    setZoomLevel(1);
    publishSessionState(mode);
  };

  const focusNode = (node: MapAgentNode) => {
    const width = 650;
    const height = 410;
    setCamera({ x: node.x - width / 2, y: node.y - height / 2, width, height });
    const focusZoom = Math.min(maximumZoom, Math.max(1.55, fittedCamera.width / width, fittedCamera.height / height));
    zoomRef.current = focusZoom;
    setZoomLevel(focusZoom);
    onSelectAgent(node.agent.id);
  };

  const focusPerson = (person: MapHumanNode) => {
    const width = 650;
    const height = 410;
    setCamera({ x: person.x - width / 2, y: person.y - height / 2, width, height });
    const focusZoom = Math.min(maximumZoom, Math.max(1.55, fittedCamera.width / width, fittedCamera.height / height));
    zoomRef.current = focusZoom;
    setZoomLevel(focusZoom);
  };

  const onSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    if (agentMatches[0]) focusNode(agentMatches[0]);
    else if (peopleMatches[0]) focusPerson(peopleMatches[0]);
  };

  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const rect = stageRef.current?.getBoundingClientRect();
    const anchor = rect?.width && rect.height
      ? { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height }
      : { x: .5, y: .5 };
    zoom(wheelZoomFactor(event.deltaY, event.deltaMode), anchor);
  };

  const onCanvasPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as Element).closest('.map-agent-node')) return;
    panRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, camera };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.currentTarget.classList.add('is-panning');
  };

  const onCanvasPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = panRef.current;
    const rect = stageRef.current?.getBoundingClientRect();
    if (!drag || drag.pointerId !== event.pointerId || !rect?.width || !rect.height) return;
    setCamera({
      ...drag.camera,
      x: drag.camera.x - (event.clientX - drag.x) * drag.camera.width / rect.width,
      y: drag.camera.y - (event.clientY - drag.y) * drag.camera.height / rect.height,
    });
  };

  const endCanvasPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (panRef.current?.pointerId !== event.pointerId) return;
    panRef.current = null;
    event.currentTarget.classList.remove('is-panning');
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const startNodeDrag = (event: ReactPointerEvent<HTMLElement>, id: string, point: Point) => {
    event.stopPropagation();
    if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
    nodeDragRef.current = { pointerId: event.pointerId, agentId: id, x: event.clientX, y: event.clientY, start: { x: point.x, y: point.y }, moved: false };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.currentTarget.classList.add('is-dragging');
  };

  const moveNode = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = nodeDragRef.current;
    const rect = stageRef.current?.getBoundingClientRect();
    if (!drag || drag.pointerId !== event.pointerId || !rect?.width || !rect.height || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
    event.stopPropagation();
    const scale = Math.min(rect.width / camera.width, rect.height / camera.height) || 1;
    const dx = (event.clientX - drag.x) / scale;
    const dy = (event.clientY - drag.y) / scale;
    if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 4) drag.moved = true;
    const next = { ...manualPositionsRef.current, [drag.agentId]: { x: drag.start.x + dx, y: drag.start.y + dy } };
    manualPositionsRef.current = next;
    setManualPositions(next);
  };

  const endNodeDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = nodeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.stopPropagation();
    suppressClickRef.current = drag.moved;
    nodeDragRef.current = null;
    event.currentTarget.classList.remove('is-dragging');
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (drag.moved) {
      manualPositionsByModeRef.current[layoutMode] = manualPositionsRef.current;
      publishSessionState(layoutMode);
    }
  };

  const resetLayout = () => {
    manualPositionsByModeRef.current[layoutMode] = {};
    manualPositionsRef.current = {};
    setManualPositions({});
    setCamera(cameraFor(autoLayout.bounds));
    zoomRef.current = 1;
    setZoomLevel(1);
    publishSessionState(layoutMode);
  };

  return (
    <section className="map-surface map-network" aria-labelledby="map-title">
      <header className="map-network-head">
        <div className="map-network-title"><span id="map-title">LIVE ORGANIZATION</span><b>{offline ? 'SNAPSHOT / MOTION HALTED' : `${nodes.filter((node) => node.active).length} ACTIVE / ${nodes.length} AGENTS / ${people.length} ${people.length === 1 ? 'USER' : 'USERS'}`}</b>{warningCount > 0 && <em>{warningCount} STRUCTURE {warningCount === 1 ? 'WARNING' : 'WARNINGS'}</em>}</div>
        <div className="map-network-tools">
          <div className="map-layout-switch" role="group" aria-label={locale === 'ja' ? '配置方式' : 'Layout mode'}>
            <button type="button" className={layoutMode === 'tree' ? 'is-selected' : ''} onClick={() => changeLayoutMode('tree')} aria-pressed={layoutMode === 'tree'} aria-label={locale === 'ja' ? 'ツリー表示' : 'Tree layout'}><GitBranch aria-hidden="true" /><span>TREE</span></button>
            <button type="button" className={layoutMode === 'radial' ? 'is-selected' : ''} onClick={() => changeLayoutMode('radial')} aria-pressed={layoutMode === 'radial'} aria-label={locale === 'ja' ? '円形表示' : 'Radial layout'}><Orbit aria-hidden="true" /><span>RADIAL</span></button>
          </div>
          <label className="map-search"><Search aria-hidden="true" /><span className="sr-only">{locale === 'ja' ? 'エージェントを検索' : 'Find agent'}</span><input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={onSearchKeyDown} placeholder={locale === 'ja' ? 'エージェントを検索' : 'Find agent'} /></label>
          <div className="map-controls" aria-label={locale === 'ja' ? 'マップ表示操作' : 'Map controls'}>
            <button type="button" onClick={() => zoom(1.18)} aria-label={locale === 'ja' ? '拡大' : 'Zoom in'}><ZoomIn aria-hidden="true" /></button>
            <button type="button" onClick={() => zoom(.84)} aria-label={locale === 'ja' ? '縮小' : 'Zoom out'}><ZoomOut aria-hidden="true" /></button>
            <button type="button" onClick={fit} aria-label={locale === 'ja' ? '全体を表示' : 'Fit all'}><Focus aria-hidden="true" /></button>
            <button type="button" onClick={resetLayout} aria-label={locale === 'ja' ? '自動配置に戻す' : 'Reset layout'}><RotateCcw aria-hidden="true" /></button>
          </div>
        </div>
      </header>
      <div
        ref={stageRef}
        className={`map-network-stage mode-${layoutMode}${overview ? ' is-overview' : ''}${microOverview ? ' is-micro-overview' : ''}${denseLineLabels ? ' has-dense-lines' : ''}`}
        data-zoom-percent={Math.round(zoomLevel * 100)}
        data-rendered-agent-count={renderedNodes.length}
        data-rendered-edge-count={renderedEdges.length}
        onWheel={onWheel}
        onPointerDown={onCanvasPointerDown}
        onPointerMove={onCanvasPointerMove}
        onPointerUp={endCanvasPan}
        onPointerCancel={endCanvasPan}
      >
        <svg className="map-network-svg" viewBox={`${camera.x} ${camera.y} ${camera.width} ${camera.height}`} preserveAspectRatio="xMidYMid meet" aria-label={locale === 'ja' ? 'エージェント組織図' : 'Agent organization map'}>
          <defs>
            <marker id="map-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L8,4 L0,8 z" /></marker>
            <linearGradient id="map-flow-gradient" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#5755e7" stopOpacity=".18" /><stop offset=".5" stopColor="#5755e7" /><stop offset="1" stopColor="#8b8afa" stopOpacity=".18" /></linearGradient>
          </defs>
          {layoutMode === 'radial' && <g className="map-line-regions" aria-hidden="true">
            {renderedLines.map((line) => <g key={line.id} className="map-line-region" data-line-id={line.id}>
              <path d={lineArcPath(line)} style={{ stroke: line.color }} />
              <text x={line.labelPoint.x} y={line.labelPoint.y} style={{ fill: line.color }} textAnchor="middle"><tspan x={line.labelPoint.x}>{line.label}</tspan><tspan x={line.labelPoint.x} dy="13">{String(line.count).padStart(2, '0')} AGENTS</tspan></text>
            </g>)}
          </g>}
          <g className="map-edges">
            {renderedEdges.map((edge) => {
              const source = nodeById.get(edge.source);
              const target = nodeById.get(edge.target);
              if (!source || !target) return null;
              const path = edgePath(source, target, edge.kind, layoutMode);
              const directional = edge.kind !== 'user-support' && edge.kind !== 'luca-access';
              return <g key={edge.id} className={`map-edge edge-${edge.kind}`} data-flow-source={edge.source} data-flow-target={edge.target} data-active={edge.active ? 'true' : 'false'}><path className="map-edge-base" d={path} markerEnd={directional ? 'url(#map-arrow)' : undefined} />{edge.active && !offline && <path className="map-edge-flow" d={path} />}</g>;
            })}
          </g>
          <g className="map-people">
            {renderedPeople.map((person) => {
              const displayName = person.participant.isCurrentUser
                ? locale === 'ja' ? 'あなた' : 'You'
                : person.participant.displayName;
              const isMatch = !normalizedQuery || displayName.toLocaleLowerCase().includes(normalizedQuery);
              return (
                <foreignObject key={person.id} x={person.x - NODE_WIDTH / 2} y={person.y - NODE_HEIGHT / 2} width={NODE_WIDTH} height={NODE_HEIGHT} overflow="visible">
                  <button
                    type="button"
                    className={`map-human-node${person.participant.isCurrentUser ? ' is-current-user' : ''}${isMatch ? '' : ' is-search-dimmed'}`}
                    data-person-id={person.participant.id}
                    aria-label={`${displayName}, HUMAN, ${person.participant.roleLabel}`}
                    onPointerDown={(event) => startNodeDrag(event, person.id, person)}
                    onPointerMove={moveNode}
                    onPointerUp={endNodeDrag}
                    onPointerCancel={endNodeDrag}
                    onClick={() => {
                      if (suppressClickRef.current) { suppressClickRef.current = false; return; }
                      focusPerson(person);
                    }}
                  >
                    <span className="map-human-glyph"><UserRound aria-hidden="true" /></span>
                    <span className="map-human-copy"><strong>{displayName}</strong><small>HUMAN <em>{person.participant.roleLabel}</em></small></span>
                  </button>
                </foreignObject>
              );
            })}
          </g>
          <g className="map-nodes">
            {renderedNodes.map((node) => {
              const isMatch = !normalizedQuery || node.agent.displayName.toLocaleLowerCase().includes(normalizedQuery);
              const service = userServiceKind(node.agent);
              return (
                <foreignObject key={node.agent.id} x={node.x - NODE_WIDTH / 2} y={node.y - NODE_HEIGHT / 2} width={NODE_WIDTH} height={NODE_HEIGHT} overflow="visible">
                  <button
                    type="button"
                    className={`map-agent-node status-${node.agent.status}${node.active && !offline ? ' is-active' : ''}${selectedAgentId === node.agent.id ? ' is-selected' : ''}${service ? ` is-user-service service-${service}` : ''}${isMatch ? '' : ' is-search-dimmed'}`}
                    data-agent-id={node.agent.id}
                    data-line-id={node.agent.lineId ?? ''}
                    data-model={node.modelLabel}
                    aria-label={`${node.agent.displayName}, ${agentStatusCopy(node.agent.status, locale)}, ${node.modelLabel}`}
                    aria-pressed={selectedAgentId === node.agent.id}
                    onPointerDown={(event) => startNodeDrag(event, node.agent.id, node)}
                    onPointerMove={moveNode}
                    onPointerUp={endNodeDrag}
                    onPointerCancel={endNodeDrag}
                    onClick={() => {
                      if (suppressClickRef.current) { suppressClickRef.current = false; return; }
                      onSelectAgent(node.agent.id);
                    }}
                  >
                    <span className="map-agent-orbit" aria-hidden="true"><i /><i /><i /></span>
                    <span className="map-agent-glyph"><AgentIcon agent={node.agent} /></span>
                    <span className="map-agent-copy"><strong>{node.agent.displayName}</strong><small><i aria-hidden="true" />{agentStatusCopy(node.agent.status, locale)}<em>{node.modelLabel}</em></small></span>
                  </button>
                </foreignObject>
              );
            })}
          </g>
        </svg>
      </div>
      <footer className="map-network-foot"><span>{locale === 'ja' ? 'ノードをドラッグして配置 / 背景をドラッグして移動 / ホイールで拡大縮小' : 'DRAG NODES TO ARRANGE / DRAG CANVAS TO PAN / WHEEL TO ZOOM'}</span><span>{Object.keys(manualPositions).length > 0 ? `${Object.keys(manualPositions).length} MANUAL POSITIONS` : `${layoutMode.toUpperCase()} / ${organizationLineCount || 1} ${(organizationLineCount || 1) === 1 ? 'LINE' : 'LINES'} / ${microOverview ? 'MICRO' : overview ? 'OVERVIEW' : 'DETAIL'}`} / {Math.round(zoomLevel * 100)}%</span></footer>
    </section>
  );
}
