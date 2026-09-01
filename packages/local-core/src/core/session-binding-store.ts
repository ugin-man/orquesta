import { constants } from 'node:fs';
import {
  lstat,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  unlink
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { validateContract } from '@orquesta/contracts';
import executionKernel from '@orquesta/execution-kernel';
import type {
  SessionBindingRotationState,
  SessionBindingStateV1,
  SessionBindingV1,
  SessionBindingVisibility
} from '@orquesta/contracts';
import { PROJECT_STORAGE, projectStoragePath } from './project-storage-layout';

// Sole binding and ownership lifecycle authority. Compaction signals may request a transition,
// but no hook or projection may persist a parallel session registry.

const FOUNDATION_AGENT_IDS = executionKernel.FOUNDATION_AGENT_IDS;
const FOUNDATION_AGENT_ID_SET = new Set<string>(FOUNDATION_AGENT_IDS);
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const LOCK_STALE_AFTER_MS = 30_000;
const SESSION_BINDING_STAGING_RELATIVE = 'runtime/session-binding-store';
const OWNER_TRANSITIONS: Readonly<Record<string, readonly SessionBindingRotationState[]>> = {
  active: ['rotation_preparing'],
  rotation_preparing: ['rotation_pending'],
  rotation_pending: ['rotation_required', 'draining'],
  rotation_required: ['draining'],
  draining: ['checkpointed']
};
const OWNER_ACCEPTING_STATES = new Set<SessionBindingRotationState>([
  'active',
  'rotation_preparing',
  'rotation_pending'
]);

type RenameFile = (sourcePath: string, destinationPath: string) => Promise<void>;
type UnlinkFile = (filePath: string) => Promise<void>;
type Sleep = (milliseconds: number) => Promise<void>;
type VerifyRuntimeAuthority = (input: {
  rootPath: string;
  projectId: string;
  runtimeAuthorityId: string;
}) => Promise<void>;
type MutationGuard = (canonicalRoot: string) => Promise<void>;

interface LockMetadata {
  schema_version: 1;
  pid: number;
  nonce: string;
  target_path: string;
  artifact_path: string;
  metadata_candidate_path: string;
  acquired_at: string;
}

interface HeldLock {
  lockPath: string;
  nonce: string;
  artifactPath: string;
  metadataCandidatePath: string;
}

interface RecoveryMetadata {
  schema_version: 1;
  pid: number;
  nonce: string;
  target_path: string;
  observed_lock_nonce: string;
  artifact_path: string;
  metadata_candidate_path: string;
  acquired_at: string;
}

export interface SessionBindingStoreOptions {
  renameFile?: RenameFile;
  unlinkFile?: UnlinkFile;
  sleep?: Sleep;
  nonce?: () => string;
  now?: () => Date;
  renameRetries?: number;
  verifyRuntimeAuthority?: VerifyRuntimeAuthority;
}

export type SessionBindingReadResult =
  | { status: 'missing'; filePath: string }
  | { status: 'migration_required'; filePath: string; reason: string }
  | { status: 'unsupported'; filePath: string; reason: string }
  | { status: 'ready'; filePath: string; state: SessionBindingStateV1 };

export interface SessionBindingMutationResult {
  changed: boolean;
  state: SessionBindingStateV1;
}

export type SessionBindingAuthorityPolicy = 'create_fresh' | 'migrate_only' | 'require_existing';
export type SessionBindingAuthorityResult = SessionBindingMutationResult & {
  source: 'created' | 'legacy_copy' | 'existing';
};

export interface InitializeSessionBindingStateInput {
  rootPath: string;
  projectId: string;
}

export interface UpsertAcceptedFoundationBindingInput {
  rootPath: string;
  projectId: string;
  expectedRevision: number;
  sessionId: string;
  agentId: (typeof FOUNDATION_AGENT_IDS)[number];
  threadId: string;
  handoffTurnId: string;
  acceptedAt: string;
  runtimeAuthorityId: string;
  visibility: SessionBindingVisibility;
  attachmentToolState?: 'supported' | 'unsupported';
}

export interface UpsertAcceptedPersistentBindingInput {
  rootPath: string;
  projectId: string;
  expectedRevision: number;
  sessionId: string;
  agentId: string;
  threadId: string;
  handoffTurnId: string;
  acceptedAt: string;
  runtimeAuthorityId: string;
  visibility: SessionBindingVisibility;
  profileId: string;
  requestId: string;
  placementIntentId: string;
  taskId: string;
  attachmentToolState?: 'supported' | 'unsupported';
}

export interface FindAcceptedOwnerBindingInput {
  rootPath: string;
  projectId: string;
  sessionId: string;
  agentId: string;
  profileId: string;
  runtimeAuthorityId: string;
}

export interface FindAcceptedPlacementBindingInput {
  rootPath: string;
  projectId: string;
  requestId: string;
  placementIntentId: string;
  taskId: string;
  agentId: string;
  runtimeAuthorityId: string;
}

export interface TransitionOwnerRotationInput {
  rootPath: string;
  projectId: string;
  expectedRevision: number;
  sessionId: string;
  to: 'rotation_preparing' | 'rotation_pending' | 'rotation_required' | 'draining' | 'checkpointed';
  changedAt: string;
}

export interface StageRotationCandidateInput {
  rootPath: string;
  projectId: string;
  expectedRevision: number;
  predecessorSessionId: string;
  successorSessionId: string;
  successorThreadId: string;
  changedAt: string;
}

export interface VerifyRotationCandidateInput {
  rootPath: string;
  projectId: string;
  expectedRevision: number;
  successorSessionId: string;
  handoffTurnId: string;
  acceptedAt: string;
  runtimeAuthorityId: string;
}

export interface AcceptRotationCandidateInput {
  rootPath: string;
  projectId: string;
  expectedRevision: number;
  successorSessionId: string;
  changedAt: string;
}

export interface FailRotationCandidateInput {
  rootPath: string;
  projectId: string;
  expectedRevision: number;
  successorSessionId: string;
  bindingStatus: 'authority_unverified' | 'conflict';
  changedAt: string;
}

export interface RetryFailedRotationCandidateInput {
  rootPath: string;
  projectId: string;
  expectedRevision: number;
  failedSessionId: string;
  successorSessionId: string;
  successorThreadId: string;
  changedAt: string;
}

export interface RetireOwnerBindingInput {
  rootPath: string;
  projectId: string;
  expectedRevision: number;
  sessionId: string;
  changedAt: string;
}

export class SessionBindingStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SessionBindingStoreError';
    this.code = code;
  }
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new SessionBindingStoreError(code, message, cause === undefined ? undefined : { cause });
}

function cloneState(state: SessionBindingStateV1): SessionBindingStateV1 {
  return structuredClone(state);
}

function comparablePath(value: string): string {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function assertInside(rootPath: string, candidatePath: string): void {
  const relative = path.relative(rootPath, candidatePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    fail('SESSION_BINDING_PATH_ESCAPE', 'session binding path escaped the trusted project root');
  }
}

async function metadata(filePath: string) {
  try {
    return await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function trustedCanonicalRoot(rootPath: string): Promise<string> {
  const requested = path.resolve(rootPath);
  let canonical: string;
  try {
    canonical = await realpath(requested);
  } catch (error) {
    fail('SESSION_BINDING_ROOT_UNAVAILABLE', 'trusted canonical project root does not exist', error);
  }
  if (comparablePath(requested) !== comparablePath(canonical)) {
    fail('SESSION_BINDING_ROOT_NOT_CANONICAL', 'rootPath must be the trusted canonical project root, not an alias or symlink');
  }
  const rootMetadata = await lstat(requested);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    fail('SESSION_BINDING_ROOT_UNSAFE', 'trusted canonical project root must be a real directory');
  }
  return canonical;
}

async function inspectStorageDirectory(canonicalRoot: string, directoryPath: string, create: boolean): Promise<boolean> {
  assertInside(canonicalRoot, directoryPath);
  let details = await metadata(directoryPath);
  if (!details && create) {
    try {
      await mkdir(directoryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    details = await metadata(directoryPath);
  }
  if (!details) return false;
  if (details.isSymbolicLink() || !details.isDirectory()) {
    fail('SESSION_BINDING_PATH_UNSAFE', 'session binding storage boundary must be a real directory');
  }
  const resolved = await realpath(directoryPath);
  if (comparablePath(resolved) !== comparablePath(directoryPath)) {
    fail('SESSION_BINDING_PATH_UNSAFE', 'session binding storage boundary cannot traverse an alias or symlink');
  }
  assertInside(canonicalRoot, resolved);
  return true;
}

async function stateFilePath(canonicalRoot: string, createDirectories: boolean): Promise<string> {
  const orquestaRoot = path.join(canonicalRoot, '.orquesta');
  const stateRoot = projectStoragePath(canonicalRoot, PROJECT_STORAGE.canonicalState);
  const hasOrquestaRoot = await inspectStorageDirectory(canonicalRoot, orquestaRoot, createDirectories);
  if (!hasOrquestaRoot) return projectStoragePath(canonicalRoot, PROJECT_STORAGE.sessionBindings);
  const hasStateRoot = await inspectStorageDirectory(canonicalRoot, stateRoot, createDirectories);
  if (!hasStateRoot) return projectStoragePath(canonicalRoot, PROJECT_STORAGE.sessionBindings);
  return projectStoragePath(canonicalRoot, PROJECT_STORAGE.sessionBindings);
}

function legacySharedStateFilePath(canonicalRoot: string): string {
  return projectStoragePath(canonicalRoot, PROJECT_STORAGE.sessions);
}

async function sessionBindingStagingPath(canonicalRoot: string): Promise<string> {
  const runtimeRoot = projectStoragePath(canonicalRoot, 'runtime');
  const stagingRoot = projectStoragePath(canonicalRoot, SESSION_BINDING_STAGING_RELATIVE);
  await inspectStorageDirectory(canonicalRoot, runtimeRoot, true);
  await inspectStorageDirectory(canonicalRoot, stagingRoot, true);
  return stagingRoot;
}

function ownedArtifactPath(stagingPath: string, nonce: string): string {
  if (!/^[A-Za-z0-9-]{1,128}$/u.test(nonce)) {
    fail('SESSION_BINDING_LOCK_UNVERIFIABLE', 'session binding lock nonce cannot identify a safe staging artifact');
  }
  const artifactPath = path.join(stagingPath, `write-${nonce}.tmp`);
  assertInside(stagingPath, artifactPath);
  return artifactPath;
}

function ownedMetadataCandidatePath(stagingPath: string, kind: 'lock' | 'recovery', nonce: string): string {
  if (!/^[A-Za-z0-9-]{1,128}$/u.test(nonce)) {
    fail('SESSION_BINDING_LOCK_UNVERIFIABLE', 'session binding metadata nonce is not a safe staging identity');
  }
  const candidatePath = path.join(stagingPath, `${kind}-candidate-${nonce}.json`);
  assertInside(stagingPath, candidatePath);
  return candidatePath;
}

function exactKeys(input: object, expected: readonly string[], boundary: string): void {
  const observed = Object.keys(input).sort();
  const canonical = [...expected].sort();
  if (!isDeepStrictEqual(observed, canonical)) {
    fail('SESSION_BINDING_INPUT_INVALID', `${boundary} must contain exactly: ${canonical.join(', ')}`);
  }
}

function exactKeysWithOptional(input: object, expected: readonly string[], optional: string, boundary: string): void {
  const observed = Object.keys(input).sort();
  const without = [...expected].sort();
  const withOptional = [...expected, optional].sort();
  if (!isDeepStrictEqual(observed, without) && !isDeepStrictEqual(observed, withOptional)) {
    fail('SESSION_BINDING_INPUT_INVALID', `${boundary} must contain exactly the canonical fields`);
  }
}

function assertExpectedRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('SESSION_BINDING_REVISION_INVALID', 'expectedRevision must be a nonnegative safe integer');
  }
}

function assertRealUtcTimestamp(value: string, field: string): void {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail('SESSION_BINDING_TIMESTAMP_INVALID', `${field} must be a real canonical UTC timestamp`);
  }
}

function assertCanonicalIdentifier(value: string, field: string, maximumLength: 128 | 256): void {
  const pattern = maximumLength === 128
    ? /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
    : /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
  if (typeof value !== 'string' || !pattern.test(value)) {
    fail('SESSION_BINDING_INPUT_INVALID', `${field} must be a canonical identifier of at most ${maximumLength} characters`);
  }
}

function assertVisibility(value: SessionBindingVisibility): void {
  if (value !== 'codex_task' && value !== 'desktop_only') {
    fail('SESSION_BINDING_INPUT_INVALID', 'visibility must be codex_task or desktop_only');
  }
}

function assertLater(value: string, previous: string, field: string): void {
  assertRealUtcTimestamp(value, field);
  if (value <= previous) {
    fail('SESSION_BINDING_TIMESTAMP_CONFLICT', `${field} must be later than the prior durable transition`);
  }
}

function canonicalSessions(sessions: readonly SessionBindingV1[]): SessionBindingV1[] {
  return structuredClone([...sessions]).sort((left, right) => (
    left.agent_id < right.agent_id ? -1
      : left.agent_id > right.agent_id ? 1
        : left.session_generation - right.session_generation
          || (left.session_id < right.session_id ? -1 : left.session_id > right.session_id ? 1 : 0)
  ));
}

function validState(value: unknown): value is SessionBindingStateV1 {
  return validateContract('session-binding-state-v1', value).ok;
}

function knownLegacySessionState(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.sessions) || record.version !== 1) return false;
  const keys = Object.keys(record).sort();
  if (!Object.hasOwn(record, 'source')) {
    return isDeepStrictEqual(keys, ['sessions', 'version']);
  }
  if (!new Set(['codex_app.list_threads', 'codex_app.thread_list']).has(String(record.source))) return false;
  if (!isDeepStrictEqual(keys, ['project_cwd', 'sessions', 'source', 'synced_at', 'updated_at', 'version'])) return false;
  return typeof record.project_cwd === 'string'
    && typeof record.synced_at === 'string'
    && typeof record.updated_at === 'string';
}

function validateState(value: unknown): SessionBindingStateV1 {
  const validation = validateContract('session-binding-state-v1', value);
  if (!validation.ok) {
    fail(
      'SESSION_BINDING_STATE_INVALID',
      `session binding state failed canonical validation: ${validation.errors.map((item) => `${item.path}:${item.code}`).join(', ')}`
    );
  }
  return value as SessionBindingStateV1;
}

function processState(pid: number): 'live' | 'dead' | 'unverifiable' {
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'unverifiable';
  try {
    process.kill(pid, 0);
    return 'live';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return 'live';
    if (code === 'ESRCH') return 'dead';
    return 'unverifiable';
  }
}

function sameBinding(left: SessionBindingV1, right: SessionBindingV1): boolean {
  return isDeepStrictEqual(left, right);
}

export class SessionBindingStore {
  readonly #renameFile: RenameFile;
  readonly #unlinkFile: UnlinkFile;
  readonly #sleep: Sleep;
  readonly #nonce: () => string;
  readonly #now: () => Date;
  readonly #renameRetries: number;
  readonly #verifyRuntimeAuthority?: VerifyRuntimeAuthority;

  constructor(options: SessionBindingStoreOptions = {}) {
    this.#renameFile = options.renameFile ?? rename;
    this.#unlinkFile = options.unlinkFile ?? unlink;
    this.#sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#nonce = options.nonce ?? randomUUID;
    this.#now = options.now ?? (() => new Date());
    this.#renameRetries = options.renameRetries ?? 5;
    this.#verifyRuntimeAuthority = options.verifyRuntimeAuthority;
  }

  async read(rootPath: string, projectId: string): Promise<SessionBindingReadResult> {
    const canonicalRoot = await trustedCanonicalRoot(rootPath);
    const filePath = await stateFilePath(canonicalRoot, false);
    const current = await this.#readUnlocked(filePath, projectId);
    if (current.status === 'missing') {
      const legacy = await this.#readLegacySharedState(canonicalRoot, projectId);
      if (legacy === null) return current;
      return legacy.status === 'ready'
        ? { status: 'migration_required', filePath: legacy.filePath, reason: 'session_binding_legacy_shared_path' }
        : legacy;
    }
    return current;
  }

  async initializeFresh(input: InitializeSessionBindingStateInput): Promise<SessionBindingMutationResult> {
    exactKeys(input, ['rootPath', 'projectId'], 'initializeFresh input');
    const observed = await this.read(input.rootPath, input.projectId);
    if (observed.status === 'unsupported') this.#unsupported(observed);
    if (observed.status === 'migration_required' && observed.reason !== 'session_binding_legacy_shared_path') {
      this.#migrationRequired(observed);
    }
    const policy: SessionBindingAuthorityPolicy = observed.status === 'ready'
      ? 'require_existing'
      : observed.status === 'migration_required'
        ? 'migrate_only'
        : 'create_fresh';
    const { source: _source, ...result } = await this.ensureAuthority({ ...input, policy });
    return result;
  }

  async ensureAuthority(input: InitializeSessionBindingStateInput & {
    policy: SessionBindingAuthorityPolicy;
  }): Promise<SessionBindingAuthorityResult> {
    exactKeys(input, ['rootPath', 'projectId', 'policy'], 'ensureAuthority input');
    if (!['create_fresh', 'migrate_only', 'require_existing'].includes(input.policy)) {
      fail('SESSION_BINDING_INPUT_INVALID', 'ensureAuthority policy is invalid');
    }
    const canonicalRoot = await trustedCanonicalRoot(input.rootPath);
    const filePath = await stateFilePath(canonicalRoot, true);
    const stagingPath = await sessionBindingStagingPath(canonicalRoot);
    return this.#withLock(filePath, stagingPath, async (lock) => {
      const current = await this.#readUnlocked(filePath, input.projectId);
      if (current.status === 'ready') {
        return { changed: false, source: 'existing', state: current.state };
      }
      if (current.status === 'migration_required') this.#migrationRequired(current);
      if (current.status === 'unsupported') this.#unsupported(current);
      if (input.policy === 'require_existing') {
        fail('SESSION_BINDING_NOT_INITIALIZED', 'session binding state disappeared or was never initialized');
      }
      if (input.policy === 'migrate_only') {
        const migrated = await this.#reconcileLegacySharedState(canonicalRoot, filePath, input.projectId, lock);
        if (migrated === null) fail('SESSION_BINDING_NOT_INITIALIZED', 'expected legacy Session binding authority is unavailable');
        return { changed: true, source: 'legacy_copy', state: migrated };
      }
      const lateLegacy = await this.#readLegacySharedState(canonicalRoot, input.projectId);
      if (lateLegacy !== null) {
        if (lateLegacy.status === 'ready') {
          fail('SESSION_BINDING_AUTHORITY_CHANGED', 'legacy Session binding authority appeared after composition preflight');
        }
        if (lateLegacy.status === 'migration_required') this.#migrationRequired(lateLegacy);
        if (lateLegacy.status === 'unsupported') this.#unsupported(lateLegacy);
      }
      const state = validateState({ schema_version: 1, project_id: input.projectId, revision: 0, sessions: [] });
      await this.#writeAtomic(filePath, state, lock);
      return { changed: true, source: 'created', state: cloneState(state) };
    });
  }

  async upsertAcceptedFoundationBinding(input: UpsertAcceptedFoundationBindingInput): Promise<SessionBindingMutationResult> {
    exactKeysWithOptional(input, [
      'rootPath', 'projectId', 'expectedRevision', 'sessionId', 'agentId', 'threadId',
      'handoffTurnId', 'acceptedAt', 'runtimeAuthorityId', 'visibility'
    ], 'attachmentToolState', 'upsertAcceptedFoundationBinding input');
    if (!FOUNDATION_AGENT_ID_SET.has(input.agentId)) {
      fail('SESSION_BINDING_FOUNDATION_AGENT_INVALID', 'foundation binding agent_id is not canonical');
    }
    return this.#upsertAcceptedBinding({
      ...input,
      profileId: `foundation:${input.agentId}:v1`,
      requestId: null,
      placementIntentId: null,
      taskId: null
    }, true);
  }

  async upsertAcceptedPersistentBinding(input: UpsertAcceptedPersistentBindingInput): Promise<SessionBindingMutationResult> {
    exactKeysWithOptional(input, [
      'rootPath', 'projectId', 'expectedRevision', 'sessionId', 'agentId', 'threadId',
      'handoffTurnId', 'acceptedAt', 'runtimeAuthorityId', 'visibility', 'profileId',
      'requestId', 'placementIntentId', 'taskId'
    ], 'attachmentToolState', 'upsertAcceptedPersistentBinding input');
    return this.#upsertAcceptedBinding(input, false);
  }

  async #upsertAcceptedBinding(input: Omit<UpsertAcceptedPersistentBindingInput,
    'requestId' | 'placementIntentId' | 'taskId'> & {
      requestId: string | null;
      placementIntentId: string | null;
      taskId: string | null;
    }, foundationEntry: boolean): Promise<SessionBindingMutationResult> {
    assertCanonicalIdentifier(input.projectId, 'projectId', 128);
    assertCanonicalIdentifier(input.sessionId, 'sessionId', 128);
    assertCanonicalIdentifier(input.agentId, 'agentId', 128);
    assertCanonicalIdentifier(input.threadId, 'threadId', 256);
    assertCanonicalIdentifier(input.handoffTurnId, 'handoffTurnId', 256);
    assertCanonicalIdentifier(input.runtimeAuthorityId, 'runtimeAuthorityId', 256);
    assertCanonicalIdentifier(input.profileId, 'profileId', 256);
    const reservedFoundation = FOUNDATION_AGENT_ID_SET.has(input.agentId);
    if (foundationEntry) {
      if (!reservedFoundation || input.profileId !== `foundation:${input.agentId}:v1`) {
        fail('SESSION_BINDING_FOUNDATION_AGENT_INVALID', 'foundation binding identity is not canonical');
      }
      if (input.requestId !== null || input.placementIntentId !== null || input.taskId !== null) {
        fail('SESSION_BINDING_INPUT_INVALID', 'foundation bindings cannot claim placement provenance');
      }
    } else {
      if (reservedFoundation) {
        fail('SESSION_BINDING_FOUNDATION_AGENT_RESERVED', `agentId ${input.agentId} must use the foundation binding entry point`);
      }
      if (input.profileId.startsWith('foundation:')) {
        fail('SESSION_BINDING_FOUNDATION_PROFILE_RESERVED', 'foundation profile namespace is reserved');
      }
      assertCanonicalIdentifier(input.requestId as string, 'requestId', 256);
      assertCanonicalIdentifier(input.placementIntentId as string, 'placementIntentId', 128);
      if (!/^PI-[a-f0-9]{12}$/u.test(input.placementIntentId as string)) {
        fail('SESSION_BINDING_INPUT_INVALID', 'placementIntentId must be a canonical placement identity');
      }
      assertCanonicalIdentifier(input.taskId as string, 'taskId', 128);
    }
    assertVisibility(input.visibility);
    assertRealUtcTimestamp(input.acceptedAt, 'acceptedAt');
    const runtimeGuard = this.#runtimeAuthorityGuard(input.projectId, input.runtimeAuthorityId);
    if (input.attachmentToolState !== undefined
      && !['supported', 'unsupported'].includes(input.attachmentToolState)) {
      fail('SESSION_BINDING_INPUT_INVALID', 'attachmentToolState is invalid');
    }
    const record: SessionBindingV1 & { attachment_tool_state: 'supported' | 'unsupported' } = {
      session_id: input.sessionId,
      agent_id: input.agentId,
      thread_id: input.threadId,
      session_generation: 1,
      session_kind: 'persistent_agent',
      attachment_tool_state: input.attachmentToolState ?? 'unsupported',
      handoff_status: 'accepted',
      handoff_turn_id: input.handoffTurnId,
      accepted_at: input.acceptedAt,
      rotation_state: 'active',
      ownership_status: 'owner',
      accepts_new_work: true,
      binding_status: 'bound',
      replaces_session_id: null,
      retry_of_session_id: null,
      replaced_by_session_id: null,
      visibility: input.visibility,
      profile_id: input.profileId,
      runtime_authority_id: input.runtimeAuthorityId,
      provisioning_request_id: input.requestId,
      placement_intent_id: input.placementIntentId,
      task_id: input.taskId,
      ownership_started_at: input.acceptedAt,
      ownership_ended_at: null,
      created_at: input.acceptedAt,
      updated_at: input.acceptedAt
    };
    return this.#mutate(input, (state) => {
      const existing = state.sessions.find((session) => session.session_id === record.session_id);
      if (existing) {
        if (sameBinding(existing, record)) return null;
        fail('SESSION_BINDING_CONFLICT', `session_id ${record.session_id} already has different binding evidence`);
      }
      if (record.provisioning_request_id !== null && state.sessions.some((session) => (
        session.provisioning_request_id === record.provisioning_request_id
        && session.session_generation === 1
        && session.replaces_session_id === null
      ))) {
        fail('SESSION_BINDING_REQUEST_CONFLICT', `request_id ${record.provisioning_request_id} already created another persistent session`);
      }
      if (record.task_id !== null && state.sessions.some((session) => (
        session.task_id === record.task_id
        && session.session_generation === 1
        && session.replaces_session_id === null
      ))) {
        fail('SESSION_BINDING_TASK_CONFLICT', `task_id ${record.task_id} already created another persistent session`);
      }
      this.#assertSessionIdentityAvailable(state, record);
      const existingAuthorities = new Set(state.sessions.filter((session) => session.handoff_status === 'accepted'
        && session.binding_status === 'bound'
        && !['superseded', 'failed', 'retired'].includes(session.rotation_state))
        .map((session) => session.runtime_authority_id));
      if (existingAuthorities.has(null) || existingAuthorities.size > 1
        || (existingAuthorities.size === 1 && !existingAuthorities.has(record.runtime_authority_id))) {
        fail('SESSION_BINDING_RUNTIME_AUTHORITY_CONFLICT', 'accepted binding would split project runtime authority');
      }
      if (state.sessions.some((session) => session.agent_id === record.agent_id && session.ownership_status === 'owner')) {
        fail('SESSION_BINDING_OWNER_CONFLICT', `agent ${record.agent_id} already has a current owner`);
      }
      return [...state.sessions, record];
    }, runtimeGuard);
  }

  async findAcceptedOwnerBinding(input: FindAcceptedOwnerBindingInput): Promise<SessionBindingV1 | null> {
    exactKeys(input, [
      'rootPath', 'projectId', 'sessionId', 'agentId', 'profileId', 'runtimeAuthorityId'
    ], 'findAcceptedOwnerBinding input');
    assertCanonicalIdentifier(input.projectId, 'projectId', 128);
    assertCanonicalIdentifier(input.sessionId, 'sessionId', 128);
    assertCanonicalIdentifier(input.agentId, 'agentId', 128);
    assertCanonicalIdentifier(input.profileId, 'profileId', 256);
    assertCanonicalIdentifier(input.runtimeAuthorityId, 'runtimeAuthorityId', 256);
    const result = await this.read(input.rootPath, input.projectId);
    if (result.status === 'missing') return null;
    if (result.status === 'migration_required') this.#migrationRequired(result);
    if (result.status === 'unsupported') this.#unsupported(result);
    const binding = result.state.sessions.find((session) => session.session_id === input.sessionId
      && session.agent_id === input.agentId
      && session.profile_id === input.profileId
      && session.runtime_authority_id === input.runtimeAuthorityId
      && session.handoff_status === 'accepted'
      && session.binding_status === 'bound'
      && session.ownership_status === 'owner'
      && session.rotation_state === 'active'
      && session.accepts_new_work);
    return binding === undefined ? null : structuredClone(binding);
  }

  async findAcceptedPlacementBinding(input: FindAcceptedPlacementBindingInput): Promise<SessionBindingV1 | null> {
    exactKeys(input, [
      'rootPath', 'projectId', 'requestId', 'placementIntentId', 'taskId', 'agentId', 'runtimeAuthorityId'
    ], 'findAcceptedPlacementBinding input');
    assertCanonicalIdentifier(input.projectId, 'projectId', 128);
    assertCanonicalIdentifier(input.requestId, 'requestId', 256);
    assertCanonicalIdentifier(input.placementIntentId, 'placementIntentId', 128);
    if (!/^PI-[a-f0-9]{12}$/u.test(input.placementIntentId)) {
      fail('SESSION_BINDING_INPUT_INVALID', 'placementIntentId must be a canonical placement identity');
    }
    assertCanonicalIdentifier(input.taskId, 'taskId', 128);
    assertCanonicalIdentifier(input.agentId, 'agentId', 128);
    assertCanonicalIdentifier(input.runtimeAuthorityId, 'runtimeAuthorityId', 256);
    const result = await this.read(input.rootPath, input.projectId);
    if (result.status === 'missing') return null;
    if (result.status === 'migration_required') this.#migrationRequired(result);
    if (result.status === 'unsupported') this.#unsupported(result);
    const matches = result.state.sessions.filter((session) => session.provisioning_request_id === input.requestId
      && session.placement_intent_id === input.placementIntentId
      && session.task_id === input.taskId
      && session.agent_id === input.agentId
      && session.runtime_authority_id === input.runtimeAuthorityId
      && session.handoff_status === 'accepted'
      && session.binding_status === 'bound'
      && session.ownership_status === 'owner'
      && session.rotation_state === 'active'
      && session.accepts_new_work);
    if (matches.length > 1) {
      fail('SESSION_BINDING_ACCEPTED_OWNER_AMBIGUOUS', 'placement request resolves to multiple active owner sessions');
    }
    return matches.length === 0 ? null : structuredClone(matches[0]);
  }

  async transitionOwnerRotation(input: TransitionOwnerRotationInput): Promise<SessionBindingMutationResult> {
    exactKeys(input, ['rootPath', 'projectId', 'expectedRevision', 'sessionId', 'to', 'changedAt'], 'transitionOwnerRotation input');
    return this.#mutate(input, (state) => {
      const current = state.sessions.find((session) => session.session_id === input.sessionId);
      if (!current || current.ownership_status !== 'owner') {
        fail('SESSION_BINDING_OWNER_NOT_FOUND', `current owner session ${input.sessionId} was not found`);
      }
      if (current.rotation_state === input.to) {
        if (current.updated_at === input.changedAt) return null;
        fail('SESSION_BINDING_DUPLICATE_EVIDENCE_CONFLICT', 'rotation transition already exists with a different timestamp');
      }
      if (!(OWNER_TRANSITIONS[current.rotation_state] ?? []).includes(input.to)) {
        fail('SESSION_BINDING_ROTATION_TRANSITION_INVALID', `${current.rotation_state} cannot transition to ${input.to}`);
      }
      assertLater(input.changedAt, current.updated_at, 'changedAt');
      return state.sessions.map((session) => session.session_id === current.session_id
        ? {
            ...session,
            rotation_state: input.to,
            accepts_new_work: OWNER_ACCEPTING_STATES.has(input.to),
            updated_at: input.changedAt
          }
        : session);
    });
  }

  async stageRotationCandidate(input: StageRotationCandidateInput): Promise<SessionBindingMutationResult> {
    exactKeys(input, [
      'rootPath', 'projectId', 'expectedRevision', 'predecessorSessionId', 'successorSessionId',
      'successorThreadId', 'changedAt'
    ], 'stageRotationCandidate input');
    return this.#mutate(input, (state) => {
      const predecessor = state.sessions.find((session) => session.session_id === input.predecessorSessionId);
      if (!predecessor || predecessor.ownership_status !== 'owner' || predecessor.rotation_state !== 'checkpointed') {
        fail('SESSION_BINDING_PREDECESSOR_NOT_CHECKPOINTED', 'rotation successor requires the checkpointed current owner');
      }
      const generation = predecessor.session_generation + 1;
      const existing = state.sessions.find((session) => session.session_id === input.successorSessionId);
      if (existing) {
        if (existing.agent_id === predecessor.agent_id
          && existing.thread_id === input.successorThreadId
          && existing.session_generation === generation
          && existing.rotation_state === 'successor_warming'
          && existing.replaces_session_id === predecessor.session_id
          && existing.created_at === input.changedAt
          && existing.updated_at === input.changedAt) return null;
        fail('SESSION_BINDING_CONFLICT', `successor session_id ${input.successorSessionId} already has different evidence`);
      }
      assertLater(input.changedAt, predecessor.updated_at, 'changedAt');
      const successor: SessionBindingV1 & { attachment_tool_state: 'unsupported' } = {
        session_id: input.successorSessionId,
        agent_id: predecessor.agent_id,
        thread_id: input.successorThreadId,
        session_generation: generation,
        session_kind: 'persistent_agent',
        attachment_tool_state: 'unsupported',
        handoff_status: 'pending',
        handoff_turn_id: null,
        accepted_at: null,
        rotation_state: 'successor_warming',
        ownership_status: 'candidate',
        accepts_new_work: false,
        binding_status: 'provisioning',
        replaces_session_id: predecessor.session_id,
        retry_of_session_id: null,
        replaced_by_session_id: null,
        visibility: predecessor.visibility,
        profile_id: `session-rotation:${predecessor.agent_id}:generation-${generation}`,
        runtime_authority_id: null,
        provisioning_request_id: predecessor.provisioning_request_id,
        placement_intent_id: predecessor.placement_intent_id,
        task_id: predecessor.task_id,
        ownership_started_at: null,
        ownership_ended_at: null,
        created_at: input.changedAt,
        updated_at: input.changedAt
      };
      this.#assertSessionIdentityAvailable(state, successor);
      if (state.sessions.some((session) => session.agent_id === predecessor.agent_id && session.ownership_status === 'candidate')) {
        fail('SESSION_BINDING_CANDIDATE_CONFLICT', `agent ${predecessor.agent_id} already has a rotation candidate`);
      }
      return [...state.sessions, successor];
    });
  }

  async verifyRotationCandidate(input: VerifyRotationCandidateInput): Promise<SessionBindingMutationResult> {
    exactKeys(input, [
      'rootPath', 'projectId', 'expectedRevision', 'successorSessionId', 'handoffTurnId',
      'acceptedAt', 'runtimeAuthorityId'
    ], 'verifyRotationCandidate input');
    assertRealUtcTimestamp(input.acceptedAt, 'acceptedAt');
    const runtimeGuard = this.#runtimeAuthorityGuard(input.projectId, input.runtimeAuthorityId);
    return this.#mutate(input, (state) => {
      const candidate = state.sessions.find((session) => session.session_id === input.successorSessionId);
      if (!candidate || candidate.ownership_status !== 'candidate') {
        fail('SESSION_BINDING_CANDIDATE_NOT_FOUND', `rotation candidate ${input.successorSessionId} was not found`);
      }
      if (candidate.rotation_state === 'successor_verified') {
        if (candidate.handoff_turn_id === input.handoffTurnId
          && candidate.accepted_at === input.acceptedAt
          && candidate.runtime_authority_id === input.runtimeAuthorityId) return null;
        fail('SESSION_BINDING_ACCEPTANCE_CONFLICT', 'verified successor has different handoff evidence');
      }
      if (candidate.rotation_state !== 'successor_warming' || candidate.replaces_session_id === null) {
        fail('SESSION_BINDING_ROTATION_TRANSITION_INVALID', 'only a warming successor can be verified');
      }
      const predecessor = state.sessions.find((session) => session.session_id === candidate.replaces_session_id);
      if (!predecessor || predecessor.ownership_status !== 'owner' || predecessor.rotation_state !== 'checkpointed') {
        fail('SESSION_BINDING_PREDECESSOR_NOT_CHECKPOINTED', 'verified successor must retain a checkpointed predecessor owner');
      }
      if (predecessor.runtime_authority_id !== input.runtimeAuthorityId) {
        fail('SESSION_BINDING_RUNTIME_AUTHORITY_CONFLICT', 'successor runtime authority differs from its predecessor');
      }
      assertLater(input.acceptedAt, candidate.updated_at, 'acceptedAt');
      return state.sessions.map((session) => session.session_id === candidate.session_id
        ? {
            ...session,
            handoff_status: 'accepted',
            handoff_turn_id: input.handoffTurnId,
            accepted_at: input.acceptedAt,
            rotation_state: 'successor_verified',
            binding_status: 'bound',
            runtime_authority_id: input.runtimeAuthorityId,
            updated_at: input.acceptedAt
          }
        : session);
    }, runtimeGuard);
  }

  async acceptRotationCandidate(input: AcceptRotationCandidateInput): Promise<SessionBindingMutationResult> {
    exactKeys(input, ['rootPath', 'projectId', 'expectedRevision', 'successorSessionId', 'changedAt'], 'acceptRotationCandidate input');
    return this.#mutate(input, (state) => {
      const candidate = state.sessions.find((session) => session.session_id === input.successorSessionId);
      if (!candidate) fail('SESSION_BINDING_CANDIDATE_NOT_FOUND', `rotation candidate ${input.successorSessionId} was not found`);
      if (candidate.ownership_status === 'owner' && candidate.rotation_state === 'active') {
        const predecessor = candidate.replaces_session_id === null
          ? null
          : state.sessions.find((session) => session.session_id === candidate.replaces_session_id);
        if (predecessor?.ownership_status === 'superseded'
          && predecessor.replaced_by_session_id === candidate.session_id
          && predecessor.ownership_ended_at === input.changedAt
          && candidate.ownership_started_at === input.changedAt) return null;
        if (predecessor?.ownership_status === 'superseded' && predecessor.replaced_by_session_id === candidate.session_id) {
          fail('SESSION_BINDING_DUPLICATE_EVIDENCE_CONFLICT', 'cutover already exists with a different timestamp');
        }
      }
      if (candidate.ownership_status !== 'candidate'
        || candidate.rotation_state !== 'successor_verified'
        || candidate.replaces_session_id === null) {
        fail('SESSION_BINDING_ROTATION_TRANSITION_INVALID', 'only a verified successor can become owner');
      }
      const predecessor = state.sessions.find((session) => session.session_id === candidate.replaces_session_id);
      if (!predecessor || predecessor.ownership_status !== 'owner' || predecessor.rotation_state !== 'checkpointed') {
        fail('SESSION_BINDING_PREDECESSOR_NOT_CHECKPOINTED', 'candidate cutover requires its checkpointed predecessor owner');
      }
      if (predecessor.agent_id !== candidate.agent_id || predecessor.runtime_authority_id !== candidate.runtime_authority_id) {
        fail('SESSION_BINDING_ROTATION_AUTHORITY_CONFLICT', 'candidate cannot take ownership across agent or runtime authority');
      }
      assertLater(input.changedAt, predecessor.updated_at > candidate.updated_at ? predecessor.updated_at : candidate.updated_at, 'changedAt');
      return state.sessions.map((session) => {
        if (session.session_id === predecessor.session_id) {
          return {
            ...session,
            rotation_state: 'superseded',
            ownership_status: 'superseded',
            accepts_new_work: false,
            replaced_by_session_id: candidate.session_id,
            ownership_ended_at: input.changedAt,
            updated_at: input.changedAt
          };
        }
        if (session.session_id === candidate.session_id) {
          return {
            ...session,
            rotation_state: 'active',
            ownership_status: 'owner',
            accepts_new_work: true,
            ownership_started_at: input.changedAt,
            updated_at: input.changedAt
          };
        }
        return session;
      });
    });
  }

  async failRotationCandidate(input: FailRotationCandidateInput): Promise<SessionBindingMutationResult> {
    exactKeys(input, [
      'rootPath', 'projectId', 'expectedRevision', 'successorSessionId', 'bindingStatus', 'changedAt'
    ], 'failRotationCandidate input');
    return this.#mutate(input, (state) => {
      const candidate = state.sessions.find((session) => session.session_id === input.successorSessionId);
      if (!candidate || candidate.ownership_status !== 'candidate') {
        fail('SESSION_BINDING_CANDIDATE_NOT_FOUND', `rotation candidate ${input.successorSessionId} was not found`);
      }
      if (candidate.rotation_state === 'failed') {
        if (candidate.binding_status === input.bindingStatus && candidate.updated_at === input.changedAt) return null;
        if (candidate.binding_status === input.bindingStatus) {
          fail('SESSION_BINDING_DUPLICATE_EVIDENCE_CONFLICT', 'failed candidate already exists with a different timestamp');
        }
        fail('SESSION_BINDING_FAILURE_CONFLICT', 'failed successor has different failure classification');
      }
      if (candidate.rotation_state !== 'successor_warming' || candidate.replaces_session_id === null) {
        fail('SESSION_BINDING_ROTATION_TRANSITION_INVALID', 'only an unaccepted warming successor can fail');
      }
      assertLater(input.changedAt, candidate.updated_at, 'changedAt');
      return state.sessions.map((session) => session.session_id === candidate.session_id
        ? {
            ...session,
            handoff_status: 'failed',
            handoff_turn_id: null,
            accepted_at: null,
            rotation_state: 'failed',
            binding_status: input.bindingStatus,
            runtime_authority_id: null,
            accepts_new_work: false,
            updated_at: input.changedAt
          }
        : session);
    });
  }

  async retryFailedRotationCandidate(input: RetryFailedRotationCandidateInput): Promise<SessionBindingMutationResult> {
    exactKeys(input, [
      'rootPath', 'projectId', 'expectedRevision', 'failedSessionId', 'successorSessionId',
      'successorThreadId', 'changedAt'
    ], 'retryFailedRotationCandidate input');
    return this.#mutate(input, (state) => {
      const failedCandidate = state.sessions.find((session) => session.session_id === input.failedSessionId);
      if (!failedCandidate
        || failedCandidate.rotation_state !== 'failed'
        || failedCandidate.ownership_status !== 'candidate'
        || failedCandidate.replaces_session_id === null) {
        fail('SESSION_BINDING_FAILED_CANDIDATE_NOT_FOUND', 'retry requires the failed successor snapshot');
      }
      const predecessor = state.sessions.find((session) => session.session_id === failedCandidate.replaces_session_id);
      if (!predecessor || predecessor.ownership_status !== 'owner' || predecessor.rotation_state !== 'checkpointed') {
        fail('SESSION_BINDING_PREDECESSOR_NOT_CHECKPOINTED', 'retry must retain the checkpointed predecessor owner');
      }
      const existingRetry = state.sessions.find((session) => session.session_id === input.successorSessionId);
      if (existingRetry) {
        if (existingRetry.agent_id === failedCandidate.agent_id
          && existingRetry.session_generation === failedCandidate.session_generation
          && existingRetry.thread_id === input.successorThreadId
          && existingRetry.replaces_session_id === failedCandidate.replaces_session_id
          && existingRetry.retry_of_session_id === failedCandidate.session_id
          && existingRetry.rotation_state === 'successor_warming'
          && existingRetry.ownership_status === 'candidate') return null;
        fail('SESSION_BINDING_RETRY_ALREADY_APPLIED', `retry session_id ${input.successorSessionId} already exists with different failed-attempt binding`);
      }
      if (state.sessions.some((session) => session.retry_of_session_id === failedCandidate.session_id)) {
        fail('SESSION_BINDING_RETRY_SOURCE_STALE', `failed attempt ${failedCandidate.session_id} already has a direct retry`);
      }
      assertLater(input.changedAt, failedCandidate.updated_at > predecessor.updated_at
        ? failedCandidate.updated_at : predecessor.updated_at, 'changedAt');
      const retry: SessionBindingV1 & { attachment_tool_state: 'unsupported' } = {
        ...failedCandidate,
        attachment_tool_state: 'unsupported',
        session_id: input.successorSessionId,
        thread_id: input.successorThreadId,
        handoff_status: 'pending',
        rotation_state: 'successor_warming',
        binding_status: 'provisioning',
        runtime_authority_id: null,
        retry_of_session_id: failedCandidate.session_id,
        created_at: input.changedAt,
        updated_at: input.changedAt
      };
      this.#assertSessionIdentityAvailable(state, retry);
      return [...state.sessions, retry];
    });
  }

  async retireOwnerBinding(input: RetireOwnerBindingInput): Promise<SessionBindingMutationResult> {
    exactKeys(input, ['rootPath', 'projectId', 'expectedRevision', 'sessionId', 'changedAt'], 'retireOwnerBinding input');
    return this.#mutate(input, (state) => {
      const owner = state.sessions.find((session) => session.session_id === input.sessionId);
      if (!owner) fail('SESSION_BINDING_OWNER_NOT_FOUND', `owner session ${input.sessionId} was not found`);
      if (owner.rotation_state === 'retired' && owner.ownership_status === 'retired') {
        if (owner.ownership_ended_at === input.changedAt) return null;
        fail('SESSION_BINDING_RETIREMENT_CONFLICT', 'retired binding has different terminal evidence');
      }
      if (owner.ownership_status !== 'owner'
        || !['active', 'rotation_preparing', 'rotation_pending', 'rotation_required', 'draining', 'checkpointed'].includes(owner.rotation_state)) {
        fail('SESSION_BINDING_OWNER_NOT_FOUND', `session ${input.sessionId} is not a current owner`);
      }
      if (state.sessions.some((session) => session.replaces_session_id === owner.session_id
        && ['successor_warming', 'successor_verified'].includes(session.rotation_state))) {
        fail('SESSION_BINDING_RETIREMENT_PENDING_ROTATION', 'owner cannot retire while a live successor candidate exists');
      }
      assertLater(input.changedAt, owner.updated_at, 'changedAt');
      return state.sessions.map((session) => session.session_id === owner.session_id
        ? {
            ...session,
            rotation_state: 'retired',
            ownership_status: 'retired',
            accepts_new_work: false,
            ownership_ended_at: input.changedAt,
            updated_at: input.changedAt
          }
        : session);
    });
  }

  async #mutate(
    input: { rootPath: string; projectId: string; expectedRevision: number },
    update: (state: SessionBindingStateV1) => SessionBindingV1[] | null,
    guard?: MutationGuard
  ): Promise<SessionBindingMutationResult> {
    assertExpectedRevision(input.expectedRevision);
    const canonicalRoot = await trustedCanonicalRoot(input.rootPath);
    const filePath = await stateFilePath(canonicalRoot, false);
    const preflight = await this.#readUnlocked(filePath, input.projectId);
    if (preflight.status === 'missing') fail('SESSION_BINDING_NOT_INITIALIZED', 'session binding state requires explicit initialization');
    if (preflight.status === 'migration_required') this.#migrationRequired(preflight);
    if (preflight.status === 'unsupported') this.#unsupported(preflight);
    const stagingPath = await sessionBindingStagingPath(canonicalRoot);
    return this.#withLock(filePath, stagingPath, async (lock) => {
      const current = await this.#readUnlocked(filePath, input.projectId);
      if (current.status === 'missing') fail('SESSION_BINDING_NOT_INITIALIZED', 'session binding state disappeared before mutation');
      if (current.status === 'migration_required') this.#migrationRequired(current);
      if (current.status === 'unsupported') this.#unsupported(current);
      await guard?.(canonicalRoot);
      const sessions = update(cloneState(current.state));
      if (sessions === null) return { changed: false, state: cloneState(current.state) };
      if (current.state.revision !== input.expectedRevision) {
        fail('SESSION_BINDING_REVISION_CONFLICT', `expected revision ${input.expectedRevision}, observed ${current.state.revision}`);
      }
      const next = validateState({
        schema_version: 1,
        project_id: current.state.project_id,
        revision: current.state.revision + 1,
        sessions: canonicalSessions(sessions)
      });
      await this.#writeAtomic(filePath, next, lock);
      return { changed: true, state: cloneState(next) };
    });
  }

  #runtimeAuthorityGuard(projectId: string, runtimeAuthorityId: string): MutationGuard {
    if (this.#verifyRuntimeAuthority === undefined) {
      fail('SESSION_BINDING_RUNTIME_AUTHORITY_VERIFIER_REQUIRED', 'accepted binding writes require a runtime authority verifier');
    }
    return async (canonicalRoot) => this.#verifyRuntimeAuthority?.({
      rootPath: canonicalRoot,
      projectId,
      runtimeAuthorityId
    });
  }

  #assertSessionIdentityAvailable(state: SessionBindingStateV1, incoming: SessionBindingV1): void {
    if (state.sessions.some((session) => session.agent_id === incoming.agent_id
      && session.session_generation === incoming.session_generation
      && session.rotation_state !== 'failed')) {
      fail('SESSION_BINDING_GENERATION_CONFLICT', `agent ${incoming.agent_id} generation ${incoming.session_generation} already exists`);
    }
    if (incoming.thread_id !== null && state.sessions.some((session) => session.thread_id === incoming.thread_id)) {
      fail('SESSION_BINDING_THREAD_CONFLICT', `thread ${incoming.thread_id} is already bound`);
    }
  }

  async #readUnlocked(filePath: string, projectId: string): Promise<SessionBindingReadResult> {
    const details = await metadata(filePath);
    if (!details) return { status: 'missing', filePath };
    if (details.isSymbolicLink()) fail('SESSION_BINDING_PATH_UNSAFE', 'sessions.json cannot be a symbolic link');
    if (!details.isFile()) return { status: 'unsupported', filePath, reason: 'session_binding_state_not_file' };
    let value: unknown;
    try {
      value = JSON.parse(await readFile(filePath, 'utf8'));
    } catch {
      return { status: 'unsupported', filePath, reason: 'session_binding_state_malformed' };
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { status: 'unsupported', filePath, reason: 'session_binding_state_corrupt' };
    }
    const version = (value as { schema_version?: unknown }).schema_version;
    if (version !== 1 && knownLegacySessionState(value)) {
      return { status: 'migration_required', filePath, reason: 'session_binding_state_legacy_version' };
    }
    if (version !== 1) return { status: 'unsupported', filePath, reason: 'session_binding_state_unsupported_version' };
    if (!validState(value)) return { status: 'unsupported', filePath, reason: 'session_binding_state_contract_invalid' };
    if (value.project_id !== projectId) return { status: 'unsupported', filePath, reason: 'session_binding_foreign_project' };
    return { status: 'ready', filePath, state: cloneState(value) };
  }

  async #readLegacySharedState(
    canonicalRoot: string,
    projectId: string,
    ignoreNonBindingAuthority = false
  ): Promise<SessionBindingReadResult | null> {
    const legacyPath = legacySharedStateFilePath(canonicalRoot);
    const details = await metadata(legacyPath);
    if (!details) return null;
    if (details.isSymbolicLink() || !details.isFile()) {
      if (ignoreNonBindingAuthority) return null;
      return { status: 'unsupported', filePath: legacyPath, reason: 'legacy_shared_session_state_ambiguous' };
    }
    let value: unknown;
    try {
      value = JSON.parse(await readFile(legacyPath, 'utf8'));
    } catch {
      if (ignoreNonBindingAuthority) return null;
      return { status: 'unsupported', filePath: legacyPath, reason: 'legacy_shared_session_state_ambiguous' };
    }
    if (knownLegacySessionState(value)) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || (value as { schema_version?: unknown }).schema_version !== 1) {
      if (ignoreNonBindingAuthority) return null;
      return { status: 'unsupported', filePath: legacyPath, reason: 'legacy_shared_session_state_ambiguous' };
    }
    const observed = await this.#readUnlocked(legacyPath, projectId);
    return ignoreNonBindingAuthority && observed.status !== 'ready' ? null : observed;
  }

  async #reconcileLegacySharedState(
    canonicalRoot: string,
    destinationPath: string,
    projectId: string,
    lock: HeldLock
  ): Promise<SessionBindingStateV1 | null> {
    const legacy = await this.#readLegacySharedState(canonicalRoot, projectId);
    if (legacy === null) return null;
    if (legacy.status === 'migration_required') this.#migrationRequired(legacy);
    if (legacy.status === 'unsupported') this.#unsupported(legacy);
    if (legacy.status === 'missing') return null;
    if (await metadata(destinationPath)) {
      fail('SESSION_BINDING_STATE_UNSUPPORTED', 'Session binding migration destination appeared while the authority lock was held');
    }
    await this.#writeAtomic(destinationPath, legacy.state, lock);
    const migrated = await this.#readUnlocked(destinationPath, projectId);
    if (migrated.status !== 'ready' || !isDeepStrictEqual(migrated.state, legacy.state)) {
      fail('SESSION_BINDING_STATE_UNSUPPORTED', 'Session binding shared-path migration did not preserve canonical state');
    }
    return cloneState(migrated.state);
  }

  #migrationRequired(result: Extract<SessionBindingReadResult, { status: 'migration_required' }>): never {
    fail('SESSION_BINDING_MIGRATION_REQUIRED', `${result.reason}: ${result.filePath}`);
  }

  #unsupported(result: Extract<SessionBindingReadResult, { status: 'unsupported' }>): never {
    fail('SESSION_BINDING_STATE_UNSUPPORTED', `${result.reason}: ${result.filePath}`);
  }

  async #acquireLock(filePath: string, stagingPath: string): Promise<HeldLock> {
    const lockPath = path.join(stagingPath, 'sessions-json.lock');
    const recoveryPath = `${lockPath}.recovery`;
    for (let recoveryAttempt = 0; recoveryAttempt < 2; recoveryAttempt += 1) {
      await this.#cleanupOrphanMetadataCandidates(stagingPath);
      await this.#clearAbandonedRecovery(lockPath, recoveryPath, filePath, stagingPath);
      const nonce = this.#nonce();
      const artifactPath = ownedArtifactPath(stagingPath, nonce);
      const metadataCandidatePath = ownedMetadataCandidatePath(stagingPath, 'lock', nonce);
      const lock: LockMetadata = {
        schema_version: 1,
        pid: process.pid,
        nonce,
        target_path: filePath,
        artifact_path: artifactPath,
        metadata_candidate_path: metadataCandidatePath,
        acquired_at: this.#now().toISOString()
      };
      try {
        await this.#publishExclusiveMetadata(lockPath, metadataCandidatePath, lock);
        if ((await lstat(lockPath)).isSymbolicLink()) fail('SESSION_BINDING_LOCK_UNSAFE', 'session binding lock cannot be a symlink');
        return { lockPath, nonce, artifactPath, metadataCandidatePath };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          fail('SESSION_BINDING_LOCK_UNAVAILABLE', 'could not acquire the sessions.json process lock', error);
        }
      }

      const observed = await this.#verifiedLock(lockPath, filePath, stagingPath);
      const age = this.#now().getTime() - Date.parse(observed.acquired_at);
      const ownerState = processState(observed.pid);
      if (ownerState === 'dead' && age >= LOCK_STALE_AFTER_MS) {
        await this.#recoverDeadLock(lockPath, recoveryPath, filePath, stagingPath, observed);
        continue;
      }
      if (ownerState === 'live' && age >= 0 && age < LOCK_STALE_AFTER_MS) {
        fail('SESSION_BINDING_LOCK_HELD', 'sessions.json is locked by another live process');
      }
      fail('SESSION_BINDING_LOCK_STALE_UNVERIFIED', 'stale or unverifiable sessions.json lock requires manual recovery');
    }
    fail('SESSION_BINDING_LOCK_UNAVAILABLE', 'sessions.json lock recovery did not reach a unique owner');
  }

  async #verifiedLock(lockPath: string, filePath: string, stagingPath: string): Promise<LockMetadata> {
    const lockDetails = await metadata(lockPath);
    if (!lockDetails || lockDetails.isSymbolicLink() || !lockDetails.isFile()) {
      fail('SESSION_BINDING_LOCK_UNVERIFIABLE', 'existing sessions.json lock identity is unverifiable');
    }
    let observed: Partial<LockMetadata>;
    try {
      observed = JSON.parse(await readFile(lockPath, 'utf8')) as Partial<LockMetadata>;
    } catch {
      fail('SESSION_BINDING_LOCK_UNVERIFIABLE', 'existing sessions.json lock cannot be parsed');
    }
    if (!isDeepStrictEqual(Object.keys(observed).sort(), ['acquired_at', 'artifact_path', 'metadata_candidate_path', 'nonce', 'pid', 'schema_version', 'target_path'])
      || observed.schema_version !== 1
      || !Number.isSafeInteger(observed.pid) || Number(observed.pid) <= 0
      || typeof observed.nonce !== 'string' || !observed.nonce
      || observed.target_path !== filePath
      || observed.artifact_path !== ownedArtifactPath(stagingPath, String(observed.nonce))
      || observed.metadata_candidate_path !== ownedMetadataCandidatePath(stagingPath, 'lock', String(observed.nonce))
      || typeof observed.acquired_at !== 'string'
      || !Number.isFinite(Date.parse(observed.acquired_at))) {
      fail('SESSION_BINDING_LOCK_UNVERIFIABLE', 'existing sessions.json lock metadata is incomplete');
    }
    return observed as LockMetadata;
  }

  async #clearAbandonedRecovery(
    lockPath: string,
    recoveryPath: string,
    filePath: string,
    stagingPath: string
  ): Promise<void> {
    const details = await metadata(recoveryPath);
    if (!details) return;
    if (details.isSymbolicLink() || !details.isFile()) {
      fail('SESSION_BINDING_LOCK_UNVERIFIABLE', 'session binding recovery claim is unsafe');
    }
    let claim: Partial<RecoveryMetadata>;
    try {
      claim = JSON.parse(await readFile(recoveryPath, 'utf8')) as Partial<RecoveryMetadata>;
    } catch {
      fail('SESSION_BINDING_LOCK_UNVERIFIABLE', 'session binding recovery claim cannot be parsed');
    }
    if (!isDeepStrictEqual(Object.keys(claim).sort(), ['acquired_at', 'artifact_path', 'metadata_candidate_path', 'nonce', 'observed_lock_nonce', 'pid', 'schema_version', 'target_path'])
      || claim.schema_version !== 1
      || !Number.isSafeInteger(claim.pid) || Number(claim.pid) <= 0
      || typeof claim.nonce !== 'string' || !claim.nonce
      || typeof claim.observed_lock_nonce !== 'string' || !claim.observed_lock_nonce
      || claim.target_path !== filePath
      || claim.artifact_path !== ownedArtifactPath(stagingPath, String(claim.observed_lock_nonce))
      || claim.metadata_candidate_path !== ownedMetadataCandidatePath(stagingPath, 'recovery', String(claim.nonce))
      || typeof claim.acquired_at !== 'string' || !Number.isFinite(Date.parse(claim.acquired_at))) {
      fail('SESSION_BINDING_LOCK_UNVERIFIABLE', 'session binding recovery claim identity is incomplete');
    }
    const age = this.#now().getTime() - Date.parse(claim.acquired_at);
    if (processState(Number(claim.pid)) !== 'dead' || age < LOCK_STALE_AFTER_MS) {
      fail('SESSION_BINDING_LOCK_RECOVERY_HELD', 'another process owns session binding lock recovery');
    }
    const currentDetails = await metadata(lockPath);
    if (currentDetails) {
      const current = await this.#verifiedLock(lockPath, filePath, stagingPath);
      if (current.nonce !== claim.observed_lock_nonce || current.artifact_path !== claim.artifact_path) {
        fail('SESSION_BINDING_LOCK_IDENTITY_CHANGED', 'session binding lock changed while recovery owner was unavailable');
      }
      await this.#cleanupOwnedArtifact(current.artifact_path, stagingPath);
      await this.#cleanupOwnedMetadataCandidate(String(current.metadata_candidate_path), stagingPath);
      await this.#unlinkOperational(lockPath);
    } else {
      await this.#cleanupOwnedArtifact(String(claim.artifact_path), stagingPath);
    }
    await this.#cleanupOwnedMetadataCandidate(String(claim.metadata_candidate_path), stagingPath);
    await this.#unlinkOperational(recoveryPath);
    await this.#syncDirectory(stagingPath);
  }

  async #recoverDeadLock(
    lockPath: string,
    recoveryPath: string,
    filePath: string,
    stagingPath: string,
    observed: LockMetadata
  ): Promise<void> {
    const claimNonce = this.#nonce();
    const claim: RecoveryMetadata = {
      schema_version: 1,
      pid: process.pid,
      nonce: claimNonce,
      target_path: filePath,
      observed_lock_nonce: observed.nonce,
      artifact_path: observed.artifact_path,
      metadata_candidate_path: ownedMetadataCandidatePath(stagingPath, 'recovery', claimNonce),
      acquired_at: this.#now().toISOString()
    };
    try {
      await this.#publishExclusiveMetadata(recoveryPath, claim.metadata_candidate_path, claim);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        fail('SESSION_BINDING_LOCK_RECOVERY_HELD', 'another process claimed stale lock recovery');
      }
      fail('SESSION_BINDING_LOCK_UNAVAILABLE', 'could not claim stale lock recovery', error);
    }
    try {
      const current = await this.#verifiedLock(lockPath, filePath, stagingPath);
      const age = this.#now().getTime() - Date.parse(current.acquired_at);
      if (current.nonce !== observed.nonce
        || current.artifact_path !== observed.artifact_path
        || processState(current.pid) !== 'dead'
        || age < LOCK_STALE_AFTER_MS) {
        fail('SESSION_BINDING_LOCK_IDENTITY_CHANGED', 'sessions.json lock changed during stale recovery');
      }
      await this.#cleanupOwnedArtifact(current.artifact_path, stagingPath);
      await this.#cleanupOwnedMetadataCandidate(current.metadata_candidate_path, stagingPath);
      await this.#unlinkOperational(lockPath);
    } finally {
      await this.#cleanupOwnedMetadataCandidate(claim.metadata_candidate_path, stagingPath);
      await this.#unlinkOperational(recoveryPath);
      await this.#syncDirectory(stagingPath);
    }
  }

  async #publishExclusiveMetadata(
    canonicalPath: string,
    candidatePath: string,
    value: LockMetadata | RecoveryMetadata
  ): Promise<void> {
    let handle;
    let published = false;
    try {
      handle = await open(
        candidatePath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      );
      await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await link(candidatePath, canonicalPath);
      published = true;
      await this.#syncDirectory(path.dirname(canonicalPath));
      await this.#unlinkOperational(candidatePath);
      await this.#syncDirectory(path.dirname(canonicalPath));
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      if (published) {
        await this.#unlinkOperational(canonicalPath).catch(() => undefined);
      }
      await this.#unlinkOperational(candidatePath).catch(() => undefined);
      throw error;
    }
  }

  async #cleanupOrphanMetadataCandidates(stagingPath: string): Promise<void> {
    const entries = await readdir(stagingPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!/^(?:lock|recovery)-candidate-[A-Za-z0-9-]{1,128}\.json$/u.test(entry.name)) continue;
      const candidatePath = path.join(stagingPath, entry.name);
      if (entry.isSymbolicLink() || !entry.isFile()) {
        fail('SESSION_BINDING_LOCK_UNVERIFIABLE', 'session binding metadata candidate is not a regular file');
      }
      const details = await lstat(candidatePath);
      let ownerState: 'live' | 'dead' | 'unverifiable' = 'unverifiable';
      let acquiredAt = details.mtimeMs;
      try {
        const value = JSON.parse(await readFile(candidatePath, 'utf8')) as Partial<LockMetadata | RecoveryMetadata>;
        ownerState = processState(Number(value.pid));
        const parsed = Date.parse(String(value.acquired_at));
        if (Number.isFinite(parsed)) acquiredAt = parsed;
      } catch {
        // A partial private candidate was never canonical authority; age is its recoverable identity.
      }
      const age = this.#now().getTime() - acquiredAt;
      if (age >= LOCK_STALE_AFTER_MS && ownerState !== 'live') {
        await this.#cleanupOwnedMetadataCandidate(candidatePath, stagingPath);
      }
    }
  }

  async #syncDirectory(directoryPath: string): Promise<void> {
    let handle;
    try {
      handle = await open(directoryPath, constants.O_RDONLY);
      await handle.sync();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!['EINVAL', 'EPERM', 'ENOTSUP', 'EISDIR'].includes(code ?? '')) throw error;
    } finally {
      if (handle) await handle.close().catch(() => undefined);
    }
  }

  async #unlinkOperational(filePath: string): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.#unlinkFile(filePath);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        if (!TRANSIENT_RENAME_CODES.has((error as NodeJS.ErrnoException).code ?? '') || attempt >= this.#renameRetries) throw error;
        await this.#sleep(Math.min(100, 8 * (2 ** attempt)));
      }
    }
  }

  async #cleanupOwnedMetadataCandidate(candidatePath: string, stagingPath: string): Promise<void> {
    assertInside(stagingPath, candidatePath);
    const details = await metadata(candidatePath);
    if (!details) return;
    if (details.isSymbolicLink() || !details.isFile()) {
      fail('SESSION_BINDING_LOCK_UNVERIFIABLE', 'session binding metadata candidate identity is unsafe');
    }
    await this.#unlinkOperational(candidatePath);
  }

  async #cleanupOwnedArtifact(artifactPath: string, stagingPath: string): Promise<void> {
    assertInside(stagingPath, artifactPath);
    const details = await metadata(artifactPath);
    if (!details) return;
    if (details.isSymbolicLink() || !details.isFile()) {
      fail('SESSION_BINDING_LOCK_UNVERIFIABLE', 'session binding staging artifact identity is unsafe');
    }
    await this.#unlinkOperational(artifactPath);
  }

  async #releaseLock(lock: HeldLock): Promise<void> {
    let observed: Partial<LockMetadata>;
    try {
      observed = JSON.parse(await readFile(lock.lockPath, 'utf8')) as Partial<LockMetadata>;
    } catch (error) {
      fail('SESSION_BINDING_LOCK_OWNERSHIP_LOST', 'sessions.json lock disappeared or became unreadable before release', error);
    }
    if (observed.nonce !== lock.nonce
      || observed.artifact_path !== lock.artifactPath
      || observed.metadata_candidate_path !== lock.metadataCandidatePath
      || (await lstat(lock.lockPath)).isSymbolicLink()) {
      fail('SESSION_BINDING_LOCK_OWNERSHIP_LOST', 'sessions.json lock ownership changed before release');
    }
    const stagingPath = path.dirname(lock.lockPath);
    await this.#cleanupOwnedArtifact(lock.artifactPath, stagingPath);
    await this.#cleanupOwnedMetadataCandidate(lock.metadataCandidatePath, stagingPath);
    await this.#unlinkOperational(lock.lockPath);
    await this.#syncDirectory(stagingPath);
  }

  async #withLock<T>(filePath: string, stagingPath: string, operation: (lock: HeldLock) => Promise<T>): Promise<T> {
    const lock = await this.#acquireLock(filePath, stagingPath);
    let operationError: unknown;
    try {
      return await operation(lock);
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      try {
        await this.#releaseLock(lock);
      } catch (releaseError) {
        if (operationError === undefined) throw releaseError;
        if (operationError && typeof operationError === 'object') {
          Object.assign(operationError, { lockReleaseError: releaseError });
        }
      }
    }
  }

  async #writeAtomic(filePath: string, state: SessionBindingStateV1, lock: HeldLock): Promise<void> {
    const temporaryPath = lock.artifactPath;
    let handle;
    try {
      handle = await open(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      );
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      for (let attempt = 0; ; attempt += 1) {
        try {
          await this.#renameFile(temporaryPath, filePath);
          await this.#syncDirectory(path.dirname(filePath));
          return;
        } catch (error) {
          if (!TRANSIENT_RENAME_CODES.has((error as NodeJS.ErrnoException).code ?? '') || attempt >= this.#renameRetries) throw error;
          await this.#sleep(Math.min(100, 8 * (2 ** attempt)));
        }
      }
    } finally {
      if (handle) await handle.close().catch(() => undefined);
      await this.#unlinkOperational(temporaryPath);
    }
  }
}
