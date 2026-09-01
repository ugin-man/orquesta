import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { lstat, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import executionKernel from '@orquesta/execution-kernel';
import {
  PROJECT_STORAGE,
  canonicalProjectRoot,
  ensureProjectStorageDirectory,
  projectStorageFileBoundary,
  projectStoragePath
} from './project-storage-layout';

export type MessageDeliveryState = 'queued' | 'thread_ready' | 'turn_starting' | 'dispatch_accepted' | 'turn_started' | 'completed' | 'failed';

export interface MessageDeliveryInput {
  rootPath: string;
  messageId: string;
  actionFingerprint: string;
  correlationId: string;
  projectId: string;
  targetAgentId: string;
  threadId: string | null;
  turnId: string | null;
  state: MessageDeliveryState;
  errorCode?: string | null;
}

export interface MessageDeliveryRecord {
  schema_version: 3;
  message_id: string;
  action_fingerprint: string;
  correlation_id: string;
  project_id: string;
  target_agent_id: string;
  thread_id: string | null;
  turn_id: string | null;
  state: MessageDeliveryState;
  observed_at: string;
  error_code: string | null;
}

export interface MessageLedgerWriter {
  record(input: MessageDeliveryInput): Promise<boolean>;
  read?(input: { rootPath: string; messageId: string }): Promise<MessageDeliveryRecord | null>;
}

const ACTION_FINGERPRINT = /^[a-f0-9]{64}$/u;
const MAX_IDENTITY_LENGTH = 512;
const MAX_ERROR_CODE_LENGTH = 256;
const MAX_RECORD_BYTES = 16 * 1024;
const MAX_LEGACY_MESSAGES = 250_000;
const MAX_LEGACY_ISSUES = 100;
const MAX_LEGACY_RESIDENT_BYTES = 128 * 1024 * 1024;
const TRANSIENT_RENAME_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);
const RECORD_KEYS = [
  'action_fingerprint', 'correlation_id', 'error_code', 'message_id', 'observed_at',
  'project_id', 'schema_version', 'state', 'target_agent_id', 'thread_id', 'turn_id'
].sort();
const PENDING_KEYS = ['message_id', 'next_digest', 'next_record', 'previous_digest', 'schema_version'].sort();
const MIGRATION_MANIFEST_KEYS = [
  'backup_relative_path', 'byte_count', 'final_records_sha256', 'final_relative_root',
  'legacy_sha256', 'line_count', 'message_count', 'schema_version', 'staging_relative_root'
].sort();
const STATE_RANK: Record<MessageDeliveryState, number> = {
  queued: 0,
  thread_ready: 1,
  turn_starting: 2,
  dispatch_accepted: 3,
  turn_started: 4,
  completed: 5,
  failed: 5
};
const TERMINAL_STATES = new Set<MessageDeliveryState>(['completed', 'failed']);
const ALLOWED_FORWARD: Record<MessageDeliveryState, ReadonlySet<MessageDeliveryState>> = {
  queued: new Set(['thread_ready', 'failed']),
  thread_ready: new Set(['turn_starting', 'failed']),
  turn_starting: new Set(['dispatch_accepted', 'turn_started', 'completed', 'failed']),
  dispatch_accepted: new Set(['turn_started', 'completed', 'failed']),
  turn_started: new Set(['completed', 'failed']),
  completed: new Set(),
  failed: new Set()
};

interface PendingRecordEnvelope {
  schema_version: 1;
  message_id: string;
  previous_digest: string | null;
  next_digest: string;
  next_record: MessageDeliveryRecord;
}

interface MessageLedgerMigrationManifest {
  schema_version: 1;
  legacy_sha256: string;
  final_records_sha256: string;
  byte_count: number;
  line_count: number;
  message_count: number;
  backup_relative_path: typeof PROJECT_STORAGE.messageDeliveryLegacyBackup;
  staging_relative_root: typeof PROJECT_STORAGE.messageDeliveryMigrationStagingRoot;
  final_relative_root: typeof PROJECT_STORAGE.messageDeliveryRoot;
}

export interface LegacyMessageLedgerMigrationInspection {
  status: 'missing' | 'ready' | 'blocked';
  no_write: true;
  legacy_path: string;
  legacy_sha256: string | null;
  final_records_sha256: string | null;
  byte_count: number;
  line_count: number;
  message_count: number;
  estimated_resident_bytes: number;
  resident_byte_limit: number;
  issues: Array<{ line: number | null; code: string; reason: string }>;
}

export interface LegacyMessageLedgerMigrationResult {
  status: 'not_required' | 'completed' | 'resumed';
  no_data_loss: true;
  backup_path: string | null;
  legacy_sha256: string | null;
  final_records_sha256: string | null;
  message_count: number;
}

interface LegacyMessageSummary {
  immutable_identity_digest: string;
  thread_id_digest: string | null;
  turn_id_digest: string | null;
  error_code_digest: string | null;
  state: MessageDeliveryState;
  observed_epoch_ms: number;
  final_record_digest: string;
  estimated_resident_bytes: number;
}

function isDeliveryState(value: unknown): value is MessageDeliveryState {
  return typeof value === 'string' && Object.hasOwn(STATE_RANK, value);
}

function exactIdentity(value: unknown, field: string, maxLength = MAX_IDENTITY_LENGTH): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || value.trim() !== value) {
    throw new Error(`message_ledger_${field}_invalid`);
  }
  return value;
}

function exactNullableIdentity(value: unknown, field: string): string | null {
  return value === null ? null : exactIdentity(value, field);
}

function messageStorageIdentity(messageId: string): string {
  exactIdentity(messageId, 'message_id');
  return createHash('sha256')
    .update('orquesta.message-delivery.v1\0', 'utf8')
    .update(messageId, 'utf8')
    .digest('hex');
}

function messageRelativePath(messageId: string): string {
  const identity = messageStorageIdentity(messageId);
  return `${PROJECT_STORAGE.messageDeliveryRoot}/${identity.slice(0, 2)}/${identity}.json`;
}

function migrationStagingRelativePath(messageId: string): string {
  const identity = messageStorageIdentity(messageId);
  return `${PROJECT_STORAGE.messageDeliveryMigrationStagingRoot}/${identity.slice(0, 2)}/${identity}.json`;
}

function messageLockRelativePath(messageId: string): string {
  const identity = messageStorageIdentity(messageId);
  return `runtime/message-ledger-v1/${identity.slice(0, 2)}/${identity}.lock`;
}

function messagePendingRelativePath(messageId: string): string {
  const identity = messageStorageIdentity(messageId);
  return `${PROJECT_STORAGE.messageDeliveryRoot}/${identity.slice(0, 2)}/${identity}.pending.json`;
}

function messageCommitRelativePath(messageId: string): string {
  const identity = messageStorageIdentity(messageId);
  return `${PROJECT_STORAGE.messageDeliveryRoot}/${identity.slice(0, 2)}/${identity}.commit.json`;
}

function assertInside(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('message_ledger_path_escape');
}

function comparable(value: string): string {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

async function storageDirectoryBoundary(
  canonicalRoot: string,
  relativeDirectory: string,
  create = false
): Promise<{ directoryPath: string; exists: boolean }> {
  if (create) {
    return { directoryPath: await ensureProjectStorageDirectory(canonicalRoot, relativeDirectory), exists: true };
  }
  const directoryPath = projectStoragePath(canonicalRoot, relativeDirectory);
  let details;
  try {
    details = await lstat(directoryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { directoryPath, exists: false };
    throw error;
  }
  if (!details.isDirectory() || details.isSymbolicLink()
    || comparable(await realpath(directoryPath)) !== comparable(directoryPath)) {
    throw new Error('message_ledger_migration_directory_unsafe');
  }
  return { directoryPath, exists: true };
}

async function assertLegacyStoreAbsent(canonicalRoot: string): Promise<void> {
  const legacy = await projectStorageFileBoundary(canonicalRoot, PROJECT_STORAGE.messageDeliveryLegacy);
  if (legacy.exists) throw new Error('message_ledger_legacy_migration_required');
  const migration = await projectStorageFileBoundary(canonicalRoot, PROJECT_STORAGE.messageDeliveryMigrationManifest);
  if (migration.exists) throw new Error('message_ledger_migration_incomplete');
}

function validateRecord(value: unknown, expectedMessageId: string): MessageDeliveryRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('message_ledger_record_invalid');
  const parsed = value as Record<string, unknown>;
  const keys = Object.keys(parsed).sort();
  if (keys.length !== RECORD_KEYS.length || keys.some((key, index) => key !== RECORD_KEYS[index])) {
    throw new Error('message_ledger_record_invalid');
  }
  if (parsed.schema_version !== 3 || !ACTION_FINGERPRINT.test(String(parsed.action_fingerprint))) {
    throw new Error('message_ledger_record_invalid');
  }
  const messageId = exactIdentity(parsed.message_id, 'message_id');
  if (messageId !== expectedMessageId) throw new Error('message_ledger_identity_conflict');
  const state = parsed.state;
  if (!isDeliveryState(state)) throw new Error('message_ledger_record_invalid');
  const observedAt = exactIdentity(parsed.observed_at, 'observed_at');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(observedAt)
    || !Number.isFinite(Date.parse(observedAt))
    || new Date(observedAt).toISOString() !== observedAt) {
    throw new Error('message_ledger_record_invalid');
  }
  const threadId = exactNullableIdentity(parsed.thread_id, 'thread_id');
  const turnId = exactNullableIdentity(parsed.turn_id, 'turn_id');
  const errorCode = parsed.error_code === null
    ? null
    : exactIdentity(parsed.error_code, 'error_code', MAX_ERROR_CODE_LENGTH);
  if ((state === 'queued' && (threadId !== null || turnId !== null))
    || ((state === 'thread_ready' || state === 'turn_starting') && (threadId === null || turnId !== null))
    || ((state === 'dispatch_accepted' || state === 'turn_started' || state === 'completed')
      && (threadId === null || turnId === null))
    || (state === 'failed' && errorCode === null)
    || (state !== 'failed' && errorCode !== null)) {
    throw new Error('message_ledger_record_invalid');
  }
  return {
    schema_version: 3,
    message_id: messageId,
    action_fingerprint: String(parsed.action_fingerprint),
    correlation_id: exactIdentity(parsed.correlation_id, 'correlation_id'),
    project_id: exactIdentity(parsed.project_id, 'project_id'),
    target_agent_id: exactIdentity(parsed.target_agent_id, 'target_agent_id'),
    thread_id: threadId,
    turn_id: turnId,
    state,
    observed_at: observedAt,
    error_code: errorCode
  };
}

function recordDigest(record: MessageDeliveryRecord): string {
  return createHash('sha256')
    .update('orquesta.message-delivery-record.v1\0', 'utf8')
    .update(JSON.stringify(record), 'utf8')
    .digest('hex');
}

function validatePendingEnvelope(value: unknown, messageId: string): PendingRecordEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('message_ledger_pending_invalid');
  const parsed = value as Record<string, unknown>;
  const keys = Object.keys(parsed).sort();
  if (keys.length !== PENDING_KEYS.length || keys.some((key, index) => key !== PENDING_KEYS[index])
    || parsed.schema_version !== 1
    || parsed.message_id !== messageId
    || (parsed.previous_digest !== null && !ACTION_FINGERPRINT.test(String(parsed.previous_digest)))
    || !ACTION_FINGERPRINT.test(String(parsed.next_digest))) {
    throw new Error('message_ledger_pending_invalid');
  }
  const nextRecord = validateRecord(parsed.next_record, messageId);
  if (recordDigest(nextRecord) !== parsed.next_digest) throw new Error('message_ledger_pending_invalid');
  return {
    schema_version: 1,
    message_id: messageId,
    previous_digest: parsed.previous_digest === null ? null : String(parsed.previous_digest),
    next_digest: String(parsed.next_digest),
    next_record: nextRecord
  };
}

function validateMigrationManifest(value: unknown): MessageLedgerMigrationManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('message_ledger_migration_manifest_invalid');
  }
  const parsed = value as Record<string, unknown>;
  const keys = Object.keys(parsed).sort();
  if (keys.length !== MIGRATION_MANIFEST_KEYS.length
    || keys.some((key, index) => key !== MIGRATION_MANIFEST_KEYS[index])
    || parsed.schema_version !== 1
    || !ACTION_FINGERPRINT.test(String(parsed.legacy_sha256))
    || !ACTION_FINGERPRINT.test(String(parsed.final_records_sha256))
    || !Number.isSafeInteger(parsed.byte_count) || Number(parsed.byte_count) < 0
    || !Number.isSafeInteger(parsed.line_count) || Number(parsed.line_count) < 0
    || !Number.isSafeInteger(parsed.message_count) || Number(parsed.message_count) < 0
    || Number(parsed.message_count) > MAX_LEGACY_MESSAGES
    || parsed.backup_relative_path !== PROJECT_STORAGE.messageDeliveryLegacyBackup
    || parsed.staging_relative_root !== PROJECT_STORAGE.messageDeliveryMigrationStagingRoot
    || parsed.final_relative_root !== PROJECT_STORAGE.messageDeliveryRoot) {
    throw new Error('message_ledger_migration_manifest_invalid');
  }
  return {
    schema_version: 1,
    legacy_sha256: String(parsed.legacy_sha256),
    final_records_sha256: String(parsed.final_records_sha256),
    byte_count: Number(parsed.byte_count),
    line_count: Number(parsed.line_count),
    message_count: Number(parsed.message_count),
    backup_relative_path: PROJECT_STORAGE.messageDeliveryLegacyBackup,
    staging_relative_root: PROJECT_STORAGE.messageDeliveryMigrationStagingRoot,
    final_relative_root: PROJECT_STORAGE.messageDeliveryRoot
  };
}

async function readMigrationMetadata(
  canonicalRoot: string,
  relativePath: string,
  failureCode: string
): Promise<MessageLedgerMigrationManifest | null> {
  const boundary = await projectStorageFileBoundary(canonicalRoot, relativePath);
  if (!boundary.exists) return null;
  const handle = await open(boundary.filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const details = await handle.stat();
    if (!details.isFile() || details.size <= 0 || details.size > MAX_RECORD_BYTES) {
      throw new Error('message_ledger_migration_manifest_invalid');
    }
    return validateMigrationManifest(JSON.parse(await handle.readFile('utf8')));
  } catch (error) {
    throw new Error(failureCode, { cause: error });
  } finally {
    await handle.close();
  }
}

async function readMigrationManifest(canonicalRoot: string): Promise<MessageLedgerMigrationManifest | null> {
  return readMigrationMetadata(
    canonicalRoot,
    PROJECT_STORAGE.messageDeliveryMigrationManifest,
    'message_ledger_migration_manifest_fail_closed'
  );
}

async function readMigrationReceipt(canonicalRoot: string): Promise<MessageLedgerMigrationManifest | null> {
  return readMigrationMetadata(
    canonicalRoot,
    PROJECT_STORAGE.messageDeliveryMigrationReceipt,
    'message_ledger_migration_receipt_fail_closed'
  );
}

async function readRecordAt(
  canonicalRoot: string,
  relativePath: string,
  messageId: string
): Promise<MessageDeliveryRecord | null> {
  const boundary = await projectStorageFileBoundary(canonicalRoot, relativePath);
  if (!boundary.exists) return null;
  const handle = await open(boundary.filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const details = await handle.stat();
    if (!details.isFile() || details.size <= 0 || details.size > MAX_RECORD_BYTES) {
      throw new Error('message_ledger_record_invalid');
    }
    return validateRecord(JSON.parse(await handle.readFile('utf8')), messageId);
  } catch (error) {
    if (error instanceof Error && error.message === 'message_ledger_identity_conflict') throw error;
    throw new Error('message_ledger_malformed_fail_closed', { cause: error });
  } finally {
    await handle.close();
  }
}

async function readRecord(canonicalRoot: string, messageId: string): Promise<MessageDeliveryRecord | null> {
  return readRecordAt(canonicalRoot, messageRelativePath(messageId), messageId);
}

async function readPendingEnvelope(canonicalRoot: string, messageId: string): Promise<PendingRecordEnvelope | null> {
  const boundary = await projectStorageFileBoundary(canonicalRoot, messagePendingRelativePath(messageId));
  if (!boundary.exists) return null;
  const handle = await open(boundary.filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const details = await handle.stat();
    if (!details.isFile() || details.size <= 0 || details.size > MAX_RECORD_BYTES * 2) {
      throw new Error('message_ledger_pending_invalid');
    }
    return validatePendingEnvelope(JSON.parse(await handle.readFile('utf8')), messageId);
  } catch (error) {
    throw new Error('message_ledger_pending_fail_closed', { cause: error });
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  let handle;
  try {
    handle = await open(directoryPath, constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (!['EINVAL', 'EPERM', 'ENOTSUP', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function unlinkOwnedTemporary(canonicalRoot: string, temporaryPath: string): Promise<void> {
  assertInside(canonicalRoot, temporaryPath);
  let details;
  try {
    details = await lstat(temporaryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!details.isFile() || details.isSymbolicLink()
    || comparable(await realpath(temporaryPath)) !== comparable(temporaryPath)) {
    throw new Error('message_ledger_staging_unsafe');
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      await unlink(temporaryPath);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      if (!TRANSIENT_RENAME_CODES.has((error as NodeJS.ErrnoException).code ?? '') || attempt >= 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, 8 * (2 ** attempt))));
    }
  }
}

async function renameOperational(sourcePath: string, destinationPath: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(sourcePath, destinationPath);
      return;
    } catch (error) {
      if (!TRANSIENT_RENAME_CODES.has((error as NodeJS.ErrnoException).code ?? '') || attempt >= 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, 8 * (2 ** attempt))));
    }
  }
}

async function withLegacyMigrationLock<T>(canonicalRoot: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = projectStoragePath(canonicalRoot, 'runtime/message-ledger/messages-jsonl.lock');
  let lock: ReturnType<typeof executionKernel.acquireExclusiveProcessLock> | null = null;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      lock = executionKernel.acquireExclusiveProcessLock({
        rootPath: canonicalRoot,
        lockPath,
        codePrefix: 'MESSAGE_LEDGER_MIGRATION'
      });
      break;
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      if ((code !== 'MESSAGE_LEDGER_MIGRATION_LOCKED'
        && code !== 'MESSAGE_LEDGER_MIGRATION_LOCK_UNAVAILABLE') || attempt === 199) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5 + (attempt % 7)));
    }
  }
  if (!lock) throw new Error('message_ledger_migration_lock_unavailable');
  let operationError: unknown;
  try {
    return await operation();
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      executionKernel.releaseExclusiveProcessLock(lock);
    } catch (releaseError) {
      if (operationError === undefined) throw releaseError;
      if (operationError && typeof operationError === 'object') Object.assign(operationError, { lockReleaseError: releaseError });
    }
  }
}

function assertIdentityProgression(current: MessageDeliveryRecord, next: MessageDeliveryRecord): void {
  if (current.action_fingerprint !== next.action_fingerprint
    || current.project_id !== next.project_id
    || current.target_agent_id !== next.target_agent_id
    || current.correlation_id !== next.correlation_id
    || (current.thread_id !== null && next.thread_id !== current.thread_id)
    || (current.turn_id !== null && next.turn_id !== current.turn_id)) {
    throw new Error('message_ledger_identity_conflict');
  }
}

function assertForwardTransition(current: MessageDeliveryRecord | null, next: MessageDeliveryRecord): void {
  if (!current && next.state !== 'queued') throw new Error('message_ledger_transition_invalid');
  if (current) {
    assertIdentityProgression(current, next);
    if (!ALLOWED_FORWARD[current.state].has(next.state)) throw new Error('message_ledger_transition_invalid');
  }
}

async function writeExclusive(filePath: string, source: string): Promise<void> {
  const handle = await open(
    filePath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  );
  try {
    await handle.writeFile(source, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function recoverPendingRecord(canonicalRoot: string, messageId: string): Promise<void> {
  const pendingPath = projectStoragePath(canonicalRoot, messagePendingRelativePath(messageId));
  const commitPath = projectStoragePath(canonicalRoot, messageCommitRelativePath(messageId));
  const pending = await readPendingEnvelope(canonicalRoot, messageId);
  const commit = await readRecordAt(canonicalRoot, messageCommitRelativePath(messageId), messageId);
  if (!pending) {
    if (commit) throw new Error('message_ledger_orphan_commit_fail_closed');
    return;
  }
  if (commit && recordDigest(commit) !== pending.next_digest) {
    throw new Error('message_ledger_pending_commit_conflict');
  }
  const current = await readRecord(canonicalRoot, messageId);
  const currentDigest = current ? recordDigest(current) : null;
  if (currentDigest === pending.next_digest) {
    await unlinkOwnedTemporary(canonicalRoot, commitPath);
    await unlinkOwnedTemporary(canonicalRoot, pendingPath);
    await syncDirectory(path.dirname(pendingPath));
    return;
  }
  if (currentDigest !== pending.previous_digest) {
    throw new Error('message_ledger_pending_previous_state_conflict');
  }
  assertForwardTransition(current, pending.next_record);
  if (!commit) {
    await writeExclusive(commitPath, `${JSON.stringify(pending.next_record)}\n`);
  }
  const destination = await projectStorageFileBoundary(canonicalRoot, messageRelativePath(messageId), { createParent: true });
  await renameOperational(commitPath, destination.filePath);
  await syncDirectory(path.dirname(destination.filePath));
  const verified = await readRecord(canonicalRoot, messageId);
  if (!verified || recordDigest(verified) !== pending.next_digest) {
    throw new Error('message_ledger_recovery_verification_failed');
  }
  await unlinkOwnedTemporary(canonicalRoot, pendingPath);
  await syncDirectory(path.dirname(pendingPath));
}

async function publishRecord(
  canonicalRoot: string,
  previous: MessageDeliveryRecord | null,
  record: MessageDeliveryRecord
): Promise<void> {
  const destination = await projectStorageFileBoundary(canonicalRoot, messageRelativePath(record.message_id), { createParent: true });
  const directoryPath = path.dirname(destination.filePath);
  const pendingPath = projectStoragePath(canonicalRoot, messagePendingRelativePath(record.message_id));
  const commitPath = projectStoragePath(canonicalRoot, messageCommitRelativePath(record.message_id));
  assertInside(canonicalRoot, pendingPath);
  assertInside(canonicalRoot, commitPath);
  const envelope: PendingRecordEnvelope = {
    schema_version: 1,
    message_id: record.message_id,
    previous_digest: previous ? recordDigest(previous) : null,
    next_digest: recordDigest(record),
    next_record: record
  };
  await writeExclusive(pendingPath, `${JSON.stringify(envelope)}\n`);
  await writeExclusive(commitPath, `${JSON.stringify(record)}\n`);
  await renameOperational(commitPath, destination.filePath);
  await syncDirectory(directoryPath);
  const verified = await readRecord(canonicalRoot, record.message_id);
  if (!verified || recordDigest(verified) !== envelope.next_digest) {
    throw new Error('message_ledger_publish_verification_failed');
  }
  await unlinkOwnedTemporary(canonicalRoot, pendingPath);
  await syncDirectory(directoryPath);
}

export class MessageLedger implements MessageLedgerWriter {
  private readonly now: () => Date;
  private readonly queues = new Map<string, Promise<void>>();

  constructor(options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async record(input: MessageDeliveryInput): Promise<boolean> {
    if (!ACTION_FINGERPRINT.test(input.actionFingerprint)) throw new Error('message_action_fingerprint_invalid');
    exactIdentity(input.messageId, 'message_id');
    exactIdentity(input.correlationId, 'correlation_id');
    exactIdentity(input.projectId, 'project_id');
    exactIdentity(input.targetAgentId, 'target_agent_id');
    exactNullableIdentity(input.threadId, 'thread_id');
    exactNullableIdentity(input.turnId, 'turn_id');
    if (!isDeliveryState(input.state)) throw new Error('message_ledger_state_invalid');
    const proposed = validateRecord({
      schema_version: 3,
      message_id: input.messageId,
      action_fingerprint: input.actionFingerprint,
      correlation_id: input.correlationId,
      project_id: input.projectId,
      target_agent_id: input.targetAgentId,
      thread_id: input.threadId,
      turn_id: input.turnId,
      state: input.state,
      observed_at: this.now().toISOString(),
      error_code: input.errorCode ?? null
    }, input.messageId);
    const canonicalRoot = await canonicalProjectRoot(input.rootPath);
    await assertLegacyStoreAbsent(canonicalRoot);
    const queueKey = `${canonicalRoot}\0${messageStorageIdentity(input.messageId)}`;
    const previous = this.queues.get(queueKey) ?? Promise.resolve();
    let written = false;
    const pending = previous.catch(() => undefined).then(() => this.withProcessLock(canonicalRoot, input.messageId, async () => {
      await recoverPendingRecord(canonicalRoot, input.messageId);
      const current = await readRecord(canonicalRoot, input.messageId);
      if (current && current.action_fingerprint !== input.actionFingerprint) throw new Error('message_action_fingerprint_mismatch');
      if (current) assertIdentityProgression(current, proposed);
      if (current && STATE_RANK[current.state] === STATE_RANK[input.state] && current.state !== input.state) {
        throw new Error('message_ledger_state_conflict');
      }
      if (current && (STATE_RANK[current.state] >= STATE_RANK[input.state] || TERMINAL_STATES.has(current.state))) return;
      assertForwardTransition(current, proposed);
      await publishRecord(canonicalRoot, current, proposed);
      written = true;
    }));
    this.queues.set(queueKey, pending);
    try {
      await pending;
      return written;
    } finally {
      if (this.queues.get(queueKey) === pending) this.queues.delete(queueKey);
    }
  }

  async read(input: { rootPath: string; messageId: string }): Promise<MessageDeliveryRecord | null> {
    exactIdentity(input.messageId, 'message_id');
    const canonicalRoot = await canonicalProjectRoot(input.rootPath);
    await assertLegacyStoreAbsent(canonicalRoot);
    const queueKey = `${canonicalRoot}\0${messageStorageIdentity(input.messageId)}`;
    const previous = this.queues.get(queueKey);
    if (previous) await previous;
    return this.withProcessLock(canonicalRoot, input.messageId, async () => {
      await recoverPendingRecord(canonicalRoot, input.messageId);
      return readRecord(canonicalRoot, input.messageId);
    });
  }

  private async withProcessLock<T>(canonicalRoot: string, messageId: string, operation: () => Promise<T>): Promise<T> {
    const lockPath = projectStoragePath(canonicalRoot, messageLockRelativePath(messageId));
    let lock: ReturnType<typeof executionKernel.acquireExclusiveProcessLock> | null = null;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        lock = executionKernel.acquireExclusiveProcessLock({ rootPath: canonicalRoot, lockPath, codePrefix: 'MESSAGE_LEDGER' });
        break;
      } catch (error) {
        const code = (error as { code?: unknown })?.code;
        if ((code !== 'MESSAGE_LEDGER_LOCKED' && code !== 'MESSAGE_LEDGER_LOCK_UNAVAILABLE') || attempt === 199) throw error;
        await new Promise((resolve) => setTimeout(resolve, 5 + (attempt % 7)));
      }
    }
    if (!lock) throw new Error('message_ledger_lock_unavailable');
    let operationError: unknown;
    try {
      return await operation();
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      try {
        executionKernel.releaseExclusiveProcessLock(lock);
      } catch (releaseError) {
        if (operationError === undefined) throw releaseError;
        if (operationError && typeof operationError === 'object') Object.assign(operationError, { lockReleaseError: releaseError });
      }
    }
  }
}

export function messageLedgerPath(rootPath: string, messageId: string): string {
  return projectStoragePath(path.resolve(rootPath), messageRelativePath(messageId));
}

export function messageLedgerPendingPath(rootPath: string, messageId: string): string {
  return projectStoragePath(path.resolve(rootPath), messagePendingRelativePath(messageId));
}

export function messageLedgerLockPath(rootPath: string, messageId: string): string {
  return projectStoragePath(path.resolve(rootPath), messageLockRelativePath(messageId));
}

export function legacyMessageLedgerPath(rootPath: string): string {
  return projectStoragePath(path.resolve(rootPath), PROJECT_STORAGE.messageDeliveryLegacy);
}

function migrationIssue(line: number | null, code: string, reason: string): { line: number | null; code: string; reason: string } {
  return { line, code, reason };
}

function migrationValueDigest(domain: string, value: string): string {
  return createHash('sha256').update(domain, 'utf8').update('\0', 'utf8').update(value, 'utf8').digest('hex');
}

function legacyMessageSummary(record: MessageDeliveryRecord): LegacyMessageSummary {
  const immutableIdentity = JSON.stringify([
    record.action_fingerprint,
    record.correlation_id,
    record.project_id,
    record.target_agent_id
  ]);
  return {
    immutable_identity_digest: migrationValueDigest('orquesta.message-ledger-migration.identity.v1', immutableIdentity),
    thread_id_digest: record.thread_id === null
      ? null
      : migrationValueDigest('orquesta.message-ledger-migration.thread.v1', record.thread_id),
    turn_id_digest: record.turn_id === null
      ? null
      : migrationValueDigest('orquesta.message-ledger-migration.turn.v1', record.turn_id),
    error_code_digest: record.error_code === null
      ? null
      : migrationValueDigest('orquesta.message-ledger-migration.error.v1', record.error_code),
    state: record.state,
    observed_epoch_ms: Date.parse(record.observed_at),
    final_record_digest: recordDigest(record),
    // The Map/key/string/object overhead is deliberately over-estimated. This
    // is a fail-closed ceiling, not a heap profiler.
    estimated_resident_bytes: 1024 + Buffer.byteLength(record.message_id, 'utf8')
  };
}

function assertLegacySummaryProgression(current: LegacyMessageSummary, next: LegacyMessageSummary): void {
  if (current.immutable_identity_digest !== next.immutable_identity_digest
    || (current.thread_id_digest !== null && next.thread_id_digest !== current.thread_id_digest)
    || (current.turn_id_digest !== null && next.turn_id_digest !== current.turn_id_digest)) {
    throw new Error('message_ledger_identity_conflict');
  }
  if (STATE_RANK[next.state] < STATE_RANK[current.state]
    || (STATE_RANK[next.state] === STATE_RANK[current.state] && next.state !== current.state)
    || next.observed_epoch_ms < current.observed_epoch_ms
    || (current.state === 'failed' && next.error_code_digest !== current.error_code_digest)) {
    throw new Error('message_ledger_state_conflict');
  }
}

/**
 * Read-only migration preflight. It never creates a directory, fixed record,
 * lock, backup, or manifest. Activation is intentionally a separate explicit
 * boundary so an unsupported legacy ledger cannot be partially converted.
 */
export async function inspectLegacyMessageLedgerMigration(
  rootPath: string,
  options: { maxResidentBytes?: number } = {}
): Promise<LegacyMessageLedgerMigrationInspection> {
  const requestedResidentLimit = options.maxResidentBytes ?? MAX_LEGACY_RESIDENT_BYTES;
  if (!Number.isSafeInteger(requestedResidentLimit) || requestedResidentLimit <= 0) {
    throw new Error('message_ledger_migration_resident_limit_invalid');
  }
  const residentByteLimit = Math.min(requestedResidentLimit, MAX_LEGACY_RESIDENT_BYTES);
  const canonicalRoot = await canonicalProjectRoot(rootPath);
  const boundary = await projectStorageFileBoundary(canonicalRoot, PROJECT_STORAGE.messageDeliveryLegacy);
  if (!boundary.exists) {
    return {
      status: 'missing', no_write: true, legacy_path: boundary.filePath, legacy_sha256: null,
      final_records_sha256: null, byte_count: 0, line_count: 0, message_count: 0,
      estimated_resident_bytes: 0, resident_byte_limit: residentByteLimit, issues: []
    };
  }
  const issues: LegacyMessageLedgerMigrationInspection['issues'] = [];
  const records = new Map<string, LegacyMessageSummary>();
  const legacyDigest = createHash('sha256');
  const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let byteCount = 0;
  let lineCount = 0;
  let estimatedResidentBytes = 0;
  let carry = Buffer.alloc(0);
  let oversizedLine = false;
  let residentLimitExceeded = false;
  const addIssue = (line: number | null, code: string, reason: string): void => {
    if (issues.length < MAX_LEGACY_ISSUES) issues.push(migrationIssue(line, code, reason));
  };
  const inspectLine = (bytes: Buffer): void => {
    lineCount += 1;
    if (residentLimitExceeded) return;
    if (oversizedLine) {
      oversizedLine = false;
      return;
    }
    const normalized = bytes.length > 0 && bytes[bytes.length - 1] === 13 ? bytes.subarray(0, -1) : bytes;
    if (normalized.length === 0) return;
    if (normalized.length > MAX_RECORD_BYTES) {
      addIssue(lineCount, 'legacy_record_too_large', `Legacy line exceeds ${MAX_RECORD_BYTES} bytes`);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(utf8.decode(normalized));
    } catch {
      addIssue(lineCount, 'legacy_record_json_invalid', 'Legacy line is not valid UTF-8 JSON');
      return;
    }
    let record: MessageDeliveryRecord;
    try {
      const messageId = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>).message_id
        : null;
      if (typeof messageId !== 'string') throw new Error('message_ledger_record_invalid');
      record = validateRecord(parsed, messageId);
    } catch (error) {
      addIssue(lineCount, 'legacy_record_not_migratable', error instanceof Error ? error.message : String(error));
      return;
    }
    const next = legacyMessageSummary(record);
    const current = records.get(record.message_id);
    if (current) {
      try {
        assertLegacySummaryProgression(current, next);
      } catch (error) {
        addIssue(lineCount, 'legacy_record_sequence_conflict', error instanceof Error ? error.message : String(error));
        return;
      }
    } else if (records.size >= MAX_LEGACY_MESSAGES) {
      addIssue(lineCount, 'legacy_message_limit_exceeded', `Legacy ledger exceeds ${MAX_LEGACY_MESSAGES} distinct messages`);
      return;
    }
    const nextEstimatedResidentBytes = estimatedResidentBytes
      - (current?.estimated_resident_bytes ?? 0)
      + next.estimated_resident_bytes;
    if (nextEstimatedResidentBytes > residentByteLimit) {
      addIssue(lineCount, 'legacy_resident_memory_limit_exceeded',
        `Legacy migration summary exceeds ${residentByteLimit} estimated resident bytes`);
      residentLimitExceeded = true;
      return;
    }
    records.set(record.message_id, next);
    estimatedResidentBytes = nextEstimatedResidentBytes;
  };
  const stream = createReadStream(boundary.filePath, { flags: 'r' });
  try {
    for await (const chunkValue of stream) {
      const rawChunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
      legacyDigest.update(rawChunk);
      byteCount += rawChunk.length;
      let chunk = rawChunk;
      if (oversizedLine) {
        const newline = chunk.indexOf(10);
        if (newline < 0) continue;
        lineCount += 1;
        oversizedLine = false;
        chunk = chunk.subarray(newline + 1);
        if (chunk.length === 0) continue;
      }
      carry = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
      let start = 0;
      for (let index = 0; index < carry.length; index += 1) {
        if (carry[index] !== 10) continue;
        inspectLine(carry.subarray(start, index));
        start = index + 1;
      }
      carry = start === 0 ? carry : carry.subarray(start);
      if (carry.length > MAX_RECORD_BYTES) {
        addIssue(lineCount + 1, 'legacy_record_too_large', `Legacy line exceeds ${MAX_RECORD_BYTES} bytes`);
        carry = Buffer.alloc(0);
        oversizedLine = true;
      }
    }
    if (oversizedLine) lineCount += 1;
    else if (carry.length > 0) inspectLine(carry);
  } catch (error) {
    addIssue(null, 'legacy_read_failed', error instanceof Error ? error.message : String(error));
  }
  const finalRecords = [...records.entries()].sort(([left], [right]) => (
    left < right ? -1 : left > right ? 1 : 0
  ));
  const finalDigest = createHash('sha256').update('orquesta.message-ledger-migration.v1\0', 'utf8');
  for (const [, summary] of finalRecords) finalDigest.update(summary.final_record_digest, 'utf8');
  return {
    status: issues.length === 0 ? 'ready' : 'blocked',
    no_write: true,
    legacy_path: boundary.filePath,
    legacy_sha256: legacyDigest.digest('hex'),
    final_records_sha256: finalDigest.digest('hex'),
    byte_count: byteCount,
    line_count: lineCount,
    message_count: finalRecords.length,
    estimated_resident_bytes: estimatedResidentBytes,
    resident_byte_limit: residentByteLimit,
    issues
  };
}

function sameMigrationInspection(
  inspection: LegacyMessageLedgerMigrationInspection,
  manifest: MessageLedgerMigrationManifest
): boolean {
  return inspection.status === 'ready'
    && inspection.legacy_sha256 === manifest.legacy_sha256
    && inspection.final_records_sha256 === manifest.final_records_sha256
    && inspection.byte_count === manifest.byte_count
    && inspection.line_count === manifest.line_count
    && inspection.message_count === manifest.message_count;
}

async function writeMigrationMetadata(
  canonicalRoot: string,
  relativePath: string,
  manifest: MessageLedgerMigrationManifest
): Promise<void> {
  const destination = await projectStorageFileBoundary(
    canonicalRoot,
    relativePath,
    { createParent: true }
  );
  if (destination.exists) {
    const existing = await readMigrationMetadata(canonicalRoot, relativePath, 'message_ledger_migration_metadata_fail_closed');
    if (JSON.stringify(existing) === JSON.stringify(manifest)) return;
    throw new Error('message_ledger_migration_metadata_conflict');
  }
  const temporaryRelative = `${relativePath}.commit`;
  const temporary = await projectStorageFileBoundary(canonicalRoot, temporaryRelative, { createParent: true });
  if (temporary.exists) await unlinkOwnedTemporary(canonicalRoot, temporary.filePath);
  await writeExclusive(temporary.filePath, `${JSON.stringify(manifest)}\n`);
  await renameOperational(temporary.filePath, destination.filePath);
  await syncDirectory(path.dirname(destination.filePath));
}

async function writeMigrationManifest(
  canonicalRoot: string,
  manifest: MessageLedgerMigrationManifest
): Promise<void> {
  return writeMigrationMetadata(canonicalRoot, PROJECT_STORAGE.messageDeliveryMigrationManifest, manifest);
}

async function writeMigrationReceipt(
  canonicalRoot: string,
  manifest: MessageLedgerMigrationManifest
): Promise<void> {
  return writeMigrationMetadata(canonicalRoot, PROJECT_STORAGE.messageDeliveryMigrationReceipt, manifest);
}

function sameMigrationMetadata(
  left: MessageLedgerMigrationManifest | null,
  right: MessageLedgerMigrationManifest
): boolean {
  return left !== null && JSON.stringify(left) === JSON.stringify(right);
}

async function retireMigrationManifestExact(
  canonicalRoot: string,
  expected: MessageLedgerMigrationManifest
): Promise<void> {
  const retiredRelative = `${PROJECT_STORAGE.messageDeliveryMigrationManifest}.retired`;
  let retired = await projectStorageFileBoundary(canonicalRoot, retiredRelative);
  if (retired.exists) {
    const retiredMetadata = await readMigrationMetadata(
      canonicalRoot,
      retiredRelative,
      'message_ledger_migration_retired_manifest_fail_closed'
    );
    if (!sameMigrationMetadata(retiredMetadata, expected)) {
      throw new Error('message_ledger_migration_manifest_changed');
    }
    await unlinkOwnedTemporary(canonicalRoot, retired.filePath);
  }
  const manifest = await projectStorageFileBoundary(canonicalRoot, PROJECT_STORAGE.messageDeliveryMigrationManifest);
  if (!manifest.exists) throw new Error('message_ledger_migration_manifest_missing');
  const observed = await readMigrationManifest(canonicalRoot);
  if (!sameMigrationMetadata(observed, expected)) {
    throw new Error('message_ledger_migration_manifest_changed');
  }
  retired = await projectStorageFileBoundary(canonicalRoot, retiredRelative);
  if (retired.exists) throw new Error('message_ledger_migration_retired_manifest_conflict');
  await renameOperational(manifest.filePath, retired.filePath);
  const renamed = await readMigrationMetadata(
    canonicalRoot,
    retiredRelative,
    'message_ledger_migration_retired_manifest_fail_closed'
  );
  if (!sameMigrationMetadata(renamed, expected)) {
    throw new Error('message_ledger_migration_manifest_changed');
  }
  retired = await projectStorageFileBoundary(canonicalRoot, retiredRelative);
  if (!retired.exists) throw new Error('message_ledger_migration_retired_manifest_missing');
  await unlinkOwnedTemporary(canonicalRoot, retired.filePath);
  await syncDirectory(path.dirname(retired.filePath));
  if ((await projectStorageFileBoundary(canonicalRoot, PROJECT_STORAGE.messageDeliveryMigrationManifest)).exists) {
    throw new Error('message_ledger_migration_manifest_reappeared');
  }
}

async function writeStagedMigrationRecord(
  canonicalRoot: string,
  record: MessageDeliveryRecord
): Promise<void> {
  const relativePath = migrationStagingRelativePath(record.message_id);
  const destination = await projectStorageFileBoundary(canonicalRoot, relativePath, { createParent: true });
  const temporaryRelative = `${relativePath}.migration-commit`;
  const temporary = await projectStorageFileBoundary(canonicalRoot, temporaryRelative, { createParent: true });
  if (temporary.exists) await unlinkOwnedTemporary(canonicalRoot, temporary.filePath);
  await writeExclusive(temporary.filePath, `${JSON.stringify(record)}\n`);
  if (destination.exists) await unlinkOwnedTemporary(canonicalRoot, destination.filePath);
  await renameOperational(temporary.filePath, destination.filePath);
  await syncDirectory(path.dirname(destination.filePath));
}

async function materializeLegacyMigrationRecords(
  canonicalRoot: string,
  manifest: MessageLedgerMigrationManifest,
  writeStaging: boolean
): Promise<Map<string, LegacyMessageSummary>> {
  const backup = await projectStorageFileBoundary(canonicalRoot, manifest.backup_relative_path);
  if (!backup.exists) throw new Error('message_ledger_migration_backup_missing');
  if (writeStaging) {
    await storageDirectoryBoundary(canonicalRoot, manifest.staging_relative_root, true);
  }
  const finalRecords = new Map<string, LegacyMessageSummary>();
  const legacyDigest = createHash('sha256');
  const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let estimatedResidentBytes = 0;
  let byteCount = 0;
  let lineCount = 0;
  let carry = Buffer.alloc(0);
  let oversizedLine = false;
  const processLine = async (bytes: Buffer): Promise<void> => {
    lineCount += 1;
    if (oversizedLine) {
      oversizedLine = false;
      throw new Error('message_ledger_migration_source_changed');
    }
    const normalized = bytes.length > 0 && bytes[bytes.length - 1] === 13 ? bytes.subarray(0, -1) : bytes;
    if (normalized.length === 0) return;
    if (normalized.length > MAX_RECORD_BYTES) throw new Error('message_ledger_migration_source_changed');
    let parsed: unknown;
    try {
      parsed = JSON.parse(utf8.decode(normalized));
    } catch (error) {
      throw new Error('message_ledger_migration_source_changed', { cause: error });
    }
    const messageId = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).message_id
      : null;
    if (typeof messageId !== 'string') throw new Error('message_ledger_migration_source_changed');
    let record: MessageDeliveryRecord;
    try {
      record = validateRecord(parsed, messageId);
    } catch (error) {
      throw new Error('message_ledger_migration_source_changed', { cause: error });
    }
    const summary = legacyMessageSummary(record);
    if (!finalRecords.has(record.message_id)) {
      estimatedResidentBytes += summary.estimated_resident_bytes;
      if (estimatedResidentBytes > MAX_LEGACY_RESIDENT_BYTES || finalRecords.size >= MAX_LEGACY_MESSAGES) {
        throw new Error('message_ledger_migration_memory_limit_exceeded');
      }
    }
    finalRecords.set(record.message_id, summary);
    if (writeStaging) await writeStagedMigrationRecord(canonicalRoot, record);
  };
  const stream = createReadStream(backup.filePath, { flags: 'r' });
  for await (const chunkValue of stream) {
    const rawChunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
    legacyDigest.update(rawChunk);
    byteCount += rawChunk.length;
    let chunk = rawChunk;
    if (oversizedLine) {
      const newline = chunk.indexOf(10);
      if (newline < 0) continue;
      lineCount += 1;
      throw new Error('message_ledger_migration_source_changed');
    }
    carry = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
    let start = 0;
    for (let index = 0; index < carry.length; index += 1) {
      if (carry[index] !== 10) continue;
      await processLine(carry.subarray(start, index));
      start = index + 1;
    }
    carry = start === 0 ? carry : carry.subarray(start);
    if (carry.length > MAX_RECORD_BYTES) {
      oversizedLine = true;
      carry = Buffer.alloc(0);
    }
  }
  if (oversizedLine) throw new Error('message_ledger_migration_source_changed');
  if (carry.length > 0) await processLine(carry);
  const finalDigest = createHash('sha256').update('orquesta.message-ledger-migration.v1\0', 'utf8');
  for (const messageId of [...finalRecords.keys()].sort()) {
    finalDigest.update((finalRecords.get(messageId) as LegacyMessageSummary).final_record_digest, 'utf8');
  }
  if (legacyDigest.digest('hex') !== manifest.legacy_sha256
    || finalDigest.digest('hex') !== manifest.final_records_sha256
    || byteCount !== manifest.byte_count
    || lineCount !== manifest.line_count
    || finalRecords.size !== manifest.message_count) {
    throw new Error('message_ledger_migration_source_changed');
  }
  return finalRecords;
}

async function verifyMigrationRecordTree(
  canonicalRoot: string,
  relativeRoot: string,
  expectedRecords: ReadonlyMap<string, LegacyMessageSummary>
): Promise<void> {
  const root = await storageDirectoryBoundary(canonicalRoot, relativeRoot);
  if (!root.exists) throw new Error('message_ledger_migration_record_tree_missing');
  for (const [messageId, expected] of expectedRecords) {
    const identity = messageStorageIdentity(messageId);
    const relativePath = `${relativeRoot}/${identity.slice(0, 2)}/${identity}.json`;
    const record = await readRecordAt(canonicalRoot, relativePath, messageId);
    if (!record || recordDigest(record) !== expected.final_record_digest) {
      throw new Error('message_ledger_migration_record_verification_failed');
    }
  }
  let observedFiles = 0;
  for (const shard of await readdir(root.directoryPath, { withFileTypes: true })) {
    if (shard.isSymbolicLink() || !shard.isDirectory() || !/^[a-f0-9]{2}$/u.test(shard.name)) {
      throw new Error('message_ledger_migration_record_tree_invalid');
    }
    const shardPath = path.join(root.directoryPath, shard.name);
    for (const entry of await readdir(shardPath, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || !entry.isFile() || !/^[a-f0-9]{64}\.json$/u.test(entry.name)) {
        throw new Error('message_ledger_migration_record_tree_invalid');
      }
      observedFiles += 1;
    }
  }
  if (observedFiles !== expectedRecords.size) {
    throw new Error('message_ledger_migration_record_count_mismatch');
  }
}

async function verifyCompletedMigrationBaseline(
  canonicalRoot: string,
  relativeRoot: string,
  baselineRecords: ReadonlyMap<string, LegacyMessageSummary>
): Promise<void> {
  const root = await storageDirectoryBoundary(canonicalRoot, relativeRoot);
  if (!root.exists) throw new Error('message_ledger_migration_record_tree_missing');
  for (const [messageId, baseline] of baselineRecords) {
    const identity = messageStorageIdentity(messageId);
    const relativePath = `${relativeRoot}/${identity.slice(0, 2)}/${identity}.json`;
    const currentRecord = await readRecordAt(canonicalRoot, relativePath, messageId);
    if (!currentRecord) throw new Error('message_ledger_migration_baseline_missing');
    const current = legacyMessageSummary(currentRecord);
    if (current.final_record_digest === baseline.final_record_digest) continue;
    if (current.state === baseline.state) {
      throw new Error('message_ledger_migration_baseline_changed');
    }
    try {
      assertLegacySummaryProgression(baseline, current);
    } catch (error) {
      throw new Error('message_ledger_migration_baseline_changed', { cause: error });
    }
  }
}

export async function migrateLegacyMessageLedger(rootPath: string): Promise<LegacyMessageLedgerMigrationResult> {
  const canonicalRoot = await canonicalProjectRoot(rootPath);
  return withLegacyMigrationLock(canonicalRoot, async () => {
    let manifest = await readMigrationManifest(canonicalRoot);
    const completionReceipt = await readMigrationReceipt(canonicalRoot);
    if (manifest && completionReceipt && !sameMigrationMetadata(manifest, completionReceipt)) {
      throw new Error('message_ledger_migration_manifest_receipt_conflict');
    }
    let resumed = Boolean(manifest);
    let legacy = await projectStorageFileBoundary(canonicalRoot, PROJECT_STORAGE.messageDeliveryLegacy);
    let backup = await projectStorageFileBoundary(canonicalRoot, PROJECT_STORAGE.messageDeliveryLegacyBackup);
    let staging = await storageDirectoryBoundary(canonicalRoot, PROJECT_STORAGE.messageDeliveryMigrationStagingRoot);
    let final = await storageDirectoryBoundary(canonicalRoot, PROJECT_STORAGE.messageDeliveryRoot);
    const retiredRelative = `${PROJECT_STORAGE.messageDeliveryMigrationManifest}.retired`;
    const retired = await projectStorageFileBoundary(canonicalRoot, retiredRelative);
    if (!manifest && retired.exists) {
      const retiredMetadata = await readMigrationMetadata(
        canonicalRoot,
        retiredRelative,
        'message_ledger_migration_retired_manifest_fail_closed'
      );
      if (!completionReceipt || !sameMigrationMetadata(retiredMetadata, completionReceipt)) {
        throw new Error('message_ledger_migration_recovery_required');
      }
      await unlinkOwnedTemporary(canonicalRoot, retired.filePath);
      await syncDirectory(path.dirname(retired.filePath));
    }
    if (!manifest && !legacy.exists) {
      if (staging.exists) throw new Error('message_ledger_migration_orphan_staging');
      if (backup.exists || completionReceipt) {
        if (!backup.exists || !final.exists || !completionReceipt) {
          throw new Error('message_ledger_migration_recovery_required');
        }
        const baselineRecords = await materializeLegacyMigrationRecords(canonicalRoot, completionReceipt, false);
        await verifyCompletedMigrationBaseline(canonicalRoot, completionReceipt.final_relative_root, baselineRecords);
        return {
          status: 'not_required', no_data_loss: true,
          backup_path: backup.filePath,
          legacy_sha256: completionReceipt.legacy_sha256,
          final_records_sha256: completionReceipt.final_records_sha256,
          message_count: completionReceipt.message_count
        };
      }
      return {
        status: 'not_required', no_data_loss: true,
        backup_path: null,
        legacy_sha256: null, final_records_sha256: null, message_count: 0
      };
    }
    if (!manifest) {
      if (backup.exists || staging.exists || final.exists || completionReceipt) {
        throw new Error('message_ledger_migration_destination_conflict');
      }
      const inspection = await inspectLegacyMessageLedgerMigration(canonicalRoot);
      if (inspection.status !== 'ready' || !inspection.legacy_sha256 || !inspection.final_records_sha256) {
        throw Object.assign(new Error('message_ledger_legacy_not_migratable'), { inspection });
      }
      manifest = {
        schema_version: 1,
        legacy_sha256: inspection.legacy_sha256,
        final_records_sha256: inspection.final_records_sha256,
        byte_count: inspection.byte_count,
        line_count: inspection.line_count,
        message_count: inspection.message_count,
        backup_relative_path: PROJECT_STORAGE.messageDeliveryLegacyBackup,
        staging_relative_root: PROJECT_STORAGE.messageDeliveryMigrationStagingRoot,
        final_relative_root: PROJECT_STORAGE.messageDeliveryRoot
      };
      await writeMigrationManifest(canonicalRoot, manifest);
      resumed = false;
    }
    legacy = await projectStorageFileBoundary(canonicalRoot, PROJECT_STORAGE.messageDeliveryLegacy);
    backup = await projectStorageFileBoundary(canonicalRoot, manifest.backup_relative_path);
    if (legacy.exists && backup.exists) throw new Error('message_ledger_migration_dual_legacy_authority');
    if (legacy.exists) {
      const inspection = await inspectLegacyMessageLedgerMigration(canonicalRoot);
      if (!sameMigrationInspection(inspection, manifest)) {
        throw new Error('message_ledger_migration_source_changed');
      }
      await renameOperational(legacy.filePath, backup.filePath);
      await syncDirectory(path.dirname(backup.filePath));
      backup = await projectStorageFileBoundary(canonicalRoot, manifest.backup_relative_path);
    }
    if (!backup.exists) throw new Error('message_ledger_migration_backup_missing');
    staging = await storageDirectoryBoundary(canonicalRoot, manifest.staging_relative_root);
    final = await storageDirectoryBoundary(canonicalRoot, manifest.final_relative_root);
    if (staging.exists && final.exists) throw new Error('message_ledger_migration_dual_record_authority');
    const expectedDigests = await materializeLegacyMigrationRecords(canonicalRoot, manifest, !final.exists);
    if (!final.exists) {
      await verifyMigrationRecordTree(canonicalRoot, manifest.staging_relative_root, expectedDigests);
      staging = await storageDirectoryBoundary(canonicalRoot, manifest.staging_relative_root);
      final = await storageDirectoryBoundary(canonicalRoot, manifest.final_relative_root);
      if (!staging.exists || final.exists) throw new Error('message_ledger_migration_cutover_conflict');
      await renameOperational(staging.directoryPath, final.directoryPath);
      await syncDirectory(path.dirname(final.directoryPath));
    }
    await verifyMigrationRecordTree(canonicalRoot, manifest.final_relative_root, expectedDigests);
    await writeMigrationReceipt(canonicalRoot, manifest);
    await retireMigrationManifestExact(canonicalRoot, manifest);
    return {
      status: resumed ? 'resumed' : 'completed',
      no_data_loss: true,
      backup_path: backup.filePath,
      legacy_sha256: manifest.legacy_sha256,
      final_records_sha256: manifest.final_records_sha256,
      message_count: manifest.message_count
    };
  });
}
