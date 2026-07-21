import type { InspectionKind } from '../../../contracts/orquesta-ui';
import type { Point } from './layout';

export function inspectionPosition(kind: InspectionKind, orchestrator: Point, nodeWidth: number): Point {
  const offset = nodeWidth * 1.5;
  return {
    x: orchestrator.x + (kind === 'external_benchmark' ? -offset : offset),
    y: orchestrator.y
  };
}

export function inspectionScreenPosition(
  kind: InspectionKind,
  orchestrator: Point,
  zoom: number,
  visualScale: number,
  nodeWidth = 126
): Point {
  const direction = kind === 'external_benchmark' ? -1 : 1;
  const projectedOffset = nodeWidth * 1.5 * zoom;
  const minimumClearance = (140 / 2 + nodeWidth / 2 + 14) * visualScale;
  return {
    x: orchestrator.x + direction * Math.max(projectedOffset, minimumClearance),
    y: orchestrator.y
  };
}
