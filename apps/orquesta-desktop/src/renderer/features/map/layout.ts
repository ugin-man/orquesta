import type { AgentUiModel } from '../../../contracts/orquesta-ui';

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
  outerRadius: number;
  compact: boolean;
}

export function createStableLayout(agents: AgentUiModel[]): MapLayout {
  const orchestrator = agents.find((agent) => agent.id === 'orchestrator');
  const specialists = agents.filter((agent) => agent.id !== 'orchestrator');
  const compact = agents.length > 12;
  const width = compact ? 1400 : 1200;
  const height = compact ? 1040 : 900;
  const center = compact ? { x: 700, y: 470 } : { x: 600, y: 390 };
  const user = compact ? { x: 700, y: 126 } : { x: 600, y: 116 };
  const positions = new Map<string, Point>();
  if (orchestrator) positions.set(orchestrator.id, center);

  if (!compact) {
    const count = Math.max(specialists.length, 1);
    const minX = count <= 6 ? 300 : 215;
    const maxX = count <= 6 ? 900 : 985;
    specialists.forEach((agent, index) => {
      const ratio = count === 1 ? 0.5 : index / (count - 1);
      const arc = Math.sin(ratio * Math.PI);
      positions.set(agent.id, {
        x: minX + (maxX - minX) * ratio,
        y: 665 - arc * 24
      });
    });
  } else {
    const ringSizes = [9, 13, Number.POSITIVE_INFINITY];
    const radii = [250, 405, 535];
    const yScales = [0.72, 0.68, 0.62];
    let offset = 0;
    ringSizes.forEach((size, ringIndex) => {
      const members = specialists.slice(offset, Number.isFinite(size) ? offset + size : undefined);
      offset += members.length;
      members.forEach((agent, index) => {
        const start = ringIndex === 0 ? Math.PI * 0.12 : -Math.PI * 0.92;
        const span = ringIndex === 0 ? Math.PI * 0.76 : Math.PI * 1.84;
        const angle = members.length === 1 ? Math.PI / 2 : start + (index / members.length) * span;
        positions.set(agent.id, {
          x: center.x + Math.cos(angle) * radii[ringIndex],
          y: center.y + Math.sin(angle) * radii[ringIndex] * yScales[ringIndex] + 80
        });
      });
    });
  }

  return {
    width,
    height,
    center,
    user,
    agentPositions: positions,
    outerRadius: compact ? 560 : 410,
    compact
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
