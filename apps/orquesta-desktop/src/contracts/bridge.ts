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

export interface AttentionResolutionInput {
  id: string;
  resolution: string;
  note?: string | null;
}

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

export type BridgeEvent =
  | { type: 'snapshot_changed'; snapshot: OrquestaUiSnapshot }
  | { type: 'toast'; toast: RuntimeUiEvent };

export interface OrquestaRendererBridge {
  getInitialSnapshot(): Promise<OrquestaUiSnapshot>;
  subscribe(listener: (event: BridgeEvent) => void): () => void;
  sendMessage(input: { targetAgentId: string; text: string; attachmentIds: string[]; selectedContextIds: string[] }): Promise<UiActionResult>;
  openAttentionItem(id: string): Promise<UiActionResult>;
  resolveAttentionItem(input: AttentionResolutionInput): Promise<UiActionResult>;
  listConversation(input: ConversationQuery): Promise<ConversationPage>;
  listProjects(): Promise<ProjectSummary[]>;
  switchProject(projectId: string): Promise<UiActionResult>;
  requestOpenProject(): Promise<UiActionResult>;
  listAttentionHistory(): Promise<AttentionUiItem[]>;
  listAgentProposals(): Promise<AgentProposal[]>;
  approveAgentProposal(proposalId: string): Promise<UiActionResult>;
}
