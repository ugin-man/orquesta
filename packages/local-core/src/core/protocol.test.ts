import { describe, expect, test } from 'vitest';
import { isCoreEvent, isCoreRequest } from './protocol';

describe('Core protocol validation', () => {
  test('connection observations are bounded metadata, not fabricated thread notifications', () => {
    const notification = { kind: 'provider_connection', providerConnectionId: 'provider-a', state: 'connected' };
    expect(isCoreEvent({ type: 'runtime.notification', notification })).toBe(true);
    expect(isCoreEvent({ type: 'runtime.notification', notification: { ...notification, state: 'disconnected' } })).toBe(true);
    for (const invalid of [
      { ...notification, providerConnectionId: '' },
      { ...notification, providerConnectionId: 'a'.repeat(129) },
      { ...notification, state: 'unknown' },
      { ...notification, threadId: 'fake-thread' },
    ]) expect(isCoreEvent({ type: 'runtime.notification', notification: invalid })).toBe(false);
  });
  test('accepts ready and rejects a malformed ready event', () => {
    expect(isCoreEvent({ type: 'core.ready', version: 1 })).toBe(true);
    expect(isCoreEvent({ type: 'core.ready', version: '1' })).toBe(false);
  });

  test('accepts only bounded requests', () => {
    expect(isCoreRequest({ type: 'core.shutdown' })).toBe(true);
    expect(isCoreRequest({ type: 'core.execute', command: 'whoami' })).toBe(false);
  });

  test('accepts only typed runtime information requests and results', () => {
    expect(isCoreRequest({ type: 'runtime.info', correlationId: 'info-1', probe: false })).toBe(true);
    expect(isCoreRequest({ type: 'runtime.info', correlationId: 'info-1', probe: 'yes' })).toBe(false);
    expect(isCoreEvent({
      type: 'runtime.info.result',
      correlationId: 'info-1',
      info: {
        status: 'not_started', adapter: 'app_server', sdkVersion: '0.144.5', codexVersion: '0.144.5',
        runtimeVersion: '0.144.5-win32-x64', targetTriple: 'x86_64-pc-windows-msvc',
        platformFamily: null, platformOs: null, userAgent: null, providerConnectionId: null, integrity: 'verified',
        models: []
      }
    })).toBe(true);
  });

  test('accepts rootless project bootstrap requests', () => {
    expect(isCoreRequest({ type: 'project.bootstrap', correlationId: 'bootstrap-1' })).toBe(true);
    expect(isCoreRequest({ type: 'project.bootstrap', correlationId: '' })).toBe(false);
    expect(isCoreRequest({ type: 'project.bootstrap', correlationId: 'bootstrap-1', rootPath: 'C:\\injected' })).toBe(false);
  });

  test('accepts only exact bounded Steer requests and acknowledgements', () => {
    const request = {
      type: 'runtime.turn.steer', correlationId: 'steer-correlation', steerId: 'steer-1',
      projectId: 'repo-1', rootPath: 'C:\\repo', targetAgentId: 'orchestrator',
      threadId: 'thread-1', turnId: 'turn-1', text: 'Check the root cause.'
    };
    expect(isCoreRequest(request)).toBe(true);
    expect(isCoreRequest({ ...request, text: '' })).toBe(false);
    expect(isCoreRequest({ ...request, text: 'x'.repeat(65_537) })).toBe(false);
    expect(isCoreRequest({ ...request, steerId: '../bad' })).toBe(false);
    expect(isCoreEvent({
      type: 'runtime.turn.steer.accepted', correlationId: 'steer-correlation', steerId: 'steer-1',
      targetAgentId: 'orchestrator', threadId: 'thread-1', turnId: 'turn-1'
    })).toBe(true);
    expect(isCoreEvent({
      type: 'runtime.turn.steer.accepted', correlationId: 'steer-correlation', steerId: 'steer-1',
      targetAgentId: 'orchestrator', threadId: 'thread-2', turnId: ''
    })).toBe(false);
  });

  test('classifies interrupt as a request and never as an event', () => {
    const request = {
      type: 'runtime.turn.interrupt', correlationId: 'interrupt-correlation', projectId: 'repo-1',
      rootPath: 'C:\\repo', targetAgentId: 'orchestrator', threadId: 'thread-1', turnId: 'turn-1'
    };
    expect(isCoreRequest(request)).toBe(true);
    expect(isCoreEvent(request)).toBe(false);
  });

  test('accepts typed bootstrap results', () => {
    expect(isCoreEvent({
      type: 'project.bootstrap.result', correlationId: 'bootstrap-1',
      result: { status: 'ready', no_write: false, reason: null, classification: 'ready' }
    })).toBe(true);
    expect(isCoreEvent({
      type: 'project.bootstrap.result', correlationId: 'bootstrap-1',
      result: { status: 'partial', no_write: true, reason: 'mixed' }
    })).toBe(false);
  });

  test('accepts opaque bounded App Server conversation cursors without guessing their format', () => {
    const valid = {
      type: 'runtime.conversation', correlationId: 'history-1', projectId: 'repo-1', rootPath: 'C:\\repo',
      targetAgentId: 'orchestrator', cursor: 'opaque/server+cursor==', limit: 50
    };
    expect(isCoreRequest(valid)).toBe(true);
    expect(isCoreRequest({ ...valid, cursor: 'bad\ncursor' })).toBe(false);
    expect(isCoreRequest({ ...valid, cursor: 'x'.repeat(4_097) })).toBe(false);
  });

  test('rejects empty, 256-scalar, and control-character attachment display names', () => {
    const attachment = {
      attachmentStoreHandle: '7f36fdc4-52ad-4b21-8a85-acde995ff005',
      kind: 'text',
      displayName: `${'😀'.repeat(251)}.txt`,
      mediaType: 'text/plain',
      sealedAbsolutePath: 'C:\\sealed\\7f36fdc4-52ad-4b21-8a85-acde995ff005',
      sizeBytes: 1,
      sha256: 'a'.repeat(64),
      encoding: 'utf-8'
    };
    const request = {
      type: 'runtime.send', correlationId: 'send-attachment-name', projectId: 'repo-1', rootPath: 'C:\\repo',
      threadId: null, targetAgentId: 'orchestrator', text: 'Read it.', attachments: [attachment]
    };
    expect(isCoreRequest(request)).toBe(true);
    expect(isCoreRequest({ ...request, text: 'あ'.repeat(21_846) })).toBe(false);
    expect(isCoreRequest({
      ...request,
      attachments: [{ ...attachment, mediaType: 'application/json' }],
    })).toBe(false);
    expect(isCoreRequest({ ...request, attachments: [{ ...attachment, displayName: '' }] })).toBe(false);
    expect(isCoreRequest({
      ...request, attachments: [{ ...attachment, displayName: `${'a'.repeat(252)}.txt` }]
    })).toBe(false);
    expect(isCoreRequest({ ...request, attachments: [{ ...attachment, displayName: 'unsafe\nname.txt' }] })).toBe(false);
  });

  test('accepts only bounded typed structured conversation history results', () => {
    const activity = {
      eventType: 'plan.updated', threadId: 'thread-1', turnId: 'turn-1', itemId: 'plan-1',
      targetAgentId: 'orchestrator', occurredAt: '2026-08-17T00:00:00.000Z',
      payload: { visibility: 'public', activity_kind: 'plan', content_omitted: true }
    };
    const valid = {
      type: 'runtime.conversation.result', correlationId: 'history-1',
      page: { items: [], nextCursor: null, activities: [activity], structuredActivitiesComplete: true }
    };
    expect(isCoreEvent(valid)).toBe(true);
    expect(isCoreEvent({ ...valid, page: { ...valid.page, activities: [{ ...activity, eventType: 'reasoning' }] } })).toBe(false);
    expect(isCoreEvent({ ...valid, page: { ...valid.page, activities: Array.from({ length: 1_001 }, () => activity) } })).toBe(false);
    expect(isCoreEvent({ ...valid, page: { ...valid.page, structuredActivitiesComplete: 'yes' } })).toBe(false);
  });

  test('rejects provider activity events with untyped or secret payload fields', () => {
    const event = {
      type: 'runtime.notification',
      notification: {
        kind: 'provider_event', correlationId: null, threadId: 'thread-a', turnId: 'turn-a',
        text: null, targetAgentId: 'orchestrator', itemId: 'command-a', occurredAt: '2026-08-17T00:00:00.000Z',
        modelEvidence: {
          recommendedModel: null, requestedModel: null, appliedModel: null, actualModel: null,
          actualModelEvidence: 'unknown'
        },
        providerEvent: {
          provider_stream_id: 'provider-a', provider_sequence: 1, event_type: 'command.started',
          scope: { thread_id: 'thread-a', turn_id: 'turn-a', item_id: 'command-a' },
          payload: {
            activity_kind: 'command', activity_state: 'running', title: 'Run powershell.exe',
            command_name: 'powershell.exe', action_types: [], action_types_truncated: false,
            exit_code: null, duration_ms: null, output_present: false, output_bytes: 0,
            output_text: null, output_truncated: false, output_redacted: false,
            cwd_omitted: true, command_arguments_omitted: true, content_omitted: true
          }
        }
      }
    };
    expect(isCoreEvent(event)).toBe(true);
    expect(isCoreEvent({
      ...event,
      notification: {
        ...event.notification,
        providerEvent: {
          ...event.notification.providerEvent,
          payload: { ...event.notification.providerEvent.payload, raw: 'secret' }
        }
      }
    })).toBe(false);
    expect(isCoreEvent({
      ...event,
      notification: {
        ...event.notification,
        providerEvent: {
          ...event.notification.providerEvent,
          payload: { ...event.notification.providerEvent.payload, command_name: 'x'.repeat(257) }
        }
      }
    })).toBe(false);
  });

  test('requires separated model evidence on dispatch and runtime notifications', () => {
    const modelEvidence = {
      recommendedModel: null, requestedModel: 'requested', appliedModel: 'requested', actualModel: null,
      actualModelEvidence: 'unknown'
    };
    expect(isCoreEvent({
      type: 'runtime.dispatch.accepted', correlationId: 'send-1', threadId: 'thread-1', turnId: 'turn-1', modelEvidence
    })).toBe(true);
    expect(isCoreEvent({
      type: 'runtime.notification',
      notification: { kind: 'turn_started', correlationId: 'send-1', threadId: 'thread-1', turnId: 'turn-1', text: null, targetAgentId: null, modelEvidence }
    })).toBe(true);
    expect(isCoreEvent({
      type: 'runtime.dispatch.accepted', correlationId: 'send-1', threadId: 'thread-1', turnId: 'turn-1', actualModel: 'inferred'
    })).toBe(false);
  });

  test('accepts only bounded repository selection and lifecycle requests', () => {
    expect(isCoreRequest({ type: 'repository.select', correlationId: 'select-1', projectId: 'repo-1', rootPath: 'C:\\repo', attachmentSealedRoot: 'C:\\sealed' })).toBe(true);
    expect(isCoreRequest({
      type: 'repository.select', correlationId: 'select-hosted', projectId: 'repo-1', rootPath: 'C:\\repo',
      attachmentSealedRoot: 'C:\\sealed', launchContext: { source: 'argv', callingThreadId: 'thread-calling-chat' }
    })).toBe(true);
    expect(isCoreRequest({
      type: 'repository.select', correlationId: 'select-hosted', projectId: 'repo-1', rootPath: 'C:\\repo',
      attachmentSealedRoot: 'C:\\sealed', launchContext: { source: 'argv', callingThreadId: '../escape' }
    })).toBe(false);
    expect(isCoreRequest({
      type: 'repository.select', correlationId: 'select-hosted', projectId: 'repo-1', rootPath: 'C:\\repo',
      attachmentSealedRoot: 'C:\\sealed', launchContext: { source: 'argv', callingThreadId: 'thread-calling-chat', legacyMigration: true }
    })).toBe(false);
    expect(isCoreRequest({ type: 'repository.get-snapshot', correlationId: 'snapshot-1' })).toBe(true);
    expect(isCoreRequest({ type: 'repository.select', correlationId: 'select-1', projectId: '../escape', rootPath: 'C:\\repo', attachmentSealedRoot: 'C:\\sealed' })).toBe(false);
    expect(isCoreRequest({ type: 'repository.select', correlationId: 'select-1', projectId: 'repo-1', rootPath: 'x'.repeat(32_769), attachmentSealedRoot: 'C:\\sealed' })).toBe(false);
    expect(isCoreRequest({ type: 'repository.select', correlationId: 'select-1', projectId: 'repo-1', rootPath: 'C:\\repo' })).toBe(false);
  });

  test('rejects retired Setup and legacy organization migration messages', () => {
    expect(isCoreRequest({ type: 'setup.start', correlationId: 'setup-1' })).toBe(false);
    expect(isCoreRequest({ type: 'setup.cancel', correlationId: 'setup-1' })).toBe(false);
    expect(isCoreRequest({
      type: 'organization.migration.read', correlationId: 'migration-1', projectId: 'repo-1', rootPath: 'C:\\repo'
    })).toBe(false);
    expect(isCoreEvent({ type: 'setup.progress', progress: {} })).toBe(false);
    expect(isCoreEvent({ type: 'organization.migration.result', correlationId: 'migration-1', result: {} })).toBe(false);
  });

  test('accepts repository snapshot result and changed events only with a projected snapshot', () => {
    const attention = {
      id: 'question:Q1', sourceKind: 'user_question', type: 'question', actionKind: 'answer', priority: 'high',
      title: 'Choose a direction', summary: 'A curated question is waiting.', sourceAgentId: 'user-support', taskId: null,
      blocking: false, createdAt: '2026-08-28T00:00:00.000Z', resolvedAt: null, resolutionDecision: null
    };
    const snapshot = {
      project: { id: 'repo-1', title: 'repo', rootPathLabel: 'C:\\repo', status: 'ready' },
      agents: [], tasks: [], attention: [attention], phases: [], recentEvents: [],
      inspectionTemplates: [], inspectionRuns: []
    };
    expect(isCoreEvent({ type: 'repository.snapshot.result', correlationId: 'snapshot-1', snapshot })).toBe(true);
    expect(isCoreEvent({ type: 'repository.snapshot.changed', snapshot })).toBe(true);
    expect(isCoreEvent({ type: 'repository.snapshot.result', correlationId: '', snapshot })).toBe(false);
    expect(isCoreEvent({ type: 'repository.snapshot.changed', snapshot: { ...snapshot, inspectionRuns: undefined } })).toBe(false);
    expect(isCoreEvent({ type: 'repository.snapshot.changed', snapshot: { project: { id: '../escape' } } })).toBe(false);
    expect(isCoreEvent({
      type: 'repository.snapshot.changed',
      snapshot: { ...snapshot, attention: [{ ...attention, sourceKind: 'raw_incident' }] }
    })).toBe(false);
  });

  test('accepts bounded inspection requests and rejects escaped or oversized targets', () => {
    const valid = {
      type: 'inspection.start', correlationId: 'inspect-1', projectId: 'repo-1', rootPath: 'C:\\repo',
      kind: 'adversarial_audit', target: { kind: 'agents', ids: ['coder-1', 'coder-2'] }, focus: null
    };
    expect(isCoreRequest(valid)).toBe(true);
    expect(isCoreRequest({ ...valid, target: { kind: 'agents', ids: ['../bad'] } })).toBe(false);
    expect(isCoreRequest({ ...valid, target: { kind: 'agents', ids: Array.from({ length: 33 }, (_, index) => `agent-${index}`) } })).toBe(false);
    expect(isCoreRequest({ ...valid, focus: 'x'.repeat(4_097) })).toBe(false);
    expect(isCoreRequest({
      type: 'inspection.cancel', correlationId: 'cancel-1', projectId: 'repo-1', rootPath: 'C:\\repo', runId: 'AUDIT-001'
    })).toBe(true);
    expect(isCoreEvent({ type: 'inspection.action.accepted', correlationId: 'inspect-1', runId: 'AUDIT-001' })).toBe(true);
  });

  test('accepts the small workflow boundary and rejects unbounded repetitions or prompts', () => {
    const save = {
      type: 'workflow.definition.save', correlationId: 'workflow-save-1', projectId: 'repo-1', rootPath: 'C:\\repo',
      workflowId: null, name: '構造確認', prompt: '現在の構造を確認する',
      checks: [{ kind: 'contains', text: '確認済み', caseSensitive: false }]
    };
    expect(isCoreRequest(save)).toBe(true);
    expect(isCoreRequest({ ...save, prompt: 'x'.repeat(65_537) })).toBe(false);
    expect(isCoreRequest({
      type: 'workflow.batch.start', correlationId: 'workflow-start-1', projectId: 'repo-1', rootPath: 'C:\\repo',
      workflowId: 'workflow-1', repetitions: 3
    })).toBe(true);
    expect(isCoreRequest({
      type: 'workflow.batch.start', correlationId: 'workflow-start-1', projectId: 'repo-1', rootPath: 'C:\\repo',
      workflowId: 'workflow-1', repetitions: 51
    })).toBe(false);
    expect(isCoreEvent({
      type: 'workflow.catalog.changed', catalog: { version: 1, definitions: [], batches: [], limits: { maxAttemptsPerBatch: 50 } }
    })).toBe(true);
  });

  test('accepts only exact bounded runtime approval messages', () => {
    expect(isCoreRequest({
      type: 'runtime.approval.respond', correlationId: 'respond-1', attentionId: 'runtime-approval-1',
      requestId: 'provider-request-1', decision: 'acceptForSession', providerConnectionId: 'provider-test'
    })).toBe(true);
    expect(isCoreRequest({
      type: 'runtime.approval.respond', correlationId: 'respond-1', attentionId: 'runtime-approval-1',
      requestId: 'provider-request-1', decision: '', providerConnectionId: 'provider-test'
    })).toBe(false);
    expect(isCoreEvent({
      type: 'runtime.approval.accepted', correlationId: 'respond-1', attentionId: 'runtime-approval-1',
      requestId: 'provider-request-1', providerConnectionId: 'provider-test', decision: 'decline'
    })).toBe(true);
  });

  test('accepts bounded Business Work Order reads without a caller root path', () => {
    const valid = {
      type: 'business.work-orders.read',
      correlationId: 'business-read-1',
      projectId: 'repo-1',
      consumer: {
        name: 'orquesta.business-work-orders.read',
        major: 1,
        minMinor: 0,
        requiredFeatures: ['journal-prefix-continuity.v1', 'work-order-index.v1']
      },
      afterCursor: null,
      query: { kind: 'index', limit: 25, afterKey: null }
    };
    expect(isCoreRequest(valid)).toBe(true);
    expect(isCoreRequest({ ...valid, rootPath: 'C:\\caller-controlled' })).toBe(false);
    expect(isCoreRequest({ ...valid, query: { kind: 'toString' } })).toBe(false);
    expect(isCoreEvent({
      type: 'business.work-orders.result',
      correlationId: 'business-read-1',
      result: { schemaVersion: 1 }
    })).toBe(true);
  });
});
