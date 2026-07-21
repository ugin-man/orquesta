import { describe, expect, it } from 'vitest';
import { fixtureCatalog } from '../../src/fixtures';
import { agent } from '../../src/fixtures/helpers';
import { buildMapLayout, createStableLayout, groupBoundsForPositions, orthogonalPath, taskHasActiveEvidence } from '../../src/renderer/features/map/layout';
import { adaptiveFixtureScenarios } from '../../src/fixtures/adaptive-organization';

function twoLineSnapshot() {
  const base = fixtureCatalog['active-project'].snapshot;
  const agents = [
    agent({ id: 'orchestrator', displayName: '統括者', role: 'orchestrator', roleSummary: 'Coordinate', iconKey: 'network', roleId: 'orchestrator', organizationScope: 'project', organizationParentAgentId: 'user', assignedByAgentId: 'user' }),
    agent({ id: 'user-support', displayName: '利用者支援係', role: 'user-support', roleSummary: 'Support', iconKey: 'user', roleId: 'user-support', organizationScope: 'project', organizationParentAgentId: 'user', assignedByAgentId: 'user' }),
    agent({ id: 'orquesta-admin', displayName: '管理係', role: 'orquesta-admin', roleSummary: 'Admin', iconKey: 'database', roleId: 'orquesta-admin', organizationScope: 'project', organizationParentAgentId: 'user', assignedByAgentId: 'user' }),
    agent({ id: 'implementation-001', displayName: '実装係1', role: 'implementation', roleSummary: 'Desktop', iconKey: 'code', roleId: 'implementation', teamId: 'desktop-implementation', lineId: 'desktop-line', position: 'member', membershipOrdinal: 1, organizationScope: 'line', organizationParentAgentId: 'orchestrator', assignedByAgentId: 'orchestrator' }),
    agent({ id: 'implementation-002', displayName: '実装係2', role: 'implementation', roleSummary: 'Desktop', iconKey: 'code', roleId: 'implementation', teamId: 'desktop-implementation', lineId: 'desktop-line', position: 'member', membershipOrdinal: 2, organizationScope: 'line', organizationParentAgentId: 'implementation-001', assignedByAgentId: 'implementation-001' }),
    agent({ id: 'implementation-004', displayName: '実装係4', role: 'implementation', roleSummary: 'Core', iconKey: 'code', roleId: 'implementation', teamId: 'core-implementation', lineId: 'core-line', position: 'member', membershipOrdinal: 1, organizationScope: 'line', organizationParentAgentId: 'orchestrator', assignedByAgentId: 'orchestrator' })
  ];
  return {
    ...base,
    agents,
    organization: {
      revision: 12,
      source: 'explicit' as const,
      diagnostics: [],
      lines: [
        { id: 'desktop-line', displayName: 'Desktop', goal: 'Build Desktop', status: 'active', ownerAgentId: 'orchestrator', dedicatedLeadAgentId: 'implementation-001', displayOrder: 1, approvalSource: 'setup_confirmation' },
        { id: 'core-line', displayName: 'Core', goal: 'Build Core', status: 'active', ownerAgentId: 'orchestrator', dedicatedLeadAgentId: 'implementation-004', displayOrder: 2, approvalSource: 'setup_confirmation' }
      ],
      teams: [
        { id: 'desktop-implementation', lineId: 'desktop-line', displayName: 'Desktop 実装', purpose: 'Renderer', lifecycleState: 'active', displayOrder: 1 },
        { id: 'core-implementation', lineId: 'core-line', displayName: 'Core 実装', purpose: 'Core', lifecycleState: 'active', displayOrder: 1 }
      ],
      relationships: [
        { id: 'R1', type: 'reports_to', fromAgentId: 'implementation-001', toAgentId: 'orchestrator' },
        { id: 'R2', type: 'reports_to', fromAgentId: 'implementation-002', toAgentId: 'implementation-001' },
        { id: 'R3', type: 'reports_to', fromAgentId: 'implementation-004', toAgentId: 'orchestrator' }
      ],
      lineProposals: []
    }
  };
}

describe('map layout', () => {
  it.each(Object.entries(adaptiveFixtureScenarios))('keeps every %s fixture agent in one unique position', (_name, fixture) => {
    const layout = createStableLayout(fixture.snapshot);
    const ids = fixture.snapshot.agents
      .filter((item) => !(item.lifecycleState === 'superseded' && ['user-liaison', 'vision-curator', 'error-concierge'].includes(item.id)))
      .map((item) => item.id);
    const points = [...layout.agentPositions.values()].map((point) => `${point.x}:${point.y}`);

    expect(new Set(ids).size).toBe(ids.length);
    expect(layout.agentPositions.size).toBe(ids.length);
    expect(new Set(points).size).toBe(points.length);
  });

  it('covers explicit 35-agent and 80-agent adaptive organizations', () => {
    expect(adaptiveFixtureScenarios.thirtyFive.snapshot.agents).toHaveLength(35);
    expect(adaptiveFixtureScenarios.large.snapshot.agents).toHaveLength(80);
    expect(createStableLayout(adaptiveFixtureScenarios.large.snapshot).organization.source).toBe('explicit');
  });

  it('lays out canonical lines and teams without mixing the same role across lines', () => {
    const snapshot = twoLineSnapshot();
    const layout = createStableLayout(snapshot);

    expect(layout.lines.map((line) => line.id)).toEqual(['desktop-line', 'core-line']);
    expect(layout.lines[0].teamIds).toEqual(['desktop-implementation']);
    expect(layout.lines[1].teamIds).toEqual(['core-implementation']);
    expect(layout.lines[0].agentIds).toEqual(['implementation-001', 'implementation-002']);
    expect(layout.lines[1].agentIds).toEqual(['implementation-004']);
    expect(layout.agentPositions.size).toBe(snapshot.agents.length);
    expect(layout.agentPositions.get('implementation-001')).not.toEqual(layout.agentPositions.get('implementation-004'));
    expect(layout.lines.flatMap((line) => line.agentIds)).not.toContain('orchestrator');
    expect(layout.lines.map((line) => line.responsibleAgentId)).toEqual(['implementation-001', 'implementation-004']);
    expect(layout.lines.every((line) => line.headerHeight === 0)).toBe(true);
    expect(layout.regions.filter((region) => region.kind === 'team').every((region) => region.headerHeight === 0)).toBe(true);
    expect(layout.edges.filter((edge) => edge.lineId).map((edge) => edge.childId)).toEqual(['implementation-001', 'implementation-004']);
    expect(layout.edges.some((edge) => edge.childId.startsWith('line:') || edge.childId.startsWith('team:'))).toBe(false);
  });

  it('connects every populated team in one active line directly to the orchestrator when no line lead is required', () => {
    const base = twoLineSnapshot();
    const design = agent({
      id: 'design-001',
      displayName: '設計係',
      role: 'design',
      roleSummary: 'Desktop design',
      iconKey: 'vision',
      roleId: 'design',
      teamId: 'desktop-design',
      lineId: 'desktop-line',
      position: 'member',
      membershipOrdinal: 1,
      organizationScope: 'line',
      organizationParentAgentId: 'orchestrator',
      assignedByAgentId: 'orchestrator'
    });
    const implementation = {
      ...base.agents.find((item) => item.id === 'implementation-001')!,
      membershipOrdinal: 1,
      organizationParentAgentId: 'orchestrator'
    };
    const snapshot = {
      ...base,
      agents: [
        ...base.agents.filter((item) => ['orchestrator', 'user-support', 'orquesta-admin'].includes(item.id)),
        design,
        implementation
      ],
      organization: {
        ...base.organization,
        lines: [{ ...base.organization.lines[0], dedicatedLeadAgentId: null }],
        teams: [
          { id: 'desktop-design', lineId: 'desktop-line', displayName: '設計', purpose: 'Design', lifecycleState: 'active' as const, displayOrder: 1 },
          { ...base.organization.teams[0], displayOrder: 2 }
        ],
        relationships: [
          { id: 'R-DESIGN', type: 'reports_to' as const, fromAgentId: 'design-001', toAgentId: 'orchestrator' },
          { id: 'R-IMPLEMENTATION', type: 'reports_to' as const, fromAgentId: 'implementation-001', toAgentId: 'orchestrator' }
        ]
      }
    };

    const layout = createStableLayout(snapshot);
    const productionEdges = layout.edges.filter((edge) => edge.kind === 'production');

    expect(productionEdges).toHaveLength(2);
    expect(productionEdges.every((edge) => edge.parentId === 'orchestrator')).toBe(true);
    expect(productionEdges.map((edge) => edge.childId).sort()).toEqual(['design-001', 'implementation-001']);
  });

  it('keeps user support and admin on one row between the user and orchestrator', () => {
    const layout = createStableLayout(twoLineSnapshot());
    const orchestrator = layout.agentPositions.get('orchestrator')!;
    const support = layout.agentPositions.get('user-support')!;
    const admin = layout.agentPositions.get('orquesta-admin')!;

    expect(support.y).toBe(admin.y);
    expect(support.y).toBeGreaterThan(layout.user.y);
    expect(support.y).toBeLessThan(orchestrator.y);
    expect(support.x).toBeLessThan(orchestrator.x);
    expect(admin.x).toBeGreaterThan(orchestrator.x);
    expect(orchestrator.x - support.x).toBe(admin.x - orchestrator.x);
    expect(layout.organization.parentByAgentId.get('user-support')).toBe('user');
    expect(layout.organization.parentByAgentId.get('orquesta-admin')).toBe('user');
  });

  it('does not relayout canonical lines when only task and status state changes', () => {
    const snapshot = twoLineSnapshot();
    const first = createStableLayout(snapshot);
    const second = createStableLayout({
      ...snapshot,
      agents: snapshot.agents.map((item) => item.id === 'implementation-001'
        ? { ...item, status: 'blocked' as const, currentTaskId: 'T-CHANGED' }
        : item)
    });

    expect(second.lines).toEqual(first.lines);
    expect([...second.agentPositions]).toEqual([...first.agentPositions]);
  });

  it('keeps superseded support agents in history but out of the active organization map', () => {
    const base = twoLineSnapshot();
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

    const layout = createStableLayout(snapshot);

    expect(layout.agentPositions.has('implementation-002')).toBe(true);
    expect(layout.agentPositions.has('user-liaison')).toBe(false);
    expect(layout.agentPositions.has('vision-curator')).toBe(false);
    expect(layout.agentPositions.has('error-concierge')).toBe(false);
    expect(layout.compact).toBe(false);
  });

  it('places pending line proposals and invalid memberships in separate non-active regions', () => {
    const base = twoLineSnapshot();
    const template = base.agents.find((item) => item.id === 'implementation-001')!;
    const snapshot = {
      ...base,
      agents: [...base.agents, { ...template, id: 'orphan-agent', displayName: 'Orphan', lineId: 'missing-line', teamId: 'missing-team' }],
      organization: {
        ...base.organization,
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

    const layout = createStableLayout(snapshot);
    const proposal = layout.regions.find((region) => region.kind === 'proposal');
    const diagnostic = layout.regions.find((region) => region.kind === 'diagnostic');

    expect(layout.lines.map((line) => line.id)).not.toContain('mobile-line');
    expect(proposal).toMatchObject({ label: 'Mobile line', agentIds: [] });
    expect(diagnostic).toMatchObject({ agentIds: ['orphan-agent'] });
    expect(layout.agentPositions.has('orphan-agent')).toBe(true);
  });

  it('creates a stable unique position for every agent', () => {
    const snapshot = fixtureCatalog['large-roster'].snapshot;
    const first = buildMapLayout(snapshot.agents, snapshot.tasks);
    const second = buildMapLayout(snapshot.agents, snapshot.tasks);
    expect(first.nodes).toEqual(second.nodes);
    expect(first.nodes).toHaveLength(35);
    const points = new Set(first.nodes.map((node) => `${node.x.toFixed(2)}:${node.y.toFixed(2)}`));
    expect(points.size).toBe(35);
    expect(first.bounds.width).toBeGreaterThan(900);
  });

  it('animates only work with observed runtime evidence', () => {
    const active = fixtureCatalog['active-project'].snapshot.tasks.find((task) => task.id === 'T68');
    const dispatchOnly = fixtureCatalog['unknown-evidence'].snapshot.tasks.find((task) => task.id === 'U12');
    expect(active && taskHasActiveEvidence(active)).toBe(true);
    expect(dispatchOnly && taskHasActiveEvidence(dispatchOnly)).toBe(false);
  });

  it('uses straight orthogonal commands for organization links', () => {
    const path = orthogonalPath({ x: 40, y: 20 }, { x: 180, y: 140 });
    expect(path).toBe('M 40 20 V 80 H 180 V 140');
    expect(path).not.toContain('C');
  });

  it('routes grouped roots to the top of the agent instead of through its center', () => {
    const snapshot = fixtureCatalog['large-roster'].snapshot;
    const layout = createStableLayout(snapshot.agents);
    const group = layout.groups.find((candidate) => candidate.agentIds.length > 1);
    expect(group).toBeDefined();

    const rootEdge = layout.edges.find((edge) => edge.parentId === `group:${group!.id}`);
    const rootPosition = rootEdge ? layout.agentPositions.get(rootEdge.childId) : undefined;
    expect(rootEdge).toBeDefined();
    expect(rootPosition).toBeDefined();
    expect(rootEdge!.to.y).toBe(rootPosition!.y - layout.nodeHeight / 2);
  });

  it('keeps useful frame padding after grouped agents are moved', () => {
    const snapshot = fixtureCatalog['large-roster'].snapshot;
    const layout = createStableLayout(snapshot.agents);
    const group = layout.groups.find((candidate) => candidate.agentIds.length > 1)!;
    const positions = new Map(layout.agentPositions);
    const first = positions.get(group.agentIds[0])!;
    positions.set(group.agentIds[0], { x: first.x - 80, y: first.y - 120 });

    const bounds = groupBoundsForPositions(group, positions, layout.nodeWidth, layout.nodeHeight);
    const groupPoints = group.agentIds.map((agentId) => positions.get(agentId)!).filter(Boolean);
    const left = Math.min(...groupPoints.map((point) => point.x - layout.nodeWidth / 2));
    const top = Math.min(...groupPoints.map((point) => point.y - layout.nodeHeight / 2));
    const right = Math.max(...groupPoints.map((point) => point.x + layout.nodeWidth / 2));
    const bottom = Math.max(...groupPoints.map((point) => point.y + layout.nodeHeight / 2));

    expect(bounds.x).toBe(left - 52);
    expect(bounds.y).toBe(top - 92);
    expect(bounds.x + bounds.width).toBe(right + 52);
    expect(bounds.y + bounds.height).toBe(bottom + 44);
  });
});
