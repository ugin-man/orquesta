import type { AttentionUiItem, InspectionKind, InspectionTargetUi, OrquestaUiSnapshot, ProjectStatus, RuntimeUiEvent } from './orquesta-ui';
import type { AskLucaInput, LucaAnswerPayload } from './luca';
import type { SetupAccountState, SetupDraft, SetupLoginStartResult, SetupProgressEvent, SetupSourceDraft, SetupStartResult } from './setup';
export type {
  SetupAccountState,
  SetupDraft,
  SetupLoginStartResult,
  SetupProgressEvent,
  SetupSourceDraft,
  SetupStartInput,
  SetupStartResult
} from './setup';

export type UiActionResult =
  | { status: 'accepted'; correlationId: string }
  | { status: 'unsupported' | 'unavailable' | 'rejected' | 'failed'; correlationId: string; reason: string; retryable: boolean };

export interface ConversationMessage {
  id: string;
  role: 'user' | 'agent' | 'system';
  targetAgentId: string;
  authorLabel: string;
  text: string;
  createdAt: string;
  evidenceLabel: string | null;
  lucaAnswer?: LucaAnswerPayload | null;
  structured?: boolean;
}

export interface ConversationQuery {
  targetAgentId: string;
  cursor?: string | null;
  limit?: number;
}

export interface ConversationPage {
  items: ConversationMessage[];
  nextCursor: string | null;
}

export interface RuntimeInfoUi {
  status: 'not_started' | 'ready' | 'unavailable';
  adapter: 'app_server';
  sdkVersion: string | null;
  codexVersion: string | null;
  runtimeVersion: string | null;
  targetTriple: string | null;
  platformFamily: string | null;
  platformOs: string | null;
  userAgent: string | null;
  integrity: 'verified' | 'unverified' | 'failed';
}

export interface StartInspectionUiInput {
  kind: InspectionKind;
  target: Pick<InspectionTargetUi, 'kind' | 'ids'>;
  focus: string | null;
}

export interface InspectionReportUi {
  runId: string;
  markdown: string;
}

export type AttentionResolutionInput =
  | { kind: 'runtime_approval'; id: string; decision: string }
  | { kind: 'repository_action'; id: string; resolution: string; note?: string | null };

export interface ProjectSummary {
  id: string;
  title: string;
  rootPathLabel: string | null;
  status: ProjectStatus;
  connectionLabel: string;
  lastOpenedAt: string;
}

export interface AgentProposal {
  id: string;
  displayName: string;
  role: string;
  reason: string;
  contextScope: string;
  approvalRequired: boolean;
  capacityLabel: string;
}

export interface ComposerAttachment {
  id: string;
  name: string;
  kind: 'image';
  sizeBytes: number;
}

export interface RendererCapabilities {
  imageAttachments: boolean;
  attentionResolution: boolean;
}

export type BridgeEvent =
  | { type: 'snapshot_changed'; snapshot: OrquestaUiSnapshot }
  | { type: 'setup_progress'; progress: SetupProgressEvent }
  | { type: 'toast'; toast: RuntimeUiEvent }
  | {
      type: 'runtime_notification';
      notification: {
        kind: 'turn_started' | 'turn_completed' | 'turn_failed' | 'agent_message' | 'model_observed';
        threadId: string;
        turnId: string | null;
        text: string | null;
        targetAgentId: string | null;
        modelEvidence: {
          recommendedModel: string | null;
          requestedModel: string | null;
          appliedModel: string | null;
          actualModel: string | null;
          actualModelEvidence: 'proven' | 'reported' | 'inferred' | 'unknown';
        };
      };
    };

export interface OrquestaRendererBridge {
  readonly capabilities: RendererCapabilities;
  getInitialSnapshot(): Promise<OrquestaUiSnapshot>;
  subscribe(listener: (event: BridgeEvent) => void): () => void;
  sendMessage(input: { targetAgentId: string; text: string; attachmentIds: string[]; selectedContextIds: string[] }): Promise<UiActionResult>;
  askLuca(input: AskLucaInput): Promise<UiActionResult>;
  openAttentionItem(id: string): Promise<UiActionResult>;
  resolveAttentionItem(input: AttentionResolutionInput): Promise<UiActionResult>;
  listConversation(input: ConversationQuery): Promise<ConversationPage>;
  getRuntimeInfo(input: { probe: boolean }): Promise<RuntimeInfoUi>;
  readSetupDraft(): Promise<SetupDraft | null>;
  saveSetupDraft(draft: SetupDraft): Promise<void>;
  chooseSetupSource(kind: SetupSourceDraft['kind']): Promise<SetupSourceDraft | null>;
  readSetupAccount(): Promise<SetupAccountState>;
  startSetupLogin(): Promise<SetupLoginStartResult>;
  startSetup(draft: SetupDraft): Promise<SetupStartResult>;
  openCodexDraft(input: { targetAgentId: string; text: string }): Promise<UiActionResult>;
  listProjects(): Promise<ProjectSummary[]>;
  switchProject(projectId: string): Promise<UiActionResult>;
  requestOpenProject(): Promise<UiActionResult>;
  selectImageAttachments(): Promise<ComposerAttachment[]>;
  listAttentionHistory(): Promise<AttentionUiItem[]>;
  startInspection(input: StartInspectionUiInput): Promise<UiActionResult>;
  cancelInspection(runId: string): Promise<UiActionResult>;
  readInspectionReport(runId: string): Promise<InspectionReportUi>;
  listAgentProposals(): Promise<AgentProposal[]>;
  approveAgentProposal(proposalId: string): Promise<UiActionResult>;
}
