import {
  mkdir,
  mkdtemp,
  link,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  utimes,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { validateContract } from '@orquesta/contracts';
import executionKernel from '@orquesta/execution-kernel';
import {
  SessionBindingStore,
  type UpsertAcceptedFoundationBindingInput,
  type UpsertAcceptedPersistentBindingInput
} from './session-binding-store';

const roots: string[] = [];
const initialAcceptedAt = '2026-08-24T04:00:00.000Z';
const FOUNDATION_AGENT_IDS = executionKernel.FOUNDATION_AGENT_IDS;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(prefix = 'orquesta-session-binding-'): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function statePath(rootPath: string): string {
  return path.join(rootPath, '.orquesta', 'state', 'session-bindings.json');
}

function legacySessionsPath(rootPath: string): string {
  return path.join(rootPath, '.orquesta', 'state', 'sessions.json');
}

function stagingPath(rootPath: string): string {
  return path.join(rootPath, '.orquesta', 'runtime', 'session-binding-store');
}

function lockPath(rootPath: string): string {
  return path.join(stagingPath(rootPath), 'sessions-json.lock');
}

function recoveryPath(rootPath: string): string {
  return `${lockPath(rootPath)}.recovery`;
}

function artifactPath(rootPath: string, nonce: string): string {
  return path.join(stagingPath(rootPath), `write-${nonce}.tmp`);
}

function metadataCandidatePath(rootPath: string, kind: 'lock' | 'recovery', nonce: string): string {
  return path.join(stagingPath(rootPath), `${kind}-candidate-${nonce}.json`);
}

function foundationInput(rootPath: string, overrides: Partial<UpsertAcceptedFoundationBindingInput> = {}): UpsertAcceptedFoundationBindingInput {
  return {
    rootPath,
    projectId: 'project-a',
    expectedRevision: 0,
    sessionId: 'session-orchestrator-g1',
    agentId: 'orchestrator',
    threadId: 'thread-orchestrator-g1',
    handoffTurnId: 'turn-orchestrator-g1',
    acceptedAt: initialAcceptedAt,
    runtimeAuthorityId: 'runtime-authority-a',
    visibility: 'codex_task',
    ...overrides
  };
}

function persistentInput(rootPath: string, overrides: Partial<UpsertAcceptedPersistentBindingInput> = {}): UpsertAcceptedPersistentBindingInput {
  return {
    rootPath,
    projectId: 'project-a',
    expectedRevision: 0,
    sessionId: 'session-implementer-g1',
    agentId: 'implementer',
    threadId: 'thread-implementer-g1',
    handoffTurnId: 'turn-implementer-g1',
    acceptedAt: initialAcceptedAt,
    runtimeAuthorityId: 'runtime-authority-a',
    visibility: 'codex_task',
    profileId: 'specialist:implementer:v1',
    requestId: 'placement:PI-0123456789ab:implementer',
    placementIntentId: 'PI-0123456789ab',
    taskId: 'placement:0123456789ab:1',
    ...overrides
  };
}

function sessionStore(options: ConstructorParameters<typeof SessionBindingStore>[0] = {}): SessionBindingStore {
  return new SessionBindingStore({ verifyRuntimeAuthority: async () => undefined, ...options });
}

async function initializedOwner(): Promise<{ rootPath: string; store: SessionBindingStore }> {
  const rootPath = await project();
  const store = sessionStore();
  await store.initializeFresh({ rootPath, projectId: 'project-a' });
  await store.upsertAcceptedFoundationBinding(foundationInput(rootPath));
  return { rootPath, store };
}

describe('SessionBindingStore', () => {
  test('does not create state until explicit initialization and initializes idempotently', async () => {
    const rootPath = await project();
    const store = sessionStore();
    await expect(store.read(rootPath, 'project-a')).resolves.toMatchObject({ status: 'missing' });
    await expect(readFile(path.join(rootPath, '.orquesta'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    const created = await store.initializeFresh({ rootPath, projectId: 'project-a' });
    expect(created).toEqual({
      changed: true,
      state: { schema_version: 1, project_id: 'project-a', revision: 0, sessions: [] }
    });
    const duplicate = await store.initializeFresh({ rootPath, projectId: 'project-a' });
    expect(duplicate.changed).toBe(false);
    expect(validateContract('session-binding-state-v1', duplicate.state).ok).toBe(true);
  });

  test('preserves a Codex session projection while creating independent binding authority', async () => {
    const rootPath = await project();
    const projectionBytes = `${JSON.stringify({
      version: 1,
      source: 'codex_app.thread_list',
      project_cwd: rootPath,
      synced_at: initialAcceptedAt,
      updated_at: initialAcceptedAt,
      sessions: []
    })}\n`;
    await mkdir(path.dirname(legacySessionsPath(rootPath)), { recursive: true });
    await writeFile(legacySessionsPath(rootPath), projectionBytes, 'utf8');
    const store = sessionStore();

    await expect(store.read(rootPath, 'project-a')).resolves.toMatchObject({ status: 'missing', filePath: statePath(rootPath) });
    await expect(store.initializeFresh({ rootPath, projectId: 'project-a' }))
      .resolves.toMatchObject({ changed: true, state: { schema_version: 1, revision: 0 } });
    await expect(readFile(legacySessionsPath(rootPath), 'utf8')).resolves.toBe(projectionBytes);
    await expect(store.read(rootPath, 'project-a')).resolves.toMatchObject({ status: 'ready' });
  });

  test('copies a valid legacy shared-path binding authority and leaves the old owner path untouched', async () => {
    const rootPath = await project();
    const store = sessionStore();
    const created = await store.initializeFresh({ rootPath, projectId: 'project-a' });
    const bytes = await readFile(statePath(rootPath), 'utf8');
    await rename(statePath(rootPath), legacySessionsPath(rootPath));

    await expect(store.read(rootPath, 'project-a')).resolves.toMatchObject({
      status: 'migration_required',
      reason: 'session_binding_legacy_shared_path'
    });
    await expect(store.initializeFresh({ rootPath, projectId: 'project-a' }))
      .resolves.toEqual({ changed: true, state: created.state });
    await expect(readFile(statePath(rootPath), 'utf8')).resolves.toBe(bytes);
    await expect(readFile(legacySessionsPath(rootPath), 'utf8')).resolves.toBe(bytes);
    await expect(store.initializeFresh({ rootPath, projectId: 'project-a' }))
      .resolves.toEqual({ changed: false, state: created.state });
  });

  test('copies verified legacy Binding state without stealing a concurrently replaced projection path', async () => {
    const rootPath = await project();
    const legacyState = { schema_version: 1, project_id: 'project-a', revision: 0, sessions: [] };
    await mkdir(path.dirname(legacySessionsPath(rootPath)), { recursive: true });
    await writeFile(legacySessionsPath(rootPath), `${JSON.stringify(legacyState)}\n`, 'utf8');
    const projectionBytes = `${JSON.stringify({
      version: 2,
      source: 'codex_app.thread_list',
      sessions: [{ thread_id: 'thread-owned-by-projection' }]
    })}\n`;
    let replaced = false;
    const store = sessionStore({
      async renameFile(sourcePath, destinationPath) {
        if (!replaced && destinationPath === statePath(rootPath)) {
          replaced = true;
          await writeFile(legacySessionsPath(rootPath), projectionBytes, 'utf8');
        }
        await rename(sourcePath, destinationPath);
      }
    });

    await expect(store.initializeFresh({ rootPath, projectId: 'project-a' }))
      .resolves.toEqual({ changed: true, state: legacyState });
    await expect(store.read(rootPath, 'project-a')).resolves.toMatchObject({ status: 'ready', state: legacyState });
    await expect(readFile(legacySessionsPath(rootPath), 'utf8')).resolves.toBe(projectionBytes);
  });

  test('never reads or retires a shared-path file after the dedicated Session authority is ready', async () => {
    const rootPath = await project();
    const store = sessionStore();
    await store.initializeFresh({ rootPath, projectId: 'project-a' });
    const currentBytes = await readFile(statePath(rootPath), 'utf8');
    const conflictingBytes = `${JSON.stringify({ schema_version: 1, project_id: 'project-a', revision: 1, sessions: [] })}\n`;
    await writeFile(legacySessionsPath(rootPath), conflictingBytes, 'utf8');
    await expect(store.read(rootPath, 'project-a')).resolves.toMatchObject({ status: 'ready', state: { revision: 0 } });
    await expect(store.ensureAuthority({ rootPath, projectId: 'project-a', policy: 'require_existing' }))
      .resolves.toMatchObject({ changed: false, source: 'existing', state: { revision: 0 } });
    await expect(readFile(statePath(rootPath), 'utf8')).resolves.toBe(currentBytes);
    await expect(readFile(legacySessionsPath(rootPath), 'utf8')).resolves.toBe(conflictingBytes);
  });

  test('strict authority policies migrate an exact old authority but never create an absent one', async () => {
    const absentRoot = await project();
    const store = sessionStore();
    await expect(store.ensureAuthority({ rootPath: absentRoot, projectId: 'project-a', policy: 'require_existing' }))
      .rejects.toMatchObject({ code: 'SESSION_BINDING_NOT_INITIALIZED' });
    await expect(readFile(statePath(absentRoot), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    const legacyRoot = await project();
    const legacyState = { schema_version: 1, project_id: 'project-a', revision: 0, sessions: [] };
    const legacyBytes = `${JSON.stringify(legacyState)}\n`;
    await mkdir(path.dirname(legacySessionsPath(legacyRoot)), { recursive: true });
    await writeFile(legacySessionsPath(legacyRoot), legacyBytes, 'utf8');
    await expect(store.ensureAuthority({ rootPath: legacyRoot, projectId: 'project-a', policy: 'migrate_only' }))
      .resolves.toEqual({ changed: true, source: 'legacy_copy', state: legacyState });
    await expect(readFile(statePath(legacyRoot), 'utf8').then((value) => JSON.parse(value)))
      .resolves.toEqual(legacyState);
    await expect(readFile(legacySessionsPath(legacyRoot), 'utf8')).resolves.toBe(legacyBytes);
  });

  test('does not manufacture Session authority from an ambiguous shared session file', async () => {
    const rootPath = await project();
    const ambiguousBytes = '{broken';
    await mkdir(path.dirname(legacySessionsPath(rootPath)), { recursive: true });
    await writeFile(legacySessionsPath(rootPath), ambiguousBytes, 'utf8');
    const store = sessionStore();
    await expect(store.read(rootPath, 'project-a')).resolves.toMatchObject({
      status: 'unsupported',
      reason: 'legacy_shared_session_state_ambiguous'
    });
    await expect(store.initializeFresh({ rootPath, projectId: 'project-a' }))
      .rejects.toMatchObject({ code: 'SESSION_BINDING_STATE_UNSUPPORTED' });
    await expect(readFile(statePath(rootPath), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(legacySessionsPath(rootPath), 'utf8')).resolves.toBe(ambiguousBytes);
  });

  test('does not let unknown foreign session projection disable ready Binding authority', async () => {
    const rootPath = await project();
    const store = sessionStore();
    await store.initializeFresh({ rootPath, projectId: 'project-a' });
    const bindingBytes = await readFile(statePath(rootPath), 'utf8');
    const projectionBytes = `${JSON.stringify({ version: 2, source: 'codex_app.thread_list', sessions: [] })}\n`;
    await writeFile(legacySessionsPath(rootPath), projectionBytes, 'utf8');

    await expect(store.read(rootPath, 'project-a')).resolves.toMatchObject({ status: 'ready' });
    await expect(store.initializeFresh({ rootPath, projectId: 'project-a' }))
      .resolves.toMatchObject({ changed: false });
    await expect(readFile(statePath(rootPath), 'utf8')).resolves.toBe(bindingBytes);
    await expect(readFile(legacySessionsPath(rootPath), 'utf8')).resolves.toBe(projectionBytes);
  });

  test('separates migratable legacy state from unsupported corrupt, partial, and foreign state without rewriting bytes', async () => {
    const fixtures = [
      { source: '{broken', status: 'unsupported', code: 'SESSION_BINDING_STATE_UNSUPPORTED' },
      { source: `${JSON.stringify({ version: 1, sessions: [] })}\n`, status: 'migration_required', code: 'SESSION_BINDING_MIGRATION_REQUIRED' },
      { source: `${JSON.stringify({ version: 1, sessions: [], source: 'codex_app.list_threads', project_cwd: 'C:/project', synced_at: initialAcceptedAt, updated_at: initialAcceptedAt })}\n`, status: 'migration_required', code: 'SESSION_BINDING_MIGRATION_REQUIRED' },
      { source: `${JSON.stringify({ version: 1, sessions: [], source: 'codex_app.thread_list', project_cwd: 'C:/project', synced_at: initialAcceptedAt, updated_at: initialAcceptedAt })}\n`, status: 'migration_required', code: 'SESSION_BINDING_MIGRATION_REQUIRED' },
      { source: `${JSON.stringify({ version: 1, sessions: [], source: 'codex_app.arbitrary' })}\n`, status: 'unsupported', code: 'SESSION_BINDING_STATE_UNSUPPORTED' },
      { source: `${JSON.stringify({ schema_version: 1, project_id: 'project-a', sessions: [] })}\n`, status: 'unsupported', code: 'SESSION_BINDING_STATE_UNSUPPORTED' },
      { source: `${JSON.stringify({ schema_version: 1, project_id: 'project-foreign', revision: 0, sessions: [] })}\n`, status: 'unsupported', code: 'SESSION_BINDING_STATE_UNSUPPORTED' },
      { source: `${JSON.stringify({ rogue_authority: true })}\n`, status: 'unsupported', code: 'SESSION_BINDING_STATE_UNSUPPORTED' },
      { source: `${JSON.stringify({ schema_version: 'garbage', sessions: [] })}\n`, status: 'unsupported', code: 'SESSION_BINDING_STATE_UNSUPPORTED' }
    ] as const;
    for (const { source, status, code } of fixtures) {
      const rootPath = await project();
      await mkdir(path.dirname(statePath(rootPath)), { recursive: true });
      await writeFile(statePath(rootPath), source, 'utf8');
      const store = new SessionBindingStore();
      await expect(store.read(rootPath, 'project-a')).resolves.toMatchObject({ status });
      await expect(store.initializeFresh({ rootPath, projectId: 'project-a' }))
        .rejects.toMatchObject({ code });
      await expect(readFile(statePath(rootPath), 'utf8')).resolves.toBe(source);
    }
  });

  test('upserts one deterministic accepted foundation owner, retries idempotently, and never reads or writes agents.json', async () => {
    const rootPath = await project();
    const store = sessionStore();
    await store.initializeFresh({ rootPath, projectId: 'project-a' });
    const agentsPath = path.join(rootPath, '.orquesta', 'state', 'agents.json');
    const agentsBytes = Buffer.from('not-json-and-not-session-authority\n', 'utf8');
    await writeFile(agentsPath, agentsBytes);

    const accepted = await store.upsertAcceptedFoundationBinding(foundationInput(rootPath));
    expect(accepted.changed).toBe(true);
    expect(accepted.state.revision).toBe(1);
    expect(accepted.state.sessions).toEqual([expect.objectContaining({
      agent_id: 'orchestrator',
      session_generation: 1,
      handoff_status: 'accepted',
      rotation_state: 'active',
      ownership_status: 'owner',
      binding_status: 'bound',
      runtime_authority_id: 'runtime-authority-a',
      profile_id: 'foundation:orchestrator:v1'
    })]);
    expect(validateContract('session-binding-state-v1', accepted.state).ok).toBe(true);

    const duplicate = await store.upsertAcceptedFoundationBinding(foundationInput(rootPath));
    expect(duplicate.changed).toBe(false);
    expect(duplicate.state.revision).toBe(1);
    expect(await readFile(agentsPath)).toEqual(agentsBytes);
  });

  test('upserts and finds an exact generic accepted owner binding without fuzzy matching', async () => {
    const rootPath = await project();
    const store = sessionStore();
    await store.initializeFresh({ rootPath, projectId: 'project-a' });
    const accepted = await store.upsertAcceptedPersistentBinding(persistentInput(rootPath));
    expect(accepted).toMatchObject({ changed: true, state: { revision: 1 } });
    await expect(store.findAcceptedOwnerBinding({
      rootPath,
      projectId: 'project-a',
      sessionId: 'session-implementer-g1',
      agentId: 'implementer',
      profileId: 'specialist:implementer:v1',
      runtimeAuthorityId: 'runtime-authority-a'
    })).resolves.toMatchObject({
      session_id: 'session-implementer-g1',
      agent_id: 'implementer',
      profile_id: 'specialist:implementer:v1',
      handoff_status: 'accepted',
      binding_status: 'bound',
      ownership_status: 'owner',
      rotation_state: 'active',
      accepts_new_work: true
    });
    await expect(store.findAcceptedPlacementBinding({
      rootPath,
      projectId: 'project-a',
      requestId: 'placement:PI-0123456789ab:implementer',
      placementIntentId: 'PI-0123456789ab',
      taskId: 'placement:0123456789ab:1',
      agentId: 'implementer',
      runtimeAuthorityId: 'runtime-authority-a'
    })).resolves.toMatchObject({ session_id: 'session-implementer-g1' });
    for (const override of [
      { sessionId: 'session-other' },
      { agentId: 'reviewer' },
      { profileId: 'specialist:reviewer:v1' },
      { runtimeAuthorityId: 'runtime-authority-b' }
    ]) {
      await expect(store.findAcceptedOwnerBinding({
        rootPath,
        projectId: 'project-a',
        sessionId: 'session-implementer-g1',
        agentId: 'implementer',
        profileId: 'specialist:implementer:v1',
        runtimeAuthorityId: 'runtime-authority-a',
        ...override
      })).resolves.toBeNull();
    }
    const retry = await store.upsertAcceptedPersistentBinding(persistentInput(rootPath, { expectedRevision: 0 }));
    expect(retry).toMatchObject({ changed: false, state: { revision: 1 } });
  });

  test('refuses accepted writes without a runtime authority verifier', async () => {
    const rootPath = await project();
    const store = new SessionBindingStore();
    await store.initializeFresh({ rootPath, projectId: 'project-a' });
    const before = await readFile(statePath(rootPath), 'utf8');
    await expect(store.upsertAcceptedPersistentBinding(persistentInput(rootPath)))
      .rejects.toMatchObject({ code: 'SESSION_BINDING_RUNTIME_AUTHORITY_VERIFIER_REQUIRED' });
    expect(await readFile(statePath(rootPath), 'utf8')).toBe(before);
  });

  test('reserves foundation agent and profile namespaces for the foundation entry point', async () => {
    const rootPath = await project();
    const store = sessionStore();
    await store.initializeFresh({ rootPath, projectId: 'project-a' });
    const before = await readFile(statePath(rootPath), 'utf8');
    await expect(store.upsertAcceptedPersistentBinding(persistentInput(rootPath, {
      agentId: 'orchestrator',
      profileId: 'specialist:rogue:v1'
    }))).rejects.toMatchObject({ code: 'SESSION_BINDING_FOUNDATION_AGENT_RESERVED' });
    await expect(store.upsertAcceptedPersistentBinding(persistentInput(rootPath, {
      profileId: 'foundation:orchestrator:v1'
    }))).rejects.toMatchObject({ code: 'SESSION_BINDING_FOUNDATION_PROFILE_RESERVED' });
    expect(await readFile(statePath(rootPath), 'utf8')).toBe(before);
  });

  test('rejects conflicting generic session evidence and verifies runtime authority while holding the write path', async () => {
    const rootPath = await project();
    const observed: string[] = [];
    const store = new SessionBindingStore({
      verifyRuntimeAuthority: async ({ rootPath: observedRoot, projectId, runtimeAuthorityId }) => {
        observed.push(`${observedRoot}|${projectId}|${runtimeAuthorityId}`);
        if (runtimeAuthorityId === 'runtime-authority-rejected') {
          throw new Error('runtime authority evidence mismatch');
        }
      }
    });
    await store.initializeFresh({ rootPath, projectId: 'project-a' });
    await store.upsertAcceptedPersistentBinding(persistentInput(rootPath));
    expect(observed).toEqual([`${rootPath}|project-a|runtime-authority-a`]);
    const before = await readFile(statePath(rootPath), 'utf8');
    await expect(store.upsertAcceptedPersistentBinding(persistentInput(rootPath, {
      expectedRevision: 1,
      agentId: 'reviewer',
      profileId: 'specialist:reviewer:v1'
    }))).rejects.toMatchObject({ code: 'SESSION_BINDING_CONFLICT' });
    await expect(store.upsertAcceptedPersistentBinding(persistentInput(rootPath, {
      expectedRevision: 1,
      sessionId: 'session-rejected-g1',
      agentId: 'reviewer',
      threadId: 'thread-rejected-g1',
      handoffTurnId: 'turn-rejected-g1',
      profileId: 'specialist:reviewer:v1',
      runtimeAuthorityId: 'runtime-authority-rejected'
    }))).rejects.toThrow('runtime authority evidence mismatch');
    expect(await readFile(statePath(rootPath), 'utf8')).toBe(before);
    expect(observed).toEqual([
      `${rootPath}|project-a|runtime-authority-a`,
      `${rootPath}|project-a|runtime-authority-a`,
      `${rootPath}|project-a|runtime-authority-rejected`
    ]);
  });

  test('derives the accepted foundation agent set from the organization v3 canonical export', async () => {
    const rootPath = await project();
    const store = sessionStore();
    await store.initializeFresh({ rootPath, projectId: 'project-a' });
    let revision = 0;
    for (const agentId of FOUNDATION_AGENT_IDS) {
      const result = await store.upsertAcceptedFoundationBinding(foundationInput(rootPath, {
        expectedRevision: revision,
        agentId,
        sessionId: `session-${agentId}-g1`,
        threadId: `thread-${agentId}-g1`,
        handoffTurnId: `turn-${agentId}-g1`
      }));
      revision = result.state.revision;
    }
    expect((await store.read(rootPath, 'project-a'))).toMatchObject({
      status: 'ready',
      state: { sessions: FOUNDATION_AGENT_IDS.map((agentId) => expect.objectContaining({ agent_id: agentId })) }
    });
    await expect(store.upsertAcceptedFoundationBinding(foundationInput(rootPath, {
      expectedRevision: revision,
      agentId: 'rogue-foundation'
    } as never))).rejects.toMatchObject({ code: 'SESSION_BINDING_FOUNDATION_AGENT_INVALID' });
  });

  test('rejects conflicting generation, thread, stale CAS, and unknown API authority without mutation', async () => {
    const { rootPath, store } = await initializedOwner();
    const before = await readFile(statePath(rootPath), 'utf8');
    await expect(store.upsertAcceptedFoundationBinding(foundationInput(rootPath, {
      expectedRevision: 1,
      sessionId: 'session-orchestrator-other',
      threadId: 'thread-orchestrator-other'
    }))).rejects.toMatchObject({ code: 'SESSION_BINDING_GENERATION_CONFLICT' });
    await expect(store.upsertAcceptedFoundationBinding(foundationInput(rootPath, {
      expectedRevision: 1,
      sessionId: 'session-support-g1',
      agentId: 'user-support',
      threadId: 'thread-orchestrator-g1'
    }))).rejects.toMatchObject({ code: 'SESSION_BINDING_THREAD_CONFLICT' });
    await expect(store.upsertAcceptedFoundationBinding(foundationInput(rootPath, {
      expectedRevision: 0,
      sessionId: 'session-support-g1',
      agentId: 'user-support',
      threadId: 'thread-support-g1',
      handoffTurnId: 'turn-support-g1'
    }))).rejects.toMatchObject({ code: 'SESSION_BINDING_REVISION_CONFLICT' });
    await expect(store.upsertAcceptedFoundationBinding({
      ...foundationInput(rootPath, { expectedRevision: 1 }),
      runtime_status: 'working'
    } as never)).rejects.toMatchObject({ code: 'SESSION_BINDING_INPUT_INVALID' });
    expect(await readFile(statePath(rootPath), 'utf8')).toBe(before);
  });

  test('rejects a second foundation binding from a different runtime authority', async () => {
    const { rootPath, store } = await initializedOwner();
    const before = await readFile(statePath(rootPath), 'utf8');
    await expect(store.upsertAcceptedFoundationBinding(foundationInput(rootPath, {
      expectedRevision: 1,
      sessionId: 'session-support-g1',
      agentId: 'user-support',
      threadId: 'thread-support-g1',
      handoffTurnId: 'turn-support-g1',
      runtimeAuthorityId: 'runtime-authority-b'
    }))).rejects.toMatchObject({ code: 'SESSION_BINDING_RUNTIME_AUTHORITY_CONFLICT' });
    expect(await readFile(statePath(rootPath), 'utf8')).toBe(before);
  });

  test('keeps predecessor ownership through checkpoint, then verifies and cuts over a successor atomically', async () => {
    const { rootPath, store } = await initializedOwner();
    const transitions = [
      ['rotation_preparing', '2026-08-24T04:01:00.000Z'],
      ['rotation_pending', '2026-08-24T04:02:00.000Z'],
      ['rotation_required', '2026-08-24T04:03:00.000Z'],
      ['draining', '2026-08-24T04:04:00.000Z'],
      ['checkpointed', '2026-08-24T04:05:00.000Z']
    ] as const;
    let revision = 1;
    for (const [to, changedAt] of transitions) {
      const result = await store.transitionOwnerRotation({
        rootPath,
        projectId: 'project-a',
        expectedRevision: revision,
        sessionId: 'session-orchestrator-g1',
        to,
        changedAt
      });
      revision += 1;
      expect(result.state.revision).toBe(revision);
      expect(result.state.sessions[0]).toMatchObject({
        ownership_status: 'owner',
        rotation_state: to,
        accepts_new_work: !['rotation_required', 'draining', 'checkpointed'].includes(to)
      });
      expect(validateContract('session-binding-state-v1', result.state).ok).toBe(true);
    }

    const staged = await store.stageRotationCandidate({
      rootPath,
      projectId: 'project-a',
      expectedRevision: revision,
      predecessorSessionId: 'session-orchestrator-g1',
      successorSessionId: 'session-orchestrator-g2',
      successorThreadId: 'thread-orchestrator-g2',
      changedAt: '2026-08-24T04:06:00.000Z'
    });
    revision += 1;
    expect(staged.state.sessions).toEqual([
      expect.objectContaining({ ownership_status: 'owner', rotation_state: 'checkpointed', replaced_by_session_id: null }),
      expect.objectContaining({
        ownership_status: 'candidate', rotation_state: 'successor_warming',
        replaces_session_id: 'session-orchestrator-g1', attachment_tool_state: 'unsupported'
      })
    ]);
    const duplicateStage = await store.stageRotationCandidate({
      rootPath,
      projectId: 'project-a',
      expectedRevision: revision - 1,
      predecessorSessionId: 'session-orchestrator-g1',
      successorSessionId: 'session-orchestrator-g2',
      successorThreadId: 'thread-orchestrator-g2',
      changedAt: '2026-08-24T04:06:00.000Z'
    });
    expect(duplicateStage).toMatchObject({ changed: false, state: { revision } });

    const verified = await store.verifyRotationCandidate({
      rootPath,
      projectId: 'project-a',
      expectedRevision: revision,
      successorSessionId: 'session-orchestrator-g2',
      handoffTurnId: 'turn-orchestrator-g2',
      acceptedAt: '2026-08-24T04:07:00.000Z',
      runtimeAuthorityId: 'runtime-authority-a'
    });
    revision += 1;
    expect(verified.state.sessions[1]).toMatchObject({
      rotation_state: 'successor_verified',
      ownership_status: 'candidate',
      binding_status: 'bound',
      accepts_new_work: false
    });

    const cutover = await store.acceptRotationCandidate({
      rootPath,
      projectId: 'project-a',
      expectedRevision: revision,
      successorSessionId: 'session-orchestrator-g2',
      changedAt: '2026-08-24T04:08:00.000Z'
    });
    revision += 1;
    expect(cutover.state.sessions).toEqual([
      expect.objectContaining({
        rotation_state: 'superseded', ownership_status: 'superseded', accepts_new_work: false,
        replaced_by_session_id: 'session-orchestrator-g2'
      }),
      expect.objectContaining({
        rotation_state: 'active', ownership_status: 'owner', accepts_new_work: true,
        replaces_session_id: 'session-orchestrator-g1'
      })
    ]);
    expect(validateContract('session-binding-state-v1', cutover.state).ok).toBe(true);
    await expect(store.acceptRotationCandidate({
      rootPath,
      projectId: 'project-a',
      expectedRevision: revision - 1,
      successorSessionId: 'session-orchestrator-g2',
      changedAt: '2026-08-24T04:08:00.000Z'
    })).resolves.toMatchObject({ changed: false, state: { revision } });
    await expect(store.acceptRotationCandidate({
      rootPath,
      projectId: 'project-a',
      expectedRevision: revision,
      successorSessionId: 'session-orchestrator-g2',
      changedAt: '2026-08-24T04:09:00.000Z'
    })).rejects.toMatchObject({ code: 'SESSION_BINDING_DUPLICATE_EVIDENCE_CONFLICT' });
  });

  test('rotates through four generations without invalidating historical ownership edges, then retires the head', async () => {
    const { rootPath, store } = await initializedOwner();
    let revision = 1;
    let ownerSessionId = 'session-orchestrator-g1';
    let minute = 1;
    const timestamp = () => `2026-08-24T04:${String(minute++).padStart(2, '0')}:00.000Z`;

    for (let generation = 2; generation <= 4; generation += 1) {
      for (const to of ['rotation_preparing', 'rotation_pending', 'rotation_required', 'draining', 'checkpointed'] as const) {
        const result = await store.transitionOwnerRotation({
          rootPath, projectId: 'project-a', expectedRevision: revision,
          sessionId: ownerSessionId, to, changedAt: timestamp()
        });
        revision = result.state.revision;
      }
      const successorSessionId = `session-orchestrator-g${generation}`;
      const staged = await store.stageRotationCandidate({
        rootPath, projectId: 'project-a', expectedRevision: revision,
        predecessorSessionId: ownerSessionId, successorSessionId,
        successorThreadId: `thread-orchestrator-g${generation}`, changedAt: timestamp()
      });
      revision = staged.state.revision;
      const verified = await store.verifyRotationCandidate({
        rootPath, projectId: 'project-a', expectedRevision: revision,
        successorSessionId, handoffTurnId: `turn-orchestrator-g${generation}`,
        acceptedAt: timestamp(), runtimeAuthorityId: 'runtime-authority-a'
      });
      revision = verified.state.revision;
      const cutover = await store.acceptRotationCandidate({
        rootPath, projectId: 'project-a', expectedRevision: revision,
        successorSessionId, changedAt: timestamp()
      });
      revision = cutover.state.revision;
      ownerSessionId = successorSessionId;
      expect(validateContract('session-binding-state-v1', cutover.state).ok).toBe(true);
    }

    const beforeRetirement = await store.read(rootPath, 'project-a');
    expect(beforeRetirement).toMatchObject({ status: 'ready', state: { sessions: [
      expect.objectContaining({ session_id: 'session-orchestrator-g1', rotation_state: 'superseded' }),
      expect.objectContaining({ session_id: 'session-orchestrator-g2', rotation_state: 'superseded' }),
      expect.objectContaining({ session_id: 'session-orchestrator-g3', rotation_state: 'superseded' }),
      expect.objectContaining({ session_id: 'session-orchestrator-g4', rotation_state: 'active' })
    ] } });
    if (beforeRetirement.status !== 'ready') throw new Error('expected ready state');
    for (let index = 0; index < beforeRetirement.state.sessions.length - 1; index += 1) {
      expect(beforeRetirement.state.sessions[index].ownership_ended_at)
        .toBe(beforeRetirement.state.sessions[index + 1].ownership_started_at);
    }

    const retired = await store.retireOwnerBinding({
      rootPath, projectId: 'project-a', expectedRevision: revision,
      sessionId: ownerSessionId, changedAt: timestamp()
    });
    expect(retired.state.sessions.at(-1)).toMatchObject({
      session_id: ownerSessionId,
      rotation_state: 'retired',
      ownership_status: 'retired',
      accepts_new_work: false,
      replaced_by_session_id: null
    });
    expect(validateContract('session-binding-state-v1', retired.state).ok).toBe(true);
    await expect(store.retireOwnerBinding({
      rootPath, projectId: 'project-a', expectedRevision: revision,
      sessionId: ownerSessionId, changedAt: retired.state.sessions.at(-1)?.ownership_ended_at ?? ''
    })).resolves.toMatchObject({ changed: false, state: { revision: retired.state.revision } });
  });

  test('rejects invalid rotation order and runtime-authority crossover without changing durable state', async () => {
    const { rootPath, store } = await initializedOwner();
    const before = await readFile(statePath(rootPath), 'utf8');
    await expect(store.stageRotationCandidate({
      rootPath,
      projectId: 'project-a',
      expectedRevision: 1,
      predecessorSessionId: 'session-orchestrator-g1',
      successorSessionId: 'session-orchestrator-g2',
      successorThreadId: 'thread-orchestrator-g2',
      changedAt: '2026-08-24T04:01:00.000Z'
    })).rejects.toMatchObject({ code: 'SESSION_BINDING_PREDECESSOR_NOT_CHECKPOINTED' });
    expect(await readFile(statePath(rootPath), 'utf8')).toBe(before);

    let revision = 1;
    for (const [to, changedAt] of [
      ['rotation_preparing', '2026-08-24T04:01:00.000Z'],
      ['rotation_pending', '2026-08-24T04:02:00.000Z'],
      ['draining', '2026-08-24T04:03:00.000Z'],
      ['checkpointed', '2026-08-24T04:04:00.000Z']
    ] as const) {
      await store.transitionOwnerRotation({ rootPath, projectId: 'project-a', expectedRevision: revision, sessionId: 'session-orchestrator-g1', to, changedAt });
      revision += 1;
    }
    await store.stageRotationCandidate({
      rootPath, projectId: 'project-a', expectedRevision: revision,
      predecessorSessionId: 'session-orchestrator-g1', successorSessionId: 'session-orchestrator-g2',
      successorThreadId: 'thread-orchestrator-g2', changedAt: '2026-08-24T04:05:00.000Z'
    });
    revision += 1;
    const stagedBytes = await readFile(statePath(rootPath), 'utf8');
    await expect(store.verifyRotationCandidate({
      rootPath, projectId: 'project-a', expectedRevision: revision,
      successorSessionId: 'session-orchestrator-g2', handoffTurnId: 'turn-g2',
      acceptedAt: '2026-08-24T04:06:00.000Z', runtimeAuthorityId: 'runtime-authority-other'
    })).rejects.toMatchObject({ code: 'SESSION_BINDING_RUNTIME_AUTHORITY_CONFLICT' });
    expect(await readFile(statePath(rootPath), 'utf8')).toBe(stagedBytes);
  });

  test('retains failed lineage and atomically reuses the same ownership generation for a retry', async () => {
    const { rootPath, store } = await initializedOwner();
    let revision = 1;
    for (const [to, changedAt] of [
      ['rotation_preparing', '2026-08-24T04:01:00.000Z'],
      ['rotation_pending', '2026-08-24T04:02:00.000Z'],
      ['draining', '2026-08-24T04:03:00.000Z'],
      ['checkpointed', '2026-08-24T04:04:00.000Z']
    ] as const) {
      await store.transitionOwnerRotation({ rootPath, projectId: 'project-a', expectedRevision: revision, sessionId: 'session-orchestrator-g1', to, changedAt });
      revision += 1;
    }
    await store.stageRotationCandidate({
      rootPath, projectId: 'project-a', expectedRevision: revision,
      predecessorSessionId: 'session-orchestrator-g1', successorSessionId: 'session-orchestrator-attempt-a',
      successorThreadId: 'thread-orchestrator-attempt-a', changedAt: '2026-08-24T04:05:00.000Z'
    });
    revision += 1;
    const failed = await store.failRotationCandidate({
      rootPath, projectId: 'project-a', expectedRevision: revision,
      successorSessionId: 'session-orchestrator-attempt-a', bindingStatus: 'authority_unverified',
      changedAt: '2026-08-24T04:06:00.000Z'
    });
    revision += 1;
    expect(failed.state.sessions[1]).toMatchObject({
      session_generation: 2,
      rotation_state: 'failed',
      replaces_session_id: 'session-orchestrator-g1'
    });
    const retried = await store.retryFailedRotationCandidate({
      rootPath, projectId: 'project-a', expectedRevision: revision,
      failedSessionId: 'session-orchestrator-attempt-a', successorSessionId: 'session-orchestrator-attempt-b',
      successorThreadId: 'thread-orchestrator-attempt-b', changedAt: '2026-08-24T04:07:00.000Z'
    });
    expect(retried.state.sessions).toHaveLength(3);
    expect(retried.state.sessions).toContainEqual(expect.objectContaining({
      session_id: 'session-orchestrator-attempt-a',
      session_generation: 2,
      rotation_state: 'failed',
      replaces_session_id: 'session-orchestrator-g1'
    }));
    expect(retried.state.sessions).toContainEqual(expect.objectContaining({
      session_id: 'session-orchestrator-attempt-b',
      session_generation: 2,
      rotation_state: 'successor_warming',
      replaces_session_id: 'session-orchestrator-g1',
      retry_of_session_id: 'session-orchestrator-attempt-a'
    }));
    expect(validateContract('session-binding-state-v1', retried.state).ok).toBe(true);
    await expect(store.retryFailedRotationCandidate({
      rootPath, projectId: 'project-a', expectedRevision: revision,
      failedSessionId: 'session-orchestrator-attempt-a', successorSessionId: 'session-orchestrator-attempt-b',
      successorThreadId: 'thread-orchestrator-attempt-b', changedAt: '2026-08-24T04:07:00.000Z'
    })).resolves.toMatchObject({ changed: false, state: { revision: retried.state.revision } });
    await expect(store.retryFailedRotationCandidate({
      rootPath, projectId: 'project-a', expectedRevision: retried.state.revision,
      failedSessionId: 'unrelated-failed-session', successorSessionId: 'session-orchestrator-attempt-b',
      successorThreadId: 'thread-orchestrator-attempt-b', changedAt: '2026-08-24T04:08:00.000Z'
    })).rejects.toMatchObject({ code: 'SESSION_BINDING_FAILED_CANDIDATE_NOT_FOUND' });

    const failedRetry = await store.failRotationCandidate({
      rootPath, projectId: 'project-a', expectedRevision: retried.state.revision,
      successorSessionId: 'session-orchestrator-attempt-b', bindingStatus: 'conflict',
      changedAt: '2026-08-24T04:08:00.000Z'
    });
    const secondRetry = await store.retryFailedRotationCandidate({
      rootPath, projectId: 'project-a', expectedRevision: failedRetry.state.revision,
      failedSessionId: 'session-orchestrator-attempt-b', successorSessionId: 'session-orchestrator-attempt-c',
      successorThreadId: 'thread-orchestrator-attempt-c', changedAt: '2026-08-24T04:09:00.000Z'
    });
    expect(secondRetry.state.sessions).toContainEqual(expect.objectContaining({
      session_id: 'session-orchestrator-attempt-c',
      session_generation: 2,
      rotation_state: 'successor_warming',
      retry_of_session_id: 'session-orchestrator-attempt-b'
    }));
    await expect(store.retryFailedRotationCandidate({
      rootPath, projectId: 'project-a', expectedRevision: failedRetry.state.revision,
      failedSessionId: 'session-orchestrator-attempt-b', successorSessionId: 'session-orchestrator-attempt-c',
      successorThreadId: 'thread-orchestrator-attempt-c', changedAt: '2026-08-24T04:09:00.000Z'
    })).resolves.toMatchObject({ changed: false, state: { revision: secondRetry.state.revision } });
    await expect(store.retryFailedRotationCandidate({
      rootPath, projectId: 'project-a', expectedRevision: secondRetry.state.revision,
      failedSessionId: 'session-orchestrator-attempt-a', successorSessionId: 'session-orchestrator-attempt-c',
      successorThreadId: 'thread-orchestrator-attempt-c', changedAt: '2026-08-24T04:09:00.000Z'
    })).rejects.toMatchObject({ code: 'SESSION_BINDING_RETRY_ALREADY_APPLIED' });
    await expect(store.retryFailedRotationCandidate({
      rootPath, projectId: 'project-a', expectedRevision: secondRetry.state.revision,
      failedSessionId: 'session-orchestrator-attempt-a', successorSessionId: 'session-orchestrator-attempt-d',
      successorThreadId: 'thread-orchestrator-attempt-d', changedAt: '2026-08-24T04:10:00.000Z'
    })).rejects.toMatchObject({ code: 'SESSION_BINDING_RETRY_SOURCE_STALE' });

    const verified = await store.verifyRotationCandidate({
      rootPath, projectId: 'project-a', expectedRevision: secondRetry.state.revision,
      successorSessionId: 'session-orchestrator-attempt-c', handoffTurnId: 'turn-orchestrator-g2',
      acceptedAt: '2026-08-24T04:10:00.000Z', runtimeAuthorityId: 'runtime-authority-a'
    });
    const cutover = await store.acceptRotationCandidate({
      rootPath, projectId: 'project-a', expectedRevision: verified.state.revision,
      successorSessionId: 'session-orchestrator-attempt-c', changedAt: '2026-08-24T04:11:00.000Z'
    });
    expect(cutover.state.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ session_id: 'session-orchestrator-attempt-a', rotation_state: 'failed' }),
      expect.objectContaining({ session_id: 'session-orchestrator-attempt-b', rotation_state: 'failed' }),
      expect.objectContaining({ session_id: 'session-orchestrator-attempt-c', rotation_state: 'active', retry_of_session_id: 'session-orchestrator-attempt-b' })
    ]));
    expect(validateContract('session-binding-state-v1', cutover.state).ok).toBe(true);
  });

  test('retires a checkpointed owner after a failed attempt without deleting failure evidence', async () => {
    const { rootPath, store } = await initializedOwner();
    let revision = 1;
    for (const [to, changedAt] of [
      ['rotation_preparing', '2026-08-24T04:01:00.000Z'],
      ['rotation_pending', '2026-08-24T04:02:00.000Z'],
      ['draining', '2026-08-24T04:03:00.000Z'],
      ['checkpointed', '2026-08-24T04:04:00.000Z']
    ] as const) {
      const transition = await store.transitionOwnerRotation({
        rootPath, projectId: 'project-a', expectedRevision: revision,
        sessionId: 'session-orchestrator-g1', to, changedAt
      });
      revision = transition.state.revision;
    }
    const staged = await store.stageRotationCandidate({
      rootPath, projectId: 'project-a', expectedRevision: revision,
      predecessorSessionId: 'session-orchestrator-g1', successorSessionId: 'session-orchestrator-attempt-a',
      successorThreadId: 'thread-orchestrator-attempt-a', changedAt: '2026-08-24T04:05:00.000Z'
    });
    const failed = await store.failRotationCandidate({
      rootPath, projectId: 'project-a', expectedRevision: staged.state.revision,
      successorSessionId: 'session-orchestrator-attempt-a', bindingStatus: 'authority_unverified',
      changedAt: '2026-08-24T04:06:00.000Z'
    });
    const retired = await store.retireOwnerBinding({
      rootPath, projectId: 'project-a', expectedRevision: failed.state.revision,
      sessionId: 'session-orchestrator-g1', changedAt: '2026-08-24T04:07:00.000Z'
    });
    expect(retired.state.sessions).toEqual([
      expect.objectContaining({ session_id: 'session-orchestrator-g1', rotation_state: 'retired', ownership_status: 'retired' }),
      expect.objectContaining({ session_id: 'session-orchestrator-attempt-a', rotation_state: 'failed' })
    ]);
    expect(validateContract('session-binding-state-v1', retired.state).ok).toBe(true);
  });

  test('fails closed on storage symlinks and on untrusted root aliases', async () => {
    const rootPath = await project();
    const outside = await project('orquesta-session-binding-outside-');
    await mkdir(path.join(rootPath, '.orquesta'));
    await symlink(outside, path.join(rootPath, '.orquesta', 'state'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(new SessionBindingStore().initializeFresh({ rootPath, projectId: 'project-a' }))
      .rejects.toMatchObject({ code: 'SESSION_BINDING_PATH_UNSAFE' });

    if (process.platform !== 'win32') {
      const aliasParent = await project('orquesta-session-binding-alias-parent-');
      const alias = path.join(aliasParent, 'alias');
      await symlink(outside, alias, 'dir');
      await expect(new SessionBindingStore().read(alias, 'project-a'))
        .rejects.toMatchObject({ code: 'SESSION_BINDING_ROOT_NOT_CANONICAL' });
    }
  });

  test('fails closed on unverifiable locks but identity-recovers a dead stale lock and re-evaluates committed state', async () => {
    const rootPath = await project();
    const store = sessionStore({ now: () => new Date('2026-08-24T05:00:00.000Z') });
    await store.initializeFresh({ rootPath, projectId: 'project-a' });
    const storeLockPath = lockPath(rootPath);
    await writeFile(storeLockPath, 'not-json\n', 'utf8');
    const before = await readFile(statePath(rootPath), 'utf8');
    await expect(store.upsertAcceptedFoundationBinding(foundationInput(rootPath)))
      .rejects.toMatchObject({ code: 'SESSION_BINDING_LOCK_UNVERIFIABLE' });
    expect(await readFile(storeLockPath, 'utf8')).toBe('not-json\n');
    expect(await readFile(statePath(rootPath), 'utf8')).toBe(before);

    await unlink(storeLockPath);
    const staleLiveArtifact = artifactPath(rootPath, 'stale-lock');
    const staleLive = `${JSON.stringify({
      schema_version: 1,
      pid: process.pid,
      nonce: 'stale-lock',
      target_path: statePath(rootPath),
      artifact_path: staleLiveArtifact,
      metadata_candidate_path: metadataCandidatePath(rootPath, 'lock', 'stale-lock'),
      acquired_at: '2026-08-24T04:00:00.000Z'
    })}\n`;
    await writeFile(storeLockPath, staleLive, 'utf8');
    await expect(store.upsertAcceptedFoundationBinding(foundationInput(rootPath)))
      .rejects.toMatchObject({ code: 'SESSION_BINDING_LOCK_STALE_UNVERIFIED' });
    expect(await readFile(storeLockPath, 'utf8')).toBe(staleLive);
    expect(await readFile(statePath(rootPath), 'utf8')).toBe(before);

    await unlink(storeLockPath);
    const committed = await sessionStore().upsertAcceptedFoundationBinding(foundationInput(rootPath));
    expect(committed.state.revision).toBe(1);
    const deadArtifact = artifactPath(rootPath, 'dead-stale-lock');
    await writeFile(deadArtifact, 'partial-state-write\n', 'utf8');
    const deadStale = `${JSON.stringify({
      schema_version: 1,
      pid: 2147483000,
      nonce: 'dead-stale-lock',
      target_path: statePath(rootPath),
      artifact_path: deadArtifact,
      metadata_candidate_path: metadataCandidatePath(rootPath, 'lock', 'dead-stale-lock'),
      acquired_at: '2026-08-24T04:00:00.000Z'
    })}\n`;
    await writeFile(storeLockPath, deadStale, 'utf8');
    const recovered = await store.upsertAcceptedFoundationBinding(foundationInput(rootPath));
    expect(recovered).toMatchObject({ changed: false, state: { revision: 1 } });
    await expect(readFile(storeLockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(deadArtifact, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(path.dirname(statePath(rootPath)))).filter((entry) => (
      entry.startsWith('sessions.json.') || entry.includes('.stale-')
    ))).toEqual([]);
  });

  test('recovers only store-owned crash artifacts published from complete private metadata candidates', async () => {
    const rootPath = await project();
    const now = new Date('2026-08-24T05:00:00.000Z');
    const store = sessionStore({ now: () => now });
    await store.initializeFresh({ rootPath, projectId: 'project-a' });

    const partialLockCandidate = metadataCandidatePath(rootPath, 'lock', 'partial-lock');
    const partialRecoveryCandidate = metadataCandidatePath(rootPath, 'recovery', 'partial-recovery');
    await writeFile(partialLockCandidate, '{"schema_version":1', 'utf8');
    await writeFile(partialRecoveryCandidate, '', 'utf8');
    const staleTime = new Date('2026-08-24T04:00:00.000Z');
    await utimes(partialLockCandidate, staleTime, staleTime);
    await utimes(partialRecoveryCandidate, staleTime, staleTime);
    const committed = await store.upsertAcceptedFoundationBinding(foundationInput(rootPath));
    expect(committed.state.revision).toBe(1);
    await expect(readFile(partialLockCandidate, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(partialRecoveryCandidate, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    const deadPid = 2147483000;
    const lockNonce = 'published-dead-lock';
    const deadArtifact = artifactPath(rootPath, lockNonce);
    const lockCandidate = metadataCandidatePath(rootPath, 'lock', lockNonce);
    const lock = {
      schema_version: 1,
      pid: deadPid,
      nonce: lockNonce,
      target_path: statePath(rootPath),
      artifact_path: deadArtifact,
      metadata_candidate_path: lockCandidate,
      acquired_at: '2026-08-24T04:00:00.000Z'
    };
    await writeFile(deadArtifact, 'uncommitted-state\n', 'utf8');
    await writeFile(lockCandidate, `${JSON.stringify(lock)}\n`, 'utf8');
    await link(lockCandidate, lockPath(rootPath));

    const recoveryNonce = 'published-dead-recovery';
    const recoveryCandidate = metadataCandidatePath(rootPath, 'recovery', recoveryNonce);
    const recovery = {
      schema_version: 1,
      pid: deadPid,
      nonce: recoveryNonce,
      target_path: statePath(rootPath),
      observed_lock_nonce: lockNonce,
      artifact_path: deadArtifact,
      metadata_candidate_path: recoveryCandidate,
      acquired_at: '2026-08-24T04:00:00.000Z'
    };
    await writeFile(recoveryCandidate, `${JSON.stringify(recovery)}\n`, 'utf8');
    await link(recoveryCandidate, recoveryPath(rootPath));

    const transientUnlinkFailures = new Map<string, number>([
      [deadArtifact, 1],
      [lockCandidate, 1],
      [recoveryCandidate, 1],
      [lockPath(rootPath), 1],
      [recoveryPath(rootPath), 1]
    ]);
    const recoveryStore = sessionStore({
      now: () => now,
      sleep: async () => undefined,
      unlinkFile: async (filePath) => {
        const remaining = transientUnlinkFailures.get(filePath) ?? 0;
        if (remaining > 0) {
          transientUnlinkFailures.set(filePath, remaining - 1);
          const error = new Error('transient unlink contention') as NodeJS.ErrnoException;
          error.code = 'EPERM';
          throw error;
        }
        await unlink(filePath);
      }
    });
    const recovered = await recoveryStore.upsertAcceptedFoundationBinding(foundationInput(rootPath));
    expect(recovered).toMatchObject({ changed: false, state: { revision: 1 } });
    expect([...transientUnlinkFailures.values()]).toEqual([0, 0, 0, 0, 0]);
    for (const ownedPath of [
      deadArtifact,
      lockCandidate,
      recoveryCandidate,
      lockPath(rootPath),
      recoveryPath(rootPath)
    ]) {
      await expect(readFile(ownedPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(await readdir(stagingPath(rootPath))).toEqual([]);
    expect((await readdir(path.dirname(statePath(rootPath)))).filter((entry) => (
      entry.startsWith('sessions.json.') || entry.includes('.stale-')
    ))).toEqual([]);
  });

  test('admits only one concurrent per-file mutation winner', async () => {
    const rootPath = await project();
    const first = sessionStore();
    const second = sessionStore();
    await first.initializeFresh({ rootPath, projectId: 'project-a' });
    const results = await Promise.allSettled([
      first.upsertAcceptedFoundationBinding(foundationInput(rootPath)),
      second.upsertAcceptedFoundationBinding(foundationInput(rootPath, {
        sessionId: 'session-admin-g1', agentId: 'orquesta-admin', threadId: 'thread-admin-g1', handoffTurnId: 'turn-admin-g1'
      }))
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const persisted = await first.read(rootPath, 'project-a');
    expect(persisted).toMatchObject({ status: 'ready', state: { revision: 1, sessions: [expect.any(Object)] } });
  });

  test('retries transient Windows-style atomic replace failures without deleting the prior file', async () => {
    const rootPath = await project();
    let attempts = 0;
    const store = sessionStore({
      renameFile: async (sourcePath, destinationPath) => {
        attempts += 1;
        if (attempts <= 2) {
          const error = new Error('busy') as NodeJS.ErrnoException;
          error.code = 'EPERM';
          throw error;
        }
        await rename(sourcePath, destinationPath);
      },
      sleep: async () => undefined
    });
    await expect(store.initializeFresh({ rootPath, projectId: 'project-a' }))
      .resolves.toMatchObject({ changed: true, state: { revision: 0 } });
    expect(attempts).toBe(3);
    await expect(store.read(rootPath, 'project-a')).resolves.toMatchObject({ status: 'ready' });
  });
});
