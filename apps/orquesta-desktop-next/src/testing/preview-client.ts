import type {
  ComposerAttachment,
  ConversationActivity,
  ConversationActivityCursor,
  ConversationMessage,
  ConversationCursor,
  ConversationReadCheckpoint,
  ConversationSnapshot,
  DesktopBootstrap,
  DesktopEvent,
  DispatchSendResult,
  DispatchRecovery,
  DispatchRecoveryResult,
  HistoryConversationPage,
  HistoryCursor,
  HistoryIndexPage,
  NativeSettings,
  ProjectArchiveMutation,
  ProjectSummary,
  ProjectBootstrapResult,
  ProjectedPendingRequest,
  ProjectedResolvedRequest,
  RendererAuthority,
  RuntimeAuthority,
  RuntimeStatus,
  WorkspaceSnapshot,
  BusinessSourceCursor,
  BusinessWorkOrdersResult,
  WorkflowCatalog,
  WorkflowCheck,
  VoiceOperationStatus,
  VoiceStatus,
} from '../domain/models';
import { compareConversationEntryOrder } from '../domain/exact-order';
import {
  type AttachmentBinarySource,
  type DesktopClient,
  type SendMessageInput,
  type StartInspectionInput,
  type SteerTurnInput,
  type VoiceTranscriptionBindingInput,
} from '../ports/desktop-client';

const now = '2026-08-10T08:42:00.000Z';
const renderer: RendererAuthority = { rendererSessionId: 'preview-renderer', rendererGeneration: 1 };
const readyStatus: RuntimeStatus = {
  lifecycle: 'Ready',
  projectId: 'orquesta-v5',
  activationToken: 'preview-activation',
  rendererSessionId: renderer.rendererSessionId,
  rendererGeneration: renderer.rendererGeneration,
  runtimeGeneration: '77777777-7777-4777-8777-777777777777',
  statusRevision: 12,
  failureReason: null,
};

export const previewProjects: ProjectSummary[] = [
  {
    id: 'orquesta-v5',
    title: 'Orquesta Desktop Next',
    rootPath: 'C:\\Projects\\orquesta',
    rootPathLabel: 'C:\\Projects\\orquesta',
    status: 'working',
    connectionLabel: 'LOCAL RUNTIME / READY',
    lastOpenedAt: now,
    lastWorkAgentId: 'orchestrator',
  },
  {
    id: 'research-ops',
    title: 'Research Operations',
    rootPath: 'C:\\Projects\\research-ops',
    rootPathLabel: 'C:\\Projects\\research-ops',
    status: 'ready',
    connectionLabel: 'LOCAL / IDLE',
    lastOpenedAt: '2026-08-09T11:18:00.000Z',
    lastWorkAgentId: null,
  },
];

export const previewSnapshot: WorkspaceSnapshot = {
  project: {
    ...previewProjects[0],
    summary: 'The team is building and reviewing a customer management app.',
    nextMilestone: 'Finish customer import and review the result',
    currentPhaseId: 'hardening',
    agentCount: 6,
    provenWorkingAgentCount: 2,
    lastSyncedAt: now,
  },
  participants: [
    { id: 'user', displayName: 'You', roleLabel: 'PROJECT OWNER', isCurrentUser: true, orchestratorAgentId: 'orchestrator' },
  ],
  agents: [
    {
      id: 'orchestrator', displayName: 'Orchestrator', role: 'ORCHESTRATOR', roleSummary: 'Coordinates the project',
      status: 'working', currentTaskId: 'T-90', currentTaskTitle: 'Coordinate the next release',
      parentAgentId: null, teamId: 'control', lineId: 'delivery', progressPercent: 68, lastEvidenceAt: now,
      recentEvidence: [{ id: 'ev-luca-1', type: 'report', title: 'Project coordination', detail: 'Customer import work was assigned to the implementation team.', level: 'proven', observedAt: now }],
      history: [{ id: 'hist-luca-1', title: 'Coordinate the next release', state: 'in_progress', changedAt: now }],
    },
    {
      id: 'orquesta-admin', displayName: 'Luca', role: 'PROJECT GUIDE', roleSummary: 'Project explanation and desktop guidance',
      status: 'standby', currentTaskId: null, currentTaskTitle: null,
      parentAgentId: null, teamId: 'foundation', lineId: 'support', progressPercent: null, lastEvidenceAt: now,
      recentEvidence: [], history: [],
    },
    {
      id: 'user-support', displayName: 'User support', role: 'USER SUPPORT', roleSummary: 'Durable user decisions and repair coordination',
      status: 'standby', currentTaskId: null, currentTaskTitle: null,
      parentAgentId: null, teamId: 'foundation', lineId: 'support', progressPercent: null, lastEvidenceAt: now,
      recentEvidence: [], history: [],
    },
    {
      id: 'native', displayName: 'Implementation', role: 'IMPLEMENTATION', roleSummary: 'Builds product features',
      status: 'working', currentTaskId: 'T-92', currentTaskTitle: 'Add customer CSV import',
      parentAgentId: 'orchestrator', teamId: 'desktop', lineId: 'delivery', progressPercent: 82, lastEvidenceAt: now,
      recentEvidence: [{ id: 'ev-runtime-1', type: 'report', title: 'Import preview ready', detail: 'The first customer CSV can be previewed before saving.', level: 'proven', observedAt: now }],
      history: [{ id: 'hist-runtime-1', title: 'Add customer CSV import', state: 'in_progress', changedAt: now }],
    },
    {
      id: 'security', displayName: 'Release', role: 'RELEASE', roleSummary: 'Prepares changes for delivery',
      status: 'approval_wait', currentTaskId: 'T-95', currentTaskTitle: 'Apply the sample customer import',
      parentAgentId: 'orchestrator', teamId: 'desktop', lineId: 'delivery', progressPercent: 64, lastEvidenceAt: now,
      recentEvidence: [{ id: 'ev-native-1', type: 'approval', title: 'Sample import ready', detail: 'The sample file is ready to add to this project.', level: 'reported', observedAt: now }],
      history: [{ id: 'hist-native-1', title: 'Apply the sample customer import', state: 'approval_wait', changedAt: now }],
    },
    {
      id: 'frontend', displayName: 'Review', role: 'REVIEW', roleSummary: 'Checks usability and quality',
      status: 'assigned_waiting', currentTaskId: 'T-93', currentTaskTitle: 'Review the import experience',
      parentAgentId: 'orchestrator', teamId: 'quality', lineId: 'assurance', progressPercent: null, lastEvidenceAt: now,
      recentEvidence: [{ id: 'ev-evidence-1', type: 'report', title: 'Review ready', detail: 'The customer import flow is ready for review.', level: 'reported', observedAt: now }],
      history: [{ id: 'hist-evidence-1', title: 'Review the import experience', state: 'report_ready', changedAt: now }],
    },
  ],
  tasks: [
    { id: 'T-90', title: 'Coordinate the next release', state: 'in_progress', ownerAgentId: 'orchestrator', assignedByAgentId: 'user', recommendedModel: 'gpt-5.6-sol', requestedModel: 'gpt-5.6-sol', actualModel: 'gpt-5.6-sol', progressSummary: 'Coordinating', progressPercent: 68, updatedAt: now },
    { id: 'T-92', title: 'Add customer CSV import', state: 'in_progress', ownerAgentId: 'native', assignedByAgentId: 'orchestrator', recommendedModel: 'gpt-5.6-sol', requestedModel: 'gpt-5.6-sol', actualModel: 'gpt-5.6-sol', progressSummary: 'Building the import preview', progressPercent: 82, updatedAt: now },
    { id: 'T-95', title: 'Apply the sample customer import', state: 'approval_wait', ownerAgentId: 'security', assignedByAgentId: 'orchestrator', recommendedModel: 'gpt-5.6-terra', requestedModel: 'gpt-5.6-terra', actualModel: 'gpt-5.6-terra', progressSummary: 'Waiting for your decision', progressPercent: 64, updatedAt: now },
    { id: 'T-93', title: 'Review the import experience', state: 'queued', ownerAgentId: 'frontend', assignedByAgentId: 'orchestrator', recommendedModel: 'gpt-5.6-terra', requestedModel: 'gpt-5.6-terra', actualModel: null, progressSummary: 'Waiting for the implementation', progressPercent: null, updatedAt: now },
  ],
  attention: [
    {
      id: 'report-audit', sourceKind: 'user_task', type: 'report_review', actionKind: 'review', priority: 'medium', title: 'Review the customer import flow',
      summary: 'The implementation result is ready for you to review.', sourceAgentId: 'frontend', taskId: 'T-93',
      blocking: false, createdAt: now, runtimeApproval: null,
      resolvedAt: null, resolutionDecision: null,
    },
  ],
  phases: [
    { id: 'contracts', title: '準備', summary: '取込条件の確認', status: 'done', itemCount: 12, completedItemCount: 12 },
    { id: 'hardening', title: '取込', summary: '顧客データの確認', status: 'current', itemCount: 18, completedItemCount: 12 },
    { id: 'windows', title: '確認', summary: '保存前の利用者確認', status: 'blocked', itemCount: 7, completedItemCount: 1 },
    { id: 'release', title: '完了', summary: '取込結果の共有', status: 'queued', itemCount: 9, completedItemCount: 0 },
  ],
  recentEvents: [
    { id: 'event-3', tone: 'warning', title: 'Decision requested', message: 'The sample customer import is waiting for your decision.', taskId: 'T-95', createdAt: now },
    { id: 'event-2', tone: 'success', title: 'Import preview ready', message: 'The customer CSV can now be reviewed before saving.', taskId: 'T-92', createdAt: '2026-08-10T08:39:00.000Z' },
    { id: 'event-1', tone: 'neutral', title: 'Work assigned', message: 'Customer import work was assigned to the implementation team.', taskId: 'T-90', createdAt: '2026-08-10T08:37:00.000Z' },
  ],
  inspectionRuns: [
    {
      runId: 'audit-7', kind: 'adversarial_audit', displayName: 'Adversarial audit', status: 'running',
      focus: 'Customer import usability and failure handling', sourceCount: 18, createdAt: now, completedAt: null, errorMessage: null,
    },
  ],
};

const previewVoiceStatus: VoiceStatus = {
  schemaVersion: 2,
  revision: 1,
  providerId: 'whisper.cpp-local',
  binaryAssetId: 'whisper.cpp-windows-x64-b4938-spike',
  initialModelAssetId: 'whisper.cpp-model-small-multilingual',
  comparisonModelAssetId: 'whisper.cpp-model-base-multilingual',
  requiredAssetsReady: true,
  assets: [
    {
      assetId: 'whisper.cpp-windows-x64-b4938-spike', kind: 'native_binary_bundle', phase: 'installed',
      downloadedBytes: 8_361_840, expectedBytes: 8_361_840, operationRef: null, lastErrorCode: null,
    },
    {
      assetId: 'whisper.cpp-model-small-multilingual', kind: 'model', phase: 'installed',
      downloadedBytes: 487_601_967, expectedBytes: 487_601_967, operationRef: null, lastErrorCode: null,
    },
    {
      assetId: 'whisper.cpp-model-base-multilingual', kind: 'model', phase: 'absent',
      downloadedBytes: 0, expectedBytes: 147_951_465, operationRef: null, lastErrorCode: null,
    },
  ],
  operations: [],
};

export function createPreviewOrganizationSnapshot(requestedSize: number, requestedLineCount?: number, requestedLineSizes?: number[]): WorkspaceSnapshot {
  const snapshot = structuredClone(previewSnapshot);
  const orchestrator = { ...snapshot.agents.find((agent) => agent.id === 'orchestrator')!, lineId: null, teamId: 'control' };
  const services = snapshot.agents.filter((agent) => ['orquesta-admin', 'user-support'].includes(agent.id));
  const workerCapacity = 2_000 - 1 - services.length;
  const explicitLineSizes: number[] = [];
  let remainingCapacity = workerCapacity;
  for (const requestedLineSize of requestedLineSizes ?? []) {
    if (!Number.isFinite(requestedLineSize) || requestedLineSize <= 0 || remainingCapacity <= 0) continue;
    const lineSize = Math.max(1, Math.min(remainingCapacity, Math.round(requestedLineSize)));
    explicitLineSizes.push(lineSize);
    remainingCapacity -= lineSize;
  }
  const size = explicitLineSizes.length > 0
    ? 1 + services.length + explicitLineSizes.reduce((sum, lineSize) => sum + lineSize, 0)
    : Math.max(6, Math.min(2_000, Math.round(requestedSize)));
  const workerCount = size - 1 - services.length;
  const lineCount = explicitLineSizes.length > 0
    ? explicitLineSizes.length
    : requestedLineCount
    ? Math.max(1, Math.min(workerCount, Math.round(requestedLineCount)))
    : size >= 25 ? 3 : size >= 15 ? 2 : 1;
  const roles = ['Implementation', 'Research', 'Verification', 'Design', 'Operations'];
  const workers: WorkspaceSnapshot['agents'] = [];
  const tasks: WorkspaceSnapshot['tasks'] = [
    { ...snapshot.tasks[0], ownerAgentId: 'orchestrator', assignedByAgentId: 'user' },
  ];
  let created = 0;

  for (let lineIndex = 0; lineIndex < lineCount; lineIndex += 1) {
    const remainingLines = lineCount - lineIndex;
    const membersInLine = explicitLineSizes[lineIndex] ?? Math.ceil((workerCount - created) / remainingLines);
    const lineId = `line-${lineIndex + 1}`;
    const leadId = `${lineId}-lead`;
    for (let memberIndex = 0; memberIndex < membersInLine && created < workerCount; memberIndex += 1) {
      const role = roles[(lineIndex + memberIndex) % roles.length];
      const id = memberIndex === 0 ? leadId : `${lineId}-agent-${String(memberIndex).padStart(2, '0')}`;
      const crossLineDelegate = lineIndex === 1 && memberIndex === membersInLine - 1;
      const active = memberIndex === 0 || memberIndex % 6 === 0 || crossLineDelegate;
      const taskId = active ? `task-${id}` : null;
      workers.push({
        ...snapshot.agents[3],
        id,
        displayName: memberIndex === 0 ? `${role} Lead` : `${role} ${String(memberIndex + 1).padStart(2, '0')}`,
        role: role.toUpperCase(),
        roleSummary: `${role} work in ${lineId}`,
        status: active ? 'working' : 'standby',
        currentTaskId: taskId,
        currentTaskTitle: active ? `Advance ${lineId}` : null,
        parentAgentId: memberIndex === 0 ? 'orchestrator' : leadId,
        teamId: `${lineId}-${role.toLowerCase()}`,
        lineId,
        progressPercent: active ? 28 + ((lineIndex * 17 + memberIndex * 11) % 65) : null,
      });
      if (taskId) tasks.push({
        ...snapshot.tasks[1],
        id: taskId,
        title: `Advance ${lineId}`,
        ownerAgentId: id,
        assignedByAgentId: crossLineDelegate ? 'line-1-lead' : memberIndex === 0 ? 'orchestrator' : leadId,
        progressPercent: 28 + ((lineIndex * 17 + memberIndex * 11) % 65),
      });
      created += 1;
    }
  }

  snapshot.agents = [orchestrator, ...services, ...workers];
  snapshot.tasks = tasks;
  snapshot.project = {
    ...snapshot.project,
    agentCount: snapshot.agents.length,
    provenWorkingAgentCount: snapshot.agents.filter((agent) => agent.status === 'working').length,
    summary: `${lineCount} production lines are running across ${snapshot.agents.length} agents.`,
  };
  return snapshot;
}

const initialConversation: ConversationMessage[] = [
  {
    id: 'message-1', role: 'user', targetAgentId: 'orchestrator', authorLabel: 'YOU',
    text: '顧客一覧のCSVを取り込めるようにしたい。保存する前に内容を確認できるようにして。', createdAt: '2026-08-10T08:37:00.000Z', evidenceLabel: null,
  },
  {
    id: 'message-2', role: 'agent', targetAgentId: 'orchestrator', authorLabel: 'ORCHESTRATOR',
    text: '了解。まずCSVの列を確認し、保存前に追加・更新・エラーの件数を見られるプレビューを作ります。',
    createdAt: '2026-08-10T08:39:00.000Z', evidenceLabel: null,
  },
];

function createPreviewConversation(requestedCount: number): ConversationMessage[] {
  const count = Math.max(0, Math.min(500, Math.round(requestedCount)));
  const startedAt = Date.parse('2026-08-10T07:00:00.000Z');
  return Array.from({ length: count }, (_, index) => {
    const ordinal = index + 1;
    const role = ordinal % 2 === 1 ? 'user' as const : 'agent' as const;
    return {
      id: `preview-message-${String(ordinal).padStart(3, '0')}`,
      role,
      targetAgentId: 'orchestrator',
      authorLabel: role === 'user' ? 'YOU' : 'ORCHESTRATOR',
      text: role === 'user'
        ? `Preview user message ${String(ordinal).padStart(2, '0')}`
        : `Preview agent message ${String(ordinal).padStart(2, '0')}`,
      createdAt: new Date(startedAt + index * 60_000).toISOString(),
      evidenceLabel: role === 'agent' ? 'PREVIEW / PROJECTED' : null,
    };
  });
}

const previewConversationActivities: ConversationActivity[] = [
  ...['inspect', 'create-files', 'verify', 'typecheck'].map((name, index): ConversationActivity => ({
    id: `preview-command-${name}`,
    threadId: 'preview-thread',
    turnId: 'preview-turn',
    itemId: `command-${index + 1}`,
    targetAgentId: 'orchestrator',
    kind: 'command',
    state: 'completed',
    title: `pwsh.exe.${name}`,
    createdAt: new Date(Date.parse('2026-08-10T08:40:00.000Z') + index * 1_000).toISOString(),
    updatedAt: new Date(Date.parse('2026-08-10T08:40:00.800Z') + index * 1_000).toISOString(),
    lastJournalSequence: index + 1,
    details: {
      commandName: 'pwsh.exe',
      actionTypes: ['unknown'],
      actionTypesTruncated: false,
      exitCode: 0,
      durationMs: 820 + index * 690,
      outputPresent: true,
      outputBytes: 32,
      outputText: `preview ${name} output\ncompleted`,
      outputTruncated: false,
      outputRedacted: false,
      cwdOmitted: true,
      commandArgumentsOmitted: true,
      contentOmitted: true,
    },
  })),
  {
    id: 'preview-file-changes',
    threadId: 'preview-thread',
    turnId: 'preview-turn',
    itemId: 'file-changes',
    targetAgentId: 'orchestrator',
    kind: 'file_change',
    state: 'completed',
    title: '3 file changes',
    createdAt: '2026-08-10T08:40:05.000Z',
    updatedAt: '2026-08-10T08:40:05.000Z',
    lastJournalSequence: 5,
    details: {
      changes: [
        { path: '~/Projects/test1/auto-test-1/numbers.txt', kind: 'created', originalBytes: 0, addedLines: 1, removedLines: 0 },
        { path: '~/Projects/test1/auto-test-2/numbers.txt', kind: 'created', originalBytes: 0, addedLines: 1, removedLines: 0 },
        { path: '~/Projects/test1/auto-test-3/numbers.txt', kind: 'created', originalBytes: 0, addedLines: 1, removedLines: 0 },
      ],
      changeCount: 3,
      changesTruncated: false,
      contentOmitted: true,
    },
  },
  {
    id: 'preview-turn-diff',
    threadId: 'preview-thread',
    turnId: 'preview-turn',
    itemId: 'turn-diff',
    targetAgentId: 'orchestrator',
    kind: 'diff',
    state: 'updated',
    title: 'Turn diff',
    createdAt: '2026-08-10T08:40:06.000Z',
    updatedAt: '2026-08-10T08:40:06.000Z',
    lastJournalSequence: 6,
    details: { originalBytes: 300, addedLines: 3, removedLines: 0, contentOmitted: true },
  },
];

const nativeConversation: ConversationMessage[] = [
  {
    id: 'native-message-1', role: 'user', targetAgentId: 'security', authorLabel: 'YOU',
    text: 'Add a CSV import so I can review customer rows before saving them.',
    createdAt: '2026-08-10T08:19:40.000Z', evidenceLabel: null,
  },
  {
    id: 'native-message-2', role: 'agent', targetAgentId: 'security', authorLabel: 'NATIVE SHELL',
    text: 'I will first inspect the current customer fields, then build a preview that highlights invalid rows.',
    createdAt: '2026-08-10T08:20:05.000Z', evidenceLabel: null,
  },
  {
    id: 'native-message-3', role: 'agent', targetAgentId: 'security', authorLabel: 'RUNTIME',
    text: 'The current records use name, email, company, and status. I found two sample files for testing.',
    createdAt: '2026-08-10T08:20:51.000Z', evidenceLabel: null,
  },
  {
    id: 'native-message-4', role: 'agent', targetAgentId: 'security', authorLabel: 'NATIVE SHELL',
    text: 'The preview now shows duplicate emails and missing names before anything is saved.',
    createdAt: '2026-08-10T08:21:28.000Z', evidenceLabel: null,
  },
  {
    id: 'native-message-5', role: 'agent', targetAgentId: 'security', authorLabel: 'NATIVE SHELL',
    text: 'The sample import is ready. Please review the preview, then decide whether to add these customers.',
    createdAt: '2026-08-10T08:22:02.000Z', evidenceLabel: null,
  },
];

const previewPendingRequests: ProjectedPendingRequest[] = [
  {
    requestKey: 'runtime-approval-req-1',
    agentId: 'security',
    requestKind: 'attention.approval_requested',
    responseOptions: ['accept', 'acceptForSession', 'decline', 'cancel'],
    prompt: null,
    createdAt: now,
    requestedEffectKind: 'file_change',
    responsePhase: null,
    recoveryState: 'actionable',
  },
];

const previewResolvedRequests: ProjectedResolvedRequest[] = [
  {
    requestKey: 'runtime-approval-preview-accepted-1',
    agentId: 'security',
    requestKind: 'attention.approval_requested',
    responseOptions: ['accept', 'acceptForSession', 'decline', 'cancel'],
    createdAt: '2026-08-10T07:58:00.000Z',
    resolvedAt: '2026-08-10T08:02:00.000Z',
    requestedEffectKind: 'file_change',
    responseDecision: 'accept',
  },
];

function clone<T>(value: T): T {
  return structuredClone(value);
}

function stoppedStatus(revision: number): RuntimeStatus {
  return {
    lifecycle: 'Stopped', projectId: null, activationToken: null,
    rendererSessionId: renderer.rendererSessionId, rendererGeneration: renderer.rendererGeneration,
    runtimeGeneration: readyStatus.runtimeGeneration, statusRevision: revision, failureReason: null,
  };
}

export interface PreviewDesktopClientOptions {
  recovery?: boolean;
  state?: 'ready' | 'empty' | 'uninitialized';
  organizationSize?: number;
  organizationLines?: number;
  organizationLineSizes?: number[];
  conversationMessageCount?: number;
  conversationActivityFixture?: boolean;
  theme?: NativeSettings['theme'];
}

export class PreviewMethodNotConfiguredError extends Error {
  constructor(method: keyof DesktopClient) {
    super('preview_method_not_configured:' + method);
    this.name = 'PreviewMethodNotConfiguredError';
  }
}

export class PreviewDesktopClient implements DesktopClient {
  readonly #listeners = new Set<(event: DesktopEvent) => void>();
  readonly #messages: ReadonlyMap<string, ConversationMessage[]>;
  readonly #status: RuntimeStatus;
  readonly #snapshot: WorkspaceSnapshot | null;
  readonly #projects: ProjectSummary[];
  readonly #archivedProjects: ProjectSummary[] = [];
  readonly #showBusinessFixture: boolean;
  readonly #conversationActivityFixture: boolean;
  readonly #recovery: DispatchRecovery | null;
  #settings: NativeSettings = {
    schemaVersion: 2,
    revision: 1,
    locale: 'en',
    theme: 'system',
    reducedMotion: false,
    notificationsEnabled: false,
    navigationCompact: true,
    workLedgerOpen: true,
  };
  #disposed = false;

  constructor(options: PreviewDesktopClientOptions = {}) {
    let status = clone(readyStatus);
    let snapshot: WorkspaceSnapshot | null = clone(previewSnapshot);
    let projects = clone(previewProjects);
    let showBusinessFixture = true;
    const messages = new Map<string, ConversationMessage[]>([
      ['orchestrator', clone(initialConversation)],
      ['security', clone(nativeConversation)],
    ]);

    if (options.state === 'empty') {
      status = stoppedStatus(readyStatus.statusRevision + 1);
      snapshot = null;
      projects = [];
      showBusinessFixture = false;
    } else if (options.state === 'uninitialized') {
      snapshot = {
        ...clone(previewSnapshot),
        agents: [],
        tasks: [],
        phases: [],
        attention: [],
        recentEvents: [],
        inspectionRuns: [],
      };
      messages.set('orchestrator', []);
      showBusinessFixture = false;
    } else {
      if (options.organizationSize || options.organizationLineSizes?.length) {
        snapshot = createPreviewOrganizationSnapshot(
          options.organizationSize ?? 6,
          options.organizationLines,
          options.organizationLineSizes,
        );
      }
      if (options.conversationMessageCount !== undefined) {
        messages.set('orchestrator', createPreviewConversation(options.conversationMessageCount));
      }
    }

    this.#status = status;
    this.#snapshot = snapshot;
    this.#projects = projects;
    this.#messages = messages;
    this.#showBusinessFixture = showBusinessFixture;
    this.#conversationActivityFixture = options.conversationActivityFixture === true;
    if (options.theme) this.#settings = { ...this.#settings, theme: options.theme };
    this.#recovery = options.recovery
      ? {
          kind: 'prepared_outcome_unknown',
          dispatchId: 'dispatch-preview',
          projectId: 'orquesta-v5',
          targetAgentId: 'orchestrator',
          createdAt: now,
          reason: 'Native response was not observed.',
          threadId: null,
          turnId: null,
        }
      : null;
  }

  async bootstrap(signal?: AbortSignal): Promise<DesktopBootstrap> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    return {
      renderer: clone(renderer),
      status: clone(this.#status),
      projects: clone(this.#projects),
      starterCreationRecoveries: [],
      settings: clone(this.#settings),
      selectedProjectId: this.#status.projectId,
      snapshot: clone(this.#snapshot),
      dispatchRecovery: clone(this.#recovery),
      pendingAttachmentSelectionIds: [],
      voiceStatus: clone(previewVoiceStatus),
    };
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#listeners.clear();
  }

  subscribe(listener: (event: DesktopEvent) => void): () => void {
    if (!this.#disposed) this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emitScenarioEvent(event: DesktopEvent): void {
    if (!this.#disposed) this.#listeners.forEach((listener) => listener(clone(event)));
  }

  async updateSettings(
    _renderer: RendererAuthority,
    input: Omit<NativeSettings, 'schemaVersion' | 'revision'> & { expectedRevision: number },
  ): Promise<NativeSettings> {
    if (input.expectedRevision !== this.#settings.revision) {
      throw new Error('settings_revision_conflict');
    }
    this.#settings = {
      schemaVersion: this.#settings.schemaVersion,
      revision: this.#settings.revision + 1,
      locale: input.locale,
      theme: input.theme,
      reducedMotion: input.reducedMotion,
      notificationsEnabled: input.notificationsEnabled,
      navigationCompact: input.navigationCompact,
      workLedgerOpen: input.workLedgerOpen,
    };
    return clone(this.#settings);
  }

  async listProjects(_renderer: RendererAuthority): Promise<ProjectSummary[]> {
    return clone(this.#projects);
  }

  async listArchivedProjects(_renderer: RendererAuthority): Promise<ProjectSummary[]> {
    return clone(this.#archivedProjects);
  }

  async archiveProject(
    _renderer: RendererAuthority,
    projectId: string,
  ): Promise<ProjectArchiveMutation> {
    const index = this.#projects.findIndex((project) => project.id === projectId);
    if (index >= 0) this.#archivedProjects.push(...this.#projects.splice(index, 1));
    return clone({ projects: this.#projects, archivedProjects: this.#archivedProjects });
  }

  async restoreArchivedProject(
    _renderer: RendererAuthority,
    projectId: string,
  ): Promise<ProjectArchiveMutation> {
    const index = this.#archivedProjects.findIndex((project) => project.id === projectId);
    if (index >= 0) this.#projects.push(...this.#archivedProjects.splice(index, 1));
    return clone({ projects: this.#projects, archivedProjects: this.#archivedProjects });
  }

  async recordLastWorkAgent(
    _authority: RuntimeAuthority,
    _targetAgentId: string,
  ): Promise<ProjectSummary> {
    return this.#notConfigured('recordLastWorkAgent');
  }

  async chooseProjectFolder(_renderer: RendererAuthority): Promise<import('../domain/models').ProjectFolderSelection | null> {
    return this.#notConfigured('chooseProjectFolder');
  }

  async openProjectFolder(
    _renderer: RendererAuthority,
    _input: { selectionRef: string; projectName: string },
  ): Promise<ProjectSummary> {
    return this.#notConfigured('openProjectFolder');
  }

  async createStarterProject(
    _renderer: RendererAuthority,
    _input: { operationRef: string; projectName: string },
  ): Promise<ProjectSummary | null> {
    return this.#notConfigured('createStarterProject');
  }

  async activateProject(
    _project: ProjectSummary,
    _renderer: RendererAuthority,
    _expectedStatusRevision: number,
  ): Promise<RuntimeStatus> {
    return this.#notConfigured('activateProject');
  }

  async stopRuntime(
    _authority: RuntimeAuthority,
    _expectedStatusRevision: number,
  ): Promise<RuntimeStatus> {
    return this.#notConfigured('stopRuntime');
  }

  async refreshStatus(_renderer: RendererAuthority): Promise<RuntimeStatus> {
    return clone(this.#status);
  }

  async readSnapshot(_authority: RuntimeAuthority): Promise<WorkspaceSnapshot> {
    if (!this.#snapshot) throw new Error('No project is active.');
    return clone(this.#snapshot);
  }

  async readComposerRuntimeOptions(_renderer: RendererAuthority) {
    return {
      models: [
        {
          id: 'gpt-5.6-sol',
          displayName: 'GPT-5.6-Sol',
          isDefault: true,
          defaultReasoningEffort: 'xhigh',
          supportedReasoningEfforts: [
            { effort: 'low', description: 'Fast responses with light reasoning.' },
            { effort: 'medium', description: 'Balanced reasoning.' },
            { effort: 'high', description: 'Deep reasoning.' },
            { effort: 'xhigh', description: 'Maximum practical reasoning.' },
          ],
          serviceTiers: [{ id: 'fast', name: 'Fast', description: '1.5x faster; uses more credits.' }],
        },
        {
          id: 'gpt-5.6-terra',
          displayName: 'GPT-5.6-Terra',
          isDefault: false,
          defaultReasoningEffort: 'high',
          supportedReasoningEfforts: [
            { effort: 'medium', description: 'Balanced reasoning.' },
            { effort: 'high', description: 'Deep reasoning.' },
          ],
          serviceTiers: [{ id: 'fast', name: 'Fast', description: '1.5x faster; uses more credits.' }],
        },
      ],
    };
  }

  async bootstrapProject(_authority: RuntimeAuthority): Promise<ProjectBootstrapResult> {
    return { status: 'ready', noWrite: true, reason: null };
  }

  async readBusinessWorkOrders(
    authority: RuntimeAuthority,
    input: { afterCursor: BusinessSourceCursor | null; afterKey: string | null },
  ): Promise<BusinessWorkOrdersResult> {
    const items = this.#showBusinessFixture && !input.afterKey
      ? [{
          key: 'WO-11111111111111111111111111111111',
          workOrderId: 'WO-11111111111111111111111111111111',
          projectRef: 'orquesta-v5',
          title: 'Desktop Next を統合する',
          status: 'running' as const,
          revision: 4,
          engineContractVersion: 2,
          createdAt: now,
          deadlineAt: '2026-08-11T08:42:00.000Z',
          branchCounts: { total: 3, byState: { running: 2, accepted: 1 } },
          lifecycle: {
            mode: 'v2' as const,
            automationState: 'running' as const,
            blockingEffectCount: 0,
            violationCount: 0,
          },
          providerDelivery: {
            total: 5,
            accepted: 4,
            notSent: 0,
            deliveryUnknown: 0,
            unresolved: 1,
          },
          acceptance: { decision: null, reviewCount: 1 },
        }]
      : [];
    return {
      runtimeProjectId: authority.projectId,
      continuity: input.afterCursor ? 'unchanged' : 'initial',
      cursor: input.afterCursor ?? {
        journalSequence: 1,
        lastBatchId: 'preview-business-batch',
        journalHash: 'b'.repeat(64),
        projectionHash: 'c'.repeat(64),
      },
      items,
      nextAfterKey: null,
      businessProjectRefs: ['orquesta-v5'],
      providerSettlementActive: true,
    };
  }

  async readConversation(
    authority: RuntimeAuthority,
    targetAgentId: string,
    _checkpoint: ConversationReadCheckpoint,
    cursor?: ConversationCursor | null,
    _activityCursor?: ConversationActivityCursor | null,
    _pendingRequestCursor?: string | null,
  ): Promise<ConversationSnapshot> {
    const all = clone(this.#messages.get(targetAgentId) ?? []).sort(compareConversationEntryOrder);
    const candidates = cursor
      ? all.filter((message) => (
          message.createdAt < cursor.beforeCreatedAt
          || (message.createdAt === cursor.beforeCreatedAt && message.id < cursor.beforeMessageId)
        ))
      : all;
    const items = candidates.slice(-50);
    const oldest = items[0] ?? null;
    return {
      source: 'sqlite',
      projectId: authority.projectId,
      targetAgentId,
      streamId: 'preview-stream',
      appliedJournalSequence: all.length,
      projectionRevision: all.length,
      syncState: 'current',
      items,
      activities: this.#conversationActivityFixture && targetAgentId === 'orchestrator'
        ? clone(previewConversationActivities)
        : [],
      olderCursor: candidates.length > items.length && oldest
        ? { beforeCreatedAt: oldest.createdAt, beforeMessageId: oldest.id }
        : null,
      activityOlderCursor: null,
      pendingRequestOlderCursor: null,
      pendingRequests: previewPendingRequests.map((request) => ({
        ...clone(request),
        recoveryState: authority.activationToken === readyStatus.activationToken
          ? request.recoveryState
          : 'stale',
      })),
      resolvedRequests: clone(previewResolvedRequests),
      activeTurns: [],
      latestTurn: null,
    };
  }

  async readHistoryIndex(
    authority: RuntimeAuthority,
    cursor?: HistoryCursor | null,
  ): Promise<HistoryIndexPage> {
    const ordered = [...this.#messages.entries()]
      .flatMap(([targetAgentId, messages]) => {
        const latest = clone(messages).sort(compareConversationEntryOrder).at(-1);
        return latest
          ? [{
              targetAgentId,
              updatedAt: latest.createdAt,
              lastMessageId: latest.id,
              lastRole: latest.role,
              preview: latest.text.slice(0, 160),
            }]
          : [];
      })
      .sort((left, right) => (
        right.updatedAt.localeCompare(left.updatedAt)
        || right.lastMessageId.localeCompare(left.lastMessageId)
      ));
    const candidates = cursor
      ? ordered.filter((item) => (
          item.updatedAt < cursor.beforeUpdatedAt
          || (item.updatedAt === cursor.beforeUpdatedAt && item.lastMessageId < cursor.beforeMessageId)
        ))
      : ordered;
    const items = candidates.slice(0, 50);
    const last = items.at(-1) ?? null;
    return {
      source: 'sqlite',
      projectId: authority.projectId,
      items,
      nextCursor: candidates.length > items.length && last
        ? { beforeUpdatedAt: last.updatedAt, beforeMessageId: last.lastMessageId }
        : null,
    };
  }

  async readHistoryPage(
    authority: RuntimeAuthority,
    targetAgentId: string,
    query: string | null,
    cursor?: ConversationCursor | null,
  ): Promise<HistoryConversationPage> {
    const normalizedQuery = query?.trim() || null;
    const ordered = clone(this.#messages.get(targetAgentId) ?? []).sort(compareConversationEntryOrder);
    const searched = normalizedQuery
      ? ordered.filter((message) => message.text.includes(normalizedQuery))
      : ordered;
    const candidates = cursor
      ? searched.filter((message) => (
          message.createdAt < cursor.beforeCreatedAt
          || (message.createdAt === cursor.beforeCreatedAt && message.id < cursor.beforeMessageId)
        ))
      : searched;
    const items = candidates.slice(-50);
    const oldest = items[0] ?? null;
    return {
      source: 'sqlite',
      projectId: authority.projectId,
      targetAgentId,
      query: normalizedQuery,
      items,
      nextCursor: candidates.length > items.length && oldest
        ? { beforeCreatedAt: oldest.createdAt, beforeMessageId: oldest.id }
        : null,
    };
  }

  async sendMessage(
    _authority: RuntimeAuthority,
    _input: SendMessageInput,
  ): Promise<DispatchSendResult> {
    return this.#notConfigured('sendMessage');
  }

  async interruptTurn(
    _authority: RuntimeAuthority,
    _input: { targetAgentId: string; threadId: string; turnId: string },
  ): Promise<void> {
    return this.#notConfigured('interruptTurn');
  }

  async steerTurn(_authority: RuntimeAuthority, _input: SteerTurnInput): Promise<void> {
    return this.#notConfigured('steerTurn');
  }

  async respondToApproval(
    _authority: RuntimeAuthority,
    _attentionId: string,
    _decision: string,
  ): Promise<void> {
    return this.#notConfigured('respondToApproval');
  }

  async startInspection(
    _authority: RuntimeAuthority,
    _input: StartInspectionInput,
  ): Promise<string> {
    return this.#notConfigured('startInspection');
  }

  async cancelInspection(_authority: RuntimeAuthority, _runId: string): Promise<void> {
    return this.#notConfigured('cancelInspection');
  }

  async readWorkflowCatalog(_authority: RuntimeAuthority): Promise<WorkflowCatalog> {
    return { definitions: [], batches: [], maxAttemptsPerBatch: 50 };
  }

  async saveWorkflowDefinition(
    _authority: RuntimeAuthority,
    _input: { workflowId: string | null; name: string; prompt: string; checks: WorkflowCheck[] },
  ): Promise<string> {
    return this.#notConfigured('saveWorkflowDefinition');
  }

  async startWorkflowBatch(
    _authority: RuntimeAuthority,
    _workflowId: string,
    _repetitions: number,
  ): Promise<string> {
    return this.#notConfigured('startWorkflowBatch');
  }

  async cancelWorkflowBatch(_authority: RuntimeAuthority, _batchId: string): Promise<void> {
    return this.#notConfigured('cancelWorkflowBatch');
  }

  async readWorkflowResult(
    _authority: RuntimeAuthority,
    _batchId: string,
    _attemptId: string,
  ): Promise<string> {
    return this.#notConfigured('readWorkflowResult');
  }

  async importAttachments(
    _authority: RuntimeAuthority,
    _selectionId: string,
    _files: readonly AttachmentBinarySource[],
  ): Promise<ComposerAttachment[]> {
    return this.#notConfigured('importAttachments');
  }

  async readAttachmentPreview(
    _authority: RuntimeAuthority,
    _selectionId: string,
    _attachmentId: string,
  ): Promise<ArrayBuffer> {
    return this.#notConfigured('readAttachmentPreview');
  }

  async forgetAttachment(
    _authority: RuntimeAuthority | null,
    _selectionId: string,
    _attachmentId: string,
  ): Promise<void> {
    return this.#notConfigured('forgetAttachment');
  }

  async abandonAttachmentSelection(
    _authority: RuntimeAuthority | null,
    _selectionId: string,
  ): Promise<void> {
    return this.#notConfigured('abandonAttachmentSelection');
  }

  async readVoiceStatus(_renderer: RendererAuthority): Promise<VoiceStatus> {
    return clone(previewVoiceStatus);
  }

  async acquireVoiceAsset(_renderer: RendererAuthority, _assetId: string): Promise<VoiceStatus> {
    return this.#notConfigured('acquireVoiceAsset');
  }

  async cancelVoiceAssetAcquisition(
    _renderer: RendererAuthority,
    _operationRef: string,
  ): Promise<VoiceStatus> {
    return this.#notConfigured('cancelVoiceAssetAcquisition');
  }

  async deleteVoiceAsset(_renderer: RendererAuthority, _assetId: string): Promise<VoiceStatus> {
    return this.#notConfigured('deleteVoiceAsset');
  }

  async transcribeVoicePcm(
    _renderer: RendererAuthority,
    _operationRef: string,
    _binding: VoiceTranscriptionBindingInput,
    _pcm: Uint8Array,
    _sampleCount: number,
  ): Promise<VoiceOperationStatus> {
    return this.#notConfigured('transcribeVoicePcm');
  }

  async cancelVoiceTranscription(
    _renderer: RendererAuthority,
    _operationRef: string,
  ): Promise<VoiceStatus> {
    return this.#notConfigured('cancelVoiceTranscription');
  }

  async acknowledgeVoiceTranscription(
    _renderer: RendererAuthority,
    _operationRef: string,
  ): Promise<VoiceStatus> {
    return this.#notConfigured('acknowledgeVoiceTranscription');
  }

  async readDispatchRecovery(_renderer: RendererAuthority): Promise<DispatchRecovery | null> {
    return clone(this.#recovery);
  }

  async reconcileDispatchRecovery(
    _renderer: RendererAuthority,
    _recovery: DispatchRecovery,
    _authority: RuntimeAuthority | null,
  ): Promise<DispatchRecoveryResult> {
    return this.#notConfigured('reconcileDispatchRecovery');
  }

  #notConfigured<Return>(method: keyof DesktopClient): Return {
    throw new PreviewMethodNotConfiguredError(method);
  }
}

export function createPreviewDesktopClient(search = typeof window === 'undefined' ? '' : window.location.search): PreviewDesktopClient {
  const params = new URLSearchParams(search);
  const state = params.get('state');
  const theme = params.get('theme');
  const organizationSize = Number(params.get('org'));
  const organizationLines = Number(params.get('lines'));
  const conversationMessageCount = Number(params.get('messages'));
  const organizationLineSizes = (params.get('lineSizes') ?? '')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value > 0);
  return new PreviewDesktopClient({
    recovery: params.get('scenario') === 'recovery',
    state: state === 'empty' || state === 'uninitialized' ? state : 'ready',
    organizationSize: Number.isFinite(organizationSize) && organizationSize > 0 ? organizationSize : undefined,
    organizationLines: Number.isFinite(organizationLines) && organizationLines > 0 ? organizationLines : undefined,
    organizationLineSizes: organizationLineSizes.length > 0 ? organizationLineSizes : undefined,
    conversationMessageCount: Number.isFinite(conversationMessageCount) && conversationMessageCount >= 0 ? conversationMessageCount : undefined,
    conversationActivityFixture: params.get('activity') === '1',
    theme: theme === 'light' || theme === 'dark' || theme === 'system' ? theme : undefined,
  });
}
