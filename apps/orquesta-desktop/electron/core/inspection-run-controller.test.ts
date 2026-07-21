import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import type { RuntimeApprovalRequest, RuntimeNotification } from './protocol';
import { InspectionRunController, type InspectionRuntime } from './inspection-run-controller';
import { readInspectionState } from './inspection-run-store';

const roots: string[] = [];

async function projectRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'orquesta-inspection-controller-'));
  roots.push(root);
  await mkdir(path.join(root, '.orquesta', 'state'), { recursive: true });
  await writeFile(path.join(root, '.orquesta', 'state', 'agents.json'), '{"agents":[]}\n', 'utf8');
  await writeFile(path.join(root, '.orquesta', 'state', 'tasks.json'), '{"tasks":[]}\n', 'utf8');
  return root;
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function runtimeDouble() {
  const runtime: InspectionRuntime = {
    startInspection: vi.fn(async (input) => ({
      threadId: `thread-${input.kind}`,
      turnId: `turn-${input.kind}`,
      runtimeBoundary: {
        sandbox: 'read-only' as const,
        approvalPolicy: 'never' as const,
        webSearchMode: input.kind === 'external_benchmark' ? 'live' as const : 'disabled' as const
      }
    })),
    interruptInspection: vi.fn(async () => undefined),
    readInspectionThread: vi.fn(async () => ({ finalResponse: null, completed: false })),
    respondToApproval: vi.fn(async ({ requestId, decision }) => ({ requestId, decision }))
  };
  return runtime;
}

function externalEnvelope(markdown = [
  '## Project evidence',
  '- `.orquesta/state/tasks.json`',
  '## Compared products',
  '- [Competitor A](https://example.test/a) — accessed 2026-07-21 — selected for the same workflow.',
  '- [Competitor B](https://example.test/b) — accessed 2026-07-21 — selected for the same audience.',
  '## Comparison axes',
  '- orchestration cost',
  '## Strengths',
  '- Clear state.',
  '## Gaps',
  '- Limited discovery.',
  '## Differentiation',
  '- Human review gates.',
  '## Reusable assets',
  '- Existing UI patterns.',
  '## Unknowns',
  '- None.'
].join('\n')): string {
  return JSON.stringify({ outcome: 'report_ready', sourceCount: 2, markdown });
}

function notification(kind: RuntimeNotification['kind'], threadId: string, text: string | null = null): RuntimeNotification {
  return {
    kind, threadId, turnId: 'turn-external_benchmark', text, targetAgentId: null,
    modelEvidence: {
      recommendedModel: null, requestedModel: null, appliedModel: null,
      actualModel: null, actualModelEvidence: 'unknown'
    }
  };
}

describe('InspectionRunController', () => {
  test('persists only inspection state and saves a validated external report', async () => {
    const rootPath = await projectRoot();
    const beforeAgents = await readFile(path.join(rootPath, '.orquesta', 'state', 'agents.json'), 'utf8');
    const beforeTasks = await readFile(path.join(rootPath, '.orquesta', 'state', 'tasks.json'), 'utf8');
    const runtime = runtimeDouble();
    const controller = new InspectionRunController({
      runtime, now: () => new Date('2026-07-21T05:00:00.000Z'), createId: () => 'BENCH-001'
    });

    const started = await controller.start({
      projectId: 'repo-1', rootPath, kind: 'external_benchmark',
      target: { kind: 'project', ids: [] }, focus: 'orchestration cost'
    });
    await controller.handleRuntimeNotification(notification('agent_message', started.threadId, externalEnvelope()));
    await controller.handleRuntimeNotification(notification('turn_completed', started.threadId));

    const run = (await readInspectionState(rootPath)).runs[0];
    expect(run).toMatchObject({
      runId: 'BENCH-001', status: 'report_ready', sourceCount: 2,
      reportPath: expect.stringMatching(/reports[\\/]inspections[\\/]BENCH-001\.md$/u),
      runtimeBoundary: { sandbox: 'read-only', approvalPolicy: 'never', webSearchMode: 'live' }
    });
    expect(await readFile(run.reportPath!, 'utf8')).toContain('https://example.test/a');
    expect(await readFile(path.join(rootPath, '.orquesta', 'state', 'agents.json'), 'utf8')).toBe(beforeAgents);
    expect(await readFile(path.join(rootPath, '.orquesta', 'state', 'tasks.json'), 'utf8')).toBe(beforeTasks);
  });

  test('fails external comparison rather than inventing a report without sources', async () => {
    const rootPath = await projectRoot();
    const runtime = runtimeDouble();
    const controller = new InspectionRunController({ runtime, createId: () => 'BENCH-002' });
    const started = await controller.start({
      projectId: 'repo-1', rootPath, kind: 'external_benchmark',
      target: { kind: 'project', ids: [] }, focus: null
    });
    await controller.handleRuntimeNotification(notification(
      'agent_message', started.threadId,
      JSON.stringify({ outcome: 'report_ready', sourceCount: 1, markdown: '## Comparison axes\n- cost\nNo external URL.' })
    ));
    await controller.handleRuntimeNotification(notification('turn_completed', started.threadId));

    expect((await readInspectionState(rootPath)).runs[0]).toMatchObject({
      status: 'failed', errorCode: 'source_unavailable', reportPath: null
    });
  });

  test('blocks a duplicate kind while allowing the other kind with Web disabled', async () => {
    const rootPath = await projectRoot();
    const runtime = runtimeDouble();
    const controller = new InspectionRunController({ runtime, createId: (() => {
      let value = 0;
      return () => `RUN-${++value}`;
    })() });
    const input = {
      projectId: 'repo-1', rootPath, kind: 'external_benchmark' as const,
      target: { kind: 'project' as const, ids: [] }, focus: null
    };
    await controller.start(input);
    await expect(controller.start(input)).rejects.toThrow('already active');
    await controller.start({ ...input, kind: 'adversarial_audit' });
    expect(runtime.startInspection).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'adversarial_audit'
    }));
    expect((await readInspectionState(rootPath)).runs.at(-1)?.runtimeBoundary?.webSearchMode).toBe('disabled');
  });

  test('cancels by exact runtime ids and leaves a non-active history record', async () => {
    const rootPath = await projectRoot();
    const runtime = runtimeDouble();
    const controller = new InspectionRunController({ runtime, createId: () => 'AUDIT-001' });
    await controller.start({
      projectId: 'repo-1', rootPath, kind: 'adversarial_audit',
      target: { kind: 'agents', ids: ['implementation-001', 'implementation-002'] }, focus: null
    });

    await controller.cancel({ projectId: 'repo-1', rootPath, runId: 'AUDIT-001' });

    expect(runtime.interruptInspection).toHaveBeenCalledWith({
      correlationId: 'inspection:AUDIT-001:cancel',
      threadId: 'thread-adversarial_audit', turnId: 'turn-adversarial_audit'
    });
    expect((await readInspectionState(rootPath)).runs[0]).toMatchObject({ status: 'cancelled' });
  });

  test('declines an unexpected approval, interrupts the run and records a boundary violation', async () => {
    const rootPath = await projectRoot();
    const runtime = runtimeDouble();
    const controller = new InspectionRunController({ runtime, createId: () => 'AUDIT-002' });
    await controller.start({
      projectId: 'repo-1', rootPath, kind: 'adversarial_audit',
      target: { kind: 'project', ids: [] }, focus: null
    });
    const approval: RuntimeApprovalRequest = {
      projectId: 'repo-1', correlationId: 'runtime-approval', requestId: 'approval-1',
      method: 'item/fileChange/requestApproval', threadId: 'thread-adversarial_audit',
      turnId: 'turn-adversarial_audit', reason: 'write requested', responseOptions: ['accept', 'decline', 'cancel']
    };

    await expect(controller.handleRuntimeApproval(approval)).resolves.toBe(true);

    expect(runtime.respondToApproval).toHaveBeenCalledWith({
      correlationId: 'runtime-approval', requestId: 'approval-1', decision: 'decline'
    });
    expect(runtime.interruptInspection).toHaveBeenCalled();
    expect((await readInspectionState(rootPath)).runs[0]).toMatchObject({
      status: 'failed', errorCode: 'read_only_boundary_violation'
    });
  });

  test('reconciles a completed persisted thread through its final response', async () => {
    const rootPath = await projectRoot();
    const runtime = runtimeDouble();
    const controller = new InspectionRunController({ runtime, createId: () => 'BENCH-003' });
    await controller.start({
      projectId: 'repo-1', rootPath, kind: 'external_benchmark',
      target: { kind: 'project', ids: [] }, focus: null
    });
    runtime.readInspectionThread = vi.fn(async () => ({ finalResponse: externalEnvelope(), completed: true }));

    await controller.reconcileProject('repo-1', rootPath);

    expect((await readInspectionState(rootPath)).runs[0]).toMatchObject({
      status: 'report_ready', reportPath: expect.any(String)
    });
  });
});
