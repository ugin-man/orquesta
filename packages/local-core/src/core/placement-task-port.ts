import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { canonicalHash, validateContract } from '@orquesta/contracts';
import type { PlacementTaskStateV3, PlacementTaskV3 } from '@orquesta/contracts';
import executionKernel from '@orquesta/execution-kernel';
import { PROJECT_STORAGE, projectStoragePath } from './project-storage-layout';

const IDENTIFIER_128 = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const PLACEMENT_INTENT_ID = /^PI-[a-f0-9]{12}$/u;
const LOCK_RELATIVE = 'runtime/placement-task-port/tasks-json.lock';
const STAGING_RELATIVE = 'runtime/placement-task-port/staging';
const UUID_FRAGMENT = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const STAGING_ARTIFACT = new RegExp(`^tasks-json\\.write-${UUID_FRAGMENT}\\.tmp$`, 'u');
const LEGACY_STATE_ARTIFACT = new RegExp(`^tasks\\.json\\.write-${UUID_FRAGMENT}\\.tmp$`, 'u');
const TRANSIENT_OPERATION_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const TASK_STATE_TRANSITIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  queued: ['assigned', 'blocked', 'cancelled', 'superseded'],
  assigned: ['dispatch_accepted', 'blocked', 'failed', 'cancelled', 'superseded'],
  dispatch_accepted: ['turn_started', 'blocked', 'failed', 'cancelled', 'superseded'],
  turn_started: ['in_progress', 'blocked', 'failed', 'cancelled'],
  in_progress: ['needs_orchestrator_review', 'blocked', 'failed', 'cancelled'],
  blocked: ['assigned', 'failed', 'cancelled', 'superseded'],
  failed: ['assigned', 'cancelled', 'superseded'],
  needs_orchestrator_review: ['accepted', 'needs_revision'],
  needs_revision: ['assigned', 'cancelled', 'superseded'],
  accepted: [],
  cancelled: [],
  superseded: []
});
const RESULT_STATES = new Set([
  'blocked', 'failed', 'needs_orchestrator_review', 'needs_revision', 'accepted', 'cancelled', 'superseded'
]);

export type PlacementTaskReadResult =
  | { status: 'missing'; filePath: string }
  | { status: 'migration_required'; filePath: string; reason: string }
  | { status: 'unsupported'; filePath: string; reason: string }
  | { status: 'ready'; filePath: string; state: PlacementTaskStateV3 };

export interface PlacementTaskReceipt {
  status: 'ready';
  state_revision: number;
  state_hash: string;
  tasks: PlacementTaskV3[];
}

export type PlacementTaskAuthorityPolicy = 'create_fresh' | 'migrate_only' | 'require_existing';
export type PlacementTaskAuthorityResult = PlacementTaskReceipt & {
  changed: boolean;
  source: 'created' | 'legacy_copy' | 'existing';
};

export interface TransitionPlacementTaskInput {
  projectId: string;
  expectedRevision: number;
  taskId: string;
  expectedState: PlacementTaskV3['state'];
  next: {
    state: PlacementTaskV3['state'];
    blockedBy: string[];
    resultSummary: string | null;
    acceptedAt: string | null;
    changedAt: string;
  };
}

export class PlacementTaskPortError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PlacementTaskPortError';
    this.code = code;
  }
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new PlacementTaskPortError(code, message, cause === undefined ? undefined : { cause });
}

function exactKeys(input: object, expected: readonly string[], label: string): void {
  const observed = Object.keys(input).sort();
  const required = [...expected].sort();
  if (observed.length !== required.length || observed.some((key, index) => key !== required[index])) {
    fail('PLACEMENT_TASK_INPUT_INVALID', `${label} must contain exactly: ${required.join(', ')}`);
  }
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactUtcTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) {
    fail('PLACEMENT_TASK_INPUT_INVALID', `${label} must be a canonical UTC timestamp`);
  }
  return value;
}

function comparable(value: string): string {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function trustedRoot(rootPath: string): string {
  if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath)) {
    fail('PLACEMENT_TASK_ROOT_INVALID', 'Placement Task port requires an absolute project root');
  }
  const requested = path.resolve(rootPath);
  let canonical: string;
  try {
    canonical = realpathSync(requested);
  } catch (error) {
    fail('PLACEMENT_TASK_ROOT_UNAVAILABLE', 'Placement Task port project root is unavailable', error);
  }
  const details = lstatSync(requested);
  if (!details.isDirectory() || details.isSymbolicLink() || comparable(requested) !== comparable(canonical)) {
    fail('PLACEMENT_TASK_ROOT_UNSAFE', 'Placement Task port project root must be a canonical real directory');
  }
  return canonical;
}

function assertInside(rootPath: string, candidatePath: string): void {
  const relative = path.relative(rootPath, candidatePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    fail('PLACEMENT_TASK_PATH_UNSAFE', 'Placement Task port path escaped the project root');
  }
}

function ensureRealDirectory(rootPath: string, directoryPath: string): void {
  assertInside(rootPath, directoryPath);
  const segments = path.relative(rootPath, directoryPath).split(path.sep).filter(Boolean);
  let current = rootPath;
  for (const segment of segments) {
    current = path.join(current, segment);
    if (!existsSync(current)) mkdirSync(current);
    const details = lstatSync(current);
    if (!details.isDirectory() || details.isSymbolicLink() || comparable(realpathSync(current)) !== comparable(current)) {
      fail('PLACEMENT_TASK_PATH_UNSAFE', `Placement Task port directory is unsafe: ${current}`);
    }
  }
}

function stateFile(rootPath: string): string {
  return projectStoragePath(rootPath, PROJECT_STORAGE.placementTasks);
}

function legacySharedStateFile(rootPath: string): string {
  return projectStoragePath(rootPath, PROJECT_STORAGE.tasks);
}

function lockFile(rootPath: string): string {
  return projectStoragePath(rootPath, LOCK_RELATIVE);
}

function stagingDirectory(rootPath: string): string {
  return projectStoragePath(rootPath, STAGING_RELATIVE);
}

function retryOperational<T>(operation: () => T): T {
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; ; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      if (!TRANSIENT_OPERATION_CODES.has((error as NodeJS.ErrnoException).code ?? '') || attempt >= 5) throw error;
      Atomics.wait(sleeper, 0, 0, Math.min(100, 8 * (2 ** attempt)));
    }
  }
}

function unlinkOwnedArtifact(rootPath: string, artifactPath: string): void {
  assertInside(rootPath, artifactPath);
  let expected: ReturnType<typeof lstatSync>;
  try {
    expected = lstatSync(artifactPath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!expected.isFile() || expected.isSymbolicLink()
    || comparable(realpathSync(artifactPath)) !== comparable(artifactPath)) {
    fail('PLACEMENT_TASK_PATH_UNSAFE', `Placement Task staging artifact is unsafe: ${artifactPath}`);
  }
  retryOperational(() => {
    let current: typeof expected;
    try {
      current = lstatSync(artifactPath, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (!current.isFile() || current.isSymbolicLink()
      || current.dev !== expected.dev || current.ino !== expected.ino
      || comparable(realpathSync(artifactPath)) !== comparable(artifactPath)) {
      fail('PLACEMENT_TASK_PATH_UNSAFE', `Placement Task staging artifact identity changed: ${artifactPath}`);
    }
    unlinkSync(artifactPath);
  });
}

function cleanupOwnedArtifacts(rootPath: string): void {
  const locations = [
    { directory: stagingDirectory(rootPath), pattern: STAGING_ARTIFACT },
    { directory: path.dirname(stateFile(rootPath)), pattern: LEGACY_STATE_ARTIFACT }
  ];
  for (const { directory, pattern } of locations) {
    if (!existsSync(directory)) continue;
    const directoryDetails = lstatSync(directory);
    if (!directoryDetails.isDirectory() || directoryDetails.isSymbolicLink()
      || comparable(realpathSync(directory)) !== comparable(directory)) {
      fail('PLACEMENT_TASK_PATH_UNSAFE', `Placement Task staging directory is unsafe: ${directory}`);
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!pattern.test(entry.name)) continue;
      const artifactPath = path.join(directory, entry.name);
      assertInside(rootPath, artifactPath);
      if (!entry.isFile()) {
        fail('PLACEMENT_TASK_PATH_UNSAFE', `Placement Task staging artifact is unsafe: ${artifactPath}`);
      }
      unlinkOwnedArtifact(rootPath, artifactPath);
    }
  }
}

function knownLegacy(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.tasks)) return false;
  if (record.schema_version !== 3) return true;
  return record.tasks.some((task) => task && typeof task === 'object' && !Array.isArray(task)
    && typeof (task as Record<string, unknown>).task_id === 'string'
    && (typeof (task as Record<string, unknown>).placement_intent_id !== 'string'
      || typeof (task as Record<string, unknown>).placement_fingerprint !== 'string'));
}

function validateState(value: unknown, projectId: string): PlacementTaskStateV3 {
  const validation = validateContract('placement-task-state-v3', value);
  if (!validation.ok) {
    fail('PLACEMENT_TASK_STATE_UNSUPPORTED', validation.errors.map((item) => `${item.path}:${item.code}`).join(', '));
  }
  const state = value as PlacementTaskStateV3;
  if (state.project_id !== projectId) {
    fail('PLACEMENT_TASK_STATE_UNSUPPORTED', 'Placement Task state belongs to another project');
  }
  const ids = new Set<string>();
  for (const [index, task] of state.tasks.entries()) {
    if (ids.has(task.task_id)) fail('PLACEMENT_TASK_STATE_UNSUPPORTED', `Duplicate task_id: ${task.task_id}`);
    ids.add(task.task_id);
    if (index > 0 && compareCodeUnits(state.tasks[index - 1].task_id, task.task_id) >= 0) {
      fail('PLACEMENT_TASK_STATE_UNSUPPORTED', 'Placement tasks must use exact code-unit task_id order');
    }
    if (task.dependencies.some((dependency, dependencyIndex) => (
      dependencyIndex > 0 && compareCodeUnits(task.dependencies[dependencyIndex - 1], dependency) >= 0
    )) || task.blocked_by.some((blocker, blockerIndex) => (
      blockerIndex > 0 && compareCodeUnits(task.blocked_by[blockerIndex - 1], blocker) >= 0
    ))) {
      fail('PLACEMENT_TASK_STATE_UNSUPPORTED', `Task references are not canonical: ${task.task_id}`);
    }
    exactUtcTimestamp(task.created_at, 'task.created_at');
    exactUtcTimestamp(task.updated_at, 'task.updated_at');
    if (Date.parse(task.updated_at) < Date.parse(task.created_at)) {
      fail('PLACEMENT_TASK_STATE_UNSUPPORTED', `Task chronology is invalid: ${task.task_id}`);
    }
    if (task.accepted_at !== null) {
      exactUtcTimestamp(task.accepted_at, 'task.accepted_at');
    }
    if ((task.state === 'accepted') !== (task.accepted_at !== null)
      || ((task.state === 'blocked') !== (task.blocked_by.length > 0))
      || (task.state === 'accepted' && (task.result_summary === null || !task.result_summary.trim()))
      || (task.accepted_at !== null && (
        Date.parse(task.accepted_at) < Date.parse(task.created_at)
        || Date.parse(task.accepted_at) > Date.parse(task.updated_at)
      ))
      || (task.result_summary !== null && !RESULT_STATES.has(task.state))) {
      fail('PLACEMENT_TASK_STATE_UNSUPPORTED', `Task lifecycle evidence is invalid: ${task.task_id}`);
    }
    if (task.owner_agent_id !== task.assigned_agent_id
      || executionKernel.taskFingerprint(task) !== task.placement_fingerprint) {
      fail('PLACEMENT_TASK_STATE_UNSUPPORTED', `Placement task semantic evidence is invalid: ${task.task_id}`);
    }
  }
  return structuredClone(state);
}

function readStateFile(rootPath: string, filePath: string, projectId: string): PlacementTaskReadResult {
  assertInside(rootPath, filePath);
  if (!existsSync(filePath)) return { status: 'missing', filePath };
  const details = lstatSync(filePath);
  if (!details.isFile() || details.isSymbolicLink() || comparable(realpathSync(filePath)) !== comparable(filePath)) {
    fail('PLACEMENT_TASK_PATH_UNSAFE', 'Placement Task state must be a canonical real file');
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return { status: 'unsupported', filePath, reason: 'placement_task_state_malformed' };
  }
  if (knownLegacy(value)) {
    return { status: 'migration_required', filePath, reason: 'placement_task_state_legacy_or_mixed' };
  }
  try {
    return { status: 'ready', filePath, state: validateState(value, projectId) };
  } catch (error) {
    if (error instanceof PlacementTaskPortError && error.code === 'PLACEMENT_TASK_STATE_UNSUPPORTED') {
      return { status: 'unsupported', filePath, reason: error.message };
    }
    throw error;
  }
}

function readState(rootPath: string, projectId: string): PlacementTaskReadResult {
  return readStateFile(rootPath, stateFile(rootPath), projectId);
}

function legacySharedPlacementState(
  rootPath: string,
  projectId: string,
  ignoreNonPlacementAuthority = false
): PlacementTaskReadResult | null {
  const filePath = legacySharedStateFile(rootPath);
  assertInside(rootPath, filePath);
  if (!existsSync(filePath)) return null;
  const details = lstatSync(filePath);
  if (!details.isFile() || details.isSymbolicLink() || comparable(realpathSync(filePath)) !== comparable(filePath)) {
    if (ignoreNonPlacementAuthority) return null;
    fail('PLACEMENT_TASK_PATH_UNSAFE', 'Legacy shared Task state must be a canonical real file');
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    if (ignoreNonPlacementAuthority) return null;
    return { status: 'unsupported', filePath, reason: 'legacy_shared_task_state_ambiguous' };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    if (ignoreNonPlacementAuthority) return null;
    return { status: 'unsupported', filePath, reason: 'legacy_shared_task_state_ambiguous' };
  }
  const record = value as Record<string, unknown>;
  if (record.schema_version === undefined && record.version === 1 && Array.isArray(record.tasks)) return null;
  if (record.schema_version !== 3) {
    if (ignoreNonPlacementAuthority) return null;
    return { status: 'unsupported', filePath, reason: 'legacy_shared_task_state_ambiguous' };
  }
  const observed = readStateFile(rootPath, filePath, projectId);
  return ignoreNonPlacementAuthority && observed.status !== 'ready' ? null : observed;
}

function migrateLegacySharedPlacementState(
  rootPath: string,
  projectId: string
): PlacementTaskStateV3 | null {
  const legacy = legacySharedPlacementState(rootPath, projectId);
  if (legacy === null) return null;
  if (legacy.status === 'migration_required') {
    fail('PLACEMENT_TASK_MIGRATION_REQUIRED', `${legacy.reason}: ${legacy.filePath}`);
  }
  if (legacy.status === 'unsupported') {
    fail('PLACEMENT_TASK_STATE_UNSUPPORTED', `${legacy.reason}: ${legacy.filePath}`);
  }
  if (legacy.status === 'missing') return null;
  const destination = stateFile(rootPath);
  ensureRealDirectory(rootPath, path.dirname(destination));
  if (existsSync(destination)) {
    fail('PLACEMENT_TASK_STATE_UNSUPPORTED', 'Placement Task migration destination appeared while the authority lock was held');
  }
  publishState(rootPath, legacy.state);
  const migrated = readState(rootPath, projectId);
  if (migrated.status !== 'ready' || canonicalHash(migrated.state) !== canonicalHash(legacy.state)) {
    fail('PLACEMENT_TASK_WRITE_FAILED', 'Placement Task shared-path migration did not preserve canonical state');
  }
  return migrated.state;
}

function canonicalTasks(tasks: readonly PlacementTaskV3[]): PlacementTaskV3[] {
  return structuredClone([...tasks]).sort((left, right) => compareCodeUnits(left.task_id, right.task_id));
}

function sameImmutablePlacementTask(left: PlacementTaskV3, right: PlacementTaskV3): boolean {
  return left.task_id === right.task_id
    && left.placement_fingerprint === right.placement_fingerprint
    && executionKernel.taskFingerprint(left) === executionKernel.taskFingerprint(right);
}

function assertInitialPlacementTask(task: PlacementTaskV3): void {
  if (task.state !== 'queued'
    || task.blocked_by.length !== 0
    || task.result_summary !== null
    || task.accepted_at !== null
    || task.created_at !== task.updated_at) {
    fail(
      'PLACEMENT_TASK_INITIAL_STATE_INVALID',
      `New task ${task.task_id} must enter through the canonical queued lifecycle boundary`
    );
  }
}

function receipt(state: PlacementTaskStateV3, selectedTasks: readonly PlacementTaskV3[]): PlacementTaskReceipt {
  return {
    status: 'ready',
    state_revision: state.revision,
    state_hash: canonicalHash(state),
    tasks: canonicalTasks(selectedTasks)
  };
}

function publishState(rootPath: string, state: PlacementTaskStateV3): void {
  const filePath = stateFile(rootPath);
  ensureRealDirectory(rootPath, path.dirname(filePath));
  const stagingPath = stagingDirectory(rootPath);
  ensureRealDirectory(rootPath, stagingPath);
  const temporaryPath = path.join(stagingPath, `tasks-json.write-${randomUUID()}.tmp`);
  assertInside(rootPath, temporaryPath);
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    writeFileSync(descriptor, `${JSON.stringify(state)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    retryOperational(() => renameSync(temporaryPath, filePath));
  } catch (error) {
    fail('PLACEMENT_TASK_WRITE_FAILED', 'Placement Task state could not be published atomically', error);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    unlinkOwnedArtifact(rootPath, temporaryPath);
  }
}

function assertProjectId(projectId: string): void {
  if (typeof projectId !== 'string' || !IDENTIFIER_128.test(projectId)) {
    fail('PLACEMENT_TASK_INPUT_INVALID', 'projectId is invalid');
  }
}

function assertPlacementIntentId(placementIntentId: string): void {
  if (typeof placementIntentId !== 'string' || !PLACEMENT_INTENT_ID.test(placementIntentId)) {
    fail('PLACEMENT_TASK_INPUT_INVALID', 'placementIntentId is invalid');
  }
}

export class PlacementTaskPort {
  readonly #rootPath: string;
  readonly project_root_binding_sha256: string;

  constructor(rootPath: string) {
    this.#rootPath = trustedRoot(rootPath);
    this.project_root_binding_sha256 = executionKernel.projectRootBindingSha256(this.#rootPath);
  }

  read(projectId: string): PlacementTaskReadResult {
    assertProjectId(projectId);
    const current = readState(this.#rootPath, projectId);
    if (current.status === 'missing') {
      const legacy = legacySharedPlacementState(this.#rootPath, projectId);
      if (legacy === null) return current;
      return legacy.status === 'ready'
        ? { status: 'migration_required', filePath: legacy.filePath, reason: 'placement_task_legacy_shared_path' }
        : legacy;
    }
    return current;
  }

  async initializeFresh(input: { projectId: string }): Promise<PlacementTaskReceipt> {
    exactKeys(input, ['projectId'], 'initializeFresh input');
    assertProjectId(input.projectId);
    const observed = this.read(input.projectId);
    if (observed.status === 'unsupported') {
      fail('PLACEMENT_TASK_STATE_UNSUPPORTED', `${observed.reason}: ${observed.filePath}`);
    }
    if (observed.status === 'migration_required' && observed.reason !== 'placement_task_legacy_shared_path') {
      fail('PLACEMENT_TASK_MIGRATION_REQUIRED', `${observed.reason}: ${observed.filePath}`);
    }
    const policy: PlacementTaskAuthorityPolicy = observed.status === 'ready'
      ? 'require_existing'
      : observed.status === 'migration_required'
        ? 'migrate_only'
        : 'create_fresh';
    const { changed: _changed, source: _source, ...receiptValue } = await this.ensureAuthority({
      projectId: input.projectId,
      policy
    });
    return receiptValue;
  }

  async ensureAuthority(input: {
    projectId: string;
    policy: PlacementTaskAuthorityPolicy;
  }): Promise<PlacementTaskAuthorityResult> {
    exactKeys(input, ['projectId', 'policy'], 'ensureAuthority input');
    assertProjectId(input.projectId);
    if (!['create_fresh', 'migrate_only', 'require_existing'].includes(input.policy)) {
      fail('PLACEMENT_TASK_INPUT_INVALID', 'ensureAuthority policy is invalid');
    }
    return this.#withLock(() => {
      const current = readState(this.#rootPath, input.projectId);
      if (current.status === 'ready') {
        return { ...receipt(current.state, []), changed: false, source: 'existing' as const };
      }
      if (current.status === 'migration_required') {
        fail('PLACEMENT_TASK_MIGRATION_REQUIRED', `${current.reason}: ${current.filePath}`);
      }
      if (current.status === 'unsupported') {
        fail('PLACEMENT_TASK_STATE_UNSUPPORTED', `${current.reason}: ${current.filePath}`);
      }
      if (input.policy === 'require_existing') {
        fail('PLACEMENT_TASK_STATE_NOT_INITIALIZED', 'Placement Task state disappeared or was never initialized');
      }
      if (input.policy === 'migrate_only') {
        const migrated = migrateLegacySharedPlacementState(this.#rootPath, input.projectId);
        if (migrated === null) {
          fail('PLACEMENT_TASK_STATE_NOT_INITIALIZED', 'Expected legacy Placement authority is unavailable');
        }
        return { ...receipt(migrated, []), changed: true, source: 'legacy_copy' as const };
      }
      const lateLegacy = legacySharedPlacementState(this.#rootPath, input.projectId);
      if (lateLegacy !== null) {
        if (lateLegacy.status === 'ready') {
          fail('PLACEMENT_TASK_AUTHORITY_CHANGED', 'Legacy Placement authority appeared after composition preflight');
        }
        if (lateLegacy.status === 'migration_required') {
          fail('PLACEMENT_TASK_MIGRATION_REQUIRED', `${lateLegacy.reason}: ${lateLegacy.filePath}`);
        }
        if (lateLegacy.status === 'unsupported') {
          fail('PLACEMENT_TASK_STATE_UNSUPPORTED', `${lateLegacy.reason}: ${lateLegacy.filePath}`);
        }
      }
      const state = validateState({ schema_version: 3, project_id: input.projectId, revision: 0, tasks: [] }, input.projectId);
      publishState(this.#rootPath, state);
      return { ...receipt(state, []), changed: true, source: 'created' as const };
    });
  }

  async inspectPlacementTasks(input: {
    projectId: string;
    placementIntentId: string;
    taskIds: string[];
  }): Promise<PlacementTaskReceipt> {
    exactKeys(input, ['projectId', 'placementIntentId', 'taskIds'], 'inspectPlacementTasks input');
    assertProjectId(input.projectId);
    assertPlacementIntentId(input.placementIntentId);
    if (!Array.isArray(input.taskIds) || input.taskIds.length > 1024
      || input.taskIds.some((taskId) => typeof taskId !== 'string' || !IDENTIFIER_128.test(taskId))
      || new Set(input.taskIds).size !== input.taskIds.length) {
      fail('PLACEMENT_TASK_INPUT_INVALID', 'taskIds must be a bounded unique canonical array');
    }
    const current = readState(this.#rootPath, input.projectId);
    if (current.status === 'missing') fail('PLACEMENT_TASK_STATE_NOT_INITIALIZED', 'Placement Task state is not initialized');
    if (current.status === 'migration_required') fail('PLACEMENT_TASK_MIGRATION_REQUIRED', `${current.reason}: ${current.filePath}`);
    if (current.status === 'unsupported') fail('PLACEMENT_TASK_STATE_UNSUPPORTED', `${current.reason}: ${current.filePath}`);
    const byId = new Map(current.state.tasks.map((task) => [task.task_id, task]));
    const selected = input.taskIds.flatMap((taskId) => {
      const task = byId.get(taskId);
      if (!task) return [];
      if (task.placement_intent_id !== input.placementIntentId) {
        fail('PLACEMENT_TASK_IDENTITY_CONFLICT', `Task ${taskId} belongs to another placement intent`);
      }
      return [task];
    });
    return receipt(current.state, selected);
  }

  async reconcilePlacementTasks(input: {
    projectId: string;
    placementIntentId: string;
    tasks: PlacementTaskV3[];
  }): Promise<PlacementTaskReceipt> {
    exactKeys(input, ['projectId', 'placementIntentId', 'tasks'], 'reconcilePlacementTasks input');
    assertProjectId(input.projectId);
    assertPlacementIntentId(input.placementIntentId);
    if (!Array.isArray(input.tasks) || input.tasks.length === 0 || input.tasks.length > 1024) {
      fail('PLACEMENT_TASK_INPUT_INVALID', 'tasks must be a nonempty bounded array');
    }
    const incomingState = validateState({
      schema_version: 3,
      project_id: input.projectId,
      revision: 0,
      tasks: canonicalTasks(input.tasks)
    }, input.projectId);
    if (incomingState.tasks.some((task) => task.placement_intent_id !== input.placementIntentId)) {
      fail('PLACEMENT_TASK_IDENTITY_CONFLICT', 'Every task must belong to the requested placement intent');
    }
    return this.#withLock(() => {
      const current = readState(this.#rootPath, input.projectId);
      if (current.status === 'missing') fail('PLACEMENT_TASK_STATE_NOT_INITIALIZED', 'Placement Task state is not initialized');
      if (current.status === 'migration_required') fail('PLACEMENT_TASK_MIGRATION_REQUIRED', `${current.reason}: ${current.filePath}`);
      if (current.status === 'unsupported') fail('PLACEMENT_TASK_STATE_UNSUPPORTED', `${current.reason}: ${current.filePath}`);
      const byId = new Map(current.state.tasks.map((task) => [task.task_id, task]));
      let changed = false;
      for (const task of incomingState.tasks) {
        const existing = byId.get(task.task_id);
        if (existing && !sameImmutablePlacementTask(existing, task)) {
          fail('PLACEMENT_TASK_IDENTITY_CONFLICT', `task_id ${task.task_id} already has different immutable content`);
        }
        if (!existing) {
          assertInitialPlacementTask(task);
          byId.set(task.task_id, structuredClone(task));
          changed = true;
        }
      }
      const state = changed
        ? validateState({
            schema_version: 3,
            project_id: input.projectId,
            revision: current.state.revision + 1,
            tasks: canonicalTasks([...byId.values()])
          }, input.projectId)
        : current.state;
      if (changed) publishState(this.#rootPath, state);
      return receipt(state, incomingState.tasks.map((task) => byId.get(task.task_id) as PlacementTaskV3));
    });
  }

  async transitionPlacementTask(input: TransitionPlacementTaskInput): Promise<PlacementTaskReceipt> {
    exactKeys(input, ['projectId', 'expectedRevision', 'taskId', 'expectedState', 'next'], 'transitionPlacementTask input');
    exactKeys(input.next, ['state', 'blockedBy', 'resultSummary', 'acceptedAt', 'changedAt'], 'transitionPlacementTask next');
    assertProjectId(input.projectId);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0
      || typeof input.taskId !== 'string' || !IDENTIFIER_128.test(input.taskId)
      || !Object.hasOwn(TASK_STATE_TRANSITIONS, input.expectedState)
      || !Object.hasOwn(TASK_STATE_TRANSITIONS, input.next.state)
      || !Array.isArray(input.next.blockedBy) || input.next.blockedBy.length > 256
      || input.next.blockedBy.some((item) => typeof item !== 'string' || !IDENTIFIER_128.test(item))
      || new Set(input.next.blockedBy).size !== input.next.blockedBy.length
      || ((input.next.state === 'blocked') !== (input.next.blockedBy.length > 0))
      || (input.next.resultSummary !== null && (
        typeof input.next.resultSummary !== 'string'
        || !input.next.resultSummary.trim()
        || input.next.resultSummary.length > 16_384
      ))
      || (input.next.acceptedAt !== null && typeof input.next.acceptedAt !== 'string')) {
      fail('PLACEMENT_TASK_INPUT_INVALID', 'Task lifecycle transition input is invalid');
    }
    const changedAt = exactUtcTimestamp(input.next.changedAt, 'changedAt');
    if (input.next.acceptedAt !== null) exactUtcTimestamp(input.next.acceptedAt, 'acceptedAt');
    const blockedBy = [...input.next.blockedBy].sort(compareCodeUnits);
    return this.#withLock(() => {
      const current = readState(this.#rootPath, input.projectId);
      if (current.status === 'missing') fail('PLACEMENT_TASK_STATE_NOT_INITIALIZED', 'Placement Task state is not initialized');
      if (current.status === 'migration_required') fail('PLACEMENT_TASK_MIGRATION_REQUIRED', `${current.reason}: ${current.filePath}`);
      if (current.status === 'unsupported') fail('PLACEMENT_TASK_STATE_UNSUPPORTED', `${current.reason}: ${current.filePath}`);
      const task = current.state.tasks.find((item) => item.task_id === input.taskId);
      if (!task) fail('PLACEMENT_TASK_NOT_FOUND', `Task ${input.taskId} does not exist`);
      const nextTask: PlacementTaskV3 = {
        ...task,
        state: input.next.state,
        blocked_by: blockedBy,
        result_summary: input.next.resultSummary,
        accepted_at: input.next.acceptedAt,
        updated_at: changedAt
      };
      if (task.state === input.next.state) {
        if (canonicalHash(task) === canonicalHash(nextTask)) return receipt(current.state, [task]);
        fail('PLACEMENT_TASK_TRANSITION_REPLAY_CONFLICT', 'Repeated task state has different lifecycle evidence');
      }
      if (current.state.revision !== input.expectedRevision) {
        fail('PLACEMENT_TASK_REVISION_CONFLICT', `Expected task revision ${input.expectedRevision}, observed ${current.state.revision}`);
      }
      if (task.state !== input.expectedState) {
        fail('PLACEMENT_TASK_STATE_CONFLICT', `Expected ${input.expectedState}, observed ${task.state}`);
      }
      if (!TASK_STATE_TRANSITIONS[task.state].includes(input.next.state)) {
        fail('PLACEMENT_TASK_TRANSITION_INVALID', `${task.state} cannot transition to ${input.next.state}`);
      }
      if (Date.parse(changedAt) <= Date.parse(task.updated_at)) {
        fail('PLACEMENT_TASK_CHRONOLOGY_INVALID', 'changedAt must be later than the prior task update');
      }
      const state = validateState({
        ...current.state,
        revision: current.state.revision + 1,
        tasks: canonicalTasks(current.state.tasks.map((item) => item.task_id === task.task_id ? nextTask : item))
      }, input.projectId);
      publishState(this.#rootPath, state);
      return receipt(state, [state.tasks.find((item) => item.task_id === task.task_id) as PlacementTaskV3]);
    });
  }

  #withLock<T>(operation: () => T): T {
    let lock: ReturnType<typeof executionKernel.acquireExclusiveProcessLock> | null = null;
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        lock = executionKernel.acquireExclusiveProcessLock({
          rootPath: this.#rootPath,
          lockPath: lockFile(this.#rootPath),
          codePrefix: 'PLACEMENT_TASK'
        });
        break;
      } catch (error) {
        const code = (error as { code?: unknown })?.code;
        if ((code !== 'PLACEMENT_TASK_LOCKED' && code !== 'PLACEMENT_TASK_LOCK_UNAVAILABLE') || attempt === 99) {
          throw error;
        }
        Atomics.wait(sleeper, 0, 0, 5 + (attempt % 7));
      }
    }
    if (!lock) fail('PLACEMENT_TASK_LOCK_UNAVAILABLE', 'Placement Task lock acquisition did not converge');
    let operationError: unknown;
    try {
      cleanupOwnedArtifacts(this.#rootPath);
      return operation();
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      try {
        executionKernel.releaseExclusiveProcessLock(lock);
      } catch (releaseError) {
        if (operationError === undefined) throw releaseError;
        if (operationError && typeof operationError === 'object') {
          Object.assign(operationError, { lockReleaseError: releaseError });
        }
      }
    }
  }
}
