# Orquesta Desktop IA I2A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the temporary User Tasks list with the approved two-pane visual workspace and hand it to the user for an early appearance review.

**Architecture:** Create a focused `UserTasksWorkspace` component. It owns only filtering and visual selection; `DesktopRendererApp` remains responsible for canonical data and resolution side effects. Home and the workspace continue to read the same `snapshot.attention` array.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, Lucide React, Electron renderer CSS.

## Global Constraints

- Keep the existing Home, map, dock, Composer, desktop shell, and canonical bridge unchanged.
- Use a 38% list and 62% detail layout with independent internal scrolling.
- Show All, Questions, Approvals, Reviews, and Manual work with counts, including zero.
- Do not add a User Tasks history tab.
- Do not run packaged, pointer, memory, full-suite, or repeated visual checks.
- Stop after one targeted test pass, one build, and one visible launch.

---

### Task 1: Build the User Tasks visual workspace

**Files:**
- Create: `apps/orquesta-desktop/src/renderer/features/attention/UserTasksWorkspace.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/features/navigation/WorkspaceSurface.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/features/i18n/messages.ts`
- Modify: `apps/orquesta-desktop/src/renderer/styles/global.css`
- Create: `apps/orquesta-desktop/tests/unit/user-tasks-workspace.test.tsx`
- Modify: `apps/orquesta-desktop/tests/unit/app.test.tsx`

**Interfaces:**
- Produces: `UserTaskKind = UserActionKind | 'all'`.
- `UserTasksWorkspace` consumes `items`, `agents`, `selectedKind`, `canResolve`, `onSelectKind`, and `onResolve`.
- `WorkspaceSurface` passes canonical `snapshot.attention` and does not open a second overlay for list selection.

- [x] **Step 1: Write the failing component test**

Assert that all five filters show counts, the layout exposes separate list and detail regions, the first filtered item is selected, clicking another item changes the detail, and a zero-count filter remains visible.

- [x] **Step 2: Run the component test and verify RED**

Run: `npm test -- tests/unit/user-tasks-workspace.test.tsx`

Expected: FAIL because `UserTasksWorkspace` does not exist.

- [x] **Step 3: Implement the two-pane visual shell**

Use one compact row per unresolved item on the left. Show kind, title, task, requester, time, and priority. Show the selected request, context, task, requester, time, and an action preview on the right. Preserve selected filter while switching items.

- [x] **Step 4: Connect the workspace and remove the duplicate overlay journey**

Replace the temporary `AttentionList` branch under `active === 'user-tasks'`. Keep Home attention item behavior unchanged. Update the app journey test so selecting a workspace item reveals the inline detail instead of `AttentionDetail`.

- [x] **Step 5: Run one targeted test pass**

Run: `npm test -- tests/unit/user-tasks-workspace.test.tsx tests/unit/app.test.tsx tests/unit/attention-card.test.tsx`

Expected: all three files pass.

- [x] **Step 6: Build and launch the checkpoint**

Run: `npm run build:desktop`

Expected: TypeScript and renderer builds succeed. Relaunch the development Electron entry once and stop for user review.
