# Setup Locale Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep every Orquesta-owned initial-setup label in the selected Japanese or English locale.

**Architecture:** Add one setup-specific localization module keyed by locale and stable setup identifiers. Pass the existing renderer locale through the setup experience and organ scene, and keep repository state unchanged.

**Tech Stack:** React, TypeScript, Vitest, Playwright Electron

## Global Constraints

- Do not change setup execution, persistence, or phase ordering.
- Do not translate project names, paths, user input, or arbitrary error messages.
- English setup UI must not expose Japanese canonical phase or activity copy.
- Keep Japanese behavior available.

---

### Task 1: Localize the six-phase setup model

**Files:**
- Create: `apps/orquesta-desktop/src/renderer/features/setup/setup-localization.ts`
- Modify: `apps/orquesta-desktop/src/renderer/features/setup/setup-visual-state.ts`
- Modify: `apps/orquesta-desktop/tests/unit/setup-visual-state.test.ts`

**Interfaces:**
- Produces: `getSetupCopy(locale)`, `localizeSetupPhase(phase, locale)`, and `localizeSetupActivity(activity, locale)`.
- Changes: `createSetupVisualState(setup, reducedMotion, locale)`.

- [ ] Add an English test using Japanese canonical phase/activity input and verify the visual model contains English only.
- [ ] Run the focused test and observe the expected failure.
- [ ] Implement the setup dictionary and stable-ID localization.
- [ ] Run the focused test and verify it passes.

### Task 2: Pass locale through the visible setup experience

**Files:**
- Modify: `apps/orquesta-desktop/src/renderer/features/setup/InitialSetupExperience.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/features/setup/SetupOrganStage.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/features/setup/organ/SetupOrganScene.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/app/DesktopRendererApp.tsx`
- Modify: `apps/orquesta-desktop/tests/unit/initial-setup-experience.test.tsx`
- Modify: `apps/orquesta-desktop/tests/unit/setup-organ-stage.test.tsx`

**Interfaces:**
- `InitialSetupExperience({ setup, locale, onCancel })`
- `SetupOrganStage({ setup, locale })`
- `SetupOrganScene({ state, locale, active })`

- [ ] Add English component tests for labels, controls, progress text, organ semantics, and fallback copy.
- [ ] Run the focused tests and observe Japanese-copy failures.
- [ ] Replace hardcoded copy with `getSetupCopy(locale)` and pass locale from the app.
- [ ] Run the focused tests and verify Japanese and English cases pass.

### Task 3: Prove the real Electron English journey

**Files:**
- Modify: `apps/orquesta-desktop/tests/electron/initial-setup.spec.ts`

**Interfaces:**
- Consumes the existing `--lang=en-US` Electron fixture.

- [ ] Change the setup-progress assertions from Japanese to English and assert the visible setup container contains no Japanese characters.
- [ ] Run the initial-setup Electron spec and verify it passes.
- [ ] Run the focused unit tests and production build once.
- [ ] Commit the completed localization branch.
