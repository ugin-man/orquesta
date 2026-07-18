export interface WindowReadinessGate {
  markWindowReady(): void;
  markRendererReady(): void;
  forceReveal(): void;
  dispose(): void;
}

export function createWindowReadinessGate(
  reveal: () => void,
  fallbackMs = 6000,
  schedule: (callback: () => void, delay: number) => ReturnType<typeof setTimeout> = setTimeout,
  cancel: (timer: ReturnType<typeof setTimeout>) => void = clearTimeout
): WindowReadinessGate {
  let windowReady = false;
  let rendererReady = false;
  let revealed = false;
  const revealOnce = () => {
    if (revealed) return;
    revealed = true;
    cancel(timer);
    reveal();
  };
  const revealWhenReady = () => {
    if (windowReady && rendererReady) revealOnce();
  };
  const timer = schedule(revealOnce, fallbackMs);
  return {
    markWindowReady() { windowReady = true; revealWhenReady(); },
    markRendererReady() { rendererReady = true; revealWhenReady(); },
    forceReveal: revealOnce,
    dispose() { cancel(timer); }
  };
}
