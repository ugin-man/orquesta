import { useState } from 'react';
import { Check, ChevronDown, ChevronUp, Circle, Pause, X } from 'lucide-react';
import type { SetupPhaseUiModel, SetupUiSnapshot } from '../../../contracts/orquesta-ui';
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

const phaseGearVariants = [
  { name: 'medium', src: '/setup/setup-gear-medium.png' },
  { name: 'fine', src: '/setup/setup-gear-fine.png' },
  { name: 'heavy', src: '/setup/setup-gear-heavy.png' },
  { name: 'medium', src: '/setup/setup-gear-medium.png' },
  { name: 'fine', src: '/setup/setup-gear-fine.png' },
  { name: 'heavy', src: '/setup/setup-gear-heavy.png' }
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
    ?? setup.phases.find((phase) => phase.status === 'active')
    ?? setup.phases[0];
  const progressValue = activePhase?.order ?? Math.max(1, setup.phases.filter((phase) => phase.status === 'complete').length);

  return (
    <main className="initial-setup" role="main" aria-label="Orquesta 初回セットアップ">
      <div className="initial-setup__paper" aria-hidden="true" />
      <div className="initial-setup__organ" aria-hidden="true" />

      <section className="initial-setup__details" aria-labelledby="initial-setup-title">
        <header className="initial-setup__brand">
          <span>Orquesta</span>
          <small>初回セットアップ</small>
          <i aria-hidden="true" />
        </header>

        <div className="initial-setup__phase-kicker">
          <span>フェーズ {String(activePhase?.order ?? 1).padStart(2, '0')} / {String(setup.phases.length).padStart(2, '0')}</span>
          <span className={`initial-setup__live initial-setup__live--${setup.status}`}><i aria-hidden="true" />{setup.status === 'paused' || setup.status === 'blocked' ? '停止中' : '構築中'}</span>
        </div>

        <h1 id="initial-setup-title">{setup.currentActivity?.title ?? activePhase?.title ?? '初回セットアップ'}</h1>
        <p className="initial-setup__lead">{setup.currentActivity?.detail ?? activePhase?.summary}</p>

        <div
          className="initial-setup__progress"
          role="progressbar"
          aria-label="セットアップ進行状況"
          aria-valuemin={1}
          aria-valuemax={setup.phases.length}
          aria-valuenow={progressValue}
          aria-valuetext={`${setup.phases.length}段階中${progressValue}段階目`}
        >
          {setup.phases.map((phase) => <i key={phase.id} data-state={phase.status} aria-hidden="true" />)}
        </div>

        <ol className="initial-setup__activity" aria-label="セットアップ処理">
          {setup.recentActivities.slice(0, 2).map((activity) => (
            <li key={activity.id} data-state="complete">
              <span className="initial-setup__activity-mark"><Check size={12} aria-hidden="true" /></span>
              <div><small>完了</small><strong>{activity.title}</strong></div>
            </li>
          ))}
          {setup.currentActivity ? (
            <li data-state={setup.currentActivity.status}>
              <span className="initial-setup__activity-mark"><Circle size={9} fill="currentColor" aria-hidden="true" /></span>
              <div><small>{setup.currentActivity.status === 'failed' ? '停止' : '実行中'}</small><strong>{setup.currentActivity.title}</strong></div>
            </li>
          ) : null}
          {setup.nextActivity ? (
            <li data-state="waiting">
              <span className="initial-setup__activity-mark"><Circle size={10} aria-hidden="true" /></span>
              <div><small>次</small><strong>{setup.nextActivity.title}</strong></div>
            </li>
          ) : null}
        </ol>

        <div className="initial-setup__technical">
          <button type="button" aria-expanded={detailsOpen} onClick={() => setDetailsOpen((open) => !open)}>
            {detailsOpen ? <ChevronUp size={15} aria-hidden="true" /> : <ChevronDown size={15} aria-hidden="true" />}
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

      <nav className="initial-setup__phases" aria-label="セットアップ段階">
        <ol>
          {setup.phases.map((phase) => {
            const gear = phaseGearVariants[(phase.order - 1) % phaseGearVariants.length]!;
            return (
            <li key={phase.id} data-state={phase.status} aria-current={phase.status === 'active' ? 'step' : undefined}>
              <span className="initial-setup__gear-wrap" data-setup-gear data-state={phase.status} data-variant={gear.name} aria-hidden="true">
                <img src={gear.src} alt="" draggable={false} />
              </span>
              <span className="initial-setup__phase-copy">
                <span className="initial-setup__phase-number">{String(phase.order).padStart(2, '0')}</span>
                <strong>{phase.title}</strong>
                <small className="initial-setup__phase-state"><PhaseStateIcon status={phase.status} />{phaseStatusLabel[phase.status]}</small>
                <small className="initial-setup__phase-summary">{phase.summary}</small>
              </span>
            </li>
            );
          })}
        </ol>
      </nav>

      <footer className="initial-setup__footer">
        <span>{setup.projectTitle}</span>
        <span aria-hidden="true">·</span>
        <small>{setup.projectRootLabel}</small>
        {setup.canCancel ? (
          <button type="button" onClick={() => setConfirmCancel(true)}>セットアップを中止 <X size={15} aria-hidden="true" /></button>
        ) : null}
      </footer>

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
