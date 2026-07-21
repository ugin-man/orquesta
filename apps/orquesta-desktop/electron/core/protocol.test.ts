import { describe, expect, test } from 'vitest';
import { emptyV4OperationsSnapshot } from '../../src/contracts/orquesta-ui';
import { isCoreEvent, isCoreRequest } from './protocol';

describe('Core protocol validation', () => {
  test('accepts ready and rejects a malformed ready event', () => {
    expect(isCoreEvent({ type: 'core.ready', version: 1 })).toBe(true);
    expect(isCoreEvent({ type: 'core.ready', version: '1' })).toBe(false);
  });

  test('accepts pong only with a non-empty correlation id', () => {
    expect(isCoreEvent({ type: 'core.pong', correlationId: 'ping-1' })).toBe(true);
    expect(isCoreEvent({ type: 'core.pong', correlationId: '' })).toBe(false);
  });

  test('accepts only bounded requests', () => {
    expect(isCoreRequest({ type: 'core.shutdown' })).toBe(true);
    expect(isCoreRequest({ type: 'core.ping', correlationId: 'ping-1' })).toBe(true);
    expect(isCoreRequest({ type: 'core.ping', correlationId: '' })).toBe(false);
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
        platformFamily: null, platformOs: null, userAgent: null, integrity: 'verified'
      }
    })).toBe(true);
  });

  test('accepts only bounded Luca runtime requests', () => {
    const valid = {
      type: 'runtime.luca.send', correlationId: 'corr-luca', projectId: 'repo-1', rootPath: 'C:\\repo',
      threadId: null, prompt: '{"protocol":"orquesta.luca.ask.v1"}'
    };
    expect(isCoreRequest(valid)).toBe(true);
    expect(isCoreRequest({ ...valid, projectId: '../bad' })).toBe(false);
    expect(isCoreRequest({ ...valid, prompt: '' })).toBe(false);
    expect(isCoreRequest({ ...valid, prompt: 'x'.repeat(65_537) })).toBe(false);
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
      notification: { kind: 'turn_started', threadId: 'thread-1', turnId: 'turn-1', text: null, targetAgentId: null, modelEvidence }
    })).toBe(true);
    expect(isCoreEvent({
      type: 'runtime.dispatch.accepted', correlationId: 'send-1', threadId: 'thread-1', turnId: 'turn-1', actualModel: 'inferred'
    })).toBe(false);
  });

  test('accepts only bounded repository selection and lifecycle requests', () => {
    expect(isCoreRequest({ type: 'repository.select', correlationId: 'select-1', projectId: 'repo-1', rootPath: 'C:\\repo' })).toBe(true);
    expect(isCoreRequest({ type: 'repository.get-snapshot', correlationId: 'snapshot-1' })).toBe(true);
    expect(isCoreRequest({ type: 'repository.close', correlationId: 'close-1' })).toBe(true);
    expect(isCoreRequest({ type: 'repository.select', correlationId: 'select-1', projectId: '../escape', rootPath: 'C:\\repo' })).toBe(false);
    expect(isCoreRequest({ type: 'repository.select', correlationId: 'select-1', projectId: 'repo-1', rootPath: 'x'.repeat(32_769) })).toBe(false);
  });

  test('accepts repository snapshot result and changed events only with a projected snapshot', () => {
    const snapshot = {
      project: { id: 'repo-1', title: 'repo', rootPathLabel: 'C:\\repo', status: 'ready' },
      agents: [], tasks: [], attention: [], phases: [], recentEvents: [], v4Operations: emptyV4OperationsSnapshot(),
      inspectionTemplates: [], inspectionRuns: []
    };
    expect(isCoreEvent({ type: 'repository.snapshot.result', correlationId: 'snapshot-1', snapshot })).toBe(true);
    expect(isCoreEvent({ type: 'repository.snapshot.changed', snapshot })).toBe(true);
    expect(isCoreEvent({ type: 'repository.snapshot.result', correlationId: '', snapshot })).toBe(false);
    expect(isCoreEvent({ type: 'repository.snapshot.changed', snapshot: { ...snapshot, v4Operations: undefined } })).toBe(false);
    expect(isCoreEvent({
      type: 'repository.snapshot.changed', snapshot: { ...snapshot, v4Operations: { ...snapshot.v4Operations, evidenceChains: 'raw' } }
    })).toBe(false);
    expect(isCoreEvent({ type: 'repository.snapshot.changed', snapshot: { project: { id: '../escape' } } })).toBe(false);
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
    expect(isCoreRequest({
      type: 'inspection.read-report', correlationId: 'report-1', projectId: 'repo-1', rootPath: 'C:\\repo', runId: '../bad'
    })).toBe(false);
    expect(isCoreEvent({ type: 'inspection.action.accepted', correlationId: 'inspect-1', runId: 'AUDIT-001' })).toBe(true);
    expect(isCoreEvent({
      type: 'inspection.report.result', correlationId: 'report-1', runId: 'AUDIT-001', markdown: '# Audit'
    })).toBe(true);
  });

  test('accepts only bounded runtime approval and attention history messages', () => {
    expect(isCoreRequest({
      type: 'runtime.approval.respond', correlationId: 'respond-1', attentionId: 'runtime-approval-1', decision: 'acceptForSession'
    })).toBe(true);
    expect(isCoreRequest({
      type: 'runtime.approval.respond', correlationId: 'respond-1', attentionId: 'runtime-approval-1', decision: ''
    })).toBe(false);
    expect(isCoreRequest({ type: 'repository.attention-history', correlationId: 'history-1' })).toBe(true);
    expect(isCoreEvent({
      type: 'runtime.approval.accepted', correlationId: 'respond-1', attentionId: 'runtime-approval-1', decision: 'decline'
    })).toBe(true);
    expect(isCoreEvent({ type: 'repository.attention-history.result', correlationId: 'history-1', items: [] })).toBe(true);
  });
});
