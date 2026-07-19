# Orquesta Desktop Records Review Revision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the user review by making Errors use the Task-style card/modal flow and bounding Timeline DOM rendering to 200-record increments.

**Architecture:** Keep the existing failure and timeline data contracts. `FailureRecordsWorkspace` changes presentation only; `TimelineRecordsWorkspace` keeps the complete filtered array for counts and navigation but slices the rendered rows. True cursor-backed aggregation remains outside this checkpoint.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, existing Renderer bridge contracts.

## Global Constraints

- Do not change Conversation, User Decisions, Settings, or repository projections.
- Errors use summary counts, one compact toolbar, a two-column card grid, and a modal detail.
- Error scope remains `open | repeated | resolved | all` and persists while switching record types.
- Timeline renders 200 rows initially and adds at most 200 per user action.
- Timeline filters reset the render limit to 200.
- Do not add a virtualization dependency or cursor API in this checkpoint.
- Run the two focused review-revision tests together, one desktop build, and one Windows package update, then stop for user review.

---

### Task 1: Define the revised visible behavior

**Files:**
- Modify: `apps/orquesta-desktop/tests/unit/app.test.tsx`

- [x] **Step 1: Write the failing Errors review test**

Open Records > Errors, select Resolved from the compact scope select, verify the two-column grid remains visible, open the encoding error in a dialog, close it from the backdrop, switch record types, and verify the Resolved scope persists.

- [x] **Step 2: Write the failing Timeline limit test**

Provide 450 task snapshots through `MockOrquestaBridge`, open Timeline, verify it reports `200 of 457 events`, click `Show 200 more`, and verify `400 of 457 events`.

- [x] **Step 3: Run both tests and verify RED**

Run: `npm test -- tests/unit/app.test.tsx -t "review revision"`

Expected: both fail because Errors still use fixed split detail and Timeline renders every filtered record.

### Task 2: Implement the Errors card/modal flow

**Files:**
- Modify: `apps/orquesta-desktop/src/renderer/features/records/FailureRecordsWorkspace.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/styles/global.css`

- [x] **Step 1: Replace scope cards with summary and toolbar select**

Keep all four counts visible as non-interactive summary text. Add scope between the shorter search field and severity/sort selects.

- [x] **Step 2: Replace split list/detail with two-column cards and modal**

Cards show source, class, title, severity, occurrence count, last occurrence, affected task, and repair state. Preserve `selectedFailureId`; render `FailureDetail` inside a modal backdrop and support backdrop, close button, and Escape.

### Task 3: Bound Timeline DOM rendering

**Files:**
- Modify: `apps/orquesta-desktop/src/renderer/features/records/TimelineRecordsWorkspace.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/styles/global.css`

- [x] **Step 1: Add the 200-row render window**

Keep `visibleRecords` as the complete filtered set. Render `visibleRecords.slice(0, renderLimit)` and reset `renderLimit` to 200 whenever kind, period, agent, or task query changes.

- [x] **Step 2: Add count and load-more controls**

Display current rendered count separately from total filtered count. When records remain, add one locally positioned button that increases the limit by 200 without moving to another screen.

- [x] **Step 3: Run both review tests and verify GREEN**

Run: `npm test -- tests/unit/app.test.tsx -t "review revision"`

Expected: 2 tests pass.

- [x] **Step 4: Build, package, and stop**

Run `npm run build:desktop`, replace the Windows x64 package, commit the checkpoint, and hand the exact executable plus review points to the user. Do not run the full suite before this user checkpoint.
