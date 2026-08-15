from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def write(relative: str, content: str) -> None:
    target = ROOT / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8", newline="\n")


def replace_once(relative: str, old: str, new: str) -> None:
    target = ROOT / relative
    source = target.read_text(encoding="utf-8")
    if new in source:
        return
    if old not in source:
        raise RuntimeError(f"Patch anchor missing in {relative}: {old[:80]!r}")
    target.write_text(source.replace(old, new, 1), encoding="utf-8", newline="\n")


write(
    "apps/orquesta-desktop/src/contracts/runtime-estimate-ui.ts",
    """export type RuntimeEstimateSource = 'agent_decomposed' | 'profile_inferred' | 'unknown';
export type RuntimeCalibrationMode = 'cold_start' | 'hybrid' | 'historical' | 'unknown';

export interface RuntimeEstimateRangeUi {
  p50: number;
  p80: number;
}

export interface RuntimeEstimateUiModel {
  source: RuntimeEstimateSource;
  agentActiveMinutes: RuntimeEstimateRangeUi;
  elapsedMinutes: RuntimeEstimateRangeUi;
  humanInterventionMinutes: RuntimeEstimateRangeUi;
  confidence: number | null;
  calibrationMode: RuntimeCalibrationMode;
  calibrationSampleCount: number | null;
  externalGateCount: number;
  unknownBlockingGateCount: number;
  uncertaintyDrivers: string[];
}

declare module './orquesta-ui' {
  interface TaskUiModel {
    runtimeEstimate?: RuntimeEstimateUiModel | null;
  }
}
""",
)

write(
    "apps/orquesta-desktop/electron/core/runtime-estimate-projection.ts",
    """import type {
  RuntimeCalibrationMode,
  RuntimeEstimateRangeUi,
  RuntimeEstimateSource,
  RuntimeEstimateUiModel
} from '../../src/contracts/runtime-estimate-ui';

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function integerNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((item) => typeof item === 'string' && item.trim() ? [item.trim()] : [])
    : [];
}

function range(value: unknown): RuntimeEstimateRangeUi | null {
  const raw = object(value);
  const p50 = finiteNonNegative(raw?.p50);
  const p80 = finiteNonNegative(raw?.p80);
  return p50 !== null && p80 !== null && p80 >= p50 ? { p50, p80 } : null;
}

function source(value: unknown): RuntimeEstimateSource {
  return value === 'agent_decomposed' || value === 'profile_inferred' ? value : 'unknown';
}

function calibrationMode(value: unknown): RuntimeCalibrationMode {
  return value === 'cold_start' || value === 'hybrid' || value === 'historical' ? value : 'unknown';
}

export function projectRuntimeEstimate(value: unknown): RuntimeEstimateUiModel | null {
  const raw = object(value);
  const runtime = object(raw?.runtime);
  const agentActiveMinutes = range(runtime?.agent_active_minutes);
  const elapsedMinutes = range(runtime?.elapsed_minutes);
  const humanInterventionMinutes = range(runtime?.human_intervention_minutes);
  if (!raw || !runtime || !agentActiveMinutes || !elapsedMinutes || !humanInterventionMinutes) return null;
  if (elapsedMinutes.p50 < agentActiveMinutes.p50 || elapsedMinutes.p80 < agentActiveMinutes.p80) return null;

  const calibration = object(raw.calibration);
  const externalGates = Array.isArray(raw.external_gates)
    ? raw.external_gates.flatMap((item) => object(item) ?? [])
    : [];
  const confidence = finiteNonNegative(raw.confidence);

  return {
    source: source(raw.source),
    agentActiveMinutes,
    elapsedMinutes,
    humanInterventionMinutes,
    confidence: confidence !== null && confidence <= 1 ? confidence : null,
    calibrationMode: calibrationMode(calibration?.mode),
    calibrationSampleCount: integerNonNegative(calibration?.sample_count),
    externalGateCount: externalGates.length,
    unknownBlockingGateCount: externalGates.filter((gate) => (
      gate.status === 'unknown_wait' && gate.blocks_done_signal !== false
    )).length,
    uncertaintyDrivers: stringArray(raw.uncertainty_drivers)
  };
}
""",
)

write(
    "apps/orquesta-desktop/electron/core/runtime-estimate-projection.test.ts",
    """import { describe, expect, test } from 'vitest';
import { projectRuntimeEstimate } from './runtime-estimate-projection';

describe('runtime estimate projection', () => {
  test('projects validated task clocks and external-gate evidence', () => {
    expect(projectRuntimeEstimate({
      source: 'agent_decomposed',
      runtime: {
        agent_active_minutes: { p50: 18, p80: 42 },
        elapsed_minutes: { p50: 22, p80: 55 },
        human_intervention_minutes: { p50: 0, p80: 5 }
      },
      calibration: { mode: 'historical', sample_count: 12 },
      external_gates: [
        { status: 'known_wait', blocks_done_signal: true, known_wait_minutes: 4 },
        { status: 'unknown_wait', blocks_done_signal: true, known_wait_minutes: null }
      ],
      uncertainty_drivers: ['test_latency'],
      confidence: 0.74
    })).toEqual({
      source: 'agent_decomposed',
      agentActiveMinutes: { p50: 18, p80: 42 },
      elapsedMinutes: { p50: 22, p80: 55 },
      humanInterventionMinutes: { p50: 0, p80: 5 },
      confidence: 0.74,
      calibrationMode: 'historical',
      calibrationSampleCount: 12,
      externalGateCount: 2,
      unknownBlockingGateCount: 1,
      uncertaintyDrivers: ['test_latency']
    });
  });

  test('rejects malformed or inverted runtime clocks', () => {
    expect(projectRuntimeEstimate(null)).toBeNull();
    expect(projectRuntimeEstimate({
      runtime: {
        agent_active_minutes: { p50: 10, p80: 20 },
        elapsed_minutes: { p50: 8, p80: 18 },
        human_intervention_minutes: { p50: 0, p80: 1 }
      }
    })).toBeNull();
  });
});
""",
)

replace_once(
    "apps/orquesta-desktop/electron/core/repository-reader.ts",
    "import { assertExplicitOrganizationState } from './legacy-organization-migration';\n",
    "import { assertExplicitOrganizationState } from './legacy-organization-migration';\nimport { projectRuntimeEstimate } from './runtime-estimate-projection';\n",
)
replace_once(
    "apps/orquesta-desktop/electron/core/repository-reader.ts",
    "    actualModel,\n    actualModelEvidence,\n    startedAt: string(raw.started_at),",
    "    actualModel,\n    actualModelEvidence,\n    runtimeEstimate: projectRuntimeEstimate(raw.runtime_estimate),\n    startedAt: string(raw.started_at),",
)

write(
    "apps/orquesta-desktop/src/renderer/features/details/runtime-estimate.css",
    """.runtime-estimate {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
}
.runtime-estimate > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 4px;
}
.runtime-estimate h3 {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0;
  font-size: 9px;
  letter-spacing: .04em;
  text-transform: uppercase;
}
.runtime-estimate__source {
  padding: 3px 6px;
  border: 1px solid var(--line);
  border-radius: 99px;
  color: var(--ink-muted);
  font-size: 7px;
  white-space: nowrap;
}
.runtime-estimate dl { margin: 0; }
.runtime-estimate .task-detail-row { grid-template-columns: 45% 55%; }
.runtime-estimate dd { display: block; }
.runtime-estimate dd strong,
.runtime-estimate dd small { display: block; }
.runtime-estimate dd strong { font-size: 9px; font-weight: 650; }
.runtime-estimate dd small { margin-top: 3px; color: var(--ink-muted); font-size: 7px; }
.runtime-estimate__note {
  margin: 9px 0 0;
  padding: 7px 8px;
  border: 1px solid rgba(185,122,47,.36);
  border-radius: 7px;
  background: rgba(255,250,239,.72);
  color: #80501f;
  font-size: 8px;
  line-height: 1.4;
}
""",
)

write(
    "apps/orquesta-desktop/src/renderer/features/details/TaskDetail.tsx",
    """import { Check, Circle, Clock, FileOutput, GitBranch, Link2, Play, Send, Sparkles } from 'lucide-react';
import type { AgentUiModel, TaskUiModel } from '../../../contracts/orquesta-ui';
import type { RuntimeEstimateUiModel } from '../../../contracts/runtime-estimate-ui';
import { OverlayFrame } from '../../components/OverlayFrame';
import { formatDateTime, statusLabel } from '../../components/format';
import { useI18n } from '../i18n/I18nProvider';
import './runtime-estimate.css';

function EvidenceState({ value }: { value: boolean }) {
  const { t } = useI18n();
  return <span className={`proof-state${value ? ' is-proven' : ''}`}>{value ? <Check size={13} /> : <Circle size={11} />}{value ? t('observed') : t('notObserved')}</span>;
}

function TaskRow({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="task-detail-row"><dt>{label}</dt><dd>{children}</dd></div>;
}

function formatMinutes(minutes: number): string {
  if (minutes === 0) return '0m';
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 24) {
    const value = hours >= 10 ? Math.round(hours).toString() : hours.toFixed(1).replace(/\.0$/u, '');
    return `${value}h`;
  }
  const days = hours / 24;
  const value = days >= 10 ? Math.round(days).toString() : days.toFixed(1).replace(/\.0$/u, '');
  return `${value}d`;
}

function RuntimeRange({ value }: { value: RuntimeEstimateUiModel['agentActiveMinutes'] }) {
  return <><strong>P50 {formatMinutes(value.p50)}</strong><small>P80 {formatMinutes(value.p80)}</small></>;
}

export function TaskDetail({ task, agents, onClose }: { task: TaskUiModel; agents: AgentUiModel[]; onClose(): void }) {
  const { t, locale } = useI18n();
  const labels = locale === 'ja'
    ? {
      section: 'AI作業時間',
      agentActive: 'AI実働',
      elapsed: '完了までの経過',
      human: '人間の作業',
      calibration: '校正',
      agentDecomposed: 'AI分解済み',
      profileInferred: '初期推定',
      unknownSource: '出典不明',
      coldStart: '初期値',
      hybrid: '混合校正',
      historical: '実測校正',
      unknownCalibration: '未校正',
      samples: '件',
      excludedWait: (count: number) => `完了時刻には、時間不明の外部待機 ${count} 件を含めていません。`
    }
    : {
      section: 'AI runtime estimate',
      agentActive: 'Agent active',
      elapsed: 'Elapsed to done',
      human: 'Human work',
      calibration: 'Calibration',
      agentDecomposed: 'Agent-decomposed',
      profileInferred: 'Profile-inferred',
      unknownSource: 'Unknown source',
      coldStart: 'Cold start',
      hybrid: 'Hybrid',
      historical: 'Historical',
      unknownCalibration: 'Uncalibrated',
      samples: ' samples',
      excludedWait: (count: number) => `${count} unknown external wait${count === 1 ? '' : 's'} excluded from the completion clock.`
    };
  const agentById = new Map(agents.map((agent) => [agent.id, agent.displayName]));
  const owner = task.ownerAgentId ? agentById.get(task.ownerAgentId) ?? task.ownerAgentId : t('unknown');
  const assigner = task.assignedByAgentId === 'user' ? 'You' : task.assignedByAgentId ? agentById.get(task.assignedByAgentId) ?? task.assignedByAgentId : t('unknown');
  const estimate = task.runtimeEstimate ?? null;
  const sourceLabel = estimate?.source === 'agent_decomposed'
    ? labels.agentDecomposed
    : estimate?.source === 'profile_inferred'
      ? labels.profileInferred
      : labels.unknownSource;
  const calibrationLabel = estimate?.calibrationMode === 'historical'
    ? labels.historical
    : estimate?.calibrationMode === 'hybrid'
      ? labels.hybrid
      : estimate?.calibrationMode === 'cold_start'
        ? labels.coldStart
        : labels.unknownCalibration;
  return (
    <OverlayFrame
      title={<span>{task.id} <small className="overlay-title-separator">/</small> {task.title}</span>}
      subtitle={<span className={`state-label state-label--${task.state}`}>{statusLabel(task.state)}</span>}
      ariaLabel={`Task ${task.id}`}
      className="task-detail inspector-overlay"
      onClose={onClose}
      modal={false}
    >
      <section className="task-progress-summary">
        <div><span>{task.progressSummary ?? statusLabel(task.state)}</span><strong>{task.progressPercent == null ? '—' : `${task.progressPercent}%`}</strong></div>
        <span className="task-progress-track"><i style={{ width: `${task.progressPercent ?? 0}%` }} /></span>
      </section>

      <dl className="task-detail-grid">
        <TaskRow label="Owner">{owner}</TaskRow>
        <TaskRow label={t('assignedBy')}>{assigner}</TaskRow>
        <TaskRow label={t('routingClass')}>{task.routingClass ?? t('unknown')}</TaskRow>
        <TaskRow label={t('dependencies')}>{task.dependencies.length ? task.dependencies.join(', ') : '—'}</TaskRow>
        <TaskRow label={t('blockedBy')}>{task.blockedBy.length ? task.blockedBy.join(', ') : '—'}</TaskRow>
        <TaskRow label={t('expectedArtifact')}>{task.expectedArtifact ?? '—'}</TaskRow>
      </dl>

      {estimate ? (
        <section className="runtime-estimate" aria-label={labels.section}>
          <header><h3><Clock size={15} />{labels.section}</h3><span className="runtime-estimate__source">{sourceLabel}</span></header>
          <dl>
            <TaskRow label={labels.agentActive}><RuntimeRange value={estimate.agentActiveMinutes} /></TaskRow>
            <TaskRow label={labels.elapsed}><RuntimeRange value={estimate.elapsedMinutes} /></TaskRow>
            <TaskRow label={labels.human}><RuntimeRange value={estimate.humanInterventionMinutes} /></TaskRow>
            <TaskRow label={t('confidence')}><strong>{estimate.confidence == null ? t('unknown') : `${Math.round(estimate.confidence * 100)}%`}</strong></TaskRow>
            <TaskRow label={labels.calibration}>
              <strong>{calibrationLabel}</strong>
              <small>{estimate.calibrationSampleCount == null ? t('notRecorded') : `${estimate.calibrationSampleCount}${labels.samples}`}</small>
            </TaskRow>
          </dl>
          {estimate.unknownBlockingGateCount > 0 ? <p className="runtime-estimate__note">{labels.excludedWait(estimate.unknownBlockingGateCount)}</p> : null}
        </section>
      ) : null}

      <section className="evidence-ladder" aria-label="Execution evidence">
        <h3><Sparkles size={15} />Execution evidence</h3>
        <div><span><Send size={14} />{t('handoffSent')}</span><EvidenceState value={task.handoffSent} /></div>
        <div><span><GitBranch size={14} />{t('dispatchAccepted')}</span><EvidenceState value={task.dispatchAccepted} /></div>
        <div><span><Play size={14} />{t('turnStarted')}</span><EvidenceState value={task.turnStarted} /></div>
        <div><span><Link2 size={14} />{t('progressObserved')}</span><EvidenceState value={task.progressObserved} /></div>
      </section>

      <section className="model-evidence">
        <h3>Model routing</h3>
        <dl>
          <TaskRow label={t('recommendedModel')}>{task.recommendedModel ?? t('unknown')}</TaskRow>
          <TaskRow label={t('requestedModel')}>{task.requestedModel ?? t('unknown')}</TaskRow>
          <TaskRow label={t('actualModel')}><span>{task.actualModel ?? t('unknown')}</span><small>{statusLabel(task.actualModelEvidence)} evidence</small></TaskRow>
        </dl>
      </section>

      <section className="detail-block"><h3><FileOutput size={15} />{t('acceptanceChecks')}</h3>{task.acceptanceChecks.length ? <ul>{task.acceptanceChecks.map((check) => <li key={check}>{check}</li>)}</ul> : <p>—</p>}</section>
      <footer className="task-timestamps">Started {formatDateTime(task.startedAt)} · Updated {formatDateTime(task.updatedAt)}</footer>
    </OverlayFrame>
  );
}
""",
)

write(
    "apps/orquesta-desktop/electron/core/repository-runtime-estimate.test.ts",
    """import { describe, expect, test } from 'vitest';
import { projectSnapshotFromDocuments } from './repository-reader';

describe('repository runtime estimate projection', () => {
  test('projects a canonical task runtime estimate for Desktop', () => {
    const snapshot = projectSnapshotFromDocuments({
      rootPath: 'C:\\work\\runtime-estimate',
      documents: {
        agents: { agents: [] },
        tasks: {
          tasks: [{
            task_id: 'T-ETA',
            title: 'Estimate the bounded task',
            state: 'queued',
            runtime_estimate: {
              source: 'profile_inferred',
              runtime: {
                agent_active_minutes: { p50: 14, p80: 36 },
                elapsed_minutes: { p50: 16, p80: 40 },
                human_intervention_minutes: { p50: 0, p80: 4 }
              },
              calibration: { mode: 'cold_start', sample_count: 0 },
              external_gates: [{ status: 'unknown_wait', blocks_done_signal: true, known_wait_minutes: null }],
              uncertainty_drivers: ['cold_start_calibration'],
              confidence: 0.3
            }
          }]
        }
      }
    });

    expect(snapshot.tasks[0].runtimeEstimate).toMatchObject({
      source: 'profile_inferred',
      agentActiveMinutes: { p50: 14, p80: 36 },
      elapsedMinutes: { p50: 16, p80: 40 },
      humanInterventionMinutes: { p50: 0, p80: 4 },
      confidence: 0.3,
      calibrationMode: 'cold_start',
      calibrationSampleCount: 0,
      unknownBlockingGateCount: 1
    });
  });
});
""",
)

write(
    "apps/orquesta-desktop/tests/unit/task-detail-runtime-estimate.test.tsx",
    """import { render, screen } from '@testing-library/react';
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
""",
)

print("runtime estimate Desktop patch applied")
