import { expect, test } from 'vitest';
import { parseAttention } from '../src/domain/validation';

const base = {
  id: 'user-action:UA1',
  sourceKind: 'user_action',
  type: 'repair',
  actionKind: 'do',
  priority: 'medium',
  title: 'Repair access',
  summary: 'A curated user action is ready.',
  sourceAgentId: 'user-support',
  taskId: null,
  blocking: false,
  createdAt: '2026-08-28T00:00:00.000Z',
  resolvedAt: null,
  resolutionDecision: null,
  runtimeApproval: null,
};

test('keeps typed canonical attention provenance in the Desktop domain', () => {
  expect(parseAttention(base)).toMatchObject({
    id: 'user-action:UA1',
    sourceKind: 'user_action',
    runtimeApproval: null,
  });
});

test('fails closed when canonical attention provenance is missing, unknown, or runtime-owned', () => {
  const missing: Record<string, unknown> = { ...base };
  delete missing.sourceKind;
  expect(() => parseAttention(missing)).toThrow('Attention item is invalid.');
  expect(() => parseAttention({ ...base, sourceKind: 'raw_incident' })).toThrow('Attention item is invalid.');
  expect(() => parseAttention({ ...base, sourceKind: 'runtime_approval' })).toThrow('Attention item is invalid.');
  expect(() => parseAttention({
    ...base,
    sourceKind: 'user_action',
    runtimeApproval: { requestId: 'req-1' },
  })).toThrow('Attention item is invalid.');
});
