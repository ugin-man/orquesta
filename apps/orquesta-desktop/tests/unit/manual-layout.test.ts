import { describe, expect, test } from 'vitest';
import {
  applyManualOffsets,
  clearManualOffsets,
  loadManualOffsets,
  saveManualOffsets,
  type ManualOffsets
} from '../../src/renderer/features/map/manual-layout';

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
});
