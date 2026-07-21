# Orquesta Six-Phase Setup Organ Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect Orquesta Desktop's intake, six real setup phases, the V11.3 pipe-organ visualization, restart-safe progress, specialist provisioning, and the final Home transition into one production flow.

**Architecture:** The canonical CommonJS setup engine owns durable phase state and delegates each phase to an idempotent handler. Electron Core starts or resumes one runner per project and continues to use the existing specialist provisioner for real Codex threads. The Renderer projects `SetupUiSnapshot` into a production left rail and a lazy-loaded React Three Fiber scene; it never advances phases with a timer.

**Tech Stack:** Node.js 22 CommonJS core, Electron 43 utility process, React 19, TypeScript 5.7, Vitest 4, Node test runner, Three.js 0.185.1, React Three Fiber 9.6.1, Playwright Electron.

## Global Constraints

- Final verification target is Electron Desktop, not the browser preview.
- Keep the left six-phase list, current activity, progress, and short log; remove every demo control from the source library.
- Do not import `App.tsx`, `demoSetupState.ts`, the review query-string behavior, or the legacy SVG CSS.
- Renderer animation must be derived from canonical state and must not mutate setup progress.
- `orchestrator`, `user-support`, and `orquesta-admin` are created in Phase 3, not at setup start.
- A successful Phase 5 may activate Phase 6 but may not mark the setup completed.
- Only Phase 6 validation may write `status: "completed"` and `completed_at`.
- New production lines require user approval; ordinary specialist roles and members do not.
- Setup state writes after start are atomic and use `current_phase_id`; `current_phase` remains read-only compatibility input.
- Previous completed mechanisms continue moving; a blocked current mechanism stops while earlier mechanisms remain active.
- No automatic audio.
- Respect `prefers-reduced-motion`; release the WebGL canvas after setup completion.
- Run focused tests per task, one final Desktop acceptance run, and one visual comparison pass. Do not repeat full Desktop stress checks after every small edit.

---

### Task 1: Add canonical phase-state transitions

**Files:**
- Create: `orquesta/scripts/setup-state.js`
- Create: `orquesta/scripts/setup-state.test.js`
- Modify: `orquesta/scripts/setup-engine.js`
- Modify: `orquesta/scripts/setup-engine.test.js`

**Interfaces:**
- Produces: `createSetupState({ setupId, projectId, draft, now })`
- Produces: `activatePhase(state, phaseId, activity, now)`
- Produces: `completePhase(state, phaseId, activity, now)`
- Produces: `blockPhase(state, phaseId, issue, activity, now)`
- Produces: `completeSetup(state, activity, now)`
- Produces: `firstIncompletePhase(state)`
- Consumes: the existing six `PHASES` definitions moved out of `setup-engine.js`.

- [ ] **Step 1: Write failing transition tests**

Add tests that assert:

```js
const state = createSetupState({ setupId: "SETUP-1", projectId: "repo-1", draft, now: NOW });
assert.equal(state.schema_version, 3);
assert.equal(state.current_phase_id, "environment");
assert.deepEqual(state.phases.map(({ status }) => status), ["active", "waiting", "waiting", "waiting", "waiting", "waiting"]);

const phase2 = activatePhase(completePhase(state, "environment", doneActivity, NOW), "understanding", activeActivity, LATER);
assert.deepEqual(phase2.phases.map(({ status }) => status), ["complete", "active", "waiting", "waiting", "waiting", "waiting"]);

const blocked = blockPhase(phase2, "understanding", { code: "README_UNAVAILABLE", message: "...", retryable: true }, failedActivity, LATER);
assert.equal(blocked.status, "blocked");
assert.equal(blocked.phases[1].status, "blocked");
assert.equal(firstIncompletePhase(blocked), "understanding");
```

Also change the setup-engine start test so `agents.json` is empty at start and the state has only Phase 1 active.

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
node --test orquesta/scripts/setup-state.test.js orquesta/scripts/setup-engine.test.js
```

Expected: FAIL because `setup-state.js` does not exist and start still writes the three foundation agents.

- [ ] **Step 3: Implement state transitions and a minimal start bundle**

Move the phase constants and initial state builder into `setup-state.js`. Enforce one active or blocked phase, bounded recent activities, phase timestamps, attempts, and completion only from `completeSetup()`.

Change `SetupEngine.start()` to write:

```js
state/agents.json       { version: 1, agents: [] }
state/tasks.json        { version: 1, tasks: [] }
state/roles.json        { schema_version: 1, organization_revision: 0, roles: [] }
state/organization.json explicit empty revision 0 state
state/sessions.json     { version: 1, sessions: [] }
```

Do not call `createFoundationStateBundle()` during start.

- [ ] **Step 4: Run tests and verify GREEN**

Run the same command. Expected: all setup-state and setup-engine tests pass.

- [ ] **Step 5: Commit**

```powershell
git add orquesta/scripts/setup-state.js orquesta/scripts/setup-state.test.js orquesta/scripts/setup-engine.js orquesta/scripts/setup-engine.test.js
git commit -m "feat: add durable six-phase setup state"
```

### Task 2: Implement environment, understanding, foundation, and planning handlers

**Files:**
- Create: `orquesta/scripts/setup-phase-handlers.js`
- Create: `orquesta/scripts/setup-phase-handlers.test.js`
- Modify: `orquesta/scripts/adaptive-setup-state.js`
- Test: `orquesta/scripts/adaptive-setup-state.test.js`

**Interfaces:**
- Consumes: `{ rootPath, setupState, now }`.
- Produces: `createDefaultPhaseHandlers(options)` returning handlers keyed by `environment`, `understanding`, `foundation`, `planning`, `specialists`, `operation`.
- Produces from each handler: `{ activity, checkpointRef, output }` or throws `SetupBlockedError`.
- Uses: `createFoundationStateBundle`, `createAdaptiveSpecialistPlan`, and `prepareProvisioningBatch`.

- [ ] **Step 1: Write failing handler tests**

Create real temporary repositories and assert:

```js
await handlers.environment(context);
assert.equal((await json("setup/checkpoints/environment.json")).status, "complete");

const understanding = await handlers.understanding(context);
assert.equal(understanding.output.goal, draft.description);
assert.ok(understanding.output.evidence.some(({ path }) => path === "README.md"));
assert.deepEqual((await json("project/project_understanding.json")).stack, ["node", "react"]);

await handlers.foundation(context);
assert.deepEqual((await json("state/agents.json")).agents.map(({ agent_id }) => agent_id).sort(), ["orchestrator", "orquesta-admin", "user-support"]);

await handlers.planning(context);
assert.ok((await json("project/completion_map.json")).tasks.length >= 1);
assert.equal((await json("setup/specialist_plan.json")).schema_version, 2);
```

Include idempotency assertions: running foundation and planning twice does not duplicate agents, tasks, roles, or increment organization revision twice.

- [ ] **Step 2: Run tests and verify RED**

```powershell
node --test orquesta/scripts/setup-phase-handlers.test.js
```

Expected: FAIL because the handler module is missing.

- [ ] **Step 3: Implement bounded project inspection**

The understanding handler may inspect only:

- root `README*`
- `package.json`, `Cargo.toml`, `pyproject.toml`, `requirements.txt`, `go.mod`
- up to 40 top-level and one-level child file names
- at most 256 KiB of text total

Build `.orquesta/project/project_understanding.json` with goal, deliverables, stack, existing assets, unknowns, evidence, and confidence. Do not send the entire repository to Codex during this handler.

- [ ] **Step 4: Implement foundation and planning writes**

Foundation calls `createFoundationStateBundle()` only when the explicit organization revision is 0. Planning creates or reuses a revisioned completion map, then calls `createAdaptiveSpecialistPlan()` with canonical role definitions. Persist checkpoints atomically.

- [ ] **Step 5: Run tests and verify GREEN**

```powershell
node --test orquesta/scripts/setup-phase-handlers.test.js orquesta/scripts/adaptive-setup-state.test.js
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```powershell
git add orquesta/scripts/setup-phase-handlers.js orquesta/scripts/setup-phase-handlers.test.js orquesta/scripts/adaptive-setup-state.js orquesta/scripts/adaptive-setup-state.test.js
git commit -m "feat: build initial setup phase handlers"
```

### Task 3: Add the restart-safe SetupRunner

**Files:**
- Create: `orquesta/scripts/setup-runner.js`
- Create: `orquesta/scripts/setup-runner.test.js`
- Modify: `orquesta/scripts/setup-engine.js`
- Modify: `orquesta/scripts/setup-engine.test.js`

**Interfaces:**
- Produces: `createSetupRunner({ handlers, readState, writeStateAtomic, appendEvent, onProgress })`.
- Produces: `run({ rootPath, setupId })`, `resume({ rootPath, setupId })`, `cancel({ rootPath, setupId })`.
- Phase 5 output includes a provisioning batch; the runner waits for an injected `provisionSpecialists` callback.
- Phase 6 validates normal repository readiness before `completeSetup()`.

- [ ] **Step 1: Write failing runner tests**

Cover:

```js
await runner.run({ rootPath, setupId });
assert.deepEqual(calls, ["environment", "understanding", "foundation", "planning", "specialists", "operation"]);
assert.equal((await readState()).status, "completed");

handlers.understanding = async () => { throw new SetupBlockedError(...); };
await runner.run({ rootPath, setupId });
assert.equal((await readState()).current_phase_id, "understanding");
assert.equal((await readState()).status, "blocked");

await runner.resume({ rootPath, setupId });
assert.deepEqual(callsAfterResume, ["understanding", "foundation", "planning", "specialists", "operation"]);
```

Assert a second concurrent `run()` for the same root returns the existing promise and does not invoke handlers twice.

- [ ] **Step 2: Run tests and verify RED**

```powershell
node --test orquesta/scripts/setup-runner.test.js
```

Expected: FAIL because the runner is missing.

- [ ] **Step 3: Implement the runner**

Use an in-process `Map<canonicalRoot, Promise>` for one active runner per project. After every durable transition, call `onProgress` with `setupId`, phase ID, status, message, and timestamp. Never sleep for animation.

- [ ] **Step 4: Run tests and verify GREEN**

```powershell
node --test orquesta/scripts/setup-runner.test.js orquesta/scripts/setup-engine.test.js
```

- [ ] **Step 5: Commit**

```powershell
git add orquesta/scripts/setup-runner.js orquesta/scripts/setup-runner.test.js orquesta/scripts/setup-engine.js orquesta/scripts/setup-engine.test.js
git commit -m "feat: run and resume six setup phases"
```

### Task 4: Connect Electron Core and specialist provisioning

**Files:**
- Modify: `apps/orquesta-desktop/electron/core/setup-engine-adapter.ts`
- Create: `apps/orquesta-desktop/electron/core/setup-engine-adapter.test.ts`
- Modify: `apps/orquesta-desktop/electron/core/core-runner.ts`
- Modify: `apps/orquesta-desktop/electron/core/specialist-provisioner.ts`
- Modify: `apps/orquesta-desktop/electron/core/specialist-provisioner.test.ts`
- Modify: `apps/orquesta-desktop/electron/core/repository-runtime.ts`
- Modify: `apps/orquesta-desktop/electron/core/repository-runtime.test.ts`
- Modify: `apps/orquesta-desktop/electron/core/repository-reader.ts`
- Modify: `apps/orquesta-desktop/electron/core/repository-reader.test.ts`

**Interfaces:**
- `startDesktopSetup(input, hooks): Promise<SetupStartResult>` starts durable state then launches the runner without blocking the start response.
- `resumeDesktopSetup(input, hooks): Promise<void>` resumes active setup on repository selection.
- Hook `provisionSpecialists({ rootPath, projectId, batch })` uses the existing `provisionSpecialists` function and returns its terminal batch.
- Hook `onProgress(progress)` emits the existing `setup.progress` Core event.

- [ ] **Step 1: Write failing adapter and provisioning tests**

Assert that start returns after state creation, runner progress is emitted, selecting a repository with an active setup resumes it once, and successful provisioning changes Phase 5 to complete plus Phase 6 to active without writing `completed_at`.

Update the existing assertion:

```ts
await expect(json(root, '.orquesta/setup/setup_state.json')).resolves.toMatchObject({
  status: 'running',
  current_phase_id: 'operation',
  completed_at: null
});
```

- [ ] **Step 2: Run tests and verify RED**

```powershell
cd apps/orquesta-desktop
npm test -- electron/core/setup-engine-adapter.test.ts electron/core/specialist-provisioner.test.ts electron/core/repository-runtime.test.ts electron/core/repository-reader.test.ts
```

Expected: FAIL because the adapter has no runner and specialist provisioning completes the whole setup.

- [ ] **Step 3: Implement Core hooks and resume**

The adapter wraps the CommonJS runner and converts progress into typed `SetupProgressEvent`. `core-runner.ts` injects the real Desktop runtime provisioning hook. `RepositoryRuntime.select()` asks the adapter to resume after the first partial snapshot is readable.

- [ ] **Step 4: Fix the Phase 5 boundary**

Change `updateInitialSetupProjection()` so terminal success produces:

```ts
{
  status: 'running',
  current_phase_id: 'operation',
  phases: specialistsCompleteAndOperationActive,
  completed_at: null
}
```

Keep provisioning failures blocked at specialists. Stop writing the legacy `current_phase` field.

- [ ] **Step 5: Run tests and verify GREEN**

Run the command from Step 2. Expected: all focused Core tests pass.

- [ ] **Step 6: Commit**

```powershell
git add apps/orquesta-desktop/electron/core
git commit -m "feat: connect desktop core to setup runner"
```

### Task 5: Port the production organ scene and visual-state adapter

**Files:**
- Create: `apps/orquesta-desktop/src/renderer/features/setup/setup-visual-state.ts`
- Create: `apps/orquesta-desktop/tests/unit/setup-visual-state.test.ts`
- Create: `apps/orquesta-desktop/src/renderer/features/setup/organ/SetupOrganStage.tsx`
- Create: `apps/orquesta-desktop/src/renderer/features/setup/organ/SetupOrganScene.tsx`
- Create: `apps/orquesta-desktop/src/renderer/features/setup/organ/Airflow3D.tsx`
- Create: `apps/orquesta-desktop/src/renderer/features/setup/organ/BackdropPanels3D.tsx`
- Create: `apps/orquesta-desktop/src/renderer/features/setup/organ/Bellows3D.tsx`
- Create: `apps/orquesta-desktop/src/renderer/features/setup/organ/EdgeOutlinedMesh.tsx`
- Create: `apps/orquesta-desktop/src/renderer/features/setup/organ/GearTrain3D.tsx`
- Create: `apps/orquesta-desktop/src/renderer/features/setup/organ/geometry.ts`
- Create: `apps/orquesta-desktop/src/renderer/features/setup/organ/LowerEngine3D.tsx`
- Create: `apps/orquesta-desktop/src/renderer/features/setup/organ/materials.ts`
- Create: `apps/orquesta-desktop/src/renderer/features/setup/organ/MechanicalSpine3D.tsx`
- Create: `apps/orquesta-desktop/src/renderer/features/setup/organ/Mechanics3D.tsx`
- Create: `apps/orquesta-desktop/src/renderer/features/setup/organ/OrganFrame3D.tsx`
- Create: `apps/orquesta-desktop/src/renderer/features/setup/organ/OrganPipes3D.tsx`
- Create: `apps/orquesta-desktop/src/renderer/features/setup/organ/ScenePrimitives.tsx`
- Create: `apps/orquesta-desktop/src/renderer/features/setup/organ/sceneLayout.ts`
- Create: `apps/orquesta-desktop/tests/unit/setup-organ-layout.test.ts`
- Modify: `apps/orquesta-desktop/package.json`
- Modify: `package-lock.json`

**Interfaces:**
- `toSetupVisualState(setup: SetupUiSnapshot, reducedMotion: boolean): SetupVisualState` maps string phase IDs to numeric visual phases.
- `SetupOrganStage({ setup })` lazy-loads the canvas and provides a static fallback.
- The scene components consume only `SetupVisualState`, never demo copy or demo actions.

- [ ] **Step 1: Write failing visual-state and layout tests**

Assert cumulative running, blocked current stop, reduced-motion stop, six phase mapping, 51 pipes, and no import of `demoSetupState` or `SetupPrototype`.

```ts
expect(toSetupVisualState(setup, false)).toMatchObject({ activePhase: 3, lifecycle: 'running' });
expect(getScenePhaseState(blocked, 3)).toMatchObject({ running: false, blocked: true });
expect(PIPE_RANKS.reduce((count, rank) => count + rank.heights.length, 0)).toBe(51);
```

- [ ] **Step 2: Run tests and verify RED**

```powershell
cd apps/orquesta-desktop
npm test -- tests/unit/setup-visual-state.test.ts tests/unit/setup-organ-layout.test.ts
```

- [ ] **Step 3: Add pinned dependencies**

```powershell
npm install --save-exact three@0.185.1 @react-three/fiber@9.6.1
```

- [ ] **Step 4: Port the vetted Three.js files**

Use only `src/setup/three/*`, `phaseActivity.ts`, and the minimum scene CSS from the supplied ZIP. Replace `SetupPrototypeState` imports with `SetupVisualState`. Do not copy `App.tsx`, `demoSetupState.ts`, `SetupPrototype.tsx`, `SetupOrganDiagram.tsx`, or the 2,800-line legacy CSS.

Set Canvas DPR to `[1, 1.5]`, disable pointer parallax under reduced motion, stop frame updates while `document.hidden`, and expose a context-loss fallback.

- [ ] **Step 5: Run tests and verify GREEN**

Run the command from Step 2, then:

```powershell
npm run build
```

- [ ] **Step 6: Commit**

```powershell
git add apps/orquesta-desktop/src/renderer/features/setup/organ apps/orquesta-desktop/src/renderer/features/setup/setup-visual-state.ts apps/orquesta-desktop/tests/unit/setup-visual-state.test.ts apps/orquesta-desktop/tests/unit/setup-organ-layout.test.ts apps/orquesta-desktop/package.json package-lock.json
git commit -m "feat: port setup pipe organ scene"
```

### Task 6: Replace the setup screen with the production left rail

**Files:**
- Modify: `apps/orquesta-desktop/src/renderer/features/setup/InitialSetupExperience.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/features/setup/initial-setup.css`
- Modify: `apps/orquesta-desktop/tests/unit/initial-setup-experience.test.tsx`
- Modify: `apps/orquesta-desktop/src/fixtures/setup-running.ts`

**Interfaces:**
- Consumes: `SetupUiSnapshot` and `SetupOrganStage`.
- Preserves: cancel confirmation, technical details, project title/root, setup status semantics.
- Produces: one left rail and one right organ stage with no duplicated phase copy.

- [ ] **Step 1: Write failing UI tests**

Assert:

```ts
expect(screen.getByRole('navigation', { name: 'セットアップ段階' })).toBeVisible();
expect(screen.getAllByRole('listitem', { name: /フェーズ/u })).toHaveLength(6);
expect(screen.getByRole('region', { name: 'パイプオルガン構築状況' })).toBeVisible();
expect(screen.queryByRole('button', { name: /Auto|Blocked|Complete|Phase/u })).not.toBeInTheDocument();
expect(screen.getAllByTestId('setup-log-entry').length).toBeLessThanOrEqual(6);
```

Keep the existing cancel and technical-detail tests.

- [ ] **Step 2: Run tests and verify RED**

```powershell
cd apps/orquesta-desktop
npm test -- tests/unit/initial-setup-experience.test.tsx
```

- [ ] **Step 3: Implement the source-faithful composition**

Use a `clamp(340px, 30vw, 430px)` left rail and the remaining width for the organ. Keep all six rows visible at 1366×768. Limit logs to six entries and scroll only the log region. Use existing warm paper tokens and the source's thin mechanical line treatment.

Lazy-load the organ with `React.lazy` and a static empty stage fallback. Do not show the current old right-side gear list or static pipe-organ background image.

- [ ] **Step 4: Run tests and verify GREEN**

Run the command from Step 2 and `npm run build`.

- [ ] **Step 5: Commit**

```powershell
git add apps/orquesta-desktop/src/renderer/features/setup apps/orquesta-desktop/tests/unit/initial-setup-experience.test.tsx apps/orquesta-desktop/src/fixtures/setup-running.ts
git commit -m "feat: build production setup progress screen"
```

### Task 7: Add end-to-end Desktop acceptance and design QA

**Files:**
- Modify: `apps/orquesta-desktop/tests/electron/initial-setup.spec.ts`
- Create: `apps/orquesta-desktop/tests/electron/setup-six-phase.spec.ts`
- Create: `design-qa.md`
- Create screenshots under: `apps/orquesta-desktop/test-results/setup-six-phase/`
- Modify: `docs/superpowers/specs/2026-07-22-orquesta-six-phase-setup-organ-integration-design.md`

**Interfaces:**
- Acceptance starts from setup intake, observes six phase changes, verifies completed Home, and covers one restart and one blocked fixture.
- Visual QA compares the supplied V11.3 screenshot and the Electron screenshot at the same 1440×900 viewport and Phase 6 state.

- [ ] **Step 1: Write failing Electron acceptance**

The test must assert that setup state reaches each phase in order, the visible left rail follows it, the organ region remains mounted until completion, and Home appears only after `completed_at` exists.

- [ ] **Step 2: Run test and verify RED**

```powershell
cd apps/orquesta-desktop
npm run build:desktop
npx playwright test --config=playwright.electron.config.ts tests/electron/setup-six-phase.spec.ts
```

- [ ] **Step 3: Complete missing integration fixes**

Fix only failures demonstrated by the acceptance test. Do not broaden into Home, map, Luca, or inspection work.

- [ ] **Step 4: Run the focused final verification once**

```powershell
node --test orquesta/scripts/setup-state.test.js orquesta/scripts/setup-phase-handlers.test.js orquesta/scripts/setup-runner.test.js orquesta/scripts/setup-engine.test.js orquesta/scripts/adaptive-setup-state.test.js
cd apps/orquesta-desktop
npm test -- electron/core/setup-engine-adapter.test.ts electron/core/specialist-provisioner.test.ts electron/core/repository-runtime.test.ts electron/core/repository-reader.test.ts tests/unit/setup-visual-state.test.ts tests/unit/setup-organ-layout.test.ts tests/unit/initial-setup-experience.test.tsx tests/unit/initial-setup-contract.test.ts
npm run build:desktop
npx playwright test --config=playwright.electron.config.ts tests/electron/setup-six-phase.spec.ts tests/electron/initial-setup.spec.ts
```

- [ ] **Step 5: Capture and compare the Desktop visual**

Capture Phase 6 at 1440×900 from Electron. Build a side-by-side comparison image containing the source reference and implementation screenshot, inspect full view plus the left rail and organ close-ups, and write `design-qa.md` with the required fidelity surfaces and `final result: passed` only when no P0/P1/P2 remains.

- [ ] **Step 6: Update design status and commit**

Change the design document state from `ユーザーレビュー待ち` to `実装済み・Desktopレビュー待ち`, then:

```powershell
git add apps/orquesta-desktop/tests/electron design-qa.md docs/superpowers/specs/2026-07-22-orquesta-six-phase-setup-organ-integration-design.md
git commit -m "test: verify six-phase desktop setup"
```

## Final completion gate

Before claiming completion:

- Read and follow `superpowers:verification-before-completion`.
- Read and follow `superpowers:finishing-a-development-branch`.
- Report exact passing test counts, Electron evidence path, visual comparison path, remaining P3 items, and whether the installer was rebuilt.
- Do not merge into another branch without the user's instruction.
