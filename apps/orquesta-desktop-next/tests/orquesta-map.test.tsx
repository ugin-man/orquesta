import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { buildOrquestaMapLayout, OrquestaMap, treeClusterRowCounts, wheelZoomFactor } from '../src/components/OrquestaMap';
import { createPreviewOrganizationSnapshot, previewSnapshot } from '../src/testing/preview-client';
import { stressAgent, stressSnapshot } from './support/orquesta-map-fixtures';

function properSegmentCrossings(layout: ReturnType<typeof buildOrquestaMapLayout>): number {
  const nodes = new Map(layout.nodes.map((node) => [node.agent.id, node]));
  const segments = layout.edges.filter((edge) => edge.kind === 'organization').flatMap((edge) => {
    const source = nodes.get(edge.source);
    const target = nodes.get(edge.target);
    return source && target ? [{ edge, source, target }] : [];
  });
  const orientation = (a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  let crossings = 0;
  for (let left = 0; left < segments.length; left += 1) {
    for (let right = left + 1; right < segments.length; right += 1) {
      const a = segments[left];
      const b = segments[right];
      if ([a.edge.source, a.edge.target].some((id) => id === b.edge.source || id === b.edge.target)) continue;
      const first = orientation(a.source, a.target, b.source);
      const second = orientation(a.source, a.target, b.target);
      const third = orientation(b.source, b.target, a.source);
      const fourth = orientation(b.source, b.target, a.target);
      if (first * second < 0 && third * fourth < 0) crossings += 1;
    }
  }
  return crossings;
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('Orquesta organization map', () => {
  test('keeps the persistent node copy to name, state and observed model', () => {
    render(<OrquestaMap snapshot={previewSnapshot} selectedAgentId={null} onSelectAgent={() => undefined} locale="en" />);

    expect(screen.getByRole('button', { name: 'You, HUMAN, PROJECT OWNER' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Implementation, Working, SOL' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review, Waiting to start, TERRA' })).toBeInTheDocument();
    expect(screen.queryByText('Builds product features')).not.toBeInTheDocument();
    expect(screen.queryByText('Add customer CSV import')).not.toBeInTheDocument();
  });

  test('marks working agents and the live delegation path without inventing model evidence', async () => {
    const onSelectAgent = vi.fn();
    const { container } = render(<OrquestaMap snapshot={previewSnapshot} selectedAgentId={null} onSelectAgent={onSelectAgent} locale="en" />);

    expect(container.querySelector('[data-agent-id="native"]')).toHaveClass('is-active');
    expect(container.querySelector('[data-flow-source="orchestrator"][data-flow-target="native"]')).toHaveAttribute('data-active', 'true');
    expect(container.querySelector('[data-flow-source="human:user"][data-flow-target="orchestrator"]')).toHaveAttribute('data-active', 'true');
    expect(screen.getByRole('button', { name: 'Luca, Standing by, UNOBSERVED' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Implementation, Working, SOL' }));
    expect(onSelectAgent).toHaveBeenCalledWith('native');
  });

  test('switches to icon-only overview after zooming out', () => {
    const { container } = render(<OrquestaMap snapshot={previewSnapshot} selectedAgentId={null} onSelectAgent={() => undefined} locale="en" />);
    const stage = container.querySelector('.map-network-stage')!;
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(stage).toHaveClass('is-overview');
  });

  test('keeps layout nodes stable and routes active task assignment separately from hierarchy', () => {
    const first = buildOrquestaMapLayout(previewSnapshot);
    const second = buildOrquestaMapLayout(previewSnapshot);
    expect(second.nodes.map(({ agent, x, y }) => [agent.id, x, y])).toEqual(first.nodes.map(({ agent, x, y }) => [agent.id, x, y]));
    expect(first.edges).toContainEqual({ id: 'edge:orchestrator:native', source: 'orchestrator', target: 'native', active: true, kind: 'organization' });
  });

  test('places the human above orchestration and keeps Luca and support on the user side', () => {
    const layout = buildOrquestaMapLayout(previewSnapshot);
    const user = layout.people[0];
    const orchestrator = layout.nodes.find((node) => node.agent.id === 'orchestrator')!;
    const luca = layout.nodes.find((node) => node.agent.id === 'orquesta-admin')!;
    const support = layout.nodes.find((node) => node.agent.id === 'user-support')!;

    expect(user.y).toBeLessThan(orchestrator.y);
    expect(luca.x).toBeLessThan(support.x);
    expect(support.x).toBeLessThan(user.x);
    expect(layout.edges).toContainEqual(expect.objectContaining({ source: 'human:user', target: 'orchestrator', kind: 'human-authority' }));
    expect(layout.edges).toContainEqual(expect.objectContaining({ source: 'orquesta-admin', target: 'human:user', kind: 'luca-access' }));
    expect(layout.edges).toContainEqual(expect.objectContaining({ source: 'user-support', target: 'human:user', kind: 'user-support' }));
  });

  test('keeps a clean Foundation organization free of structure warnings', () => {
    const foundationSnapshot = {
      ...previewSnapshot,
      agents: previewSnapshot.agents.filter((agent) => (
        ['orchestrator', 'orquesta-admin', 'user-support'].includes(agent.id)
      )),
      tasks: [],
    };
    const layout = buildOrquestaMapLayout(foundationSnapshot);

    expect(layout.diagnostics).toEqual({
      orphanParentAgentIds: [], cycleAgentIds: [], unassignedLineAgentIds: [],
    });
  });

  test('spreads multiple human participants while preserving their orchestrator links', () => {
    const layout = buildOrquestaMapLayout({
      ...previewSnapshot,
      participants: [
        { id: 'employee-a', displayName: 'Employee A', roleLabel: 'PROJECT MEMBER', isCurrentUser: true, orchestratorAgentId: 'orchestrator' },
        { id: 'employee-b', displayName: 'Employee B', roleLabel: 'PROJECT MEMBER', isCurrentUser: false, orchestratorAgentId: 'orchestrator' },
      ],
    });

    expect(layout.people).toHaveLength(2);
    expect(new Set(layout.people.map((person) => person.x)).size).toBe(2);
    expect(layout.edges.filter((edge) => edge.kind === 'human-authority')).toHaveLength(2);
    expect(layout.edges.filter((edge) => edge.kind === 'user-support')).toHaveLength(2);
    expect(layout.edges.filter((edge) => edge.kind === 'luca-access')).toHaveLength(1);
  });

  test('does not invent a person or authority edge when canonical participants are empty', () => {
    const layout = buildOrquestaMapLayout({ ...previewSnapshot, participants: [] });

    expect(layout.people).toEqual([]);
    expect(layout.edges.some((edge) => edge.kind === 'human-authority')).toBe(false);
  });

  test('shows an unbound participant without inventing an orchestrator authority edge', () => {
    const layout = buildOrquestaMapLayout({
      ...previewSnapshot,
      participants: [{
        id: 'observer', displayName: 'Observer', roleLabel: 'PROJECT MEMBER',
        isCurrentUser: false, orchestratorAgentId: 'missing-agent',
      }],
    });

    expect(layout.people.map((person) => person.participant.id)).toEqual(['observer']);
    expect(layout.edges.some((edge) => edge.kind === 'human-authority')).toBe(false);
  });

  test('keeps tree and radial manual positions independent without writing browser storage', () => {
    const legacyModeKey = 'orquesta.desktop-next.map-mode.v1.orquesta-v5';
    const legacyTreeKey = 'orquesta.desktop-next.map-layout.v4.orquesta-v5.tree';
    const legacyTreeValue = JSON.stringify({ native: { x: 99_999, y: 99_999 } });
    window.localStorage.setItem(legacyModeKey, 'radial');
    window.localStorage.setItem(legacyTreeKey, legacyTreeValue);
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem');
    const view = render(<OrquestaMap snapshot={previewSnapshot} selectedAgentId={null} onSelectAgent={() => undefined} locale="en" />);
    const { container } = view;
    const stage = container.querySelector('.map-network-stage')!;
    Object.defineProperty(stage, 'getBoundingClientRect', {
      value: () => ({ x: 0, y: 0, top: 0, left: 0, right: 1000, bottom: 600, width: 1000, height: 600, toJSON: () => ({}) }),
    });
    const node = () => container.querySelector('[data-agent-id="native"]')!;
    const frame = () => node().closest('foreignObject')!;
    const coordinate = () => [frame().getAttribute('x'), frame().getAttribute('y')];
    const drag = (pointerId: number, from: [number, number], to: [number, number]) => {
      const dispatch = (type: string, clientX: number, clientY: number, buttons: number) => {
      const event = new Event(type, { bubbles: true });
      Object.defineProperties(event, {
          pointerId: { value: pointerId }, clientX: { value: clientX }, clientY: { value: clientY }, buttons: { value: buttons },
      });
        fireEvent(node(), event);
      };
      dispatch('pointerdown', from[0], from[1], 1);
      dispatch('pointermove', to[0], to[1], 1);
      dispatch('pointerup', to[0], to[1], 0);
    };

    const automaticTree = coordinate();
    expect(screen.getByRole('button', { name: 'Tree layout' })).toHaveAttribute('aria-pressed', 'true');
    expect(automaticTree).not.toEqual(['99907', '99947']);
    drag(7, [400, 260], [520, 320]);
    const manualTree = coordinate();
    expect(manualTree).not.toEqual(automaticTree);
    expect(screen.getByText(/1 MANUAL POSITIONS/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Radial layout' }));
    const automaticRadial = coordinate();
    drag(8, [450, 300], [370, 390]);
    const manualRadial = coordinate();
    expect(manualRadial).not.toEqual(automaticRadial);

    fireEvent.click(screen.getByRole('button', { name: 'Tree layout' }));
    expect(coordinate()).toEqual(manualTree);
    fireEvent.click(screen.getByRole('button', { name: 'Reset layout' }));
    expect(coordinate()).toEqual(automaticTree);

    fireEvent.click(screen.getByRole('button', { name: 'Radial layout' }));
    expect(coordinate()).toEqual(manualRadial);
    expect(storageWrite).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(legacyModeKey)).toBe('radial');
    expect(window.localStorage.getItem(legacyTreeKey)).toBe(legacyTreeValue);

    view.unmount();
    const remounted = render(<OrquestaMap snapshot={previewSnapshot} selectedAgentId={null} onSelectAgent={() => undefined} locale="en" />);
    const remountedTreeFrame = remounted.container.querySelector('[data-agent-id="native"]')!.closest('foreignObject')!;
    expect([remountedTreeFrame.getAttribute('x'), remountedTreeFrame.getAttribute('y')]).toEqual(automaticTree);
    fireEvent.click(screen.getByRole('button', { name: 'Radial layout' }));
    const remountedRadialFrame = remounted.container.querySelector('[data-agent-id="native"]')!.closest('foreignObject')!;
    expect([remountedRadialFrame.getAttribute('x'), remountedRadialFrame.getAttribute('y')]).toEqual(automaticRadial);
  });

  test('keeps restored remote positions in view and preserves the camera across live snapshot updates', () => {
    // Large-organization rendering has a dedicated explicit load suite. Keep
    // this camera-state contract focused so it does not repeat that DOM load.
    const organization = Array.from({ length: 41 }, (_, index) => stressAgent(
      `worker-${String(index).padStart(3, '0')}`,
      'orchestrator',
      'line-a',
    ));
    const snapshot = stressSnapshot(organization);
    const remoteTree = { x: 50_000, y: 40_000 };
    const remoteRadial = { x: -50_000, y: -40_000 };
    const sessionState = {
      layoutMode: 'tree' as const,
      manualPositionsByMode: {
        tree: { 'worker-040': remoteTree },
        radial: { 'worker-040': remoteRadial },
      },
    };
    const view = render(<OrquestaMap snapshot={snapshot} selectedAgentId={null} onSelectAgent={() => undefined} locale="en" sessionState={sessionState} />);
    const svg = () => view.container.querySelector<SVGElement>('.map-network-svg')!;
    const viewBoxContains = (point: { x: number; y: number }) => {
      const [x, y, width, height] = svg().getAttribute('viewBox')!.split(' ').map(Number);
      return point.x >= x && point.x <= x + width && point.y >= y && point.y <= y + height;
    };

    expect(view.container.querySelector('[data-agent-id="worker-040"]')).not.toBeNull();
    expect(viewBoxContains(remoteTree)).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    const manuallyZoomedViewBox = svg().getAttribute('viewBox');

    view.rerender(<OrquestaMap
      snapshot={{ ...snapshot, project: { ...snapshot.project, status: 'offline' as const } }}
      selectedAgentId={null}
      onSelectAgent={() => undefined}
      locale="en"
      sessionState={sessionState}
    />);
    expect(svg()).toHaveAttribute('viewBox', manuallyZoomedViewBox);

    fireEvent.click(screen.getByRole('button', { name: 'Radial layout' }));
    expect(view.container.querySelector('[data-agent-id="worker-040"]')).not.toBeNull();
    expect(viewBoxContains(remoteRadial)).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Tree layout' }));
    expect(viewBoxContains(remoteTree)).toBe(true);
  });

  test('keeps eighty sibling agents collision-free in automatic layout', () => {
    const largeSnapshot = {
      ...previewSnapshot,
      agents: [
        { ...previewSnapshot.agents[0], currentTaskId: null, currentTaskTitle: null },
        ...Array.from({ length: 79 }, (_, index) => ({
          ...previewSnapshot.agents[3],
          id: `worker-${String(index).padStart(2, '0')}`,
          displayName: `Worker ${String(index + 1).padStart(2, '0')}`,
          currentTaskId: null,
          currentTaskTitle: null,
          parentAgentId: 'orchestrator',
          status: 'standby' as const,
        })),
      ],
      tasks: [],
    };
    const layout = buildOrquestaMapLayout(largeSnapshot, 'tree');
    const siblings = layout.nodes.filter((node) => node.agent.parentAgentId === 'orchestrator');
    const rows = new Map<number, number[]>();
    siblings.forEach((node) => rows.set(node.y, [...(rows.get(node.y) ?? []), node.x]));

    expect(rows.size).toBeGreaterThan(1);
    expect(layout.bounds.width).toBeLessThan(3_000);
    for (const row of rows.values()) {
      const sorted = row.sort((a, b) => a - b);
      if (sorted.length > 1) expect(Math.min(...sorted.slice(1).map((x, index) => x - sorted[index]))).toBeGreaterThanOrEqual(207.999);
    }
  });

  test('groups line members into centered grape clusters in tree layout', () => {
    const snapshot = createPreviewOrganizationSnapshot(30);
    const layout = buildOrquestaMapLayout(snapshot, 'tree');
    const leads = layout.nodes.filter((node) => node.agent.parentAgentId === 'orchestrator');

    expect(leads).toHaveLength(3);
    for (const lead of leads) {
      const members = layout.nodes.filter((node) => node.agent.parentAgentId === lead.agent.id);
      const rows = new Map<number, number[]>();
      members.forEach((node) => rows.set(node.y, [...(rows.get(node.y) ?? []), node.x]));

      expect(members).toHaveLength(8);
      expect([...rows.entries()].sort(([left], [right]) => left - right).map(([, row]) => row.length)).toEqual([4, 3, 1]);
      expect(Math.max(...members.map((node) => node.x)) - Math.min(...members.map((node) => node.x))).toBe(624);
      const rays = members.map((node) => Math.atan2(node.x - lead.x, node.y - lead.y).toFixed(8));
      expect(new Set(rays).size).toBe(members.length);
      const topRow = [...rows.entries()].sort(([left], [right]) => left - right)[0][1];
      expect(topRow.reduce((sum, x) => sum + x, 0) / topRow.length).toBe(lead.x);
    }
    expect(treeClusterRowCounts(9)).toEqual([4, 3, 2]);
    expect(treeClusterRowCounts(10)).toEqual([4, 3, 2, 1]);
  });

  test.each([10, 20, 30])('keeps the %i-agent tree collision-free while clustering each line', (size) => {
    const snapshot = createPreviewOrganizationSnapshot(size);
    const layout = buildOrquestaMapLayout(snapshot, 'tree');
    const organizationNodes = layout.nodes.filter((node) => !['orquesta-admin', 'user-support'].includes(node.agent.id));
    const byId = new Map(organizationNodes.map((node) => [node.agent.id, node]));

    expect(new Set(organizationNodes.map((node) => `${node.x}:${node.y}`)).size).toBe(organizationNodes.length);
    for (const node of organizationNodes) {
      if (!node.agent.parentAgentId) continue;
      const parent = byId.get(node.agent.parentAgentId);
      expect(parent).toBeDefined();
      expect(node.y).toBeGreaterThan(parent!.y);
    }
    const parents = new Set(organizationNodes.map((node) => node.agent.parentAgentId).filter(Boolean));
    for (const parentId of parents) {
      const siblings = organizationNodes.filter((node) => node.agent.parentAgentId === parentId);
      if (siblings.length < 4) continue;
      expect(new Set(siblings.map((node) => node.y)).size).toBeGreaterThan(1);
    }
  });

  test('builds an uneven three-line organization with exact 50, 80, and 100-agent populations', () => {
    const snapshot = createPreviewOrganizationSnapshot(6, undefined, [50, 80, 100]);
    const lineCounts = new Map<string, number>();
    snapshot.agents.filter((agent) => !['orquesta-admin', 'user-support'].includes(agent.id)).forEach((agent) => {
      if (agent.lineId) lineCounts.set(agent.lineId, (lineCounts.get(agent.lineId) ?? 0) + 1);
    });

    expect(snapshot.agents).toHaveLength(233);
    expect([...lineCounts.entries()].sort(([left], [right]) => left.localeCompare(right))).toEqual([
      ['line-1', 50],
      ['line-2', 80],
      ['line-3', 100],
    ]);

    const layout = buildOrquestaMapLayout(snapshot, 'tree');
    const organizationNodes = layout.nodes.filter((node) => !['orquesta-admin', 'user-support'].includes(node.agent.id));
    expect(new Set(organizationNodes.map((node) => `${node.x.toFixed(6)}:${node.y.toFixed(6)}`)).size).toBe(organizationNodes.length);
    const leads = organizationNodes.filter((node) => node.agent.parentAgentId === 'orchestrator');
    expect(leads).toHaveLength(3);
    expect(leads.map((lead) => organizationNodes.filter((node) => node.agent.parentAgentId === lead.agent.id).length)).toEqual([49, 79, 99]);
    for (const lead of leads) {
      const children = organizationNodes.filter((node) => node.agent.parentAgentId === lead.agent.id);
      expect(new Set(children.map((node) => Math.atan2(node.x - lead.x, node.y - lead.y).toFixed(8))).size).toBe(children.length);
    }
  });

  test('keeps a small many-line boundary finite, distinct and renderable', () => {
    const agents = Array.from({ length: 8 }, (_, index) => {
      const lineId = `boundary-line-${index}`;
      const leadId = `${lineId}-lead`;
      return [stressAgent(leadId, 'orchestrator', lineId), stressAgent(`${lineId}-worker`, leadId, lineId)];
    }).flat();
    const snapshot = stressSnapshot(agents);
    const layout = buildOrquestaMapLayout(snapshot, 'radial');
    const organizationNodes = layout.nodes.filter((node) => !['orquesta-admin', 'user-support'].includes(node.agent.id));
    expect(layout.lines).toHaveLength(8);
    expect(new Set(organizationNodes.map((node) => `${node.x.toFixed(6)}:${node.y.toFixed(6)}`)).size).toBe(17);
    expect(organizationNodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true);

    const { container } = render(<OrquestaMap snapshot={snapshot} selectedAgentId={null} onSelectAgent={() => undefined} locale="en" />);
    expect(container.querySelectorAll('.map-line-region')).toHaveLength(8);
    expect(container.querySelectorAll('[data-agent-id]')).toHaveLength(19);
  });

  test('keeps a fifty-agent line readable beside tiny lines', () => {
    const lineA = [stressAgent('line-a-lead', 'orchestrator', 'line-a')];
    const lineB = [stressAgent('line-b-lead', 'orchestrator', 'line-b')];
    for (let index = 1; index < 50; index += 1) lineB.push(stressAgent(`line-b-${index}`, 'line-b-lead', 'line-b'));
    const lineC = [
      stressAgent('line-c-lead', 'orchestrator', 'line-c'),
      stressAgent('line-c-1', 'line-c-lead', 'line-c'),
      stressAgent('line-c-2', 'line-c-lead', 'line-c'),
    ];
    const layout = buildOrquestaMapLayout(stressSnapshot([...lineA, ...lineB, ...lineC]), 'radial');
    const members = layout.nodes.filter((node) => node.agent.parentAgentId === 'line-b-lead');
    let minimumDistance = Number.POSITIVE_INFINITY;
    for (let left = 0; left < members.length; left += 1) {
      for (let right = left + 1; right < members.length; right += 1) {
        minimumDistance = Math.min(minimumDistance, Math.hypot(members[left].x - members[right].x, members[left].y - members[right].y));
      }
    }

    expect(layout.lines.map((line) => line.count)).toEqual([1, 50, 3]);
    expect(members).toHaveLength(49);
    expect(minimumDistance).toBeGreaterThan(200);

    const treeLayout = buildOrquestaMapLayout(stressSnapshot([...lineA, ...lineB, ...lineC]), 'tree');
    const treeLead = treeLayout.nodes.find((node) => node.agent.id === 'line-b-lead')!;
    const treeMembers = treeLayout.nodes.filter((node) => node.agent.parentAgentId === 'line-b-lead');
    expect(new Set(treeMembers.map((node) => Math.atan2(node.x - treeLead.x, node.y - treeLead.y).toFixed(8))).size).toBe(49);
    expect(new Set(treeMembers.map((node) => node.y)).size).toBeGreaterThan(5);
  });

  test('allocates descendants inside their parent sector in a deep asymmetric radial tree', () => {
    const agents = [
      stressAgent('lead', 'orchestrator', 'line-1', 'Lead'),
      stressAgent('branch-a', 'lead', 'line-1', 'Branch A'),
      stressAgent('branch-b', 'lead', 'line-1', 'Branch B'),
      stressAgent('a-alpha', 'branch-a', 'line-1', 'Alpha'),
      stressAgent('a-zulu', 'branch-a', 'line-1', 'Zulu'),
      stressAgent('b-bravo', 'branch-b', 'line-1', 'Bravo'),
      stressAgent('b-yankee', 'branch-b', 'line-1', 'Yankee'),
      stressAgent('a-alpha-deep', 'a-alpha', 'line-1', 'Deep Alpha'),
      stressAgent('a-alpha-deeper', 'a-alpha-deep', 'line-1', 'Deeper Alpha'),
    ];
    const layout = buildOrquestaMapLayout(stressSnapshot(agents), 'radial');

    expect(properSegmentCrossings(layout)).toBe(0);
    expect(new Set(layout.nodes.filter((node) => !['orquesta-admin', 'user-support'].includes(node.agent.id)).map((node) => `${node.x.toFixed(6)}:${node.y.toFixed(6)}`)).size).toBe(agents.length + 1);
    expect(Math.max(...layout.nodes.map((node) => node.depth))).toBe(5);
  });

  test('keeps a sixty-four-level chain finite in both layout modes', () => {
    const chain = Array.from({ length: 64 }, (_, index) => stressAgent(
      `deep-${String(index + 1).padStart(2, '0')}`,
      index === 0 ? 'orchestrator' : `deep-${String(index).padStart(2, '0')}`,
      'line-deep',
    ));
    for (const mode of ['tree', 'radial'] as const) {
      const layout = buildOrquestaMapLayout(stressSnapshot(chain), mode);
      const chainNodes = layout.nodes.filter((node) => node.agent.lineId === 'line-deep');
      expect(chainNodes).toHaveLength(64);
      expect(new Set(chainNodes.map((node) => `${node.x.toFixed(6)}:${node.y.toFixed(6)}`)).size).toBe(64);
      expect(chainNodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true);
      expect(Math.max(...chainNodes.map((node) => node.depth))).toBe(64);
    }
  });

  test('breaks malformed cycles for layout while preserving diagnostics', () => {
    const agents = [
      stressAgent('cycle-a', 'cycle-b', 'line-cycle'),
      stressAgent('cycle-b', 'cycle-a', 'line-cycle'),
      stressAgent('cycle-child', 'cycle-a', 'line-cycle'),
      stressAgent('orphan', 'missing-parent', 'line-orphan'),
    ];
    const layout = buildOrquestaMapLayout(stressSnapshot(agents), 'radial');
    const coordinateKeys = new Set(layout.nodes.filter((node) => !['orquesta-admin', 'user-support'].includes(node.agent.id)).map((node) => `${node.x.toFixed(6)}:${node.y.toFixed(6)}`));

    expect(layout.diagnostics.cycleAgentIds).toEqual(['cycle-a', 'cycle-b']);
    expect(layout.diagnostics.orphanParentAgentIds).toEqual(['orphan']);
    expect(coordinateKeys.size).toBe(agents.length + 1);
    expect(layout.edges.some((edge) => edge.source === 'cycle-a' && edge.target === 'cycle-b')).toBe(false);
    expect(layout.edges.some((edge) => edge.source === 'cycle-b' && edge.target === 'cycle-a')).toBe(false);
  });

  test('preserves layout invariants across deterministic irregular organizations', () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      let randomState = seed * 2_654_435_761;
      const random = () => {
        randomState = (randomState * 1_664_525 + 1_013_904_223) >>> 0;
        return randomState / 0x1_0000_0000;
      };
      const size = 12 + (seed * 17) % 170;
      const lineCount = Math.min(size, 1 + (seed * 13) % 36);
      const agents: ReturnType<typeof stressAgent>[] = [];
      const membersByLine = new Map<string, string[]>();
      for (let lineIndex = 0; lineIndex < lineCount; lineIndex += 1) {
        const lineId = `random-line-${lineIndex}`;
        const leadId = `${lineId}-lead`;
        agents.push(stressAgent(leadId, 'orchestrator', lineId, `Lead ${lineIndex}`));
        membersByLine.set(lineId, [leadId]);
      }
      while (agents.length < size) {
        const lineIndex = Math.floor(random() * lineCount);
        const lineId = `random-line-${lineIndex}`;
        const members = membersByLine.get(lineId)!;
        const parentPool = random() < .18 ? members.slice(-3) : members;
        const parentId = parentPool[Math.floor(random() * parentPool.length)];
        const id = `${lineId}-agent-${agents.length}`;
        agents.push(stressAgent(id, parentId, lineId, `Agent ${String(Math.floor(random() * 10_000)).padStart(4, '0')}`));
        members.push(id);
      }
      const snapshot = stressSnapshot(agents);
      for (const mode of ['tree', 'radial'] as const) {
        const layout = buildOrquestaMapLayout(snapshot, mode);
        const organization = layout.nodes.filter((node) => !['orquesta-admin', 'user-support'].includes(node.agent.id));
        const nodeById = new Map(organization.map((node) => [node.agent.id, node]));
        expect(organization.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true);
        expect(new Set(organization.map((node) => `${node.x.toFixed(6)}:${node.y.toFixed(6)}`)).size).toBe(organization.length);
        expect(layout.diagnostics).toEqual({ orphanParentAgentIds: [], cycleAgentIds: [], unassignedLineAgentIds: [] });
        if (mode === 'tree') {
          for (const parent of organization) {
            const children = organization.filter((node) => node.agent.parentAgentId === parent.agent.id);
            const rays = children.map((child) => Math.atan2(child.x - parent.x, child.y - parent.y).toFixed(8));
            expect(new Set(rays).size).toBe(rays.length);
            expect(children.every((child) => child.y > parent.y)).toBe(true);
          }
        } else {
          const byDepth = new Map<number, typeof organization>();
          organization.filter((node) => node.agent.id !== 'orchestrator').forEach((node) => byDepth.set(node.depth, [...(byDepth.get(node.depth) ?? []), node]));
          for (const depthNodes of byDepth.values()) {
            for (let left = 0; left < depthNodes.length; left += 1) {
              for (let right = left + 1; right < depthNodes.length; right += 1) {
                expect(Math.hypot(depthNodes[left].x - depthNodes[right].x, depthNodes[left].y - depthNodes[right].y)).toBeGreaterThan(200);
              }
            }
          }
          expect(properSegmentCrossings(layout)).toBe(0);
        }
        expect(layout.edges.filter((edge) => edge.kind === 'organization')).toHaveLength(agents.length);
        expect(nodeById.has('orchestrator')).toBe(true);
      }
    }
  });

  test('normalizes wheel input across mouse, trackpad and line-based devices', () => {
    expect(wheelZoomFactor(100, 0)).toBeGreaterThanOrEqual(.62);
    expect(wheelZoomFactor(100, 0)).toBeLessThan(.75);
    expect(wheelZoomFactor(-100, 0)).toBeGreaterThan(1.35);
    expect(wheelZoomFactor(3, 1)).toBeGreaterThan(.8);
    expect(wheelZoomFactor(3, 1)).toBeLessThan(.9);
    expect(wheelZoomFactor(4, 0)).toBeGreaterThan(.98);
    expect(wheelZoomFactor(4, 0)).toBeLessThan(1);
  });

  test('makes a single mouse-wheel notch visibly change the map zoom', () => {
    const { container } = render(<OrquestaMap snapshot={previewSnapshot} selectedAgentId={null} onSelectAgent={() => undefined} locale="en" />);
    const stage = container.querySelector('.map-network-stage')!;
    Object.defineProperty(stage, 'getBoundingClientRect', {
      value: () => ({ x: 0, y: 0, top: 0, left: 0, right: 1000, bottom: 600, width: 1000, height: 600, toJSON: () => ({}) }),
    });
    const svg = container.querySelector('.map-network-svg')!;
    const beforeWidth = Number(svg.getAttribute('viewBox')!.split(' ')[2]);

    fireEvent.wheel(stage, { deltaY: 100, deltaMode: 0, clientX: 750, clientY: 300 });

    const afterWidth = Number(svg.getAttribute('viewBox')!.split(' ')[2]);
    expect(afterWidth).toBeGreaterThan(beforeWidth * 1.35);
    expect(stage).toHaveAttribute('data-zoom-percent', '70');
    expect(screen.getByText(/70%/)).toBeInTheDocument();
  });

  test.each([
    [10, 1],
    [20, 2],
    [30, 3],
  ])('keeps all %i agents visible in radial line sectors', (size, expectedLines) => {
    const snapshot = createPreviewOrganizationSnapshot(size);
    const layout = buildOrquestaMapLayout(snapshot, 'radial');
    const organizationNodes = layout.nodes.filter((node) => !['orquesta-admin', 'user-support'].includes(node.agent.id));
    const coordinateKeys = new Set(organizationNodes.map((node) => `${node.x.toFixed(3)}:${node.y.toFixed(3)}`));

    expect(layout.nodes).toHaveLength(size);
    expect(layout.lines).toHaveLength(expectedLines);
    expect(coordinateKeys.size).toBe(organizationNodes.length);
    expect(new Set(layout.lines.flatMap((line) => layout.nodes.filter((node) => node.agent.lineId === line.id).map((node) => node.agent.id))).size).toBe(size - 3);
    expect(layout.bounds.width).toBeGreaterThan(760);
    expect(layout.diagnostics).toEqual({ orphanParentAgentIds: [], cycleAgentIds: [], unassignedLineAgentIds: [] });
  });

  test('uses radial layout by default for a large organization and allows switching back to tree', () => {
    const snapshot = createPreviewOrganizationSnapshot(30);
    const { container } = render(<OrquestaMap snapshot={snapshot} selectedAgentId={null} onSelectAgent={() => undefined} locale="en" />);

    expect(screen.getByRole('button', { name: 'Radial layout' })).toHaveAttribute('aria-pressed', 'true');
    expect(container.querySelector('.map-network-stage')).toHaveClass('mode-radial');
    expect(container.querySelectorAll('.map-line-region')).toHaveLength(3);

    fireEvent.click(screen.getByRole('button', { name: 'Tree layout' }));
    expect(screen.getByRole('button', { name: 'Tree layout' })).toHaveAttribute('aria-pressed', 'true');
    expect(container.querySelector('.map-network-stage')).toHaveClass('mode-tree');
  });

  test('can zoom out into a micro overview without removing nodes or connections', () => {
    const snapshot = createPreviewOrganizationSnapshot(30);
    const { container } = render(<OrquestaMap snapshot={snapshot} selectedAgentId={null} onSelectAgent={() => undefined} locale="en" />);
    const stage = container.querySelector('.map-network-stage')!;
    for (let index = 0; index < 9; index += 1) fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));

    expect(stage).toHaveClass('is-micro-overview');
    expect(container.querySelectorAll('[data-agent-id]')).toHaveLength(30);
    expect(container.querySelectorAll('[data-flow-source]').length).toBeGreaterThanOrEqual(27);
  });

  test('reports malformed parent graphs instead of silently treating them as healthy', () => {
    const snapshot = createPreviewOrganizationSnapshot(10);
    snapshot.agents = snapshot.agents.map((agent) => {
      if (agent.id === 'line-1-agent-01') return { ...agent, parentAgentId: 'missing-agent' };
      if (agent.id === 'line-1-agent-02') return { ...agent, parentAgentId: 'line-1-agent-03' };
      if (agent.id === 'line-1-agent-03') return { ...agent, parentAgentId: 'line-1-agent-02', lineId: null };
      return agent;
    });
    const layout = buildOrquestaMapLayout(snapshot, 'radial');

    expect(layout.diagnostics.orphanParentAgentIds).toEqual(['line-1-agent-01']);
    expect(layout.diagnostics.cycleAgentIds).toEqual(['line-1-agent-02', 'line-1-agent-03']);
    expect(layout.diagnostics.unassignedLineAgentIds).toEqual(['line-1-agent-03']);
  });
});
