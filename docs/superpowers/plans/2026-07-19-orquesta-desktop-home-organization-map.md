# Orquesta Desktop Home Organization Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 円形Homeの中へOrquesta固有の組織構造を読みやすく表示し、Now、Project Status、言語切替、初回起動表示までを完成させる。

**Architecture:** Rendererでagent stateを指揮軸、運用、利用者支援、制作groupへ投影し、その意味モデルから安定した座標と直交線を計算する。Mapは真円のviewportとしてpan、zoom、Fit、手動配置を持ち、長い説明は詳細overlayへ限定する。Electron MainはRendererの初期状態が描画された通知を待ってからMain Windowを見せる。

**Tech Stack:** Electron 43、React 19、TypeScript、Vitest、Testing Library、Playwright、Lucide React

## Global Constraints

- Home全体をscrollさせない。
- agentをstatusや件数で非表示にしない。折り畳みと`+N`集約を使わない。
- `orquesta-admin`は現行プロトコル上残し、user直下の小さい運用ノードとして表示する。
- current taskの委譲元と組織上の親を分離する。
- missionと長いprogressはHome nodeへ常時表示しない。
- `.orquesta` stateへ手動座標を書き込まない。
- 別タブの過去タスク、過去エラー、質問一覧は今回作らない。
- 新しいproduction behaviorはREDを確認してから実装する。
- Unitやbuildだけを実画面の合格証拠にしない。

---

### Task 1: Orquesta固有の組織投影を追加する

**Files:**
- Create: `apps/orquesta-desktop/src/renderer/features/map/organization.ts`
- Create: `apps/orquesta-desktop/tests/unit/map-organization.test.ts`
- Modify: `apps/orquesta-desktop/electron/core/repository-reader.ts`
- Modify: `apps/orquesta-desktop/electron/core/repository-reader.test.ts`

**Interfaces:**
- Produces: `buildOrganizationProjection(agents: AgentUiModel[]): OrganizationProjection`
- Produces: `productionGroupFor(agent: AgentUiModel): ProductionGroupId`
- `OrganizationProjection` contains `parentByAgentId`, `childrenByParentId`, `laneByAgentId`, `groupByAgentId`, `groups`, and hierarchy diagnostics.

- [ ] **Step 1: Write the failing organization tests**

Add tests proving this exact topology:

```ts
const projection = buildOrganizationProjection([
  makeAgent('orchestrator', 'orchestrator', 'user'),
  makeAgent('orquesta-admin', 'orquesta-admin', 'orchestrator'),
  makeAgent('user-liaison', 'user-liaison', 'orchestrator'),
  makeAgent('vision-curator', 'vision-curator', 'orchestrator'),
  makeAgent('error-concierge', 'error-concierge', 'orchestrator'),
  makeAgent('implementation-001', 'implementation', 'orchestrator'),
  makeAgent('implementation-002', 'implementation', 'orchestrator'),
  makeAgent('implementation-003', 'implementation', 'implementation-001')
]);

expect(projection.parentByAgentId.get('orquesta-admin')).toBe('user');
expect(projection.parentByAgentId.get('user-liaison')).toBe('user');
expect(projection.parentByAgentId.get('vision-curator')).toBe('user-liaison');
expect(projection.parentByAgentId.get('error-concierge')).toBe('user-liaison');
expect(projection.groupByAgentId.get('implementation-001')).toBe('implementation');
expect(projection.groupByAgentId.get('implementation-002')).toBe('implementation');
expect(projection.parentByAgentId.get('implementation-003')).toBe('implementation-001');
expect(projection.groups.find((group) => group.id === 'implementation')?.agentIds).toEqual([
  'implementation-001', 'implementation-002', 'implementation-003'
]);
```

Also prove unknown roles go to `other`, and status/current task changes do not change the projection.

- [ ] **Step 2: Run the tests and confirm RED**

Run:

```powershell
npx vitest run tests/unit/map-organization.test.ts electron/core/repository-reader.test.ts --config vitest.config.ts
```

Expected: FAIL because `organization.ts` and stable structural-parent projection do not exist.

- [ ] **Step 3: Implement the semantic projection**

Use these stable production groups and this order:

```ts
export const PRODUCTION_GROUP_ORDER = [
  'implementation', 'design', 'qa', 'docs', 'protocol', 'research', 'other'
] as const;
```

Foundation roles override stale/default parent values. Production children keep an explicit non-foundation production parent; otherwise they attach to `orchestrator`. Reuse `buildAgentHierarchy` for missing-parent, self-parent, and cycle repair, then rebuild parent/children/depth maps after foundation overrides.

In `repository-reader.ts`, stop using `currentTask?.assignedByAgentId` as the agent's organization parent:

```ts
assignedByAgentId: id === 'orchestrator'
  ? 'user'
  : string(raw.organization_parent_agent_id)
    ?? string(raw.assigned_by_agent_id)
    ?? 'orchestrator'
```

Task `assignedByAgentId` remains unchanged and continues to describe current work flow.

- [ ] **Step 4: Run the focused tests and confirm GREEN**

Run the same Vitest command. Expected: all selected tests pass.

- [ ] **Step 5: Commit Task 1**

```powershell
git add apps/orquesta-desktop/src/renderer/features/map/organization.ts apps/orquesta-desktop/tests/unit/map-organization.test.ts apps/orquesta-desktop/electron/core/repository-reader.ts apps/orquesta-desktop/electron/core/repository-reader.test.ts
git commit -m "feat: project semantic Orquesta organization"
```

### Task 2: Group-aware layoutと直交線を作る

**Files:**
- Modify: `apps/orquesta-desktop/src/renderer/features/map/layout.ts`
- Modify: `apps/orquesta-desktop/tests/unit/map-layout.test.ts`
- Modify: `apps/orquesta-desktop/tests/unit/layout.test.ts`

**Interfaces:**
- Consumes: `OrganizationProjection`
- Produces: `MapLayout.groups: MapGroupLayout[]`
- Produces: `MapLayout.edges` with `kind: 'spine' | 'admin' | 'support' | 'production' | 'delegation'`
- Produces: `orthogonalPath(from: Point, to: Point, axis?: 'vertical' | 'horizontal'): string`

- [ ] **Step 1: Write failing group-layout tests**

Assert that three implementation agents have unique positions inside one `implementation` group, that support agents are right of the command spine, admin is left of user, and all returned edge paths contain only `M`, `L`, `H`, and `V` commands.

Add 1, 12, 35, and 80-agent assertions:

```ts
expect(layout.agentPositions.size).toBe(snapshot.agents.length);
expect(new Set([...layout.agentPositions.values()].map(({ x, y }) => `${x}:${y}`)).size)
  .toBe(snapshot.agents.length);
expect(layout.groups.find((group) => group.id === 'implementation')?.agentIds).toHaveLength(3);
```

- [ ] **Step 2: Run focused layout tests and confirm RED**

```powershell
npx vitest run tests/unit/map-layout.test.ts tests/unit/layout.test.ts --config vitest.config.ts
```

Expected: FAIL because the layout has no semantic groups and still emits cubic paths.

- [ ] **Step 3: Implement deterministic group layout**

Lay out each production group as a bounded forest. Group roots are placed in rows, explicit children remain below their parent, and group bounds include every individual node. Arrange group boxes in at most three columns under the orchestrator. Compute the world bounds after admin and support branches are placed.

Use stable ordering from the input and agent ID. Do not sort by status or active work.

Replace the cubic edge helper with an orthogonal path:

```ts
export function orthogonalPath(from: Point, to: Point, axis: 'vertical' | 'horizontal' = 'vertical'): string {
  if (axis === 'horizontal') {
    const midX = from.x + (to.x - from.x) / 2;
    return `M ${from.x} ${from.y} H ${midX} V ${to.y} H ${to.x}`;
  }
  const midY = from.y + (to.y - from.y) / 2;
  return `M ${from.x} ${from.y} V ${midY} H ${to.x} V ${to.y}`;
}
```

- [ ] **Step 4: Run layout tests and confirm GREEN**

Run the focused layout command. Expected: all selected tests pass with every node preserved.

- [ ] **Step 5: Commit Task 2**

```powershell
git add apps/orquesta-desktop/src/renderer/features/map/layout.ts apps/orquesta-desktop/tests/unit/map-layout.test.ts apps/orquesta-desktop/tests/unit/layout.test.ts
git commit -m "feat: lay out grouped Orquesta branches"
```

### Task 3: 円形Map、情報量、手動配置を実装する

**Files:**
- Create: `apps/orquesta-desktop/src/renderer/features/map/manual-layout.ts`
- Create: `apps/orquesta-desktop/tests/unit/manual-layout.test.ts`
- Modify: `apps/orquesta-desktop/src/renderer/features/map/MapViewport.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/styles/global.css`
- Modify: `apps/orquesta-desktop/tests/unit/map-viewport.test.ts`
- Modify: `apps/orquesta-desktop/tests/unit/app.test.tsx`

**Interfaces:**
- Produces: `readManualOffsets(projectId: string): Record<string, Point>`
- Produces: `writeManualOffset(projectId: string, agentId: string, point: Point): void`
- Produces: `clearManualOffsets(projectId: string): void`
- `MapViewport` renders `data-map-aperture="circle"` and `data-group-id` frames.

- [ ] **Step 1: Write failing Renderer tests**

Tests must prove:

- `.map-world-boundary` is absent and the viewport declares a circle aperture.
- every agent remains `[data-node-kind="agent"]`.
- normal zoom shows short role and status but not `roleSummary`.
- current task ID is visible at normal/detail.
- the implementation group frame contains all implementation agent IDs.
- manual offsets survive a new `MapViewport` instance for the same project.
- Reset clears offsets; Fit does not.
- invalid localStorage JSON is ignored.

- [ ] **Step 2: Run focused tests and confirm RED**

```powershell
npx vitest run tests/unit/manual-layout.test.ts tests/unit/map-viewport.test.ts tests/unit/app.test.tsx --config vitest.config.ts
```

Expected: FAIL because the current Map has a rectangular boundary, mission text, and no drag persistence.

- [ ] **Step 3: Implement the circular viewport and semantic nodes**

Make `.map-viewport` a fixed, centered, true circle using equal width and height. Clip Map content inside the aperture. Render group frames from layout group bounds before nodes. Remove the SVG world rectangle.

Change node copy to:

```tsx
<strong>{displayName}</strong>
<small className="agent-node__role">{shortRoleLabel(agent.role)}</small>
<span className="agent-node__status">...</span>
{activeTask ? <span className="agent-node__task-id">{activeTask.id}</span> : null}
```

Only detail zoom may add a two-line task title. `roleSummary` stays in `AgentDetail`.

Apply manual point offsets after automatic layout. Node drag starts only after 4px. Stop propagation so map pan and node drag do not fight. Reset clears the current project's overrides and calls Fit.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run the focused Renderer command. Expected: all selected tests pass.

- [ ] **Step 5: Commit Task 3**

```powershell
git add apps/orquesta-desktop/src/renderer/features/map apps/orquesta-desktop/src/renderer/styles/global.css apps/orquesta-desktop/tests/unit/manual-layout.test.ts apps/orquesta-desktop/tests/unit/map-viewport.test.ts apps/orquesta-desktop/tests/unit/app.test.tsx
git commit -m "feat: restore circular interactive Orquesta map"
```

### Task 4: Now、Project Status、言語切替を整理する

**Files:**
- Modify: `apps/orquesta-desktop/src/renderer/features/now/NowCardStack.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/features/project/ProjectStatusCard.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/features/i18n/messages.ts`
- Modify: `apps/orquesta-desktop/src/main.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/styles/global.css`
- Create: `apps/orquesta-desktop/tests/unit/now-panel.test.tsx`
- Create: `apps/orquesta-desktop/tests/unit/project-status.test.tsx`
- Modify: `apps/orquesta-desktop/tests/unit/app.test.tsx`

**Interfaces:**
- Now considers an item active only when its agent is `working` with `statusEvidence === 'proven'` and its task has observed turn/progress evidence.
- Project Status exposes `JA` and `EN` buttons through `useI18n()`.

- [ ] **Step 1: Write failing evidence and localization tests**

Prove that a stale agent with a completed task does not appear as Working, a proven current agent does appear, the header is rendered once, and long progress text is bounded.

Prove that `0 proven working` and `実行確認済み 0` are explicit, that JA/EN buttons change the Home labels, and that persisted Japanese wins when no URL parameter is supplied.

- [ ] **Step 2: Run focused tests and confirm RED**

```powershell
npx vitest run tests/unit/now-panel.test.tsx tests/unit/project-status.test.tsx tests/unit/app.test.tsx --config vitest.config.ts
```

- [ ] **Step 3: Implement one bounded Now panel and visible locale switch**

Render one `.now-panel` with one header and an internally scrollable list. Each row shows agent, task ID, at most two lines of progress, elapsed time, and progress track. Remove the synthetic `Active delegation` duplicate card.

In `main.tsx`, stop forcing English:

```tsx
<DesktopRendererApp />
```

Project Status uses the existing I18n provider and exposes the two locale buttons without opening Advanced Operations.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run the focused command. Expected: all selected tests pass.

- [ ] **Step 5: Commit Task 4**

```powershell
git add apps/orquesta-desktop/src/main.tsx apps/orquesta-desktop/src/renderer/features/now apps/orquesta-desktop/src/renderer/features/project/ProjectStatusCard.tsx apps/orquesta-desktop/src/renderer/features/i18n/messages.ts apps/orquesta-desktop/src/renderer/styles/global.css apps/orquesta-desktop/tests/unit
git commit -m "feat: simplify desktop home instruments"
```

### Task 5: Renderer ready gateで初回白画面を防ぐ

**Files:**
- Modify: `apps/orquesta-desktop/electron/shared/host-contract.ts`
- Modify: `apps/orquesta-desktop/electron/preload/host-api.ts`
- Modify: `apps/orquesta-desktop/electron/preload/host-api.test.ts`
- Modify: `apps/orquesta-desktop/electron/main/index.ts`
- Modify: `apps/orquesta-desktop/src/renderer/app/DesktopRendererApp.tsx`
- Modify: `apps/orquesta-desktop/tests/electron/desktop-shell.spec.ts`

**Interfaces:**
- Produces: `DesktopHostApi.notifyRendererReady(): Promise<void>`
- Adds: `DESKTOP_IPC.rendererReady`

- [ ] **Step 1: Write failing host and Electron tests**

The preload test must prove `notifyRendererReady()` invokes only `DESKTOP_IPC.rendererReady` and accepts only `{ accepted: true }`.

Add an Electron test with a fresh temporary `--user-data-dir` and no project fixture. The first visible Main Window must contain `.project-onboarding-shell` and the Open project button, not only a blank body.

- [ ] **Step 2: Run host test and confirm RED**

```powershell
npx vitest run electron/preload/host-api.test.ts --config vitest.config.ts
```

Expected: FAIL because the channel and API are missing.

- [ ] **Step 3: Implement the renderer-ready handshake**

Register the IPC handler before creating Main Window. `Workspace` calls `notifyRendererReady()` after `snapshot` or `loadingError` has rendered. Main closes splash and shows Main Window only after the notification from that window's `webContents`.

Keep a 6-second fallback. On timeout, show Main Window and preserve the loading/error surface instead of leaving the application invisible.

- [ ] **Step 4: Run host and Electron startup tests**

```powershell
npx vitest run electron/preload/host-api.test.ts --config vitest.config.ts
npm run build:desktop
npx playwright test --config=playwright.electron.config.ts tests/electron/desktop-shell.spec.ts
```

Expected: host tests and both fixture/no-project Electron cases pass.

- [ ] **Step 5: Commit Task 5**

```powershell
git add apps/orquesta-desktop/electron apps/orquesta-desktop/src/renderer/app/DesktopRendererApp.tsx apps/orquesta-desktop/tests/electron/desktop-shell.spec.ts
git commit -m "fix: reveal desktop after renderer is ready"
```

### Task 6: Browser、visual、Electron実機QAを通す

**Files:**
- Create: `apps/orquesta-desktop/src/fixtures/semantic-home.ts`
- Modify: `apps/orquesta-desktop/src/fixtures/index.ts`
- Modify: `apps/orquesta-desktop/tests/unit/fixtures.test.ts`
- Modify: `apps/orquesta-desktop/tests/browser/interaction.spec.ts`
- Modify: `apps/orquesta-desktop/tests/visual/home.visual.spec.ts`
- Modify: `apps/orquesta-desktop/tests/electron/map-stability.spec.ts`
- Modify: `apps/orquesta-desktop/tests/visual/__screenshots__/home-active-1440x900.png`
- Modify: `apps/orquesta-desktop/tests/visual/__screenshots__/home-active-1366x768.png`
- Create: `apps/orquesta-desktop/design-qa.md`
- Modify: `apps/orquesta-desktop/docs/validation/map-stabilization.md`

**Interfaces:**
- The `semantic-home` fixture mirrors the current 12-agent role mix without copying private conversation content.

- [ ] **Step 1: Add failing browser assertions before updating screenshots**

Assert at 1440x900 and 1366x768:

- `data-map-aperture="circle"` exists.
- DOM agent count equals fixture agent count.
- all three implementation nodes belong to one visible group frame.
- Home document has no horizontal or vertical scroll.
- node rectangles do not overlap at Fit.
- Composer, Now, Project Status, and Attention remain visible.
- agent click, task click, pan, zoom, Fit, drag, Reset, and language switch work.
- browser console has no errors.

- [ ] **Step 2: Run browser tests and confirm RED where the fixture/assertions are new**

```powershell
npm run build
npx playwright test tests/browser/interaction.spec.ts
```

- [ ] **Step 3: Finish responsive CSS and update screenshot baselines**

Fix layout until the browser assertions pass. Then update the two reviewed visual baselines:

```powershell
npm run test:visual:update
```

- [ ] **Step 4: Run the complete Desktop verification**

```powershell
npm run test
npm run build
npm run test:browser
npm run test:visual
npm run build:desktop
npx playwright test --config=playwright.electron.config.ts tests/electron/desktop-shell.spec.ts tests/electron/map-stability.spec.ts tests/electron/repository-integration.spec.ts tests/electron/runtime-integration.spec.ts
git diff --check
```

Expected: zero failed tests, zero build errors, zero whitespace errors.

- [ ] **Step 5: Run visual comparison and write `design-qa.md`**

Open the approved reference and the latest same-size implementation capture together. Record typography, spacing, colors, image quality, and copy. Fix all P0, P1, and P2 findings, repeat the capture, and leave `final result: passed` only when none remain.

- [ ] **Step 6: Commit Task 6**

```powershell
git add apps/orquesta-desktop
git commit -m "test: verify completed desktop home"
```

- [ ] **Step 7: Launch the live repository for user review**

Build and start the Desktop app against the Orquesta worktree. Do not call the Desktop integration complete. Keep the app open so the user can inspect the real 12-agent Home before Task 9 or packaging work continues.
