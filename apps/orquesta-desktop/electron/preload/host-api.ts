import type { ComposerAttachment, ConversationMessage, ConversationPage, InspectionReportUi, ProjectSummary, RuntimeInfoUi, StartInspectionUiInput, UiActionResult } from '../../src/contracts/bridge';
import { LUCA_QUESTION_IDS, type AskLucaInput } from '../../src/contracts/luca';
import { isV4OperationsSnapshot, type AttentionUiItem, type OrquestaUiSnapshot } from '../../src/contracts/orquesta-ui';
import type { RuntimeNotification } from '../core/protocol';
import type { DesktopHostApi, DesktopHostInfo } from '../shared/host-contract';
import { DESKTOP_IPC } from '../shared/host-contract';

export type IpcInvoke = (channel: string, input?: unknown) => Promise<unknown>;
export type IpcSubscribe = (channel: string, listener: (payload: unknown) => void) => () => void;

function isDesktopHostInfo(value: unknown): value is DesktopHostInfo {
  if (!value || typeof value !== 'object') return false;
  const info = value as Record<string, unknown>;
  return info.platform === 'win32' && ['starting', 'ready', 'stopped'].includes(String(info.coreStatus));
}

function isRepositorySnapshot(value: unknown): value is OrquestaUiSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Record<string, unknown>;
  const project = snapshot.project && typeof snapshot.project === 'object' ? snapshot.project as Record<string, unknown> : null;
  return Boolean(
    project && typeof project.id === 'string' && typeof project.title === 'string'
    && Array.isArray(snapshot.agents) && Array.isArray(snapshot.tasks)
    && Array.isArray(snapshot.attention) && Array.isArray(snapshot.phases) && Array.isArray(snapshot.recentEvents)
    && Array.isArray(snapshot.inspectionTemplates) && Array.isArray(snapshot.inspectionRuns)
    && isV4OperationsSnapshot(snapshot.v4Operations)
  );
}

function isProjectSummary(value: unknown): value is ProjectSummary {
  if (!value || typeof value !== 'object') return false;
  const project = value as Record<string, unknown>;
  return typeof project.id === 'string' && typeof project.title === 'string' && typeof project.lastOpenedAt === 'string';
}

function isComposerAttachment(value: unknown): value is ComposerAttachment {
  if (!value || typeof value !== 'object') return false;
  const attachment = value as Record<string, unknown>;
  return safeId(attachment.id) && attachment.kind === 'image' && typeof attachment.name === 'string'
    && typeof attachment.sizeBytes === 'number' && Number.isSafeInteger(attachment.sizeBytes) && attachment.sizeBytes >= 0;
}

function isActionResult(value: unknown): value is UiActionResult {
  if (!value || typeof value !== 'object') return false;
  const action = value as Record<string, unknown>;
  if (typeof action.correlationId !== 'string') return false;
  if (action.status === 'accepted') return true;
  return ['unsupported', 'unavailable', 'rejected', 'failed'].includes(String(action.status))
    && typeof action.reason === 'string' && typeof action.retryable === 'boolean';
}

function safeProjectId(projectId: string): boolean {
  return /^[a-zA-Z0-9._:-]{1,128}$/u.test(projectId);
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,128}$/u.test(value);
}

function isConversationMessage(value: unknown): value is ConversationMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  if (!(safeId(message.id) && ['user', 'agent', 'system'].includes(String(message.role)) && safeId(message.targetAgentId)
    && typeof message.authorLabel === 'string' && typeof message.text === 'string' && typeof message.createdAt === 'string')) return false;
  if (message.structured !== undefined && typeof message.structured !== 'boolean') return false;
  if (message.lucaAnswer === undefined || message.lucaAnswer === null) return true;
  if (typeof message.lucaAnswer !== 'object' || Array.isArray(message.lucaAnswer)) return false;
  const answer = message.lucaAnswer as Record<string, unknown>;
  return typeof answer.answer === 'string' && Array.isArray(answer.points) && answer.points.every((item) => typeof item === 'string')
    && Array.isArray(answer.uncertainties) && answer.uncertainties.every((item) => typeof item === 'string')
    && Array.isArray(answer.references) && answer.references.every((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
      const reference = item as Record<string, unknown>;
      return ['project', 'phase', 'task', 'failure', 'inspection', 'agent', 'attention'].includes(String(reference.kind))
        && typeof reference.id === 'string' && typeof reference.label === 'string';
    });
}

const lucaQuestionIds = new Set<string>(LUCA_QUESTION_IDS);

function validateAskLucaInput(input: AskLucaInput): void {
  if (!input || !lucaQuestionIds.has(input.questionId) || !input.context || !['ja', 'en'].includes(input.locale)) {
    throw new Error('Luca question is invalid');
  }
  if (!['home', 'task', 'failure', 'inspection'].includes(input.context.kind)) throw new Error('Luca context is invalid');
  if (input.context.kind !== 'home' && !safeId(input.context.id)) throw new Error('Luca context id is invalid');
  if (input.customText !== undefined && input.customText !== null
    && (typeof input.customText !== 'string' || input.customText.length > 2_000)) throw new Error('Luca custom question is invalid');
}

function isConversationPage(value: unknown): value is ConversationPage {
  if (!value || typeof value !== 'object') return false;
  const page = value as Record<string, unknown>;
  return Array.isArray(page.items) && page.items.every(isConversationMessage) && (page.nextCursor === null || typeof page.nextCursor === 'string');
}

function isRuntimeNotification(value: unknown): value is RuntimeNotification {
  if (!value || typeof value !== 'object') return false;
  const notification = value as Record<string, unknown>;
  const evidence = notification.modelEvidence && typeof notification.modelEvidence === 'object'
    ? notification.modelEvidence as Record<string, unknown>
    : null;
  return ['turn_started', 'turn_completed', 'turn_failed', 'agent_message', 'model_observed'].includes(String(notification.kind))
    && safeId(notification.threadId) && (notification.turnId === null || safeId(notification.turnId))
    && (notification.text === null || typeof notification.text === 'string')
    && (notification.targetAgentId === null || safeId(notification.targetAgentId))
    && Boolean(evidence && ['proven', 'reported', 'inferred', 'unknown'].includes(String(evidence.actualModelEvidence)));
}

function nullableString(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

function isRuntimeInfo(value: unknown): value is RuntimeInfoUi {
  if (!value || typeof value !== 'object') return false;
  const info = value as Record<string, unknown>;
  return ['not_started', 'ready', 'unavailable'].includes(String(info.status)) && info.adapter === 'app_server'
    && nullableString(info.sdkVersion) && nullableString(info.codexVersion) && nullableString(info.runtimeVersion)
    && nullableString(info.targetTriple) && nullableString(info.platformFamily) && nullableString(info.platformOs)
    && nullableString(info.userAgent) && ['verified', 'unverified', 'failed'].includes(String(info.integrity));
}

function isAttentionItem(value: unknown): value is AttentionUiItem {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  if (!safeId(item.id) || typeof item.title !== 'string' || typeof item.summary !== 'string') return false;
  if (item.runtimeApproval === undefined) return true;
  if (!item.runtimeApproval || typeof item.runtimeApproval !== 'object') return false;
  const approval = item.runtimeApproval as Record<string, unknown>;
  return safeId(approval.requestId) && safeId(approval.threadId) && safeId(approval.turnId)
    && typeof approval.method === 'string' && Array.isArray(approval.responseOptions)
    && approval.responseOptions.length > 0 && approval.responseOptions.every((option) => typeof option === 'string');
}

function validateInspectionInput(input: StartInspectionUiInput): void {
  if (!input || !['external_benchmark', 'adversarial_audit'].includes(input.kind)) throw new Error('Inspection kind is invalid');
  const target = input.target;
  if (!target || !['project', 'line', 'team', 'agents'].includes(target.kind) || !Array.isArray(target.ids)
    || target.ids.length > 32 || !target.ids.every(safeId)) throw new Error('Inspection target is invalid');
  if ((target.kind === 'project' && target.ids.length !== 0)
    || ((target.kind === 'line' || target.kind === 'team') && target.ids.length !== 1)
    || (target.kind === 'agents' && target.ids.length === 0)) throw new Error('Inspection target scope is invalid');
  if (input.focus !== null && (typeof input.focus !== 'string' || !input.focus.trim() || input.focus.length > 4_096)) {
    throw new Error('Inspection focus is invalid');
  }
}

function isInspectionReport(value: unknown): value is InspectionReportUi {
  if (!value || typeof value !== 'object') return false;
  const report = value as Record<string, unknown>;
  return safeId(report.runId) && typeof report.markdown === 'string' && report.markdown.trim().length > 0
    && report.markdown.length <= 1_048_576;
}

export function createDesktopHostApi(invoke: IpcInvoke, subscribe: IpcSubscribe): DesktopHostApi {
  return {
    async getHostInfo() {
      const result = await invoke(DESKTOP_IPC.getHostInfo);
      if (!isDesktopHostInfo(result)) throw new Error('Desktop host returned invalid host information');
      return result;
    },
    async pingCore(correlationId) {
      if (!correlationId || correlationId.length > 128) {
        throw new Error('correlationId must contain 1-128 characters');
      }
      const result = await invoke(DESKTOP_IPC.pingCore, { correlationId });
      if (
        !result ||
        typeof result !== 'object' ||
        (result as Record<string, unknown>).correlationId !== correlationId
      ) {
        throw new Error('Desktop host returned an invalid Core ping response');
      }
      return { correlationId };
    },
    async getRepositorySnapshot() {
      const snapshot = await invoke(DESKTOP_IPC.getRepositorySnapshot);
      if (!isRepositorySnapshot(snapshot)) throw new Error('Desktop host returned an invalid repository snapshot');
      return snapshot;
    },
    async listRepositories() {
      const projects = await invoke(DESKTOP_IPC.listRepositories);
      if (!Array.isArray(projects) || !projects.every(isProjectSummary)) throw new Error('Desktop host returned an invalid project list');
      return projects;
    },
    async switchRepository(projectId) {
      if (!safeProjectId(projectId)) throw new Error('projectId must contain 1-128 safe identifier characters');
      const action = await invoke(DESKTOP_IPC.switchRepository, { projectId });
      if (!isActionResult(action)) throw new Error('Desktop host returned an invalid switch result');
      return action;
    },
    async openRepository() {
      const action = await invoke(DESKTOP_IPC.openRepository);
      if (!isActionResult(action)) throw new Error('Desktop host returned an invalid open result');
      return action;
    },
    async selectImageAttachments() {
      const attachments = await invoke(DESKTOP_IPC.selectImageAttachments);
      if (!Array.isArray(attachments) || attachments.length > 4 || !attachments.every(isComposerAttachment)) {
        throw new Error('Desktop host returned invalid image attachments');
      }
      return attachments;
    },
    subscribeRepository(listener) {
      return subscribe(DESKTOP_IPC.repositoryChanged, (payload) => {
        if (isRepositorySnapshot(payload)) listener(payload);
      });
    },
    async sendMessage(input) {
      if (!safeId(input.targetAgentId) || !input.text.trim() || input.text.length > 65_536) throw new Error('Message input is invalid');
      if (!Array.isArray(input.attachmentIds) || !Array.isArray(input.selectedContextIds)) throw new Error('Message context is invalid');
      const action = await invoke(DESKTOP_IPC.sendMessage, input);
      if (!isActionResult(action)) throw new Error('Desktop host returned an invalid send result');
      return action;
    },
    async askLuca(input) {
      validateAskLucaInput(input);
      const action = await invoke(DESKTOP_IPC.askLuca, input);
      if (!isActionResult(action)) throw new Error('Desktop host returned an invalid Luca result');
      return action;
    },
    async listConversation(input) {
      if (!safeId(input.targetAgentId)) throw new Error('Conversation target is invalid');
      const limit = input.limit ?? 100;
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('Conversation limit is invalid');
      const page = await invoke(DESKTOP_IPC.listConversation, { ...input, limit });
      if (!isConversationPage(page)) throw new Error('Desktop host returned an invalid conversation page');
      return page;
    },
    async getRuntimeInfo(input) {
      if (!input || typeof input.probe !== 'boolean') throw new Error('Runtime probe must be boolean');
      const info = await invoke(DESKTOP_IPC.getRuntimeInfo, input);
      if (!isRuntimeInfo(info)) throw new Error('Desktop host returned invalid runtime information');
      return info;
    },
    async openCodexDraft(input) {
      if (!safeId(input.targetAgentId) || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 65_536) {
        throw new Error('Codex draft input is invalid');
      }
      const action = await invoke(DESKTOP_IPC.openCodexDraft, { targetAgentId: input.targetAgentId, text: input.text.trim() });
      if (!isActionResult(action)) throw new Error('Desktop host returned an invalid Codex draft result');
      return action;
    },
    async respondRuntimeApproval(input) {
      if (!safeId(input.id) || typeof input.decision !== 'string' || !input.decision.trim() || input.decision.length > 128) {
        throw new Error('Runtime approval response is invalid');
      }
      const action = await invoke(DESKTOP_IPC.respondRuntimeApproval, input);
      if (!isActionResult(action)) throw new Error('Desktop host returned an invalid approval result');
      return action;
    },
    async listAttentionHistory() {
      const items = await invoke(DESKTOP_IPC.listAttentionHistory);
      if (!Array.isArray(items) || !items.every(isAttentionItem)) throw new Error('Desktop host returned invalid attention history');
      return items;
    },
    async startInspection(input) {
      validateInspectionInput(input);
      const normalized = {
        kind: input.kind,
        target: { kind: input.target.kind, ids: [...input.target.ids] },
        focus: typeof input.focus === 'string' ? input.focus.trim() : null
      };
      const action = await invoke(DESKTOP_IPC.startInspection, normalized);
      if (!isActionResult(action)) throw new Error('Desktop host returned an invalid inspection start result');
      return action;
    },
    async cancelInspection(runId) {
      if (!safeId(runId)) throw new Error('Inspection run id is invalid');
      const action = await invoke(DESKTOP_IPC.cancelInspection, { runId });
      if (!isActionResult(action)) throw new Error('Desktop host returned an invalid inspection cancel result');
      return action;
    },
    async readInspectionReport(runId) {
      if (!safeId(runId)) throw new Error('Inspection run id is invalid');
      const report = await invoke(DESKTOP_IPC.readInspectionReport, { runId });
      if (!isInspectionReport(report) || report.runId !== runId) throw new Error('Desktop host returned an invalid inspection report');
      return report;
    },
    subscribeRuntime(listener) {
      return subscribe(DESKTOP_IPC.runtimeChanged, (payload) => {
        if (isRuntimeNotification(payload)) listener(payload);
      });
    }
  };
}
