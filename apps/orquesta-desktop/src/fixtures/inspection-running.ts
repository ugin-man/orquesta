import type { InspectionRunUiModel } from '../contracts/orquesta-ui';
import { adaptiveTwoLineFixture } from './adaptive-organization';
import type { FixtureDefinition } from './types';

const inspectionRuns: InspectionRunUiModel[] = [
  {
    runId: 'BENCH-RUNNING',
    kind: 'external_benchmark',
    displayName: 'External benchmark',
    status: 'running',
    target: { kind: 'project', ids: [], label: adaptiveTwoLineFixture.snapshot.project.title },
    focus: 'Desktop orchestration competitors',
    threadId: 'thread-benchmark',
    turnId: 'turn-benchmark',
    reportPath: null,
    sourceCount: 0,
    errorCode: null,
    errorMessage: null,
    createdAt: '2026-07-21T10:00:00.000Z',
    completedAt: null
  },
  {
    runId: 'AUDIT-RUNNING',
    kind: 'adversarial_audit',
    displayName: 'Adversarial audit',
    status: 'running',
    target: { kind: 'project', ids: [], label: adaptiveTwoLineFixture.snapshot.project.title },
    focus: null,
    threadId: 'thread-audit',
    turnId: 'turn-audit',
    reportPath: null,
    sourceCount: 0,
    errorCode: null,
    errorMessage: null,
    createdAt: '2026-07-21T10:00:05.000Z',
    completedAt: null
  }
];

export const inspectionRunningFixture: FixtureDefinition = {
  ...adaptiveTwoLineFixture,
  snapshot: {
    ...adaptiveTwoLineFixture.snapshot,
    project: { ...adaptiveTwoLineFixture.snapshot.project, id: 'inspection-running', title: 'Inspection agents active' },
    inspectionRuns,
    inspectionTemplates: adaptiveTwoLineFixture.snapshot.inspectionTemplates.map((template) => ({
      ...template,
      activeRunId: inspectionRuns.find((run) => run.kind === template.kind)?.runId ?? null
    }))
  }
};
