import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { establishRuntimeBinding } from './runtime-binding-store';
import { SessionBindingStore } from './session-binding-store';
import { SessionBindingResolver } from './session-binding-resolver';

const roots: string[] = [];
const acceptedAt = '2026-08-25T00:00:00.000Z';

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(mode: 'standalone' | 'codex_hosted' = 'standalone') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'orquesta-session-resolver-'));
  roots.push(root);
  await mkdir(path.join(root, '.orquesta', 'state'), { recursive: true });
  await establishRuntimeBinding({
    rootPath: root,
    projectId: 'project-1',
    launchContext: mode === 'codex_hosted'
      ? { source: 'argv', callingThreadId: 'thread-calling' }
      : { source: 'standalone', callingThreadId: null },
    authorityId: () => 'runtime-authority-1',
    now: () => new Date(acceptedAt)
  });
  const store = new SessionBindingStore({
    now: () => new Date(acceptedAt),
    verifyRuntimeAuthority: async (input) => {
      if (input.rootPath !== root
        || input.projectId !== 'project-1'
        || input.runtimeAuthorityId !== 'runtime-authority-1') {
        throw new Error('runtime_authority_conflict');
      }
    }
  });
  await store.initializeFresh({ rootPath: root, projectId: 'project-1' });
  return { root, store };
}

async function foundation(
  store: SessionBindingStore,
  rootPath: string,
  input: {
    agentId?: 'orchestrator' | 'orquesta-admin' | 'user-support';
    sessionId: string;
    threadId: string;
    attachmentToolState?: 'supported' | 'unsupported';
  }
) {
  const read = await store.read(rootPath, 'project-1');
  if (read.status !== 'ready') throw new Error(`unexpected ${read.status}`);
  return store.upsertAcceptedFoundationBinding({
    rootPath,
    projectId: 'project-1',
    expectedRevision: read.state.revision,
    sessionId: input.sessionId,
    agentId: input.agentId ?? 'orchestrator',
    threadId: input.threadId,
    handoffTurnId: `turn-${input.threadId}`,
    acceptedAt,
    runtimeAuthorityId: 'runtime-authority-1',
    visibility: 'desktop_only',
    ...(input.attachmentToolState ? { attachmentToolState: input.attachmentToolState } : {})
  });
}

test('routes only the canonical accepted active owner', async () => {
  const { root, store } = await project();
  await foundation(store, root, { sessionId: 'session-current', threadId: 'thread-current' });
  const resolver = new SessionBindingResolver(store);

  await expect(resolver.resolveActiveThread(root, 'project-1', 'orchestrator'))
    .resolves.toBe('thread-current');
  await expect(resolver.resolveActiveSession(root, 'project-1', 'orchestrator'))
    .resolves.toEqual({ threadId: 'thread-current', attachmentToolState: 'unsupported' });
  await expect(resolver.resolveActiveThread(root, 'project-1', 'user-support'))
    .rejects.toMatchObject({ code: 'SESSION_BINDING_ACTIVE_OWNER_MISSING' });
});

test('resolves attachment tool support only from an explicitly accepted SessionBinding field', async () => {
  const { root, store } = await project();
  await foundation(store, root, {
    sessionId: 'session-current',
    threadId: 'thread-current',
    attachmentToolState: 'supported'
  });
  await expect(new SessionBindingResolver(store).resolveActiveSession(root, 'project-1', 'orchestrator'))
    .resolves.toEqual({ threadId: 'thread-current', attachmentToolState: 'supported' });
});

test('fails closed for a runtime visibility mismatch', async () => {
  const { root, store } = await project('codex_hosted');
  const read = await store.read(root, 'project-1');
  if (read.status !== 'ready') throw new Error(`unexpected ${read.status}`);
  await store.upsertAcceptedFoundationBinding({
    rootPath: root,
    projectId: 'project-1',
    expectedRevision: read.state.revision,
    sessionId: 'session-current',
    agentId: 'orchestrator',
    threadId: 'thread-current',
    handoffTurnId: 'turn-current',
    acceptedAt,
    runtimeAuthorityId: 'runtime-authority-1',
    visibility: 'desktop_only'
  });

  await expect(new SessionBindingResolver(store).resolveActiveThread(root, 'project-1', 'orchestrator'))
    .rejects.toMatchObject({ code: 'SESSION_BINDING_ACTIVE_OWNER_MISSING' });
});

test('returns canonical generations in stable order and never infers an unknown agent', async () => {
  const { root, store } = await project();
  await foundation(store, root, { sessionId: 'session-current', threadId: 'thread-current' });
  const resolver = new SessionBindingResolver(store);

  await expect(resolver.resolveConversationSessions(root, 'project-1', 'orchestrator')).resolves.toEqual([
    expect.objectContaining({
      sessionId: 'session-current',
      threadId: 'thread-current',
      generation: 1,
      ownershipStatus: 'owner',
      runtimeAuthorityId: 'runtime-authority-1'
    })
  ]);
  await expect(resolver.resolveConversationSessions(root, 'project-1', 'implementation-001')).resolves.toEqual([]);
});

test('rejects a project id that does not own the runtime binding before reading sessions', async () => {
  const { root, store } = await project();
  await expect(new SessionBindingResolver(store).resolveActiveThread(root, 'other-project', 'orchestrator'))
    .rejects.toMatchObject({ code: 'SESSION_BINDING_RUNTIME_AUTHORITY_MISSING' });
});
