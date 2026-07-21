import type {
  AgentProposal,
  AttentionResolutionInput,
  BridgeEvent,
  ConversationMessage,
  ConversationPage,
  ConversationQuery,
  OrquestaRendererBridge,
  ProjectSummary,
  StartInspectionUiInput,
  UiActionResult
} from '../contracts/bridge';
import type { AskLucaInput, LucaAnswerPayload } from '../contracts/luca';
import type { AttentionUiItem, InspectionRunUiModel, OrquestaUiSnapshot, RuntimeUiEvent } from '../contracts/orquesta-ui';
import type { SetupAccountState, SetupDraft, SetupSourceDraft, SetupStartResult } from '../contracts/setup';
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
  readonly capabilities = { imageAttachments: false, attentionResolution: true } as const;
  private fixtureId: FixtureId;
  private listeners = new Set<(event: BridgeEvent) => void>();
  private conversations = new Map<string, ConversationMessage[]>();
  private resolvedAttention = new Map<string, AttentionUiItem>();
  private approvedProposals = new Set<string>();
  private inspectionRunsByProject = new Map<string, InspectionRunUiModel[]>();
  private setupDraft: SetupDraft = {
    revision: 1,
    status: 'draft',
    source: { kind: 'new_project', parentPath: 'C:\\Users\\Demo\\Documents\\Orquesta Projects', folderName: 'New Orquesta Project' },
    projectName: 'New Orquesta Project',
    description: '',
    questions: [],
    answers: []
  };
  private setupAccount: SetupAccountState = { status: 'authenticated', accountType: 'chatgpt', requiresOpenaiAuth: true };

  constructor(initialFixture: FixtureId = 'active-project') {
    this.fixtureId = initialFixture;
  }

  async getInitialSnapshot(): Promise<OrquestaUiSnapshot> {
    const snapshot = structuredClone(fixtureCatalog[this.fixtureId].snapshot);
    snapshot.attention = snapshot.attention.filter((item) => !this.resolvedAttention.has(item.id));
    const storedRuns = this.inspectionRunsByProject.get(snapshot.project.id);
    if (storedRuns) snapshot.inspectionRuns = structuredClone(storedRuns);
    const activeStatuses = new Set(['queued', 'running', 'cancelling']);
    const reportStatuses = new Set(['report_ready', 'partial', 'closed']);
    snapshot.inspectionTemplates = snapshot.inspectionTemplates.map((template) => ({
      ...template,
      activeRunId: snapshot.inspectionRuns.find((run) => run.kind === template.kind && activeStatuses.has(run.status))?.runId ?? null,
      lastReportRunId: snapshot.inspectionRuns.find((run) => run.kind === template.kind && reportStatuses.has(run.status) && run.reportPath)?.runId ?? null
    }));
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

  async askLuca(input: AskLucaInput): Promise<UiActionResult> {
    const question = input.customText?.trim() || input.questionId;
    const payload: LucaAnswerPayload = {
      answer: input.context.kind === 'home'
        ? 'これはプロトタイプのLuca回答です。現在のプロジェクト記録だけを説明しています。'
        : `これは${input.context.kind} ${input.context.id}についてのプロトタイプ説明です。`,
      points: ['実際のCodexターンは開始していません。'],
      uncertainties: ['モックデータのため、実行環境の状態は確認していません。'],
      references: input.context.kind === 'home' ? [] : [{ kind: input.context.kind, id: input.context.id, label: input.context.id }]
    };
    const existing = this.conversations.get('orquesta-admin') ?? [];
    const now = new Date().toISOString();
    existing.push({
      id: correlationId(), role: 'user', targetAgentId: 'orquesta-admin', authorLabel: 'You', text: question,
      createdAt: now, evidenceLabel: 'Prototype Luca question'
    }, {
      id: correlationId(), role: 'agent', targetAgentId: 'orquesta-admin', authorLabel: 'Luca', text: payload.answer,
      createdAt: now, evidenceLabel: 'Prototype Luca answer', lucaAnswer: payload, structured: true
    });
    this.conversations.set('orquesta-admin', existing);
    this.emit({
      type: 'runtime_notification',
      notification: {
        kind: 'agent_message', threadId: 'prototype-luca', turnId: correlationId(), text: payload.answer,
        targetAgentId: 'orquesta-admin', modelEvidence: {
          recommendedModel: 'Luna', requestedModel: 'gpt-5.6-luna', appliedModel: null,
          actualModel: null, actualModelEvidence: 'unknown'
        }
      }
    });
    return accepted();
  }

  async openAttentionItem(_id: string): Promise<UiActionResult> {
    return accepted();
  }

  async resolveAttentionItem(input: AttentionResolutionInput): Promise<UiActionResult> {
    if (input.kind === 'runtime_approval') return rejected('The prototype has no live runtime approval request.');
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

  async getRuntimeInfo(_input: { probe: boolean }) {
    return {
      status: 'unavailable' as const,
      adapter: 'app_server' as const,
      sdkVersion: null,
      codexVersion: null,
      runtimeVersion: null,
      targetTriple: null,
      platformFamily: null,
      platformOs: null,
      userAgent: null,
      integrity: 'unverified' as const
    };
  }

  async readSetupDraft(): Promise<SetupDraft | null> {
    return structuredClone(this.setupDraft);
  }

  async saveSetupDraft(draft: SetupDraft): Promise<void> {
    this.setupDraft = structuredClone(draft);
  }

  async chooseSetupSource(kind: SetupSourceDraft['kind']): Promise<SetupSourceDraft | null> {
    if (kind === 'detected_root') return this.setupDraft.source.kind === 'detected_root' ? structuredClone(this.setupDraft.source) : null;
    if (kind === 'existing_folder') return { kind, rootPath: 'C:\\Users\\Demo\\Documents\\Existing Project' };
    if (kind === 'new_project') {
      return { kind, parentPath: 'C:\\Users\\Demo\\Documents\\Orquesta Projects', folderName: this.setupDraft.projectName || 'New Orquesta Project' };
    }
    return null;
  }

  async readSetupAccount(): Promise<SetupAccountState> {
    return structuredClone(this.setupAccount);
  }

  async startSetupLogin() {
    this.setupAccount = { status: 'authenticated', accountType: 'chatgpt', requiresOpenaiAuth: true };
    return { type: 'chatgpt' as const, loginId: 'prototype-login', authUrl: 'https://auth.openai.com/authorize' };
  }

  async startSetup(draft: SetupDraft): Promise<SetupStartResult> {
    this.setupDraft = structuredClone(draft);
    const rootPath = draft.source.kind === 'detected_root' || draft.source.kind === 'existing_folder'
      ? draft.source.rootPath
      : `${draft.source.parentPath}\\${draft.source.kind === 'new_project' ? draft.source.folderName : draft.projectName}`;
    return { setupId: 'prototype-setup', rootPath, activePhaseId: 'environment' };
  }

  async openCodexDraft(_input: { targetAgentId: string; text: string }): Promise<UiActionResult> {
    return unavailable('The prototype cannot open a real Codex draft.');
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

  async selectImageAttachments() {
    return [];
  }

  async listAttentionHistory(): Promise<AttentionUiItem[]> {
    const fixtureHistory = structuredClone(fixtureCatalog[this.fixtureId].attentionHistory);
    return [...Array.from(this.resolvedAttention.values()).map((item) => structuredClone(item)), ...fixtureHistory];
  }

  async startInspection(input: StartInspectionUiInput): Promise<UiActionResult> {
    const snapshot = await this.getInitialSnapshot();
    if (snapshot.inspectionRuns.some((run) => run.kind === input.kind && ['queued', 'running', 'cancelling'].includes(run.status))) {
      return rejected('An inspection of this kind is already active.');
    }
    const template = snapshot.inspectionTemplates.find((item) => item.kind === input.kind);
    if (!template) return rejected('Unknown inspection kind.');
    const runId = `prototype-inspection-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const run: InspectionRunUiModel = {
      runId,
      kind: input.kind,
      displayName: template.displayName,
      status: 'running',
      target: {
        kind: input.target.kind,
        ids: [...input.target.ids],
        label: input.target.kind === 'project' ? snapshot.project.title : `${input.target.kind}: ${input.target.ids.join(', ')}`
      },
      focus: input.focus,
      threadId: null,
      turnId: null,
      reportPath: null,
      sourceCount: 0,
      errorCode: null,
      errorMessage: null,
      createdAt: new Date().toISOString(),
      completedAt: null
    };
    this.inspectionRunsByProject.set(snapshot.project.id, [...snapshot.inspectionRuns, run]);
    this.emit({ type: 'snapshot_changed', snapshot: await this.getInitialSnapshot() });
    return accepted();
  }

  async cancelInspection(runId: string): Promise<UiActionResult> {
    const snapshot = await this.getInitialSnapshot();
    const index = snapshot.inspectionRuns.findIndex((run) => run.runId === runId);
    if (index < 0 || !['queued', 'running', 'cancelling'].includes(snapshot.inspectionRuns[index].status)) {
      return rejected('Inspection is not active.');
    }
    snapshot.inspectionRuns[index] = {
      ...snapshot.inspectionRuns[index], status: 'cancelled', completedAt: new Date().toISOString()
    };
    this.inspectionRunsByProject.set(snapshot.project.id, snapshot.inspectionRuns);
    this.emit({ type: 'snapshot_changed', snapshot: await this.getInitialSnapshot() });
    return accepted();
  }

  async readInspectionReport(runId: string) {
    const snapshot = await this.getInitialSnapshot();
    const run = snapshot.inspectionRuns.find((candidate) => candidate.runId === runId);
    if (!run || !['report_ready', 'partial', 'closed'].includes(run.status)) throw new Error('Prototype inspection report is unavailable.');
    return {
      runId,
      markdown: `# ${run.displayName}\n\n> Evidence: Prototype inspection\n\nThis report is fixture data. No real Codex inspection turn ran.\n`
    };
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
