import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  applyKernelEvent,
  claimDispatch,
  createKernelState,
  executionKernelEnabled,
  planDispatchTick,
  retryDelayMs,
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
import type {
  DesktopExecutionRuntime
} from './desktop-execution-kernel';

const STATE_FILE = 'execution-kernel-shadow-v2.json';
const SHADOW_FLAG = 'ORQUESTA_EXECUTION_KERNEL_SHADOW_V2';
const SHADOW_MAX_CONCURRENT = 2;

type PredictedAction = 'dispatch' | 'wait_for_capacity' | 'wait_for_dependency' | 'suppress_duplicate';
type ActualAction = 'dispatch_accepted' | 'dispatch_failed';
type RuntimeStatus = 'accepted' | 'started' | 'progress' | 'completed' | 'failed'
  | 'thread_missing' | 'thread_archived' | 'unknown';

interface RuntimeDispatchResult {
  threadId: string;
  turnId: string;
  modelEvidence: RuntimeModelEvidence;
}

interface ShadowObservation {
  observation_id: string;
  task_id: string;
  correlation_id: string;
  project_id: string;
  target_agent_id: string;
  input_fingerprint: string;
  input_character_count: number;
  local_image_count: number;
  prepared_at: string;
  predicted_action: PredictedAction;
  prediction_reason: string;
  predicted_dispatch_id: string | null;
  kernel_tracked: boolean;
  actual_action: ActualAction | null;
  actual_thread_id: string | null;
  actual_turn_id: string | null;
  actual_at: string | null;
  runtime_status: RuntimeStatus;
  finished_at: string | null;
  divergence: string | null;
  model_evidence: Record<string, unknown> | null;
  policy_evidence: {
    source: 'unavailable';
    execution_policy: null;
    reason: 'desktop_runtime_send_has_no_structured_task_intent';
  };
  additional_codex_turns: 0;
}

interface ShadowMetrics {
  observed_dispatches: number;
  predicted_dispatches: number;
  predicted_waits: number;
  predicted_duplicate_suppressions: number;
  actual_dispatches: number;
  actual_failures: number;
  matching_dispatches: number;
  divergences: number;
  completed_turns: number;
  additional_codex_turns: 0;
}

interface ShadowState {
  schema_version: 1;
  mode: 'shadow';
  kernel_state: KernelState;
  observations: ShadowObservation[];
  metrics: ShadowMetrics;
  created_at: string;
  updated_at: string;
}

function enabledFlag(value: string | undefined): boolean {
  return ['1', 'true', 'on', 'enabled'].includes(String(value ?? '').trim().toLowerCase());
}

export function desktopExecutionShadowEnabled(
  environment: NodeJS.ProcessEnv = process.env
): boolean {
  return !executionKernelEnabled(environment) && enabledFlag(environment[SHADOW_FLAG]);
}

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

function metricsFor(observations: ShadowObservation[]): ShadowMetrics {
  return {
    observed_dispatches: observations.length,
    predicted_dispatches: observations.filter((item) => item.predicted_action === 'dispatch').length,
    predicted_waits: observations.filter((item) => (
      item.predicted_action === 'wait_for_capacity' || item.predicted_action === 'wait_for_dependency'
    )).length,
    predicted_duplicate_suppressions: observations.filter((item) => (
      item.predicted_action === 'suppress_duplicate'
    )).length,
    actual_dispatches: observations.filter((item) => item.actual_action === 'dispatch_accepted').length,
    actual_failures: observations.filter((item) => item.actual_action === 'dispatch_failed').length,
    matching_dispatches: observations.filter((item) => (
      item.predicted_action === 'dispatch' && item.actual_action === 'dispatch_accepted'
    )).length,
    divergences: observations.filter((item) => Boolean(item.divergence)).length,
    completed_turns: observations.filter((item) => item.runtime_status === 'completed').length,
    additional_codex_turns: 0
  };
}

function fingerprint(input: DesktopRuntimeSendInput): string {
  return createHash('sha256')
    .update(JSON.stringify({
      target_agent_id: input.targetAgentId,
      text: input.text,
      local_image_paths: input.localImagePaths
    }))
    .digest('hex');
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

function taskIdFor(input: DesktopRuntimeSendInput): string {
  return `desktop-${input.correlationId}`;
}

function predictionFor(
  task: KernelTaskRecord,
  predictedDispatchId: string | null
): { action: PredictedAction; reason: string } {
  if (predictedDispatchId) return { action: 'dispatch', reason: 'eligible_within_capacity' };
  if (task.state === 'waiting_for_dependency') {
    return { action: 'wait_for_dependency', reason: task.blocker_reason ?? 'dependency_incomplete' };
  }
  if (task.state === 'eligible') {
    return { action: 'wait_for_capacity', reason: 'no_available_slots' };
  }
  return { action: 'suppress_duplicate', reason: `existing_execution_${task.state}` };
}

function emptyMetrics(): ShadowMetrics {
  return metricsFor([]);
}

export class DesktopExecutionShadowController {
  readonly enabled: boolean;
  private readonly runtime: DesktopExecutionRuntime;
  private readonly now: () => Date;
  private readonly roots = new Map<string, ShadowState>();
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
    this.enabled = desktopExecutionShadowEnabled(environment);
    this.now = now;
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operationQueue.then(operation, operation);
    this.operationQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  private async canonicalRoot(rootPath: string): Promise<string> {
    return realpath(rootPath);
  }

  private async load(canonicalRoot: string): Promise<ShadowState> {
    const cached = this.roots.get(canonicalRoot);
    if (cached) return cached;
    let state: ShadowState;
    try {
      state = JSON.parse(await readFile(statePath(canonicalRoot), 'utf8')) as ShadowState;
      if (state.schema_version !== 1 || state.mode !== 'shadow'
        || !state.kernel_state || !Array.isArray(state.observations)) {
        throw new Error('execution_kernel_shadow_state_invalid');
      }
      state.metrics = metricsFor(state.observations);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const createdAt = this.timestamp();
      state = {
        schema_version: 1,
        mode: 'shadow',
        kernel_state: createKernelState({
          maxConcurrent: SHADOW_MAX_CONCURRENT,
          updatedAt: createdAt
        }),
        observations: [],
        metrics: emptyMetrics(),
        created_at: createdAt,
        updated_at: createdAt
      };
    }
    this.roots.set(canonicalRoot, state);
    return state;
  }

  private async persist(canonicalRoot: string, state: ShadowState): Promise<void> {
    const destination = statePath(canonicalRoot);
    await mkdir(path.dirname(destination), { recursive: true });
    const next = {
      ...state,
      metrics: metricsFor(state.observations),
      updated_at: this.timestamp()
    };
    const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    await rename(temporary, destination);
    this.roots.set(canonicalRoot, next);
  }

  private prepare(state: ShadowState, input: DesktopRuntimeSendInput): {
    state: ShadowState;
    observation: ShadowObservation;
  } {
    const preparedAt = this.timestamp();
    const taskId = taskIdFor(input);
    const definitions = [
      ...definitionsFromState(state.kernel_state),
      ...(!state.kernel_state.tasks[taskId]
        ? [{
            task_id: taskId,
            priority: Object.keys(state.kernel_state.tasks).length + 1,
            created_at: preparedAt
          }]
        : [])
    ];
    const plan = planDispatchTick({
      state: state.kernel_state,
      tasks: definitions,
      now: preparedAt
    });
    const dispatch = plan.dispatches.find((candidate) => candidate.task_id === taskId) ?? null;
    const task = plan.state.tasks[taskId];
    const prediction = predictionFor(task, dispatch?.dispatch_id ?? null);
    const observation: ShadowObservation = {
      observation_id: `S-${createHash('sha256')
        .update(`${taskId}\u0000${state.observations.length + 1}\u0000${preparedAt}`)
        .digest('hex')
        .slice(0, 16)}`,
      task_id: taskId,
      correlation_id: input.correlationId,
      project_id: input.projectId,
      target_agent_id: input.targetAgentId,
      input_fingerprint: fingerprint(input),
      input_character_count: input.text.length,
      local_image_count: input.localImagePaths.length,
      prepared_at: preparedAt,
      predicted_action: prediction.action,
      prediction_reason: prediction.reason,
      predicted_dispatch_id: dispatch?.dispatch_id ?? null,
      kernel_tracked: false,
      actual_action: null,
      actual_thread_id: null,
      actual_turn_id: null,
      actual_at: null,
      runtime_status: 'unknown',
      finished_at: null,
      divergence: null,
      model_evidence: null,
      policy_evidence: {
        source: 'unavailable',
        execution_policy: null,
        reason: 'desktop_runtime_send_has_no_structured_task_intent'
      },
      additional_codex_turns: 0
    };
    return {
      state: {
        ...state,
        kernel_state: plan.state,
        observations: [...state.observations, observation]
      },
      observation
    };
  }

  private applyNotificationToKernel(
    kernelState: KernelState,
    observation: ShadowObservation,
    notification: RuntimeNotification
  ): KernelState {
    const task = kernelState.tasks[observation.task_id];
    if (!observation.kernel_tracked || !task?.dispatch_id) return kernelState;
    let next = kernelState;
    const common = {
      task_id: task.task_id,
      dispatch_id: task.dispatch_id,
      thread_id: task.thread_id,
      turn_id: task.turn_id,
      observed_at: this.timestamp()
    };
    const ensureRunning = () => {
      if (next.tasks[task.task_id].state === 'dispatching') {
        next = applyKernelEvent(next, {
          ...common,
          event_id: `${observation.observation_id}:turn_started`,
          type: 'turn_started'
        });
      }
    };
    if (notification.kind === 'turn_started') {
      ensureRunning();
    } else if (notification.kind === 'agent_message') {
      ensureRunning();
      if (next.tasks[task.task_id].state === 'running') {
        next = applyKernelEvent(next, {
          ...common,
          event_id: `${observation.observation_id}:progress:${eventSuffix(notification)}`,
          type: 'progress_observed'
        });
      }
    } else if (notification.kind === 'model_observed' && notification.modelEvidence.actualModel) {
      if (['dispatching', 'running'].includes(next.tasks[task.task_id].state)) {
        next = applyKernelEvent(next, {
          ...common,
          event_id: `${observation.observation_id}:model:${eventSuffix(notification)}`,
          type: 'model_observed',
          model: notification.modelEvidence.actualModel
        });
      }
    } else if (notification.kind === 'turn_completed') {
      ensureRunning();
      if (next.tasks[task.task_id].state === 'running') {
        next = applyKernelEvent(next, {
          ...common,
          event_id: `${observation.observation_id}:turn_completed`,
          type: 'turn_completed',
          status: 'completed'
        });
      }
    } else if (notification.kind === 'turn_failed') {
      if (!['accepted', 'failed', 'cancelled'].includes(next.tasks[task.task_id].state)) {
        next = applyKernelEvent(next, {
          ...common,
          event_id: `${observation.observation_id}:turn_failed`,
          type: 'task_failed',
          error: notification.text ?? 'codex_turn_failed'
        });
      }
    }
    return next;
  }

  private runtimeStatus(notification: RuntimeNotification): RuntimeStatus {
    if (notification.kind === 'turn_started') return 'started';
    if (notification.kind === 'turn_completed') return 'completed';
    if (notification.kind === 'turn_failed') return 'failed';
    return 'progress';
  }

  execute(
    input: DesktopRuntimeSendInput,
    authoritativeSend: () => Promise<RuntimeDispatchResult>
  ): Promise<RuntimeDispatchResult> {
    if (!this.enabled) return Promise.reject(new Error('Desktop execution shadow is disabled'));
    return this.enqueue(async () => {
      const canonicalRoot = await this.canonicalRoot(input.rootPath);
      let state = await this.load(canonicalRoot);
      const prepared = this.prepare(state, { ...input, rootPath: canonicalRoot });
      state = prepared.state;
      await this.persist(canonicalRoot, state);
      const observation = prepared.observation;
      try {
        const result = await authoritativeSend();
        let kernelState = state.kernel_state;
        if (observation.predicted_action === 'dispatch') {
          const claimed = claimDispatch(kernelState, {
            taskId: observation.task_id,
            now: this.timestamp()
          });
          kernelState = applyKernelEvent(claimed.state, {
            event_id: `${observation.observation_id}:dispatch_accepted`,
            type: 'dispatch_accepted',
            task_id: observation.task_id,
            dispatch_id: claimed.dispatch.dispatch_id,
            correlation_id: input.correlationId,
            thread_id: result.threadId,
            turn_id: result.turnId,
            model_evidence: modelEvidenceForKernel(result.modelEvidence),
            observed_at: this.timestamp()
          });
          observation.kernel_tracked = true;
        }
        observation.actual_action = 'dispatch_accepted';
        observation.actual_thread_id = result.threadId;
        observation.actual_turn_id = result.turnId;
        observation.actual_at = this.timestamp();
        observation.runtime_status = 'accepted';
        observation.model_evidence = modelEvidenceForKernel(result.modelEvidence);
        observation.divergence = observation.predicted_action === 'dispatch'
          ? null
          : observation.predicted_action === 'suppress_duplicate'
            ? 'kernel_suppressed_legacy_dispatched'
            : 'kernel_waited_legacy_dispatched';
        await this.persist(canonicalRoot, { ...state, kernel_state: kernelState });
        return result;
      } catch (error) {
        let kernelState = state.kernel_state;
        if (observation.predicted_action === 'dispatch') {
          const claimed = claimDispatch(kernelState, {
            taskId: observation.task_id,
            now: this.timestamp()
          });
          const observedAt = this.timestamp();
          kernelState = applyKernelEvent(claimed.state, {
            event_id: `${observation.observation_id}:dispatch_failed`,
            type: 'attempt_failed',
            task_id: observation.task_id,
            dispatch_id: claimed.dispatch.dispatch_id,
            observed_at: observedAt,
            retry_at: new Date(Date.parse(observedAt) + retryDelayMs(claimed.dispatch.attempt)).toISOString(),
            error: error instanceof Error ? error.message : String(error)
          });
          observation.kernel_tracked = true;
        }
        observation.actual_action = 'dispatch_failed';
        observation.actual_at = this.timestamp();
        observation.runtime_status = 'failed';
        observation.finished_at = this.timestamp();
        observation.divergence = observation.predicted_action === 'dispatch'
          ? 'kernel_dispatch_legacy_failed'
          : null;
        await this.persist(canonicalRoot, { ...state, kernel_state: kernelState });
        throw error;
      }
    });
  }

  observe(notification: RuntimeNotification): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    return this.enqueue(async () => {
      for (const [canonicalRoot, state] of this.roots) {
        const observation = [...state.observations].reverse().find((candidate) => (
          candidate.actual_thread_id === notification.threadId
          && (!notification.turnId || candidate.actual_turn_id === notification.turnId)
          && !['completed', 'failed'].includes(candidate.runtime_status)
        ));
        if (!observation) continue;
        observation.runtime_status = this.runtimeStatus(notification);
        if (notification.kind === 'turn_completed' || notification.kind === 'turn_failed') {
          observation.finished_at = this.timestamp();
        }
        const kernelState = this.applyNotificationToKernel(state.kernel_state, observation, notification);
        await this.persist(canonicalRoot, { ...state, kernel_state: kernelState });
        return;
      }
    });
  }

  open(rootPath: string): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    return this.enqueue(async () => {
      const canonicalRoot = await this.canonicalRoot(rootPath);
      const state = await this.load(canonicalRoot);
      const liveThreads = await this.runtime.listProjectThreads(canonicalRoot);
      const byId = new Map(liveThreads.map((thread) => [thread.id, thread]));
      let kernelState = state.kernel_state;
      for (const observation of state.observations) {
        if (!observation.actual_thread_id || !observation.actual_turn_id
          || ['completed', 'failed', 'thread_missing', 'thread_archived'].includes(observation.runtime_status)) {
          continue;
        }
        const thread = byId.get(observation.actual_thread_id);
        if (!thread || thread.archived) {
          observation.runtime_status = thread?.archived ? 'thread_archived' : 'thread_missing';
          observation.finished_at = this.timestamp();
          continue;
        }
        const turnStatus = await this.runtime.readTurnStatus?.(
          observation.actual_thread_id,
          observation.actual_turn_id
        ) ?? null;
        if (!turnStatus) continue;
        const notification: RuntimeNotification = {
          kind: turnStatus === 'completed'
            ? 'turn_completed'
            : ['failed', 'interrupted', 'cancelled'].includes(turnStatus)
              ? 'turn_failed'
              : 'turn_started',
          threadId: observation.actual_thread_id,
          turnId: observation.actual_turn_id,
          text: null,
          targetAgentId: observation.target_agent_id,
          modelEvidence: {
            recommendedModel: null,
            requestedModel: null,
            appliedModel: null,
            actualModel: null,
            actualModelEvidence: 'unknown'
          }
        };
        observation.runtime_status = this.runtimeStatus(notification);
        if (notification.kind === 'turn_completed' || notification.kind === 'turn_failed') {
          observation.finished_at = this.timestamp();
        }
        kernelState = this.applyNotificationToKernel(kernelState, observation, notification);
      }
      await this.persist(canonicalRoot, { ...state, kernel_state: kernelState });
    });
  }
}
