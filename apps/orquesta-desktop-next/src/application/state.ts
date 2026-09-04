import type {
  AgentExecution,
  AttentionItem,
  BusinessSourceCursor,
  BusinessWorkOrderSummary,
  ComposerAccessMode,
  ComposerAttachment,
  ComposerServiceTier,
  ConversationActivity,
  ConversationActivityCursor,
  ConversationCursor,
  ConversationMessage,
  ConversationSummary,
  DispatchRecovery,
  HistoryCursor,
  ProjectedPendingRequest,
  ProjectBootstrapResult,
  ProjectSummary,
  NativeSettings,
  StarterCreationRecoverySummary,
  RendererAuthority,
  RuntimeAuthority,
  RuntimeModelOption,
  RuntimeStatus,
  WorkflowCatalog,
  WorkspaceSnapshot,
  VoiceStatus,
} from '../domain/models';
import type { UserMessage } from './user-message';

export type ApplicationPhase = 'booting' | 'launcher' | 'activating' | 'workspace' | 'stopping' | 'failed';
export type WorkspaceRoute = 'work' | 'map' | 'decisions' | 'workflows' | 'history';

interface VoiceComposerCaptureBase {
  epoch: number;
  renderer: RendererAuthority;
  draft: string;
  draftRevision: number;
}

export interface VoiceAgentComposerCapture extends VoiceComposerCaptureBase {
  target: 'agent';
  scope: 'ready_operation';
  authority: RuntimeAuthority;
  runtimeGeneration: string;
  statusRevision: number;
  projectId: string;
  agentId: string;
}

export interface VoiceLauncherComposerCapture extends VoiceComposerCaptureBase {
  target: 'launcher';
  projectId: null;
  agentId: null;
}

export type VoiceComposerCapture = VoiceAgentComposerCapture | VoiceLauncherComposerCapture;

export interface ApplicationState {
  phase: ApplicationPhase;
  route: WorkspaceRoute;
  projects: ProjectSummary[];
  archivedProjects: ProjectSummary[];
  archivedProjectsLoading: boolean;
  projectArchiveMutationId: string | null;
  starterCreationRecoveries: StarterCreationRecoverySummary[];
  selectedProjectId: string | null;
  snapshot: WorkspaceSnapshot | null;
  runtimeStatus: RuntimeStatus | null;
  rendererAuthority: RendererAuthority | null;
  settings: NativeSettings | null;
  settingsUpdating: boolean;
  runtimeAuthority: RuntimeAuthority | null;
  selectedAgentId: string | null;
  messages: ConversationMessage[];
  activities: ConversationActivity[];
  conversationLoading: boolean;
  conversationOlderCursor: ConversationCursor | null;
  conversationOlderActivityCursor: ConversationActivityCursor | null;
  conversationOlderPendingRequestCursor: string | null;
  conversationOlderLoading: boolean;
  historyConversations: ConversationSummary[];
  userSignalsBaselineReady: boolean;
  historyIndexCursor: HistoryCursor | null;
  historySelectedAgentId: string | null;
  historyQuery: string;
  historyMessages: ConversationMessage[];
  historyCursor: ConversationCursor | null;
  historyLoading: boolean;
  historyOlderLoading: boolean;
  attentionHistory: AttentionItem[];
  projectedPendingRequests: ProjectedPendingRequest[];
  draft: string;
  runtimeModels: RuntimeModelOption[];
  runtimeModelsLoading: boolean;
  composerModelId: string | null;
  composerReasoningEffort: string | null;
  composerAccessMode: ComposerAccessMode;
  composerServiceTier: ComposerServiceTier;
  attachments: ComposerAttachment[];
  attachmentSelectionPending: boolean;
  attachmentRemovalPending: boolean;
  sending: boolean;
  conversationAction: 'send' | 'retry' | 'steer' | 'stop' | null;
  turnMutationAcceptedTurnKey: string | null;
  turnMutationOutcomeUnknownTurnKey: string | null;
  executions: Record<string, AgentExecution>;
  supportAgentId: string | null;
  supportMessages: ConversationMessage[];
  supportConversationLoading: boolean;
  supportDraft: string;
  supportSending: boolean;
  actionPendingId: string | null;
  dispatchRecovery: DispatchRecovery | null;
  recoveryPending: boolean;
  error: UserMessage | null;
  notice: UserMessage | null;
  businessWorkOrders: BusinessWorkOrderSummary[];
  businessCursor: BusinessSourceCursor | null;
  businessNextAfterKey: string | null;
  businessLoading: boolean;
  businessRecoveryRequired: boolean;
  workflowCatalog: WorkflowCatalog | null;
  workflowLoading: boolean;
  addingProject: boolean;
  projectStartPending: boolean;
  projectBootstrap: ProjectBootstrapResult | null;
  voiceStatus: VoiceStatus | null;
  voiceCapturePhase: 'idle' | 'requesting_permission' | 'recording' | 'stopping' | 'transcribing' | 'cancelling';
  voiceActiveOperationRef: string | null;
  voiceSendIntentOperationRef: string | null;
  voiceError: UserMessage | null;
}

export function createInitialApplicationState(): ApplicationState {
  return {
    phase: 'booting',
    route: 'work',
    projects: [],
    archivedProjects: [],
    archivedProjectsLoading: false,
    projectArchiveMutationId: null,
    starterCreationRecoveries: [],
    selectedProjectId: null,
    snapshot: null,
    runtimeStatus: null,
    rendererAuthority: null,
    settings: null,
    settingsUpdating: false,
    runtimeAuthority: null,
    selectedAgentId: null,
    messages: [],
    activities: [],
    conversationLoading: false,
    conversationOlderCursor: null,
    conversationOlderActivityCursor: null,
    conversationOlderPendingRequestCursor: null,
    conversationOlderLoading: false,
    historyConversations: [],
    userSignalsBaselineReady: false,
    historyIndexCursor: null,
    historySelectedAgentId: null,
    historyQuery: '',
    historyMessages: [],
    historyCursor: null,
    historyLoading: false,
    historyOlderLoading: false,
    attentionHistory: [],
    projectedPendingRequests: [],
    draft: '',
    runtimeModels: [],
    runtimeModelsLoading: false,
    composerModelId: null,
    composerReasoningEffort: null,
    composerAccessMode: 'full_access',
    composerServiceTier: 'standard',
    attachments: [],
    attachmentSelectionPending: false,
    attachmentRemovalPending: false,
    sending: false,
    conversationAction: null,
    turnMutationAcceptedTurnKey: null,
    turnMutationOutcomeUnknownTurnKey: null,
    executions: {},
    supportAgentId: null,
    supportMessages: [],
    supportConversationLoading: false,
    supportDraft: '',
    supportSending: false,
    actionPendingId: null,
    dispatchRecovery: null,
    recoveryPending: false,
    error: null,
    notice: null,
    businessWorkOrders: [],
    businessCursor: null,
    businessNextAfterKey: null,
    businessLoading: false,
    businessRecoveryRequired: false,
    workflowCatalog: null,
    workflowLoading: false,
    addingProject: false,
    projectStartPending: false,
    projectBootstrap: null,
    voiceStatus: null,
    voiceCapturePhase: 'idle',
    voiceActiveOperationRef: null,
    voiceSendIntentOperationRef: null,
    voiceError: null,
  };
}
