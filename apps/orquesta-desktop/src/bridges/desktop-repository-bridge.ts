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

function unsupported(reason: string): UiActionResult {
  return { status: 'unsupported', correlationId: correlationId(), reason, retryable: false };
}

export class DesktopRepositoryBridge implements OrquestaRendererBridge {
  readonly capabilities = { imageAttachments: true, attentionResolution: true } as const;
  private readonly host: DesktopHostApi;

  constructor(host: DesktopHostApi) {
    this.host = host;
  }

  getInitialSnapshot(): Promise<OrquestaUiSnapshot> {
    return this.host.getRepositorySnapshot();
  }

  subscribe(listener: (event: BridgeEvent) => void): () => void {
    const unsubscribeRepository = this.host.subscribeRepository((snapshot) => listener({ type: 'snapshot_changed', snapshot }));
    const unsubscribeRuntime = this.host.subscribeRuntime((notification) => {
      const tone = notification.kind === 'turn_failed' ? 'danger' : notification.kind === 'turn_completed' ? 'success' : 'neutral';
      const title = notification.kind === 'turn_started' ? 'Codex turn started'
        : notification.kind === 'turn_completed' ? 'Codex turn completed'
          : notification.kind === 'turn_failed' ? 'Codex turn failed'
            : notification.kind === 'model_observed' ? 'Codex model observed' : 'Coordinator replied';
      const runtimeLocation = notification.kind === 'turn_failed'
        ? ` Thread ${notification.threadId}${notification.turnId ? ` · turn ${notification.turnId}` : ''}.`
        : '';
      listener({
        type: 'toast',
        toast: {
          id: `${notification.kind}-${notification.turnId ?? notification.threadId}-${Date.now()}`,
          tone,
          title,
          message: `${notification.text ?? (notification.kind === 'turn_started' ? 'The coordinator accepted the instruction.' : title)}${runtimeLocation}`,
          taskId: null, createdAt: new Date().toISOString()
        }
      });
    });
    return () => { unsubscribeRepository(); unsubscribeRuntime(); };
  }

  sendMessage(input: { targetAgentId: string; text: string; attachmentIds: string[]; selectedContextIds: string[] }): Promise<UiActionResult> {
    return this.host.sendMessage(input);
  }

  async openAttentionItem(_id: string): Promise<UiActionResult> {
    return unsupported('This read-only item has no external action.');
  }

  async resolveAttentionItem(input: AttentionResolutionInput): Promise<UiActionResult> {
    if (input.kind === 'runtime_approval') {
      return this.host.respondRuntimeApproval({ id: input.id, decision: input.decision });
    }
    return unsupported('Read-only repository mode cannot resolve canonical attention state.');
  }

  listConversation(input: ConversationQuery): Promise<ConversationPage> {
    return this.host.listConversation(input);
  }

  getRuntimeInfo(input: { probe: boolean }) {
    return this.host.getRuntimeInfo(input);
  }

  openCodexDraft(input: { targetAgentId: string; text: string }): Promise<UiActionResult> {
    return this.host.openCodexDraft(input);
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

  selectImageAttachments() {
    return this.host.selectImageAttachments();
  }

  listAttentionHistory(): Promise<AttentionUiItem[]> {
    return this.host.listAttentionHistory();
  }

  async listAgentProposals(): Promise<AgentProposal[]> {
    return [];
  }

  async approveAgentProposal(_proposalId: string): Promise<UiActionResult> {
    return unsupported('Read-only repository mode cannot change the canonical roster.');
  }
}
