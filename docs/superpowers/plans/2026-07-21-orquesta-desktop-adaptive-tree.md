# Orquesta Desktop Adaptive Tree Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the canonical Orquesta line, team, role, membership, lifecycle, and proposal state as an adaptive circular organization map without hiding agents.

**Architecture:** Extend the repository-to-renderer contract with explicit organization entities, normalize them into a line-first map view model, and feed a deterministic layout that only changes on organization revision. Keep the existing viewport and interaction shell, replace regex-based explicit grouping with canonical line/team membership, and retain a diagnosed legacy adapter for old projects.

**Tech Stack:** TypeScript, React 19, Electron, Vite, Vitest, Testing Library, Playwright Electron, CSS.

## Global Constraints

- Preserve the existing circular viewport, design tokens, pan, zoom, Fit, Reset, selection, and app-owned manual layout.
- Never collapse, aggregate, or omit an agent. All lifecycle states remain visible by default.
- Do not use role/display-name regexes when `organization.source === 'explicit'`.
- Keep organization relationships and current-task delegation relationships separate.
- New-line proposals are not active lines until approved.
- Temporary cross-line assignments are forbidden.
- Layout is recomputed from structural organization revisions, not status, heartbeat, or task-progress changes.
- Do not modify or discard unrelated uncommitted Desktop UI work.
- Production code is written only after its focused test has failed for the intended reason.

---

### Task 1: Explicit organization renderer contract

**Files:**
- Modify: `apps/orquesta-desktop/src/contracts/orquesta-ui.ts`
- Modify: `apps/orquesta-desktop/electron/core/repository-reader.ts`
- Test: `apps/orquesta-desktop/electron/core/repository-reader.test.ts`

**Interfaces:**
- Consumes: schema version 2 `.orquesta/state/organization.json` lines, teams, memberships, and relationships plus pending `propose_line` records from `.orquesta/state/organization-decisions.json`.
- Produces: `OrganizationUiSnapshot.lines`, `.teams`, `.relationships`, `.lineProposals`; `AgentUiModel.membershipOrdinal` and `.displayOrder`.

- [x] **Step 1: Write failing repository projection tests**

Add an explicit two-line organization fixture and a pending `propose_line` decision to the existing repository-reader test setup and assert:

```ts
expect(snapshot.organization?.lines.map((line) => line.id)).toEqual(['desktop-line', 'core-line']);
expect(snapshot.organization?.teams.map((team) => team.id)).toEqual(['desktop-implementation', 'core-implementation']);
expect(snapshot.organization?.relationships).toContainEqual(expect.objectContaining({
  type: 'reports_to',
  fromAgentId: 'implementation-004',
  toAgentId: 'orchestrator'
}));
expect(snapshot.agents.find((agent) => agent.id === 'implementation-004')).toMatchObject({
  lineId: 'core-line',
  teamId: 'core-implementation',
  membershipOrdinal: 1
});
```

- [x] **Step 2: Verify RED**

Run:

```powershell
npm test -- electron/core/repository-reader.test.ts
```

Expected: fail because the organization arrays and membership ordering fields do not exist.

- [x] **Step 3: Add the contract types and projection**

Add these exact public types and fields:

```ts
export interface OrganizationLineUiModel {
  id: string;
  displayName: string;
  goal: string | null;
  status: string;
  ownerAgentId: string;
  dedicatedLeadAgentId: string | null;
  displayOrder: number;
  approvalSource: string | null;
}

export interface OrganizationTeamUiModel {
  id: string;
  lineId: string | null;
  displayName: string;
  purpose: string | null;
  lifecycleState: string;
  displayOrder: number;
}

export interface OrganizationRelationshipUiModel {
  id: string;
  type: string;
  fromAgentId: string;
  toAgentId: string;
}

export interface OrganizationLineProposalUiModel {
  id: string;
  displayName: string;
  reason: string;
  status: 'approval_wait';
  ownerAgentId: string | null;
}
```

Extend `OrganizationUiSnapshot` with arrays of those types and default every array to `[]` in legacy mode. Add nullable `membershipOrdinal` and `displayOrder` fields to `AgentUiModel`. Read display names, goals, owner IDs, dedicated leads, purpose, lifecycle, ordinal, and proposal records without reconstructing them from IDs.

- [x] **Step 4: Verify GREEN and contract compatibility**

Run:

```powershell
npm test -- electron/core/repository-reader.test.ts tests/unit/organization-model.test.ts
npm run build
```

Expected: both test files pass and TypeScript build exits 0.

### Task 2: Canonical line-first map view model

**Files:**
- Modify: `apps/orquesta-desktop/src/renderer/features/map/organization.ts`
- Test: `apps/orquesta-desktop/tests/unit/map-organization.test.ts`
- Test: `apps/orquesta-desktop/tests/unit/organization-model.test.ts`

**Interfaces:**
- Consumes: `OrquestaUiSnapshot` with explicit organization arrays.
- Produces: `OrganizationProjection` containing `coreAgentIds`, `lines`, `unassignedAgentIds`, structural parent maps, diagnostics, and legacy source information.

- [x] **Step 1: Write failing explicit-organization tests**

Cover:

```ts
const projection = buildOrganizationProjection(snapshot);
expect(projection.lines.map((line) => line.id)).toEqual(['desktop-line', 'core-line']);
expect(projection.lines[0].teams[0].roleClusters[0].agentIds).toEqual([
  'implementation-001',
  'implementation-002'
]);
expect(projection.lines[1].teams[0].roleClusters[0].agentIds).toEqual([
  'implementation-004'
]);
expect(projection.coreAgentIds).toEqual(['orchestrator', 'user-support', 'orquesta-admin']);
```

Also assert that status and task-only changes do not alter line/team/role-cluster membership and that retired/provisioning agents remain present.

- [x] **Step 2: Verify RED**

Run:

```powershell
npm test -- tests/unit/map-organization.test.ts tests/unit/organization-model.test.ts
```

Expected: fail because the current projection accepts only agents and groups explicit roles into fixed global categories.

- [x] **Step 3: Implement the explicit model and isolated legacy adapter**

Change the entry point to:

```ts
export function buildOrganizationProjection(snapshot: OrquestaUiSnapshot): OrganizationProjection
```

Use `snapshot.organization.source` to choose one of two isolated paths:

```ts
return snapshot.organization?.source === 'explicit'
  ? buildExplicitOrganizationProjection(snapshot)
  : buildLegacyOrganizationProjection(snapshot.agents);
```

For explicit state, build `Line -> Team -> RoleCluster -> Agent` from IDs, membership, position, ordinal, and display order. Do not call `productionGroupFor`. Preserve invalid agents under `unassignedAgentIds` with diagnostics instead of silently assigning them to the orchestrator.

- [x] **Step 4: Verify GREEN**

Run the two focused tests again. Expected: pass with explicit same-role agents separated by line and all individuals retained.

### Task 3: Deterministic adaptive line/team layout

**Files:**
- Modify: `apps/orquesta-desktop/src/renderer/features/map/layout.ts`
- Test: `apps/orquesta-desktop/tests/unit/map-layout.test.ts`

**Interfaces:**
- Consumes: the Task 2 `OrganizationProjection`.
- Produces: generic `MapRegionLayout[]` for line/team/role regions, agent positions, structural edges, world bounds, ports, and compact mode.

- [x] **Step 1: Write failing layout tests**

Add tests for:

```ts
expect(layout.lines.map((line) => line.id)).toEqual(['desktop-line', 'core-line']);
expect(layout.agentPositions.get('implementation-001')).not.toEqual(
  layout.agentPositions.get('implementation-004')
);
expect(layout.lines[0].teamIds).toContain('desktop-implementation');
expect(layout.agentPositions.size).toBe(snapshot.agents.length);
```

Test 1-line, 2-line, 3-line, 35-agent, and 80-agent inputs; dedicated lead first placement; line owner without duplicated orchestrator; port endpoints outside label bounds; and stable output after task/status-only changes.

- [x] **Step 2: Verify RED**

Run:

```powershell
npm test -- tests/unit/map-layout.test.ts
```

Expected: fail because `MapGroupLayout` is restricted to fixed `ProductionGroupId` values and there is no line layout.

- [x] **Step 3: Implement adaptive packing**

Replace fixed production groups with generic regions:

```ts
export interface MapRegionLayout {
  id: string;
  kind: 'line' | 'team' | 'role' | 'proposal' | 'diagnostic';
  parentId: string | null;
  agentIds: string[];
  x: number;
  y: number;
  width: number;
  height: number;
  headerHeight: number;
  inputPort: Point;
}
```

Place Project Core on the central upper axis. Use one column for one line, two columns for two lines, and `ceil(sqrt(lineCount))` columns for three or more lines. Inside each line, pack teams by stable display order; inside teams, pack role clusters and every agent. Expand world bounds rather than dropping nodes.

- [x] **Step 4: Verify GREEN**

Run the focused layout tests. Expected: all scenarios pass and every input agent has one unique position.

### Task 4: Render the adaptive tree and semantic information

**Files:**
- Modify: `apps/orquesta-desktop/src/renderer/features/map/MapViewport.tsx`
- Create: `apps/orquesta-desktop/src/renderer/features/map/map.css`
- Test: `apps/orquesta-desktop/tests/unit/map-viewport.test.ts`

**Interfaces:**
- Consumes: Task 3 line/team/role regions and ports.
- Produces: visible line/team headers, lifecycle nodes, separate structural/task layers, smooth visual scaling, and accessible selection controls.

- [x] **Step 1: Write failing DOM and interaction tests**

Assert:

```ts
expect(container.querySelectorAll('[data-region-kind="line"]')).toHaveLength(2);
expect(container.querySelector('[data-line-id="desktop-line"]')).toHaveTextContent('Desktop');
expect(container.querySelector('[data-line-id="core-line"]')).toHaveTextContent('Core');
expect(container.querySelectorAll('[data-agent-id]')).toHaveLength(snapshot.agents.length);
expect(container.querySelector('[data-agent-id="implementation-003"]')).toHaveAttribute('data-lifecycle-state', 'retired');
expect(container.querySelector('[data-agent-id="implementation-004"]')).toHaveTextContent('T90');
```

Add tests that role text is not repeated when it matches the display name, task edges are absent by default, task edges appear after task selection, and the transparent hit target remains available in overview.

- [x] **Step 2: Verify RED**

Run:

```powershell
npm test -- tests/unit/map-viewport.test.ts
```

Expected: fail because current markup exposes only fixed `.map-group` elements and always renders the role subtitle.

- [x] **Step 3: Render line/team/role regions and lifecycle states**

Import `./map.css` from `MapViewport.tsx` so the dirty global stylesheet is not rewritten. Reuse existing CSS tokens. Add `data-region-kind`, line/team IDs, lifecycle and position attributes. Keep Lucide and `AgentGlyph` assets; do not create inline SVG or CSS-drawn icons.

Use smooth node visual scaling with a clamped CSS variable and a separate minimum hit area. Show compact name/status at overview, task ID at normal, and at most two task-title lines at detail. Hide a duplicate role subtitle when normalized role and display name are equivalent.

- [x] **Step 4: Verify GREEN**

Run viewport tests and build. Expected: DOM assertions pass and TypeScript/CSS bundling exits 0.

### Task 5: Line, team, and agent manual placement

**Files:**
- Modify: `apps/orquesta-desktop/src/renderer/features/map/manual-layout.ts`
- Modify: `apps/orquesta-desktop/src/renderer/features/map/MapViewport.tsx`
- Test: `apps/orquesta-desktop/tests/unit/map-viewport.test.ts`
- Test: `apps/orquesta-desktop/tests/unit/manual-layout.test.ts`

**Interfaces:**
- Consumes: line/team/agent drag targets and current organization revision.
- Produces: version 2 manual-layout state with legacy agent-offset migration.

- [x] **Step 1: Write failing persistence and group-drag tests**

Define the desired storage shape:

```ts
interface ManualLayoutStateV2 {
  version: 2;
  organizationRevision: number;
  lineOffsets: Record<string, Point>;
  teamOffsets: Record<string, Point>;
  agentOffsets: Record<string, Point>;
}
```

Assert that dragging a team header moves every team member by the same delta, dragging a line moves all line teams and agents, individual drag only moves one node, pointer jitter writes nothing, and old flat agent offsets migrate without loss.

- [x] **Step 2: Verify RED**

Run the two focused tests. Expected: fail because current storage contains only a flat `Record<agentId, Point>` and headers are not draggable.

- [x] **Step 3: Implement versioned offsets and group drag**

Add line/team/agent offset application functions, filter offsets to current structural IDs, and persist only after a real drag. Keep canonical `.orquesta` files read-only.

- [x] **Step 4: Verify GREEN**

Run focused tests. Expected: all pointer capture, coalescing, jitter, and group-drag tests pass.

### Task 6: Proposals, diagnostics, and lifecycle exceptions

**Files:**
- Modify: `apps/orquesta-desktop/src/renderer/features/map/organization.ts`
- Modify: `apps/orquesta-desktop/src/renderer/features/map/layout.ts`
- Modify: `apps/orquesta-desktop/src/renderer/features/map/MapViewport.tsx`
- Test: `apps/orquesta-desktop/tests/unit/map-organization.test.ts`
- Test: `apps/orquesta-desktop/tests/unit/map-layout.test.ts`
- Test: `apps/orquesta-desktop/tests/unit/map-viewport.test.ts`

**Interfaces:**
- Consumes: lifecycle state, operational status, line proposals, invalid references, and legacy diagnostics.
- Produces: visible proposal/diagnostic regions without promoting them into active organization lines.

- [x] **Step 1: Write failing exception tests**

Cover provisioning, provisioning failure, retired, superseded, pending new-line proposal, missing team, missing line, relationship cycle, permanent transfer, and legacy source badges. Assert that pending line proposals are not included in `projection.lines` and that no agent ID appears twice after a transfer.

- [x] **Step 2: Verify RED**

Run the three focused test files. Expected: fail on missing proposal and diagnostic regions.

- [x] **Step 3: Implement exception rendering**

Keep lifecycle nodes in their destination or former team. Render proposals in separate dotted `proposal` regions near the world edge. Render broken references in a diagnostic region and expose the diagnostic count on the viewport. Show legacy inference as a diagnosed badge, not as explicit organization.

- [x] **Step 4: Verify GREEN**

Run the focused tests. Expected: all exception assertions pass and every Agent has exactly one rendered node.

### Task 7: Realistic fixtures, performance, Desktop visual QA, and documentation

**Files:**
- Create: `apps/orquesta-desktop/src/fixtures/adaptive-organization.ts`
- Modify: `apps/orquesta-desktop/src/fixtures/index.ts`
- Modify: `apps/orquesta-desktop/tests/electron/map-stability.spec.ts`
- Modify: `apps/orquesta-desktop/tests/unit/map-layout.test.ts`
- Modify: `design-qa.md`
- Modify: `docs/superpowers/specs/2026-07-21-orquesta-desktop-adaptive-tree-design.md`

**Interfaces:**
- Consumes: completed map implementation.
- Produces: user-reviewable two-line Desktop state, 35/80-agent proof, screenshots, and final QA evidence.

- [x] **Step 1: Add realistic fixture tests first**

Create fixtures for foundation-only, single-line, two-line same-role, dedicated lead, lifecycle mixture, pending proposal, 35 agents, and 80 agents. Before adding them to the fixture catalog, add tests requiring one unique DOM node and one unique layout position per Agent.

- [x] **Step 2: Verify RED**

Run:

```powershell
npm test -- tests/unit/map-layout.test.ts tests/unit/map-viewport.test.ts
```

Expected: fail because the fixture cases do not yet exist.

- [x] **Step 3: Add fixture catalog entries and Electron coverage**

Add `adaptive-two-line`, `adaptive-lifecycle`, and `adaptive-large-roster` fixture entries without overwriting unrelated fixture-index changes. Update the Electron test to capture 1440x900 at 100%, 1366x768 at 125%, 1440x900 at 150%, and 1366x768 at 200%, and to exercise pan, zoom, Fit, Reset, Agent selection, Task selection, Team drag, and Line drag.

- [x] **Step 4: Run full automated verification**

Run:

```powershell
npm test
npm run build:desktop
npm run test:desktop-smoke
```

Expected: exit 0 with no failing unit or Electron tests.

- [x] **Step 5: Capture and compare the selected design**

Capture the selected C mock and the implementation at the same map state and viewport. Put both images into one comparison image, inspect full view and focused Line/Team/Agent regions, and write `design-qa.md` with fonts, spacing, tokens, icons/assets, copy, interactions, findings, iteration history, and `final result: passed` only when no P0/P1/P2 remains.

- [x] **Step 6: User checkpoint**

Open the current Desktop build or browser comparison automatically and ask the user to confirm the two-line organization map. The checkpoint must show two lines containing the same implementation role without mixing individuals.

## Plan Self-Review

- Spec coverage: contract, canonical projection, adaptive layout, information hierarchy, lifecycle, proposals, manual group placement, performance, legacy fallback, fixtures, Desktop QA, and user checkpoint are each assigned to a task.
- Placeholder scan: no TBD/TODO/unspecified implementation steps remain.
- Type consistency: Task 1 contract feeds Task 2 projection; Task 2 feeds Task 3 layout; Task 3 feeds Tasks 4-6 rendering; Task 7 verifies the full stack.
