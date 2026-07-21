import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, test, vi } from 'vitest';
import type { InspectionRunUiModel } from '../../src/contracts/orquesta-ui';
import { I18nProvider } from '../../src/renderer/features/i18n/I18nProvider';
import { InspectionRecordsWorkspace } from '../../src/renderer/features/records/InspectionRecordsWorkspace';

function run(overrides: Partial<InspectionRunUiModel>): InspectionRunUiModel {
  return {
    runId: 'BENCH-001',
    kind: 'external_benchmark',
    displayName: 'External benchmark',
    status: 'report_ready',
    target: { kind: 'project', ids: [], label: 'Project' },
    focus: null,
    threadId: 'thread-1',
    turnId: 'turn-1',
    reportPath: '.orquesta/reports/inspections/BENCH-001.md',
    sourceCount: 3,
    errorCode: null,
    errorMessage: null,
    createdAt: '2026-07-21T09:00:00.000Z',
    completedAt: '2026-07-21T09:01:00.000Z',
    ...overrides
  };
}

const runs = [
  run({ runId: 'BENCH-001' }),
  run({
    runId: 'AUDIT-001',
    kind: 'adversarial_audit',
    displayName: 'Adversarial audit',
    sourceCount: 0,
    createdAt: '2026-07-21T10:00:00.000Z',
    completedAt: '2026-07-21T10:01:00.000Z'
  })
];

function Subject({ records = runs, readReport }: {
  records?: InspectionRunUiModel[];
  readReport(runId: string): Promise<{ runId: string; markdown: string }>;
}) {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  return <InspectionRecordsWorkspace runs={records} selectedRunId={selectedRunId} onSelectedRunIdChange={setSelectedRunId} readReport={readReport} />;
}

describe('InspectionRecordsWorkspace', () => {
  test('filters runs and renders a safe report modal that closes outside or with Escape', async () => {
    const user = userEvent.setup();
    const readReport = vi.fn(async (runId: string) => ({
      runId,
      markdown: '## Main finding\n\n- Evidence one\n- Evidence two\n\n[Primary source](https://example.com/report)\n\n[Unsafe](javascript:alert(1))'
    }));
    const view = render(
      <I18nProvider initialLocale="ja">
        <Subject readReport={readReport} />
      </I18nProvider>
    );

    await user.click(screen.getByRole('button', { name: '敵対監査' }));
    expect(screen.getByRole('button', { name: /AUDIT-001/u })).toBeVisible();
    expect(screen.queryByRole('button', { name: /BENCH-001/u })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /AUDIT-001/u }));
    const dialog = await screen.findByRole('dialog', { name: '敵対監査レポート' });
    expect(within(dialog).getByRole('heading', { name: 'Main finding' })).toBeVisible();
    expect(within(dialog).getByRole('list')).toHaveTextContent('Evidence one');
    expect(within(dialog).getByRole('link', { name: 'Primary source' })).toHaveAttribute('href', 'https://example.com/report');
    expect(within(dialog).queryByRole('link', { name: 'Unsafe' })).not.toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /AUDIT-001/u }));
    expect(await screen.findByRole('dialog')).toBeVisible();
    await user.click(screen.getByTestId('inspection-record-modal-backdrop'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    view.unmount();
  });

  test('keeps a failed report row visible and offers retry', async () => {
    const user = userEvent.setup();
    const readReport = vi.fn()
      .mockRejectedValueOnce(new Error('report unavailable'))
      .mockResolvedValueOnce({ runId: 'BENCH-001', markdown: '## Recovered' });
    render(
      <I18nProvider initialLocale="en">
        <Subject records={[runs[0]]} readReport={readReport} />
      </I18nProvider>
    );

    await user.click(screen.getByRole('button', { name: /BENCH-001/u }));
    expect(await screen.findByText('report unavailable')).toBeVisible();
    expect(screen.getByRole('button', { name: /BENCH-001/u })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'Recovered' })).toBeVisible();
  });
});
