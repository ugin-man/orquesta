import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { DesktopCodexService } from './desktop-codex-service';
import { DesktopExecutionKernelController } from './desktop-execution-kernel';
import { DesktopExecutionShadowController } from './desktop-execution-shadow';
import { handleCoreRequest } from './handler';
import type { CoreDispatchRequest, CoreEvent, RepositorySelectRequest } from './protocol';
import { InspectionRunController } from './inspection-run-controller';
import { legacyCodexHostedSessionIds, migrateLegacyCodexHostedSessions } from './legacy-runtime-session-migration';
import { applyLegacyOrganizationMigration, readLegacyOrganizationMigration } from './legacy-organization-migration';
import { RepositoryRuntime } from './repository-runtime';
import { ProjectThreadReconciler } from './project-thread-reconciler';
import { establishRuntimeBinding } from './runtime-binding-store';
import { SessionRotationController } from './session-rotation-controller';
import { readSetupLaunchContext, writeSetupLaunchContext } from './setup-launch-context-store';
import { provisionFoundationAgents, provisionSpecialists } from './specialist-provisioner';
import { createDesktopSetupController } from './setup-engine-adapter';
import { createSpecialistProvisioningCoordinator } from './specialist-provisioning-coordinator';

export function preferredFoundationThreadIds(
  environment: NodeJS.ProcessEnv = process.env
): Record<string, string> | undefined {
  const callingThreadId = environment.CODEX_THREAD_ID?.trim();
  return callingThreadId ? { orchestrator: callingThreadId } : undefined;
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
}

export function foundationThreadIdsFromSessions(value: unknown): Record<string, string> {
  const state = record(value);
  const sessions = Array.isArray(state?.sessions) ? state.sessions : [];
  const foundationAgentIds = new Set(['orchestrator', 'orquesta-admin', 'user-support']);
  const selected = new Map<string, { threadId: string; generation: number; updatedAt: number }>();
  for (const value of sessions) {
    const session = record(value);
    const agentId = typeof session?.agent_id === 'string' ? session.agent_id.trim() : '';
    const threadId = typeof session?.thread_id === 'string' ? session.thread_id.trim() : '';
    if (!foundationAgentIds.has(agentId) || !threadId) continue;
    if (session?.accepts_new_work === false
      || (session?.ownership_status && session.ownership_status !== 'owner')
      || (session?.rotation_state && session.rotation_state !== 'active')
      || ['archived', 'missing'].includes(String(session?.binding_status ?? ''))
      || ['failed', 'stale'].includes(String(session?.status ?? ''))) continue;
    const generation = Number.isInteger(session?.session_generation)
      ? Number(session?.session_generation)
      : 1;
    const updatedAt = typeof session?.updated_at === 'string' && Number.isFinite(Date.parse(session.updated_at))
      ? Date.parse(session.updated_at)
      : 0;
    const current = selected.get(agentId);
    if (!current || generation > current.generation
      || (generation === current.generation && updatedAt > current.updatedAt)) {
      selected.set(agentId, { threadId, generation, updatedAt });
    }
  }
  return Object.fromEntries([...selected].map(([agentId, item]) => [agentId, item.threadId]));
}

export async function readFoundationThreadIds(rootPath: string): Promise<Record<string, string>> {
  try {
    return foundationThreadIdsFromSessions(JSON.parse(await readFile(
      path.join(rootPath, '.orquesta', 'state', 'sessions.json'),
      'utf8'
    )));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

export async function verifyProvisionedThreadsVisible(
  rootPath: string,
  listProjectThreads: (rootPath: string) => Promise<Array<{ id: string; archived: boolean }>>,
  bindings: Array<{ thread_id?: string | null; handoff_status?: string | null; status?: string | null }>
): Promise<void> {
  const expected = [...new Set(bindings.flatMap((binding) => {
    const accepted = binding.handoff_status === 'accepted' || binding.status === 'accepted';
    return accepted && binding.thread_id ? [binding.thread_id] : [];
  }))];
  if (!expected.length) return;
  const visible = new Set((await listProjectThreads(rootPath))
    .filter((thread) => !thread.archived)
    .map((thread) => thread.id));
  const missing = expected.filter((threadId) => !visible.has(threadId));
  if (missing.length) {
    throw new Error(`provisioned_thread_not_visible:${missing.join(',')}`);
  }
}

export async function establishExistingProjectRuntimeBinding(
  request: Pick<RepositorySelectRequest, 'rootPath' | 'projectId' | 'launchContext'>,
  listProjectThreads: (rootPath: string) => Promise<Array<{ id: string; archived: boolean }>>,
  establish = establishRuntimeBinding,
  writeLaunchContext = writeSetupLaunchContext
): Promise<void> {
  const launchContext = request.launchContext;
  if (!launchContext?.callingThreadId) return;
  const threads = await listProjectThreads(request.rootPath);
  const callingThread = threads.find((thread) => (
    thread.id === launchContext.callingThreadId && !thread.archived
  ));
  if (!callingThread) {
    throw new Error(`codex_hosted_calling_thread_not_in_project:${launchContext.callingThreadId}`);
  }
  const legacySessionIds = await legacyCodexHostedSessionIds(request.rootPath, threads);
  if (legacySessionIds.length && launchContext.legacyMigration !== true) {
    throw new Error('legacy_project_requires_migration');
  }
  const binding = await establish({
    rootPath: request.rootPath,
    projectId: request.projectId,
    launchContext
  });
  if (legacySessionIds.length) {
    await migrateLegacyCodexHostedSessions({ rootPath: request.rootPath, binding, threads });
  }
  await writeLaunchContext(request.rootPath, launchContext);
}

export function runDesktopCore(runtime: DesktopCodexService): void {
  const parentPort = process.parentPort;
  if (!parentPort) throw new Error('Orquesta Core must run as an Electron utility process');

  const coordinatedProvisioning = createSpecialistProvisioningCoordinator(async ({ projectId, rootPath, batch }) => {
    const completed = await provisionSpecialists({ root: rootPath, projectId, batch, runtime });
    await verifyProvisionedThreadsVisible(rootPath, (projectRoot) => runtime.listProjectThreads(projectRoot), completed.requests);
    return completed;
  });
  const threadReconciler = new ProjectThreadReconciler({
    listProjectThreads: (rootPath) => runtime.listProjectThreads(rootPath),
    setThreadName: (input) => runtime.setThreadName(input)
  });
  const repository = new RepositoryRuntime({
    provisionSetupSpecialists: async (input) => { await coordinatedProvisioning(input); },
    reconcileProjectThreads: (rootPath) => threadReconciler.reconcile(rootPath)
  });
  const inspections = new InspectionRunController({ runtime });
  const sessionRotation = new SessionRotationController({ runtime });
  const executionKernel = new DesktopExecutionKernelController({ runtime });
  const executionShadow = new DesktopExecutionShadowController({ runtime });
  const send = (event: CoreEvent) => parentPort.postMessage(event);
  const setup = createDesktopSetupController({
    provisionFoundation: async ({ rootPath, projectId, agentIds }) => {
      const launchContext = await readSetupLaunchContext(rootPath);
      const recordedThreadIds = await readFoundationThreadIds(rootPath);
      let preferredThreadIds = {
        ...recordedThreadIds,
        ...(launchContext ? {} : preferredFoundationThreadIds())
      };
      if (launchContext?.callingThreadId) {
        const liveThreads = await runtime.listProjectThreads(rootPath);
        const callingThread = liveThreads.find((thread) => (
          thread.id === launchContext.callingThreadId && !thread.archived
        ));
        if (!callingThread) {
          throw new Error('The calling Codex task is not available in the selected project');
        }
        preferredThreadIds = {
          ...preferredThreadIds,
          orchestrator: launchContext.callingThreadId
        };
      }
      const completed = await provisionFoundationAgents({
        root: rootPath,
        projectId,
        agentIds,
        preferredThreadIds,
        runtime
      });
      await verifyProvisionedThreadsVisible(rootPath, (projectRoot) => runtime.listProjectThreads(projectRoot), completed);
      return completed;
    },
    provisionSpecialists: coordinatedProvisioning,
    onProgress: (progress) => send({ type: 'setup.progress', progress }),
    onBackgroundError: (error) => {
      console.error('Initial setup runner failed outside a phase boundary', error);
    }
  });
  runtime.subscribe((notification) => {
    send({ type: 'runtime.notification', notification });
    void sessionRotation.observe(notification).catch((error) => {
      console.error('Session rotation observation failed', error);
    });
    void executionKernel.observe(notification);
    void executionShadow.observe(notification);
    void inspections.handleRuntimeNotification(notification);
  });
  runtime.subscribeApprovals((approval) => {
    void inspections.handleRuntimeApproval(approval).then((handled) => {
      if (!handled) repository.addRuntimeApproval(approval);
    });
  });
  repository.subscribe((snapshot) => send({ type: 'repository.snapshot.changed', snapshot }));

  const stop = () => {
    void Promise.all([runtime.shutdown(), repository.stop()]).finally(() => {
      send({ type: 'core.stopped' });
      setImmediate(() => process.exit(0));
    });
  };

  const dispatch = (request: CoreDispatchRequest) => {
    void (async () => {
      try {
        if (request.type === 'organization.migration.read') {
          const result = await readLegacyOrganizationMigration(request);
          send({ type: 'organization.migration.result', correlationId: request.correlationId, result });
        } else if (request.type === 'organization.migration.apply') {
          const result = await applyLegacyOrganizationMigration(request);
          send({ type: 'organization.migration.result', correlationId: request.correlationId, result });
        } else if (request.type === 'repository.select') {
          await establishExistingProjectRuntimeBinding(
            request,
            (rootPath) => runtime.listProjectThreads(rootPath)
          );
          await repository.select(request);
          await executionKernel.open(request.rootPath);
          await executionShadow.open(request.rootPath);
          await inspections.reconcileProject(request.projectId, request.rootPath);
          await sessionRotation.open(request.rootPath, request.projectId);
          const snapshot = await repository.refresh();
          send({ type: 'repository.snapshot.result', correlationId: request.correlationId, snapshot });
          await setup.resume({ rootPath: request.rootPath });
        } else if (request.type === 'repository.get-snapshot') {
          const snapshot = await repository.refresh();
          send({ type: 'repository.snapshot.result', correlationId: request.correlationId, snapshot });
        } else if (request.type === 'repository.close') {
          await repository.stop();
        } else if (request.type === 'repository.attention-history') {
          send({
            type: 'repository.attention-history.result',
            correlationId: request.correlationId,
            items: repository.listAttentionHistory()
          });
        } else if (request.type === 'runtime.approval.respond') {
          const approval = repository.runtimeApproval(request.attentionId);
          if (!approval) throw new Error('Runtime approval is no longer pending');
          const result = await runtime.respondToApproval({
            correlationId: request.correlationId,
            requestId: approval.requestId,
            decision: request.decision
          });
          repository.resolveRuntimeApproval(request.attentionId, result.decision);
          send({
            type: 'runtime.approval.accepted',
            correlationId: request.correlationId,
            attentionId: request.attentionId,
            decision: result.decision
          });
        } else if (request.type === 'runtime.send') {
          await threadReconciler.reconcile(request.rootPath);
          await sessionRotation.ensureReadyForDispatch(request.rootPath, request.projectId, request.targetAgentId);
          await threadReconciler.reconcile(request.rootPath);
          const threadId = await threadReconciler.resolveBoundThread(request.rootPath, request.targetAgentId);
          const runtimeInput = {
            ...request,
            threadId,
            recommendedModel: request.recommendedModel ?? null,
            requestedModel: request.requestedModel ?? null
          };
          const result = executionKernel.enabled
            ? await executionKernel.dispatch(runtimeInput)
            : executionShadow.enabled
              ? await executionShadow.execute(runtimeInput, () => runtime.sendMessage(runtimeInput))
              : await runtime.sendMessage(runtimeInput);
          send({ type: 'runtime.dispatch.accepted', correlationId: request.correlationId, ...result });
        } else if (request.type === 'runtime.luca.send') {
          await threadReconciler.reconcile(request.rootPath);
          await sessionRotation.ensureReadyForDispatch(request.rootPath, request.projectId, 'orquesta-admin');
          await threadReconciler.reconcile(request.rootPath);
          const threadId = await threadReconciler.resolveBoundThread(request.rootPath, 'orquesta-admin');
          const result = await runtime.sendLucaQuestion({ ...request, threadId });
          send({ type: 'runtime.dispatch.accepted', correlationId: request.correlationId, ...result });
        } else if (request.type === 'inspection.start') {
          const result = await inspections.start(request);
          send({ type: 'inspection.action.accepted', correlationId: request.correlationId, runId: result.runId });
        } else if (request.type === 'inspection.cancel') {
          await inspections.cancel(request);
          send({ type: 'inspection.action.accepted', correlationId: request.correlationId, runId: request.runId });
        } else if (request.type === 'inspection.read-report') {
          const markdown = await inspections.readReport(request);
          send({ type: 'inspection.report.result', correlationId: request.correlationId, runId: request.runId, markdown });
        } else if (request.type === 'runtime.conversation') {
          await threadReconciler.reconcile(request.rootPath);
          const generations = await threadReconciler.resolveConversationSessions(request.rootPath, request.targetAgentId);
          const page = await runtime.listLogicalConversation({ ...request, generations });
          send({ type: 'runtime.conversation.result', correlationId: request.correlationId, page });
        } else if (request.type === 'setup.account.read') {
          const account = await runtime.readAccount();
          send({ type: 'setup.account.result', correlationId: request.correlationId, account });
        } else if (request.type === 'setup.account.login.start') {
          const login = await runtime.startChatGptLogin();
          send({ type: 'setup.account.login.started', correlationId: request.correlationId, login });
        } else if (request.type === 'setup.start') {
          const launchContext = request.launchContext ?? {
            source: 'standalone',
            callingThreadId: null
          };
          await establishRuntimeBinding({
            rootPath: request.rootPath,
            projectId: request.draft.projectName,
            launchContext
          });
          await writeSetupLaunchContext(request.rootPath, launchContext);
          const result = await setup.start({ rootPath: request.rootPath, draft: request.draft });
          send({ type: 'setup.start.result', correlationId: request.correlationId, result });
        } else {
          const info = await runtime.getRuntimeInfo({ probe: request.probe });
          send({ type: 'runtime.info.result', correlationId: request.correlationId, info });
        }
      } catch (error) {
        send({
          type: 'runtime.request.failed',
          correlationId: request.correlationId,
          reason: error instanceof Error ? error.message.slice(0, 4_096) : String(error).slice(0, 4_096),
          retryable: true
        });
      }
    })();
  };

  parentPort.on('message', (event) => {
    handleCoreRequest(event.data, { send, stop, dispatch });
  });

  send({ type: 'core.ready', version: 1 });
}
