import type { MapRegionLayout, Point } from './layout';

export type ManualOffsets = Record<string, Point>;
export type InspectionOffsets = Record<string, Point>;
const inspectionKinds = new Set(['external_benchmark', 'adversarial_audit']);

export interface ManualLayoutState {
  version: 3;
  organizationRevision: number | null;
  lineOffsets: ManualOffsets;
  teamOffsets: ManualOffsets;
  agentOffsets: ManualOffsets;
  inspectionOffsets: InspectionOffsets;
}

export interface AgentOrganizationMembership {
  lineId: string | null;
  teamId: string | null;
}

export interface ManualLayoutValidIds {
  lineIds: Set<string>;
  teamIds: Set<string>;
  agentIds: Set<string>;
}

const STORAGE_PREFIX = 'orquesta.desktop.map-layout.';

function storageKey(projectId: string): string {
  return `${STORAGE_PREFIX}${projectId}`;
}

function validPoint(value: unknown): value is Point {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<Point>;
  return Number.isFinite(candidate.x) && Number.isFinite(candidate.y);
}

function sanitizeOffsets(value: unknown): ManualOffsets {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, Point] => validPoint(entry[1])));
}

function sanitizeInspectionOffsets(value: unknown): InspectionOffsets {
  return Object.fromEntries(Object.entries(sanitizeOffsets(value)).filter(([kind]) => inspectionKinds.has(kind)));
}

function hasOffsets(state: ManualLayoutState): boolean {
  return Boolean(
    Object.keys(state.lineOffsets).length
    || Object.keys(state.teamOffsets).length
    || Object.keys(state.agentOffsets).length
    || Object.keys(state.inspectionOffsets).length
  );
}

function addPoints(...points: Array<Point | undefined>): Point {
  return points.reduce<Point>((sum, point) => point
    ? { x: sum.x + point.x, y: sum.y + point.y }
    : sum, { x: 0, y: 0 });
}

function translated(point: Point, offset: Point): Point {
  return { x: point.x + offset.x, y: point.y + offset.y };
}

export function createManualLayoutState(organizationRevision: number | null): ManualLayoutState {
  return {
    version: 3,
    organizationRevision,
    lineOffsets: {},
    teamOffsets: {},
    agentOffsets: {},
    inspectionOffsets: {}
  };
}

export function loadManualLayout(projectId: string, organizationRevision: number | null, storage: Storage): ManualLayoutState {
  const empty = createManualLayoutState(organizationRevision);
  try {
    const raw = storage.getItem(storageKey(projectId));
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return empty;
    const candidate = parsed as Partial<ManualLayoutState>;
    if (candidate.version === 3) {
      if (candidate.organizationRevision !== organizationRevision) return empty;
      return {
        ...empty,
        lineOffsets: sanitizeOffsets(candidate.lineOffsets),
        teamOffsets: sanitizeOffsets(candidate.teamOffsets),
        agentOffsets: sanitizeOffsets(candidate.agentOffsets),
        inspectionOffsets: sanitizeInspectionOffsets(candidate.inspectionOffsets)
      };
    }
    return organizationRevision === null ? { ...empty, agentOffsets: sanitizeOffsets(parsed) } : empty;
  } catch {
    return empty;
  }
}

export function saveManualLayout(projectId: string, state: ManualLayoutState, storage: Storage): void {
  const valid: ManualLayoutState = {
    version: 3,
    organizationRevision: Number.isInteger(state.organizationRevision) ? state.organizationRevision : null,
    lineOffsets: sanitizeOffsets(state.lineOffsets),
    teamOffsets: sanitizeOffsets(state.teamOffsets),
    agentOffsets: sanitizeOffsets(state.agentOffsets),
    inspectionOffsets: sanitizeInspectionOffsets(state.inspectionOffsets)
  };
  if (hasOffsets(valid)) storage.setItem(storageKey(projectId), JSON.stringify(valid));
  else storage.removeItem(storageKey(projectId));
}

export function pruneManualLayout(state: ManualLayoutState, validIds: ManualLayoutValidIds): ManualLayoutState {
  const keep = (offsets: ManualOffsets, ids: Set<string>): ManualOffsets => Object.fromEntries(
    Object.entries(offsets).filter(([id]) => ids.has(id))
  );
  return {
    ...state,
    lineOffsets: keep(state.lineOffsets, validIds.lineIds),
    teamOffsets: keep(state.teamOffsets, validIds.teamIds),
    agentOffsets: keep(state.agentOffsets, validIds.agentIds)
  };
}

export function loadManualOffsets(projectId: string, storage: Storage): ManualOffsets {
  try {
    const raw = storage.getItem(storageKey(projectId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    if ([2, 3].includes(Number((parsed as { version?: unknown }).version))) {
      return sanitizeOffsets((parsed as Partial<ManualLayoutState>).agentOffsets);
    }
    return sanitizeOffsets(parsed);
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

export function applyManualLayoutPositions(
  base: Map<string, Point>,
  state: ManualLayoutState,
  membershipByAgentId: Map<string, AgentOrganizationMembership>
): Map<string, Point> {
  const result = new Map<string, Point>();
  for (const [agentId, point] of base) {
    const membership = membershipByAgentId.get(agentId);
    const offset = addPoints(
      membership?.lineId ? state.lineOffsets[membership.lineId] : undefined,
      membership?.teamId ? state.teamOffsets[membership.teamId] : undefined,
      state.agentOffsets[agentId]
    );
    result.set(agentId, translated(point, offset));
  }
  return result;
}

function regionLookupKey(region: MapRegionLayout): string {
  return region.kind === 'line' ? `line:${region.id}` : region.id;
}

function rawTeamId(region: MapRegionLayout): string {
  return region.id.startsWith('team:') ? region.id.slice('team:'.length) : region.id;
}

export function applyManualLayoutRegions(regions: MapRegionLayout[], state: ManualLayoutState): MapRegionLayout[] {
  const byId = new Map(regions.map((region) => [regionLookupKey(region), region]));
  const offsetById = new Map<string, Point>();

  const resolveOffset = (region: MapRegionLayout, visiting = new Set<string>()): Point => {
    const key = regionLookupKey(region);
    const cached = offsetById.get(key);
    if (cached) return cached;
    if (visiting.has(key)) return { x: 0, y: 0 };
    const nextVisiting = new Set(visiting).add(key);
    const parent = region.parentId ? byId.get(region.parentId) : undefined;
    const inherited = parent ? resolveOffset(parent, nextVisiting) : { x: 0, y: 0 };
    const own = region.kind === 'line'
      ? state.lineOffsets[region.id]
      : region.kind === 'team'
        ? state.teamOffsets[rawTeamId(region)]
        : undefined;
    const result = addPoints(inherited, own);
    offsetById.set(key, result);
    return result;
  };

  return regions.map((region) => {
    const offset = resolveOffset(region);
    return {
      ...region,
      x: region.x + offset.x,
      y: region.y + offset.y,
      inputPort: translated(region.inputPort, offset)
    };
  });
}
