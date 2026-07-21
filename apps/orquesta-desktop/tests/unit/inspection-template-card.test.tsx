import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import { fixtureInspectionTemplates } from '../../src/fixtures/helpers';
import { I18nProvider } from '../../src/renderer/features/i18n/I18nProvider';
import { TeamManagement } from '../../src/renderer/features/team/TeamManagement';

describe('inspection launch cards', () => {
  test('keeps both temporary inspection templates separate from role proposals', async () => {
    const onStartInspection = vi.fn(async () => ({ status: 'accepted' as const, correlationId: 'inspect-1' }));
    render(
      <I18nProvider initialLocale="ja">
        <TeamManagement
          agents={[]}
          proposals={[]}
          inspectionTemplates={structuredClone(fixtureInspectionTemplates)}
          inspectionRuns={[]}
          onApprove={vi.fn()}
          onStartInspection={onStartInspection}
          onCancelInspection={vi.fn()}
          onOpenInspectionReport={vi.fn()}
          onClose={vi.fn()}
        />
      </I18nProvider>
    );

    expect(screen.getByRole('heading', { name: '外部比較' })).toBeVisible();
    expect(screen.getByRole('heading', { name: '敵対監査' })).toBeVisible();
    const inspectionSection = screen.getByRole('region', { name: '一時検査エージェント' });
    expect(within(inspectionSection).getAllByText('読み取り専用')).toHaveLength(2);
    await userEvent.click(screen.getByRole('button', { name: '外部比較を起動' }));
    expect(onStartInspection).toHaveBeenCalledWith({
      kind: 'external_benchmark', target: { kind: 'project', ids: [] }, focus: null
    });
  });

  test('shows cancel for an active run and the last report for a completed run', async () => {
    const onCancelInspection = vi.fn(async () => ({ status: 'accepted' as const, correlationId: 'cancel-1' }));
    const onOpenInspectionReport = vi.fn();
    const templates = structuredClone(fixtureInspectionTemplates);
    templates[0].activeRunId = 'BENCH-RUNNING';
    templates[1].lastReportRunId = 'AUDIT-DONE';
    render(
      <I18nProvider initialLocale="ja">
        <TeamManagement
          agents={[]}
          proposals={[]}
          inspectionTemplates={templates}
          inspectionRuns={[
            {
              runId: 'BENCH-RUNNING', kind: 'external_benchmark', displayName: 'External benchmark', status: 'running',
              target: { kind: 'project', ids: [], label: 'Project' }, focus: null, threadId: null, turnId: null,
              reportPath: null, sourceCount: 0, errorCode: null, errorMessage: null,
              createdAt: '2026-07-21T00:00:00.000Z', completedAt: null
            },
            {
              runId: 'AUDIT-DONE', kind: 'adversarial_audit', displayName: 'Adversarial audit', status: 'report_ready',
              target: { kind: 'project', ids: [], label: 'Project' }, focus: null, threadId: null, turnId: null,
              reportPath: '.orquesta/reports/inspections/AUDIT-DONE.md', sourceCount: 0, errorCode: null, errorMessage: null,
              createdAt: '2026-07-21T00:00:00.000Z', completedAt: '2026-07-21T00:01:00.000Z'
            }
          ]}
          onApprove={vi.fn()}
          onStartInspection={vi.fn()}
          onCancelInspection={onCancelInspection}
          onOpenInspectionReport={onOpenInspectionReport}
          onClose={vi.fn()}
        />
      </I18nProvider>
    );

    await userEvent.click(screen.getByRole('button', { name: '外部比較を中止' }));
    expect(onCancelInspection).toHaveBeenCalledWith('BENCH-RUNNING');
    await userEvent.click(screen.getByRole('button', { name: '敵対監査の直近レポート' }));
    expect(onOpenInspectionReport).toHaveBeenCalledWith('AUDIT-DONE');
  });
});
