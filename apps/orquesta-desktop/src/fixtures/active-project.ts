import type { FixtureDefinition } from './types';
import { agent, attention, failure, fixtureV4Operations, observedAt, phase, task } from './helpers';

const agents = [
  agent({
    id: 'orchestrator', displayName: 'Orchestrator', role: 'Orchestrator', roleSummary: 'Multi-Agent Coordinator', iconKey: 'network',
    status: 'working', statusLabel: 'Working', currentTaskId: 'T69', currentTaskTitle: 'Coordinate multi-agent delivery',
    assignedByAgentId: 'user', contextScope: 'Routes work and preserves evidence boundaries.', requiredReadingCount: 5,
    expectedArtifact: 'Accepted project outcome',
    recentEvidence: [{ id: 'E69', label: 'Turn started', detail: 'Coordinator turn observed.', level: 'proven', observedAt }],
    history: [{ id: 'H69', title: 'Accepted user direction', state: 'in_progress', changedAt: observedAt }]
  }),
  agent({
    id: 'analyst', displayName: 'Analyst', role: 'Analyst', roleSummary: 'Data & Insight', iconKey: 'chart',
    status: 'working', statusLabel: 'Working', currentTaskId: 'T68', currentTaskTitle: 'Data synthesis', assignedByAgentId: 'orchestrator',
    contextScope: 'Analysis scope and selected data extracts.', expectedArtifact: 'Findings memo',
    recentEvidence: [{ id: 'E68a', label: 'Progress observed', detail: 'Three source groups reconciled.', level: 'proven', observedAt }],
    history: [{ id: 'H68', title: 'Data synthesis', state: 'in_progress', changedAt: observedAt }]
  }),
  agent({
    id: 'connector', displayName: 'Connector', role: 'Connector', roleSummary: 'Data Access', iconKey: 'database',
    status: 'working', statusLabel: 'Working', currentTaskId: 'T66', currentTaskTitle: 'Sync data sources', assignedByAgentId: 'orchestrator',
    blockedReason: 'Intermittent API timeout', waitingOn: 'Automatic retry', expectedArtifact: 'Normalized data snapshot',
    recentEvidence: [{ id: 'E66', label: 'Retry observed', detail: 'Connection retry scheduled in 15 seconds.', level: 'proven', observedAt }]
  }),
  agent({
    id: 'coder', displayName: 'Coder', role: 'Coder', roleSummary: 'Implementation', iconKey: 'code',
    status: 'working', statusLabel: 'Working', currentTaskId: 'T70', currentTaskTitle: 'Implement parser', assignedByAgentId: 'orchestrator',
    expectedArtifact: 'Parser module and tests',
    recentEvidence: [{ id: 'E70', label: 'Progress observed', detail: 'Schema parser tests are green.', level: 'proven', observedAt }]
  }),
  agent({ id: 'writer', displayName: 'Writer', role: 'Writer', roleSummary: 'Content & Docs', iconKey: 'file', status: 'standby', statusLabel: 'Idle' }),
  agent({ id: 'researcher', displayName: 'Researcher', role: 'Researcher', roleSummary: 'Web & Knowledge', iconKey: 'search', status: 'standby', statusLabel: 'Idle' }),
  agent({ id: 'reviewer', displayName: 'Reviewer', role: 'Reviewer', roleSummary: 'QA & Validation', iconKey: 'shield', status: 'standby', statusLabel: 'Idle' })
];

const tasks = [
  task({
    id: 'T69', title: 'Coordinate multi-agent delivery', state: 'in_progress', ownerAgentId: 'orchestrator', assignedByAgentId: 'user',
    handoffSent: true, dispatchAccepted: true, turnStarted: true, progressObserved: true, progressSummary: 'Delegated analysis, data, and implementation work.', progressPercent: 44,
    routingClass: 'orchestration', actualModel: 'gpt-5.6-pro', actualModelEvidence: 'proven', startedAt: '2026-07-17T13:20:00.000Z',
    expectedArtifact: 'Accepted integrated result', acceptanceChecks: ['Every specialist report is evidence-backed.', 'User actions are surfaced in Attention.']
  }),
  task({
    id: 'T68', title: 'Data synthesis', state: 'in_progress', ownerAgentId: 'analyst', assignedByAgentId: 'orchestrator',
    handoffSent: true, dispatchAccepted: true, turnStarted: true, progressObserved: true, progressSummary: 'Reconciling source groups and drafting findings.', progressPercent: 72,
    routingClass: 'analysis', recommendedModel: 'gpt-5.6-pro', requestedModel: 'gpt-5.6-pro', actualModel: 'gpt-5.6-pro', actualModelEvidence: 'proven',
    startedAt: '2026-07-17T13:24:00.000Z', expectedArtifact: 'Findings memo', acceptanceChecks: ['Citations trace to source records.', 'Conflicts are labeled.']
  }),
  task({
    id: 'T66', title: 'Sync data sources', state: 'blocked', ownerAgentId: 'connector', assignedByAgentId: 'orchestrator',
    handoffSent: true, dispatchAccepted: true, turnStarted: true, progressObserved: true, progressSummary: 'Two of three sources synchronized; one API is retrying.', progressPercent: 61,
    routingClass: 'data-access', blockedBy: ['External API timeout'], actualModel: 'gpt-5.4-mini', actualModelEvidence: 'reported',
    startedAt: '2026-07-17T13:23:30.000Z', expectedArtifact: 'Normalized data snapshot', acceptanceChecks: ['All source checksums recorded.']
  }),
  task({
    id: 'T70', title: 'Implement parser', state: 'in_progress', ownerAgentId: 'coder', assignedByAgentId: 'orchestrator',
    dependencies: ['T66'], handoffSent: true, dispatchAccepted: true, turnStarted: true, progressObserved: true, progressSummary: 'Parser core implemented; edge cases remain.', progressPercent: 38,
    routingClass: 'implementation', actualModel: 'gpt-5.5-codex', actualModelEvidence: 'proven', startedAt: '2026-07-17T13:25:00.000Z',
    expectedArtifact: 'Typed parser module', acceptanceChecks: ['Unit tests cover malformed input.', 'No filesystem calls in Renderer.']
  }),
  task({ id: 'T67', title: 'Clarify scope of analysis', state: 'approval_wait', ownerAgentId: 'analyst', assignedByAgentId: 'orchestrator', userActionId: 'A67' }),
  task({ id: 'T65', title: 'Approve data access plan', state: 'approval_wait', ownerAgentId: 'reviewer', assignedByAgentId: 'orchestrator', userActionId: 'A65' })
];

export const activeProjectFixture: FixtureDefinition = {
  snapshot: {
    project: {
      id: 'active-project', title: 'Local Multi-Agent Orchestration', rootPathLabel: '~/projects/orquesta-v4', status: 'working', connectionLabel: 'Local bridge ready',
      isDemoData: true, repositoryDisplayState: 'demo', lastSyncedAt: observedAt, currentPhaseId: 'phase-build', agentCount: 6, provenWorkingAgentCount: 3,
      summary: 'Renderer handoff and local orchestration workflow', nextMilestone: 'Visual review and Electron intake'
    },
    agents,
    tasks,
    attention: [
      attention({ id: 'A67', type: 'question', title: 'Question', summary: 'Clarify scope of analysis.', sourceAgentId: 'analyst', taskId: 'T67', primaryActionLabel: 'View' }),
      attention({ id: 'A65', type: 'approval', title: 'Approval', summary: 'Approve data access plan.', sourceAgentId: 'reviewer', taskId: 'T65', priority: 'high', blocking: true, primaryActionLabel: 'Review' }),
      attention({ id: 'A66', type: 'error', title: 'Error', summary: 'Timeout connecting to API.', sourceAgentId: 'connector', taskId: 'T66', priority: 'high', primaryActionLabel: 'Details' })
    ],
    failures: [
      failure({
        id: 'FC66', source: 'cluster', failureClass: 'network.timeout', title: 'External API timeout', summary: 'The same source timed out during three bounded attempts.',
        severity: 'high', status: 'open', occurrenceCount: 3, firstOccurredAt: '2026-07-17T13:12:00.000Z', lastOccurredAt: observedAt,
        taskIds: ['T66'], sourceAgentIds: ['connector'], suspectedOwner: 'shared', repairStatus: 'waiting', cause: 'The remote source stopped responding.', fix: 'Wait for recovery, then retry once.',
        prevention: ['Keep retries bounded and preserve the original error.'], evidence: ['Three timeout responses were recorded.'],
        occurrences: [
          { id: 'IC66-3', source: 'candidate', status: 'clustered', summary: 'Third API timeout.', occurredAt: observedAt, taskId: 'T66', sourceAgentId: 'connector', evidence: ['timeout attempt 3'], attemptedFixes: ['Changed endpoint.'], outcome: null },
          { id: 'IC66-2', source: 'candidate', status: 'clustered', summary: 'Second API timeout.', occurredAt: '2026-07-17T13:20:00.000Z', taskId: 'T66', sourceAgentId: 'connector', evidence: ['timeout attempt 2'], attemptedFixes: ['Retried once.'], outcome: null }
        ]
      }),
      failure({
        id: 'failure-class:encoding.corruption', failureClass: 'encoding.corruption', title: 'State encoding repaired', summary: 'The damaged JSON state was rebuilt as UTF-8.',
        status: 'resolved', resolution: 'resolved', firstOccurredAt: '2026-07-16T08:00:00.000Z', lastOccurredAt: '2026-07-16T08:00:00.000Z',
        taskIds: ['T64'], sourceAgentIds: ['orchestrator'], suspectedOwner: 'codex', repairStatus: 'resolved', cause: 'Text passed through a non-UTF-8 console path.', fix: 'Rebuilt the state file as UTF-8.',
        prevention: ['Read and write Japanese JSON with explicit UTF-8.'], evidence: ['The repaired JSON parsed successfully.'],
        occurrences: [{ id: 'F64', source: 'incident', status: 'resolved', summary: 'The damaged JSON state was rebuilt.', occurredAt: '2026-07-16T08:00:00.000Z', taskId: 'T64', sourceAgentId: 'orchestrator', evidence: ['JSON parsed.'], attemptedFixes: [], outcome: 'Rebuilt as UTF-8.' }]
      }),
      failure({
        id: 'IC-BROWSER', source: 'candidate', failureClass: 'browser.runtime', title: 'Browser runtime candidate', summary: 'A browser startup error still needs classification.',
        severity: 'low', status: 'candidate', taskIds: ['T70'], sourceAgentIds: ['reviewer'], suspectedOwner: 'unknown', repairStatus: 'candidate', evidence: ['One unclassified systemError.'],
        occurrences: [{ id: 'IC-BROWSER', source: 'candidate', status: 'candidate', summary: 'Browser startup returned systemError.', occurredAt: observedAt, taskId: 'T70', sourceAgentId: 'reviewer', evidence: ['systemError'], attemptedFixes: [], outcome: null }]
      })
    ],
    phases: [
      phase({ id: 'phase-foundation', title: 'Foundation', summary: 'Contracts and fixtures', status: 'done', ownerAgentIds: ['orchestrator', 'coder'], itemCount: 8, completedItemCount: 8 }),
      phase({ id: 'phase-build', title: 'Renderer build', summary: 'Map, instruments, and overlays', status: 'current', ownerAgentIds: ['coder', 'analyst'], itemCount: 14, completedItemCount: 8 }),
      phase({ id: 'phase-review', title: 'Visual review', summary: 'User acceptance against approved image', status: 'queued', ownerAgentIds: ['reviewer'], itemCount: 6, completedItemCount: 0 }),
      phase({ id: 'phase-electron', title: 'Desktop integration', summary: 'Electron main, preload, and real bridge', status: 'queued', ownerAgentIds: ['connector'], itemCount: 10, completedItemCount: 0 })
    ],
    recentEvents: [{ id: 'toast-T66', tone: 'danger', title: 'Connector', message: 'Timeout connecting to API. Retrying in 15s.', taskId: 'T66', createdAt: observedAt }],
    v4Operations: fixtureV4Operations
  },
  conversations: {
    orchestrator: [
      { id: 'C1', role: 'user', targetAgentId: 'orchestrator', authorLabel: 'You', text: 'Build the approved desktop Renderer and keep the Electron boundary clean.', createdAt: '2026-07-17T13:18:00.000Z', evidenceLabel: null },
      { id: 'C2', role: 'agent', targetAgentId: 'orchestrator', authorLabel: 'Orchestrator', text: 'Renderer work is delegated. I will only mark work active where runtime evidence exists.', createdAt: '2026-07-17T13:20:00.000Z', evidenceLabel: 'Prototype conversation' },
      { id: 'C3', role: 'system', targetAgentId: 'orchestrator', authorLabel: 'System event', text: 'T68 turn started and progress was observed.', createdAt: observedAt, evidenceLabel: 'Mock evidence' }
    ],
    analyst: [
      { id: 'C4', role: 'agent', targetAgentId: 'analyst', authorLabel: 'Analyst', text: 'The analysis route is active.', createdAt: observedAt, evidenceLabel: 'Prototype conversation' }
    ]
  },
  attentionHistory: [
    attention({ id: 'AH1', type: 'question', title: 'Question answered', summary: 'Confirm the approved reference image.', sourceAgentId: 'orchestrator', taskId: 'T69', resolvedAt: '2026-07-17T13:16:00.000Z', resolutionLabel: 'Image attached' }),
    attention({ id: 'AH2', type: 'report_review', title: 'Report accepted', summary: 'Architecture contract review passed.', sourceAgentId: 'reviewer', taskId: 'T64', resolvedAt: '2026-07-17T13:12:00.000Z', resolutionLabel: 'Accepted' })
  ],
  agentProposals: [
    { id: 'P1', displayName: 'Accessibility Auditor', role: 'Support specialist', reason: 'Validate keyboard flow, contrast, and reduced motion before Electron intake.', contextScope: 'Rendered UI and accessibility test output only', approvalRequired: true, capacityLabel: 'Standby capacity available' },
    { id: 'P2', displayName: 'Localization Reviewer', role: 'Support specialist', reason: 'Check long Japanese labels without changing the visual hierarchy.', contextScope: 'ja/en message dictionaries and rendered layouts', approvalRequired: true, capacityLabel: 'One temporary seat' }
  ],
  lastOpenedAt: observedAt
};
