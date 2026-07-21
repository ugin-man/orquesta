import { Minus, Plus, RotateCcw, Scan, Search, ShieldAlert, UsersRound } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent } from 'react';
import type { AgentUiModel, InspectionKind, OrquestaUiSnapshot, TaskUiModel } from '../../../contracts/orquesta-ui';
import { AgentGlyph } from '../../components/AgentGlyph';
import { StatusDot } from '../../components/StatusDot';
import { useI18n } from '../i18n/I18nProvider';
import { tutorialTargetProps } from '../tutorial/home-tutorial-targets';
import { createStableLayout, edgePath, groupBoundsForPositions, type MapGroupLayout, type MapRegionLayout, type Point } from './layout';
import {
  applyManualLayoutPositions,
  applyManualLayoutRegions,
  clearManualOffsets,
  createManualLayoutState,
  loadManualLayout,
  pruneManualLayout,
  saveManualLayout,
  type ManualLayoutState
} from './manual-layout';
import './map.css';
import { inspectionPosition, inspectionScreenPosition } from './inspection-layout';

interface Camera { x: number; y: number; zoom: number }
interface Bounds { x: number; y: number; width: number; height: number }
interface PanDrag { pointerId: number; startX: number; startY: number; cameraX: number; cameraY: number; zoom: number }
interface AgentDrag { pointerId: number; agentId: string; startX: number; startY: number; origin: Point; zoom: number; moved: boolean }
interface RegionDrag { pointerId: number; kind: 'line' | 'team'; regionId: string; startX: number; startY: number; origin: Point; zoom: number; moved: boolean }
interface InspectionDrag { pointerId: number; inspectionKind: InspectionKind; startX: number; startY: number; origin: Point; zoom: number; moved: boolean }
type PendingPointerUpdate =
  | { kind: 'pan'; pointerId: number; camera: Camera }
  | { kind: 'agent'; pointerId: number; agentId: string; offset: Point }
  | { kind: 'region'; pointerId: number; regionKind: 'line' | 'team'; regionId: string; offset: Point }
  | { kind: 'inspection'; pointerId: number; inspectionKind: InspectionKind; offset: Point };
interface CapturedPointer { pointerId: number; target: HTMLElement }

export type SemanticZoomLevel = 'overview' | 'normal' | 'detail';

export function semanticLevelForZoom(zoom: number): SemanticZoomLevel {
  if (zoom < 0.24) return 'overview';
  if (zoom < 0.72) return 'normal';
  return 'detail';
}

export function interactionSizeForZoom(zoom: number, baseSize = 54): number {
  return clamp(baseSize * visualScaleForZoom(zoom), 24, baseSize);
}

export function visualScaleForZoom(zoom: number): number {
  return semanticLevelForZoom(zoom) === 'overview'
    ? clamp(zoom / 0.72, 0.36, 0.55)
    : clamp(zoom / 0.52, 0.55, 1);
}

export function compactAgentName(displayName: string): string {
  const normalized = displayName.trim().toUpperCase();
  const numbered = normalized.match(/^(.*?)\s+(\d+)$/u);
  if (numbered) return `${Array.from(numbered[1]).slice(0, 5).join('')} ${numbered[2]}`;
  return Array.from(normalized).slice(0, 8).join('');
}

export function worldToScreen(point: Point, camera: Camera): Point {
  return { x: camera.x + point.x * camera.zoom, y: camera.y + point.y * camera.zoom };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isActiveTask(task: TaskUiModel | undefined, online: boolean): boolean {
  return Boolean(online && task && (task.turnStarted || task.progressObserved));
}

export function fitCamera(viewport: DOMRect | { width: number; height: number }, world: { width: number; height: number }, padding = 42): Camera {
  const availableWidth = Math.max(1, viewport.width - padding * 2);
  const availableHeight = Math.max(1, viewport.height - padding * 2);
  const zoom = clamp(Math.min(availableWidth / world.width, availableHeight / world.height), 0.14, 1.16);
  return {
    zoom,
    x: padding + (availableWidth - world.width * zoom) / 2,
    y: padding + (availableHeight - world.height * zoom) / 2
  };
}

function fitBounds(viewport: DOMRect | { width: number; height: number }, bounds: Bounds): Camera {
  const circularInset = Math.max(54, Math.min(viewport.width, viewport.height) * 0.155);
  const side = circularInset;
  const top = Math.max(96, circularInset);
  const bottom = Math.max(96, circularInset);
  const availableWidth = Math.max(1, viewport.width - side * 2);
  const availableHeight = Math.max(1, viewport.height - top - bottom);
  const zoom = clamp(Math.min(availableWidth / bounds.width, availableHeight / bounds.height), 0.14, 1.16);
  return {
    zoom,
    x: side + (availableWidth - bounds.width * zoom) / 2 - bounds.x * zoom,
    y: top - bounds.y * zoom
  };
}

function mapStatusText(agent: AgentUiModel): string {
  return agent.statusLabel || agent.status.replaceAll('_', ' ');
}

function shortRole(agent: AgentUiModel): string {
  const value = agent.role.trim() || agent.roleSummary.trim();
  return Array.from(value).slice(0, 22).join('');
}

function contentBounds(user: Point, positions: Map<string, Point>, groups: MapGroupLayout[], regions: MapRegionLayout[], nodeWidth: number, nodeHeight: number, extraPoints: Point[] = []): Bounds {
  const left = [user.x - nodeWidth / 2, ...[...positions.values()].map((point) => point.x - nodeWidth / 2), ...extraPoints.map((point) => point.x - 63), ...groups.map((group) => group.x), ...regions.map((region) => region.x)];
  const right = [user.x + nodeWidth / 2, ...[...positions.values()].map((point) => point.x + nodeWidth / 2), ...extraPoints.map((point) => point.x + 63), ...groups.map((group) => group.x + group.width), ...regions.map((region) => region.x + region.width)];
  const top = [user.y - nodeHeight / 2, ...[...positions.values()].map((point) => point.y - nodeHeight / 2), ...extraPoints.map((point) => point.y - 70), ...groups.map((group) => group.y), ...regions.map((region) => region.y)];
  const bottom = [user.y + nodeHeight / 2, ...[...positions.values()].map((point) => point.y + nodeHeight / 2), ...extraPoints.map((point) => point.y + 70), ...groups.map((group) => group.y + group.height), ...regions.map((region) => region.y + region.height)];
  const x = Math.min(...left);
  const y = Math.min(...top);
  return { x, y, width: Math.max(...right) - x, height: Math.max(...bottom) - y };
}

export function MapViewport({
  snapshot,
  selectedAgentId,
  selectedTaskId,
  reducedMotion,
  onSelectAgent,
  onSelectTask,
  onSelectInspection,
  onClearSelection,
  onOpenTeam
}: {
  snapshot: OrquestaUiSnapshot;
  selectedAgentId: string | null;
  selectedTaskId: string | null;
  reducedMotion: boolean;
  onSelectAgent(agentId: string): void;
  onSelectTask(taskId: string): void;
  onSelectInspection(runId: string): void;
  onClearSelection(): void;
  onOpenTeam(): void;
}) {
  const { t } = useI18n();
  const viewportRef = useRef<HTMLDivElement>(null);
  const rosterLayoutKey = snapshot.organization?.source === 'explicit'
    ? `${snapshot.project.id}:organization:${snapshot.organization.revision}:${snapshot.agents.map((agent) => `${agent.id}:${agent.lineId ?? ''}:${agent.teamId ?? ''}:${agent.position ?? ''}`).join('|')}`
    : `${snapshot.project.id}:legacy:${snapshot.agents.map((agent) => `${agent.id}:${agent.assignedByAgentId ?? ''}`).join('|')}`;
  const layout = useMemo(() => createStableLayout(snapshot), [rosterLayoutKey]);
  const organizationRevision = snapshot.organization?.source === 'explicit' ? snapshot.organization.revision : null;
  const validManualLayoutIds = {
    lineIds: new Set(snapshot.organization?.lines.map((line) => line.id) ?? []),
    teamIds: new Set(snapshot.organization?.teams.map((team) => team.id) ?? []),
    agentIds: new Set(snapshot.agents.map((agent) => agent.id))
  };
  const manualStructureKey = `${[...validManualLayoutIds.lineIds].join('|')}::${[...validManualLayoutIds.teamIds].join('|')}::${[...validManualLayoutIds.agentIds].join('|')}`;
  const manualLoadKey = `${snapshot.project.id}:${organizationRevision ?? 'legacy'}:${manualStructureKey}`;
  const [manualLayout, setManualLayout] = useState<ManualLayoutState>(() => pruneManualLayout(
    loadManualLayout(snapshot.project.id, organizationRevision, window.localStorage),
    validManualLayoutIds
  ));
  const manualLayoutRef = useRef(manualLayout);
  const loadedManualLayoutKeyRef = useRef(manualLoadKey);
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, zoom: 0.72 });
  const [panDrag, setPanDrag] = useState<PanDrag | null>(null);
  const [agentDrag, setAgentDrag] = useState<AgentDrag | null>(null);
  const [regionDrag, setRegionDrag] = useState<RegionDrag | null>(null);
  const [inspectionDrag, setInspectionDrag] = useState<InspectionDrag | null>(null);
  const panDragRef = useRef<PanDrag | null>(null);
  const agentDragRef = useRef<AgentDrag | null>(null);
  const regionDragRef = useRef<RegionDrag | null>(null);
  const inspectionDragRef = useRef<InspectionDrag | null>(null);
  const suppressClickRef = useRef<{ type: 'agent'; id: string } | { type: 'inspection'; kind: InspectionKind } | null>(null);
  const capturedPointerRef = useRef<CapturedPointer | null>(null);
  const pendingPointerUpdateRef = useRef<PendingPointerUpdate | null>(null);
  const pointerFrameRef = useRef<number | null>(null);
  const online = snapshot.project.status !== 'offline';
  const semanticLevel = semanticLevelForZoom(camera.zoom);

  const applyPointerUpdate = useCallback((update: PendingPointerUpdate) => {
    if (update.kind === 'pan') {
      if (panDragRef.current?.pointerId === update.pointerId) setCamera(update.camera);
      return;
    }
    if (update.kind === 'agent') {
      if (agentDragRef.current?.pointerId !== update.pointerId || agentDragRef.current.agentId !== update.agentId) return;
      setManualLayout((current) => {
        const next = { ...current, agentOffsets: { ...current.agentOffsets, [update.agentId]: update.offset } };
        manualLayoutRef.current = next;
        return next;
      });
      return;
    }
    if (update.kind === 'inspection') {
      if (inspectionDragRef.current?.pointerId !== update.pointerId || inspectionDragRef.current.inspectionKind !== update.inspectionKind) return;
      setManualLayout((current) => {
        const next = { ...current, inspectionOffsets: { ...current.inspectionOffsets, [update.inspectionKind]: update.offset } };
        manualLayoutRef.current = next;
        return next;
      });
      return;
    }
    const drag = regionDragRef.current;
    if (!drag || drag.pointerId !== update.pointerId || drag.kind !== update.regionKind || drag.regionId !== update.regionId) return;
    setManualLayout((current) => {
      const bucket = update.regionKind === 'line' ? 'lineOffsets' : 'teamOffsets';
      const next = { ...current, [bucket]: { ...current[bucket], [update.regionId]: update.offset } };
      manualLayoutRef.current = next;
      return next;
    });
  }, []);

  const schedulePointerFrame = useCallback((update: PendingPointerUpdate) => {
    pendingPointerUpdateRef.current = update;
    if (pointerFrameRef.current !== null) return;
    pointerFrameRef.current = requestAnimationFrame(() => {
      pointerFrameRef.current = null;
      const pending = pendingPointerUpdateRef.current;
      pendingPointerUpdateRef.current = null;
      if (pending) applyPointerUpdate(pending);
    });
  }, [applyPointerUpdate]);

  const releaseCapturedPointer = useCallback((pointerId?: number) => {
    const captured = capturedPointerRef.current;
    if (!captured || (pointerId !== undefined && captured.pointerId !== pointerId)) return;
    try {
      captured.target.releasePointerCapture?.(captured.pointerId);
    } catch {
      // Chromium may already have released capture while the terminal event was dispatched.
    }
    capturedPointerRef.current = null;
  }, []);

  const finishPointerInteraction = useCallback((pointerId?: number, renderState = true, suppressNextClick = false) => {
    const pan = panDragRef.current;
    const agent = agentDragRef.current;
    const region = regionDragRef.current;
    const inspection = inspectionDragRef.current;
    if (pointerId !== undefined && pan?.pointerId !== pointerId && agent?.pointerId !== pointerId && region?.pointerId !== pointerId && inspection?.pointerId !== pointerId) return;

    if (pointerFrameRef.current !== null) cancelAnimationFrame(pointerFrameRef.current);
    pointerFrameRef.current = null;
    const pending = pendingPointerUpdateRef.current;
    pendingPointerUpdateRef.current = null;

    if (pending?.kind === 'pan' && pan?.pointerId === pending.pointerId && renderState) {
      setCamera(pending.camera);
    }
    if (agent) {
      let state = manualLayoutRef.current;
      if (agent.moved) {
        if (pending?.kind === 'agent' && pending.pointerId === agent.pointerId && pending.agentId === agent.agentId) {
          state = { ...state, agentOffsets: { ...state.agentOffsets, [agent.agentId]: pending.offset } };
          manualLayoutRef.current = state;
          if (renderState) setManualLayout(state);
        }
        saveManualLayout(snapshot.project.id, state, window.localStorage);
      }
      suppressClickRef.current = agent.moved && suppressNextClick ? { type: 'agent', id: agent.agentId } : null;
      agentDragRef.current = null;
      if (renderState) setAgentDrag(null);
    }
    if (region) {
      let state = manualLayoutRef.current;
      if (region.moved) {
        if (pending?.kind === 'region' && pending.pointerId === region.pointerId && pending.regionId === region.regionId && pending.regionKind === region.kind) {
          const bucket = region.kind === 'line' ? 'lineOffsets' : 'teamOffsets';
          state = { ...state, [bucket]: { ...state[bucket], [region.regionId]: pending.offset } };
          manualLayoutRef.current = state;
          if (renderState) setManualLayout(state);
        }
        saveManualLayout(snapshot.project.id, state, window.localStorage);
      }
      regionDragRef.current = null;
      if (renderState) setRegionDrag(null);
    }
    if (inspection) {
      let state = manualLayoutRef.current;
      if (inspection.moved) {
        if (pending?.kind === 'inspection' && pending.pointerId === inspection.pointerId && pending.inspectionKind === inspection.inspectionKind) {
          state = { ...state, inspectionOffsets: { ...state.inspectionOffsets, [inspection.inspectionKind]: pending.offset } };
          manualLayoutRef.current = state;
          if (renderState) setManualLayout(state);
        }
        saveManualLayout(snapshot.project.id, state, window.localStorage);
      }
      suppressClickRef.current = inspection.moved && suppressNextClick ? { type: 'inspection', kind: inspection.inspectionKind } : null;
      inspectionDragRef.current = null;
      if (renderState) setInspectionDrag(null);
    }
    if (pan) {
      panDragRef.current = null;
      if (renderState) setPanDrag(null);
    }
    releaseCapturedPointer(pointerId);
  }, [releaseCapturedPointer, snapshot.project.id]);

  useEffect(() => {
    if (loadedManualLayoutKeyRef.current === manualLoadKey) return;
    loadedManualLayoutKeyRef.current = manualLoadKey;
    const loaded = pruneManualLayout(loadManualLayout(snapshot.project.id, organizationRevision, window.localStorage), {
      lineIds: new Set(snapshot.organization?.lines.map((line) => line.id) ?? []),
      teamIds: new Set(snapshot.organization?.teams.map((team) => team.id) ?? []),
      agentIds: new Set(snapshot.agents.map((agent) => agent.id))
    });
    manualLayoutRef.current = loaded;
    setManualLayout(loaded);
  }, [manualLoadKey, organizationRevision, snapshot.agents, snapshot.organization?.lines, snapshot.organization?.teams, snapshot.project.id]);
  const membershipByAgentId = useMemo(() => new Map(snapshot.agents.map((agent) => [agent.id, {
    lineId: agent.lineId ?? null,
    teamId: agent.teamId ?? null
  }])), [snapshot.agents]);
  const effectivePositions = useMemo(
    () => applyManualLayoutPositions(layout.agentPositions, manualLayout, membershipByAgentId),
    [layout.agentPositions, manualLayout, membershipByAgentId]
  );
  const effectiveGroups = useMemo(
    () => layout.groups.map((group) => groupBoundsForPositions(group, effectivePositions, layout.nodeWidth, layout.nodeHeight)),
    [effectivePositions, layout.groups, layout.nodeHeight, layout.nodeWidth]
  );
  const effectiveRegions = useMemo(() => applyManualLayoutRegions(layout.regions, manualLayout), [layout.regions, manualLayout]);
  const teamLeadAgentIds = useMemo(() => new Set(layout.organization.lines.flatMap((line) => line.teams.flatMap((team) => team.leadAgentId ? [team.leadAgentId] : []))), [layout.organization.lines]);
  const activeInspectionRuns = useMemo(() => {
    const activeStatuses = new Set(['queued', 'running', 'cancelling']);
    return (['external_benchmark', 'adversarial_audit'] as const).flatMap((kind) => {
      const run = snapshot.inspectionRuns.find((candidate) => candidate.kind === kind && activeStatuses.has(candidate.status));
      return run ? [run] : [];
    });
  }, [snapshot.inspectionRuns]);
  const orchestratorPoint = effectivePositions.get('orchestrator') ?? null;
  const inspectionNodes = useMemo(() => orchestratorPoint ? activeInspectionRuns.map((run) => ({
    run,
    from: orchestratorPoint,
    point: (() => {
      const point = inspectionPosition(run.kind, orchestratorPoint, 126);
      const offset = manualLayout.inspectionOffsets[run.kind] ?? { x: 0, y: 0 };
      return { x: point.x + offset.x, y: point.y + offset.y };
    })()
  })) : [], [activeInspectionRuns, manualLayout.inspectionOffsets, orchestratorPoint]);
  const visibleRegions = useMemo(() => {
    const framedTeamIds = new Set(effectiveRegions
      .filter((region) => region.kind === 'team' && region.agentIds.length >= 3)
      .map((region) => region.id));
    const roleCountByParent = new Map<string, number>();
    for (const region of effectiveRegions) {
      if (region.kind !== 'role' || !region.parentId) continue;
      roleCountByParent.set(region.parentId, (roleCountByParent.get(region.parentId) ?? 0) + 1);
    }
    return effectiveRegions.filter((region) => {
      if (region.kind === 'line') return false;
      if (region.kind === 'team') return framedTeamIds.has(region.id);
      if (region.kind === 'role') return Boolean(region.parentId && framedTeamIds.has(region.parentId) && (roleCountByParent.get(region.parentId) ?? 0) > 1);
      return true;
    });
  }, [effectiveRegions]);
  const bounds = useMemo(
    () => contentBounds(layout.user, effectivePositions, effectiveGroups, visibleRegions, layout.nodeWidth, layout.nodeHeight, inspectionNodes.map((node) => node.point)),
    [effectiveGroups, effectivePositions, inspectionNodes, layout.nodeHeight, layout.nodeWidth, layout.user, visibleRegions]
  );

  const applyFit = useCallback(() => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (rect) setCamera(fitBounds(rect, bounds));
  }, [bounds]);
  const applyFitRef = useRef(applyFit);
  applyFitRef.current = applyFit;

  const fitLayoutKey = `${rosterLayoutKey}:inspections:${activeInspectionRuns.map((run) => run.kind).join('|')}`;
  const fittedLayoutKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (fittedLayoutKeyRef.current === fitLayoutKey) return;
    let pending = true;
    const frame = requestAnimationFrame(() => {
      pending = false;
      fittedLayoutKeyRef.current = fitLayoutKey;
      applyFitRef.current();
    });
    return () => {
      if (pending) cancelAnimationFrame(frame);
    };
  }, [fitLayoutKey]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(() => applyFitRef.current());
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [snapshot.project.id]);

  useEffect(() => {
    const handleBlur = () => finishPointerInteraction();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') finishPointerInteraction();
    };
    window.addEventListener('blur', handleBlur);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('blur', handleBlur);
      window.removeEventListener('keydown', handleKeyDown);
      finishPointerInteraction(undefined, false);
    };
  }, [finishPointerInteraction]);

  const taskById = useMemo(() => new Map(snapshot.tasks.map((task) => [task.id, task])), [snapshot.tasks]);
  const groupById = useMemo(() => new Map(effectiveGroups.map((group) => [group.id, group])), [effectiveGroups]);
  const regionByEdgeId = useMemo(() => new Map(effectiveRegions.map((region) => [
    region.kind === 'line' ? `line:${region.id}` : region.id,
    region
  ])), [effectiveRegions]);
  const effectiveEdges = useMemo(() => layout.edges.map((edge) => {
    const parentGroupId = edge.parentId.startsWith('group:') ? edge.parentId.slice(6) : null;
    const parentRegion = regionByEdgeId.get(edge.parentId);
    const parent = edge.parentId === 'user'
      ? layout.user
      : parentGroupId
        ? groupById.get(parentGroupId as MapGroupLayout['id'])?.anchor ?? edge.from
        : parentRegion?.inputPort ?? effectivePositions.get(edge.parentId) ?? edge.from;
    const groupId = edge.childId.startsWith('group:') ? edge.childId.slice(6) : null;
    const childRegion = regionByEdgeId.get(edge.childId);
    const childPoint = groupId ? groupById.get(groupId as MapGroupLayout['id'])?.anchor : childRegion?.inputPort ?? effectivePositions.get(edge.childId);
    const child = parentGroupId && childPoint
      ? { x: childPoint.x, y: childPoint.y - layout.nodeHeight / 2 }
      : childPoint;
    return { ...edge, from: parent, to: child ?? edge.to };
  }), [effectivePositions, groupById, layout.edges, layout.nodeHeight, layout.user, regionByEdgeId]);

  const currentEdges = useMemo(() => snapshot.agents.flatMap((agent) => {
    if (!agent.currentTaskId) return [];
    const task = taskById.get(agent.currentTaskId);
    const to = effectivePositions.get(agent.id);
    if (!task || !to) return [];
    const from = agent.id === 'orchestrator'
      ? layout.user
      : effectivePositions.get(task.assignedByAgentId ?? 'orchestrator') ?? effectivePositions.get('orchestrator') ?? layout.center;
    return [{ agentId: agent.id, task, from, to }];
  }), [effectivePositions, layout.center, layout.user, snapshot.agents, taskById]);

  const connectedAgentIds = useMemo(() => {
    const ids = new Set<string>();
    if (selectedAgentId) {
      ids.add(selectedAgentId);
      for (const task of snapshot.tasks) {
        if (task.ownerAgentId === selectedAgentId || task.assignedByAgentId === selectedAgentId) {
          if (task.ownerAgentId) ids.add(task.ownerAgentId);
          if (task.assignedByAgentId && task.assignedByAgentId !== 'user') ids.add(task.assignedByAgentId);
        }
      }
    }
    if (selectedTaskId) {
      const task = taskById.get(selectedTaskId);
      if (task?.ownerAgentId) ids.add(task.ownerAgentId);
      if (task?.assignedByAgentId && task.assignedByAgentId !== 'user') ids.add(task.assignedByAgentId);
    }
    return ids;
  }, [selectedAgentId, selectedTaskId, snapshot.tasks, taskById]);

  const zoomAt = (nextZoom: number, anchor?: Point) => {
    setCamera((current) => {
      const zoom = clamp(nextZoom, 0.14, 1.9);
      if (!anchor) return { ...current, zoom };
      const worldX = (anchor.x - current.x) / current.zoom;
      const worldY = (anchor.y - current.y) / current.zoom;
      return { zoom, x: anchor.x - worldX * zoom, y: anchor.y - worldY * zoom };
    });
  };

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    zoomAt(camera.zoom * Math.exp(-event.deltaY * 0.0011), { x: event.clientX - rect.left, y: event.clientY - rect.top });
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button, [role="dialog"]')) return;
    finishPointerInteraction();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    capturedPointerRef.current = { pointerId: event.pointerId, target: event.currentTarget };
    const drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, cameraX: camera.x, cameraY: camera.y, zoom: camera.zoom };
    panDragRef.current = drag;
    setPanDrag(drag);
    onClearSelection();
  };

  const handleAgentPointerDown = (event: ReactPointerEvent<HTMLButtonElement>, agentId: string) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    finishPointerInteraction();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    capturedPointerRef.current = { pointerId: event.pointerId, target: event.currentTarget };
    const drag = { pointerId: event.pointerId, agentId, startX: event.clientX, startY: event.clientY, origin: manualLayoutRef.current.agentOffsets[agentId] ?? { x: 0, y: 0 }, zoom: camera.zoom, moved: false };
    agentDragRef.current = drag;
    setAgentDrag({ ...drag });
  };

  const handleRegionPointerDown = (event: ReactPointerEvent<HTMLButtonElement>, kind: 'line' | 'team', regionId: string) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    finishPointerInteraction();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    capturedPointerRef.current = { pointerId: event.pointerId, target: event.currentTarget };
    const bucket = kind === 'line' ? manualLayoutRef.current.lineOffsets : manualLayoutRef.current.teamOffsets;
    const drag = {
      pointerId: event.pointerId,
      kind,
      regionId,
      startX: event.clientX,
      startY: event.clientY,
      origin: bucket[regionId] ?? { x: 0, y: 0 },
      zoom: camera.zoom,
      moved: false
    };
    regionDragRef.current = drag;
    setRegionDrag({ ...drag });
  };

  const handleInspectionPointerDown = (event: ReactPointerEvent<HTMLButtonElement>, inspectionKind: InspectionKind) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    finishPointerInteraction();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    capturedPointerRef.current = { pointerId: event.pointerId, target: event.currentTarget };
    const drag = {
      pointerId: event.pointerId,
      inspectionKind,
      startX: event.clientX,
      startY: event.clientY,
      origin: manualLayoutRef.current.inspectionOffsets[inspectionKind] ?? { x: 0, y: 0 },
      zoom: camera.zoom,
      moved: false
    };
    inspectionDragRef.current = drag;
    setInspectionDrag({ ...drag });
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const draggedAgent = agentDragRef.current;
    if (draggedAgent?.pointerId === event.pointerId) {
      const screenDx = event.clientX - draggedAgent.startX;
      const screenDy = event.clientY - draggedAgent.startY;
      if (!draggedAgent.moved && Math.hypot(screenDx, screenDy) <= 4) return;
      draggedAgent.moved = true;
      schedulePointerFrame({
        kind: 'agent',
        pointerId: event.pointerId,
        agentId: draggedAgent.agentId,
        offset: {
          x: draggedAgent.origin.x + screenDx / draggedAgent.zoom,
          y: draggedAgent.origin.y + screenDy / draggedAgent.zoom
        }
      });
      return;
    }
    const draggedRegion = regionDragRef.current;
    if (draggedRegion?.pointerId === event.pointerId) {
      const screenDx = event.clientX - draggedRegion.startX;
      const screenDy = event.clientY - draggedRegion.startY;
      if (!draggedRegion.moved && Math.hypot(screenDx, screenDy) <= 4) return;
      draggedRegion.moved = true;
      schedulePointerFrame({
        kind: 'region',
        pointerId: event.pointerId,
        regionKind: draggedRegion.kind,
        regionId: draggedRegion.regionId,
        offset: {
          x: draggedRegion.origin.x + screenDx / draggedRegion.zoom,
          y: draggedRegion.origin.y + screenDy / draggedRegion.zoom
        }
      });
      return;
    }
    const draggedInspection = inspectionDragRef.current;
    if (draggedInspection?.pointerId === event.pointerId) {
      const screenDx = event.clientX - draggedInspection.startX;
      const screenDy = event.clientY - draggedInspection.startY;
      if (!draggedInspection.moved && Math.hypot(screenDx, screenDy) <= 4) return;
      draggedInspection.moved = true;
      schedulePointerFrame({
        kind: 'inspection',
        pointerId: event.pointerId,
        inspectionKind: draggedInspection.inspectionKind,
        offset: {
          x: draggedInspection.origin.x + screenDx / draggedInspection.zoom,
          y: draggedInspection.origin.y + screenDy / draggedInspection.zoom
        }
      });
      return;
    }
    const draggedMap = panDragRef.current;
    if (!draggedMap || draggedMap.pointerId !== event.pointerId) return;
    schedulePointerFrame({
      kind: 'pan',
      pointerId: event.pointerId,
      camera: {
        zoom: draggedMap.zoom,
        x: draggedMap.cameraX + event.clientX - draggedMap.startX,
        y: draggedMap.cameraY + event.clientY - draggedMap.startY
      }
    });
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    finishPointerInteraction(event.pointerId, true, true);
  };

  const handlePointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    finishPointerInteraction(event.pointerId);
  };

  const focusPoint = (point: Point) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    const zoom = Math.max(camera.zoom, layout.compact ? 0.72 : 1.02);
    setCamera({ zoom, x: rect.width / 2 - point.x * zoom, y: rect.height / 2 - point.y * zoom });
  };

  const resetLayout = () => {
    clearManualOffsets(snapshot.project.id, window.localStorage);
    const reset = createManualLayoutState(organizationRevision);
    manualLayoutRef.current = reset;
    setManualLayout(reset);
    requestAnimationFrame(() => {
      const rect = viewportRef.current?.getBoundingClientRect();
      if (rect) setCamera(fitBounds(rect, contentBounds(layout.user, layout.agentPositions, layout.groups, visibleRegions, layout.nodeWidth, layout.nodeHeight, inspectionNodes.map((node) => node.point))));
    });
  };

  return (
    <section
      ref={viewportRef}
      {...tutorialTargetProps('map')}
      className={`map-viewport${panDrag ? ' is-dragging' : ''}`}
      aria-label="Orquesta Map"
      data-semantic-level={semanticLevel}
      data-hierarchy-diagnostics={layout.hierarchy.diagnostics.length}
      data-organization-diagnostics={layout.organization.sourceDiagnostics.length + layout.organization.unassignedAgentIds.length}
      data-map-layout={layout.organization.source === 'explicit' ? 'adaptive' : 'legacy'}
      onWheel={handleWheel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
    >
      <svg
        className={`map-orbit${reducedMotion ? ' is-reduced-motion' : ''}`}
        data-testid="map-orbit"
        viewBox="0 0 100 100"
        aria-hidden="true"
      >
        <circle className="map-orbit__arc map-orbit__arc--outer" cx="50" cy="50" r="49.1" pathLength="100" />
        <circle className="map-orbit__arc map-orbit__arc--middle" cx="50" cy="50" r="48.1" pathLength="100" />
        <circle className="map-orbit__arc map-orbit__arc--inner" cx="50" cy="50" r="47.1" pathLength="100" />
      </svg>

      <div className="map-world" data-zoom={camera.zoom.toFixed(2)}>
        <svg className="map-geometry" aria-hidden="true">
          {visibleRegions.filter((region) => ['line', 'team', 'role', 'proposal', 'diagnostic'].includes(region.kind)).map((region) => {
            const topLeft = worldToScreen({ x: region.x, y: region.y }, camera);
            const lineId = region.kind === 'line' ? region.id : undefined;
            const teamId = region.kind === 'team' ? region.id.slice('team:'.length) : undefined;
            const proposalId = region.kind === 'proposal' ? region.id.slice('proposal:'.length) : undefined;
            const roleId = region.kind === 'role' ? region.label : undefined;
            const labelScreenSize = region.kind === 'line' ? 10 : region.kind === 'team' || region.kind === 'role' ? 8 : 9;
            return (
              <g
                key={region.id}
                className={`map-region map-region--${region.kind}`}
                data-region-kind={region.kind}
                data-line-id={lineId}
                data-team-id={teamId}
                data-role-id={roleId}
                data-proposal-id={proposalId}
                transform={`translate(${topLeft.x} ${topLeft.y}) scale(${camera.zoom})`}
              >
                <rect x={0} y={0} width={region.width} height={region.height} rx={region.kind === 'line' ? 28 : 18} />
                <text x={18} y={region.kind === 'line' ? 25 : 22} style={{ fontSize: labelScreenSize / camera.zoom }}>{region.label}</text>
                {region.kind === 'line' && region.meta ? <text className="map-region__meta" x={18} y={45} style={{ fontSize: 7 / camera.zoom }}>{region.meta}</text> : null}
                {region.kind === 'proposal' ? <text className="map-region__meta" x={18} y={47} style={{ fontSize: 8 / camera.zoom }}>Awaiting user approval</text> : null}
                {region.kind === 'diagnostic' ? <text className="map-region__meta" x={18} y={47} style={{ fontSize: 8 / camera.zoom }}>{region.agentIds.length} agent{region.agentIds.length === 1 ? '' : 's'} need placement</text> : null}
              </g>
            );
          })}
          {effectiveGroups.filter((group) => group.agentIds.length > 1).map((group) => {
            const topLeft = worldToScreen({ x: group.x, y: group.y }, camera);
            return (
              <g key={`group-${group.id}`} className="map-group" transform={`translate(${topLeft.x} ${topLeft.y}) scale(${camera.zoom})`}>
                <rect x={0} y={0} width={group.width} height={group.height} rx={22} />
                <text x={14} y={19}>{group.id.toUpperCase()}</text>
              </g>
            );
          })}
          {effectiveEdges.map(({ id, from, to, kind, lineId, teamId, responsibleAgentId }) => (
            <path key={id} className={`map-edge map-edge--base map-edge--${kind}`} data-line-branch-edge={lineId} data-team-branch-edge={teamId} data-responsible-agent-id={responsibleAgentId} d={edgePath(worldToScreen(from, camera), worldToScreen(to, camera))} />
          ))}
          {inspectionNodes.map(({ run, from, point }) => {
            const fromScreen = worldToScreen(from, camera);
            const basePoint = inspectionPosition(run.kind, from, 126);
            const toScreenBase = inspectionScreenPosition(run.kind, fromScreen, camera.zoom, visualScaleForZoom(camera.zoom));
            const toScreen = {
              x: toScreenBase.x + (point.x - basePoint.x) * camera.zoom,
              y: toScreenBase.y + (point.y - basePoint.y) * camera.zoom
            };
            return (
              <path
                key={`inspection-edge-${run.runId}`}
                data-testid="inspection-edge"
                className={`map-edge map-edge--inspection map-edge--inspection-${run.kind === 'external_benchmark' ? 'blue' : 'red'}`}
                d={edgePath(fromScreen, toScreen, 'horizontal')}
              />
            );
          })}
          {currentEdges.filter(({ agentId, task }) => selectedTaskId === task.id
            || selectedAgentId === agentId
            || selectedAgentId === task.ownerAgentId
            || selectedAgentId === task.assignedByAgentId).map(({ task, from, to }) => {
            const active = isActiveTask(task, online);
            return (
              <g key={`edge-${task.id}`}>
                <path className={`map-edge map-edge--task${active ? ' is-active' : ''}${selectedTaskId === task.id ? ' is-selected' : ''}`} d={edgePath(worldToScreen(from, camera), worldToScreen(to, camera))} />
                {active && !reducedMotion ? <path className="map-edge-flow" d={edgePath(worldToScreen(from, camera), worldToScreen(to, camera))} /> : null}
              </g>
            );
          })}
        </svg>

        {effectiveRegions.filter((region) => region.kind === 'line' || (region.kind === 'team' && region.agentIds.length >= 3)).map((region) => {
          if (region.kind === 'line') {
            const responsiblePoint = region.responsibleAgentId ? effectivePositions.get(region.responsibleAgentId) : null;
            if (!responsiblePoint || !region.responsibleAgentId) return null;
            const screen = worldToScreen({ x: region.x + region.width / 2, y: region.y }, camera);
            const moving = regionDrag?.kind === 'line' && regionDrag.regionId === region.id;
            return (
              <button
                key={`branch-${region.id}`}
                type="button"
                className={`map-line-branch${moving ? ' is-moving' : ''}`}
                data-line-branch={region.id}
                data-region-drag-handle="line"
                data-region-id={region.id}
                data-responsible-agent-id={region.responsibleAgentId}
                style={{ left: screen.x, top: screen.y - Math.max(70, 90 * camera.zoom) }}
                aria-label={`Move line ${region.label}`}
                onPointerDown={(event) => handleRegionPointerDown(event, 'line', region.id)}
              >{region.label}</button>
            );
          }
          const topLeft = worldToScreen({ x: region.x, y: region.y }, camera);
          const regionId = region.kind === 'team' && region.id.startsWith('team:')
            ? region.id.slice('team:'.length)
            : region.id;
          const moving = regionDrag?.kind === region.kind && regionDrag.regionId === regionId;
          return (
            <button
              key={`drag-${region.kind}-${regionId}`}
              type="button"
              className={`map-region-drag-handle${moving ? ' is-moving' : ''}`}
              data-region-drag-handle={region.kind}
              data-region-id={regionId}
              style={{
                left: topLeft.x,
                top: topLeft.y,
                width: region.width * camera.zoom,
                height: Math.max(22, region.headerHeight * camera.zoom)
              }}
              aria-label={`Move ${region.kind} ${region.label}`}
              onPointerDown={(event) => handleRegionPointerDown(event, region.kind as 'line' | 'team', regionId)}
            />
          );
        })}

        <div className="map-user-node" style={{ left: worldToScreen(layout.user, camera).x, top: worldToScreen(layout.user, camera).y }}>
          <span className="agent-node__icon"><AgentGlyph iconKey="user" size={30} /></span>
          <strong>YOU</strong><small>Human</small>
        </div>

        {snapshot.agents.map((agent) => {
          const point = effectivePositions.get(agent.id);
          if (!point) return null;
          const screenPoint = worldToScreen(point, camera);
          const selected = selectedAgentId === agent.id;
          const dimmed = Boolean((selectedAgentId || selectedTaskId) && !selected && !connectedAgentIds.has(agent.id));
            const activeTask = agent.currentTaskId ? taskById.get(agent.currentTaskId) : undefined;
            const motion = isActiveTask(activeTask, online) && !reducedMotion;
            const visualScale = visualScaleForZoom(camera.zoom);
            const visualBaseSize = agent.id === 'orchestrator' ? 66 : 54;
            const interactionSize = interactionSizeForZoom(camera.zoom, visualBaseSize);
          return (
            <button
              key={agent.id}
              type="button"
              data-node-kind="agent"
              data-agent-id={agent.id}
              data-lifecycle-state={agent.lifecycleState ?? 'unknown'}
              data-operational-status={agent.operationalStatus ?? 'unknown'}
              data-position={agent.position ?? 'member'}
              data-line-id={agent.lineId ?? undefined}
              data-team-id={agent.teamId ?? undefined}
              data-team-lead={teamLeadAgentIds.has(agent.id) ? 'true' : undefined}
              className={`agent-node${agent.id === 'orchestrator' ? ' agent-node--orchestrator' : ''}${selected ? ' is-selected' : ''}${dimmed ? ' is-dimmed' : ''}${motion ? ' agent-node--motion' : ''}${agentDrag?.agentId === agent.id ? ' is-moving' : ''}`}
              style={{ left: screenPoint.x, top: screenPoint.y, width: interactionSize, height: interactionSize, minHeight: interactionSize }}
              aria-label={`${agent.displayName}, ${mapStatusText(agent)}`}
              onPointerDown={(event) => handleAgentPointerDown(event, agent.id)}
              onClick={(event) => {
                event.stopPropagation();
                if (suppressClickRef.current?.type === 'agent' && suppressClickRef.current.id === agent.id) { suppressClickRef.current = null; return; }
                onSelectAgent(agent.id);
              }}
              onDoubleClick={(event) => { event.stopPropagation(); focusPoint(point); }}
            >
              <span className="agent-node__visual" style={{ transform: `translate(-50%, -50%) scale(${visualScale})` }}>
                <span className="agent-node__icon"><AgentGlyph iconKey={agent.iconKey} size={agent.id === 'orchestrator' ? 30 : semanticLevel === 'overview' ? 18 : 24} /></span>
                <span className="agent-node__copy">
                  <strong>{semanticLevel === 'overview' && !selected ? compactAgentName(agent.displayName) : agent.displayName}</strong>
                  {layout.organization.source === 'legacy' ? <small>{shortRole(agent)}</small> : null}
                  {teamLeadAgentIds.has(agent.id) ? <span className="agent-node__lead">Lead</span> : null}
                  <span className="agent-node__status"><StatusDot status={agent.status} /><em>{mapStatusText(agent)}</em>{agent.currentTaskId ? <b>{agent.currentTaskId}</b> : null}</span>
                  {semanticLevel === 'detail' && agent.currentTaskTitle ? <span className="agent-node__task-title">{agent.currentTaskTitle}</span> : null}
                </span>
              </span>
            </button>
          );
        })}

        {inspectionNodes.map(({ run, from }) => {
          const offset = manualLayout.inspectionOffsets[run.kind] ?? { x: 0, y: 0 };
          const baseScreenPoint = inspectionScreenPosition(run.kind, worldToScreen(from, camera), camera.zoom, visualScaleForZoom(camera.zoom));
          const screenPoint = { x: baseScreenPoint.x + offset.x * camera.zoom, y: baseScreenPoint.y + offset.y * camera.zoom };
          const blue = run.kind === 'external_benchmark';
          const label = blue ? t('externalBenchmark') : t('adversarialAudit');
          const status = run.status === 'queued' ? t('inspectionQueued') : run.status === 'cancelling' ? t('inspectionCancelling') : t('inspectionRunning');
          return (
            <button
              type="button"
              key={run.runId}
              data-node-kind="inspection"
              data-inspection-kind={run.kind}
              className={`inspection-node inspection-node--${blue ? 'blue' : 'red'}${reducedMotion ? ' is-reduced-motion' : ''}${inspectionDrag?.inspectionKind === run.kind ? ' is-moving' : ''}`}
              style={{ left: screenPoint.x, top: screenPoint.y, width: interactionSizeForZoom(camera.zoom, 54), height: interactionSizeForZoom(camera.zoom, 54) }}
              aria-label={`${label}, ${status}`}
              onPointerDown={(event) => handleInspectionPointerDown(event, run.kind)}
              onClick={(event) => {
                event.stopPropagation();
                if (suppressClickRef.current?.type === 'inspection' && suppressClickRef.current.kind === run.kind) { suppressClickRef.current = null; return; }
                onSelectInspection(run.runId);
              }}
            >
              <span className="inspection-node__visual" style={{ transform: `translate(-50%, -50%) scale(${visualScaleForZoom(camera.zoom)})` }}>
                <span className="inspection-node__ring" aria-hidden="true" />
                <span className="inspection-node__icon">{blue ? <Search size={23} /> : <ShieldAlert size={23} />}</span>
                <span className="inspection-node__copy">
                  <strong>{label}</strong>
                  <small>{status}</small>
                </span>
              </span>
            </button>
          );
        })}

      </div>

      {layout.organization.source === 'legacy' ? (
        <div className="map-source-badge" data-organization-source="legacy">Inferred organization</div>
      ) : null}

      <button type="button" className="add-agent-button" onClick={(event) => { event.stopPropagation(); onOpenTeam(); }}>
        <UsersRound size={16} aria-hidden="true" />{t('teamManagement')}
      </button>

      <div className="map-controls" aria-label="Map controls">
        <button type="button" onClick={() => zoomAt(camera.zoom + 0.14)} aria-label={t('zoomIn')}><Plus size={15} /></button>
        <button type="button" onClick={() => zoomAt(camera.zoom - 0.14)} aria-label={t('zoomOut')}><Minus size={15} /></button>
        <button type="button" onClick={applyFit} aria-label={t('fit')}><Scan size={15} /><span>{t('fit')}</span></button>
        <button type="button" onClick={resetLayout} aria-label={t('reset')}><RotateCcw size={15} /><span>{t('reset')}</span></button>
      </div>
    </section>
  );
}
