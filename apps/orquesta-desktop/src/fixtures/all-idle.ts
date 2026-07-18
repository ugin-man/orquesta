import type { FixtureDefinition } from './types';
import { activeProjectFixture } from './active-project';

const fixture = structuredClone(activeProjectFixture);
fixture.snapshot.project = {
  ...fixture.snapshot.project,
  id: 'all-idle',
  title: 'Quiet Workspace',
  status: 'ready',
  connectionLabel: 'Ready · no active turns',
  currentPhaseId: 'phase-review',
  provenWorkingAgentCount: 0,
  summary: 'All specialists are standing by'
};
fixture.snapshot.agents = fixture.snapshot.agents.map((agent) => ({
  ...agent,
  status: 'standby',
  statusLabel: 'Idle',
  currentTaskId: null,
  currentTaskTitle: null,
  recentEvidence: []
}));
fixture.snapshot.tasks = [];
fixture.snapshot.attention = [];
fixture.snapshot.recentEvents = [];
fixture.conversations = { orchestrator: fixture.conversations.orchestrator ?? [] };
fixture.lastOpenedAt = '2026-07-16T17:10:00.000Z';

export const allIdleFixture: FixtureDefinition = fixture;
