import type { DesktopHostApi } from '../../electron/shared/host-contract';
import type {
  AgentProposal,
  AttentionResolutionInput,
  BridgeEvent,
  ConversationPage,
  ConversationQuery,
  OrquestaRendererBridge,
  ProjectSummary,
  UiActionResult
} from '../contracts/bridge';
import type { AttentionUiItem, OrquestaUiSnapshot } from '../contracts/orquesta-ui';

function correlationId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `desktop-${Date.now()}`;
}

function unavailable(reason: string): UiActionResult {
  return { status: 'unavailable', correlationId: correlationId(), reason, retryable: true };
}

function unsupported(reason: string): UiActionResult {
  return { status: 'unsupported', correlationId: correlationId(), reason, retryable: false };
}

export class DesktopRepositoryBridge implements OrquestaRendererBridge {
  private readonly host: DesktopHostApi;

  constructor(host: DesktopHostApi) {
    this.host = host;
  }

  getInitialSnapshot(): Promise<OrquestaUiSnapshot> {
    return this.host.getRepositorySnapshot();
  }

  subscribe(listener: (event: BridgeEvent) => void): () => void {
    return this.host.subscribeRepository((snapshot) => listener({ type: 'snapshot_changed', snapshot }));
  }

  async sendMessage(_input: { targetAgentId: string; text: string; attachmentIds: string[]; selectedContextIds: string[] }): Promise<UiActionResult> {
    return unavailable('Codex App Server command runtime is not connected yet. The draft remains in the app.');
  }

  async openAttentionItem(_id: string): Promise<UiActionResult> {
    return unsupported('This read-only item has no external action.');
  }

  async resolveAttentionItem(_input: AttentionResolutionInput): Promise<UiActionResult> {
    return unsupported('Read-only repository mode cannot resolve canonical attention state.');
  }

  async listConversation(_input: ConversationQuery): Promise<ConversationPage> {
    return { items: [], nextCursor: null };
  }

  listProjects(): Promise<ProjectSummary[]> {
    return this.host.listRepositories();
  }

  switchProject(projectId: string): Promise<UiActionResult> {
    return this.host.switchRepository(projectId);
  }

  requestOpenProject(): Promise<UiActionResult> {
    return this.host.openRepository();
  }

  async listAttentionHistory(): Promise<AttentionUiItem[]> {
    return [];
  }

  async listAgentProposals(): Promise<AgentProposal[]> {
    return [];
  }

  async approveAgentProposal(_proposalId: string): Promise<UiActionResult> {
    return unsupported('Read-only repository mode cannot change the canonical roster.');
  }
}
