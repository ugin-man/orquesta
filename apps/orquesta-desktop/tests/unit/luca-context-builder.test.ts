import { describe, expect, test, vi } from 'vitest';
import { activeProjectFixture } from '../../src/fixtures/active-project';
import type { OrquestaUiSnapshot } from '../../src/contracts/orquesta-ui';
import { buildLucaContext, LucaContextNotFoundError } from '../../electron/main/luca-context-builder';
import { buildLucaRequestPrompt } from '../../electron/main/luca-prompt';

function snapshot(): OrquestaUiSnapshot {
  return structuredClone(activeProjectFixture.snapshot);
}

describe('buildLucaContext', () => {
  test('includes the selected task and bounded directly related records without all tasks', async () => {
    const context = await buildLucaContext(
      { questionId: 'task.explain', context: { kind: 'task', id: 'T70' }, locale: 'ja' },
      snapshot(),
      { readInspectionReport: vi.fn(), lastHomeSeenAt: null }
    );

    expect(context).toMatchObject({ kind: 'task', subject: { id: 'T70' } });
    expect(context).not.toHaveProperty('allTasks');
    expect(context).toHaveProperty('dependencies.items');
    expect(JSON.stringify(context)).toContain('T66');
  });

  test('caps inspection markdown and records truncation', async () => {
    const source = snapshot();
    source.inspectionRuns = [{
      runId: 'BENCH-1', kind: 'external_benchmark', displayName: 'External benchmark', status: 'report_ready',
      target: { kind: 'project', ids: [], label: source.project.title }, focus: null, threadId: 'thread-bench', turnId: 'turn-bench',
      reportPath: '.orquesta/reports/BENCH-1.md', sourceCount: 4, errorCode: null, errorMessage: null,
      createdAt: '2026-07-18T10:00:00.000Z', completedAt: '2026-07-18T10:10:00.000Z'
    }];
    const context = await buildLucaContext(
      { questionId: 'inspection.explain', context: { kind: 'inspection', id: 'BENCH-1' }, locale: 'ja' },
      source,
      { readInspectionReport: vi.fn(async () => ({ runId: 'BENCH-1', markdown: 'x'.repeat(25_000) })), lastHomeSeenAt: null }
    );

    expect(context).toMatchObject({ kind: 'inspection', subject: { runId: 'BENCH-1' }, truncated: true });
    expect(context.reportMarkdown).toHaveLength(20_000);
  });

  test('keeps a Home question packet specific and exposes a missing comparison baseline', async () => {
    const active = await buildLucaContext(
      { questionId: 'home.active', context: { kind: 'home' }, locale: 'ja' }, snapshot(),
      { readInspectionReport: vi.fn(), lastHomeSeenAt: null }
    );
    const changed = await buildLucaContext(
      { questionId: 'home.changed', context: { kind: 'home' }, locale: 'ja' }, snapshot(),
      { readInspectionReport: vi.fn(), lastHomeSeenAt: null }
    );

    expect(active).toHaveProperty('activeTasks');
    expect(active).not.toHaveProperty('completedTasks');
    expect(changed).toMatchObject({ comparisonBaseline: null });
  });

  test('fails closed when a selected record no longer exists', async () => {
    await expect(buildLucaContext(
      { questionId: 'failure.explain', context: { kind: 'failure', id: 'missing' }, locale: 'ja' }, snapshot(),
      { readInspectionReport: vi.fn(), lastHomeSeenAt: null }
    )).rejects.toBeInstanceOf(LucaContextNotFoundError);
  });
});

describe('buildLucaRequestPrompt', () => {
  test('serializes the fixed question intent and supplied context', () => {
    const prompt = buildLucaRequestPrompt(
      { questionId: 'task.explain', context: { kind: 'task', id: 'T70' }, locale: 'ja' },
      { kind: 'task', subject: { id: 'T70' } }
    );
    expect(JSON.parse(prompt)).toMatchObject({
      protocol: 'orquesta.luca.ask.v1',
      request: { questionId: 'task.explain', displayQuestion: 'このタスクを簡単に説明して' },
      context: { kind: 'task', subject: { id: 'T70' } }
    });
  });

  test('requires bounded custom text only for custom questions', () => {
    expect(() => buildLucaRequestPrompt(
      { questionId: 'task.custom', context: { kind: 'task', id: 'T70' }, locale: 'ja', customText: '  ' },
      { kind: 'task' }
    )).toThrow(/custom question/i);
    expect(() => buildLucaRequestPrompt(
      { questionId: 'task.explain', context: { kind: 'task', id: 'T70' }, locale: 'ja', customText: 'extra' },
      { kind: 'task' }
    )).toThrow(/non-custom/i);
    expect(() => buildLucaRequestPrompt(
      { questionId: 'home.custom', context: { kind: 'home' }, locale: 'ja', customText: 'x'.repeat(2_001) },
      { kind: 'home' }
    )).toThrow(/2,000/);
  });
});
