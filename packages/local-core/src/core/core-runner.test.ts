import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  activateProjectMessageDeliveryStorage,
  establishSelectedProjectRuntimeBinding,
  inspectSelectedProjectBootstrap,
  prepareSelectedProjectBootstrap,
  resolveDesktopOperationRoot,
  runDesktopCore,
  type DesktopCoreTransport
} from './core-runner';
import type { DesktopCodexService } from './desktop-codex-service';
import { establishRuntimeBinding, readRuntimeBinding, readRuntimeBindingEvidence } from './runtime-binding-store';
import { MessageLedger, migrateLegacyMessageLedger } from './message-ledger-v2';
import { ProjectBootstrapPlacementService } from './project-bootstrap-placement-service';
import { ProjectWriterLease } from './project-writer-lease';
import { InspectionRunController } from './inspection-run-controller';
import { WorkflowRunController } from './workflow-run-controller';
import type { RuntimeApprovalRequest } from './protocol';

const roots: string[] = [];
const PRODUCT_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function runtimeProject(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'orquesta-core-runner-'));
  roots.push(root);
  await mkdir(path.join(root, '.orquesta', 'state'), { recursive: true });
  return root;
}

describe('selected project runtime binding', () => {
  test('establishes Codex-hosted ownership only after the calling task is visible', async () => {
    const root = await runtimeProject();
    const establish = vi.fn(async () => ({ mode: 'codex_hosted' as const }));
    const launchContext = { source: 'argv' as const, callingThreadId: 'thread-calling-chat' };

    await establishSelectedProjectRuntimeBinding(
      { rootPath: root, projectId: 'repo-1', launchContext },
      async () => [{ id: 'thread-calling-chat', archived: false }],
      establish as never
    );

    expect(establish).toHaveBeenCalledWith({
      rootPath: root, projectId: 'repo-1', launchContext, allowLegacyProjectIdAdoption: false
    });
  });

  test('fails closed before writing when the calling task is absent', async () => {
    const root = await runtimeProject();
    const establish = vi.fn();
    await expect(establishSelectedProjectRuntimeBinding(
      {
        rootPath: root,
        projectId: 'repo-1',
        launchContext: { source: 'argv', callingThreadId: 'thread-calling-chat' }
      },
      async () => [],
      establish
    )).rejects.toThrow('codex_hosted_calling_thread_not_in_project:thread-calling-chat');
    expect(establish).not.toHaveBeenCalled();
  });

  test('keeps an exact existing runtime authority byte-stable', async () => {
    const root = await runtimeProject();
    await establishRuntimeBinding({
      rootPath: root,
      projectId: 'repo-1',
      launchContext: { source: 'standalone', callingThreadId: null },
      authorityId: () => 'runtime-authority-1',
      now: () => new Date('2026-08-25T00:00:00.000Z')
    });
    const before = await readFile(path.join(root, '.orquesta', 'state', 'runtime-binding.json'));
    const establish = vi.fn();

    await establishSelectedProjectRuntimeBinding(
      { rootPath: root, projectId: 'repo-1' },
      async () => [],
      establish
    );

    expect(establish).not.toHaveBeenCalled();
    await expect(readRuntimeBinding(root)).resolves.toMatchObject({ runtime_authority_id: 'runtime-authority-1' });
    expect(await readFile(path.join(root, '.orquesta', 'state', 'runtime-binding.json'))).toEqual(before);
  });
});

describe('rootless project bootstrap cutover', () => {
  test('resolves Desktop operation assets only from the packaged runtime authority', async () => {
    const runtimeDist = await mkdtemp(path.join(os.tmpdir(), 'orquesta-runtime-assets-'));
    roots.push(runtimeDist);
    const references = path.join(runtimeDist, 'orquesta', 'references');
    await mkdir(references, { recursive: true });
    await writeFile(path.join(references, 'desktop-operation-catalog.generated.json'), '{}\n', 'utf8');

    expect(resolveDesktopOperationRoot({ ORQUESTA_NEXT_RUNTIME_DIST: runtimeDist })).toBe(runtimeDist);
    expect(() => resolveDesktopOperationRoot({})).toThrow('desktop_operation_root_unavailable');
    expect(() => resolveDesktopOperationRoot({ ORQUESTA_NEXT_RUNTIME_DIST: 'relative-runtime' }))
      .toThrow('desktop_operation_root_unavailable');
  });

  test('returns legacy v2 read-only before reconciling a conflicting runtime launch mode', async () => {
    const root = await runtimeProject();
    const organizationPath = path.join(root, '.orquesta', 'state', 'organization.json');
    const rolesPath = path.join(root, '.orquesta', 'state', 'roles.json');
    await writeFile(organizationPath, '{"schema_version":2,"revision":1}\n', 'utf8');
    await writeFile(rolesPath, '{"schema_version":1,"roles":[]}\n', 'utf8');
    await establishRuntimeBinding({
      rootPath: root,
      projectId: 'project-1',
      launchContext: { source: 'standalone', callingThreadId: null },
      authorityId: () => 'runtime-authority-legacy',
      now: () => new Date('2026-08-25T00:00:00.000Z')
    });
    const bindingPath = path.join(root, '.orquesta', 'state', 'runtime-binding.json');
    const before = await Promise.all([readFile(organizationPath), readFile(rolesPath), readFile(bindingPath)]);
    const listThreads = vi.fn(async () => [{ id: 'thread-calling-chat', archived: false }]);

    const result = await prepareSelectedProjectBootstrap({
      rootPath: root,
      projectId: 'project-1',
      launchContext: { source: 'argv', callingThreadId: 'thread-calling-chat' }
    }, listThreads);

    expect(result.classification).toMatchObject({
      status: 'legacy_v2', reason: 'organization_v2_migration_required', no_write: true
    });
    expect(listThreads).not.toHaveBeenCalled();
    expect(await Promise.all([readFile(organizationPath), readFile(rolesPath), readFile(bindingPath)])).toEqual(before);
  });

  test('resumes from a binding-only crash and reaches ready with the same validated receipt', async () => {
    const root = await runtimeProject();
    const selection = { rootPath: root, projectId: 'project-1' };

    const bindingOnly = await prepareSelectedProjectBootstrap(selection, async () => []);
    expect(bindingOnly.classification).toMatchObject({ status: 'fresh' });
    expect(bindingOnly.runtimeEvidence?.sha256).toMatch(/^[a-f0-9]{64}$/u);
    const bindingBytes = await readFile(path.join(root, '.orquesta', 'state', 'runtime-binding.json'));

    // A new Core process has no in-memory bootstrap service. It must recover from canonical evidence alone.
    const afterRestart = await prepareSelectedProjectBootstrap(selection, async () => []);
    expect(afterRestart.classification).toMatchObject({ status: 'fresh' });
    expect(afterRestart.runtimeEvidence?.sha256).toBe(bindingOnly.runtimeEvidence?.sha256);
    expect(await readFile(path.join(root, '.orquesta', 'state', 'runtime-binding.json'))).toEqual(bindingBytes);

    const sendMessage = vi.fn(async (input: { targetAgentId: string }) => ({
      threadId: `thread-${input.targetAgentId}`,
      turnId: `turn-${input.targetAgentId}`,
      modelEvidence: {
        recommendedModel: null,
        requestedModel: null,
        appliedModel: null,
        actualModel: null,
        actualModelEvidence: 'unknown' as const
      }
    }));
    const readTurnStatus = vi.fn(async () => 'completed');
    const listConversation = vi.fn(async (input: { targetAgentId: string }) => ({
      items: [{
        id: `agent-turn-${input.targetAgentId}`,
        role: 'agent' as const,
        targetAgentId: input.targetAgentId,
        authorLabel: input.targetAgentId,
        text: `<orquesta_foundation_receipt version="1" agent_id="${input.targetAgentId}" status="accepted" />`,
        createdAt: '2026-08-25T00:00:00.000Z',
        evidenceLabel: 'test',
        turnId: `turn-${input.targetAgentId}`
      }],
      nextCursor: null
    }));
    const writerLease = new ProjectWriterLease();
    await writerLease.select(root, selection.projectId);
    try {
      const service = await ProjectBootstrapPlacementService.create({
        productRoot: PRODUCT_ROOT,
        projectRoot: root,
        projectId: selection.projectId,
        runtime: { sendMessage, readTurnStatus, listConversation } as Pick<
          DesktopCodexService,
          'sendMessage' | 'readTurnStatus' | 'listConversation'
        >
      });
      expect(service.runtime_binding_sha256).toBe(afterRestart.runtimeEvidence?.sha256);
      await expect(service.bootstrap({ bootstrapId: 'binding-restart-proof' }))
        .resolves.toMatchObject({ status: 'ready' });
    } finally {
      await writerLease.release();
    }

    const ready = await inspectSelectedProjectBootstrap(selection);
    expect(ready.classification).toMatchObject({ status: 'ready' });
    expect(ready.runtimeEvidence?.sha256).toBe(afterRestart.runtimeEvidence?.sha256);
  });

  test('rejects a foreign project binding before any bootstrap write', async () => {
    const root = await runtimeProject();
    await establishRuntimeBinding({
      rootPath: root,
      projectId: 'foreign-project',
      launchContext: { source: 'standalone', callingThreadId: null }
    });
    const bindingPath = path.join(root, '.orquesta', 'state', 'runtime-binding.json');
    const before = await readFile(bindingPath);

    await expect(prepareSelectedProjectBootstrap(
      { rootPath: root, projectId: 'project-1' },
      async () => []
    )).rejects.toThrow('runtime_binding_project_mismatch');
    expect(await readFile(bindingPath)).toEqual(before);
    await expect(access(path.join(root, '.orquesta', 'state', 'organization.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('rejects a tampered root binding byte-stably before any bootstrap write', async () => {
    const root = await runtimeProject();
    await establishRuntimeBinding({
      rootPath: root,
      projectId: 'project-1',
      launchContext: { source: 'standalone', callingThreadId: null }
    });
    const evidence = await readRuntimeBindingEvidence(root);
    if (!evidence) throw new Error('runtime binding was not created');
    const tampered = JSON.parse(await readFile(evidence.filePath, 'utf8')) as Record<string, unknown>;
    tampered.project_root_fingerprint = '0'.repeat(64);
    await writeFile(evidence.filePath, `${JSON.stringify(tampered, null, 2)}\n`, 'utf8');
    const before = await readFile(evidence.filePath);

    await expect(prepareSelectedProjectBootstrap(
      { rootPath: root, projectId: 'project-1' },
      async () => []
    )).rejects.toThrow('runtime_binding_project_mismatch');
    expect(await readFile(evidence.filePath)).toEqual(before);
    await expect(access(path.join(root, '.orquesta', 'state', 'organization.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('keeps unsupported Organization authority byte-stable and returns unsupported', async () => {
    const root = await runtimeProject();
    const agentsPath = path.join(root, '.orquesta', 'state', 'agents.json');
    await writeFile(agentsPath, '{"schema_version":4}\n', 'utf8');
    const events: Array<Record<string, unknown>> = [];
    let inbound: ((message: unknown) => void) | null = null;
    const transport: DesktopCoreTransport = {
      postMessage: (event) => events.push(event as unknown as Record<string, unknown>),
      onMessage: (listener) => { inbound = listener; },
      exit: vi.fn()
    };
    const runtime = {
      subscribe: vi.fn(),
      subscribeApprovals: vi.fn(),
      subscribeApprovalExpirations: vi.fn(),
      listProjectThreads: vi.fn(async () => []),
      selectAttachmentAuthority: vi.fn(async () => undefined),
      clearAttachmentAuthority: vi.fn(),
      shutdown: vi.fn(async () => undefined)
    } as unknown as DesktopCodexService;
    runDesktopCore(runtime, transport);
    if (!inbound) throw new Error('Core transport was not installed');

    inbound({
      type: 'repository.select',
      correlationId: 'select-1',
      projectId: 'project-1',
      rootPath: root,
      attachmentSealedRoot: 'C:\\private-attachment-sealed-root'
    });
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
      type: 'repository.snapshot.result', correlationId: 'select-1'
    })));
    expect(runtime.selectAttachmentAuthority).toHaveBeenCalledWith('C:\\private-attachment-sealed-root');
    expect(JSON.stringify(events)).not.toContain('private-attachment-sealed-root');
    inbound({ type: 'project.bootstrap', correlationId: 'bootstrap-1' });
    await vi.waitFor(() => expect(events).toContainEqual({
      type: 'project.bootstrap.result',
      correlationId: 'bootstrap-1',
      result: {
        status: 'unsupported',
        no_write: true,
        reason: 'organization_authority_schema_unsupported',
        classification: 'unsupported'
      }
    }));

    await expect(readFile(agentsPath, 'utf8')).resolves.toBe('{"schema_version":4}\n');
    await expect(access(path.join(root, '.orquesta', 'state', 'runtime-binding.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(path.join(root, '.orquesta', 'state', 'runtime', 'project-writer-v1.lock')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    inbound({ type: 'core.shutdown' });
    await vi.waitFor(() => expect(runtime.shutdown).toHaveBeenCalledOnce());
    expect(runtime.clearAttachmentAuthority).toHaveBeenCalledOnce();
  });

  test('does not project a private attachment root from repository selection failure', async () => {
    const root = await runtimeProject();
    await writeFile(path.join(root, '.orquesta', 'state', 'roles.json'), '{"schema_version":2}\n', 'utf8');
    const privateRoot = path.join(root, 'PRIVATE_ATTACHMENT_ROOT_SENTINEL');
    const events: Array<Record<string, unknown>> = [];
    let inbound: ((message: unknown) => void) | null = null;
    const transport: DesktopCoreTransport = {
      postMessage: (event) => events.push(event as unknown as Record<string, unknown>),
      onMessage: (listener) => { inbound = listener; },
      exit: vi.fn()
    };
    const runtime = {
      subscribe: vi.fn(),
      subscribeApprovals: vi.fn(),
      subscribeApprovalExpirations: vi.fn(),
      listProjectThreads: vi.fn(async () => []),
      selectAttachmentAuthority: vi.fn(async () => {
        throw new Error(`EACCES: permission denied, lstat '${privateRoot}'`);
      }),
      clearAttachmentAuthority: vi.fn(async () => undefined),
      shutdown: vi.fn(async () => undefined)
    } as unknown as DesktopCodexService;
    runDesktopCore(runtime, transport);
    if (!inbound) throw new Error('Core transport was not installed');

    inbound({
      type: 'repository.select',
      correlationId: 'select-private-root-failure',
      projectId: 'project-1',
      rootPath: root,
      attachmentSealedRoot: privateRoot
    });
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
      type: 'runtime.request.failed',
      correlationId: 'select-private-root-failure',
      reason: 'attachment_root_unavailable'
    })));
    expect(JSON.stringify(events)).not.toContain(privateRoot);
    expect(JSON.stringify(events)).not.toContain('PRIVATE_ATTACHMENT_ROOT_SENTINEL');

    inbound({ type: 'core.shutdown' });
    await vi.waitFor(() => expect(runtime.shutdown).toHaveBeenCalledOnce());
  });

  test('routes internal approvals without swallowing an external approval when no writer lease is selected', async () => {
    const events: Array<Record<string, unknown>> = [];
    let approvalListener: ((approval: RuntimeApprovalRequest) => void) | null = null;
    const transport: DesktopCoreTransport = {
      postMessage: (event) => events.push(event as unknown as Record<string, unknown>),
      onMessage: vi.fn(),
      exit: vi.fn()
    };
    const runtime = {
      subscribe: vi.fn(),
      subscribeApprovals: vi.fn((listener: (approval: RuntimeApprovalRequest) => void) => {
        approvalListener = listener;
      }),
      subscribeApprovalExpirations: vi.fn()
    } as unknown as DesktopCodexService;
    const inspectionHandler = vi.spyOn(InspectionRunController.prototype, 'handleRuntimeApproval')
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error('internal-handler-failed'));
    const workflowHandler = vi.spyOn(WorkflowRunController.prototype, 'handleRuntimeApproval')
      .mockResolvedValue(false);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    runDesktopCore(runtime, transport);
    if (!approvalListener) throw new Error('Approval listener was not installed');
    const approval = (requestId: string): RuntimeApprovalRequest => ({
      projectId: 'repo-1',
      correlationId: `correlation-${requestId}`,
      requestId,
      providerConnectionId: 'provider-connection-1',
      method: 'item/fileChange/requestApproval',
      threadId: `thread-${requestId}`,
      turnId: `turn-${requestId}`,
      targetAgentId: 'orchestrator',
      requestedEffect: { kind: 'file_change', itemId: `item-${requestId}` },
      reason: 'write requested',
      responseOptions: ['accept', 'decline'],
      actionFingerprint: 'a'.repeat(64)
    });

    approvalListener(approval('internal'));
    await vi.waitFor(() => expect(inspectionHandler).toHaveBeenCalledTimes(1));
    expect(events.filter((event) => event.type === 'runtime.approval.requested')).toHaveLength(0);

    const external = approval('external');
    approvalListener(external);
    await vi.waitFor(() => expect(events).toContainEqual({
      type: 'runtime.approval.requested', approval: external
    }));
    expect(workflowHandler).toHaveBeenCalledTimes(1);

    approvalListener(approval('failed-internal'));
    await vi.waitFor(() => expect(consoleError).toHaveBeenCalledWith(
      'Runtime approval routing failed closed', expect.objectContaining({ message: 'internal-handler-failed' })
    ));
    expect(events.filter((event) => event.type === 'runtime.approval.requested')).toHaveLength(1);
  });
});

describe('project message delivery storage activation', () => {
  test('migrates a normal legacy ledger idempotently and leaves it immediately writable', async () => {
    const root = await runtimeProject();
    const legacyPath = path.join(root, '.orquesta', 'state', 'messages.jsonl');
    const backupPath = path.join(root, '.orquesta', 'state', 'messages.migrated-v1.jsonl');
    const source = `${JSON.stringify({
      schema_version: 3,
      message_id: 'message-existing',
      action_fingerprint: 'a'.repeat(64),
      correlation_id: 'message-existing',
      project_id: 'project-1',
      target_agent_id: 'orchestrator',
      thread_id: null,
      turn_id: null,
      state: 'queued',
      observed_at: '2026-08-24T01:00:00.000Z',
      error_code: null
    })}\n`;
    await writeFile(legacyPath, source, 'utf8');
    const migrateMessageDeliveryStorage = vi.fn(migrateLegacyMessageLedger);
    const runtime = { migrateMessageDeliveryStorage };

    await expect(activateProjectMessageDeliveryStorage(runtime, root)).resolves.toMatchObject({
      status: 'completed', no_data_loss: true, backup_path: backupPath, message_count: 1
    });
    await expect(activateProjectMessageDeliveryStorage(runtime, root)).resolves.toMatchObject({
      status: 'not_required', no_data_loss: true, backup_path: backupPath, message_count: 1
    });
    expect(migrateMessageDeliveryStorage).toHaveBeenCalledTimes(2);
    await expect(readFile(backupPath, 'utf8')).resolves.toBe(source);

    const ledger = new MessageLedger({ now: () => new Date('2026-08-24T01:00:01.000Z') });
    await expect(ledger.record({
      rootPath: root,
      messageId: 'message-existing',
      actionFingerprint: 'a'.repeat(64),
      correlationId: 'message-existing',
      projectId: 'project-1',
      targetAgentId: 'orchestrator',
      threadId: 'thread-existing',
      turnId: null,
      state: 'thread_ready'
    })).resolves.toBe(true);
  });

  test('fails closed at activation when legacy and V2 authorities are mixed', async () => {
    const root = await runtimeProject();
    const stateRoot = path.join(root, '.orquesta', 'state');
    const legacyPath = path.join(stateRoot, 'messages.jsonl');
    const backupPath = path.join(stateRoot, 'messages.migrated-v1.jsonl');
    await writeFile(legacyPath, '{}\n', 'utf8');
    await mkdir(path.join(stateRoot, 'message-delivery-v1'), { recursive: true });

    await expect(activateProjectMessageDeliveryStorage({
      migrateMessageDeliveryStorage: migrateLegacyMessageLedger
    }, root)).rejects.toThrow('message_ledger_migration_destination_conflict');
    await expect(readFile(legacyPath, 'utf8')).resolves.toBe('{}\n');
    await expect(access(backupPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
