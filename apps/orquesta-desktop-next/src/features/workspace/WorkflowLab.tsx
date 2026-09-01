import { useState } from 'react';
import type { FormEvent } from 'react';
import type { ApplicationStore } from '../../application/store';
import type { ApplicationState } from '../../application/state';
import {
  workflowAttemptStatusCopy,
  workflowBatchStatusCopy,
  workflowCheckOutcomeCopy,
} from '../../presentation/user-copy';

interface WorkflowLabProps {
  state: ApplicationState;
  store: ApplicationStore;
  locale: 'ja' | 'en';
}

function metric(value: number | null, locale: 'ja' | 'en'): string {
  return value === null ? (locale === 'ja' ? '未評価' : 'NOT ASSESSED') : `${value}%`;
}

export function WorkflowLab({ state, store, locale }: WorkflowLabProps) {
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [expectedText, setExpectedText] = useState('');
  const [repetitions, setRepetitions] = useState(3);
  const [openedResult, setOpenedResult] = useState<{ attemptId: string; output: string } | null>(null);
  const catalog = state.workflowCatalog;
  const maximumRepetitions = catalog?.maxAttemptsPerBatch ?? 50;
  const repetitionsAreValid = Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= maximumRepetitions;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !prompt.trim()) return;
    await store.saveWorkflowDefinition({
      workflowId: null,
      name,
      prompt,
      checks: expectedText.trim()
        ? [{ kind: 'contains', text: expectedText.trim(), caseSensitive: false }]
        : [],
    });
  };

  return (
    <section className="workflow-lab" aria-labelledby="workflow-lab-title">
      <header>
        <div>
          <span>REPEATABLE READ-ONLY WORKFLOWS</span>
          <h3 id="workflow-lab-title">{locale === 'ja' ? '反復ワークフロー' : 'WORKFLOW LAB'}</h3>
        </div>
        <button type="button" disabled={state.workflowLoading} onClick={() => void store.refreshWorkflowCatalog()}>
          {state.workflowLoading ? (locale === 'ja' ? '読取中' : 'READING') : (locale === 'ja' ? '再読込' : 'REFRESH')}
        </button>
      </header>
      <p className="workflow-explainer">{locale === 'ja'
        ? '同じ指示を毎回まっさらな一時AIへ渡します。実行完了率と、任意の確認文に対する通過率を分けて表示します。確認を設定しない実行は、成功を推測せず未評価になります。'
        : 'Each run uses a fresh temporary AI. Completion, optional local checks, and outcome consistency remain separate.'}</p>
      <div className="workflow-columns">
        <form onSubmit={(event) => void save(event)}>
          <h4>{locale === 'ja' ? '新しいワークフロー' : 'NEW WORKFLOW'}</h4>
          <label>{locale === 'ja' ? '名前' : 'Name'}<input value={name} onChange={(event) => setName(event.target.value)} maxLength={256} /></label>
          <label>{locale === 'ja' ? '一時AIへ渡す指示' : 'Prompt'}<textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={6} maxLength={65_536} /></label>
          <label>{locale === 'ja' ? '結果に含まれてほしい語句（任意）' : 'Expected text (optional)'}<input value={expectedText} onChange={(event) => setExpectedText(event.target.value)} maxLength={1_024} /></label>
          <button type="submit" disabled={Boolean(state.actionPendingId) || !name.trim() || !prompt.trim()}>{locale === 'ja' ? '保存' : 'SAVE'}</button>
        </form>
        <div className="workflow-definitions">
          <div className="workflow-repeat-control">
            <label>{locale === 'ja' ? '反復回数' : 'Runs'}<input type="number" min={1} max={maximumRepetitions} value={repetitions} onChange={(event) => setRepetitions(Number(event.target.value))} /></label>
          </div>
          {(catalog?.definitions ?? []).length === 0
            ? <p className="empty-state">{locale === 'ja' ? '保存されたワークフローはありません。' : 'No saved workflows.'}</p>
            : catalog!.definitions.map((definition) => (
              <article key={definition.workflowId}>
                <span>{definition.checks.length === 0 ? (locale === 'ja' ? '結果確認なし' : 'UNASSESSED') : `${definition.checks.length} CHECK`}</span>
                <h4>{definition.name}</h4>
                <p>{definition.prompt}</p>
                <button type="button" disabled={Boolean(state.actionPendingId) || !repetitionsAreValid} onClick={() => void store.startWorkflowBatch(definition.workflowId, repetitions)}>
                  {locale === 'ja' ? `${repetitions}回実行` : `RUN ×${repetitions}`}
                </button>
              </article>
            ))}
        </div>
      </div>
      <div className="workflow-batches">
        {(catalog?.batches ?? []).map((batch) => (
          <article key={batch.batchId}>
            <header><span>{workflowBatchStatusCopy(batch.status, locale)}</span><b>{catalog?.definitions.find((item) => item.workflowId === batch.workflowId)?.name ?? batch.workflowId}</b></header>
            <dl>
              <div><dt>{locale === 'ja' ? '実行完了率' : 'COMPLETION'}</dt><dd>{metric(batch.metrics.executionReliabilityPercent, locale)}</dd></div>
              <div><dt>{locale === 'ja' ? '確認通過率' : 'CHECK PASS'}</dt><dd>{metric(batch.metrics.successRatePercent, locale)}</dd></div>
              <div><dt>{locale === 'ja' ? '判定一致率' : 'CONSISTENCY'}</dt><dd>{metric(batch.metrics.outcomeConsistencyPercent, locale)}</dd></div>
              <div><dt>{locale === 'ja' ? '標本数' : 'SAMPLE'}</dt><dd>{batch.metrics.terminalRuns}/{batch.metrics.requestedRuns}</dd></div>
            </dl>
            <div className="workflow-attempts">
              {batch.attempts.map((attempt) => {
                const checkOutcome = workflowCheckOutcomeCopy(attempt.checkOutcome, locale);
                return <button
                  key={attempt.attemptId}
                  type="button"
                  disabled={!attempt.resultPreview}
                  onClick={() => {
                    if (!attempt.resultPreview) return;
                    void store.readWorkflowResult(batch.batchId, attempt.attemptId).then((output) => {
                      if (output) setOpenedResult({ attemptId: attempt.attemptId, output });
                    });
                  }}
                >#{attempt.ordinal} {workflowAttemptStatusCopy(attempt.status, locale)} {checkOutcome ? `/ ${checkOutcome}` : ''}</button>;
              })}
            </div>
            {['queued', 'running', 'cancelling'].includes(batch.status) && (
              <button type="button" disabled={Boolean(state.actionPendingId)} onClick={() => void store.cancelWorkflowBatch(batch.batchId)}>
                {locale === 'ja' ? 'この反復を停止' : 'CANCEL BATCH'}
              </button>
            )}
          </article>
        ))}
      </div>
      {openedResult && (
        <aside className="workflow-result" role="dialog" aria-modal="false" aria-label={locale === 'ja' ? 'ワークフロー結果' : 'Workflow result'}>
          <header><b>{openedResult.attemptId}</b><button type="button" onClick={() => setOpenedResult(null)}>{locale === 'ja' ? '閉じる' : 'CLOSE'}</button></header>
          <pre>{openedResult.output}</pre>
        </aside>
      )}
    </section>
  );
}
