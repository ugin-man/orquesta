import type { FixtureDefinition } from './types';
import { activeProjectFixture } from './active-project';

const fixture = structuredClone(activeProjectFixture);
fixture.snapshot.project = {
  ...fixture.snapshot.project,
  id: 'offline-project',
  title: 'Disconnected Repository',
  status: 'offline',
  connectionLabel: 'Offline · repository snapshot only',
  repositoryDisplayState: 'offline',
  lastSyncedAt: '2026-07-17T11:42:00.000Z',
  provenWorkingAgentCount: 0,
  summary: 'Last known snapshot retained; live state unavailable'
};
fixture.snapshot.agents = fixture.snapshot.agents.map((agent) => ({
  ...agent,
  status: 'stale',
  statusLabel: 'Stale',
  statusEvidence: 'unknown',
  recentEvidence: []
}));
fixture.snapshot.recentEvents = [];
fixture.snapshot.attention = [
  {
    id: 'OFFLINE-1', type: 'repair', actionKind: 'do', priority: 'blocker', title: 'Connection unavailable', summary: 'Reconnect the project bridge to refresh runtime evidence.',
    sourceAgentId: 'orchestrator', taskId: null, blocking: true, primaryActionLabel: 'Details', createdAt: '2026-07-17T11:43:00.000Z', resolvedAt: null, resolutionLabel: null
  }
];
fixture.lastOpenedAt = '2026-07-17T11:42:00.000Z';

export const offlineProjectFixture: FixtureDefinition = fixture;
