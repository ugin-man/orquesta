import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import executionKernelModule from '@orquesta/execution-kernel';
import {
  AttachmentPreDispatchError,
  ApprovalOutcomeUnknownError,
  DispatchOutcomeUnknownError,
  DispatchTerminalError,
  type DesktopCodexService
} from './desktop-codex-service';
import { DesktopExecutionKernelController, DesktopPreDispatchError } from './desktop-execution-kernel';
import { handleCoreRequest } from './handler';
import type { CoreDispatchRequest, CoreEvent, ProjectBootstrapResult, RepositorySelectRequest } from './protocol';
import { InspectionRunController } from './inspection-run-controller';
import { RepositoryRuntime } from './repository-runtime';
import {
  establishRuntimeBinding,
  readRuntimeBinding,
  readRuntimeBindingEvidence,
  type RuntimeBindingEvidence
} from './runtime-binding-store';
import { ProjectWriterLease } from './project-writer-lease';
import { ProjectBootstrapPlacementService } from './project-bootstrap-placement-service';
import { SessionBindingResolutionError, SessionBindingResolver } from './session-binding-resolver';
import { readBusinessWorkOrders } from './business-work-order-runtime';
import { WorkflowRunController } from './workflow-run-controller';

/**
 * The project activation boundary owns one-time delivery storage upgrades.
 * Ordinary message reads and sends must never attempt this migration implicitly.
 */
export async function activateProjectMessageDeliveryStorage(
  runtime: Pick<DesktopCodexService, 'migrateMessageDeliveryStorage'>,
  rootPath: string
) {
  return runtime.migrateMessageDeliveryStorage(rootPath);
}

class CoreDispatchFailure extends Error {
  readonly retryable: boolean;

  constructor(error: unknown, retryable: boolean) {
    super(error instanceof Error ? error.message : String(error));
    this.name = 'CoreDispatchFailure';
    this.retryable = retryable;
  }
}

export async function establishSelectedProjectRuntimeBinding(
  request: Pick<RepositorySelectRequest, 'rootPath' | 'projectId' | 'launchContext'>,
  listProjectThreads: (rootPath: string) => Promise<Array<{ id: string; archived: boolean }>>,
  establish = establishRuntimeBinding
): Promise<void> {
  const launchContext = request.launchContext ?? { source: 'standalone' as const, callingThreadId: null };
  if (launchContext.callingThreadId) {
    const threads = await listProjectThreads(request.rootPath);
    if (!threads.some((thread) => thread.id === launchContext.callingThreadId && !thread.archived)) {
      throw new Error(`codex_hosted_calling_thread_not_in_project:${launchContext.callingThreadId}`);
    }
  }
  const existing = await readRuntimeBinding(request.rootPath);
  const expectedMode = launchContext.callingThreadId ? 'codex_hosted' : 'standalone';
  const expectedTransport = launchContext.callingThreadId ? 'codex_shared_app_server' : 'app_server';
  if (existing) {
    if (existing.project_id !== request.projectId
      || existing.mode !== expectedMode
      || existing.transport !== expectedTransport
      || existing.calling_thread_id !== launchContext.callingThreadId) {
      throw new Error('runtime_authority_conflict');
    }
    return;
  }
  await establish({
    rootPath: request.rootPath,
    projectId: request.projectId,
    launchContext,
    allowLegacyProjectIdAdoption: false
  });
}

export async function inspectSelectedProjectBootstrap(
  request: Pick<RepositorySelectRequest, 'rootPath' | 'projectId'>
): Promise<{ classification: Record<string, unknown>; runtimeEvidence: RuntimeBindingEvidence | null }> {
  const runtimeEvidence = await readRuntimeBindingEvidence(request.rootPath);
  if (runtimeEvidence && runtimeEvidence.binding.project_id !== request.projectId) {
    throw new Error('runtime_binding_project_mismatch');
  }
  const classification = executionKernelModule.classifyFoundationBootstrapV3({
    projectRoot: request.rootPath,
    projectId: request.projectId,
    validatedRuntimeBindingSha256: runtimeEvidence?.sha256 ?? null
  }) as unknown as Record<string, unknown>;
  if (typeof classification.status !== 'string') {
    throw new Error('foundation_bootstrap_classification_invalid');
  }
  return { classification, runtimeEvidence };
}

export async function prepareSelectedProjectBootstrap(
  request: Pick<RepositorySelectRequest, 'rootPath' | 'projectId' | 'launchContext'>,
  listProjectThreads: (rootPath: string) => Promise<Array<{ id: string; archived: boolean }>>
): Promise<{ classification: Record<string, unknown>; runtimeEvidence: RuntimeBindingEvidence | null }> {
  const before = await inspectSelectedProjectBootstrap(request);
  const rejected = rejectedBootstrapClassification(before.classification);
  if (rejected) return before;
  if (!before.runtimeEvidence && before.classification.status !== 'fresh') return before;
  await establishSelectedProjectRuntimeBinding(request, listProjectThreads);
  const runtimeEvidence = await readRuntimeBindingEvidence(request.rootPath);
  if (!runtimeEvidence || runtimeEvidence.binding.project_id !== request.projectId) {
    throw new Error('runtime_binding_missing_after_write');
  }
  const classification = executionKernelModule.classifyFoundationBootstrapV3({
    projectRoot: request.rootPath,
    projectId: request.projectId,
    validatedRuntimeBindingSha256: runtimeEvidence.sha256
  }) as unknown as Record<string, unknown>;
  if (typeof classification.status !== 'string') {
    throw new Error('foundation_bootstrap_classification_invalid');
  }
  return { classification, runtimeEvidence };
}

function bootstrapResult(value: Record<string, unknown>): ProjectBootstrapResult {
  const rawStatus = String(value.status ?? 'unsupported');
  const status: ProjectBootstrapResult['status'] = rawStatus === 'repair_required'
    ? 'recovery_required'
    : ['ready', 'migration_required', 'unsupported', 'recovery_required'].includes(rawStatus)
      ? rawStatus as ProjectBootstrapResult['status']
      : 'unsupported';
  return {
    status,
    no_write: value.no_write === true,
    reason: typeof value.reason === 'string' ? value.reason : null,
    classification: typeof value.classification === 'string' ? value.classification : null
  };
}

function rejectedBootstrapClassification(value: Record<string, unknown>): ProjectBootstrapResult | null {
  const status = String(value.status ?? 'unsupported');
  if (status === 'legacy_v2' || status === 'mixed_v2' || status === 'partial') {
    return {
      status: 'migration_required',
      no_write: true,
      reason: typeof value.reason === 'string' ? value.reason : status,
      classification: status
    };
  }
  if (status === 'unsupported') {
    return {
      status: 'unsupported',
      no_write: true,
      reason: typeof value.reason === 'string' ? value.reason : 'unsupported',
      classification: status
    };
  }
  return null;
}

export function resolveDesktopOperationRoot(environment: NodeJS.ProcessEnv = process.env): string {
  const runtimeDist = environment.ORQUESTA_NEXT_RUNTIME_DIST;
  if (typeof runtimeDist !== 'string' || !path.isAbsolute(runtimeDist)) {
    throw new Error('desktop_operation_root_unavailable');
  }
  const root = path.resolve(runtimeDist);
  const catalog = path.join(root, 'orquesta', 'references', 'desktop-operation-catalog.generated.json');
  if (!existsSync(catalog)) throw new Error('desktop_operation_catalog_unavailable');
  return root;
}

export interface DesktopCoreTransport {
  postMessage(event: CoreEvent): void;
  onMessage(listener: (message: unknown) => void): void;
  exit(code: number): void;
}

export function runDesktopCore(runtime: DesktopCodexService, coreTransport: DesktopCoreTransport): void {
  const writerLeases = new ProjectWriterLease();
  const repository = new RepositoryRuntime();
  const inspections = new InspectionRunController({ runtime });
  const workflows = new WorkflowRunController({ runtime });
  const sessionBindings = new SessionBindingResolver();
  const executionKernel = new DesktopExecutionKernelController({ runtime });
  const send = (event: CoreEvent) => coreTransport.postMessage(event);
  let selectedProject: Omit<RepositorySelectRequest, 'type' | 'correlationId' | 'attachmentSealedRoot'> | null = null;
  let bootstrapInFlight: Promise<ProjectBootstrapResult> | null = null;
  runtime.subscribe((notification) => {
    send({ type: 'runtime.notification', notification });
    if (notification.kind === 'provider_connection') return;
    void writerLeases.runSelected(async ({ rootPath }) => {
      const [, , workflowHandled] = await Promise.all([
        executionKernel.observe(notification, rootPath),
        inspections.handleRuntimeNotification(notification, rootPath),
        workflows.handleRuntimeNotification(notification, rootPath)
      ]);
      if (workflowHandled && notification.kind !== 'agent_message') {
        send({ type: 'workflow.catalog.changed', catalog: await workflows.readCatalog(rootPath) });
      }
    }).catch((error) => {
      console.error('Runtime notification observation failed', error);
    });
  });
  runtime.subscribeApprovals((approval) => {
    void (async () => {
      // Each internal controller first checks its own thread ownership and
      // returns false without side effects for an ordinary user approval. Do
      // not gate that classification on the selected writer lease: a missing
      // or rotating lease must never make an external approval disappear.
      const inspectionHandled = await inspections.handleRuntimeApproval(approval);
      const workflowHandled = !inspectionHandled && await workflows.handleRuntimeApproval(approval);
      if (
        workflowHandled
        && selectedProject?.projectId === approval.projectId
      ) {
        send({
          type: 'workflow.catalog.changed',
          catalog: await workflows.readCatalog(selectedProject.rootPath),
        });
      }
      return inspectionHandled || workflowHandled;
    })().then((handled) => {
      if (!handled) send({ type: 'runtime.approval.requested', approval });
    }).catch((error) => {
      // Unknown approvals return false before either controller can throw. A
      // handler failure therefore belongs to a claimed internal read-only run
      // and must fail closed instead of becoming a user permission request.
      console.error('Runtime approval routing failed closed', error);
    });
  });
  runtime.subscribeApprovalExpirations((threadId, turnId) => {
    if (turnId) send({ type: 'runtime.approval.expired', threadId, turnId });
  });
  repository.subscribe((snapshot) => send({ type: 'repository.snapshot.changed', snapshot }));

  const stop = () => {
    void writerLeases.close(async () => {
      await runtime.clearAttachmentAuthority();
      await Promise.all([runtime.shutdown(), repository.stop()]);
    })
      .finally(() => {
      send({ type: 'core.stopped' });
      setImmediate(() => coreTransport.exit(0));
    });
  };

  const dispatch = (request: CoreDispatchRequest) => {
    void (async () => {
      try {
      const execute = async () => {
        if (request.type === 'repository.select') {
          if (bootstrapInFlight) throw new Error('project_bootstrap_in_progress');
          const canonicalRoot = await realpath(request.rootPath);
          await inspectSelectedProjectBootstrap({ rootPath: canonicalRoot, projectId: request.projectId });
          try {
            await runtime.selectAttachmentAuthority(request.attachmentSealedRoot);
          } catch {
            // The attachment root is a private Native -> Core authority. Never project
            // raw filesystem errors because Node includes the rejected absolute path.
            throw new Error('attachment_root_unavailable');
          }
          try {
            if (writerLeases.hasSelectedWriter()) {
              await repository.stop();
              await writerLeases.release();
            }
            selectedProject = {
              projectId: request.projectId,
              rootPath: canonicalRoot,
              launchContext: request.launchContext
            };
            bootstrapInFlight = null;
            const repositoryRequest: RepositorySelectRequest = {
              type: 'repository.select',
              correlationId: request.correlationId,
              projectId: request.projectId,
              rootPath: canonicalRoot,
              attachmentSealedRoot: request.attachmentSealedRoot,
              ...(request.launchContext ? { launchContext: request.launchContext } : {})
            };
            const { attachmentSealedRoot: _privateAttachmentRoot, ...sanitizedRepositoryRequest } = repositoryRequest;
            const snapshot = repository.selectUninitialized(sanitizedRepositoryRequest);
            send({ type: 'repository.snapshot.result', correlationId: request.correlationId, snapshot });
          } catch (error) {
            await runtime.clearAttachmentAuthority();
            throw error;
          }
        } else if (request.type === 'project.bootstrap') {
          if (!selectedProject) throw new Error('project_bootstrap_requires_selected_project');
          const selection = selectedProject;
          bootstrapInFlight ??= (async () => {
            const { classification, runtimeEvidence } = await prepareSelectedProjectBootstrap(
              selection,
              (rootPath) => runtime.listProjectThreads(rootPath)
            );
            const rejected = rejectedBootstrapClassification(classification);
            if (rejected) return rejected;
            if (!['fresh', 'prepared', 'incomplete', 'ready'].includes(String(classification.status))) {
              return {
                status: 'unsupported' as const,
                no_write: true,
                reason: 'unsupported_bootstrap_state',
                classification: String(classification.status)
              };
            }
            if (!runtimeEvidence) throw new Error('runtime_binding_missing_after_prepare');
            const service = await ProjectBootstrapPlacementService.create({
              productRoot: resolveDesktopOperationRoot(),
              projectRoot: selection.rootPath,
              projectId: selection.projectId,
              runtime
            });
            if (service.runtime_binding_sha256 !== runtimeEvidence.sha256) {
              throw new Error('runtime_binding_changed_before_service');
            }
            await writerLeases.select(selection.rootPath, selection.projectId);
            try {
              const result = await writerLeases.runSelected(() => service.bootstrap());
              const projected = bootstrapResult(result);
              if (projected.status === 'ready') {
                await activateProjectMessageDeliveryStorage(runtime, selection.rootPath);
                await repository.select(selection);
                await executionKernel.open(selection.rootPath);
                await inspections.reconcileProject(selection.projectId, selection.rootPath);
                await workflows.reconcileProject(selection.projectId, selection.rootPath);
                await repository.refresh();
              }
              return projected;
            } catch (error) {
              await repository.stop().catch(() => undefined);
              await writerLeases.release().catch(() => undefined);
              throw error;
            }
          })().finally(() => { bootstrapInFlight = null; });
          const result = await bootstrapInFlight;
          send({ type: 'project.bootstrap.result', correlationId: request.correlationId, result });
        } else if (request.type === 'repository.get-snapshot') {
          const snapshot = repository.getSnapshot();
          send({ type: 'repository.snapshot.result', correlationId: request.correlationId, snapshot });
        } else if (request.type === 'business.work-orders.read') {
          const rootPath = writerLeases.selectedRootPath;
          const runtimeProjectId = writerLeases.selectedProjectId;
          if (!rootPath || !runtimeProjectId) throw new Error('project_writer_lease_not_selected');
          if (request.projectId !== runtimeProjectId) {
            throw Object.assign(new Error('Business request does not match the selected project'), {
              code: 'BUSINESS_DESKTOP_PROJECT_MISMATCH'
            });
          }
          const result = await readBusinessWorkOrders({
            request,
            runtimeProjectId,
            rootPath
          });
          send({ type: 'business.work-orders.result', correlationId: request.correlationId, result });
        } else if (request.type === 'runtime.approval.respond') {
          const result = await runtime.respondToApproval({
            correlationId: request.correlationId,
            requestId: request.requestId,
            providerConnectionId: request.providerConnectionId,
            decision: request.decision
          });
          send({
            type: 'runtime.approval.accepted',
            correlationId: request.correlationId,
            attentionId: request.attentionId,
            requestId: result.requestId,
            providerConnectionId: result.providerConnectionId,
            decision: result.decision
          });
        } else if (request.type === 'runtime.send') {
          let activeSession;
          try {
            activeSession = await sessionBindings.resolveActiveSession(
              request.rootPath,
              request.projectId,
              request.targetAgentId
            );
            if (request.attachments.some((attachment) => attachment.kind === 'text')
              && activeSession.attachmentToolState !== 'supported') {
              throw new SessionBindingResolutionError(
                'SESSION_BINDING_ATTACHMENT_TOOL_UNSUPPORTED',
                'この会話は通常ファイル添付に未対応です。新しい会話で利用できます'
              );
            }
          } catch (error) {
            throw new CoreDispatchFailure(error, true);
          }
          const runtimeInput = {
            ...request,
            threadId: activeSession.threadId,
            attachmentToolState: activeSession.attachmentToolState,
            recommendedModel: request.recommendedModel ?? null,
            requestedModel: request.requestedModel ?? null
          };
          let result;
          try {
            result = executionKernel.enabled
              ? await executionKernel.dispatch(runtimeInput)
              : await runtime.sendMessage(runtimeInput);
          } catch (error) {
            if (error instanceof AttachmentPreDispatchError
              || error instanceof DispatchOutcomeUnknownError
              || error instanceof DispatchTerminalError) throw error;
            throw new CoreDispatchFailure(error, error instanceof DesktopPreDispatchError);
          }
          send({ type: 'runtime.dispatch.accepted', correlationId: request.correlationId, ...result });
        } else if (request.type === 'runtime.dispatch.reconcile') {
          const result = await runtime.reconcileDispatch(request);
          send({ type: 'runtime.dispatch.accepted', correlationId: request.correlationId, ...result });
        } else if (request.type === 'runtime.turn.interrupt') {
          await runtime.interruptTurn({
            correlationId: request.correlationId,
            threadId: request.threadId,
            turnId: request.turnId,
          });
          send({
            type: 'runtime.turn.interrupt.accepted',
            correlationId: request.correlationId,
            targetAgentId: request.targetAgentId,
            threadId: request.threadId,
            turnId: request.turnId,
          });
        } else if (request.type === 'runtime.turn.steer') {
          const result = await runtime.steerTurn(request);
          send({
            type: 'runtime.turn.steer.accepted',
            correlationId: request.correlationId,
            steerId: request.steerId,
            targetAgentId: request.targetAgentId,
            threadId: result.threadId,
            turnId: result.turnId,
          });
        } else if (request.type === 'inspection.start') {
          const result = await inspections.start(request);
          send({ type: 'inspection.action.accepted', correlationId: request.correlationId, runId: result.runId });
        } else if (request.type === 'inspection.cancel') {
          await inspections.cancel(request);
          send({ type: 'inspection.action.accepted', correlationId: request.correlationId, runId: request.runId });
        } else if (request.type === 'workflow.catalog.read') {
          const catalog = await workflows.readCatalog(request.rootPath);
          send({ type: 'workflow.catalog.result', correlationId: request.correlationId, catalog });
        } else if (request.type === 'workflow.definition.save') {
          const definition = await workflows.saveDefinition(request);
          send({
            type: 'workflow.action.result', correlationId: request.correlationId,
            workflowId: definition.workflowId, batchId: null
          });
        } else if (request.type === 'workflow.batch.start') {
          const result = await workflows.startBatch(request);
          send({
            type: 'workflow.action.result', correlationId: request.correlationId,
            workflowId: request.workflowId, batchId: result.batchId
          });
        } else if (request.type === 'workflow.batch.cancel') {
          await workflows.cancelBatch(request);
          send({
            type: 'workflow.action.result', correlationId: request.correlationId,
            workflowId: null, batchId: request.batchId
          });
        } else if (request.type === 'workflow.result.read') {
          const output = await workflows.readResult(request);
          send({
            type: 'workflow.result.result', correlationId: request.correlationId,
            batchId: request.batchId, attemptId: request.attemptId, output
          });
        } else if (request.type === 'runtime.conversation') {
          const generations = await sessionBindings.resolveConversationSessions(
            request.rootPath,
            request.projectId,
            request.targetAgentId
          );
          const page = await runtime.listLogicalConversation({ ...request, generations });
          send({ type: 'runtime.conversation.result', correlationId: request.correlationId, page });
        } else {
          const info = await runtime.getRuntimeInfo({ probe: request.probe });
          send({ type: 'runtime.info.result', correlationId: request.correlationId, info });
        }
      };
        if (request.type === 'repository.select'
          || request.type === 'project.bootstrap'
          || request.type === 'runtime.info') {
          await execute();
        } else if (request.type === 'repository.get-snapshot') {
          await execute();
        } else {
          if ('rootPath' in request && 'projectId' in request
            && typeof request.rootPath === 'string' && typeof request.projectId === 'string') {
            await writerLeases.run(request.rootPath, request.projectId, async (canonicalRoot) => {
              request = { ...request, rootPath: canonicalRoot } as CoreDispatchRequest;
              await execute();
            });
          } else {
            await writerLeases.runSelected(async ({ rootPath }) => {
              if ('rootPath' in request) request = { ...request, rootPath } as CoreDispatchRequest;
              await execute();
            });
          }
        }
      } catch (error) {
        const structuredError = error && typeof error === 'object'
          ? error as { code?: unknown; details?: unknown }
          : null;
        const boundedErrorCode = typeof structuredError?.code === 'string'
          && /^[A-Z][A-Z0-9_]{1,127}$/u.test(structuredError.code)
          ? structuredError.code
          : null;
        const structuredDetails = structuredError?.details
          && typeof structuredError.details === 'object'
          && !Array.isArray(structuredError.details)
          ? structuredError.details as Record<string, unknown>
          : null;
        const terminalDetails = error instanceof DispatchTerminalError
          ? error.details
          : error instanceof CoreDispatchFailure && request.type === 'runtime.send'
            && request.messageId && request.actionFingerprint
            ? {
                terminalOutcome: 'failed' as const,
                messageId: request.messageId,
                actionFingerprint: request.actionFingerprint
              }
            : structuredDetails;
        send({
          type: 'runtime.request.failed',
          correlationId: request.correlationId,
          reason: error instanceof Error ? error.message.slice(0, 4_096) : String(error).slice(0, 4_096),
          retryable: error instanceof CoreDispatchFailure ? error.retryable : false,
          errorCode: error instanceof AttachmentPreDispatchError
            ? error.code
            : error instanceof DispatchTerminalError
            || error instanceof DispatchOutcomeUnknownError
            || error instanceof ApprovalOutcomeUnknownError
            ? error.code
            : boundedErrorCode,
          outcomeUnknown: error instanceof DispatchOutcomeUnknownError
            || error instanceof ApprovalOutcomeUnknownError,
          details: terminalDetails
        });
      }
    })();
  };

  coreTransport.onMessage((message) => {
    handleCoreRequest(message, { send, stop, dispatch });
  });

  send({ type: 'core.ready', version: 1 });
}
