# Orquesta Desktop IA I3E Timeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Timeline preview with one chronological, filterable view across tasks, errors, conversations, and resolved user decisions.

**Architecture:** Add an isolated `TimelineRecordsWorkspace` that projects the current task/error snapshot plus explicitly loaded conversation and decision history into normalized records. Opening Timeline loads conversation pages for the current agent routes and resolved decisions without model turns. It groups one task snapshot per task, one row per failure cluster, consecutive messages per route, and one row per user decision.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, existing Renderer bridge queries.

## Global Constraints

- Do not modify `DecisionRecordsWorkspace` while its user review is pending.
- Reuse the approved Records shell and persistent Composer.
- Keep the whole desktop shell fixed; only the timeline list scrolls.
- Filters cover kind, period, agent, and task ID.
- Do not present raw event logs as the user-facing timeline.
- Task and failure rows use canonical snapshot timestamps; missing timestamps remain visibly unknown.
- Conversation loading uses existing `listConversation()` and does not create model turns.
- Decision rows use existing `listAttentionHistory()`.
- Use one focused app test, one desktop build, one Windows x64 package update, then stop.

---

### Task 1: Define the Timeline user flow

**Files:**
- Modify: `apps/orquesta-desktop/tests/unit/app.test.tsx`

- [x] **Step 1: Write one failing flow test**

Open `Records > Timeline`, verify the five kind filters and grouped conversation row, filter to Errors, then click the error row and verify `Records > Errors` opens that error detail.

- [x] **Step 2: Run the focused test and verify RED**

Run: `npm test -- tests/unit/app.test.tsx -t "aggregates the project timeline"`

Expected: FAIL because Timeline still renders the preview placeholder.

### Task 2: Build and integrate the Timeline workspace

**Files:**
- Create: `apps/orquesta-desktop/src/renderer/features/records/TimelineRecordsWorkspace.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/features/navigation/WorkspaceSurface.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/app/DesktopRendererApp.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/styles/global.css`
- Modify: `docs/superpowers/specs/2026-07-19-orquesta-desktop-information-architecture-design.md`

**Interfaces:**

```ts
export type TimelineRecordKind = 'task' | 'error' | 'conversation' | 'decision';
export type TimelineKindFilter = TimelineRecordKind | 'all';
export type TimelinePeriod = 'all' | 'day' | 'week' | 'month';

export interface TimelineRecord {
  id: string;
  sourceId: string;
  kind: TimelineRecordKind;
  title: string;
  summary: string;
  timestamp: string | null;
  agentId: string | null;
  taskId: string | null;
  count: number;
}
```

- [x] **Step 1: Normalize and group records**

Create one record per task and failure. Group consecutive messages for the same logical route when their timestamps are within 30 minutes. Keep each resolved user decision as one record. Sort known timestamps newest first and unknown timestamps last.

- [x] **Step 2: Implement the visual timeline and filters**

Render five readable kind buttons plus period, agent, and task-ID filters. Each row shows time, kind, title, compact summary, agent, task, and grouped count. Empty and loading states remain inside the timeline pane.

- [x] **Step 3: Load history and wire primary-view navigation**

When Timeline opens, immediately show snapshot task/error rows while `listAttentionHistory()` and current agent-route `listConversation()` calls load. Ignore delayed results after project changes. Task, error, and conversation rows deep-link to their exact primary view. Decision rows open User Decisions without changing its pending-review component.

- [x] **Step 4: Run the focused test and verify GREEN**

Run: `npm test -- tests/unit/app.test.tsx -t "aggregates the project timeline"`

Expected: PASS.

- [x] **Step 5: Build, package, and prepare a review fixture**

Run `npm run build:desktop`, replace the Windows x64 package, and keep the existing `active-project` fixture available for later combined review. Mark the Timeline matrix row as `implemented, awaiting user review`.
