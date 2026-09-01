import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { RuntimeApprovalRequest, RuntimeThreadNotification as RuntimeNotification } from './protocol';
import type { InspectionRuntimeBoundary } from './inspection-run-store';
import {
  readWorkflowState,
  readWorkflowCatalog,
  readWorkflowResult,
  writeWorkflowResult,
  writeWorkflowState,
  WORKFLOW_LIMITS,
  type WorkflowAttemptRecord,
  type WorkflowBatchRecord,
  type WorkflowCheck,
  type WorkflowDefinition
} from './workflow-store';
import { ProjectMutationQueue } from './project-mutation-queue';

const ACTIVE_ATTEMPTS = new Set<WorkflowAttemptRecord['status']>(['starting', 'running']);
const SAFE_ID = /^[a-zA-Z0-9._:-]{1,128}$/u;

export interface WorkflowRuntime {
  startWorkflowRun(input: {
    correlationId: string;
    projectId: string;
    rootPath: string;
    prompt: string;
  }): Promise<{ threadId: string; turnId: string; runtimeBoundary: InspectionRuntimeBoundary }>;
  interruptInspection(input: { correlationId: string; threadId: string; turnId: string }): Promise<void>;
  readInspectionThread(input: { correlationId: string; threadId: string }): Promise<{
    finalResponse: string | null;
    status: 'in_progress' | 'completed' | 'failed' | 'unknown';
  }>;
  respondToApproval(input: { correlationId: string; requestId: string; providerConnectionId: string; decision: string }): Promise<{
    requestId: string;
    providerConnectionId: string;
    decision: string;
  }>;
}

interface AttemptLocation {
  projectId: string;
  rootPath: string;
  batchId: string;
  attemptId: string;
}

export interface WorkflowRunControllerOptions {
  runtime: WorkflowRuntime;
  now?: () => Date;
  createId?: (kind: 'workflow' | 'batch') => string;
}

function boundedText(value: string, name: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) throw new Error(`${name} is invalid`);
  return normalized;
}

function normalizeChecks(checks: WorkflowCheck[]): WorkflowCheck[] {
  if (!Array.isArray(checks) || checks.length > 16) throw new Error('workflow checks are invalid');
  return checks.map((check) => {
    if (!check || !['contains', 'not_contains'].includes(check.kind) || typeof check.caseSensitive !== 'boolean') {
      throw new Error('workflow check is invalid');
    }
    return { kind: check.kind, text: boundedText(check.text, 'workflow check text', 1_024), caseSensitive: check.caseSensitive };
  });
}

function workflowPrompt(batch: WorkflowBatchRecord, attempt: WorkflowAttemptRecord): string {
  return [
    'あなたは独立した一時実行です。次のワークフローを一度だけ実行してください。',
    'この実行は読み取り専用です。ファイル変更、外部への書込み、承認要求は行わないでください。',
    '途中経過ではなく、最後の返答に実行結果を自然な文章でまとめてください。JSONなど固定形式は不要です。',
    `ワークフロー: ${batch.definitionSnapshot.name}`,
    `反復: ${attempt.ordinal}/${batch.requestedRuns}`,
    '',
    batch.definitionSnapshot.prompt
  ].join('\n');
}

function evaluate(checks: WorkflowCheck[], output: string): { outcome: 'passed' | 'failed' | 'unassessed'; failed: number[] } {
  if (checks.length === 0) return { outcome: 'unassessed', failed: [] };
  const failed: number[] = [];
  checks.forEach((check, index) => {
    const haystack = check.caseSensitive ? output : output.toLocaleLowerCase();
    const needle = check.caseSensitive ? check.text : check.text.toLocaleLowerCase();
    const contains = haystack.includes(needle);
    if ((check.kind === 'contains' && !contains) || (check.kind === 'not_contains' && contains)) failed.push(index);
  });
  return { outcome: failed.length === 0 ? 'passed' : 'failed', failed };
}

function terminalBatch(batch: WorkflowBatchRecord, now: string): WorkflowBatchRecord {
  if (batch.attempts.some((attempt) => !['completed', 'failed', 'cancelled'].includes(attempt.status))) return batch;
  const completed = batch.attempts.filter((attempt) => attempt.status === 'completed').length;
  const failed = batch.attempts.filter((attempt) => attempt.status === 'failed').length;
  const status = batch.status === 'cancelling' || completed === 0 && failed === 0
    ? 'cancelled'
    : completed === batch.attempts.length ? 'completed'
      : completed === 0 ? 'failed' : 'partial';
  return { ...batch, status, completedAt: now };
}

export class WorkflowRunController {
  private readonly runtime: WorkflowRuntime;
  private readonly now: () => Date;
  private readonly createId: (kind: 'workflow' | 'batch') => string;
  private readonly locationByThread = new Map<string, AttemptLocation>();
  private readonly responseByThread = new Map<string, string>();
  private readonly mutations = new ProjectMutationQueue();

  constructor(options: WorkflowRunControllerOptions) {
    this.runtime = options.runtime;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? ((kind) => `${kind}-${randomUUID()}`);
  }

  async saveDefinition(input: {
    rootPath: string;
    workflowId: string | null;
    name: string;
    prompt: string;
    checks: WorkflowCheck[];
  }): Promise<WorkflowDefinition> {
    return this.mutations.run(input.rootPath, async () => {
      const state = await readWorkflowState(input.rootPath);
      const now = this.now().toISOString();
      const name = boundedText(input.name, 'workflow name', 256);
      const prompt = boundedText(input.prompt, 'workflow prompt', 65_536);
      const checks = normalizeChecks(input.checks);
      if (input.workflowId === null) {
        const workflowId = this.createId('workflow');
        if (!SAFE_ID.test(workflowId) || state.definitions.some((item) => item.workflowId === workflowId)) {
          throw new Error('workflow id is invalid or duplicated');
        }
        const definition = { workflowId, name, prompt, checks, createdAt: now, updatedAt: now };
        state.definitions.push(definition);
        await writeWorkflowState(input.rootPath, state);
        return definition;
      }
      if (!SAFE_ID.test(input.workflowId)) throw new Error('workflow id is invalid');
      const index = state.definitions.findIndex((item) => item.workflowId === input.workflowId);
      if (index < 0) throw new Error('workflow definition was not found');
      const definition = { ...state.definitions[index], name, prompt, checks, updatedAt: now };
      state.definitions[index] = definition;
      await writeWorkflowState(input.rootPath, state);
      return definition;
    });
  }

  readCatalog(rootPath: string) {
    return readWorkflowCatalog(rootPath);
  }

  async readResult(input: { rootPath: string; batchId: string; attemptId: string }): Promise<string> {
    const state = await readWorkflowState(input.rootPath);
    const batch = state.batches.find((item) => item.batchId === input.batchId);
    const attempt = batch?.attempts.find((item) => item.attemptId === input.attemptId);
    if (!attempt?.resultPath) throw new Error('workflow result is unavailable');
    const output = await readWorkflowResult(input.rootPath, input.batchId, input.attemptId);
    if (!attempt.resultPreview || !output.trim().startsWith(attempt.resultPreview)) {
      throw new Error('workflow result does not match its recorded attempt');
    }
    return output;
  }

  async startBatch(input: { projectId: string; rootPath: string; workflowId: string; repetitions: number }): Promise<{ batchId: string }> {
    if (!SAFE_ID.test(input.projectId) || !SAFE_ID.test(input.workflowId)) throw new Error('workflow start identity is invalid');
    if (!Number.isInteger(input.repetitions) || input.repetitions < 1 || input.repetitions > WORKFLOW_LIMITS.maxAttemptsPerBatch) {
      throw new Error('workflow repetition count is invalid');
    }
    const batchId = await this.mutations.run(input.rootPath, async () => {
      const state = await readWorkflowState(input.rootPath);
      const definition = state.definitions.find((item) => item.workflowId === input.workflowId);
      if (!definition) throw new Error('workflow definition was not found');
      const nextBatchId = this.createId('batch');
      if (!SAFE_ID.test(nextBatchId) || state.batches.some((item) => item.batchId === nextBatchId)) throw new Error('workflow batch id is invalid or duplicated');
      const createdAt = this.now().toISOString();
      const attempts: WorkflowAttemptRecord[] = Array.from({ length: input.repetitions }, (_, index) => ({
      attemptId: `${nextBatchId}:${index + 1}`,
      ordinal: index + 1,
      status: 'queued',
      threadId: null,
      turnId: null,
      resultPath: null,
      resultPreview: null,
      checkOutcome: null,
      failedCheckIndexes: [],
      errorCode: null,
      errorMessage: null,
      createdAt,
      startedAt: null,
      completedAt: null,
      durationMs: null
    }));
      state.batches.push({
      batchId: nextBatchId,
      workflowId: definition.workflowId,
      definitionSnapshot: structuredClone(definition),
      requestedRuns: input.repetitions,
      status: 'queued',
      attempts,
      createdAt,
      completedAt: null
    });
      await writeWorkflowState(input.rootPath, state);
      return nextBatchId;
    });
    await this.startNext({ projectId: input.projectId, rootPath: input.rootPath, batchId });
    return { batchId };
  }

  private async updateAttempt(location: AttemptLocation, update: (attempt: WorkflowAttemptRecord, batch: WorkflowBatchRecord) => WorkflowAttemptRecord): Promise<WorkflowBatchRecord> {
    return this.mutations.run(location.rootPath, async () => {
      const state = await readWorkflowState(location.rootPath);
      const batchIndex = state.batches.findIndex((batch) => batch.batchId === location.batchId);
      if (batchIndex < 0) throw new Error('workflow batch no longer exists');
      const batch = state.batches[batchIndex];
      const attemptIndex = batch.attempts.findIndex((attempt) => attempt.attemptId === location.attemptId);
      if (attemptIndex < 0) throw new Error('workflow attempt no longer exists');
      batch.attempts[attemptIndex] = update(batch.attempts[attemptIndex], batch);
      state.batches[batchIndex] = terminalBatch(batch, this.now().toISOString());
      await writeWorkflowState(location.rootPath, state);
      return state.batches[batchIndex];
    });
  }

  private async startNext(input: { projectId: string; rootPath: string; batchId: string }): Promise<void> {
    while (true) {
      const claimed = await this.mutations.run(input.rootPath, async () => {
        const state = await readWorkflowState(input.rootPath);
        const batch = state.batches.find((item) => item.batchId === input.batchId);
        if (!batch || batch.status === 'cancelling'
          || ['completed', 'partial', 'failed', 'cancelled'].includes(batch.status)
          || batch.attempts.some((attempt) => ACTIVE_ATTEMPTS.has(attempt.status))) return null;
        const queued = batch.attempts.find((attempt) => attempt.status === 'queued');
        if (!queued) return null;
        queued.status = 'starting';
        queued.startedAt = this.now().toISOString();
        await writeWorkflowState(input.rootPath, state);
        return { batch: structuredClone(batch), queued: structuredClone(queued) };
      });
      if (!claimed) return;
      const { batch, queued } = claimed;
      const location = { ...input, attemptId: queued.attemptId };
      try {
        const result = await this.runtime.startWorkflowRun({
          correlationId: `workflow:${batch.batchId}:${queued.attemptId}:start`,
          projectId: input.projectId,
          rootPath: input.rootPath,
          prompt: workflowPrompt(batch, queued)
        });
        if (result.runtimeBoundary.sandbox !== 'read-only'
          || result.runtimeBoundary.approvalPolicy !== 'never'
          || result.runtimeBoundary.webSearchMode !== 'disabled') {
          throw new Error('read_only_boundary_violation: workflow runtime profile mismatch');
        }
        await this.updateAttempt(location, (attempt, currentBatch) => {
          currentBatch.status = 'running';
          return { ...attempt, status: 'running', threadId: result.threadId, turnId: result.turnId };
        });
        this.locationByThread.set(result.threadId, location);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.updateAttempt(location, (attempt) => ({
          ...attempt,
          status: 'failed',
          errorCode: message.includes('read_only_boundary_violation') ? 'read_only_boundary_violation' : 'runtime_unavailable',
          errorMessage: message.slice(0, 4_096),
          completedAt: this.now().toISOString(),
          durationMs: this.duration(attempt.startedAt)
        }));
      }
    }
  }

  private duration(startedAt: string | null): number | null {
    if (!startedAt) return null;
    return Math.max(0, this.now().getTime() - new Date(startedAt).getTime());
  }

  private async finish(location: AttemptLocation, output: string): Promise<void> {
    const state = await readWorkflowState(location.rootPath);
    const batch = state.batches.find((item) => item.batchId === location.batchId);
    const attempt = batch?.attempts.find((item) => item.attemptId === location.attemptId);
    if (!batch || !attempt || !ACTIVE_ATTEMPTS.has(attempt.status)) return;
    const resultPath = await writeWorkflowResult(location.rootPath, batch.batchId, attempt.attemptId, output);
    const checked = evaluate(batch.definitionSnapshot.checks, output);
    await this.updateAttempt(location, (current) => ({
      ...current,
      status: 'completed',
      resultPath,
      resultPreview: output.trim().slice(0, 1_024),
      checkOutcome: checked.outcome,
      failedCheckIndexes: checked.failed,
      errorCode: null,
      errorMessage: null,
      completedAt: this.now().toISOString(),
      durationMs: this.duration(current.startedAt)
    }));
    if (attempt.threadId) {
      this.locationByThread.delete(attempt.threadId);
      this.responseByThread.delete(attempt.threadId);
    }
    await this.startNext({ projectId: location.projectId, rootPath: location.rootPath, batchId: location.batchId });
  }

  private async fail(location: AttemptLocation, code: string, message: string): Promise<void> {
    const batch = await this.updateAttempt(location, (attempt) => ({
      ...attempt,
      status: 'failed',
      errorCode: code,
      errorMessage: message.slice(0, 4_096),
      completedAt: this.now().toISOString(),
      durationMs: this.duration(attempt.startedAt)
    }));
    const attempt = batch.attempts.find((item) => item.attemptId === location.attemptId);
    if (attempt?.threadId) {
      this.locationByThread.delete(attempt.threadId);
      this.responseByThread.delete(attempt.threadId);
    }
    await this.startNext({ projectId: location.projectId, rootPath: location.rootPath, batchId: location.batchId });
  }

  async handleRuntimeNotification(notification: RuntimeNotification, allowedRootPath?: string): Promise<boolean> {
    const location = this.locationByThread.get(notification.threadId);
    if (!location) return false;
    if (allowedRootPath && path.resolve(location.rootPath) !== path.resolve(allowedRootPath)) return false;
    if (notification.kind === 'agent_message' && notification.text) {
      this.responseByThread.set(notification.threadId, notification.text);
      return true;
    }
    if (notification.kind === 'turn_failed') {
      await this.fail(location, 'runtime_turn_failed', notification.text ?? 'workflow turn failed');
      return true;
    }
    if (notification.kind !== 'turn_completed') return true;
    let response = this.responseByThread.get(notification.threadId) ?? null;
    if (!response) {
      response = (await this.runtime.readInspectionThread({
        correlationId: `workflow:${location.batchId}:${location.attemptId}:completion`,
        threadId: notification.threadId
      })).finalResponse;
    }
    if (!response) await this.fail(location, 'empty_result', 'workflow completed without a final response');
    else await this.finish(location, response);
    return true;
  }

  async handleRuntimeApproval(approval: RuntimeApprovalRequest, allowedRootPath?: string): Promise<boolean> {
    const location = this.locationByThread.get(approval.threadId);
    if (!location) return false;
    if (allowedRootPath && path.resolve(location.rootPath) !== path.resolve(allowedRootPath)) return false;
    const decision = approval.responseOptions.includes('decline') ? 'decline'
      : approval.responseOptions.includes('cancel') ? 'cancel' : null;
    if (decision) {
      await this.runtime.respondToApproval({
        correlationId: approval.correlationId,
        requestId: approval.requestId,
        providerConnectionId: approval.providerConnectionId,
        decision,
      }).catch(() => undefined);
    }
    await this.runtime.interruptInspection({
      correlationId: `workflow:${location.batchId}:${location.attemptId}:boundary`,
      threadId: approval.threadId,
      turnId: approval.turnId
    }).catch(() => undefined);
    await this.fail(location, 'read_only_boundary_violation', 'workflow requested an operation that requires approval');
    return true;
  }

  async cancelBatch(input: { projectId: string; rootPath: string; batchId: string }): Promise<void> {
    const completedAt = this.now().toISOString();
    const { active, batch } = await this.mutations.run(input.rootPath, async () => {
      const state = await readWorkflowState(input.rootPath);
      const currentBatch = state.batches.find((item) => item.batchId === input.batchId);
      if (!currentBatch || !['queued', 'running', 'cancelling'].includes(currentBatch.status)) throw new Error('workflow batch is not active');
      currentBatch.status = 'cancelling';
      const currentActive = currentBatch.attempts.find((attempt) => ACTIVE_ATTEMPTS.has(attempt.status));
      for (const attempt of currentBatch.attempts) {
        if (attempt.status === 'queued' || attempt.status === 'starting') {
          attempt.status = 'cancelled';
          attempt.completedAt = completedAt;
        }
      }
      await writeWorkflowState(input.rootPath, state);
      return { active: currentActive ? structuredClone(currentActive) : undefined, batch: structuredClone(currentBatch) };
    });
    if (active?.threadId && active.turnId) {
      await this.runtime.interruptInspection({
        correlationId: `workflow:${batch.batchId}:${active.attemptId}:cancel`, threadId: active.threadId, turnId: active.turnId
      });
    }
    await this.mutations.run(input.rootPath, async () => {
      const refreshed = await readWorkflowState(input.rootPath);
      const current = refreshed.batches.find((item) => item.batchId === input.batchId);
      if (!current) throw new Error('workflow batch no longer exists');
      for (const attempt of current.attempts) {
        if (ACTIVE_ATTEMPTS.has(attempt.status)) {
          attempt.status = 'cancelled';
          attempt.completedAt = completedAt;
          attempt.durationMs = this.duration(attempt.startedAt);
          if (attempt.threadId) {
            this.locationByThread.delete(attempt.threadId);
            this.responseByThread.delete(attempt.threadId);
          }
        }
      }
      current.status = 'cancelled';
      current.completedAt = completedAt;
      await writeWorkflowState(input.rootPath, refreshed);
    });
  }

  async reconcileProject(projectId: string, rootPath: string): Promise<void> {
    const state = await readWorkflowState(rootPath);
    for (const batch of state.batches.filter((item) => ['queued', 'running', 'cancelling'].includes(item.status))) {
      if (batch.status === 'cancelling') {
        await this.cancelBatch({ projectId, rootPath, batchId: batch.batchId });
        continue;
      }
      const starting = batch.attempts.find((attempt) => attempt.status === 'starting');
      if (starting) {
        await this.fail(
          { projectId, rootPath, batchId: batch.batchId, attemptId: starting.attemptId },
          'start_outcome_unknown',
          'workflow runtime acceptance was interrupted; the attempt was not started again to avoid a duplicate'
        );
        continue;
      }
      const running = batch.attempts.find((attempt) => attempt.status === 'running');
      if (!running) {
        await this.startNext({ projectId, rootPath, batchId: batch.batchId });
        continue;
      }
      if (!running.threadId) {
        await this.fail({ projectId, rootPath, batchId: batch.batchId, attemptId: running.attemptId }, 'runtime_interrupted', 'workflow runtime thread id is unavailable');
        continue;
      }
      const location = { projectId, rootPath, batchId: batch.batchId, attemptId: running.attemptId };
      this.locationByThread.set(running.threadId, location);
      let history: Awaited<ReturnType<WorkflowRuntime['readInspectionThread']>>;
      try {
        history = await this.runtime.readInspectionThread({
          correlationId: `workflow:${batch.batchId}:${running.attemptId}:reconcile`, threadId: running.threadId
        });
      } catch (error) {
        await this.fail(location, 'runtime_interrupted', error instanceof Error ? error.message : String(error));
        continue;
      }
      if (history.status === 'completed' && history.finalResponse) await this.finish(location, history.finalResponse);
      else if (history.status === 'failed' || history.status === 'unknown') await this.fail(location, 'runtime_turn_failed', `workflow runtime returned ${history.status}`);
    }
  }
}
