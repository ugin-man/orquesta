import type { AttentionUiItem } from '../contracts/orquesta-ui';
import type { FixtureDefinition } from './types';
import { activeProjectFixture } from './active-project';

const fixture = structuredClone(activeProjectFixture);
const types: AttentionUiItem['type'][] = ['approval', 'question', 'error', 'report_review', 'repair', 'direction'];
fixture.snapshot.project = { ...fixture.snapshot.project, id: 'attention-heavy', title: 'Release Review Queue', status: 'blocked', connectionLabel: 'Blocked by user review', summary: 'High-volume review fixture' };
fixture.snapshot.attention = Array.from({ length: 45 }, (_, index) => ({
  id: `HEAVY-${index + 1}`,
  type: types[index % types.length],
  priority: index < 3 ? 'blocker' : index < 12 ? 'high' : 'medium',
  title: index % 3 === 0 ? 'Approval required' : index % 3 === 1 ? 'Question' : 'Review item',
  summary: `User action ${index + 1} needs a bounded decision before this route can continue.`,
  sourceAgentId: fixture.snapshot.agents[(index % (fixture.snapshot.agents.length - 1)) + 1].id,
  taskId: fixture.snapshot.tasks[index % fixture.snapshot.tasks.length]?.id ?? null,
  blocking: index < 8,
  primaryActionLabel: index % 2 ? 'View' : 'Review',
  createdAt: `2026-07-17T12:${String(index % 60).padStart(2, '0')}:00.000Z`,
  resolvedAt: null,
  resolutionLabel: null
}));
fixture.attentionHistory = Array.from({ length: 120 }, (_, index) => ({
  id: `HISTORY-${index + 1}`,
  type: types[index % types.length],
  priority: 'low',
  title: `Resolved item ${index + 1}`,
  summary: `Archived user action ${index + 1}.`,
  sourceAgentId: fixture.snapshot.agents[(index % (fixture.snapshot.agents.length - 1)) + 1].id,
  taskId: null,
  blocking: false,
  primaryActionLabel: 'View',
  createdAt: `2026-07-16T10:${String(index % 60).padStart(2, '0')}:00.000Z`,
  resolvedAt: `2026-07-16T11:${String(index % 60).padStart(2, '0')}:00.000Z`,
  resolutionLabel: 'Resolved in prototype'
}));
fixture.snapshot.recentEvents = [];
fixture.lastOpenedAt = '2026-07-17T12:59:00.000Z';

export const attentionHeavyFixture: FixtureDefinition = fixture;
