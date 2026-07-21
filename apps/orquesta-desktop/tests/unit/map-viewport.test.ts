import { createElement } from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { fixtureCatalog } from '../../src/fixtures';
import { I18nProvider } from '../../src/renderer/features/i18n/I18nProvider';
import { MapViewport, compactAgentName, fitCamera, interactionSizeForZoom, semanticLevelForZoom, visualScaleForZoom, worldToScreen } from '../../src/renderer/features/map/MapViewport';
import { adaptiveTwoLineSnapshot } from './adaptive-map-fixture';
import { adaptiveFixtureScenarios } from '../../src/fixtures/adaptive-organization';
import { inspectionRunningFixture } from '../../src/fixtures/inspection-running';

class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;

  constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
  }
}

function installAnimationFrames() {
  let nextFrameId = 1;
  const frames = new Map<number, FrameRequestCallback>();
  const request = vi.fn((callback: FrameRequestCallback) => {
    const frameId = nextFrameId;
    nextFrameId += 1;
    frames.set(frameId, callback);
    return frameId;
  });
  const cancel = vi.fn((frameId: number) => {
    frames.delete(frameId);
  });
  vi.stubGlobal('requestAnimationFrame', request);
  vi.stubGlobal('cancelAnimationFrame', cancel);
  return {
    cancel,
    pending: () => frames.size,
    request,
    flush() {
      const scheduled = [...frames.entries()];
      frames.clear();
      for (const [, callback] of scheduled) callback(performance.now());
    }
  };
}

function installPointerCapture() {
  const captured = new Map<Element, Set<number>>();
  for (const method of ['setPointerCapture', 'releasePointerCapture', 'hasPointerCapture'] as const) {
    if (!(method in HTMLElement.prototype)) {
      Object.defineProperty(HTMLElement.prototype, method, { configurable: true, value: () => undefined, writable: true });
    }
  }
  const setPointerCapture = vi.spyOn(HTMLElement.prototype, 'setPointerCapture').mockImplementation(function (this: HTMLElement, pointerId) {
    const pointers = captured.get(this) ?? new Set<number>();
    pointers.add(pointerId);
    captured.set(this, pointers);
  });
  const releasePointerCapture = vi.spyOn(HTMLElement.prototype, 'releasePointerCapture').mockImplementation(function (this: HTMLElement, pointerId) {
    captured.get(this)?.delete(pointerId);
  });
  vi.spyOn(HTMLElement.prototype, 'hasPointerCapture').mockImplementation(function (this: HTMLElement, pointerId) {
    return captured.get(this)?.has(pointerId) ?? false;
  });
  return {
    releasePointerCapture,
    retainedCount: () => [...captured.values()].reduce((total, pointers) => total + pointers.size, 0),
    setPointerCapture
  };
}

function mapElement(snapshot = fixtureCatalog['large-roster'].snapshot, onSelectAgent = vi.fn(), selectedAgentId: string | null = null, selectedTaskId: string | null = null, onOpenTeam = vi.fn()) {
  const viewport = createElement(MapViewport, {
    snapshot,
    selectedAgentId,
    selectedTaskId,
    reducedMotion: true,
    onSelectAgent,
    onSelectTask: vi.fn(),
    onClearSelection: vi.fn(),
    onOpenTeam
  });
  return createElement(I18nProvider, { initialLocale: 'en', children: viewport });
}

function renderMap(onSelectAgent = vi.fn()) {
  return render(mapElement(fixtureCatalog['large-roster'].snapshot, onSelectAgent));
}

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Map viewport projection', () => {
  test.each(Object.entries(adaptiveFixtureScenarios))('renders every %s fixture agent exactly once', (_name, fixture) => {
    const animationFrames = installAnimationFrames();
    const { container } = render(mapElement(fixture.snapshot));
    act(() => animationFrames.flush());
    const renderedIds = [...container.querySelectorAll<HTMLElement>('[data-agent-id]')].map((element) => element.dataset.agentId);

    const expectedCount = fixture.snapshot.agents.filter((item) => !(
      item.lifecycleState === 'superseded' && ['user-liaison', 'vision-curator', 'error-concierge'].includes(item.id)
    )).length;
    expect(renderedIds).toHaveLength(expectedCount);
    expect(new Set(renderedIds).size).toBe(expectedCount);
  });

  test('renders lines as visible responsible-agent branches and keeps one-to-two-member teams flat', () => {
    const animationFrames = installAnimationFrames();
    const snapshot = adaptiveTwoLineSnapshot();
    const { container } = render(mapElement(snapshot));
    act(() => animationFrames.flush());

    expect(container.querySelectorAll('[data-region-kind="line"]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-region-kind="team"]')).toHaveLength(0);
    expect(container.querySelector('[data-line-branch="desktop-line"]')).toHaveTextContent('Desktop');
    expect(container.querySelector('[data-line-branch="desktop-line"]')).toHaveAttribute('data-responsible-agent-id', 'implementation-001');
    expect(container.querySelector('[data-line-branch="core-line"]')).toHaveTextContent('Core');
    expect(container.querySelector('[data-line-branch="core-line"]')).toHaveAttribute('data-responsible-agent-id', 'implementation-004');
    expect(container.querySelectorAll('[data-region-drag-handle="team"]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-region-drag-handle="line"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-agent-id]')).toHaveLength(snapshot.agents.length);
    expect(container.querySelector('[data-agent-id="implementation-002"]')).toHaveAttribute('data-lifecycle-state', 'retired');
    expect(container.querySelector('[data-agent-id="implementation-004"]')).toHaveTextContent('T90');
    expect(container.querySelector('[data-agent-id="implementation-001"]')).not.toHaveTextContent('implementation');
    expect(container.querySelectorAll('.agent-node__lead')).toHaveLength(0);
  });

  test('renders role cluster boundaries only when one team contains multiple roles', () => {
    const animationFrames = installAnimationFrames();
    const base = adaptiveTwoLineSnapshot();
    const template = base.agents.find((item) => item.id === 'implementation-004')!;
    const snapshot = {
      ...base,
      agents: [...base.agents.map((item) => item.id === 'implementation-001' ? { ...item, position: 'lead' as const } : item), {
        ...template,
        id: 'designer-001',
        displayName: '設計係1',
        role: 'design',
        roleId: 'design',
        lineId: 'desktop-line',
        teamId: 'desktop-implementation',
        organizationParentAgentId: 'implementation-001'
      }]
    };
    const { container } = render(mapElement(snapshot));
    act(() => animationFrames.flush());

    const teamRegions = container.querySelectorAll('[data-region-kind="team"]');
    const roleRegions = container.querySelectorAll('[data-region-kind="role"]');
    expect(teamRegions).toHaveLength(1);
    expect(roleRegions).toHaveLength(2);
    expect([...roleRegions].map((region) => region.textContent)).toEqual(expect.arrayContaining(['implementation', 'design']));
    expect(container.querySelectorAll('[data-team-lead="true"]')).toHaveLength(1);
    expect(container.querySelector('[data-team-lead="true"]')).toHaveAttribute('data-agent-id', 'implementation-001');
  });

  test('does not render superseded support agents on the current organization map', () => {
    const animationFrames = installAnimationFrames();
    const base = adaptiveTwoLineSnapshot();
    const support = base.agents.find((item) => item.id === 'user-support')!;
    const snapshot = {
      ...base,
      agents: [
        ...base.agents,
        ...['user-liaison', 'vision-curator', 'error-concierge'].map((id) => ({
          ...support,
          id,
          displayName: id,
          lifecycleState: 'superseded' as const
        }))
      ]
    };
    const { container } = render(mapElement(snapshot));
    act(() => animationFrames.flush());

    expect(container.querySelector('[data-agent-id="implementation-002"]')).toBeInTheDocument();
    expect(container.querySelector('[data-agent-id="user-liaison"]')).not.toBeInTheDocument();
    expect(container.querySelector('[data-agent-id="vision-curator"]')).not.toBeInTheDocument();
    expect(container.querySelector('[data-agent-id="error-concierge"]')).not.toBeInTheDocument();
  });

  test('shows task delegation only for the selected agent or selected task', () => {
    const animationFrames = installAnimationFrames();
    const snapshot = adaptiveTwoLineSnapshot();
    const idle = render(mapElement(snapshot));
    act(() => animationFrames.flush());
    expect(idle.container.querySelectorAll('.map-edge--task')).toHaveLength(0);
    idle.unmount();

    const selected = render(mapElement(snapshot, vi.fn(), 'implementation-001'));
    act(() => animationFrames.flush());
    expect(selected.container.querySelectorAll('.map-edge--task').length).toBeGreaterThan(0);
  });

  test('renders active inspection beacons without adding them to the canonical agent roster', () => {
    const animationFrames = installAnimationFrames();
    const snapshot = inspectionRunningFixture.snapshot;
    const { container, getByRole } = render(mapElement(snapshot));
    act(() => animationFrames.flush());

    expect(getByRole('button', { name: /External benchmark.*Running/u })).toHaveAttribute('data-inspection-kind', 'external_benchmark');
    expect(getByRole('button', { name: /Adversarial audit.*Running/u })).toHaveAttribute('data-inspection-kind', 'adversarial_audit');
    expect(container.querySelectorAll('[data-testid="inspection-edge"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-agent-id]')).toHaveLength(snapshot.agents.length);
  });

  test('renders proposal, diagnostic, and provisioning-failure states without promoting a proposal', () => {
    const animationFrames = installAnimationFrames();
    const base = adaptiveTwoLineSnapshot();
    const template = base.agents.find((item) => item.id === 'implementation-001')!;
    const snapshot = {
      ...base,
      agents: [
        ...base.agents.map((item) => item.id === 'implementation-004'
          ? { ...item, lifecycleState: 'provisioning' as const, operationalStatus: 'provisioning_failed' }
          : item),
        { ...template, id: 'orphan-agent', displayName: 'Orphan agent', lineId: 'missing-line', teamId: 'missing-team' }
      ],
      organization: {
        ...base.organization!,
        lineProposals: [{
          id: 'decision-mobile',
          lineId: 'mobile-line',
          displayName: 'Mobile line',
          goal: 'Build mobile',
          reason: 'Separate delivery path',
          status: 'approval_wait' as const,
          ownerAgentId: 'orchestrator'
        }]
      }
    };
    const { container } = render(mapElement(snapshot));
    act(() => animationFrames.flush());

    expect(container.querySelectorAll('[data-region-kind="line"]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-line-branch]')).toHaveLength(2);
    expect(container.querySelector('[data-region-kind="proposal"]')).toHaveTextContent('Mobile line');
    expect(container.querySelector('[data-region-kind="diagnostic"]')).toHaveTextContent('Organization issues');
    expect(container.querySelector('[data-agent-id="orphan-agent"]')).toBeInTheDocument();
    expect(container.querySelector('[data-agent-id="implementation-004"]')).toHaveAttribute('data-operational-status', 'provisioning_failed');
  });

  test('labels inferred legacy organization instead of presenting it as canonical', () => {
    const animationFrames = installAnimationFrames();
    const { container } = renderMap();
    act(() => animationFrames.flush());

    expect(container.querySelector('[data-organization-source="legacy"]')).toHaveTextContent('Inferred organization');
  });

  test('clamps a legacy detail title and removes it from normal zoom', () => {
    installAnimationFrames();
    const base = fixtureCatalog['active-project'].snapshot;
    const longTitle = 'Execute Orquesta V4 Phase 1 through reviewed specialist waves without leaking this sentence into the map';
    const snapshot = {
      ...base,
      agents: base.agents.map((agent, index) => index === 0
        ? { ...agent, currentTaskId: 'T-LONG', currentTaskTitle: longTitle }
        : agent)
    };
    const { container, getByRole } = render(mapElement(snapshot));
    const detailTitle = container.querySelector<HTMLElement>('[data-agent-id] .agent-node__task-title');
    expect(detailTitle).toBeInTheDocument();
    expect(getComputedStyle(detailTitle!).overflow).toBe('hidden');
    expect(getComputedStyle(detailTitle!).maxWidth).toBe('138px');
    fireEvent.click(getByRole('button', { name: 'Zoom out' }));

    expect(container.querySelector('.map-viewport')).toHaveAttribute('data-semantic-level', 'normal');
    expect(container.querySelector('[data-agent-id] .agent-node__task-title')).not.toBeInTheDocument();
    expect(container).not.toHaveTextContent(longTitle);
  });

  test('uses three deterministic semantic zoom levels', () => {
    expect(semanticLevelForZoom(0.2)).toBe('overview');
    expect(semanticLevelForZoom(0.3)).toBe('normal');
    expect(semanticLevelForZoom(0.6)).toBe('normal');
    expect(semanticLevelForZoom(1)).toBe('detail');
  });

  test('uses the rendered icon base size for agent interaction targets', () => {
    expect(interactionSizeForZoom(0.2, 54)).toBe(24);
    expect(interactionSizeForZoom(0.72, 54)).toBe(54);
    expect(interactionSizeForZoom(0.72, 66)).toBe(66);
  });

  test('keeps normal two-line nodes legible without enlarging dense overview nodes', () => {
    expect(visualScaleForZoom(0.2)).toBeCloseTo(0.36);
    expect(visualScaleForZoom(0.3)).toBeCloseTo(0.5769, 3);
    expect(visualScaleForZoom(0.72)).toBe(1);
  });

  test('projects world coordinates without scaling node contents', () => {
    expect(worldToScreen({ x: 100, y: 80 }, { x: 20, y: -10, zoom: 0.5 })).toEqual({ x: 70, y: 30 });
  });

  test('fits the world inside the circular viewport padding', () => {
    const camera = fitCamera({ width: 1440, height: 900 }, { width: 1200, height: 900 });
    expect(camera.x).toBeGreaterThanOrEqual(42);
    expect(camera.y).toBeGreaterThanOrEqual(42);
    expect(camera.x + 1200 * camera.zoom).toBeLessThanOrEqual(1398);
    expect(camera.y + 900 * camera.zoom).toBeLessThanOrEqual(858);
  });

  test('refits when the roster layout changes inside the same project', () => {
    const animationFrames = installAnimationFrames();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 1000, height: 800, x: 0, y: 0, top: 0, right: 1000, bottom: 800, left: 0, toJSON: () => ({}) });
    const initial = fixtureCatalog['active-project'].snapshot;
    const expanded = {
      ...fixtureCatalog['large-roster'].snapshot,
      project: { ...fixtureCatalog['large-roster'].snapshot.project, id: initial.project.id }
    };
    const rendered = render(mapElement(initial));
    act(() => animationFrames.flush());
    const before = Number(rendered.container.querySelector('.map-world')?.getAttribute('data-zoom'));

    rendered.rerender(mapElement(expanded));
    act(() => animationFrames.flush());
    const after = Number(rendered.container.querySelector('.map-world')?.getAttribute('data-zoom'));

    expect(after).toBeLessThan(before);
  });

  test('keeps a distinguishing suffix in overview labels', () => {
    expect(compactAgentName('Connector 02')).toBe('CONNE 02');
    expect(compactAgentName('Orchestrator')).toBe('ORCHESTR');
  });

  test('keeps each group frame and heading inside one camera transform', () => {
    const animationFrames = installAnimationFrames();
    const { container } = renderMap();
    act(() => animationFrames.flush());

    const group = container.querySelector<SVGGElement>('.map-group');
    expect(group).not.toBeNull();
    expect(group).toHaveAttribute('transform');
    expect(group!.querySelector('rect')).toHaveAttribute('x', '0');
    expect(group!.querySelector('text')).toHaveAttribute('x', '14');
  });

  test('coalesces agent pointer moves into one update per animation frame', () => {
    vi.stubGlobal('PointerEvent', TestPointerEvent);
    const animationFrames = installAnimationFrames();
    installPointerCapture();
    const { container } = renderMap();
    act(() => animationFrames.flush());
    animationFrames.request.mockClear();
    const agent = container.querySelector<HTMLButtonElement>('[data-agent-id="orchestrator"]');
    expect(agent).not.toBeNull();

    fireEvent.pointerDown(agent!, { pointerId: 7, button: 0, clientX: 100, clientY: 100 });
    for (let index = 1; index <= 100; index += 1) {
      fireEvent.pointerMove(agent!, { pointerId: 7, button: 0, clientX: 100 + index, clientY: 100 + index });
    }

    expect(animationFrames.request).toHaveBeenCalledTimes(1);
    expect(animationFrames.pending()).toBe(1);
  });

  test('drags an inspection beacon, saves its stable offset, and only suppresses its immediate click', () => {
    vi.stubGlobal('PointerEvent', TestPointerEvent);
    const animationFrames = installAnimationFrames();
    installPointerCapture();
    const onOpenTeam = vi.fn();
    const snapshot = inspectionRunningFixture.snapshot;
    const { container } = render(mapElement(snapshot, vi.fn(), null, null, onOpenTeam));
    act(() => animationFrames.flush());
    const inspection = container.querySelector<HTMLButtonElement>('[data-inspection-kind="external_benchmark"]');
    const edge = container.querySelector<SVGPathElement>('.map-edge--inspection-blue');
    expect(inspection).not.toBeNull();
    expect(edge).not.toBeNull();
    const leftBefore = inspection!.style.left;
    const edgeBefore = edge!.getAttribute('d');

    fireEvent.pointerDown(inspection!, { pointerId: 18, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(inspection!, { pointerId: 18, button: 0, clientX: 140, clientY: 120 });
    fireEvent.pointerUp(inspection!, { pointerId: 18, button: 0, clientX: 140, clientY: 120 });

    const saved = JSON.parse(window.localStorage.getItem(`orquesta.desktop.map-layout.${snapshot.project.id}`) ?? '{}');
    expect(saved.inspectionOffsets.external_benchmark).toEqual(expect.objectContaining({
      x: expect.any(Number),
      y: expect.any(Number)
    }));
    expect(saved.inspectionOffsets.external_benchmark.x).not.toBe(0);
    expect(inspection!.style.left).not.toBe(leftBefore);
    expect(edge!.getAttribute('d')).not.toBe(edgeBefore);

    fireEvent.click(inspection!);
    expect(onOpenTeam).not.toHaveBeenCalled();
    fireEvent.click(inspection!);
    expect(onOpenTeam).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['line', 'desktop-line', 'lineOffsets'],
    ['team', 'desktop-implementation', 'teamOffsets']
  ] as const)('drags a whole %s and saves its inherited manual offset', (kind, id, offsetBucket) => {
    vi.stubGlobal('PointerEvent', TestPointerEvent);
    const animationFrames = installAnimationFrames();
    installPointerCapture();
    const base = adaptiveTwoLineSnapshot();
    const snapshot = kind === 'team' ? {
      ...base,
      agents: [
        ...base.agents.map((item) => item.id === 'implementation-001' ? { ...item, position: 'lead' as const } : item),
        {
          ...base.agents.find((item) => item.id === 'implementation-004')!,
          id: 'designer-drag-001',
          displayName: '設計係 drag',
          role: 'design',
          roleId: 'design',
          lineId: 'desktop-line',
          teamId: 'desktop-implementation',
          membershipOrdinal: 3,
          organizationParentAgentId: 'implementation-001'
        }
      ]
    } : base;
    const { container } = render(mapElement(snapshot));
    act(() => animationFrames.flush());
    const handle = container.querySelector<HTMLButtonElement>(`[data-region-drag-handle="${kind}"][data-region-id="${id}"]`);
    expect(handle).not.toBeNull();

    fireEvent.pointerDown(handle!, { pointerId: 17, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(handle!, { pointerId: 17, button: 0, clientX: 140, clientY: 120 });
    fireEvent.pointerUp(handle!, { pointerId: 17, button: 0, clientX: 140, clientY: 120 });

    const saved = JSON.parse(window.localStorage.getItem(`orquesta.desktop.map-layout.${snapshot.project.id}`) ?? '{}');
    expect(saved).toMatchObject({ version: 3, organizationRevision: snapshot.organization?.revision });
    expect(saved[offsetBucket][id]).toEqual(expect.objectContaining({
      x: expect.any(Number),
      y: expect.any(Number)
    }));
    expect(Math.abs(saved[offsetBucket][id].x)).toBeGreaterThan(0);
  });

  test('does not save a manual offset for click-sized pointer jitter', () => {
    vi.stubGlobal('PointerEvent', TestPointerEvent);
    const animationFrames = installAnimationFrames();
    installPointerCapture();
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem');
    const { container } = renderMap();
    act(() => animationFrames.flush());
    setItem.mockClear();
    removeItem.mockClear();
    const agent = container.querySelector<HTMLButtonElement>('[data-agent-id="orchestrator"]');

    fireEvent.pointerDown(agent!, { pointerId: 8, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(agent!, { pointerId: 8, button: 0, clientX: 103, clientY: 102 });
    fireEvent.pointerUp(agent!, { pointerId: 8, button: 0, clientX: 103, clientY: 102 });

    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
  });

  test.each(['pointerup', 'pointercancel', 'blur', 'Escape', 'unmount'] as const)(
    'releases pointer capture and pending animation frames on %s',
    (termination) => {
      vi.stubGlobal('PointerEvent', TestPointerEvent);
      const animationFrames = installAnimationFrames();
      const pointerCapture = installPointerCapture();
      const rendered = renderMap();
      act(() => animationFrames.flush());
      animationFrames.cancel.mockClear();
      const viewport = rendered.container.querySelector<HTMLElement>('.map-viewport');
      expect(viewport).not.toBeNull();

      fireEvent.pointerDown(viewport!, { pointerId: 9, button: 0, clientX: 100, clientY: 100 });
      fireEvent.pointerMove(viewport!, { pointerId: 9, button: 0, clientX: 140, clientY: 120 });
      expect(pointerCapture.retainedCount()).toBe(1);
      expect(animationFrames.pending()).toBe(1);

      if (termination === 'pointerup') fireEvent.pointerUp(viewport!, { pointerId: 9, button: 0, clientX: 140, clientY: 120 });
      if (termination === 'pointercancel') fireEvent.pointerCancel(viewport!, { pointerId: 9, button: 0, clientX: 140, clientY: 120 });
      if (termination === 'blur') fireEvent.blur(window);
      if (termination === 'Escape') fireEvent.keyDown(window, { key: 'Escape' });
      if (termination === 'unmount') rendered.unmount();

      expect(pointerCapture.releasePointerCapture).toHaveBeenCalledWith(9);
      expect(pointerCapture.retainedCount()).toBe(0);
      expect(animationFrames.cancel).toHaveBeenCalledTimes(1);
      expect(animationFrames.pending()).toBe(0);
    }
  );

  test.each(['pointercancel', 'blur', 'Escape'] as const)(
    'does not suppress the next agent click after %s terminates a drag',
    (termination) => {
      vi.stubGlobal('PointerEvent', TestPointerEvent);
      const animationFrames = installAnimationFrames();
      installPointerCapture();
      const onSelectAgent = vi.fn();
      const rendered = renderMap(onSelectAgent);
      act(() => animationFrames.flush());
      const agent = rendered.container.querySelector<HTMLButtonElement>('[data-agent-id="orchestrator"]');

      fireEvent.pointerDown(agent!, { pointerId: 10, button: 0, clientX: 100, clientY: 100 });
      fireEvent.pointerMove(agent!, { pointerId: 10, button: 0, clientX: 140, clientY: 120 });
      if (termination === 'pointercancel') fireEvent.pointerCancel(agent!, { pointerId: 10, button: 0, clientX: 140, clientY: 120 });
      if (termination === 'blur') fireEvent.blur(window);
      if (termination === 'Escape') fireEvent.keyDown(window, { key: 'Escape' });
      fireEvent.click(agent!);

      expect(onSelectAgent).toHaveBeenCalledWith('orchestrator');
    }
  );
});
