# Orquesta Desktop IA I3A Task Records Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the temporary Records task list with the approved searchable task history workspace and large detail popup.

**Architecture:** Add a focused `TaskRecordsWorkspace` that receives canonical `TaskUiModel[]` and a controlled per-project view state from `DesktopRendererApp`. The existing Records shell stays in place. Home and Map task entry points update that view state and open `Records > Tasks`, so the grid, filters, and selected task remain consistent.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, existing Orquesta UI contracts and Electron repository snapshot.

## Global Constraints

- Preserve the approved Home, User Tasks, Records, Settings, More dock and the existing workspace dimensions.
- Default task scope is all; completed means only canonical `accepted`.
- Failed, blocked, approval-wait, and review-wait tasks remain incomplete and visibly distinct.
- Desktop task cards use two columns; opening details keeps the grid in place behind a large popup.
- Search and filters operate on the canonical snapshot and remain controlled for the current project.
- Do not add task mutation controls in this stage.
- Run one targeted test pass, one desktop build, one package update, then stop for user review.

---

### Task 1: Build the task record workspace

**Files:**
- Create: `apps/orquesta-desktop/src/renderer/features/records/TaskRecordsWorkspace.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/styles/global.css`
- Create: `apps/orquesta-desktop/tests/unit/task-records-workspace.test.tsx`

**Interfaces:**
- Produces `TaskRecordView`, `createDefaultTaskRecordView()`, and `TaskRecordsWorkspace`.
- `TaskRecordView` controls `scope`, `query`, `ownerId`, `stateGroup`, `period`, `sort`, and `selectedTaskId`.
- `TaskRecordsWorkspace` consumes canonical tasks and agents and emits the entire next view through `onViewChange`.

- [x] **Step 1: Write the failing interaction test**

Cover incomplete/completed/all counts, default exclusion of accepted tasks, ID/title search, agent/state filtering, card selection, and inline detail closing.

- [x] **Step 2: Run the component test and verify RED**

Run: `npm test -- tests/unit/task-records-workspace.test.tsx`

Expected: FAIL because `TaskRecordsWorkspace` does not exist.

- [x] **Step 3: Implement the workspace**

Use these public types:

```ts
export type TaskRecordScope = 'incomplete' | 'complete' | 'all';
export type TaskRecordStateGroup = 'all' | 'active' | 'waiting' | 'user_wait' | 'review_wait' | 'blocked' | 'complete' | 'failed';
export type TaskRecordPeriod = 'all' | '24h' | '7d' | '30d';
export type TaskRecordSort = 'updated_desc' | 'updated_asc' | 'id_asc';

export interface TaskRecordView {
  scope: TaskRecordScope;
  query: string;
  ownerId: string;
  stateGroup: TaskRecordStateGroup;
  period: TaskRecordPeriod;
  sort: TaskRecordSort;
  selectedTaskId: string | null;
}
```

Render a non-interactive summary in the order All, Completed, Incomplete. Put those choices and the detailed states into one state filter, followed by a fixed-height two-column card grid and empty results. Open task details in a large centered popup that closes by backdrop, close button, or Escape without reflowing the grid. Show task ID/title, state, owner, updated time, and one blocked/progress line on cards. Show progress, ownership, routing, dependencies, artifacts, report, acceptance checks, execution evidence, and model evidence in detail.

- [x] **Step 4: Run the component test**

Run: `npm test -- tests/unit/task-records-workspace.test.tsx`

Expected: PASS.

### Task 2: Integrate Records and deep links

**Files:**
- Modify: `apps/orquesta-desktop/src/renderer/features/navigation/WorkspaceSurface.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/app/DesktopRendererApp.tsx`
- Modify: `apps/orquesta-desktop/tests/unit/app.test.tsx`

**Interfaces:**
- `WorkspaceSurface` receives `taskRecordView` and `onTaskRecordViewChange`.
- `DesktopRendererApp.openTaskRecord(taskId)` selects Records, selects Tasks, and sets `selectedTaskId` without opening the legacy overlay.

- [x] **Step 1: Write the failing app test**

Assert that Records opens the new incomplete task grid, selecting a card opens inline detail, and a Home task entry opens Records with that task selected.

- [x] **Step 2: Run the app test and verify RED**

Run: `npm test -- tests/unit/app.test.tsx`

Expected: FAIL against the temporary one-column list and legacy task overlay.

- [x] **Step 3: Connect the controlled view and task deep links**

Keep one `TaskRecordView` in `DesktopRendererApp`, reset it only when the project ID changes, render the new workspace for `recordKind === 'task'`, and route Now, Map task chips, agent task links, and task-backed attention links through `openTaskRecord`.

- [x] **Step 4: Run one targeted pass and build**

Run: `npm test -- tests/unit/task-records-workspace.test.tsx tests/unit/app.test.tsx`

Then run: `npm run build:desktop`

Expected: both targeted test files and the desktop build pass. Package and launch the real repository once, then stop for user review.
