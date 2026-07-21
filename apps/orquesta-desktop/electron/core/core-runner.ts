import type { DesktopCodexService } from './desktop-codex-service';
import { handleCoreRequest } from './handler';
import type { CoreDispatchRequest, CoreEvent } from './protocol';
import { InspectionRunController } from './inspection-run-controller';
import { RepositoryRuntime } from './repository-runtime';
import { provisionSpecialists } from './specialist-provisioner';
import { createDesktopSetupController } from './setup-engine-adapter';
import { createSpecialistProvisioningCoordinator } from './specialist-provisioning-coordinator';

export function runDesktopCore(runtime: DesktopCodexService): void {
  const parentPort = process.parentPort;
  if (!parentPort) throw new Error('Orquesta Core must run as an Electron utility process');

  const coordinatedProvisioning = createSpecialistProvisioningCoordinator(({ projectId, rootPath, batch }) => (
    provisionSpecialists({ root: rootPath, projectId, batch, runtime })
  ));
  const repository = new RepositoryRuntime({
    provisionSetupSpecialists: async (input) => { await coordinatedProvisioning(input); }
  });
  const inspections = new InspectionRunController({ runtime });
  const send = (event: CoreEvent) => parentPort.postMessage(event);
  const setup = createDesktopSetupController({
    provisionSpecialists: coordinatedProvisioning,
    onProgress: (progress) => send({ type: 'setup.progress', progress }),
    onBackgroundError: (error) => {
      console.error('Initial setup runner failed outside a phase boundary', error);
    }
  });
  runtime.subscribe((notification) => {
    send({ type: 'runtime.notification', notification });
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
        if (request.type === 'repository.select') {
          await repository.select(request);
          await inspections.reconcileProject(request.projectId, request.rootPath);
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
          const result = await runtime.sendMessage({
            ...request,
            recommendedModel: request.recommendedModel ?? null,
            requestedModel: request.requestedModel ?? null
          });
          send({ type: 'runtime.dispatch.accepted', correlationId: request.correlationId, ...result });
        } else if (request.type === 'runtime.luca.send') {
          const result = await runtime.sendLucaQuestion(request);
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
          const page = await runtime.listConversation(request);
          send({ type: 'runtime.conversation.result', correlationId: request.correlationId, page });
        } else if (request.type === 'setup.account.read') {
          const account = await runtime.readAccount();
          send({ type: 'setup.account.result', correlationId: request.correlationId, account });
        } else if (request.type === 'setup.account.login.start') {
          const login = await runtime.startChatGptLogin();
          send({ type: 'setup.account.login.started', correlationId: request.correlationId, login });
        } else if (request.type === 'setup.start') {
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
