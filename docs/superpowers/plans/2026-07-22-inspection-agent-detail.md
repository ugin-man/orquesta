# Inspection Agent Detail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make temporary inspection nodes cancellable in every active state and open a dedicated detail panel from the Desktop map.

**Architecture:** Keep inspections separate from permanent agents. Route map selection by `runId` into a focused `InspectionDetail` component, while Team Management and the detail panel share the existing bridge cancellation command. Extend the controller state machine so a queued run without runtime identifiers can transition directly to `cancelled`.

**Tech Stack:** Electron, React 19, TypeScript, Vitest, Playwright Electron

## Global Constraints

- Desktop is the final target; do not use browser verification.
- Do not modify the management-agent or Luka work running in the other worktree.
- Keep completed and cancelled runs in inspection history.

---

### Task 1: Queued cancellation

**Files:**
- Modify: `apps/orquesta-desktop/electron/core/inspection-run-controller.ts`
- Test: `apps/orquesta-desktop/electron/core/inspection-run-controller.test.ts`

**Interfaces:**
- Consumes: `InspectionRunController.cancel({ projectId, rootPath, runId })`
- Produces: a terminal `cancelled` run even when a queued run has no runtime identifiers

- [ ] Add a failing test that persists a queued run with null runtime IDs and cancels it.
- [ ] Run the focused controller test and confirm the runtime-ID rejection.
- [ ] Add the direct queued-to-cancelled transition without calling the runtime interrupt method.
- [ ] Re-run the focused controller test.

### Task 2: Inspection detail panel

**Files:**
- Create: `apps/orquesta-desktop/src/renderer/features/details/InspectionDetail.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/features/map/MapViewport.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/app/DesktopRendererApp.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/styles/global.css`
- Modify: `apps/orquesta-desktop/src/renderer/features/i18n/messages.ts`
- Test: `apps/orquesta-desktop/tests/unit/map-viewport.test.ts`
- Test: `apps/orquesta-desktop/tests/unit/app.test.tsx`

**Interfaces:**
- Consumes: `InspectionRunUiModel`, `cancelInspection(runId)`, `readInspectionReport(runId)`
- Produces: `onSelectInspection(runId)` and a non-modal `InspectionDetail`

- [ ] Add a failing map test that expects the clicked inspection run ID instead of Team Management navigation.
- [ ] Add a failing app test for detail contents and cancellation.
- [ ] Change the map callback and add the dedicated detail panel.
- [ ] Re-run both focused renderer tests.

### Task 3: Desktop acceptance

**Files:**
- Modify: `apps/orquesta-desktop/tests/electron/inspection-runtime.spec.ts`

**Interfaces:**
- Consumes: the Desktop renderer and canonical inspection state file
- Produces: Electron evidence for detail opening, cancellation, and node removal

- [ ] Add an Electron scenario for clicking a running inspection, cancelling it, and observing the map node disappear.
- [ ] Build the Desktop application.
- [ ] Run only the inspection Electron test.
- [ ] Restart the Desktop application with the verified build.
