# Orquesta Desktop Initial Setup Review Slice Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development for each implementation task and superpowers:verification-before-completion before claiming the review slice is ready.

**Goal:** Build a review-only initial setup screen that proves the approved visual direction without starting the setup engine or changing the existing Home experience.

**Architecture:** Extend the renderer snapshot with an optional setup state. A dedicated fixture supplies phase-three setup data, and `DesktopRendererApp` routes that state to an isolated setup feature before the normal Home/onboarding branches. The feature owns its component, styles, and raster assets so the current dirty Home work remains untouched except for one guarded render branch.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, Vite, Playwright, scoped CSS, project-bound PNG assets.

---

### Task 1: Add the setup UI state contract

**Files:**
- Modify: `apps/orquesta-desktop/src/contracts/orquesta-ui.ts`
- Test: `apps/orquesta-desktop/tests/unit/initial-setup-contract.test.ts`

- [ ] Write a failing contract test that builds a six-phase setup snapshot and checks the active phase, recent activity, and technical detail types.
- [ ] Run `npm test -- --run tests/unit/initial-setup-contract.test.ts` from `apps/orquesta-desktop` and confirm the failure is caused by the missing contract.
- [ ] Add `SetupUiSnapshot`, `SetupPhaseUiModel`, `SetupActivityUiModel`, and their narrow status unions.
- [ ] Add `setup?: SetupUiSnapshot | null` to `OrquestaUiSnapshot` so every existing producer remains compatible.
- [ ] Run the same test and confirm it passes.

### Task 2: Add the review fixture

**Files:**
- Create: `apps/orquesta-desktop/src/fixtures/setup-running.ts`
- Modify: `apps/orquesta-desktop/src/fixtures/index.ts`
- Test: `apps/orquesta-desktop/tests/unit/initial-setup-contract.test.ts`

- [ ] Extend the failing test to require a `setup-running` fixture with exactly six ordered phases and phase three active.
- [ ] Run the contract test and confirm it fails because the fixture is absent.
- [ ] Build the fixture by cloning the existing active project fixture and supplying review-only setup state.
- [ ] Register `setup-running` in the fixture catalog.
- [ ] Run the contract test and confirm it passes.

### Task 3: Create project-bound visual assets

**Files:**
- Create: `apps/orquesta-desktop/public/setup/pipe-organ-background.png`
- Create: `apps/orquesta-desktop/public/setup/setup-gear.png`

- [ ] Generate a warm-ivory concert pipe organ background based on the approved concept, with no logo, gears, text, UI, or fake controls.
- [ ] Generate one isolated dark metal gear on a flat chroma-key background.
- [ ] Copy both outputs into `public/setup` and remove the gear chroma key locally.
- [ ] Inspect the background at original detail and verify that it reads as a real pipe organ rather than the Orquesta logo.
- [ ] Validate that the gear has an alpha channel and transparent corners.

### Task 4: Build the dedicated setup screen

**Files:**
- Create: `apps/orquesta-desktop/src/renderer/features/setup/InitialSetupExperience.tsx`
- Create: `apps/orquesta-desktop/src/renderer/features/setup/initial-setup.css`
- Test: `apps/orquesta-desktop/tests/unit/initial-setup-experience.test.tsx`

- [ ] Write a failing component test that requires the current activity, current/next phase, all six phases, accessible progress, technical-detail disclosure, and cancel confirmation.
- [ ] Run `npm test -- --run tests/unit/initial-setup-experience.test.tsx` and confirm it fails because the component is missing.
- [ ] Implement the semantic screen from `SetupUiSnapshot`; do not hard-code phase data in JSX.
- [ ] Render the pipe organ as a subdued full-height background layer, the detail panel on the left, and six gear/phase rows on the right.
- [ ] Rotate only the active gear and disable continuous motion under `prefers-reduced-motion`.
- [ ] Mark complete, active, and waiting phases with text/icon/shape differences in addition to color.
- [ ] Implement technical-detail disclosure and a two-step cancel confirmation without wiring destructive behavior.
- [ ] Run the component test and confirm it passes.

### Task 5: Route setup state without altering Home

**Files:**
- Modify: `apps/orquesta-desktop/src/renderer/app/DesktopRendererApp.tsx`
- Test: `apps/orquesta-desktop/tests/unit/app.test.tsx`

- [ ] Add a failing app test that renders `MockOrquestaBridge('setup-running')`, expects the setup experience, and confirms Home navigation is absent.
- [ ] Run only that test and confirm the expected failure.
- [ ] Import `InitialSetupExperience` and return it when `snapshot.setup` is present and not complete.
- [ ] Keep the branch after snapshot loading and before the existing no-project/Home branches.
- [ ] Preserve the existing uncommitted `.home-right-rail` and workspace-dock changes exactly.
- [ ] Run the app test and the two setup tests.

### Task 6: Build and perform the first visual review gate

**Files:**
- Create: `design-qa.md`
- Create: `artifacts/setup-review/setup-running-1440x900.png`
- Create: `artifacts/setup-review/setup-running-1366x768.png`

- [ ] Run `npm run build` from `apps/orquesta-desktop`.
- [ ] Start the Vite preview and open `?fixture=setup-running&lang=ja&startup=instant`.
- [ ] Capture the setup screen at 1440×900 and 1366×768.
- [ ] Test technical-detail disclosure, cancel-confirmation open/close, and keyboard focus order.
- [ ] Check browser console errors once.
- [ ] Compare the approved source concept and the rendered screenshot together, recording fonts, spacing, colors, image quality, and copy in `design-qa.md`.
- [ ] Fix only actionable P0/P1/P2 differences, recapture once per real fix cycle, and record comparison history.
- [ ] Stop with the preview available for user review; do not implement the input flow or setup engine before approval.
