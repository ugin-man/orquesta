import type { AttentionUiItem, OrquestaUiSnapshot, ProjectStatus, RuntimeUiEvent } from './orquesta-ui';

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
  | { type: 'toast'; toast: RuntimeUiEvent };

export interface OrquestaRendererBridge {
  readonly capabilities: RendererCapabilities;
  getInitialSnapshot(): Promise<OrquestaUiSnapshot>;
  subscribe(listener: (event: BridgeEvent) => void): () => void;
  sendMessage(input: { targetAgentId: string; text: string; attachmentIds: string[]; selectedContextIds: string[] }): Promise<UiActionResult>;
  openAttentionItem(id: string): Promise<UiActionResult>;
  resolveAttentionItem(input: AttentionResolutionInput): Promise<UiActionResult>;
  listConversation(input: ConversationQuery): Promise<ConversationPage>;
  getRuntimeInfo(input: { probe: boolean }): Promise<RuntimeInfoUi>;
  listProjects(): Promise<ProjectSummary[]>;
  switchProject(projectId: string): Promise<UiActionResult>;
  requestOpenProject(): Promise<UiActionResult>;
  selectImageAttachments(): Promise<ComposerAttachment[]>;
  listAttentionHistory(): Promise<AttentionUiItem[]>;
  listAgentProposals(): Promise<AgentProposal[]>;
  approveAgentProposal(proposalId: string): Promise<UiActionResult>;
}
