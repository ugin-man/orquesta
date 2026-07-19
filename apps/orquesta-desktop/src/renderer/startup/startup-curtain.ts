export const STARTUP_MINIMUM_MS = 1400;
export const STARTUP_EXIT_MS = 300;
export const STARTUP_REDUCED_EXIT_MS = 160;
export const STARTUP_FALLBACK_MS = 6000;

export interface StartupCurtainController {
  markReady(): void;
  dispose(): void;
}

export function createStartupCurtainController(): StartupCurtainController {
  const curtain = document.getElementById('startup-curtain');
  if (!curtain) return { markReady() {}, dispose() {} };

  const startedAt = Date.now();
  const instant = new URLSearchParams(window.location.search).get('startup') === 'instant';
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  let exitTimer: ReturnType<typeof setTimeout> | null = null;
  let removalTimer: ReturnType<typeof setTimeout> | null = null;
  let readinessScheduled = false;
  let exited = false;

  const finish = () => curtain.remove();
  const beginExit = () => {
    if (exited) return;
    exited = true;
    clearTimeout(fallbackTimer);
    if (exitTimer) clearTimeout(exitTimer);
    if (instant) {
      finish();
      return;
    }
    curtain.classList.add('startup-curtain--exiting');
    removalTimer = setTimeout(finish, reducedMotion ? STARTUP_REDUCED_EXIT_MS : STARTUP_EXIT_MS);
  };
  const fallbackTimer = setTimeout(beginExit, STARTUP_FALLBACK_MS);

  return {
    markReady() {
      if (readinessScheduled || exited) return;
      readinessScheduled = true;
      const remaining = instant ? 0 : Math.max(0, STARTUP_MINIMUM_MS - (Date.now() - startedAt));
      if (remaining === 0) beginExit();
      else exitTimer = setTimeout(beginExit, remaining);
    },
    dispose() {
      clearTimeout(fallbackTimer);
      if (exitTimer) clearTimeout(exitTimer);
      if (removalTimer) clearTimeout(removalTimer);
    }
  };
}
