import { useMemo, useState } from 'react';
import { Check, ChevronDown, ChevronUp, Circle, Pause, X } from 'lucide-react';
import type { SetupPhaseUiModel, SetupUiSnapshot } from '../../../contracts/orquesta-ui';
import { SetupOrganStage } from './SetupOrganStage';
import { createSetupVisualState } from './setup-visual-state';
import './initial-setup.css';

interface InitialSetupExperienceProps {
  setup: SetupUiSnapshot;
  onCancel?: () => void;
}

const phaseStatusLabel: Record<SetupPhaseUiModel['status'], string> = {
  complete: '完了',
  active: '実行中',
  waiting: '待機',
  blocked: '停止'
};

const mechanismCopy = [
  '入力機構を始動しています',
  '動力列へ回転を伝えています',
  '機械制御を同期しています',
  'ベローズと空気槽を加圧しています',
  '必要なパイプへ空気経路を接続しています',
  '全機構の同期を確認しています'
] as const;

function PhaseStateIcon({ status }: { status: SetupPhaseUiModel['status'] }) {
  if (status === 'complete') return <Check size={12} strokeWidth={2.5} aria-hidden="true" />;
  if (status === 'blocked') return <Pause size={11} strokeWidth={2.3} aria-hidden="true" />;
  return <Circle size={9} strokeWidth={status === 'active' ? 3 : 1.7} aria-hidden="true" />;
}

export function InitialSetupExperience({ setup, onCancel }: InitialSetupExperienceProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const activePhase = setup.phases.find((phase) => phase.id === setup.currentPhaseId)
    ?? setup.phases.find((phase) => phase.status === 'active' || phase.status === 'blocked')
    ?? setup.phases[0];
  const visualState = useMemo(() => createSetupVisualState(setup, false), [setup]);
  const progressValue = setup.status === 'completed'
    ? setup.phases.length
    : activePhase?.order ?? Math.max(1, setup.phases.filter((phase) => phase.status === 'complete').length);
  const stopped = setup.status === 'paused' || setup.status === 'blocked' || setup.status === 'cancelled';
  const liveLabel = setup.status === 'completed' ? '完了' : stopped ? '停止中' : '構築中';

  return (
    <main className="initial-setup" role="main" aria-label="Orquesta 初回セットアップ">
      <div className="initial-setup__paper" aria-hidden="true" />

      <aside className="initial-setup__rail">
        <header className="initial-setup__brand">
          <p>ORQUESTA SETUP</p>
          <h2>{setup.projectTitle}</h2>
          <small>LOCAL MULTI-AGENT WORKSPACE</small>
        </header>

        <nav className="initial-setup__phases" aria-label="セットアップ段階">
          <div className="initial-setup__section-label">
            <span>SETUP PHASES</span>
            <strong>{String(progressValue).padStart(2, '0')} / 06</strong>
          </div>
          <ol>
            {setup.phases.map((phase) => (
              <li
                key={phase.id}
                data-setup-phase
                data-state={phase.status}
                aria-current={phase.status === 'active' ? 'step' : undefined}
                aria-label={`フェーズ${phase.order} ${phase.title} ${phaseStatusLabel[phase.status]}`}
              >
                <span className="initial-setup__phase-index">{String(phase.order).padStart(2, '0')}</span>
                <span className="initial-setup__phase-copy">
                  <small>PHASE {phase.order}</small>
                  <strong>{phase.title}</strong>
                  <span>{phase.summary}</span>
                </span>
                <span className="initial-setup__phase-state"><PhaseStateIcon status={phase.status} />{phaseStatusLabel[phase.status]}</span>
              </li>
            ))}
          </ol>
        </nav>

        <section className="initial-setup__status" aria-labelledby="initial-setup-title">
          <div className="initial-setup__status-heading">
            <div>
              <small>STATUS</small>
              <h1 id="initial-setup-title">{setup.currentActivity?.title ?? activePhase?.title ?? '初回セットアップ'}</h1>
            </div>
            <span className={`initial-setup__live initial-setup__live--${setup.status}`}><i aria-hidden="true" />{liveLabel}</span>
          </div>
          <p className="initial-setup__lead">{setup.currentActivity?.detail ?? activePhase?.summary}</p>

          <div className="initial-setup__progress-row">
            <span>PROGRESS</span>
            <strong>{visualState.overallProgress}%</strong>
          </div>
          <div
            className="initial-setup__progress"
            role="progressbar"
            aria-label="セットアップ進行状況"
            aria-valuemin={1}
            aria-valuemax={setup.phases.length}
            aria-valuenow={progressValue}
            aria-valuetext={`${setup.phases.length}段階中${progressValue}段階目`}
          >
            <i style={{ width: `${visualState.overallProgress}%` }} aria-hidden="true" />
          </div>

          <div className="initial-setup__log-heading">
            <span>SYSTEM LOG</span>
            {setup.nextActivity ? <small data-prefix="次">{setup.nextActivity.title}</small> : null}
          </div>
          <ol className="initial-setup__logs" aria-label="直近のセットアップ処理">
            {visualState.logs.map((entry) => (
              <li key={entry.id} data-testid="setup-log-entry" data-state={entry.state}>
                <time>{entry.time}</time>
                <span>{entry.message}</span>
                <strong>{entry.stateLabel}</strong>
              </li>
            ))}
          </ol>

          <div className="initial-setup__technical">
            <button type="button" aria-expanded={detailsOpen} onClick={() => setDetailsOpen((open) => !open)}>
              {detailsOpen ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
              {detailsOpen ? '技術的な詳細を閉じる' : '技術的な詳細を表示'}
            </button>
            {detailsOpen ? (
              <dl>
                {setup.technicalDetails.map((detail) => (
                  <div key={detail.id} data-tone={detail.tone}>
                    <dt>{detail.label}</dt>
                    <dd>{detail.value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </div>
        </section>

        <footer className="initial-setup__footer">
          <span><i aria-hidden="true" />LOCAL</span>
          <small title={setup.projectRootLabel}>{setup.projectRootLabel}</small>
          {setup.canCancel ? (
            <button type="button" onClick={() => setConfirmCancel(true)}>セットアップを中止 <X size={14} aria-hidden="true" /></button>
          ) : null}
        </footer>
      </aside>

      <section className="initial-setup__stage" role="region" aria-label="パイプオルガン構築状況">
        <div className="initial-setup__stage-kicker"><i aria-hidden="true" /> MECHANICAL ORCHESTRATION / LOCAL SYSTEM</div>
        <SetupOrganStage setup={setup} />
        <div className="initial-setup__stage-caption">
          <small>PHASE {activePhase?.order ?? 1} · {activePhase?.id.toUpperCase()}</small>
          <p>{mechanismCopy[(activePhase?.order ?? 1) - 1]}</p>
        </div>
      </section>

      {confirmCancel ? (
        <div className="initial-setup__modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setConfirmCancel(false);
        }}>
          <section className="initial-setup__modal" role="dialog" aria-modal="true" aria-labelledby="cancel-setup-title">
            <span className="initial-setup__modal-icon"><Pause size={20} aria-hidden="true" /></span>
            <div>
              <h2 id="cancel-setup-title">セットアップを中止しますか</h2>
              <p>現在の進行状況は保存されます。次回はこの段階から再開できます。</p>
            </div>
            <div className="initial-setup__modal-actions">
              <button type="button" onClick={() => setConfirmCancel(false)}>中止せず戻る</button>
              <button type="button" className="initial-setup__modal-danger" onClick={() => { setConfirmCancel(false); onCancel?.(); }}>セットアップを中止する</button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}
