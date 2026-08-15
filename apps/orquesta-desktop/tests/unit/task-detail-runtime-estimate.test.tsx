import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { task } from '../../src/fixtures/helpers';
import { TaskDetail } from '../../src/renderer/features/details/TaskDetail';
import { I18nProvider } from '../../src/renderer/features/i18n/I18nProvider';

describe('TaskDetail runtime estimate', () => {
  test('shows separate AI, elapsed, and human clocks with calibration evidence', () => {
    render(
      <I18nProvider initialLocale="ja">
        <TaskDetail
          task={task({
            id: 'T-ETA',
            title: '見積もり表示',
            runtimeEstimate: {
              source: 'agent_decomposed',
              agentActiveMinutes: { p50: 18, p80: 42 },
              elapsedMinutes: { p50: 22, p80: 55 },
              humanInterventionMinutes: { p50: 0, p80: 5 },
              confidence: 0.74,
              calibrationMode: 'historical',
              calibrationSampleCount: 12,
              externalGateCount: 1,
              unknownBlockingGateCount: 1,
              uncertaintyDrivers: ['test_latency']
            }
          })}
          agents={[]}
          onClose={vi.fn()}
        />
      </I18nProvider>
    );

    expect(screen.getByRole('region', { name: 'AI作業時間' })).toBeVisible();
    expect(screen.getByText('AI分解済み')).toBeVisible();
    expect(screen.getByText('P50 18m')).toBeVisible();
    expect(screen.getByText('P80 42m')).toBeVisible();
    expect(screen.getByText('P50 22m')).toBeVisible();
    expect(screen.getByText('P80 55m')).toBeVisible();
    expect(screen.getByText('74%')).toBeVisible();
    expect(screen.getByText('実測校正')).toBeVisible();
    expect(screen.getByText('12件')).toBeVisible();
    expect(screen.getByText('完了時刻には、時間不明の外部待機 1 件を含めていません。')).toBeVisible();
  });

  test('omits the section when canonical state has no estimate', () => {
    render(
      <I18nProvider initialLocale="en">
        <TaskDetail task={task({ id: 'T-NONE', title: 'No estimate' })} agents={[]} onClose={vi.fn()} />
      </I18nProvider>
    );
    expect(screen.queryByRole('region', { name: 'AI runtime estimate' })).not.toBeInTheDocument();
  });
});
