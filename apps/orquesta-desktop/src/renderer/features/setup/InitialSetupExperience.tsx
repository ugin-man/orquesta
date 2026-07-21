import { useMemo, useState } from 'react';
import { Check, ChevronDown, ChevronUp, Circle, Pause, X } from 'lucide-react';
import type { SetupPhaseUiModel, SetupUiSnapshot } from '../../../contracts/orquesta-ui';
import type { Locale } from '../i18n/messages';
import { SetupOrganStage } from './SetupOrganStage';
import { getSetupCopy, localizeSetupActivity, localizeSetupPhase, localizeTechnicalDetail } from './setup-localization';
import { createSetupVisualState } from './setup-visual-state';
import './initial-setup.css';

interface InitialSetupExperienceProps {
  setup: SetupUiSnapshot;
  locale?: Locale;
  onCancel?: () => void;
}

function PhaseStateIcon({ status }: { status: SetupPhaseUiModel['status'] }) {
  if (status === 'complete') return <Check size={12} strokeWidth={2.5} aria-hidden="true" />;
  if (status === 'blocked') return <Pause size={11} strokeWidth={2.3} aria-hidden="true" />;
  return <Circle size={9} strokeWidth={status === 'active' ? 3 : 1.7} aria-hidden="true" />;
}

export function InitialSetupExperience({ setup, locale = 'ja', onCancel }: InitialSetupExperienceProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const copy = getSetupCopy(locale);
  const localizedPhases = useMemo(() => setup.phases.map((phase) => localizeSetupPhase(phase, locale)), [locale, setup.phases]);
  const localizedCurrentActivity = useMemo(() => setup.currentActivity ? localizeSetupActivity(setup.currentActivity, locale) : null, [locale, setup.currentActivity]);
  const localizedNextActivity = useMemo(() => setup.nextActivity ? localizeSetupActivity(setup.nextActivity, locale) : null, [locale, setup.nextActivity]);
  const activePhase = localizedPhases.find((phase) => phase.id === setup.currentPhaseId)
    ?? localizedPhases.find((phase) => phase.status === 'active' || phase.status === 'blocked')
    ?? localizedPhases[0];
  const visualState = useMemo(() => createSetupVisualState(setup, false, locale), [locale, setup]);
  const progressValue = setup.status === 'completed'
    ? setup.phases.length
    : activePhase?.order ?? Math.max(1, setup.phases.filter((phase) => phase.status === 'complete').length);
  const stopped = setup.status === 'paused' || setup.status === 'blocked' || setup.status === 'cancelled';
  const liveLabel = setup.status === 'completed' ? copy.liveStatus.complete : stopped ? copy.liveStatus.stopped : copy.liveStatus.running;

  return (
    <main className="initial-setup" role="main" aria-label={copy.mainLabel}>
      <div className="initial-setup__paper" aria-hidden="true" />

      <aside className="initial-setup__rail">
        <header className="initial-setup__brand">
          <p>ORQUESTA SETUP</p>
          <h2>{setup.projectTitle}</h2>
          <small>LOCAL MULTI-AGENT WORKSPACE</small>
        </header>

        <nav className="initial-setup__phases" aria-label={copy.phaseNav}>
          <div className="initial-setup__section-label">
            <span>SETUP PHASES</span>
            <strong>{String(progressValue).padStart(2, '0')} / 06</strong>
          </div>
          <ol>
            {localizedPhases.map((phase) => (
              <li
                key={phase.id}
                data-setup-phase
                data-state={phase.status}
                aria-current={phase.status === 'active' ? 'step' : undefined}
                aria-label={`${locale === 'ja' ? 'フェーズ' : 'Phase '}${phase.order} ${phase.title} ${copy.phaseStatus[phase.status]}`}
              >
                <span className="initial-setup__phase-index">{String(phase.order).padStart(2, '0')}</span>
                <span className="initial-setup__phase-copy">
                  <small>PHASE {phase.order}</small>
                  <strong>{phase.title}</strong>
                  <span>{phase.summary}</span>
                </span>
                <span className="initial-setup__phase-state"><PhaseStateIcon status={phase.status} />{copy.phaseStatus[phase.status]}</span>
              </li>
            ))}
          </ol>
        </nav>

        <section className="initial-setup__status" aria-labelledby="initial-setup-title">
          <div className="initial-setup__status-heading">
            <div>
              <small>STATUS</small>
              <h1 id="initial-setup-title">{localizedCurrentActivity?.title ?? activePhase?.title ?? copy.setupFallback}</h1>
            </div>
            <span className={`initial-setup__live initial-setup__live--${setup.status}`}><i aria-hidden="true" />{liveLabel}</span>
          </div>
          <p className="initial-setup__lead">{localizedCurrentActivity?.detail ?? activePhase?.summary}</p>

          <div className="initial-setup__progress-row">
            <span>{copy.progress.toUpperCase()}</span>
            <strong>{visualState.overallProgress}%</strong>
          </div>
          <div
            className="initial-setup__progress"
            role="progressbar"
            aria-label={copy.progressLabel}
            aria-valuemin={1}
            aria-valuemax={setup.phases.length}
            aria-valuenow={progressValue}
            aria-valuetext={copy.progressText(progressValue, setup.phases.length)}
          >
            <i style={{ width: `${visualState.overallProgress}%` }} aria-hidden="true" />
          </div>

          <div className="initial-setup__log-heading">
            <span>{copy.systemLog.toUpperCase()}</span>
            {localizedNextActivity ? <small data-prefix={copy.nextPrefix}>{localizedNextActivity.title}</small> : null}
          </div>
          <ol className="initial-setup__logs" aria-label={copy.recentProcesses}>
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
              {detailsOpen ? copy.detailsClose : copy.detailsOpen}
            </button>
            {detailsOpen ? (
              <dl>
                {setup.technicalDetails.map((detail) => localizeTechnicalDetail(detail, locale)).map((detail) => (
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
            <button type="button" onClick={() => setConfirmCancel(true)}>{copy.cancel} <X size={14} aria-hidden="true" /></button>
          ) : null}
        </footer>
      </aside>

      <section className="initial-setup__stage" role="region" aria-label={copy.stageLabel}>
        <div className="initial-setup__stage-kicker"><i aria-hidden="true" /> {copy.stageKicker}</div>
        <SetupOrganStage setup={setup} locale={locale} />
        <div className="initial-setup__stage-caption">
          <small>PHASE {activePhase?.order ?? 1} · {activePhase?.id.toUpperCase()}</small>
          <p>{copy.mechanism[(activePhase?.order ?? 1) - 1]}</p>
        </div>
      </section>

      {confirmCancel ? (
        <div className="initial-setup__modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setConfirmCancel(false);
        }}>
          <section className="initial-setup__modal" role="dialog" aria-modal="true" aria-labelledby="cancel-setup-title">
            <span className="initial-setup__modal-icon"><Pause size={20} aria-hidden="true" /></span>
            <div>
              <h2 id="cancel-setup-title">{copy.cancelTitle}</h2>
              <p>{copy.cancelBody}</p>
            </div>
            <div className="initial-setup__modal-actions">
              <button type="button" onClick={() => setConfirmCancel(false)}>{copy.cancelBack}</button>
              <button type="button" className="initial-setup__modal-danger" onClick={() => { setConfirmCancel(false); onCancel?.(); }}>{copy.cancelConfirm}</button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}
