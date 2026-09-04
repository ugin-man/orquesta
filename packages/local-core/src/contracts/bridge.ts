import type { InspectionKind, InspectionTargetUi, OrquestaUiSnapshot, ProjectStatus, RuntimeUiEvent } from './orquesta-ui';
import type { LucaAnswerPayload } from './luca';

export type UiActionResult =
  | { status: 'accepted'; correlationId: string }
  | { status: 'unsupported' | 'unavailable' | 'rejected' | 'failed'; correlationId: string; reason: string; retryable: boolean };

export interface ConversationMessage {
  id: string;
  kind?: 'message' | 'session_boundary';
  role: 'user' | 'agent' | 'system';
  targetAgentId: string;
  authorLabel: string;
  text: string;
  createdAt: string;
  evidenceLabel: string | null;
  lucaAnswer?: LucaAnswerPayload | null;
  structured?: boolean;
  threadId?: string;
  turnId?: string | null;
  sourceMessageId?: string;
  sessionGeneration?: number;
  sessionBoundary?: {
    fromGeneration: number;
    toGeneration: number;
  };
}

export interface ConversationQuery {
  targetAgentId: string;
  cursor?: string | null;
  limit?: number;
}

export interface ConversationActivityBackfillRecord {
  eventType: 'tool.started' | 'tool.completed' | 'tool.failed'
    | 'command.started' | 'command.completed' | 'command.failed'
    | 'file.change.started' | 'file.change.completed' | 'file.change.failed'
    | 'diff.updated' | 'plan.updated';
  threadId: string;
  turnId: string;
  itemId: string | null;
  targetAgentId: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}

export interface ConversationPage {
  items: ConversationMessage[];
  nextCursor: string | null;
  activities?: ConversationActivityBackfillRecord[];
  structuredActivitiesComplete?: boolean;
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
  providerConnectionId: string | null;
  integrity: 'verified' | 'unverified' | 'failed';
  models: RuntimeModelUi[];
}

export interface RuntimeModelUi {
  id: string;
  displayName: string;
  isDefault: boolean;
  defaultReasoningEffort: string | null;
  supportedReasoningEfforts: Array<{ effort: string; description: string | null }>;
  serviceTiers: Array<{ id: string; name: string; description: string }>;
}

export interface StartInspectionUiInput {
  kind: InspectionKind;
  target: Pick<InspectionTargetUi, 'kind' | 'ids'>;
  focus: string | null;
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
  | { type: 'toast'; toast: RuntimeUiEvent }
  | {
      type: 'runtime_notification';
      notification: {
        kind: 'turn_started' | 'turn_completed' | 'turn_failed' | 'agent_message' | 'model_observed';
        correlationId?: string | null;
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
  openAttentionItem(id: string): Promise<UiActionResult>;
  resolveAttentionItem(input: AttentionResolutionInput): Promise<UiActionResult>;
  listConversation(input: ConversationQuery): Promise<ConversationPage>;
  getRuntimeInfo(input: { probe: boolean }): Promise<RuntimeInfoUi>;
  openCodexDraft(input: { targetAgentId: string; text: string }): Promise<UiActionResult>;
  listProjects(): Promise<ProjectSummary[]>;
  switchProject(projectId: string): Promise<UiActionResult>;
  requestOpenProject(): Promise<UiActionResult>;
  selectImageAttachments(): Promise<ComposerAttachment[]>;
  startInspection(input: StartInspectionUiInput): Promise<UiActionResult>;
  cancelInspection(runId: string): Promise<UiActionResult>;
  listAgentProposals(): Promise<AgentProposal[]>;
  approveAgentProposal(proposalId: string): Promise<UiActionResult>;
}
