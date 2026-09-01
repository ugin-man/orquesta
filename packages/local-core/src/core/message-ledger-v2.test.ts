import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import {
  MessageLedger,
  inspectLegacyMessageLedgerMigration,
  legacyMessageLedgerPath,
  migrateLegacyMessageLedger,
  messageLedgerLockPath,
  messageLedgerPath,
  messageLedgerPendingPath
} from './message-ledger-v2';
import { verifyTargetIgnoresMalformedSiblings } from '../../test-support/message-ledger-v2-scale';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(prefix = 'orquesta-message-ledger-v2-'): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function base(rootPath: string, messageId = 'message-1') {
  return {
    rootPath,
    messageId,
    actionFingerprint: 'a'.repeat(64),
    correlationId: messageId,
    projectId: 'project-1',
    targetAgentId: 'orchestrator'
  };
}

function recordDigest(record: unknown): string {
  return createHash('sha256')
    .update('orquesta.message-delivery-record.v1\0', 'utf8')
    .update(JSON.stringify(record), 'utf8')
    .digest('hex');
}

function legacyRecord(input: ReturnType<typeof base>, state: string, observedAt: string, threadId: string | null, turnId: string | null) {
  return {
    schema_version: 3,
    message_id: input.messageId,
    action_fingerprint: input.actionFingerprint,
    correlation_id: input.correlationId,
    project_id: input.projectId,
    target_agent_id: input.targetAgentId,
    thread_id: threadId,
    turn_id: turnId,
    state,
    observed_at: observedAt,
    error_code: null
  };
}

function migrationPaths(rootPath: string) {
  const stateRoot = path.join(rootPath, '.orquesta', 'state');
  return {
    legacy: path.join(stateRoot, 'messages.jsonl'),
    backup: path.join(stateRoot, 'messages.migrated-v1.jsonl'),
    manifest: path.join(stateRoot, 'message-delivery-migration-v1.json'),
    receipt: path.join(stateRoot, 'message-delivery-migration-v1.completed.json'),
    retired: path.join(stateRoot, 'message-delivery-migration-v1.json.retired'),
    staging: path.join(stateRoot, 'message-delivery-v1.migrating'),
    final: path.join(stateRoot, 'message-delivery-v1')
  };
}

function migrationManifest(inspection: Awaited<ReturnType<typeof inspectLegacyMessageLedgerMigration>>) {
  if (!inspection.legacy_sha256 || !inspection.final_records_sha256) throw new Error('test_migration_not_ready');
  return {
    schema_version: 1,
    legacy_sha256: inspection.legacy_sha256,
    final_records_sha256: inspection.final_records_sha256,
    byte_count: inspection.byte_count,
    line_count: inspection.line_count,
    message_count: inspection.message_count,
    backup_relative_path: 'state/messages.migrated-v1.jsonl',
    staging_relative_root: 'state/message-delivery-v1.migrating',
    final_relative_root: 'state/message-delivery-v1'
  };
}

function stagedMessagePath(rootPath: string, messageId: string): string {
  const paths = migrationPaths(rootPath);
  const relative = path.relative(paths.final, messageLedgerPath(rootPath, messageId));
  return path.join(paths.staging, relative);
}

async function expectCompletedMigrationResidue(rootPath: string): Promise<void> {
  const paths = migrationPaths(rootPath);
  await expect(access(paths.receipt)).resolves.toBeUndefined();
  await expect(access(paths.manifest)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(access(paths.retired)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(access(paths.staging)).rejects.toMatchObject({ code: 'ENOENT' });
}

describe('MessageLedger fixed per-message authority', () => {
  test('replaces one bounded record through monotonic delivery states', async () => {
    const rootPath = await project();
    const ledger = new MessageLedger({ now: () => new Date('2026-08-02T00:00:00.000Z') });
    const input = base(rootPath);

    await expect(ledger.record({ ...input, threadId: null, turnId: null, state: 'queued' })).resolves.toBe(true);
    await expect(ledger.record({ ...input, threadId: 'thread-1', turnId: null, state: 'thread_ready' })).resolves.toBe(true);
    await expect(ledger.record({ ...input, threadId: 'thread-1', turnId: null, state: 'turn_starting' })).resolves.toBe(true);
    await expect(ledger.record({ ...input, threadId: 'thread-1', turnId: 'turn-1', state: 'turn_started' })).resolves.toBe(true);
    await expect(ledger.record({ ...input, threadId: 'thread-1', turnId: 'turn-1', state: 'dispatch_accepted' })).resolves.toBe(false);
    await expect(ledger.record({ ...input, threadId: 'thread-1', turnId: 'turn-1', state: 'completed' })).resolves.toBe(true);
    await expect(ledger.record({ ...input, threadId: 'thread-1', turnId: 'turn-1', state: 'failed', errorCode: 'late_failure' }))
      .rejects.toThrow('message_ledger_state_conflict');

    const source = await readFile(messageLedgerPath(rootPath, input.messageId), 'utf8');
    const record = JSON.parse(source);
    expect(record.state).toBe('completed');
    expect(record.schema_version).toBe(3);
    expect(source).not.toContain('prompt');
    expect(source).not.toContain('message body');
    await expect(ledger.read({ rootPath, messageId: input.messageId })).resolves.toEqual(record);
  });

  test('allows exactly one first claim across independent store instances', async () => {
    const rootPath = await project();
    const input = { ...base(rootPath), threadId: null, turnId: null, state: 'queued' as const };
    const results = await Promise.all([
      new MessageLedger().record(input),
      new MessageLedger().record(input)
    ]);
    expect(results.sort()).toEqual([false, true]);
    expect((await new MessageLedger().read({ rootPath, messageId: input.messageId }))?.state).toBe('queued');
  });

  test('rejects lifecycle jumps instead of treating rank as transition authority', async () => {
    const rootPath = await project();
    const input = base(rootPath, 'message-transition');
    const ledger = new MessageLedger();
    await ledger.record({ ...input, threadId: null, turnId: null, state: 'queued' });
    await expect(ledger.record({
      ...input,
      threadId: 'thread-jump',
      turnId: 'turn-jump',
      state: 'completed'
    })).rejects.toThrow('message_ledger_transition_invalid');
    await expect(ledger.read({ rootPath, messageId: input.messageId }))
      .resolves.toMatchObject({ state: 'queued' });
  });

  test('rehydrates terminal state and rejects identity changes', async () => {
    const rootPath = await project();
    const input = {
      ...base(rootPath, 'message-2'),
      threadId: 'thread-2',
      turnId: 'turn-2',
      state: 'completed' as const
    };
    await new MessageLedger().record({
      ...input,
      threadId: null,
      turnId: null,
      state: 'queued'
    });
    await new MessageLedger().record({ ...input, turnId: null, state: 'thread_ready' });
    await new MessageLedger().record({ ...input, turnId: null, state: 'turn_starting' });
    await new MessageLedger().record(input);
    await expect(new MessageLedger().record(input)).resolves.toBe(false);
    await expect(new MessageLedger().record({ ...input, projectId: 'project-other' }))
      .rejects.toThrow('message_ledger_identity_conflict');
    await expect(new MessageLedger().record({ ...input, state: 'failed', errorCode: null }))
      .rejects.toThrow('message_ledger_record_invalid');
  });

  test('recovers one identity-bound pending transition and keeps locks outside canonical state', async () => {
    const rootPath = await project();
    const input = base(rootPath, 'message-recovery');
    const ledger = new MessageLedger({ now: () => new Date('2026-08-24T08:00:00.000Z') });
    await ledger.record({ ...input, threadId: null, turnId: null, state: 'queued' });
    const pending = {
      schema_version: 3,
      message_id: input.messageId,
      action_fingerprint: input.actionFingerprint,
      correlation_id: input.correlationId,
      project_id: input.projectId,
      target_agent_id: input.targetAgentId,
      thread_id: 'thread-recovery',
      turn_id: null,
      state: 'thread_ready',
      observed_at: '2026-08-24T08:01:00.000Z',
      error_code: null
    };
    const current = JSON.parse(await readFile(messageLedgerPath(rootPath, input.messageId), 'utf8'));
    await writeFile(messageLedgerPendingPath(rootPath, input.messageId), `${JSON.stringify({
      schema_version: 1,
      message_id: input.messageId,
      previous_digest: recordDigest(current),
      next_digest: recordDigest(pending),
      next_record: pending
    })}\n`, 'utf8');

    await expect(new MessageLedger().read({ rootPath, messageId: input.messageId })).resolves.toEqual(pending);
    await expect(access(messageLedgerPendingPath(rootPath, input.messageId))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(messageLedgerLockPath(rootPath, input.messageId))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(path.dirname(messageLedgerPath(rootPath, input.messageId))))
      .some((name) => name.endsWith('.lock') || name.includes('.candidate-'))).toBe(false);
  });

  test('does not let recovery bypass the normal delivery transition matrix', async () => {
    const rootPath = await project('orquesta-message-ledger-v2-recovery-invalid-');
    const input = base(rootPath, 'message-invalid-recovery');
    const ledger = new MessageLedger({ now: () => new Date('2026-08-24T08:00:00.000Z') });
    await ledger.record({ ...input, threadId: null, turnId: null, state: 'queued' });
    const current = JSON.parse(await readFile(messageLedgerPath(rootPath, input.messageId), 'utf8'));
    const invalidNext = {
      ...current,
      thread_id: 'thread-invalid',
      turn_id: 'turn-invalid',
      state: 'completed',
      observed_at: '2026-08-24T08:01:00.000Z'
    };
    await writeFile(messageLedgerPendingPath(rootPath, input.messageId), `${JSON.stringify({
      schema_version: 1,
      message_id: input.messageId,
      previous_digest: recordDigest(current),
      next_digest: recordDigest(invalidNext),
      next_record: invalidNext
    })}\n`, 'utf8');
    await expect(new MessageLedger().read({ rootPath, messageId: input.messageId }))
      .rejects.toThrow('message_ledger_transition_invalid');
    expect(JSON.parse(await readFile(messageLedgerPath(rootPath, input.messageId), 'utf8')).state).toBe('queued');
  });

  test('fails closed on malformed, legacy, and linked storage authority', async () => {
    const malformedRoot = await project('orquesta-message-ledger-v2-malformed-');
    const malformedPath = messageLedgerPath(malformedRoot, 'message-unsafe');
    await mkdir(path.dirname(malformedPath), { recursive: true });
    await writeFile(malformedPath, '{"schema_version":3', 'utf8');
    await expect(new MessageLedger().read({ rootPath: malformedRoot, messageId: 'message-unsafe' }))
      .rejects.toThrow('message_ledger_malformed_fail_closed');

    const legacyRoot = await project('orquesta-message-ledger-v2-legacy-');
    await mkdir(path.dirname(legacyMessageLedgerPath(legacyRoot)), { recursive: true });
    await writeFile(legacyMessageLedgerPath(legacyRoot), '{}\n', 'utf8');
    await expect(new MessageLedger().record({
      ...base(legacyRoot), threadId: null, turnId: null, state: 'queued'
    })).rejects.toThrow('message_ledger_legacy_migration_required');

    const linkedRoot = await project('orquesta-message-ledger-v2-linked-');
    const outside = await project('orquesta-message-ledger-v2-outside-');
    await mkdir(path.join(linkedRoot, '.orquesta', 'state'), { recursive: true });
    await symlink(outside, path.join(linkedRoot, '.orquesta', 'state', 'message-delivery-v1'));
    await expect(new MessageLedger().record({
      ...base(linkedRoot), threadId: null, turnId: null, state: 'queued'
    })).rejects.toThrow('project_storage_directory_unsafe');
  });

  test('inspects a migratable legacy ledger without writing fixed records, locks, or backups', async () => {
    const rootPath = await project('orquesta-message-ledger-v2-migration-ready-');
    const input = base(rootPath, 'message-migration');
    const legacyPath = legacyMessageLedgerPath(rootPath);
    await mkdir(path.dirname(legacyPath), { recursive: true });
    const records = [
      legacyRecord(input, 'queued', '2026-08-24T01:00:00.000Z', null, null),
      legacyRecord(input, 'thread_ready', '2026-08-24T01:00:01.000Z', 'thread-migration', null),
      legacyRecord(input, 'turn_starting', '2026-08-24T01:00:02.000Z', 'thread-migration', null),
      legacyRecord(input, 'dispatch_accepted', '2026-08-24T01:00:03.000Z', 'thread-migration', 'turn-migration')
    ];
    await writeFile(legacyPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');

    const inspected = await inspectLegacyMessageLedgerMigration(rootPath);
    expect(inspected).toMatchObject({
      status: 'ready', no_write: true, line_count: 4, message_count: 1, issues: []
    });
    expect(inspected.legacy_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(inspected.final_records_sha256).toMatch(/^[a-f0-9]{64}$/u);
    await expect(access(path.join(rootPath, '.orquesta', 'state', 'message-delivery-v1')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(path.join(rootPath, '.orquesta', 'runtime', 'message-ledger-v1')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(new MessageLedger().read({ rootPath, messageId: input.messageId }))
      .rejects.toThrow('message_ledger_legacy_migration_required');
  });

  test('blocks legacy schema and identity conflicts instead of preparing a partial migration', async () => {
    const legacyRoot = await project('orquesta-message-ledger-v2-migration-legacy-schema-');
    const legacyPath = legacyMessageLedgerPath(legacyRoot);
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await writeFile(legacyPath, `${JSON.stringify({
      schema_version: 1,
      message_id: 'legacy-message',
      state: 'queued'
    })}\n`, 'utf8');
    await expect(inspectLegacyMessageLedgerMigration(legacyRoot)).resolves.toMatchObject({
      status: 'blocked', no_write: true, message_count: 0,
      issues: [{ line: 1, code: 'legacy_record_not_migratable' }]
    });

    const conflictRoot = await project('orquesta-message-ledger-v2-migration-conflict-');
    const input = base(conflictRoot, 'message-conflict');
    const conflictPath = legacyMessageLedgerPath(conflictRoot);
    await mkdir(path.dirname(conflictPath), { recursive: true });
    const first = legacyRecord(input, 'queued', '2026-08-24T01:00:00.000Z', null, null);
    const conflicting = { ...first, project_id: 'project-other', observed_at: '2026-08-24T01:00:01.000Z' };
    await writeFile(conflictPath, `${JSON.stringify(first)}\n${JSON.stringify(conflicting)}\n`, 'utf8');
    await expect(inspectLegacyMessageLedgerMigration(conflictRoot)).resolves.toMatchObject({
      status: 'blocked', no_write: true, message_count: 1,
      issues: [{ line: 2, code: 'legacy_record_sequence_conflict' }]
    });
  });

  test('accepts a forward failure but rejects terminal failure error drift', async () => {
    const readyRoot = await project('orquesta-message-ledger-v2-migration-forward-failure-');
    const readyInput = base(readyRoot, 'message-forward-failure');
    const readyPath = legacyMessageLedgerPath(readyRoot);
    await mkdir(path.dirname(readyPath), { recursive: true });
    const queued = legacyRecord(readyInput, 'queued', '2026-08-24T01:00:00.000Z', null, null);
    const failed = {
      ...legacyRecord(readyInput, 'failed', '2026-08-24T01:00:01.000Z', null, null),
      error_code: 'provider_unavailable'
    };
    await writeFile(readyPath, `${JSON.stringify(queued)}\n${JSON.stringify(failed)}\n`, 'utf8');
    await expect(inspectLegacyMessageLedgerMigration(readyRoot)).resolves.toMatchObject({
      status: 'ready', message_count: 1, issues: []
    });

    const driftRoot = await project('orquesta-message-ledger-v2-migration-failure-drift-');
    const driftInput = base(driftRoot, 'message-failure-drift');
    const driftPath = legacyMessageLedgerPath(driftRoot);
    await mkdir(path.dirname(driftPath), { recursive: true });
    const firstFailure = {
      ...legacyRecord(driftInput, 'failed', '2026-08-24T01:00:00.000Z', null, null),
      error_code: 'provider_unavailable'
    };
    const changedFailure = {
      ...firstFailure,
      observed_at: '2026-08-24T01:00:01.000Z',
      error_code: 'different_error'
    };
    await writeFile(driftPath, `${JSON.stringify(firstFailure)}\n${JSON.stringify(changedFailure)}\n`, 'utf8');
    await expect(inspectLegacyMessageLedgerMigration(driftRoot)).resolves.toMatchObject({
      status: 'blocked', message_count: 1,
      issues: [{ line: 2, code: 'legacy_record_sequence_conflict' }]
    });
  });

  test('fails closed on invalid UTF-8 even when replacement text would be valid JSON data', async () => {
    const rootPath = await project('orquesta-message-ledger-v2-migration-invalid-utf8-');
    const legacyPath = legacyMessageLedgerPath(rootPath);
    await mkdir(path.dirname(legacyPath), { recursive: true });
    const record = legacyRecord(base(rootPath, 'message-invalid-utf8'), 'queued', '2026-08-24T01:00:00.000Z', null, null);
    const source = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
    const marker = Buffer.from('message-invalid-utf8', 'utf8');
    const markerIndex = source.indexOf(marker);
    source[markerIndex + 1] = 0xff;
    await writeFile(legacyPath, source);

    await expect(inspectLegacyMessageLedgerMigration(rootPath)).resolves.toMatchObject({
      status: 'blocked', no_write: true, message_count: 0,
      issues: [{ line: 1, code: 'legacy_record_json_invalid' }]
    });
  });

  test('blocks before a compact migration summary can exceed its bounded resident budget', async () => {
    const rootPath = await project('orquesta-message-ledger-v2-migration-memory-bound-');
    const legacyPath = legacyMessageLedgerPath(rootPath);
    await mkdir(path.dirname(legacyPath), { recursive: true });
    const lines = Array.from({ length: 8 }, (_, index) => {
      const input = {
        ...base(rootPath, `message-${index}-${'m'.repeat(480)}`),
        correlationId: `correlation-${index}-${'c'.repeat(480)}`,
        projectId: `project-${index}-${'p'.repeat(480)}`,
        targetAgentId: `agent-${index}-${'a'.repeat(480)}`
      };
      return JSON.stringify(legacyRecord(input, 'queued', '2026-08-24T01:00:00.000Z', null, null));
    });
    await writeFile(legacyPath, `${lines.join('\n')}\n`, 'utf8');

    const inspected = await inspectLegacyMessageLedgerMigration(rootPath, { maxResidentBytes: 4096 });
    expect(inspected).toMatchObject({
      status: 'blocked', no_write: true, resident_byte_limit: 4096,
      issues: [{ line: 3, code: 'legacy_resident_memory_limit_exceeded' }]
    });
    expect(inspected.estimated_resident_bytes).toBeLessThanOrEqual(4096);
    expect(inspected.message_count).toBe(2);
  });

  test('explicitly backs up, verifies, and atomically cuts a legacy ledger to fixed records', async () => {
    const rootPath = await project('orquesta-message-ledger-v2-explicit-migration-');
    const input = base(rootPath, 'message-explicit-migration');
    const legacyPath = legacyMessageLedgerPath(rootPath);
    await mkdir(path.dirname(legacyPath), { recursive: true });
    const records = [
      legacyRecord(input, 'queued', '2026-08-24T01:00:00.000Z', null, null),
      legacyRecord(input, 'thread_ready', '2026-08-24T01:00:01.000Z', 'thread-explicit', null),
      legacyRecord(input, 'turn_starting', '2026-08-24T01:00:02.000Z', 'thread-explicit', null),
      legacyRecord(input, 'dispatch_accepted', '2026-08-24T01:00:03.000Z', 'thread-explicit', 'turn-explicit')
    ];
    const source = `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
    await writeFile(legacyPath, source, 'utf8');

    const migrated = await migrateLegacyMessageLedger(rootPath);
    expect(migrated).toMatchObject({
      status: 'completed', no_data_loss: true, message_count: 1
    });
    await expect(access(legacyPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const backupPath = path.join(rootPath, '.orquesta', 'state', 'messages.migrated-v1.jsonl');
    await expect(readFile(backupPath, 'utf8')).resolves.toBe(source);
    await expect(access(path.join(rootPath, '.orquesta', 'state', 'message-delivery-migration-v1.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(path.join(rootPath, '.orquesta', 'state', 'message-delivery-migration-v1.completed.json')))
      .resolves.toBeUndefined();
    await expect(access(path.join(rootPath, '.orquesta', 'state', 'message-delivery-v1.migrating')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(new MessageLedger().read({ rootPath, messageId: input.messageId })).resolves.toMatchObject({
      state: 'dispatch_accepted', thread_id: 'thread-explicit', turn_id: 'turn-explicit'
    });
    await expect(migrateLegacyMessageLedger(rootPath)).resolves.toMatchObject({
      status: 'not_required', no_data_loss: true, backup_path: backupPath
    });
  });

  test('treats a completion receipt as migration proof while allowing valid later ledger progress', async () => {
    const rootPath = await project('orquesta-message-ledger-v2-live-after-migration-');
    const migratedInput = base(rootPath, 'message-migrated-and-advanced');
    const paths = migrationPaths(rootPath);
    await mkdir(path.dirname(paths.legacy), { recursive: true });
    const source = `${JSON.stringify(legacyRecord(
      migratedInput, 'queued', '2026-08-24T01:00:00.000Z', null, null
    ))}\n`;
    await writeFile(paths.legacy, source, 'utf8');
    await migrateLegacyMessageLedger(rootPath);

    const ledger = new MessageLedger({ now: () => new Date('2026-08-24T01:00:02.000Z') });
    await expect(ledger.record({
      ...migratedInput, threadId: 'thread-after-migration', turnId: null, state: 'thread_ready'
    })).resolves.toBe(true);
    const newInput = base(rootPath, 'message-created-after-migration');
    await expect(ledger.record({ ...newInput, threadId: null, turnId: null, state: 'queued' })).resolves.toBe(true);

    await expect(migrateLegacyMessageLedger(rootPath)).resolves.toMatchObject({
      status: 'not_required', no_data_loss: true, message_count: 1
    });
    await expect(readFile(paths.backup, 'utf8')).resolves.toBe(source);
    await expect(ledger.read({ rootPath, messageId: migratedInput.messageId }))
      .resolves.toMatchObject({ state: 'thread_ready', thread_id: 'thread-after-migration' });
    await expect(ledger.read({ rootPath, messageId: newInput.messageId }))
      .resolves.toMatchObject({ state: 'queued' });
    await expectCompletedMigrationResidue(rootPath);
  });

  test('resumes every durable pre-cutover boundary without changing backup bytes', async () => {
    const manifestLegacyRoot = await project('orquesta-message-ledger-v2-resume-manifest-legacy-');
    const manifestLegacyInput = base(manifestLegacyRoot, 'message-manifest-legacy');
    const manifestLegacyPaths = migrationPaths(manifestLegacyRoot);
    await mkdir(path.dirname(manifestLegacyPaths.legacy), { recursive: true });
    const manifestLegacySource = `${JSON.stringify(legacyRecord(
      manifestLegacyInput, 'queued', '2026-08-24T01:00:00.000Z', null, null
    ))}\n`;
    await writeFile(manifestLegacyPaths.legacy, manifestLegacySource, 'utf8');
    const manifestLegacyInspection = await inspectLegacyMessageLedgerMigration(manifestLegacyRoot);
    await writeFile(manifestLegacyPaths.manifest, `${JSON.stringify(migrationManifest(manifestLegacyInspection))}\n`, 'utf8');
    await expect(migrateLegacyMessageLedger(manifestLegacyRoot)).resolves.toMatchObject({ status: 'resumed' });
    await expect(readFile(manifestLegacyPaths.backup, 'utf8')).resolves.toBe(manifestLegacySource);
    await expectCompletedMigrationResidue(manifestLegacyRoot);

    const partialRoot = await project('orquesta-message-ledger-v2-resume-partial-staging-');
    const partialA = base(partialRoot, 'message-partial-a');
    const partialB = base(partialRoot, 'message-partial-b');
    const partialPaths = migrationPaths(partialRoot);
    await mkdir(path.dirname(partialPaths.legacy), { recursive: true });
    const partialRecords = [
      legacyRecord(partialA, 'queued', '2026-08-24T01:00:00.000Z', null, null),
      legacyRecord(partialB, 'queued', '2026-08-24T01:00:01.000Z', null, null)
    ];
    const partialSource = `${partialRecords.map((record) => JSON.stringify(record)).join('\n')}\n`;
    await writeFile(partialPaths.legacy, partialSource, 'utf8');
    const partialInspection = await inspectLegacyMessageLedgerMigration(partialRoot);
    await writeFile(partialPaths.manifest, `${JSON.stringify(migrationManifest(partialInspection))}\n`, 'utf8');
    await rename(partialPaths.legacy, partialPaths.backup);
    const partialRecordPath = stagedMessagePath(partialRoot, partialA.messageId);
    await mkdir(path.dirname(partialRecordPath), { recursive: true });
    await writeFile(partialRecordPath, `${JSON.stringify(partialRecords[0])}\n`, 'utf8');
    await writeFile(`${partialRecordPath}.migration-commit`, 'stale-partial-commit', 'utf8');
    await expect(migrateLegacyMessageLedger(partialRoot)).resolves.toMatchObject({
      status: 'resumed', message_count: 2
    });
    await expect(readFile(partialPaths.backup, 'utf8')).resolves.toBe(partialSource);
    await expectCompletedMigrationResidue(partialRoot);
  });

  test('resumes final-tree and retired-manifest crash boundaries and rejects receipt conflict', async () => {
    const finalRoot = await project('orquesta-message-ledger-v2-resume-final-tree-');
    const finalInput = base(finalRoot, 'message-final-tree');
    const finalPaths = migrationPaths(finalRoot);
    await mkdir(path.dirname(finalPaths.legacy), { recursive: true });
    const finalRecord = legacyRecord(finalInput, 'queued', '2026-08-24T01:00:00.000Z', null, null);
    const finalSource = `${JSON.stringify(finalRecord)}\n`;
    await writeFile(finalPaths.legacy, finalSource, 'utf8');
    const finalInspection = await inspectLegacyMessageLedgerMigration(finalRoot);
    const finalManifest = migrationManifest(finalInspection);
    await writeFile(finalPaths.manifest, `${JSON.stringify(finalManifest)}\n`, 'utf8');
    await rename(finalPaths.legacy, finalPaths.backup);
    const finalMessagePath = messageLedgerPath(finalRoot, finalInput.messageId);
    await mkdir(path.dirname(finalMessagePath), { recursive: true });
    await writeFile(finalMessagePath, `${JSON.stringify(finalRecord)}\n`, 'utf8');
    await expect(migrateLegacyMessageLedger(finalRoot)).resolves.toMatchObject({ status: 'resumed' });
    await expect(readFile(finalPaths.backup, 'utf8')).resolves.toBe(finalSource);
    await expectCompletedMigrationResidue(finalRoot);

    const receiptSource = await readFile(finalPaths.receipt, 'utf8');
    await writeFile(finalPaths.retired, receiptSource, 'utf8');
    await expect(migrateLegacyMessageLedger(finalRoot)).resolves.toMatchObject({ status: 'not_required' });
    await expect(readFile(finalPaths.backup, 'utf8')).resolves.toBe(finalSource);
    await expectCompletedMigrationResidue(finalRoot);

    const conflictRoot = await project('orquesta-message-ledger-v2-manifest-receipt-conflict-');
    const conflictInput = base(conflictRoot, 'message-conflict');
    const conflictPaths = migrationPaths(conflictRoot);
    await mkdir(path.dirname(conflictPaths.legacy), { recursive: true });
    const conflictRecord = legacyRecord(conflictInput, 'queued', '2026-08-24T01:00:00.000Z', null, null);
    const conflictSource = `${JSON.stringify(conflictRecord)}\n`;
    await writeFile(conflictPaths.legacy, conflictSource, 'utf8');
    const conflictInspection = await inspectLegacyMessageLedgerMigration(conflictRoot);
    const conflictManifest = migrationManifest(conflictInspection);
    await writeFile(conflictPaths.manifest, `${JSON.stringify(conflictManifest)}\n`, 'utf8');
    await writeFile(conflictPaths.receipt, `${JSON.stringify({
      ...conflictManifest, legacy_sha256: 'f'.repeat(64)
    })}\n`, 'utf8');
    await expect(migrateLegacyMessageLedger(conflictRoot)).rejects.toThrow(
      'message_ledger_migration_manifest_receipt_conflict'
    );
    await expect(readFile(conflictPaths.legacy, 'utf8')).resolves.toBe(conflictSource);
    await expect(access(conflictPaths.backup)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(conflictPaths.final)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('resumes from an immutable manifest and backup without requiring the old live path', async () => {
    const rootPath = await project('orquesta-message-ledger-v2-resume-migration-');
    const input = base(rootPath, 'message-resume-migration');
    const legacyPath = legacyMessageLedgerPath(rootPath);
    await mkdir(path.dirname(legacyPath), { recursive: true });
    const records = [
      legacyRecord(input, 'queued', '2026-08-24T01:00:00.000Z', null, null),
      legacyRecord(input, 'thread_ready', '2026-08-24T01:00:01.000Z', 'thread-resume', null)
    ];
    await writeFile(legacyPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
    const inspection = await inspectLegacyMessageLedgerMigration(rootPath);
    const manifestPath = path.join(rootPath, '.orquesta', 'state', 'message-delivery-migration-v1.json');
    const backupPath = path.join(rootPath, '.orquesta', 'state', 'messages.migrated-v1.jsonl');
    await writeFile(manifestPath, `${JSON.stringify({
      schema_version: 1,
      legacy_sha256: inspection.legacy_sha256,
      final_records_sha256: inspection.final_records_sha256,
      byte_count: inspection.byte_count,
      line_count: inspection.line_count,
      message_count: inspection.message_count,
      backup_relative_path: 'state/messages.migrated-v1.jsonl',
      staging_relative_root: 'state/message-delivery-v1.migrating',
      final_relative_root: 'state/message-delivery-v1'
    })}\n`, 'utf8');
    await rename(legacyPath, backupPath);

    await expect(migrateLegacyMessageLedger(rootPath)).resolves.toMatchObject({
      status: 'resumed', no_data_loss: true, message_count: 1
    });
    await expect(new MessageLedger().read({ rootPath, messageId: input.messageId }))
      .resolves.toMatchObject({ state: 'thread_ready', thread_id: 'thread-resume' });
  });

  test('leaves an unmigratable legacy ledger untouched and creates no partial authority', async () => {
    const rootPath = await project('orquesta-message-ledger-v2-blocked-migration-');
    const legacyPath = legacyMessageLedgerPath(rootPath);
    await mkdir(path.dirname(legacyPath), { recursive: true });
    const source = '{"schema_version":1,"message_id":"unknown-identity","state":"queued"}\n';
    await writeFile(legacyPath, source, 'utf8');

    await expect(migrateLegacyMessageLedger(rootPath)).rejects.toMatchObject({
      message: 'message_ledger_legacy_not_migratable'
    });
    await expect(readFile(legacyPath, 'utf8')).resolves.toBe(source);
    await expect(access(path.join(rootPath, '.orquesta', 'state', 'messages.migrated-v1.jsonl')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(path.join(rootPath, '.orquesta', 'state', 'message-delivery-migration-v1.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(path.join(rootPath, '.orquesta', 'state', 'message-delivery-migration-v1.completed.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(path.join(rootPath, '.orquesta', 'state', 'message-delivery-v1')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('fails closed when only a backup or an unreceipted backup/final pair remains', async () => {
    const backupOnlyRoot = await project('orquesta-message-ledger-v2-backup-only-');
    const backupOnly = path.join(backupOnlyRoot, '.orquesta', 'state', 'messages.migrated-v1.jsonl');
    await mkdir(path.dirname(backupOnly), { recursive: true });
    await writeFile(backupOnly, '{}\n', 'utf8');
    await expect(migrateLegacyMessageLedger(backupOnlyRoot)).rejects.toThrow(
      'message_ledger_migration_recovery_required'
    );

    const unreceiptedRoot = await project('orquesta-message-ledger-v2-unreceipted-final-');
    const backup = path.join(unreceiptedRoot, '.orquesta', 'state', 'messages.migrated-v1.jsonl');
    await mkdir(path.dirname(backup), { recursive: true });
    await mkdir(path.join(unreceiptedRoot, '.orquesta', 'state', 'message-delivery-v1'), { recursive: true });
    await writeFile(backup, '{}\n', 'utf8');
    await expect(migrateLegacyMessageLedger(unreceiptedRoot)).rejects.toThrow(
      'message_ledger_migration_recovery_required'
    );
  });

  test('reads and advances one target without scanning 64 malformed siblings', async () => {
    await verifyTargetIgnoresMalformedSiblings(64);
  });

  test('uses a distinct process lock identity for each message', async () => {
    const rootPath = await project('orquesta-message-ledger-v2-lock-scope-');
    expect(messageLedgerLockPath(rootPath, 'message-a')).not.toBe(messageLedgerLockPath(rootPath, 'message-b'));
  });
});
