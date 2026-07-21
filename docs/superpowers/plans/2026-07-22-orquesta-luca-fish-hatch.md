# Orquesta Luca Fish Hatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an app-wide hatchable 3D goldfish form for Luca that swims only on Home, stays behind interactive UI, opens the existing Luca panel, and can be reset to an egg from Settings.

**Architecture:** Keep Luca's existing read-only question runtime unchanged. Add a renderer-only pet state machine, a lazily loaded Three.js layer, pure motion planning, and a short DOM/Three hatch ceremony. Persist only `egg` or `fish` in app-wide localStorage; treat `hatching` as transient.

**Tech Stack:** React 19, TypeScript, Three.js `0.185.1`, Vitest, Testing Library, Playwright Electron

## Global Constraints

- The persistent state is app-wide and is never stored in a project repository.
- Luca's prompt, read-only runtime, thread, answer format, and conversation history are unchanged.
- The fish renders only on Home and is layered below the map and all interactive widgets.
- The fish is a true 3D low-poly red goldfish with translucent fins; no downloaded GLB or Codex pet atlas is used.
- Device pixel ratio is capped at `1.5`, animation is capped at `30fps`, and rendering pauses outside Home or while the document is hidden.
- Reduced motion skips falling, wobbling, and autonomous swimming while preserving Luca access.
- Japanese and English copy must ship together.
- Verification is limited to focused unit/component tests, one production build, one Electron acceptance path, and one user visual review.

---

## File Structure

- `apps/orquesta-desktop/src/renderer/features/luca/luca-pet-preference.ts`: validated app-wide persistent state.
- `apps/orquesta-desktop/src/renderer/features/luca/luca-fish-motion.ts`: pure bounds, route, speed, and orientation calculations.
- `apps/orquesta-desktop/src/renderer/features/luca/LucaFishModel.ts`: Three.js geometry, materials, animation handles, and disposal.
- `apps/orquesta-desktop/src/renderer/features/luca/LucaFishLayer.tsx`: lazy Three.js canvas, DOM hit target, lifecycle, pointer/focus behavior, and fallback.
- `apps/orquesta-desktop/src/renderer/features/luca/LucaHatchCeremony.tsx`: transient egg fall, water entry, cracking, and fish reveal.
- `apps/orquesta-desktop/src/renderer/features/luca/LucaPanel.tsx`: Home-only hatch action.
- `apps/orquesta-desktop/src/renderer/features/luca/luca.css`: Luca pet, hatch, panel action, and fallback styling.
- `apps/orquesta-desktop/src/renderer/features/settings/SettingsWorkspace.tsx`: app-wide Luca form status and reset.
- `apps/orquesta-desktop/src/renderer/features/navigation/WorkspaceSurface.tsx`: pass Settings callbacks and state.
- `apps/orquesta-desktop/src/renderer/app/DesktopRendererApp.tsx`: own pet state and connect hatch, fish, panel, and reset.
- `apps/orquesta-desktop/tests/unit/luca-pet-preference.test.ts`: persistence contract.
- `apps/orquesta-desktop/tests/unit/luca-fish-motion.test.ts`: movement bounds and smoothing.
- `apps/orquesta-desktop/tests/unit/luca-fish-model.test.ts`: geometry/material/disposal contract.
- `apps/orquesta-desktop/tests/unit/luca-panel.test.tsx`: hatch action visibility and invocation.
- `apps/orquesta-desktop/tests/unit/app.test.tsx`: Home integration and reset wiring.
- `apps/orquesta-desktop/tests/electron/luca-fish-hatch.spec.ts`: one end-to-end hatch/project-switch/reset acceptance path.

---

### Task 1: App-wide Luca pet preference

**Files:**
- Create: `apps/orquesta-desktop/src/renderer/features/luca/luca-pet-preference.ts`
- Create: `apps/orquesta-desktop/tests/unit/luca-pet-preference.test.ts`

**Interfaces:**
- Produces: `LucaPetMode`, `LucaPetVisualState`, `LUCA_PET_STORAGE_KEY`, `readLucaPetMode(storage)`, `writeLucaPetMode(storage, mode)`.
- Consumes: browser `Storage`.

- [ ] **Step 1: Write the failing persistence tests**

```ts
import { describe, expect, test } from 'vitest';
import { LUCA_PET_STORAGE_KEY, readLucaPetMode, writeLucaPetMode } from '../../src/renderer/features/luca/luca-pet-preference';

describe('Luca pet preference', () => {
  test('defaults invalid or missing values to egg', () => {
    localStorage.clear();
    expect(readLucaPetMode(localStorage)).toBe('egg');
    localStorage.setItem(LUCA_PET_STORAGE_KEY, 'hatching');
    expect(readLucaPetMode(localStorage)).toBe('egg');
  });

  test('persists fish globally without a project id', () => {
    writeLucaPetMode(localStorage, 'fish');
    expect(localStorage.getItem(LUCA_PET_STORAGE_KEY)).toBe('fish');
    expect(readLucaPetMode(localStorage)).toBe('fish');
  });
});
```

- [ ] **Step 2: Run the test and verify the missing module failure**

Run: `npm --prefix apps/orquesta-desktop run test -- tests/unit/luca-pet-preference.test.ts`

Expected: FAIL because `luca-pet-preference.ts` does not exist.

- [ ] **Step 3: Implement the validated storage contract**

```ts
export type LucaPetMode = 'egg' | 'fish';
export type LucaPetVisualState = LucaPetMode | 'hatching';
export const LUCA_PET_STORAGE_KEY = 'orquesta.desktop.luca-pet.v1';

export function readLucaPetMode(storage: Pick<Storage, 'getItem'>): LucaPetMode {
  return storage.getItem(LUCA_PET_STORAGE_KEY) === 'fish' ? 'fish' : 'egg';
}

export function writeLucaPetMode(storage: Pick<Storage, 'setItem'>, mode: LucaPetMode): void {
  storage.setItem(LUCA_PET_STORAGE_KEY, mode);
}
```

- [ ] **Step 4: Run the focused test**

Run: `npm --prefix apps/orquesta-desktop run test -- tests/unit/luca-pet-preference.test.ts`

Expected: 2 tests PASS.

- [ ] **Step 5: Commit the persistence unit**

```bash
git add apps/orquesta-desktop/src/renderer/features/luca/luca-pet-preference.ts apps/orquesta-desktop/tests/unit/luca-pet-preference.test.ts
git commit -m "feat(desktop): persist Luca pet form"
```

### Task 2: Home hatch action and Settings reset

**Files:**
- Modify: `apps/orquesta-desktop/src/renderer/features/luca/LucaPanel.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/features/luca/luca.css`
- Modify: `apps/orquesta-desktop/src/renderer/features/settings/SettingsWorkspace.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/features/navigation/WorkspaceSurface.tsx`
- Modify: `apps/orquesta-desktop/tests/unit/luca-panel.test.tsx`
- Modify: `apps/orquesta-desktop/tests/unit/app.test.tsx`

**Interfaces:**
- Consumes: `LucaPetMode` from Task 1.
- Produces: `LucaPanel` props `petMode?: LucaPetMode`, `onHatch?(): void`; `SettingsWorkspace` props `lucaPetMode: LucaPetMode`, `onResetLucaPet(): void`.

- [ ] **Step 1: Add failing Luca panel tests**

```tsx
test('offers hatching only from the Home egg panel', async () => {
  const onHatch = vi.fn();
  const { rerender } = render(<LucaPanel context={{ kind: 'home' }} locale="ja" state={{ kind: 'idle' }} petMode="egg" onHatch={onHatch} onAsk={vi.fn()} onClose={vi.fn()} />);
  await userEvent.click(screen.getByRole('button', { name: 'Lucaを孵化させる' }));
  expect(onHatch).toHaveBeenCalledOnce();
  rerender(<LucaPanel context={{ kind: 'task', id: 'T001' }} locale="ja" state={{ kind: 'idle' }} petMode="egg" onHatch={onHatch} onAsk={vi.fn()} onClose={vi.fn()} />);
  expect(screen.queryByRole('button', { name: 'Lucaを孵化させる' })).toBeNull();
});
```

- [ ] **Step 2: Run the panel test and verify the prop/type failure**

Run: `npm --prefix apps/orquesta-desktop run test -- tests/unit/luca-panel.test.tsx`

Expected: FAIL because the pet props do not exist.

- [ ] **Step 3: Add the Home-only action row**

Implement these props and condition in `LucaPanel.tsx`:

```tsx
petMode?: LucaPetMode;
onHatch?(): void;

const showHatch = context.kind === 'home' && petMode === 'egg' && Boolean(onHatch);

<div className="luca-panel__primary-actions">
  {customQuestionButton}
  {showHatch ? <button type="button" className="luca-panel__hatch" disabled={pending} onClick={onHatch}>{locale === 'ja' ? 'Lucaを孵化させる' : 'Hatch Luca'}</button> : null}
</div>
```

Keep the existing custom form behavior after the action opens. Do not duplicate the custom question definition.

- [ ] **Step 4: Add failing Settings integration assertions**

Extend `app.test.tsx` so fish mode shows `Lucaを卵に戻す`, clicking it removes the fish entry, restores the Home Luca trigger, and does not call any conversation deletion bridge method.

- [ ] **Step 5: Implement the Settings props and bilingual copy**

Add to `SettingsWorkspaceProps`:

```ts
lucaPetMode: LucaPetMode;
onResetLucaPet(): void;
```

Add the Display row with the exact Japanese and English copy from the design only when `lucaPetMode === 'fish'`. Omit the whole Luca form row in egg mode. Pass the props through `WorkspaceSurface` without creating a second state owner.

- [ ] **Step 6: Run focused UI tests**

Run: `npm --prefix apps/orquesta-desktop run test -- tests/unit/luca-panel.test.tsx tests/unit/app.test.tsx`

Expected: all selected tests PASS.

- [ ] **Step 7: Commit the controls**

```bash
git add apps/orquesta-desktop/src/renderer/features/luca/LucaPanel.tsx apps/orquesta-desktop/src/renderer/features/luca/luca.css apps/orquesta-desktop/src/renderer/features/settings/SettingsWorkspace.tsx apps/orquesta-desktop/src/renderer/features/navigation/WorkspaceSurface.tsx apps/orquesta-desktop/tests/unit/luca-panel.test.tsx apps/orquesta-desktop/tests/unit/app.test.tsx
git commit -m "feat(desktop): add Luca hatch and reset controls"
```

### Task 3: Low-poly Three.js Luca model

**Files:**
- Modify: `apps/orquesta-desktop/package.json`
- Modify: `apps/orquesta-desktop/package-lock.json`
- Create: `apps/orquesta-desktop/src/renderer/features/luca/LucaFishModel.ts`
- Create: `apps/orquesta-desktop/tests/unit/luca-fish-model.test.ts`

**Interfaces:**
- Produces: `createLucaFishModel(THREE): LucaFishModelHandle` and `disposeLucaFishModel(handle)`.
- `LucaFishModelHandle` contains `root`, `tailPivot`, `leftFinPivot`, `rightFinPivot`, `materials`, and `geometries`.

- [ ] **Step 1: Install the exact Three.js version**

Run: `npm --prefix apps/orquesta-desktop install three@0.185.1 --save`

Expected: `package.json` contains `"three": "^0.185.1"` and the desktop lockfile updates.

- [ ] **Step 2: Write the failing model contract test**

```ts
test('builds a red flat-shaded fish with translucent fins', async () => {
  const THREE = await import('three');
  const fish = createLucaFishModel(THREE);
  expect(fish.root.name).toBe('LucaFish');
  expect(fish.tailPivot.children.length).toBeGreaterThan(0);
  expect(fish.materials.some((material) => material.transparent && material.opacity < 0.7)).toBe(true);
  expect(fish.materials.some((material) => material.flatShading)).toBe(true);
  disposeLucaFishModel(fish);
  expect(fish.geometries.every((geometry) => geometry.dispose)).toBe(true);
});
```

- [ ] **Step 3: Run the model test and verify failure**

Run: `npm --prefix apps/orquesta-desktop run test -- tests/unit/luca-fish-model.test.ts`

Expected: FAIL because `LucaFishModel.ts` does not exist.

- [ ] **Step 4: Implement the procedural model**

Use `SphereGeometry(1, 8, 6)` scaled for the body, small sphere eyes, and custom `BufferGeometry` triangles for tail and fins. Use `MeshStandardMaterial` with flat shading for the body and `DoubleSide`, `transparent: true`, `depthWrite: false` for fins. Keep the body length under four Three.js world units and return all disposable resources in the handle.

- [ ] **Step 5: Run the model test and TypeScript build**

Run: `npm --prefix apps/orquesta-desktop run test -- tests/unit/luca-fish-model.test.ts && npm --prefix apps/orquesta-desktop run build`

Expected: focused test PASS and renderer production build succeeds.

- [ ] **Step 6: Commit the model**

```bash
git add apps/orquesta-desktop/package.json apps/orquesta-desktop/package-lock.json apps/orquesta-desktop/src/renderer/features/luca/LucaFishModel.ts apps/orquesta-desktop/tests/unit/luca-fish-model.test.ts
git commit -m "feat(desktop): build low-poly Luca fish"
```

### Task 4: Deterministic safe movement

**Files:**
- Create: `apps/orquesta-desktop/src/renderer/features/luca/luca-fish-motion.ts`
- Create: `apps/orquesta-desktop/tests/unit/luca-fish-motion.test.ts`

**Interfaces:**
- Produces: `FishBounds`, `FishPose`, `FishRoute`, `createFishBounds(width, height)`, `createFishRoute(start, bounds, random)`, `sampleFishRoute(route, progress)`, `pointerSpeedFactor(distance)`.
- Consumes: injected `random(): number` so tests never depend on `Math.random`.

- [ ] **Step 1: Write failing bounds and interpolation tests**

```ts
test('keeps every route endpoint at least 48px inside Home', () => {
  const bounds = createFishBounds(1440, 900);
  const route = createFishRoute({ x: 720, y: 450, depth: 0 }, bounds, () => 0.99);
  expect(route.end.x).toBeLessThanOrEqual(1392);
  expect(route.end.y).toBeLessThanOrEqual(852);
  expect(route.end.x).toBeGreaterThanOrEqual(48);
  expect(route.durationMs).toBeGreaterThanOrEqual(4500);
  expect(route.durationMs).toBeLessThanOrEqual(8000);
});

test('slows near the pointer and stops on capture', () => {
  expect(pointerSpeedFactor(120)).toBe(1);
  expect(pointerSpeedFactor(45)).toBeGreaterThan(0);
  expect(pointerSpeedFactor(0)).toBe(0);
});
```

- [ ] **Step 2: Run the motion test and verify failure**

Run: `npm --prefix apps/orquesta-desktop run test -- tests/unit/luca-fish-motion.test.ts`

Expected: FAIL because the motion module does not exist.

- [ ] **Step 3: Implement pure route planning**

Use cubic Bézier sampling with clamped start/end/control points. Set `safeInset = Math.min(48, width / 4, height / 4)`, choose duration within `4500..8000`, depth within `-0.35..0.35`, and return a tangent vector with each sample for Three.js orientation.

- [ ] **Step 4: Run the focused test**

Run: `npm --prefix apps/orquesta-desktop run test -- tests/unit/luca-fish-motion.test.ts`

Expected: all movement tests PASS.

- [ ] **Step 5: Commit the motion unit**

```bash
git add apps/orquesta-desktop/src/renderer/features/luca/luca-fish-motion.ts apps/orquesta-desktop/tests/unit/luca-fish-motion.test.ts
git commit -m "feat(desktop): plan Luca fish movement"
```

### Task 5: Home fish rendering and interaction layer

**Files:**
- Create: `apps/orquesta-desktop/src/renderer/features/luca/LucaFishLayer.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/features/luca/luca.css`
- Modify: `apps/orquesta-desktop/src/renderer/styles/global.css`
- Modify: `apps/orquesta-desktop/src/renderer/app/DesktopRendererApp.tsx`
- Modify: `apps/orquesta-desktop/tests/unit/app.test.tsx`

**Interfaces:**
- Consumes: model functions from Task 3 and motion functions from Task 4.
- Produces: `LucaFishLayer({ active, reducedMotion, panelOpen, onOpenLuca, onWebGlFailure })`.

- [ ] **Step 1: Add failing Home integration tests**

Add assertions that fish mode renders `button[name="Lucaに聞く"]` inside the fish layer on Home, removes the fixed `.luca-home-trigger`, calls the same Home Luca opener when clicked, and removes the fish layer when Settings is selected.

- [ ] **Step 2: Run the Home integration test and verify failure**

Run: `npm --prefix apps/orquesta-desktop run test -- tests/unit/app.test.tsx`

Expected: FAIL because `LucaFishLayer` is not wired.

- [ ] **Step 3: Implement the lazy transparent Three.js layer**

`LucaFishLayer` must:

```ts
const THREE = await import('three');
const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
```

Create one scene, orthographic camera, ambient light, directional light, and one fish. Update at most once every `1000 / 30` milliseconds. Project the fish position into screen coordinates and update a `44x44` DOM button. Pause on hover, focus, open panel, hidden document, inactive workspace, and reduced motion. Dispose every resource and observer on unmount.

- [ ] **Step 4: Establish the fixed layer order**

Add `.luca-fish-layer { position: fixed; inset: 0; z-index: 1; pointer-events: none; }`, give its hit button pointer events, and change `.map-viewport` to `z-index: 2`. Do not change widget, dock, composer, or overlay z-index values.

- [ ] **Step 5: Add the non-WebGL fallback**

If dynamic import or renderer creation fails, render a fixed red fish-shaped DOM button with the same accessible name and `onOpenLuca`. Do not reset `fish` mode automatically.

- [ ] **Step 6: Run focused tests and build**

Run: `npm --prefix apps/orquesta-desktop run test -- tests/unit/app.test.tsx tests/unit/luca-fish-motion.test.ts tests/unit/luca-fish-model.test.ts && npm --prefix apps/orquesta-desktop run build`

Expected: focused tests PASS and build succeeds.

- [ ] **Step 7: Commit the live fish layer**

```bash
git add apps/orquesta-desktop/src/renderer/features/luca/LucaFishLayer.tsx apps/orquesta-desktop/src/renderer/features/luca/luca.css apps/orquesta-desktop/src/renderer/styles/global.css apps/orquesta-desktop/src/renderer/app/DesktopRendererApp.tsx apps/orquesta-desktop/tests/unit/app.test.tsx
git commit -m "feat(desktop): let Luca swim across Home"
```

### Task 6: Hatch ceremony and state integration

**Files:**
- Create: `apps/orquesta-desktop/src/renderer/features/luca/LucaHatchCeremony.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/features/luca/luca.css`
- Modify: `apps/orquesta-desktop/src/renderer/app/DesktopRendererApp.tsx`
- Modify: `apps/orquesta-desktop/tests/unit/app.test.tsx`

**Interfaces:**
- Produces: `LucaHatchCeremony({ reducedMotion, onComplete, onCancel })`.
- Consumes: transient `LucaPetVisualState` owned by `DesktopRendererApp`.

- [ ] **Step 1: Add failing ceremony state tests**

Use fake timers to assert that clicking `Lucaを孵化させる` closes the panel, shows a dialog-like status with `Lucaが孵化しています`, does not persist `fish` before completion, and persists `fish` after `3200ms`. Add a reduced-motion case that completes after `250ms`.

- [ ] **Step 2: Run the app test and verify failure**

Run: `npm --prefix apps/orquesta-desktop run test -- tests/unit/app.test.tsx`

Expected: FAIL because the ceremony and state transitions do not exist.

- [ ] **Step 3: Implement the seven-stage ceremony**

Render a fixed presentation layer with `aria-live="polite"`, an egg element, one ripple, two shell halves, and a fish reveal host. Drive named CSS classes from timers at `250`, `650`, `1250`, `1750`, `2350`, `2850`, and `3200ms`. Clear every timer on unmount. In reduced motion, use one `250ms` fade and skip spatial movement.

- [ ] **Step 4: Wire completion-only persistence**

In `DesktopRendererApp`:

```ts
const [lucaPetMode, setLucaPetMode] = useState(() => readLucaPetMode(window.localStorage));
const [lucaPetVisualState, setLucaPetVisualState] = useState<LucaPetVisualState>(lucaPetMode);

const finishLucaHatch = () => {
  writeLucaPetMode(window.localStorage, 'fish');
  setLucaPetMode('fish');
  setLucaPetVisualState('fish');
};
```

Reset writes `egg`, updates both states, and leaves Luca messages/thread untouched.

- [ ] **Step 5: Run focused tests**

Run: `npm --prefix apps/orquesta-desktop run test -- tests/unit/luca-pet-preference.test.ts tests/unit/luca-panel.test.tsx tests/unit/app.test.tsx`

Expected: all selected tests PASS.

- [ ] **Step 6: Commit the hatch flow**

```bash
git add apps/orquesta-desktop/src/renderer/features/luca/LucaHatchCeremony.tsx apps/orquesta-desktop/src/renderer/features/luca/luca.css apps/orquesta-desktop/src/renderer/app/DesktopRendererApp.tsx apps/orquesta-desktop/tests/unit/app.test.tsx
git commit -m "feat(desktop): hatch Luca into a goldfish"
```

### Task 7: Electron acceptance and user review build

**Files:**
- Create: `apps/orquesta-desktop/tests/electron/luca-fish-hatch.spec.ts`
- Modify: `apps/orquesta-desktop/tests/electron/fixtures/desktop-launch.ts` only if a storage preload hook is required by the existing fixture.

**Interfaces:**
- Consumes: completed renderer feature.
- Produces: one deterministic Electron acceptance path and a current Desktop build for user review.

- [ ] **Step 1: Write the Electron acceptance test**

The single test must start from egg mode, open Home Luca, hatch, wait for the fish button, switch project if the fixture exposes a second project, verify fish remains, open Settings, reset to egg, return Home, and verify the fixed Luca trigger returns. It must not inspect animation pixels or rerun unrelated map stability tests.

- [ ] **Step 2: Build the Desktop host and renderer**

Run: `npm --prefix apps/orquesta-desktop run build:desktop`

Expected: renderer and Electron host builds succeed.

- [ ] **Step 3: Run focused unit and Electron verification**

Run: `npm --prefix apps/orquesta-desktop run test -- tests/unit/luca-pet-preference.test.ts tests/unit/luca-fish-motion.test.ts tests/unit/luca-fish-model.test.ts tests/unit/luca-panel.test.tsx tests/unit/app.test.tsx`

Expected: selected unit/component tests PASS.

Run: `npm --prefix apps/orquesta-desktop exec playwright test --config=playwright.electron.config.ts tests/electron/luca-fish-hatch.spec.ts`

Expected: 1 Electron test PASS.

- [ ] **Step 4: Run repository checks relevant to the change**

Run: `git diff --check && git status --short`

Expected: no whitespace errors; only intentional feature files are modified.

- [ ] **Step 5: Commit acceptance coverage**

```bash
git add apps/orquesta-desktop/tests/electron/luca-fish-hatch.spec.ts apps/orquesta-desktop/tests/electron/fixtures/desktop-launch.ts
git commit -m "test(desktop): accept Luca fish hatch flow"
```

- [ ] **Step 6: Launch the current Desktop build for user review**

Run the built Electron application from the feature worktree. Ask the user to inspect only the 3D body, translucent fins, fish size, hatch timing, swimming distraction, occlusion behind controls, hover pause, click-to-open, and Settings reset.

Expected: the user can review the actual Desktop rather than a browser proxy.
