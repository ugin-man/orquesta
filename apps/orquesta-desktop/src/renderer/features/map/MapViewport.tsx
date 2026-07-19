import { Minus, Plus, RotateCcw, Scan, UsersRound } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent } from 'react';
import type { AgentUiModel, OrquestaUiSnapshot, TaskUiModel } from '../../../contracts/orquesta-ui';
import { AgentGlyph } from '../../components/AgentGlyph';
import { StatusDot } from '../../components/StatusDot';
import { useI18n } from '../i18n/I18nProvider';
import { createStableLayout, edgePath, type MapGroupLayout, type Point } from './layout';
import { applyManualOffsets, clearManualOffsets, loadManualOffsets, saveManualOffsets, type ManualOffsets } from './manual-layout';

interface Camera { x: number; y: number; zoom: number }
interface Bounds { x: number; y: number; width: number; height: number }
interface PanDrag { pointerId: number; startX: number; startY: number; cameraX: number; cameraY: number; zoom: number }
interface AgentDrag { pointerId: number; agentId: string; startX: number; startY: number; origin: Point; zoom: number; moved: boolean }
type PendingPointerUpdate =
  | { kind: 'pan'; pointerId: number; camera: Camera }
  | { kind: 'agent'; pointerId: number; agentId: string; offset: Point };
interface CapturedPointer { pointerId: number; target: HTMLElement }

export type SemanticZoomLevel = 'overview' | 'normal' | 'detail';

export function semanticLevelForZoom(zoom: number): SemanticZoomLevel {
  if (zoom < 0.24) return 'overview';
  if (zoom < 0.72) return 'normal';
  return 'detail';
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

function groupBounds(group: MapGroupLayout, positions: Map<string, Point>, nodeWidth: number, nodeHeight: number): MapGroupLayout {
  const points = group.agentIds.flatMap((agentId) => {
    const point = positions.get(agentId);
    return point ? [point] : [];
  });
  if (!points.length) return group;
  const x = Math.min(...points.map((point) => point.x - nodeWidth / 2)) - 34;
  const y = Math.min(...points.map((point) => point.y - nodeHeight / 2)) - 42;
  const right = Math.max(...points.map((point) => point.x + nodeWidth / 2)) + 34;
  const bottom = Math.max(...points.map((point) => point.y + nodeHeight / 2)) + 30;
  return { ...group, x, y, width: right - x, height: bottom - y, anchor: { x: (x + right) / 2, y } };
}

function contentBounds(user: Point, positions: Map<string, Point>, groups: MapGroupLayout[], nodeWidth: number, nodeHeight: number): Bounds {
  const left = [user.x - nodeWidth / 2, ...[...positions.values()].map((point) => point.x - nodeWidth / 2), ...groups.map((group) => group.x)];
  const right = [user.x + nodeWidth / 2, ...[...positions.values()].map((point) => point.x + nodeWidth / 2), ...groups.map((group) => group.x + group.width)];
  const top = [user.y - nodeHeight / 2, ...[...positions.values()].map((point) => point.y - nodeHeight / 2), ...groups.map((group) => group.y)];
  const bottom = [user.y + nodeHeight / 2, ...[...positions.values()].map((point) => point.y + nodeHeight / 2), ...groups.map((group) => group.y + group.height)];
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
  onClearSelection,
  onOpenTeam
}: {
  snapshot: OrquestaUiSnapshot;
  selectedAgentId: string | null;
  selectedTaskId: string | null;
  reducedMotion: boolean;
  onSelectAgent(agentId: string): void;
  onSelectTask(taskId: string): void;
  onClearSelection(): void;
  onOpenTeam(): void;
}) {
  const { t } = useI18n();
  const viewportRef = useRef<HTMLDivElement>(null);
  const rosterLayoutKey = `${snapshot.project.id}:${snapshot.agents.map((agent) => `${agent.id}:${agent.assignedByAgentId ?? ''}`).join('|')}`;
  const layout = useMemo(() => createStableLayout(snapshot.agents), [rosterLayoutKey]);
  const [manualOffsets, setManualOffsets] = useState<ManualOffsets>(() => loadManualOffsets(snapshot.project.id, window.localStorage));
  const manualOffsetsRef = useRef(manualOffsets);
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, zoom: 0.72 });
  const [panDrag, setPanDrag] = useState<PanDrag | null>(null);
  const [agentDrag, setAgentDrag] = useState<AgentDrag | null>(null);
  const panDragRef = useRef<PanDrag | null>(null);
  const agentDragRef = useRef<AgentDrag | null>(null);
  const suppressClickRef = useRef<string | null>(null);
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
    if (agentDragRef.current?.pointerId !== update.pointerId || agentDragRef.current.agentId !== update.agentId) return;
    setManualOffsets((current) => {
      const next = { ...current, [update.agentId]: update.offset };
      manualOffsetsRef.current = next;
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
    if (pointerId !== undefined && pan?.pointerId !== pointerId && agent?.pointerId !== pointerId) return;

    if (pointerFrameRef.current !== null) cancelAnimationFrame(pointerFrameRef.current);
    pointerFrameRef.current = null;
    const pending = pendingPointerUpdateRef.current;
    pendingPointerUpdateRef.current = null;

    if (pending?.kind === 'pan' && pan?.pointerId === pending.pointerId && renderState) {
      setCamera(pending.camera);
    }
    if (agent) {
      let offsets = manualOffsetsRef.current;
      if (agent.moved) {
        if (pending?.kind === 'agent' && pending.pointerId === agent.pointerId && pending.agentId === agent.agentId) {
          offsets = { ...offsets, [agent.agentId]: pending.offset };
          manualOffsetsRef.current = offsets;
          if (renderState) setManualOffsets(offsets);
        }
        saveManualOffsets(snapshot.project.id, offsets, window.localStorage);
      }
      suppressClickRef.current = agent.moved && suppressNextClick ? agent.agentId : null;
      agentDragRef.current = null;
      if (renderState) setAgentDrag(null);
    }
    if (pan) {
      panDragRef.current = null;
      if (renderState) setPanDrag(null);
    }
    releaseCapturedPointer(pointerId);
  }, [releaseCapturedPointer, snapshot.project.id]);

  useEffect(() => {
    const loaded = loadManualOffsets(snapshot.project.id, window.localStorage);
    manualOffsetsRef.current = loaded;
    setManualOffsets(loaded);
  }, [snapshot.project.id]);
  const effectivePositions = useMemo(() => applyManualOffsets(layout.agentPositions, manualOffsets), [layout.agentPositions, manualOffsets]);
  const effectiveGroups = useMemo(
    () => layout.groups.map((group) => groupBounds(group, effectivePositions, layout.nodeWidth, layout.nodeHeight)),
    [effectivePositions, layout.groups, layout.nodeHeight, layout.nodeWidth]
  );
  const bounds = useMemo(
    () => contentBounds(layout.user, effectivePositions, effectiveGroups, layout.nodeWidth, layout.nodeHeight),
    [effectiveGroups, effectivePositions, layout.nodeHeight, layout.nodeWidth, layout.user]
  );

  const applyFit = useCallback(() => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (rect) setCamera(fitBounds(rect, bounds));
  }, [bounds]);
  const applyFitRef = useRef(applyFit);
  applyFitRef.current = applyFit;

  const fittedLayoutKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (fittedLayoutKeyRef.current === rosterLayoutKey) return;
    fittedLayoutKeyRef.current = rosterLayoutKey;
    const frame = requestAnimationFrame(applyFit);
    return () => cancelAnimationFrame(frame);
  }, [applyFit, rosterLayoutKey]);

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
  const effectiveEdges = useMemo(() => layout.edges.map((edge) => {
    const parentGroupId = edge.parentId.startsWith('group:') ? edge.parentId.slice(6) : null;
    const parent = edge.parentId === 'user'
      ? layout.user
      : parentGroupId
        ? groupById.get(parentGroupId as MapGroupLayout['id'])?.anchor ?? edge.from
        : effectivePositions.get(edge.parentId) ?? edge.from;
    const groupId = edge.childId.startsWith('group:') ? edge.childId.slice(6) : null;
    const child = groupId ? groupById.get(groupId as MapGroupLayout['id'])?.anchor : effectivePositions.get(edge.childId);
    return { ...edge, from: parent, to: child ?? edge.to };
  }), [effectivePositions, groupById, layout.edges, layout.user]);

  const currentEdges = useMemo(() => snapshot.agents.flatMap((agent) => {
    if (!agent.currentTaskId) return [];
    const task = taskById.get(agent.currentTaskId);
    const to = effectivePositions.get(agent.id);
    if (!task || !to) return [];
    const from = agent.id === 'orchestrator'
      ? layout.user
      : effectivePositions.get(task.assignedByAgentId ?? 'orchestrator') ?? effectivePositions.get('orchestrator') ?? layout.center;
    return [{ task, from, to }];
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
    const drag = { pointerId: event.pointerId, agentId, startX: event.clientX, startY: event.clientY, origin: manualOffsetsRef.current[agentId] ?? { x: 0, y: 0 }, zoom: camera.zoom, moved: false };
    agentDragRef.current = drag;
    setAgentDrag({ ...drag });
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
    manualOffsetsRef.current = {};
    setManualOffsets({});
    requestAnimationFrame(() => {
      const rect = viewportRef.current?.getBoundingClientRect();
      if (rect) setCamera(fitBounds(rect, contentBounds(layout.user, layout.agentPositions, layout.groups, layout.nodeWidth, layout.nodeHeight)));
    });
  };

  return (
    <section
      ref={viewportRef}
      className={`map-viewport${panDrag ? ' is-dragging' : ''}`}
      aria-label="Orquesta Map"
      data-semantic-level={semanticLevel}
      data-hierarchy-diagnostics={layout.hierarchy.diagnostics.length}
      onWheel={handleWheel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
    >
      <div className="map-world" data-zoom={camera.zoom.toFixed(2)}>
        <svg className="map-geometry" aria-hidden="true">
          {effectiveGroups.filter((group) => group.agentIds.length > 1).map((group) => {
            const topLeft = worldToScreen({ x: group.x, y: group.y }, camera);
            return (
              <g key={`group-${group.id}`} className="map-group">
                <rect x={topLeft.x} y={topLeft.y} width={group.width * camera.zoom} height={group.height * camera.zoom} rx={Math.max(10, 22 * camera.zoom)} />
                <text x={topLeft.x + 14} y={topLeft.y + 19}>{group.id.toUpperCase()}</text>
              </g>
            );
          })}
          {effectiveEdges.map(({ id, from, to, kind }) => (
            <path key={id} className={`map-edge map-edge--base map-edge--${kind}`} d={edgePath(worldToScreen(from, camera), worldToScreen(to, camera))} />
          ))}
          {currentEdges.filter(({ task }) => selectedTaskId === task.id).map(({ task, from, to }) => {
            const active = isActiveTask(task, online);
            return (
              <g key={`edge-${task.id}`}>
                <path className={`map-edge map-edge--task${active ? ' is-active' : ''}${selectedTaskId === task.id ? ' is-selected' : ''}`} d={edgePath(worldToScreen(from, camera), worldToScreen(to, camera))} />
                {active && !reducedMotion ? <path className="map-edge-flow" d={edgePath(worldToScreen(from, camera), worldToScreen(to, camera))} /> : null}
              </g>
            );
          })}
        </svg>

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
          return (
            <button
              key={agent.id}
              type="button"
              data-node-kind="agent"
              data-agent-id={agent.id}
              className={`agent-node${agent.id === 'orchestrator' ? ' agent-node--orchestrator' : ''}${selected ? ' is-selected' : ''}${dimmed ? ' is-dimmed' : ''}${motion ? ' agent-node--motion' : ''}${agentDrag?.agentId === agent.id ? ' is-moving' : ''}`}
              style={{ left: screenPoint.x, top: screenPoint.y }}
              aria-label={`${agent.displayName}, ${mapStatusText(agent)}`}
              onPointerDown={(event) => handleAgentPointerDown(event, agent.id)}
              onClick={(event) => {
                event.stopPropagation();
                if (suppressClickRef.current === agent.id) { suppressClickRef.current = null; return; }
                onSelectAgent(agent.id);
              }}
              onDoubleClick={(event) => { event.stopPropagation(); focusPoint(point); }}
            >
              <span className="agent-node__icon"><AgentGlyph iconKey={agent.iconKey} size={agent.id === 'orchestrator' ? 30 : semanticLevel === 'overview' ? 18 : 24} /></span>
              <span className="agent-node__copy">
                <strong>{semanticLevel === 'overview' && !selected ? compactAgentName(agent.displayName) : agent.displayName}</strong>
                <small>{shortRole(agent)}</small>
                <span className="agent-node__status"><StatusDot status={agent.status} /><em>{mapStatusText(agent)}</em>{agent.currentTaskId ? <b>{agent.currentTaskId}</b> : null}</span>
              </span>
            </button>
          );
        })}

      </div>

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
