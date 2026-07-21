import { ArrowLeft, Send, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AskLucaInput, LucaAnswerPayload, LucaContextRef, LucaQuestionId } from '../../../contracts/luca';
import { questionsFor } from '../../../contracts/luca-question-catalog';

export type LucaPanelState =
  | { kind: 'idle' }
  | { kind: 'pending'; questionId: LucaQuestionId }
  | { kind: 'answer'; payload: LucaAnswerPayload }
  | { kind: 'error'; message: string; retryable: boolean };

export function LucaPanel({ context, locale, state, onAsk, onClose, onReset }: {
  context: LucaContextRef;
  locale: 'ja' | 'en';
  state: LucaPanelState;
  onAsk(input: AskLucaInput): void | Promise<void>;
  onClose(): void;
  onReset?(): void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [customText, setCustomText] = useState('');
  const questions = useMemo(() => questionsFor(context.kind), [context.kind]);
  const pending = state.kind === 'pending';

  useEffect(() => {
    setCustomOpen(false);
    setCustomText('');
  }, [context.kind, context.kind === 'home' ? 'home' : context.id]);

  const ask = (questionId: LucaQuestionId, text?: string) => {
    if (pending) return;
    void onAsk({ questionId, context, locale, customText: text ?? null });
  };

  return (
    <aside
      ref={panelRef}
      className="luca-panel"
      aria-label="Luca"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && panelRef.current?.contains(document.activeElement)) onClose();
      }}
    >
      <header className="luca-panel__header">
        <div><span>Luca</span><small>{locale === 'ja' ? 'プロジェクト説明係' : 'Project explainer'}</small></div>
        <button type="button" className="luca-panel__close" onClick={onClose} aria-label={locale === 'ja' ? 'Lucaを閉じる' : 'Close Luca'}><X size={17} /></button>
      </header>

      {state.kind === 'answer' ? (
        <div className="luca-panel__answer">
          <p>{state.payload.answer}</p>
          {state.payload.points.length ? <ul>{state.payload.points.map((point) => <li key={point}>{point}</li>)}</ul> : null}
          {state.payload.uncertainties.length ? (
            <section><small>{locale === 'ja' ? '不明な点・限界' : 'Unknowns and limits'}</small><ul>{state.payload.uncertainties.map((item) => <li key={item}>{item}</li>)}</ul></section>
          ) : null}
          {state.payload.references.length ? (
            <section className="luca-panel__references"><small>{locale === 'ja' ? '参照した記録' : 'References'}</small><div>{state.payload.references.map((reference) => <span key={`${reference.kind}:${reference.id}`}>{reference.label}</span>)}</div></section>
          ) : null}
          <button type="button" className="luca-panel__back" onClick={onReset}><ArrowLeft size={14} />{locale === 'ja' ? '別の質問をする' : 'Ask another question'}</button>
        </div>
      ) : state.kind === 'error' ? (
        <div className="luca-panel__error" role="alert"><p>{state.message}</p><button type="button" onClick={onReset}>{locale === 'ja' ? '質問一覧に戻る' : 'Back to questions'}</button></div>
      ) : (
        <div className="luca-panel__body">
          <p className="luca-panel__intro">{locale === 'ja' ? '記録をもとに、いま表示している内容を短く説明します。' : 'Ask for a short explanation based only on saved project records.'}</p>
          {pending ? <div className="luca-panel__pending" role="status"><i />{locale === 'ja' ? 'Lucaが記録を確認しています…' : 'Luca is reading the records…'}</div> : null}
          <div className="luca-panel__questions">
            {questions.map((question) => question.custom ? (
              <div key={question.id} className="luca-panel__custom">
                {!customOpen ? (
                  <button type="button" disabled={pending} onClick={() => setCustomOpen(true)}>{question.label[locale]}</button>
                ) : (
                  <form onSubmit={(event) => { event.preventDefault(); if (customText.trim()) ask(question.id, customText.trim()); }}>
                    <button type="button" className="luca-panel__custom-back" onClick={() => setCustomOpen(false)} aria-label={locale === 'ja' ? '定型質問に戻る' : 'Back to quick questions'}><ArrowLeft size={15} /></button>
                    <textarea
                      aria-label={locale === 'ja' ? 'Lucaへの質問' : 'Question for Luca'}
                      value={customText}
                      maxLength={2_000}
                      disabled={pending}
                      onChange={(event) => setCustomText(event.target.value)}
                      autoFocus
                    />
                    <button type="submit" disabled={pending || !customText.trim()} aria-label={locale === 'ja' ? '質問を送る' : 'Send question'}><Send size={15} /></button>
                  </form>
                )}
              </div>
            ) : (
              <button type="button" key={question.id} disabled={pending} onClick={() => ask(question.id)}>{question.label[locale]}</button>
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}
