import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

type JsonRecord = Record<string, unknown>;

export interface ProvisioningRequest {
  agent_id: string;
  role_id: string;
  team_id: string;
  line_id: string;
  task_id: string;
  status: 'pending' | 'reuse_ready' | 'standby' | 'provisioning_failed';
  created_at: string;
  thread_id?: string | null;
  turn_id?: string | null;
  handoff_status?: 'accepted' | 'failed' | null;
  error?: string | null;
  completed_at?: string | null;
}

export interface ProvisioningBatch {
  provisioning_batch_id: string;
  organization_revision: number;
  max_concurrent_provisioning: number;
  requests: ProvisioningRequest[];
  created_at: string;
  updated_at?: string;
}

export interface SpecialistRuntime {
  sendMessage(input: {
    correlationId: string;
    projectId: string;
    rootPath: string;
    threadId: string | null;
    targetAgentId: string;
    text: string;
    localImagePaths: string[];
    recommendedModel: string | null;
    requestedModel: string | null;
  }): Promise<{ threadId: string; turnId: string }>;
}

interface ProvisionSpecialistsInput {
  root: string;
  projectId?: string;
  batch: ProvisioningBatch;
  runtime: SpecialistRuntime;
  now?: () => string;
}

function object(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function rows(value: unknown, key: string): JsonRecord[] {
  const container = object(value);
  return Array.isArray(container[key]) ? (container[key] as unknown[]).map(object) : [];
}

async function readJson(filePath: string, fallback: JsonRecord): Promise<JsonRecord> {
  try {
    return object(JSON.parse(await readFile(filePath, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(fallback);
    throw error;
  }
}

export async function readProvisioningBatch(root: string): Promise<ProvisioningBatch | null> {
  try {
    const parsed = object(JSON.parse(await readFile(path.join(root, '.orquesta', 'setup', 'provisioning_batch.json'), 'utf8')));
    if (!parsed.provisioning_batch_id || !Array.isArray(parsed.requests)) throw new Error('Invalid provisioning batch');
    return parsed as unknown as ProvisioningBatch;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, filePath);
}

function upsert(items: JsonRecord[], key: string, value: JsonRecord): JsonRecord[] {
  const id = value[key];
  const index = items.findIndex((item) => item[key] === id);
  if (index === -1) return [...items, value];
  const next = [...items];
  next[index] = { ...items[index], ...value };
  return next;
}

function handoffText(request: ProvisioningRequest): string {
  return [
    '<orquesta_provisioning_handoff>',
    `  <agent_id>${request.agent_id}</agent_id>`,
    `  <role_id>${request.role_id}</role_id>`,
    `  <team_id>${request.team_id}</team_id>`,
    `  <line_id>${request.line_id}</line_id>`,
    `  <task_id>${request.task_id}</task_id>`,
    '  <instruction>Read the canonical task, respect its context boundary, execute it, and report completion evidence to the orchestrator.</instruction>',
    '</orquesta_provisioning_handoff>'
  ].join('\n');
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

async function attemptRequest(
  root: string,
  projectId: string,
  batchId: string,
  request: ProvisioningRequest,
  runtime: SpecialistRuntime,
  now: () => string
): Promise<ProvisioningRequest> {
  if (request.handoff_status === 'accepted' && request.thread_id && request.turn_id) {
    return structuredClone(request);
  }
  try {
    const accepted = await runtime.sendMessage({
      correlationId: `${batchId}:${request.agent_id}`,
      projectId,
      rootPath: root,
      threadId: request.thread_id ?? null,
      targetAgentId: request.agent_id,
      text: handoffText(request),
      localImagePaths: [],
      recommendedModel: null,
      requestedModel: null
    });
    return {
      ...request,
      status: 'standby',
      thread_id: accepted.threadId,
      turn_id: accepted.turnId,
      handoff_status: 'accepted',
      error: null,
      completed_at: now()
    };
  } catch (error) {
    return {
      ...request,
      status: 'provisioning_failed',
      thread_id: request.thread_id ?? null,
      turn_id: null,
      handoff_status: 'failed',
      error: boundedError(error),
      completed_at: now()
    };
  }
}

async function persistChunk(root: string, batch: ProvisioningBatch, completed: ProvisioningRequest[], now: string): Promise<void> {
  const stateRoot = path.join(root, '.orquesta', 'state');
  const setupRoot = path.join(root, '.orquesta', 'setup');
  const agentsPath = path.join(stateRoot, 'agents.json');
  const sessionsPath = path.join(stateRoot, 'sessions.json');
  const tasksPath = path.join(stateRoot, 'tasks.json');
  const batchPath = path.join(setupRoot, 'provisioning_batch.json');
  const agentsState = await readJson(agentsPath, { version: 1, agents: [] });
  const sessionsState = await readJson(sessionsPath, { version: 1, sessions: [] });
  const tasksState = await readJson(tasksPath, { version: 1, tasks: [] });
  let agents = rows(agentsState, 'agents');
  let sessions = rows(sessionsState, 'sessions');
  let tasks = rows(tasksState, 'tasks');

  for (const request of completed) {
    const accepted = request.handoff_status === 'accepted' && Boolean(request.thread_id && request.turn_id);
    agents = upsert(agents, 'agent_id', {
      agent_id: request.agent_id,
      role: request.role_id,
      role_id: request.role_id,
      role_version: 1,
      team_id: request.team_id,
      line_id: request.line_id,
      organization_scope: 'line',
      lifecycle_state: accepted ? 'active' : 'provisioning',
      operational_status: accepted ? 'standby' : 'provisioning_failed',
      status: accepted ? 'standby' : 'provisioning_failed',
      thread_id: accepted ? request.thread_id : null,
      provisioning_error: accepted ? null : request.error ?? 'Unknown provisioning failure',
      updated_at: now
    });
    if (accepted) {
      sessions = upsert(sessions, 'agent_id', {
        session_id: `session-${request.agent_id}`,
        agent_id: request.agent_id,
        thread_id: request.thread_id,
        status: 'standby',
        handoff_status: 'accepted',
        handoff_turn_id: request.turn_id,
        updated_at: now
      });
    }
    tasks = tasks.map((task) => task.task_id === request.task_id
      ? {
          ...task,
          owner_agent_id: request.agent_id,
          state: accepted ? 'in_progress' : task.state ?? 'queued',
          provisioning_status: accepted ? 'accepted' : 'failed',
          handoff_thread_id: accepted ? request.thread_id : null,
          handoff_turn_id: accepted ? request.turn_id : null,
          provisioning_error: accepted ? null : request.error ?? 'Unknown provisioning failure',
          updated_at: now
        }
      : task);
  }

  await writeJsonAtomic(agentsPath, { ...agentsState, agents, updated_at: now });
  await writeJsonAtomic(sessionsPath, { ...sessionsState, sessions, updated_at: now });
  await writeJsonAtomic(tasksPath, { ...tasksState, tasks, updated_at: now });
  await writeJsonAtomic(batchPath, { ...batch, updated_at: now });
}

export async function provisionSpecialists({
  root,
  projectId = path.basename(root),
  batch,
  runtime,
  now = () => new Date().toISOString()
}: ProvisionSpecialistsInput): Promise<ProvisioningBatch> {
  if (!path.isAbsolute(root)) throw new Error('Specialist provisioning requires an absolute repository root');
  if (!batch.provisioning_batch_id || !Array.isArray(batch.requests)) throw new Error('Invalid provisioning batch');
  if (!Number.isInteger(batch.max_concurrent_provisioning) || batch.max_concurrent_provisioning < 1) {
    throw new Error('Invalid provisioning concurrency');
  }
  const limit = Math.min(3, batch.max_concurrent_provisioning);
  const next: ProvisioningBatch = structuredClone(batch);

  for (let start = 0; start < next.requests.length; start += limit) {
    const chunk = next.requests.slice(start, start + limit);
    const completed = await Promise.all(chunk.map((item) => attemptRequest(
      root,
      projectId,
      next.provisioning_batch_id,
      item,
      runtime,
      now
    )));
    completed.forEach((item, index) => {
      next.requests[start + index] = item;
    });
    const timestamp = now();
    next.updated_at = timestamp;
    await persistChunk(root, next, completed, timestamp);
  }
  return next;
}
