import type { AgentUiModel } from '../../../contracts/orquesta-ui';
import { buildAgentHierarchy, type AgentHierarchy, type HierarchyParentId } from './hierarchy';

export interface Point {
  x: number;
  y: number;
}

export interface MapLayout {
  width: number;
  height: number;
  center: Point;
  user: Point;
  agentPositions: Map<string, Point>;
  edges: Array<{ parentId: HierarchyParentId; childId: string; from: Point; to: Point }>;
  hierarchy: AgentHierarchy;
  nodeWidth: number;
  nodeHeight: number;
  outerRadius: number;
  compact: boolean;
}

const NODE_WIDTH = 168;
const NODE_HEIGHT = 140;
const USER_NODE_HEIGHT = 100;
const HORIZONTAL_GAP = 48;
const LEVEL_GAP = 110;
const ROW_GAP = 64;
const MAX_ROW_WIDTH = 2400;
const WORLD_MARGIN_X = 120;
const WORLD_MARGIN_Y = 80;

interface SubtreeBox {
  width: number;
  height: number;
  positions: Map<HierarchyParentId, Point>;
}

function translatePositions(target: Map<HierarchyParentId, Point>, source: Map<HierarchyParentId, Point>, x: number, y: number) {
  for (const [id, point] of source) target.set(id, { x: point.x + x, y: point.y + y });
}

function layoutSubtree(parentId: HierarchyParentId, hierarchy: AgentHierarchy): SubtreeBox {
  const isUser = parentId === 'user';
  const ownHeight = isUser ? USER_NODE_HEIGHT : NODE_HEIGHT;
  const childBoxes = (hierarchy.childrenByParentId.get(parentId) ?? []).map((childId) => layoutSubtree(childId, hierarchy));
  if (!childBoxes.length) {
    return {
      width: NODE_WIDTH,
      height: ownHeight,
      positions: new Map([[parentId, { x: NODE_WIDTH / 2, y: ownHeight / 2 }]])
    };
  }

  const rows: Array<{ boxes: SubtreeBox[]; width: number; height: number }> = [];
  for (const box of childBoxes) {
    let row = rows.at(-1);
    const nextWidth = row ? row.width + HORIZONTAL_GAP + box.width : box.width;
    if (!row || (row.boxes.length > 0 && nextWidth > MAX_ROW_WIDTH)) {
      row = { boxes: [], width: 0, height: 0 };
      rows.push(row);
    }
    row.width = row.boxes.length ? row.width + HORIZONTAL_GAP + box.width : box.width;
    row.height = Math.max(row.height, box.height);
    row.boxes.push(box);
  }

  const width = Math.max(NODE_WIDTH, ...rows.map((row) => row.width));
  const positions = new Map<HierarchyParentId, Point>([[parentId, { x: width / 2, y: ownHeight / 2 }]]);
  let rowY = ownHeight + LEVEL_GAP;
  for (const row of rows) {
    let rowX = (width - row.width) / 2;
    for (const box of row.boxes) {
      translatePositions(positions, box.positions, rowX, rowY);
      rowX += box.width + HORIZONTAL_GAP;
    }
    rowY += row.height + ROW_GAP;
  }

  return {
    width,
    height: rowY - ROW_GAP,
    positions
  };
}

export function createStableLayout(agents: AgentUiModel[]): MapLayout {
  const hierarchy = buildAgentHierarchy(agents);
  const tree = layoutSubtree('user', hierarchy);
  const contentWidth = tree.width + WORLD_MARGIN_X * 2;
  const contentHeight = tree.height + WORLD_MARGIN_Y * 2;
  const width = Math.max(1200, contentWidth);
  const height = Math.max(900, contentHeight);
  const offsetX = (width - tree.width) / 2;
  const offsetY = WORLD_MARGIN_Y;
  const allPositions = new Map<HierarchyParentId, Point>();
  translatePositions(allPositions, tree.positions, offsetX, offsetY);
  const user = allPositions.get('user') ?? { x: width / 2, y: WORLD_MARGIN_Y + USER_NODE_HEIGHT / 2 };
  const agentPositions = new Map<string, Point>();
  for (const item of agents) {
    const point = allPositions.get(item.id);
    if (point && !agentPositions.has(item.id)) agentPositions.set(item.id, point);
  }
  const center = agentPositions.get('orchestrator') ?? agentPositions.values().next().value ?? user;
  const edges = [...hierarchy.parentByAgentId].flatMap(([childId, parentId]) => {
    const from = parentId === 'user' ? user : agentPositions.get(parentId);
    const to = agentPositions.get(childId);
    return from && to ? [{ parentId, childId, from, to }] : [];
  });

  return {
    width,
    height,
    center,
    user,
    agentPositions,
    edges,
    hierarchy,
    nodeWidth: NODE_WIDTH,
    nodeHeight: NODE_HEIGHT,
    outerRadius: Math.max(width, height) / 2 - WORLD_MARGIN_X,
    compact: agents.length > 12
  };
}

export function edgePath(from: Point, to: Point): string {
  const dy = to.y - from.y;
  const controlY = from.y + dy * 0.48;
  return `M ${from.x} ${from.y} C ${from.x} ${controlY}, ${to.x} ${controlY}, ${to.x} ${to.y}`;
}

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
