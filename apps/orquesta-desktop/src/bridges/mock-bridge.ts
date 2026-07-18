import type {
  AgentProposal,
  AttentionResolutionInput,
  BridgeEvent,
  ConversationMessage,
  ConversationPage,
  ConversationQuery,
  OrquestaRendererBridge,
  ProjectSummary,
  UiActionResult
} from '../contracts/bridge';
import type { AttentionUiItem, OrquestaUiSnapshot, RuntimeUiEvent } from '../contracts/orquesta-ui';
import { fixtureCatalog, fixtureIdForProject, fixtureKeys, type FixtureId } from '../fixtures';

function correlationId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `prototype-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function accepted(): UiActionResult {
  return { status: 'accepted', correlationId: correlationId() };
}
function unavailable(reason: string): UiActionResult {
  return { status: 'unavailable', correlationId: correlationId(), reason, retryable: true };
}
function rejected(reason: string): UiActionResult {
  return { status: 'rejected', correlationId: correlationId(), reason, retryable: false };
}

export class MockOrquestaBridge implements OrquestaRendererBridge {
  private fixtureId: FixtureId;
  private listeners = new Set<(event: BridgeEvent) => void>();
  private conversations = new Map<string, ConversationMessage[]>();
  private resolvedAttention = new Map<string, AttentionUiItem>();
  private approvedProposals = new Set<string>();

  constructor(initialFixture: FixtureId = 'active-project') {
    this.fixtureId = initialFixture;
  }

  async getInitialSnapshot(): Promise<OrquestaUiSnapshot> {
    const snapshot = structuredClone(fixtureCatalog[this.fixtureId].snapshot);
    snapshot.attention = snapshot.attention.filter((item) => !this.resolvedAttention.has(item.id));
    return snapshot;
  }

  subscribe(listener: (event: BridgeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: BridgeEvent): void {
    for (const listener of this.listeners) listener(structuredClone(event));
  }

  async sendMessage(input: { targetAgentId: string; text: string; attachmentIds: string[]; selectedContextIds: string[] }): Promise<UiActionResult> {
    const snapshot = await this.getInitialSnapshot();
    if (snapshot.project.status === 'offline') return unavailable('Project is offline; the prototype keeps the draft only.');
    if (!input.text.trim()) return rejected('Message text is empty.');

    const existing = this.conversations.get(input.targetAgentId)
      ?? structuredClone(fixtureCatalog[this.fixtureId].conversations[input.targetAgentId] ?? []);
    existing.push({
      id: correlationId(),
      role: 'user',
      targetAgentId: input.targetAgentId,
      authorLabel: 'You',
      text: input.text.trim(),
      createdAt: new Date().toISOString(),
      evidenceLabel: 'Prototype message · no real turn started'
    });
    this.conversations.set(input.targetAgentId, existing);
    this.emit({
      type: 'toast',
      toast: {
        id: correlationId(),
        tone: 'neutral',
        title: 'Prototype message queued',
        message: 'Saved to mock conversation. No Codex turn was started.',
        taskId: null,
        createdAt: new Date().toISOString()
      }
    });
    return accepted();
  }

  async openAttentionItem(_id: string): Promise<UiActionResult> {
    return accepted();
  }

  async resolveAttentionItem(input: AttentionResolutionInput): Promise<UiActionResult> {
    const snapshot = fixtureCatalog[this.fixtureId].snapshot;
    const item = snapshot.attention.find((candidate) => candidate.id === input.id);
    if (!item) return rejected('Unknown attention item.');
    const resolved: AttentionUiItem = {
      ...structuredClone(item),
      resolvedAt: new Date().toISOString(),
      resolutionLabel: input.resolution
    };
    this.resolvedAttention.set(input.id, resolved);
    this.emit({ type: 'snapshot_changed', snapshot: await this.getInitialSnapshot() });
    return accepted();
  }

  async listConversation(input: ConversationQuery): Promise<ConversationPage> {
    const items = structuredClone(
      this.conversations.get(input.targetAgentId)
      ?? fixtureCatalog[this.fixtureId].conversations[input.targetAgentId]
      ?? []
    );
    const limit = Math.max(1, input.limit ?? 100);
    return { items: items.slice(-limit), nextCursor: null };
  }

  async listProjects(): Promise<ProjectSummary[]> {
    return fixtureKeys.map((key) => {
      const fixture = fixtureCatalog[key];
      const project = fixture.snapshot.project;
      return {
        id: project.id,
        title: project.title,
        rootPathLabel: project.rootPathLabel,
        status: project.status,
        connectionLabel: project.connectionLabel,
        lastOpenedAt: fixture.lastOpenedAt
      };
    });
  }

  async switchProject(projectId: string): Promise<UiActionResult> {
    const next = fixtureIdForProject(projectId);
    if (!next) return rejected('Unknown prototype project.');
    this.fixtureId = next;
    this.resolvedAttention.clear();
    this.emit({ type: 'snapshot_changed', snapshot: await this.getInitialSnapshot() });
    return accepted();
  }

  async requestOpenProject(): Promise<UiActionResult> {
    return unavailable('Directory picker is added during Electron integration.');
  }

  async listAttentionHistory(): Promise<AttentionUiItem[]> {
    const fixtureHistory = structuredClone(fixtureCatalog[this.fixtureId].attentionHistory);
    return [...Array.from(this.resolvedAttention.values()).map((item) => structuredClone(item)), ...fixtureHistory];
  }

  async listAgentProposals(): Promise<AgentProposal[]> {
    return structuredClone(
      fixtureCatalog[this.fixtureId].agentProposals.filter((proposal) => !this.approvedProposals.has(proposal.id))
    );
  }

  async approveAgentProposal(proposalId: string): Promise<UiActionResult> {
    const proposal = fixtureCatalog[this.fixtureId].agentProposals.find((item) => item.id === proposalId);
    if (!proposal) return rejected('Unknown proposal.');
    this.approvedProposals.add(proposalId);
    const toast: RuntimeUiEvent = {
      id: correlationId(),
      tone: 'success',
      title: `${proposal.displayName} approved`,
      message: 'Roster state changed in the prototype only.',
      taskId: null,
      createdAt: new Date().toISOString()
    };
    this.emit({ type: 'toast', toast });
    return accepted();
  }
}
