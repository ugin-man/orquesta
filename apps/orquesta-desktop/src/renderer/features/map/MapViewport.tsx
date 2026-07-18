import { Minus, Plus, RotateCcw, Scan } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type WheelEvent } from 'react';
import type { AgentUiModel, OrquestaUiSnapshot, TaskUiModel } from '../../../contracts/orquesta-ui';
import { AgentGlyph } from '../../components/AgentGlyph';
import { StatusDot } from '../../components/StatusDot';
import { useI18n } from '../i18n/I18nProvider';
import { createStableLayout, edgePath, midpoint, type Point } from './layout';

interface Camera {
  x: number;
  y: number;
  zoom: number;
}

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  cameraX: number;
  cameraY: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isActiveTask(task: TaskUiModel | undefined, online: boolean): boolean {
  return Boolean(online && task && (task.turnStarted || task.progressObserved));
}

function fitCamera(viewport: DOMRect | { width: number; height: number }, world: { width: number; height: number }, padding = 18): Camera {
  const zoom = clamp(Math.min((viewport.width - padding * 2) / world.width, (viewport.height - padding * 2) / world.height), 0.34, 1.12);
  return {
    zoom,
    x: (viewport.width - world.width * zoom) / 2,
    y: (viewport.height - world.height * zoom) / 2
  };
}

function mapStatusText(agent: AgentUiModel): string {
  return agent.statusLabel || agent.status.replaceAll('_', ' ');
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
  const rosterLayoutKey = `${snapshot.project.id}:${snapshot.agents.map((agent) => agent.id).join('|')}`;
  const layout = useMemo(() => createStableLayout(snapshot.agents), [rosterLayoutKey]);
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, zoom: 0.9 });
  const [drag, setDrag] = useState<DragState | null>(null);
  const online = snapshot.project.status !== 'offline';

  const applyFit = useCallback(() => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    setCamera(fitCamera(rect, layout));
  }, [layout]);

  const fittedProjectIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (fittedProjectIdRef.current === snapshot.project.id) return;
    fittedProjectIdRef.current = snapshot.project.id;
    applyFit();
  }, [applyFit, snapshot.project.id]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    let width = viewport.clientWidth;
    let height = viewport.clientHeight;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      const nextWidth = entry?.contentRect.width ?? viewport.clientWidth;
      const nextHeight = entry?.contentRect.height ?? viewport.clientHeight;
      if (nextWidth === width && nextHeight === height) return;
      width = nextWidth;
      height = nextHeight;
      applyFit();
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [applyFit]);

  const taskById = useMemo(() => new Map(snapshot.tasks.map((task) => [task.id, task])), [snapshot.tasks]);

  const currentEdges = useMemo(() => {
    return snapshot.agents.flatMap((agent) => {
      if (!agent.currentTaskId) return [];
      const task = taskById.get(agent.currentTaskId);
      if (!task) return [];
      const from = agent.id === 'orchestrator'
        ? layout.user
        : layout.agentPositions.get(task.assignedByAgentId ?? 'orchestrator') ?? layout.center;
      const to = layout.agentPositions.get(agent.id);
      if (!to) return [];
      return [{ agent, task, from, to, chip: midpoint(from, to, agent.id === 'orchestrator' ? 0.54 : 0.48) }];
    });
  }, [layout, snapshot.agents, taskById]);

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

  const zoomAt = (nextZoom: number, anchor?: { x: number; y: number }) => {
    setCamera((current) => {
      const zoom = clamp(nextZoom, 0.32, 1.9);
      if (!anchor) return { ...current, zoom };
      const worldX = (anchor.x - current.x) / current.zoom;
      const worldY = (anchor.y - current.y) / current.zoom;
      return { zoom, x: anchor.x - worldX * zoom, y: anchor.y - worldY * zoom };
    });
  };

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('.floating-panel, .context-overlay, .command-composer')) return;
    event.preventDefault();
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const factor = Math.exp(-event.deltaY * 0.0011);
    zoomAt(camera.zoom * factor, anchor);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest('button, [role="dialog"], .floating-panel')) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, cameraX: camera.x, cameraY: camera.y });
    onClearSelection();
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    setCamera((current) => ({ ...current, x: drag.cameraX + event.clientX - drag.startX, y: drag.cameraY + event.clientY - drag.startY }));
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag?.pointerId === event.pointerId) setDrag(null);
  };

  const focusPoint = (point: Point) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    const zoom = Math.max(camera.zoom, layout.compact ? 0.8 : 1.02);
    setCamera({ zoom, x: rect.width / 2 - point.x * zoom, y: rect.height / 2 - point.y * zoom });
  };

  const worldStyle = {
    width: `${layout.width}px`,
    height: `${layout.height}px`,
    transform: `translate3d(${camera.x}px, ${camera.y}px, 0) scale(${camera.zoom})`
  } satisfies CSSProperties;

  return (
    <section
      ref={viewportRef}
      className={`map-viewport${drag ? ' is-dragging' : ''}`}
      aria-label="Orquesta Map"
      onWheel={handleWheel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      <div className="map-world" style={worldStyle} data-zoom={camera.zoom.toFixed(2)}>
        <svg className="map-geometry" viewBox={`0 0 ${layout.width} ${layout.height}`} aria-hidden="true">
          <circle className="map-boundary" cx={layout.center.x} cy={layout.center.y + (layout.compact ? 60 : 40)} r={layout.outerRadius} />
          <circle className="map-orchestrator-ring map-orchestrator-ring--outer" cx={layout.center.x} cy={layout.center.y} r={layout.compact ? 112 : 108} />
          <circle className="map-orchestrator-ring" cx={layout.center.x} cy={layout.center.y} r={layout.compact ? 78 : 75} />
          {snapshot.agents.filter((agent) => agent.id !== 'orchestrator').map((agent) => {
            const point = layout.agentPositions.get(agent.id);
            if (!point) return null;
            return <path key={`base-${agent.id}`} className="map-edge map-edge--base" d={edgePath(layout.center, point)} />;
          })}
          <path className="map-edge map-edge--base" d={edgePath(layout.user, layout.center)} />
          {currentEdges.map(({ task, from, to }) => {
            const active = isActiveTask(task, online);
            const selected = selectedTaskId === task.id;
            return (
              <g key={`edge-${task.id}`}>
                <path className={`map-edge map-edge--task${active ? ' is-active' : ''}${selected ? ' is-selected' : ''}`} d={edgePath(from, to)} />
                {active && !reducedMotion ? <path className="map-edge-flow" d={edgePath(from, to)} /> : null}
              </g>
            );
          })}
        </svg>

        <div className="map-user-node" style={{ left: layout.user.x, top: layout.user.y }}>
          <span className="agent-node__icon"><AgentGlyph iconKey="user" size={30} /></span>
          <strong>YOU</strong>
          <small>Human</small>
        </div>

        {snapshot.agents.map((agent) => {
          const point = layout.agentPositions.get(agent.id);
          if (!point) return null;
          const selected = selectedAgentId === agent.id;
          const dimmed = (selectedAgentId || selectedTaskId) && !selected && !connectedAgentIds.has(agent.id);
          const activeTask = agent.currentTaskId ? taskById.get(agent.currentTaskId) : undefined;
          const motion = isActiveTask(activeTask, online) && !reducedMotion;
          return (
            <button
              key={agent.id}
              type="button"
              data-node-kind="agent"
              className={`agent-node${agent.id === 'orchestrator' ? ' agent-node--orchestrator' : ''}${layout.compact ? ' agent-node--compact' : ''}${selected ? ' is-selected' : ''}${dimmed ? ' is-dimmed' : ''}${motion ? ' agent-node--motion' : ''}`}
              style={{ left: point.x, top: point.y }}
              aria-label={`${agent.displayName}, ${mapStatusText(agent)}`}
              onClick={(event) => { event.stopPropagation(); onSelectAgent(agent.id); }}
              onDoubleClick={(event) => { event.stopPropagation(); focusPoint(point); }}
            >
              <span className="agent-node__icon"><AgentGlyph iconKey={agent.iconKey} size={agent.id === 'orchestrator' ? 30 : layout.compact ? 20 : 26} /></span>
              <span className="agent-node__copy">
                <strong>{agent.displayName.toUpperCase()}</strong>
                <small>{agent.roleSummary}</small>
                <span className="agent-node__status"><StatusDot status={agent.status} /><em>{mapStatusText(agent)}</em></span>
              </span>
            </button>
          );
        })}

        {currentEdges.map(({ task, chip }) => (
          <button
            key={`chip-${task.id}`}
            type="button"
            className={`task-chip${selectedTaskId === task.id ? ' is-selected' : ''}${isActiveTask(task, online) ? ' is-active' : ''}`}
            style={{ left: chip.x, top: chip.y }}
            aria-label={`${task.id}: ${task.title}`}
            onClick={(event) => { event.stopPropagation(); onSelectTask(task.id); }}
          >
            {task.id}
          </button>
        ))}

        <button type="button" className="add-agent-button" style={{ left: layout.center.x, top: layout.compact ? layout.height - 72 : 762 }} onClick={(event) => { event.stopPropagation(); onOpenTeam(); }}>
          <Plus size={16} aria-hidden="true" />{t('addAgent')}
        </button>
      </div>

      <div className="map-controls" aria-label="Map controls">
        <button type="button" onClick={() => zoomAt(camera.zoom + 0.14)} aria-label={t('zoomIn')}><Plus size={15} /></button>
        <button type="button" onClick={() => zoomAt(camera.zoom - 0.14)} aria-label={t('zoomOut')}><Minus size={15} /></button>
        <button type="button" onClick={applyFit} aria-label={t('fit')}><Scan size={15} /><span>{t('fit')}</span></button>
        <button type="button" onClick={applyFit} aria-label={t('reset')}><RotateCcw size={15} /><span>{t('reset')}</span></button>
      </div>
    </section>
  );
}
