import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { HOME_TUTORIAL_STEPS } from './home-tutorial-model';
import { findTutorialTargetElements, measureTutorialTargets, type TutorialTargetRect } from './home-tutorial-targets';
import './home-tutorial.css';

type HomeTutorialOverlayProps = {
  stepIndex: number;
  locale: 'ja' | 'en';
  reducedMotion: boolean;
  onBack: () => void;
  onNext: () => void;
  onSkip: () => void;
};

type Measurement = {
  stepIndex: number;
  rects: TutorialTargetRect[];
};

const labels = {
  ja: { back: '戻る', next: '次へ', complete: '完了', skip: 'スキップ' },
  en: { back: 'Back', next: 'Next', complete: 'Complete', skip: 'Skip' }
} as const;

function cardPosition(rects: readonly TutorialTargetRect[]): React.CSSProperties {
  const margin = 28;
  const gap = 24;
  const cardWidth = Math.min(380, Math.max(300, window.innerWidth - margin * 2));
  const cardHeight = 310;
  const left = Math.min(...rects.map((rect) => rect.left));
  const top = Math.min(...rects.map((rect) => rect.top));
  const right = Math.max(...rects.map((rect) => rect.left + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.top + rect.height));
  const spaces = [
    { side: 'right', value: window.innerWidth - right },
    { side: 'left', value: left },
    { side: 'bottom', value: window.innerHeight - bottom },
    { side: 'top', value: top }
  ].sort((a, b) => b.value - a.value);
  const preferred = spaces.find((space) => (
    space.side === 'left' || space.side === 'right'
      ? space.value >= cardWidth + gap + margin
      : space.value >= cardHeight + gap + margin
  )) ?? spaces[0]!;
  const clampLeft = (value: number) => Math.max(margin, Math.min(value, window.innerWidth - cardWidth - margin));
  const clampTop = (value: number) => Math.max(margin, Math.min(value, window.innerHeight - cardHeight - margin));

  if (preferred.side === 'left') {
    const cardTop = clampTop(top);
    return { width: cardWidth, left: clampLeft(left - cardWidth - gap), top: cardTop, maxHeight: window.innerHeight - cardTop - margin };
  }
  if (preferred.side === 'right') {
    const cardTop = clampTop(top);
    return { width: cardWidth, left: clampLeft(right + gap), top: cardTop, maxHeight: window.innerHeight - cardTop - margin };
  }
  if (preferred.side === 'top') {
    return {
      width: cardWidth,
      left: clampLeft(left),
      bottom: Math.max(margin, window.innerHeight - top + gap),
      maxHeight: Math.max(180, top - gap - margin)
    };
  }
  const cardTop = Math.max(margin, bottom + gap);
  return { width: cardWidth, left: clampLeft(left), top: cardTop, maxHeight: Math.max(180, window.innerHeight - cardTop - margin) };
}

export function HomeTutorialOverlay({
  stepIndex,
  locale,
  reducedMotion,
  onBack,
  onNext,
  onSkip
}: HomeTutorialOverlayProps) {
  const step = HOME_TUTORIAL_STEPS[stepIndex] ?? HOME_TUTORIAL_STEPS[0];
  const copy = step.copy[locale];
  const text = labels[locale];
  const cardRef = useRef<HTMLDivElement>(null);
  const skippedMissingStepRef = useRef<number | null>(null);
  const maskId = `home-tutorial-mask-${useId().replace(/:/g, '')}`;
  const [measurement, setMeasurement] = useState<Measurement>({ stepIndex: -1, rects: [] });

  useLayoutEffect(() => {
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        setMeasurement({ stepIndex, rects: measureTutorialTargets(document, step.targetIds) });
      });
    };
    measure();
    window.addEventListener('resize', measure);

    const elements = findTutorialTargetElements(document, step.targetIds);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    elements.forEach((element) => observer?.observe(element));
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, [step.targetIds, stepIndex]);

  useEffect(() => {
    if (measurement.stepIndex !== stepIndex || measurement.rects.length > 0) return;
    if (skippedMissingStepRef.current === stepIndex) return;
    skippedMissingStepRef.current = stepIndex;
    onNext();
  }, [measurement, onNext, stepIndex]);

  useEffect(() => {
    if (measurement.stepIndex === stepIndex && measurement.rects.length > 0) cardRef.current?.focus();
  }, [measurement, stepIndex]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onSkip();
        return;
      }
      if (event.key === 'ArrowLeft' && stepIndex > 0) {
        event.preventDefault();
        onBack();
        return;
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        onNext();
        return;
      }
      if (event.key !== 'Tab' || !cardRef.current) return;

      const focusable = Array.from(cardRef.current.querySelectorAll<HTMLElement>('button:not(:disabled)'));
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === cardRef.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [onBack, onNext, onSkip, stepIndex]);

  const positionedCard = useMemo(
    () => measurement.rects.length > 0 ? cardPosition(measurement.rects) : undefined,
    [measurement]
  );

  if (measurement.stepIndex !== stepIndex || measurement.rects.length === 0) return null;

  return createPortal(
    <div className={`home-tutorial-overlay${reducedMotion ? ' home-tutorial-overlay--reduced-motion' : ''}`}>
      <svg className="home-tutorial-overlay__mask" width="100%" height="100%" aria-hidden="true">
        <defs>
          <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="100%" height="100%">
            <rect x="0" y="0" width="100%" height="100%" fill="white" />
            {measurement.rects.map((rect) => (
              <rect
                key={`hole-${rect.id}`}
                data-testid="tutorial-hole"
                x={rect.left - 8}
                y={rect.top - 8}
                width={rect.width + 16}
                height={rect.height + 16}
                rx="16"
                fill="black"
              />
            ))}
          </mask>
        </defs>
        <rect className="home-tutorial-overlay__shade" width="100%" height="100%" mask={`url(#${maskId})`} />
        {measurement.rects.map((rect) => (
          <rect
            key={`outline-${rect.id}`}
            className="home-tutorial-overlay__outline"
            x={rect.left - 8}
            y={rect.top - 8}
            width={rect.width + 16}
            height={rect.height + 16}
            rx="16"
          />
        ))}
      </svg>

      <div
        ref={cardRef}
        className="home-tutorial-card"
        style={positionedCard}
        role="dialog"
        aria-modal="true"
        aria-labelledby="home-tutorial-title"
        aria-describedby="home-tutorial-body"
        tabIndex={-1}
      >
        <div className="home-tutorial-card__meta">
          <span>{stepIndex + 1} / {HOME_TUTORIAL_STEPS.length}</span>
          <button type="button" className="home-tutorial-card__skip" onClick={onSkip}>{text.skip}</button>
        </div>
        <h2 id="home-tutorial-title">{copy.title}</h2>
        <p id="home-tutorial-body">{copy.body}</p>
        {copy.points && (
          <ul>
            {copy.points.map((point) => <li key={point}>{point}</li>)}
          </ul>
        )}
        <div className="home-tutorial-card__actions">
          <button type="button" onClick={onBack} disabled={stepIndex === 0}>{text.back}</button>
          <button type="button" className="home-tutorial-card__primary" onClick={onNext}>
            {stepIndex === HOME_TUTORIAL_STEPS.length - 1 ? text.complete : text.next}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
