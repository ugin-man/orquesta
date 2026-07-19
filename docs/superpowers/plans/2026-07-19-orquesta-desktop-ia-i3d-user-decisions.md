# Orquesta Desktop IA I3D User Decisions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the User Decisions preview with a readable, filterable history of resolved questions, approvals, reviews, and manual work.

**Architecture:** Reuse the existing `listAttentionHistory()` bridge and `AttentionUiItem` projection. Add a focused `DecisionRecordsWorkspace` with five large filters, a compact one-column history list, and a separate detail pane. Do not invent decision makers or change summaries that are absent from the projection; label those fields as not recorded.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, existing Electron attention-history IPC.

## Global Constraints

- Reuse the approved Records shell and persistent Composer.
- Keep the whole desktop shell fixed; only the decision list and detail pane scroll.
- Filters are All, Answers, Approvals, Reviews, and Manual work.
- List rows show kind, decision, resolved time, related task, and decision maker state.
- Details show the original request, recorded decision, related context, and recorded change outcome.
- Missing source fields are shown as not recorded; no values are fabricated.
- Use one focused app test, one desktop build, one Windows x64 package update, then stop for user review.

---

### Task 1: Define the User Decisions flow

**Files:**
- Modify: `apps/orquesta-desktop/tests/unit/app.test.tsx`

- [x] **Step 1: Write one failing user-flow test**

Open `Records > Decisions`, verify all five filters and their counts, select a resolved question, and verify the detail contains the original request, the recorded answer, its related task, and an explicit missing-change message.

- [x] **Step 2: Run the focused test and verify RED**

Run: `npm test -- tests/unit/app.test.tsx -t "shows resolved user decisions"`

Expected: FAIL because Decisions still renders the preview placeholder.

### Task 2: Build and integrate the decision workspace

**Files:**
- Create: `apps/orquesta-desktop/src/renderer/features/records/DecisionRecordsWorkspace.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/features/navigation/WorkspaceSurface.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/app/DesktopRendererApp.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/styles/global.css`
- Modify: `docs/superpowers/specs/2026-07-19-orquesta-desktop-information-architecture-design.md`

**Interfaces:**

```ts
export type DecisionRecordKind = UserActionKind | 'all';

export interface DecisionRecordsWorkspaceProps {
  items: AttentionUiItem[];
  agents: AgentUiModel[];
  selectedKind: DecisionRecordKind;
  loading: boolean;
  onSelectKind(kind: DecisionRecordKind): void;
}
```

- [x] **Step 1: Implement the five filters, list, and detail pane**

Sort by `resolvedAt ?? createdAt`, newest first. Use `actionKind` for filters. Show `resolutionLabel` as the recorded decision and use honest empty copy for absent decision maker or outcome fields.

- [x] **Step 2: Load canonical history when Decisions opens**

Add decision-history state to `DesktopRendererApp`. Opening Decisions immediately selects the workspace, clears stale project history, and calls `bridge.listAttentionHistory()`. Ignore delayed results after a project change through a request counter.

- [x] **Step 3: Run the focused test and verify GREEN**

Run: `npm test -- tests/unit/app.test.tsx -t "shows resolved user decisions"`

Expected: PASS.

- [x] **Step 4: Build, package, and launch once**

Run `npm run build:desktop`, replace the Windows x64 package, launch it, and stop for user review. Mark the User Decisions matrix row as `implemented, awaiting user review`.
