import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test as vitestTest, vi } from 'vitest';
import executionKernel from '@orquesta/execution-kernel';
import { establishRuntimeBinding, readRuntimeBindingEvidence } from './runtime-binding-store';
import { PlacementTaskPort } from './placement-task-port';
import { SessionBindingStore } from './session-binding-store';
import { ProjectBootstrapPlacementService } from './project-bootstrap-placement-service';
import { ProjectWriterLease } from './project-writer-lease';

type FixtureOwner = {
  roots: string[];
  writerLeases: ProjectWriterLease[];
  releasePendingStatuses: Array<() => void>;
};
const fixtures = new WeakMap<object, {
  owner: FixtureOwner;
  settled: Promise<PromiseSettledResult<void>[]>;
}>();
const PRODUCT_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const PROJECT_ID = 'project-composition-test';
const BOOTSTRAP_ID = 'foundation-composition-test';
const START = Date.parse('2026-08-25T00:00:00.000Z');

function foundationReceipt(agentId: string): string {
  return `<orquesta_foundation_receipt version="1" agent_id="${agentId}" status="accepted" />`;
}

function test(name: string, body: (owner: FixtureOwner) => Promise<void>, timeout?: number): void {
  vitestTest(name, ({ task }) => {
    const owner: FixtureOwner = { roots: [], writerLeases: [], releasePendingStatuses: [] };
    // Vitest's timeout rejects its wrapper without waiting for the async body.
    // Observe immediately, but return the original promise so failures stay visible.
    const pending = Promise.resolve().then(() => body(owner));
    fixtures.set(task, { owner, settled: Promise.allSettled([pending]) });
    return pending;
  }, timeout);
}

afterEach(async ({ task }) => {
  const fixture = fixtures.get(task);
  if (!fixture) return;
  fixtures.delete(task);
  const { owner, settled } = fixture;
  for (const release of owner.releasePendingStatuses.splice(0)) release();
  // All bootstrap calls and later fixture I/O belong to these actual bodies,
  // including when the runner has already reported their timeout or failure.
  // Capture the owner before awaiting: even a timed-out hook must never take
  // resources from a later test, including roots registered by a late body.
  await settled;
  await Promise.all(owner.writerLeases.splice(0).map((lease) => lease.release()));
  await Promise.all(owner.roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function clock(start = START): () => Date {
  let value = start;
  return () => new Date(value++);
}

async function projectRoot(owner: FixtureOwner): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'orquesta-project-composition-'));
  owner.roots.push(root);
  await establishRuntimeBinding({
    rootPath: root,
    projectId: PROJECT_ID,
    launchContext: { source: 'standalone', callingThreadId: null },
    authorityId: () => 'runtime-authority-composition',
    now: () => new Date('2026-08-25T00:00:00.000Z')
  });
  // Production Core retains this outer lease for the selected project before
  // it exposes ProjectBootstrapPlacementService. Integration tests exercise
  // the same single-writer boundary instead of calling the service unleased.
  const writerLease = new ProjectWriterLease();
  await writerLease.select(root, PROJECT_ID);
  owner.writerLeases.push(writerLease);
  return root;
}

function fakeRuntime() {
  const results = new Map<string, { threadId: string; turnId: string }>();
  const agentByTurn = new Map<string, string>();
  const placementCalls: Array<{ messageId: string; threadId: string }> = [];
  const foundationCalls: Array<{ messageId: string; threadId: string }> = [];
  let loseNextPlacementAck = false;
  let loseNextFoundationAck = false;
  let receiptOverride: string | null = null;
  const sendMessage = vi.fn(async (input: { messageId?: string; correlationId: string; targetAgentId: string }) => {
    const messageId = input.messageId ?? input.correlationId;
    let result = results.get(messageId);
    if (!result) {
      const suffix = createHash('sha256').update(messageId).digest('hex').slice(0, 20);
      result = { threadId: `thread-${suffix}`, turnId: `turn-${suffix}` };
      results.set(messageId, result);
    }
    agentByTurn.set(result.turnId, input.targetAgentId);
    if (messageId.startsWith('placement:')) {
      placementCalls.push({ messageId, threadId: result.threadId });
      if (loseNextPlacementAck) {
        loseNextPlacementAck = false;
        const error = new Error('simulated provider acknowledgment loss') as Error & { code: string };
        error.code = 'SIMULATED_ACK_LOSS';
        throw error;
      }
    } else {
      foundationCalls.push({ messageId, threadId: result.threadId });
      if (loseNextFoundationAck) {
        loseNextFoundationAck = false;
        const error = new Error('simulated Foundation acknowledgment loss') as Error & { code: string };
        error.code = 'SIMULATED_FOUNDATION_ACK_LOSS';
        throw error;
      }
    }
    return {
      ...result,
      attachmentToolState: 'supported' as const,
      modelEvidence: {
        recommendedModel: null,
        requestedModel: null,
        appliedModel: null,
        actualModel: null,
        actualModelEvidence: 'unknown' as const
      }
    };
  });
  const readTurnStatus = vi.fn(async () => 'completed');
  const listConversation = vi.fn(async (input: {
    threadId: string;
    targetAgentId: string;
    includeFoundationReceipts?: boolean;
  }) => {
    if (input.includeFoundationReceipts !== true) {
      throw new Error('Foundation receipt read must explicitly request the internal control message');
    }
    const result = [...results.values()].find((candidate) => candidate.threadId === input.threadId);
    if (!result) return { items: [], nextCursor: null };
    const agentId = agentByTurn.get(result.turnId) ?? input.targetAgentId;
    return {
      items: [{
        id: `agent-${result.turnId}`,
        role: 'agent' as const,
        targetAgentId: agentId,
        authorLabel: agentId,
        text: receiptOverride ?? foundationReceipt(agentId),
        createdAt: '2026-08-25T00:00:00.000Z',
        evidenceLabel: 'test',
        turnId: result.turnId
      }],
      nextCursor: null
    };
  });
  return {
    sendMessage,
    readTurnStatus,
    listConversation,
    placementCalls,
    foundationCalls,
    setFoundationReceipt(value: string | null) { receiptOverride = value; },
    loseNextPlacementAck() { loseNextPlacementAck = true; },
    loseNextFoundationAck() { loseNextFoundationAck = true; }
  };
}

function placementInput() {
  return {
    sourceRef: { kind: 'user', id: 'user-request' },
    roleCatalog: [
      { id: 'implementation', version: 1, capabilities: ['code', 'test'] },
      { id: 'testing', version: 1, capabilities: ['test'] }
    ],
    template: {
      purpose: 'Implement the bounded project feature.',
      capability_needs: ['code'],
      role_ref: { id: 'implementation', version: 1 },
      scope_ref: { kind: 'project', id: PROJECT_ID },
      requested_count: 1,
      coordination_hint: null
    }
  };
}

async function digestTree(root: string): Promise<Array<{ path: string; sha256: string }>> {
  const output: Array<{ path: string; sha256: string }> = [];
  async function visit(directory: string): Promise<void> {
    for (const name of (await readdir(directory)).sort()) {
      const filePath = path.join(directory, name);
      const details = await stat(filePath);
      if (details.isDirectory()) {
        await visit(filePath);
      } else {
        output.push({
          path: path.relative(root, filePath).replaceAll('\\', '/'),
          sha256: createHash('sha256').update(await readFile(filePath)).digest('hex')
        });
      }
    }
  }
  await visit(root);
  return output;
}

test('production composition bootstraps Foundation sessions, TaskPort v3, and replays without another dispatch', async (owner) => {
  const root = await projectRoot(owner);
  const runtime = fakeRuntime();
  const service = await ProjectBootstrapPlacementService.create({
    productRoot: PRODUCT_ROOT,
    projectRoot: root,
    projectId: PROJECT_ID,
    runtime,
    now: clock()
  });
  const evidence = await readRuntimeBindingEvidence(root);
  expect(service.project_root_binding_sha256).toBe(executionKernel.projectRootBindingSha256(root));
  expect(service.runtime_binding_sha256).toBe(evidence?.sha256);

  const first = await service.bootstrap({ bootstrapId: BOOTSTRAP_ID, userDisplayName: 'Test User' });
  expect(first).toMatchObject({ status: 'ready', no_write: false, project_id: PROJECT_ID });
  const sessions = await new SessionBindingStore().read(root, PROJECT_ID);
  expect(sessions).toMatchObject({ status: 'ready' });
  if (sessions.status !== 'ready') throw new Error('session state did not initialize');
  expect(sessions.state.sessions).toHaveLength(3);
  expect(sessions.state.sessions.every((session) => session.handoff_status === 'accepted')).toBe(true);
  expect(new PlacementTaskPort(root).read(PROJECT_ID)).toMatchObject({
    status: 'ready',
    state: { schema_version: 3, revision: 0, tasks: [] }
  });
  expect(runtime.sendMessage).toHaveBeenCalledTimes(3);
  expect(runtime.readTurnStatus).toHaveBeenCalledTimes(3);
  expect(runtime.listConversation).toHaveBeenCalledTimes(3);

  const second = await service.bootstrap({ bootstrapId: BOOTSTRAP_ID, userDisplayName: 'Test User' });
  expect(second).toMatchObject({ status: 'ready', no_write: true });
  expect(runtime.sendMessage).toHaveBeenCalledTimes(3);
});

test('does not recreate a missing Placement authority after Foundation is already ready', async (owner) => {
  const root = await projectRoot(owner);
  const runtime = fakeRuntime();
  const service = await ProjectBootstrapPlacementService.create({
    productRoot: PRODUCT_ROOT,
    projectRoot: root,
    projectId: PROJECT_ID,
    runtime,
    now: clock()
  });
  await expect(service.bootstrap({ bootstrapId: BOOTSTRAP_ID })).resolves.toMatchObject({ status: 'ready', no_write: false });
  const placementPath = path.join(root, '.orquesta', 'state', 'placement-tasks.json');
  await rm(placementPath, { force: true });

  await expect(service.bootstrap({ bootstrapId: BOOTSTRAP_ID })).resolves.toMatchObject({
    status: 'repair_required',
    classification: 'ready',
    reason: 'placement_task_authority_missing_after_foundation_ready',
    no_write: true
  });
  await expect(readFile(placementPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(service.bootstrap({ bootstrapId: BOOTSTRAP_ID })).resolves.toMatchObject({
    status: 'repair_required',
    reason: 'placement_task_authority_missing_after_foundation_ready',
    no_write: true
  });
  expect(runtime.sendMessage).toHaveBeenCalledTimes(3);
});

test('does not recreate a missing Session authority after Foundation is already ready', async (owner) => {
  const root = await projectRoot(owner);
  const runtime = fakeRuntime();
  const service = await ProjectBootstrapPlacementService.create({
    productRoot: PRODUCT_ROOT,
    projectRoot: root,
    projectId: PROJECT_ID,
    runtime,
    now: clock()
  });
  await expect(service.bootstrap({ bootstrapId: BOOTSTRAP_ID })).resolves.toMatchObject({ status: 'ready', no_write: false });
  const sessionPath = path.join(root, '.orquesta', 'state', 'session-bindings.json');
  await rm(sessionPath, { force: true });
  const before = await digestTree(root);

  await expect(service.bootstrap({ bootstrapId: BOOTSTRAP_ID })).resolves.toMatchObject({
    status: 'repair_required',
    classification: 'ready',
    reason: 'session_binding_authority_missing_after_foundation_ready',
    no_write: true
  });
  expect(await digestTree(root)).toEqual(before);
  expect(runtime.sendMessage).toHaveBeenCalledTimes(3);
});

test('copies exact old-path Session and Placement authorities after Foundation is ready without deleting shared paths', async (owner) => {
  const root = await projectRoot(owner);
  const runtime = fakeRuntime();
  const service = await ProjectBootstrapPlacementService.create({
    productRoot: PRODUCT_ROOT,
    projectRoot: root,
    projectId: PROJECT_ID,
    runtime,
    now: clock()
  });
  await expect(service.bootstrap({ bootstrapId: BOOTSTRAP_ID })).resolves.toMatchObject({ status: 'ready', no_write: false });
  const state = path.join(root, '.orquesta', 'state');
  const sessionPath = path.join(state, 'session-bindings.json');
  const placementPath = path.join(state, 'placement-tasks.json');
  const oldSessionPath = path.join(state, 'sessions.json');
  const oldTaskPath = path.join(state, 'tasks.json');
  await rename(sessionPath, oldSessionPath);
  await rename(placementPath, oldTaskPath);

  await expect(service.bootstrap({ bootstrapId: BOOTSTRAP_ID })).resolves.toMatchObject({ status: 'ready', no_write: false });
  await expect(readFile(sessionPath, 'utf8')).resolves.toContain('"schema_version": 1');
  await expect(readFile(placementPath, 'utf8')).resolves.toContain('"schema_version":3');
  await expect(readFile(oldSessionPath, 'utf8')).resolves.toContain('"schema_version": 1');
  await expect(readFile(oldTaskPath, 'utf8')).resolves.toContain('"schema_version":3');
  await expect(service.bootstrap({ bootstrapId: BOOTSTRAP_ID })).resolves.toMatchObject({ status: 'ready', no_write: true });
  expect(runtime.sendMessage).toHaveBeenCalledTimes(3);
});

test('does not migrate other stores when legacy Foundation authority blocks bootstrap', async (owner) => {
  const root = await projectRoot(owner);
  const state = path.join(root, '.orquesta', 'state');
  await writeFile(path.join(state, 'organization.json'), '{"schema_version":2,"revision":1}\n', 'utf8');
  await writeFile(path.join(state, 'sessions.json'), `${JSON.stringify({
    schema_version: 1,
    project_id: PROJECT_ID,
    revision: 0,
    sessions: []
  })}\n`, 'utf8');
  await writeFile(path.join(state, 'tasks.json'), `${JSON.stringify({
    schema_version: 3,
    project_id: PROJECT_ID,
    revision: 0,
    tasks: []
  })}\n`, 'utf8');
  const before = await digestTree(root);
  const runtime = fakeRuntime();
  const service = await ProjectBootstrapPlacementService.create({
    productRoot: PRODUCT_ROOT,
    projectRoot: root,
    projectId: PROJECT_ID,
    runtime,
    now: clock()
  });

  await expect(service.bootstrap({ bootstrapId: BOOTSTRAP_ID })).resolves.toMatchObject({
    status: 'migration_required',
    classification: 'legacy_v2',
    no_write: true
  });
  expect(await digestTree(root)).toEqual(before);
  expect(runtime.sendMessage).not.toHaveBeenCalled();
});

test('does not publish an accepted Foundation binding before the exact handoff turn completes', async (owner) => {
  // Register before the first await: timeout can happen before the mock is called.
  let releaseStatus!: () => void;
  const status = new Promise<string>((resolve) => { releaseStatus = () => resolve('completed'); });
  owner.releasePendingStatuses.push(releaseStatus);
  const root = await projectRoot(owner);
  const runtime = fakeRuntime();
  runtime.readTurnStatus.mockReturnValueOnce(status);
  const service = await ProjectBootstrapPlacementService.create({
    productRoot: PRODUCT_ROOT,
    projectRoot: root,
    projectId: PROJECT_ID,
    runtime,
    now: clock()
  });

  const pending = service.bootstrap({ bootstrapId: BOOTSTRAP_ID });
  const settlement = Promise.allSettled([pending]);
  try {
    await vi.waitFor(() => expect(runtime.readTurnStatus).toHaveBeenCalledTimes(1));
    const beforeReceipt = await new SessionBindingStore().read(root, PROJECT_ID);
    if (beforeReceipt.status !== 'ready') throw new Error('session state did not initialize');
    expect(beforeReceipt.state.sessions).toEqual([]);

    releaseStatus();
    await expect(pending).resolves.toMatchObject({ status: 'ready' });
    const afterReceipt = await new SessionBindingStore().read(root, PROJECT_ID);
    if (afterReceipt.status !== 'ready') throw new Error('session state did not remain ready');
    expect(afterReceipt.state.sessions).toHaveLength(3);
  } finally {
    releaseStatus();
    const [result] = await settlement;
    if (result.status === 'rejected') throw result.reason;
  }
});

test('fails closed on a completed Foundation handoff with the wrong receipt', async (owner) => {
  const root = await projectRoot(owner);
  const runtime = fakeRuntime();
  runtime.setFoundationReceipt('accepted-ish');
  const service = await ProjectBootstrapPlacementService.create({
    productRoot: PRODUCT_ROOT,
    projectRoot: root,
    projectId: PROJECT_ID,
    runtime,
    now: clock()
  });

  await expect(service.bootstrap({ bootstrapId: BOOTSTRAP_ID }))
    .rejects.toMatchObject({ code: 'FOUNDATION_HANDOFF_RECEIPT_INVALID' });
  const sessions = await new SessionBindingStore().read(root, PROJECT_ID);
  if (sessions.status !== 'ready') throw new Error('session state did not remain ready');
  expect(sessions.state.sessions).toEqual([]);
});

test('fails closed when a Foundation handoff turn terminates unsuccessfully', async (owner) => {
  const root = await projectRoot(owner);
  const runtime = fakeRuntime();
  runtime.readTurnStatus.mockResolvedValueOnce('failed');
  const service = await ProjectBootstrapPlacementService.create({
    productRoot: PRODUCT_ROOT,
    projectRoot: root,
    projectId: PROJECT_ID,
    runtime,
    now: clock()
  });

  await expect(service.bootstrap({ bootstrapId: BOOTSTRAP_ID }))
    .rejects.toMatchObject({ code: 'FOUNDATION_HANDOFF_TURN_FAILED' });
  expect(runtime.listConversation).not.toHaveBeenCalled();
});

test('persistent placement resumes provider ACK loss with the same message id and canonical lifecycle order', async (owner) => {
  const root = await projectRoot(owner);
  const runtime = fakeRuntime();
  const service = await ProjectBootstrapPlacementService.create({
    productRoot: PRODUCT_ROOT,
    projectRoot: root,
    projectId: PROJECT_ID,
    runtime,
    now: clock()
  });
  await service.bootstrap({ bootstrapId: BOOTSTRAP_ID });
  runtime.loseNextPlacementAck();

  await expect(service.placePersistentAgent(placementInput())).rejects.toMatchObject({ code: 'SIMULATED_ACK_LOSS' });
  const interrupted = new PlacementTaskPort(root).read(PROJECT_ID);
  expect(interrupted).toMatchObject({ status: 'ready' });
  if (interrupted.status !== 'ready') throw new Error('task state did not initialize');
  expect(interrupted.state.tasks).toHaveLength(1);
  expect(interrupted.state.tasks[0].state).toBe('assigned');

  const resumed = await service.placePersistentAgent(placementInput());
  expect(resumed).toMatchObject({ status: 'complete', no_write: false });
  const completed = new PlacementTaskPort(root).read(PROJECT_ID);
  if (completed.status !== 'ready') throw new Error('task state did not remain ready');
  expect(completed.state.tasks[0].state).toBe('dispatch_accepted');
  expect(runtime.placementCalls).toHaveLength(2);
  expect(runtime.placementCalls[1]).toEqual(runtime.placementCalls[0]);
  const sessions = await new SessionBindingStore().read(root, PROJECT_ID);
  if (sessions.status !== 'ready') throw new Error('session state did not remain ready');
  expect(sessions.state.sessions).toHaveLength(4);

  const callsBeforeReplay = runtime.sendMessage.mock.calls.length;
  const replay = await service.placePersistentAgent(placementInput());
  expect(replay).toMatchObject({ status: 'complete', no_write: true });
  expect(runtime.sendMessage).toHaveBeenCalledTimes(callsBeforeReplay);
}, 15_000);

test('placement before completed bootstrap fails without creating placement authority', async (owner) => {
  const root = await projectRoot(owner);
  const runtime = fakeRuntime();
  const service = await ProjectBootstrapPlacementService.create({
    productRoot: PRODUCT_ROOT,
    projectRoot: root,
    projectId: PROJECT_ID,
    runtime,
    now: clock()
  });
  const before = await digestTree(root);

  await expect(service.placePersistentAgent(placementInput()))
    .rejects.toMatchObject({ code: 'PROJECT_COMPOSITION_NOT_BOOTSTRAPPED' });
  expect(runtime.sendMessage).not.toHaveBeenCalled();
  expect(await digestTree(root)).toEqual(before);
});

test('Foundation bootstrap resumes provider ACK loss with the same durable request identity', async (owner) => {
  const root = await projectRoot(owner);
  const runtime = fakeRuntime();
  const service = await ProjectBootstrapPlacementService.create({
    productRoot: PRODUCT_ROOT,
    projectRoot: root,
    projectId: PROJECT_ID,
    runtime,
    now: clock()
  });
  runtime.loseNextFoundationAck();

  await expect(service.bootstrap({ bootstrapId: BOOTSTRAP_ID }))
    .rejects.toMatchObject({ code: 'SIMULATED_FOUNDATION_ACK_LOSS' });
  const resumed = await service.bootstrap({ bootstrapId: BOOTSTRAP_ID });
  expect(resumed).toMatchObject({ status: 'ready', no_write: false });
  expect(runtime.foundationCalls).toHaveLength(4);
  expect(runtime.foundationCalls[1]).toEqual(runtime.foundationCalls[0]);
  const sessions = await new SessionBindingStore().read(root, PROJECT_ID);
  if (sessions.status !== 'ready') throw new Error('session state did not resume');
  expect(sessions.state.sessions).toHaveLength(3);
});

test('ambiguous legacy session authority is unsupported without writing or provider dispatch', async (owner) => {
  const root = await projectRoot(owner);
  const legacyPath = path.join(root, '.orquesta', 'state', 'sessions.json');
  await mkdir(path.dirname(legacyPath), { recursive: true });
  await writeFile(legacyPath, `${JSON.stringify({ schema_version: 2, project_id: PROJECT_ID, sessions: [] })}\n`, 'utf8');
  const before = await digestTree(root);
  const runtime = fakeRuntime();
  const service = await ProjectBootstrapPlacementService.create({
    productRoot: PRODUCT_ROOT,
    projectRoot: root,
    projectId: PROJECT_ID,
    runtime,
    now: clock()
  });

  const result = await service.bootstrap({ bootstrapId: BOOTSTRAP_ID });
  expect(result).toMatchObject({
    status: 'unsupported',
    classification: 'unsupported',
    reason: 'legacy_shared_session_state_ambiguous',
    no_write: true
  });
  expect(runtime.sendMessage).not.toHaveBeenCalled();
  expect(await digestTree(root)).toEqual(before);
});

test('captured runtime binding SHA change fails before bootstrap writes', async (owner) => {
  const root = await projectRoot(owner);
  const runtime = fakeRuntime();
  const service = await ProjectBootstrapPlacementService.create({
    productRoot: PRODUCT_ROOT,
    projectRoot: root,
    projectId: PROJECT_ID,
    runtime,
    now: clock()
  });
  const evidence = await readRuntimeBindingEvidence(root);
  if (!evidence) throw new Error('runtime binding was not created');
  const binding = JSON.parse(await readFile(evidence.filePath, 'utf8'));
  binding.verified_at = '2026-08-25T00:00:01.000Z';
  await writeFile(evidence.filePath, `${JSON.stringify(binding, null, 2)}\n`, 'utf8');
  const before = await digestTree(root);

  await expect(service.bootstrap({ bootstrapId: BOOTSTRAP_ID }))
    .rejects.toMatchObject({ code: 'PROJECT_COMPOSITION_RUNTIME_AUTHORITY_CHANGED' });
  expect(runtime.sendMessage).not.toHaveBeenCalled();
  expect(await digestTree(root)).toEqual(before);
});
