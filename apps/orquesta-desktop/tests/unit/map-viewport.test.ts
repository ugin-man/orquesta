import { createElement } from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { fixtureCatalog } from '../../src/fixtures';
import { I18nProvider } from '../../src/renderer/features/i18n/I18nProvider';
import { MapViewport, compactAgentName, fitCamera, semanticLevelForZoom, worldToScreen } from '../../src/renderer/features/map/MapViewport';

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

function mapElement(snapshot = fixtureCatalog['large-roster'].snapshot, onSelectAgent = vi.fn()) {
  const viewport = createElement(MapViewport, {
    snapshot,
    selectedAgentId: null,
    selectedTaskId: null,
    reducedMotion: true,
    onSelectAgent,
    onSelectTask: vi.fn(),
    onClearSelection: vi.fn(),
    onOpenTeam: vi.fn()
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
  test('uses three deterministic semantic zoom levels', () => {
    expect(semanticLevelForZoom(0.2)).toBe('overview');
    expect(semanticLevelForZoom(0.3)).toBe('normal');
    expect(semanticLevelForZoom(0.6)).toBe('normal');
    expect(semanticLevelForZoom(1)).toBe('detail');
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
