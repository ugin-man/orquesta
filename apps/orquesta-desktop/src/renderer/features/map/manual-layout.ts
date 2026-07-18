import type { Point } from './layout';

export type ManualOffsets = Record<string, Point>;

const STORAGE_PREFIX = 'orquesta.desktop.map-layout.';

function storageKey(projectId: string): string {
  return `${STORAGE_PREFIX}${projectId}`;
}

function validPoint(value: unknown): value is Point {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<Point>;
  return Number.isFinite(candidate.x) && Number.isFinite(candidate.y);
}

export function loadManualOffsets(projectId: string, storage: Storage): ManualOffsets {
  try {
    const raw = storage.getItem(storageKey(projectId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, Point] => validPoint(entry[1])));
  } catch {
    return {};
  }
}

export function saveManualOffsets(projectId: string, offsets: ManualOffsets, storage: Storage): void {
  const valid = Object.fromEntries(Object.entries(offsets).filter((entry): entry is [string, Point] => validPoint(entry[1])));
  if (Object.keys(valid).length) storage.setItem(storageKey(projectId), JSON.stringify(valid));
  else storage.removeItem(storageKey(projectId));
}

export function clearManualOffsets(projectId: string, storage: Storage): void {
  storage.removeItem(storageKey(projectId));
}

export function applyManualOffsets(base: Map<string, Point>, offsets: ManualOffsets): Map<string, Point> {
  const result = new Map<string, Point>();
  for (const [agentId, point] of base) {
    const offset = offsets[agentId];
    result.set(agentId, offset ? { x: point.x + offset.x, y: point.y + offset.y } : { ...point });
  }
  return result;
}
