import { randomUUID } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { InspectionKind, InspectionTargetUi } from '../../src/contracts/orquesta-ui';
import type { RuntimeApprovalRequest, RuntimeNotification } from './protocol';
import { buildInspectionPrompt, type InspectionOutputEnvelope } from './inspection-prompts';
import {
  inspectionReportPath,
  readInspectionState,
  writeInspectionState,
  type InspectionRunRecord,
  type InspectionRuntimeBoundary,
  type InspectionStateFile
} from './inspection-run-store';

const ACTIVE_STATUSES = new Set<InspectionRunRecord['status']>(['queued', 'running', 'cancelling']);
const SAFE_ID = /^[a-zA-Z0-9._:-]{1,128}$/u;
const MAX_REPORT_BYTES = 1_048_576;

export interface StartInspectionInput {
  projectId: string;
  rootPath: string;
  kind: InspectionKind;
  target: { kind: InspectionTargetUi['kind']; ids: string[] };
  focus: string | null;
}

export interface InspectionRuntime {
  startInspection(input: {
    correlationId: string;
    projectId: string;
    rootPath: string;
    kind: InspectionKind;
    prompt: string;
  }): Promise<{ threadId: string; turnId: string; runtimeBoundary: InspectionRuntimeBoundary }>;
  interruptInspection(input: { correlationId: string; threadId: string; turnId: string }): Promise<void>;
  readInspectionThread(input: { correlationId: string; threadId: string }): Promise<{
    finalResponse: string | null;
    completed: boolean;
  }>;
  respondToApproval(input: { correlationId: string; requestId: string; decision: string }): Promise<{
    requestId: string;
    decision: string;
  }>;
}

export interface InspectionRunControllerOptions {
  runtime: InspectionRuntime;
  now?: () => Date;
  createId?: () => string;
}

interface RunLocation {
  projectId: string;
  rootPath: string;
  runId: string;
}

interface ReportValidation {
  envelope: InspectionOutputEnvelope | null;
  errorCode: 'invalid_report' | 'source_unavailable' | null;
  errorMessage: string | null;
}

function validateStartInput(input: StartInspectionInput): void {
  if (!SAFE_ID.test(input.projectId)) throw new Error('Inspection project id is invalid');
  if (!['external_benchmark', 'adversarial_audit'].includes(input.kind)) throw new Error('Inspection kind is invalid');
  if (!['project', 'line', 'team', 'agents'].includes(input.target.kind)) throw new Error('Inspection target is invalid');
  if (input.target.ids.length > 32 || !input.target.ids.every((id) => SAFE_ID.test(id))) {
    throw new Error('Inspection target ids are invalid');
  }
  if (input.target.kind === 'project' && input.target.ids.length !== 0) throw new Error('Project inspection target must not include ids');
  if ((input.target.kind === 'line' || input.target.kind === 'team') && input.target.ids.length !== 1) {
    throw new Error('Line and team inspection targets require one id');
  }
  if (input.target.kind === 'agents' && input.target.ids.length === 0) throw new Error('Agent inspection target requires at least one id');
  if (input.focus !== null && (input.focus.trim().length === 0 || input.focus.length > 4_096)) {
    throw new Error('Inspection focus is invalid');
  }
}

function parseEnvelope(text: string): ReportValidation {
  let value: unknown;
  try {
    value = JSON.parse(text.trim());
  } catch {
    return { envelope: null, errorCode: 'invalid_report', errorMessage: 'Inspection output was not a single JSON object.' };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { envelope: null, errorCode: 'invalid_report', errorMessage: 'Inspection output envelope is invalid.' };
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(',') !== 'markdown,outcome,sourceCount'
    || !['report_ready', 'partial'].includes(String(record.outcome))
    || !Number.isInteger(record.sourceCount) || Number(record.sourceCount) < 0
    || typeof record.markdown !== 'string' || !record.markdown.trim()
    || Buffer.byteLength(record.markdown, 'utf8') > MAX_REPORT_BYTES) {
    return { envelope: null, errorCode: 'invalid_report', errorMessage: 'Inspection output envelope is invalid.' };
  }
  return {
    envelope: {
      outcome: record.outcome as InspectionOutputEnvelope['outcome'],
      sourceCount: Number(record.sourceCount),
      markdown: record.markdown
    },
    errorCode: null,
    errorMessage: null
  };
}

function validateReport(kind: InspectionKind, text: string): ReportValidation {
  const parsed = parseEnvelope(text);
  if (!parsed.envelope) return parsed;
  const { envelope } = parsed;
  if (kind === 'external_benchmark') {
    const urls = new Set(envelope.markdown.match(/https?:\/\/[^\s)>\]]+/gu) ?? []);
    if (envelope.sourceCount < 1 || urls.size < envelope.sourceCount) {
      return { envelope: null, errorCode: 'source_unavailable', errorMessage: 'External comparison did not contain the claimed live sources.' };
    }
    const accessDates = envelope.markdown.match(/\b\d{4}-\d{2}-\d{2}\b/gu) ?? [];
    const hasAxes = /(?:^|\n)#{1,3}\s+(?:comparison axes|比較軸)\b/iu.test(envelope.markdown);
    if (accessDates.length < envelope.sourceCount || !hasAxes) {
      return { envelope: null, errorCode: 'invalid_report', errorMessage: 'External comparison is missing access dates or comparison axes.' };
    }
  } else {
    const required = [/(?:evidence reference|証拠)/iu, /(?:severity|重大度)/iu, /(?:change cost|変更コスト)/iu, /(?:no-change risk|変更しない場合)/iu];
    if (!required.every((pattern) => pattern.test(envelope.markdown))) {
      return { envelope: null, errorCode: 'invalid_report', errorMessage: 'Adversarial audit is missing required finding fields.' };
    }
  }
  return parsed;
}

function reportDocument(run: InspectionRunRecord, completedAt: string, markdown: string): string {
  return `# ${run.kind === 'external_benchmark' ? 'External benchmark' : 'Adversarial audit'}\n\n`
    + `- Run ID: ${run.runId}\n`
    + `- Target: ${run.target.kind}:${run.target.ids.join(',') || 'project-root'}\n`
    + `- Started: ${run.startedAt ?? run.createdAt}\n`
    + `- Completed: ${completedAt}\n`
    + `- Runtime: sandbox=${run.runtimeBoundary?.sandbox ?? 'unknown'}, approvalPolicy=${run.runtimeBoundary?.approvalPolicy ?? 'unknown'}, webSearchMode=${run.runtimeBoundary?.webSearchMode ?? 'unknown'}\n\n`
    + `${markdown.trim()}\n`;
}

export class InspectionRunController {
  private readonly runtime: InspectionRuntime;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly runByThread = new Map<string, RunLocation>();
  private readonly responseByThread = new Map<string, string>();

  constructor(options: InspectionRunControllerOptions) {
    this.runtime = options.runtime;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? (() => `inspection-${randomUUID()}`);
  }

  private async updateRun(rootPath: string, runId: string, update: (run: InspectionRunRecord) => InspectionRunRecord): Promise<InspectionRunRecord> {
    const state = await readInspectionState(rootPath);
    const index = state.runs.findIndex((run) => run.runId === runId);
    if (index < 0) throw new Error('Inspection run no longer exists');
    const next = update(state.runs[index]);
    state.runs[index] = next;
    await writeInspectionState(rootPath, state);
    return next;
  }

  private async fail(location: RunLocation, errorCode: string, errorMessage: string): Promise<void> {
    const completedAt = this.now().toISOString();
    await this.updateRun(location.rootPath, location.runId, (run) => ({
      ...run,
      status: 'failed',
      errorCode,
      errorMessage: errorMessage.slice(0, 4_096),
      completedAt,
      closedAt: completedAt
    }));
    if (runLocationThread(this.runByThread, location)) this.runByThread.delete(runLocationThread(this.runByThread, location)!);
  }

  async start(input: StartInspectionInput): Promise<{ runId: string; threadId: string; turnId: string }> {
    validateStartInput(input);
    const state = await readInspectionState(input.rootPath);
    if (state.runs.some((run) => run.kind === input.kind && ACTIVE_STATUSES.has(run.status))) {
      throw new Error(`An ${input.kind} inspection is already active`);
    }
    const runId = this.createId();
    if (!SAFE_ID.test(runId) || state.runs.some((run) => run.runId === runId)) throw new Error('Inspection run id is invalid or duplicated');
    const createdAt = this.now().toISOString();
    const run: InspectionRunRecord = {
      runId,
      kind: input.kind,
      requestedBy: 'user',
      target: structuredClone(input.target),
      focus: input.focus?.trim() ?? null,
      status: 'queued',
      threadId: null,
      turnId: null,
      reportPath: null,
      sourceCount: 0,
      errorCode: null,
      errorMessage: null,
      runtimeBoundary: null,
      createdAt,
      startedAt: null,
      completedAt: null,
      closedAt: null
    };
    const queued: InspectionStateFile = { version: 1, runs: [...state.runs, run] };
    await writeInspectionState(input.rootPath, queued);
    try {
      const runtimeResult = await this.runtime.startInspection({
        correlationId: `inspection:${runId}:start`,
        projectId: input.projectId,
        rootPath: input.rootPath,
        kind: input.kind,
        prompt: buildInspectionPrompt({ runId, projectId: input.projectId, kind: input.kind, target: input.target, focus: run.focus })
      });
      const expectedWeb = input.kind === 'external_benchmark' ? 'live' : 'disabled';
      if (runtimeResult.runtimeBoundary.sandbox !== 'read-only'
        || runtimeResult.runtimeBoundary.approvalPolicy !== 'never'
        || runtimeResult.runtimeBoundary.webSearchMode !== expectedWeb) {
        throw new Error('read_only_boundary_violation: inspection runtime profile mismatch');
      }
      const startedAt = this.now().toISOString();
      await this.updateRun(input.rootPath, runId, (current) => ({
        ...current,
        status: 'running',
        threadId: runtimeResult.threadId,
        turnId: runtimeResult.turnId,
        runtimeBoundary: runtimeResult.runtimeBoundary,
        startedAt
      }));
      this.runByThread.set(runtimeResult.threadId, { projectId: input.projectId, rootPath: input.rootPath, runId });
      return { runId, threadId: runtimeResult.threadId, turnId: runtimeResult.turnId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.fail(
        { projectId: input.projectId, rootPath: input.rootPath, runId },
        message.includes('read_only_boundary_violation') ? 'read_only_boundary_violation' : 'runtime_unavailable',
        message
      );
      throw error;
    }
  }

  async cancel(input: { projectId: string; rootPath: string; runId: string }): Promise<void> {
    const state = await readInspectionState(input.rootPath);
    const run = state.runs.find((candidate) => candidate.runId === input.runId);
    if (!run || !ACTIVE_STATUSES.has(run.status)) throw new Error('Inspection run is not active');
    if (!run.threadId || !run.turnId) throw new Error('Inspection runtime ids are unavailable');
    await this.updateRun(input.rootPath, run.runId, (current) => ({ ...current, status: 'cancelling' }));
    try {
      await this.runtime.interruptInspection({
        correlationId: `inspection:${run.runId}:cancel`, threadId: run.threadId, turnId: run.turnId
      });
    } catch (error) {
      await this.fail(
        { projectId: input.projectId, rootPath: input.rootPath, runId: run.runId },
        'runtime_turn_failed',
        error instanceof Error ? error.message : String(error)
      );
      throw error;
    }
    const completedAt = this.now().toISOString();
    await this.updateRun(input.rootPath, run.runId, (current) => ({
      ...current, status: 'cancelled', completedAt, closedAt: completedAt
    }));
    this.runByThread.delete(run.threadId);
    this.responseByThread.delete(run.threadId);
  }

  private async complete(location: RunLocation, response: string): Promise<void> {
    const state = await readInspectionState(location.rootPath);
    const run = state.runs.find((candidate) => candidate.runId === location.runId);
    if (!run || !ACTIVE_STATUSES.has(run.status)) return;
    const validation = validateReport(run.kind, response);
    if (!validation.envelope) {
      await this.fail(location, validation.errorCode ?? 'invalid_report', validation.errorMessage ?? 'Inspection report is invalid.');
      return;
    }
    const completedAt = this.now().toISOString();
    const filename = await inspectionReportPath(location.rootPath, run.runId);
    await writeFile(filename, reportDocument(run, completedAt, validation.envelope.markdown), { encoding: 'utf8', flag: 'wx' });
    await this.updateRun(location.rootPath, run.runId, (current) => ({
      ...current,
      status: validation.envelope!.outcome,
      reportPath: filename,
      sourceCount: validation.envelope!.sourceCount,
      errorCode: null,
      errorMessage: null,
      completedAt,
      closedAt: completedAt
    }));
    if (run.threadId) {
      this.runByThread.delete(run.threadId);
      this.responseByThread.delete(run.threadId);
    }
  }

  async handleRuntimeNotification(notification: RuntimeNotification): Promise<boolean> {
    const location = this.runByThread.get(notification.threadId);
    if (!location) return false;
    if (notification.kind === 'agent_message' && notification.text) {
      this.responseByThread.set(notification.threadId, notification.text);
      return true;
    }
    if (notification.kind === 'turn_failed') {
      await this.fail(location, 'runtime_turn_failed', notification.text ?? 'Inspection turn failed.');
      return true;
    }
    if (notification.kind !== 'turn_completed') return true;
    let response = this.responseByThread.get(notification.threadId) ?? null;
    if (!response) {
      const history = await this.runtime.readInspectionThread({
        correlationId: `inspection:${location.runId}:completion`, threadId: notification.threadId
      });
      response = history.finalResponse;
    }
    if (!response) {
      await this.fail(location, 'invalid_report', 'Inspection completed without a final report envelope.');
      return true;
    }
    await this.complete(location, response);
    return true;
  }

  async handleRuntimeApproval(approval: RuntimeApprovalRequest): Promise<boolean> {
    const location = this.runByThread.get(approval.threadId);
    if (!location) return false;
    const decision = approval.responseOptions.includes('decline')
      ? 'decline'
      : approval.responseOptions.includes('cancel') ? 'cancel' : null;
    if (decision) {
      await this.runtime.respondToApproval({
        correlationId: approval.correlationId, requestId: approval.requestId, decision
      }).catch(() => undefined);
    }
    await this.runtime.interruptInspection({
      correlationId: `inspection:${location.runId}:boundary`,
      threadId: approval.threadId,
      turnId: approval.turnId
    }).catch(() => undefined);
    await this.fail(location, 'read_only_boundary_violation', 'Inspection requested an operation that requires approval.');
    return true;
  }

  async reconcileProject(projectId: string, rootPath: string): Promise<void> {
    const state = await readInspectionState(rootPath);
    for (const run of state.runs.filter((candidate) => ACTIVE_STATUSES.has(candidate.status))) {
      const location = { projectId, rootPath, runId: run.runId };
      if (!run.threadId) {
        await this.fail(location, 'runtime_interrupted', 'Inspection did not persist a runtime thread id.');
        continue;
      }
      this.runByThread.set(run.threadId, location);
      const history = await this.runtime.readInspectionThread({
        correlationId: `inspection:${run.runId}:reconcile`, threadId: run.threadId
      }).catch(() => ({ finalResponse: null, completed: false }));
      if (history.finalResponse) await this.complete(location, history.finalResponse);
      else await this.fail(location, 'runtime_interrupted', 'Inspection runtime did not provide a completed report after restart.');
    }
  }

  async readReport(input: { projectId: string; rootPath: string; runId: string }): Promise<string> {
    const state = await readInspectionState(input.rootPath);
    const run = state.runs.find((candidate) => candidate.runId === input.runId);
    if (!run?.reportPath) throw new Error('Inspection report is unavailable');
    const expected = await inspectionReportPath(input.rootPath, run.runId);
    if (path.resolve(run.reportPath) !== path.resolve(expected)) throw new Error('Inspection report path is outside the selected project');
    const info = await stat(expected);
    if (!info.isFile() || info.size > MAX_REPORT_BYTES) throw new Error('Inspection report exceeds the supported size');
    return readFile(expected, 'utf8');
  }
}

function runLocationThread(map: Map<string, RunLocation>, location: RunLocation): string | null {
  for (const [threadId, candidate] of map) {
    if (candidate.rootPath === location.rootPath && candidate.runId === location.runId) return threadId;
  }
  return null;
}
