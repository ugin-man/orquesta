import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  applyKernelEvent,
  createKernelState,
  executionKernelEnabled,
  runDispatchTick,
  type KernelState,
  type KernelTaskDefinition,
  type KernelTaskRecord
} from '@orquesta/execution-kernel';
import type {
  DesktopRuntimeSendInput
} from './desktop-codex-service';
import type {
  RuntimeModelEvidence,
  RuntimeNotification
} from './protocol';
import type { ProjectCodexThread } from './project-thread-reconciler';

const ACTIVE_STATES = new Set(['claimed', 'dispatching', 'running']);
const STATE_FILE = 'execution-kernel-v2.json';
const MAX_PHASE_C_TASKS = 2;

interface RuntimeDispatchResult {
  threadId: string;
  turnId: string;
  modelEvidence: RuntimeModelEvidence;
}

export interface DesktopExecutionRuntime {
  sendMessage(input: DesktopRuntimeSendInput): Promise<RuntimeDispatchResult>;
  listProjectThreads(rootPath: string): Promise<ProjectCodexThread[]>;
  readTurnStatus?(threadId: string, turnId: string): Promise<string | null>;
}

interface DispatchInput extends DesktopRuntimeSendInput {}

function definitionsFromState(state: KernelState): KernelTaskDefinition[] {
  return Object.values(state.tasks).map((task) => ({
    task_id: task.task_id,
    dependencies: [...task.dependencies],
    priority: task.priority,
    created_at: task.created_at,
    execution_revision: task.execution_revision,
    cycle_id: task.cycle_id
  }));
}

function modelEvidenceForKernel(evidence: RuntimeModelEvidence): Record<string, unknown> {
  return {
    recommended_model: evidence.recommendedModel,
    requested_model: evidence.requestedModel,
    applied_model: evidence.appliedModel,
    actual_model: evidence.actualModel,
    actual_model_evidence: evidence.actualModelEvidence
  };
}

function eventSuffix(notification: RuntimeNotification): string {
  return createHash('sha256')
    .update([
      notification.kind,
      notification.threadId,
      notification.turnId ?? '',
      notification.text ?? ''
    ].join('\u0000'))
    .digest('hex')
    .slice(0, 12);
}

function statePath(rootPath: string): string {
  return path.join(rootPath, '.orquesta', 'state', STATE_FILE);
}

function safeTimestamp(now: () => Date): string {
  return now().toISOString();
}

export function desktopExecutionKernelEnabled(
  environment: NodeJS.ProcessEnv = process.env
): boolean {
  return executionKernelEnabled(environment);
}

export class DesktopExecutionKernelController {
  readonly enabled: boolean;
  private readonly runtime: DesktopExecutionRuntime;
  private readonly now: () => Date;
  private readonly roots = new Map<string, KernelState>();
  private readonly dispatchInputs = new Map<string, DispatchInput>();
  private operationQueue: Promise<unknown> = Promise.resolve();

  constructor({
    runtime,
    environment = process.env,
    now = () => new Date()
  }: {
    runtime: DesktopExecutionRuntime;
    environment?: NodeJS.ProcessEnv;
    now?: () => Date;
  }) {
    this.runtime = runtime;
    this.enabled = desktopExecutionKernelEnabled(environment);
    this.now = now;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operationQueue.then(operation, operation);
    this.operationQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  private async canonicalRoot(rootPath: string): Promise<string> {
    return realpath(rootPath);
  }

  private async load(canonicalRoot: string): Promise<KernelState> {
    const cached = this.roots.get(canonicalRoot);
    if (cached) return cached;
    let state: KernelState;
    try {
      state = JSON.parse(await readFile(statePath(canonicalRoot), 'utf8')) as KernelState;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw error;
      state = createKernelState({
        maxConcurrent: MAX_PHASE_C_TASKS,
        updatedAt: safeTimestamp(this.now)
      });
    }
    this.roots.set(canonicalRoot, state);
    return state;
  }

  private async persist(canonicalRoot: string, state: KernelState): Promise<void> {
    const destination = statePath(canonicalRoot);
    await mkdir(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(temporary, destination);
    this.roots.set(canonicalRoot, state);
  }

  private taskForRuntimeIdentity(
    threadId: string,
    turnId: string | null
  ): { rootPath: string; task: KernelTaskRecord } | null {
    for (const [rootPath, state] of this.roots) {
      const task = Object.values(state.tasks).find((candidate) => (
        candidate.thread_id === threadId
        && (!turnId || !candidate.turn_id || candidate.turn_id === turnId)
      ));
      if (task) return { rootPath, task };
    }
    return null;
  }

  private applyRuntimeNotification(
    state: KernelState,
    task: KernelTaskRecord,
    notification: RuntimeNotification
  ): KernelState {
    const common = {
      task_id: task.task_id,
      dispatch_id: task.dispatch_id,
      thread_id: task.thread_id,
      turn_id: task.turn_id,
      observed_at: safeTimestamp(this.now)
    };
    const suffix = eventSuffix(notification);
    if (notification.kind === 'turn_started') {
      return applyKernelEvent(state, {
        ...common,
        event_id: `${task.dispatch_id}:desktop:turn_started`,
        type: 'turn_started'
      });
    }
    if (notification.kind === 'agent_message') {
      return applyKernelEvent(state, {
        ...common,
        event_id: `${task.dispatch_id}:desktop:progress:${suffix}`,
        type: 'progress_observed'
      });
    }
    if (notification.kind === 'model_observed' && notification.modelEvidence.actualModel) {
      return applyKernelEvent(state, {
        ...common,
        event_id: `${task.dispatch_id}:desktop:model:${suffix}`,
        type: 'model_observed',
        model: notification.modelEvidence.actualModel
      });
    }
    if (notification.kind === 'turn_completed') {
      return applyKernelEvent(state, {
        ...common,
        event_id: `${task.dispatch_id}:desktop:turn_completed`,
        type: 'turn_completed',
        status: 'completed'
      });
    }
    if (notification.kind === 'turn_failed') {
      return applyKernelEvent(state, {
        ...common,
        event_id: `${task.dispatch_id}:desktop:turn_failed`,
        type: 'task_failed',
        error: notification.text ?? 'codex_turn_failed'
      });
    }
    return state;
  }

  private async recoverLoadedRoot(
    canonicalRoot: string,
    state: KernelState
  ): Promise<KernelState> {
    const liveThreads = await this.runtime.listProjectThreads(canonicalRoot);
    const byId = new Map(liveThreads.map((thread) => [thread.id, thread]));
    let next = state;
    for (const task of Object.values(state.tasks)) {
      if (!ACTIVE_STATES.has(task.state)) continue;
      if (!task.thread_id || !task.turn_id) {
        next = applyKernelEvent(next, {
          event_id: `${task.dispatch_id}:recovery:missing_identity`,
          type: 'task_failed',
          task_id: task.task_id,
          dispatch_id: task.dispatch_id,
          observed_at: safeTimestamp(this.now),
          error: 'recovery_missing_runtime_identity'
        });
        continue;
      }
      const thread = byId.get(task.thread_id);
      if (!thread || thread.archived) {
        next = applyKernelEvent(next, {
          event_id: `${task.dispatch_id}:recovery:thread_unavailable`,
          type: 'task_failed',
          task_id: task.task_id,
          dispatch_id: task.dispatch_id,
          thread_id: task.thread_id,
          turn_id: task.turn_id,
          observed_at: safeTimestamp(this.now),
          error: thread?.archived ? 'recovery_thread_archived' : 'recovery_thread_missing'
        });
        continue;
      }
      const turnStatus = await this.runtime.readTurnStatus?.(task.thread_id, task.turn_id) ?? null;
      if (turnStatus === 'completed') {
        if (next.tasks[task.task_id].state !== 'running') {
          next = applyKernelEvent(next, {
            event_id: `${task.dispatch_id}:recovery:turn_started`,
            type: 'turn_started',
            task_id: task.task_id,
            dispatch_id: task.dispatch_id,
            thread_id: task.thread_id,
            turn_id: task.turn_id,
            observed_at: safeTimestamp(this.now)
          });
        }
        next = applyKernelEvent(next, {
          event_id: `${task.dispatch_id}:recovery:turn_completed`,
          type: 'turn_completed',
          task_id: task.task_id,
          dispatch_id: task.dispatch_id,
          thread_id: task.thread_id,
          turn_id: task.turn_id,
          observed_at: safeTimestamp(this.now),
          status: 'completed'
        });
      } else if (turnStatus === 'inProgress' && next.tasks[task.task_id].state !== 'running') {
        next = applyKernelEvent(next, {
          event_id: `${task.dispatch_id}:recovery:turn_started`,
          type: 'turn_started',
          task_id: task.task_id,
          dispatch_id: task.dispatch_id,
          thread_id: task.thread_id,
          turn_id: task.turn_id,
          observed_at: safeTimestamp(this.now)
        });
      } else if (turnStatus && ['failed', 'interrupted', 'cancelled'].includes(turnStatus)) {
        next = applyKernelEvent(next, {
          event_id: `${task.dispatch_id}:recovery:turn_failed`,
          type: 'task_failed',
          task_id: task.task_id,
          dispatch_id: task.dispatch_id,
          thread_id: task.thread_id,
          turn_id: task.turn_id,
          observed_at: safeTimestamp(this.now),
          error: `recovery_turn_${turnStatus}`
        });
      }
      // Unknown or idle evidence never causes an automatic redispatch.
    }
    return next;
  }

  open(rootPath: string): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    return this.enqueue(async () => {
      const canonicalRoot = await this.canonicalRoot(rootPath);
      const state = await this.load(canonicalRoot);
      const recovered = await this.recoverLoadedRoot(canonicalRoot, state);
      await this.persist(canonicalRoot, recovered);
    });
  }

  dispatch(input: DispatchInput): Promise<RuntimeDispatchResult> {
    if (!this.enabled) {
      return Promise.reject(new Error('Desktop execution kernel is disabled'));
    }
    return this.enqueue(async () => {
      const canonicalRoot = await this.canonicalRoot(input.rootPath);
      let state = await this.load(canonicalRoot);
      const taskId = `desktop-${input.correlationId}`;
      if (!state.tasks[taskId] && Object.keys(state.tasks).length >= MAX_PHASE_C_TASKS) {
        throw new Error(`Desktop execution-kernel proof is limited to ${MAX_PHASE_C_TASKS} tasks`);
      }
      this.dispatchInputs.set(taskId, { ...input, rootPath: canonicalRoot });
      const definitions = [
        ...definitionsFromState(state),
        ...(!state.tasks[taskId]
          ? [{
              task_id: taskId,
              priority: Object.keys(state.tasks).length + 1,
              created_at: safeTimestamp(this.now)
            }]
          : [])
      ];
      const tick = await runDispatchTick({
        state,
        tasks: definitions,
        now: safeTimestamp(this.now),
        adapter: {
          start: async (dispatch) => {
            const request = this.dispatchInputs.get(dispatch.task_id);
            if (!request) throw new Error(`Desktop dispatch input is unavailable for ${dispatch.task_id}`);
            const result = await this.runtime.sendMessage(request);
            return {
              accepted_at: safeTimestamp(this.now),
              correlation_id: request.correlationId,
              thread_id: result.threadId,
              turn_id: result.turnId,
              model_evidence: modelEvidenceForKernel(result.modelEvidence)
            };
          }
        }
      });
      state = tick.state;
      await this.persist(canonicalRoot, state);
      const result = tick.results.find((candidate) => candidate.task_id === taskId);
      if (!result || result.status !== 'dispatching' || !result.thread_id || !result.turn_id) {
        throw new Error(`Desktop execution kernel did not dispatch ${taskId}`);
      }
      return {
        threadId: result.thread_id,
        turnId: result.turn_id,
        modelEvidence: input.requestedModel || input.recommendedModel
          ? {
              recommendedModel: input.recommendedModel,
              requestedModel: input.requestedModel,
              appliedModel: state.tasks[taskId].model_evidence?.applied_model as string | null ?? null,
              actualModel: null,
              actualModelEvidence: 'unknown'
            }
          : {
              recommendedModel: null,
              requestedModel: null,
              appliedModel: state.tasks[taskId].model_evidence?.applied_model as string | null ?? null,
              actualModel: null,
              actualModelEvidence: 'unknown'
            }
      };
    });
  }

  observe(notification: RuntimeNotification): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    return this.enqueue(async () => {
      const match = this.taskForRuntimeIdentity(notification.threadId, notification.turnId);
      if (!match) return;
      const state = this.roots.get(match.rootPath);
      if (!state) return;
      const current = state.tasks[match.task.task_id];
      if (!current || !ACTIVE_STATES.has(current.state)) return;
      const next = this.applyRuntimeNotification(state, current, notification);
      await this.persist(match.rootPath, next);
    });
  }
}
