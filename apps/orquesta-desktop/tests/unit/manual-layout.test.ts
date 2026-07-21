import { describe, expect, test } from 'vitest';
import {
  applyManualLayoutPositions,
  applyManualLayoutRegions,
  applyManualOffsets,
  clearManualOffsets,
  createManualLayoutState,
  loadManualLayout,
  loadManualOffsets,
  pruneManualLayout,
  saveManualLayout,
  saveManualOffsets,
  type ManualLayoutState,
  type ManualOffsets
} from '../../src/renderer/features/map/manual-layout';
import type { MapRegionLayout } from '../../src/renderer/features/map/layout';

describe('manual map layout', () => {
  test('persists finite per-project offsets and ignores corrupt entries', () => {
    const offsets: ManualOffsets = {
      'implementation-001': { x: 44, y: -18 },
      broken: { x: Number.NaN, y: 2 }
    };
    saveManualOffsets('demo', offsets, window.localStorage);

    expect(loadManualOffsets('demo', window.localStorage)).toEqual({
      'implementation-001': { x: 44, y: -18 }
    });
  });

  test('keeps another project isolated and reset clears only the selected project', () => {
    saveManualOffsets('alpha', { one: { x: 10, y: 20 } }, window.localStorage);
    saveManualOffsets('beta', { two: { x: 30, y: 40 } }, window.localStorage);
    clearManualOffsets('alpha', window.localStorage);

    expect(loadManualOffsets('alpha', window.localStorage)).toEqual({});
    expect(loadManualOffsets('beta', window.localStorage)).toEqual({ two: { x: 30, y: 40 } });
  });

  test('applies offsets without mutating base positions', () => {
    const base = new Map([['agent', { x: 100, y: 80 }]]);
    const result = applyManualOffsets(base, { agent: { x: 12, y: -7 } });

    expect(result.get('agent')).toEqual({ x: 112, y: 73 });
    expect(base.get('agent')).toEqual({ x: 100, y: 80 });
  });

  test('does not import legacy agent offsets into a canonical organization revision', () => {
    saveManualOffsets('legacy', { 'implementation-001': { x: 14, y: -6 } }, window.localStorage);

    expect(loadManualLayout('legacy', 9, window.localStorage)).toEqual({
      version: 3,
      organizationRevision: 9,
      lineOffsets: {},
      teamOffsets: {},
      agentOffsets: {},
      inspectionOffsets: {}
    });
  });

  test('persists line, team, and agent offsets while sanitizing invalid points', () => {
    const state: ManualLayoutState = {
      version: 3,
      organizationRevision: 3,
      lineOffsets: { desktop: { x: 40, y: 20 } },
      teamOffsets: { implementation: { x: -8, y: 11 } },
      inspectionOffsets: {},
      agentOffsets: {
        'implementation-001': { x: 2, y: 4 },
        broken: { x: Number.POSITIVE_INFINITY, y: 4 }
      }
    };

    saveManualLayout('demo-v2', state, window.localStorage);

    expect(loadManualLayout('demo-v2', 3, window.localStorage)).toEqual({
      version: 3,
      organizationRevision: 3,
      lineOffsets: { desktop: { x: 40, y: 20 } },
      teamOffsets: { implementation: { x: -8, y: 11 } },
      agentOffsets: { 'implementation-001': { x: 2, y: 4 } },
      inspectionOffsets: {}
    });
    expect(loadManualLayout('demo-v2', 4, window.localStorage)).toEqual(createManualLayoutState(4));
  });

  test('keeps version 3 agent positions when inspection offsets were not saved yet', () => {
    window.localStorage.setItem('orquesta.desktop.map-layout.before-inspections', JSON.stringify({
      version: 3,
      organizationRevision: 3,
      lineOffsets: { desktop: { x: 40, y: 20 } },
      teamOffsets: {},
      agentOffsets: { 'implementation-001': { x: 2, y: 4 } }
    }));

    expect(loadManualLayout('before-inspections', 3, window.localStorage)).toEqual({
      version: 3,
      organizationRevision: 3,
      lineOffsets: { desktop: { x: 40, y: 20 } },
      teamOffsets: {},
      agentOffsets: { 'implementation-001': { x: 2, y: 4 } },
      inspectionOffsets: {}
    });
  });

  test('persists only the two stable inspection offsets in version 3 state', () => {
    const state = {
      ...createManualLayoutState(3),
      inspectionOffsets: {
        external_benchmark: { x: -30, y: 12 },
        adversarial_audit: { x: 26, y: -8 },
        retired_experiment: { x: 9, y: 9 }
      }
    };

    saveManualLayout('inspection-offsets', state, window.localStorage);

    expect(loadManualLayout('inspection-offsets', 3, window.localStorage)).toEqual({
      version: 3,
      organizationRevision: 3,
      lineOffsets: {},
      teamOffsets: {},
      agentOffsets: {},
      inspectionOffsets: {
        external_benchmark: { x: -30, y: 12 },
        adversarial_audit: { x: 26, y: -8 }
      }
    });
  });

  test('discards version 2 offsets left by the pre-migration Desktop map', () => {
    window.localStorage.setItem('orquesta.desktop.map-layout.stale-v2', JSON.stringify({
      version: 2,
      organizationRevision: 2,
      lineOffsets: { old: { x: 400, y: 200 } },
      teamOffsets: {},
      agentOffsets: { 'orquesta-admin': { x: 300, y: -100 } }
    }));

    expect(loadManualLayout('stale-v2', 2, window.localStorage)).toEqual(createManualLayoutState(2));
  });

  test('inherits line and team movement while keeping individual movement local', () => {
    const state = createManualLayoutState(7);
    state.lineOffsets.desktop = { x: 100, y: 10 };
    state.teamOffsets.implementation = { x: -20, y: 30 };
    state.agentOffsets['implementation-001'] = { x: 5, y: -2 };
    const base = new Map([
      ['implementation-001', { x: 50, y: 60 }],
      ['implementation-002', { x: 150, y: 60 }],
      ['orchestrator', { x: 100, y: 10 }]
    ]);
    const membership = new Map([
      ['implementation-001', { lineId: 'desktop', teamId: 'implementation' }],
      ['implementation-002', { lineId: 'desktop', teamId: 'implementation' }],
      ['orchestrator', { lineId: null, teamId: null }]
    ]);

    const result = applyManualLayoutPositions(base, state, membership);

    expect(result.get('implementation-001')).toEqual({ x: 135, y: 98 });
    expect(result.get('implementation-002')).toEqual({ x: 230, y: 100 });
    expect(result.get('orchestrator')).toEqual({ x: 100, y: 10 });
  });

  test('moves nested line, team, and role regions through the same hierarchy', () => {
    const region = (value: Partial<MapRegionLayout> & Pick<MapRegionLayout, 'id' | 'kind' | 'parentId'>): MapRegionLayout => ({
      label: value.id,
      agentIds: [],
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      headerHeight: 20,
      inputPort: { x: 100, y: 0 },
      ...value
    });
    const regions = [
      region({ id: 'desktop', kind: 'line', parentId: null }),
      region({ id: 'team:implementation', kind: 'team', parentId: 'line:desktop', x: 20, y: 30 }),
      region({ id: 'role:implementation', kind: 'role', parentId: 'team:implementation', x: 30, y: 50 })
    ];
    const state = createManualLayoutState(2);
    state.lineOffsets.desktop = { x: 80, y: 5 };
    state.teamOffsets.implementation = { x: 10, y: 20 };

    const result = applyManualLayoutRegions(regions, state);

    expect(result[0]).toMatchObject({ x: 80, y: 5, inputPort: { x: 180, y: 5 } });
    expect(result[1]).toMatchObject({ x: 110, y: 55, inputPort: { x: 190, y: 25 } });
    expect(result[2]).toMatchObject({ x: 120, y: 75, inputPort: { x: 190, y: 25 } });
  });

  test('drops offsets for organization IDs that disappeared after a revision', () => {
    const state = createManualLayoutState(2);
    state.lineOffsets = { desktop: { x: 10, y: 10 }, removed: { x: 99, y: 99 } };
    state.teamOffsets = { implementation: { x: 20, y: 20 }, oldTeam: { x: 99, y: 99 } };
    state.agentOffsets = { coder: { x: 30, y: 30 }, oldAgent: { x: 99, y: 99 } };

    expect(pruneManualLayout(state, {
      lineIds: new Set(['desktop']),
      teamIds: new Set(['implementation']),
      agentIds: new Set(['coder'])
    })).toEqual({
      version: 3,
      organizationRevision: 2,
      lineOffsets: { desktop: { x: 10, y: 10 } },
      teamOffsets: { implementation: { x: 20, y: 20 } },
      agentOffsets: { coder: { x: 30, y: 30 } },
      inspectionOffsets: {}
    });
  });
});
