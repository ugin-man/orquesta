# Orquesta Desktop IA I1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the existing Home shell while exposing the approved Home, User Tasks, Records, Settings, and More information architecture for user review.

**Architecture:** Keep `DesktopRendererApp` as the workspace state owner. Replace the six workspace IDs with five approved destinations, keep the existing `WorkspaceSurface` shell, and reuse current task, failure, conversation, language, operations, and Project Route content inside the new destinations. Change `AttentionCard` into the Home User Tasks summary without changing its canonical data source.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, Lucide React, Electron renderer CSS.

## Global Constraints

- Do not change the circular Home map, role topology, colors, paper texture, or desktop window shell.
- Do not run long interaction, memory, pointer, packaged, or full-suite checks in I1.
- Show all four User Tasks counts even when each count is zero.
- Keep Team Management only inside the Map.
- Keep Project Route under More.
- Settings owns language, Operations, and Diagnostics.
- Records owns Task, Error, Conversation, Decision, and Timeline entry points, but I1 may reuse the current partial content and label unfinished modes honestly.
- Stop after one targeted test pass and one visual launch checkpoint for user review.

---

### Task 1: Replace the six-item workspace dock

**Files:**
- Modify: `apps/orquesta-desktop/src/renderer/features/navigation/WorkspaceDock.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/features/i18n/messages.ts`
- Modify: `apps/orquesta-desktop/src/renderer/styles/global.css`
- Test: `apps/orquesta-desktop/tests/unit/workspace-dock.test.tsx`

**Interfaces:**
- Produces: `WorkspaceId = 'home' | 'user-tasks' | 'records' | 'settings' | 'more'`
- Produces: `WorkspaceCounts = { userTasks: number }`
- Produces: visible labels for User Tasks, Records, Settings, and More in English and Japanese.

- [x] **Step 1: Write the failing dock test**

Change the test expectation to five buttons in the order `home`, `user-tasks`, `records`, `settings`, `more`. Assert only `user-tasks` has a numeric badge and selecting Records calls `onSelect('records')`.

- [x] **Step 2: Run the dock test and verify RED**

Run: `npm test -- tests/unit/workspace-dock.test.tsx`

Expected: FAIL because the current dock still exposes six legacy workspace IDs.

- [x] **Step 3: Implement the five-item dock**

Use `House`, `ListChecks`, `LibraryBig`, `Settings`, and `CircleEllipsis`. Add a small CSS separator before Settings with `.workspace-dock-item[data-workspace="settings"] { margin-left: 5px; }` and a `::before` divider.

- [x] **Step 4: Run the dock test and verify GREEN**

Run: `npm test -- tests/unit/workspace-dock.test.tsx`

Expected: PASS.

### Task 2: Turn Home Attention into a User Tasks summary

**Files:**
- Modify: `apps/orquesta-desktop/src/renderer/features/attention/AttentionCard.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/features/i18n/messages.ts`
- Test: `apps/orquesta-desktop/tests/unit/attention-card.test.tsx`

**Interfaces:**
- Produces: `onOpenKind(kind: UserActionKind): void`
- Keeps: `summarizeAttention(items)` as the one count source for Home and User Tasks.

- [x] **Step 1: Write failing summary tests**

Assert the Japanese title is `ユーザータスク 6`, all four labels appear including `承認 0`, only three priority items appear, and clicking `質問 2` calls `onOpenKind('answer')`. Add an empty-data test that still shows `質問 0`, `承認 0`, `確認 0`, and `手動作業 0`.

- [x] **Step 2: Run the AttentionCard test and verify RED**

Run: `npm test -- tests/unit/attention-card.test.tsx`

Expected: FAIL because zero counts are hidden, five items are rendered, and counts are not buttons.

- [x] **Step 3: Implement the User Tasks summary**

Rename visible copy only; retain internal attention contracts. Render four count buttons for `answer`, `approve`, `review`, and `do`, render at most three items, keep the card visible in its empty state, and remove the Home history footer because resolved items belong in Records.

- [x] **Step 4: Run the AttentionCard test and verify GREEN**

Run: `npm test -- tests/unit/attention-card.test.tsx`

Expected: PASS.

### Task 3: Connect the new workspace shells and direct routes

**Files:**
- Modify: `apps/orquesta-desktop/src/renderer/app/DesktopRendererApp.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/features/navigation/WorkspaceSurface.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/features/project/ProjectLauncher.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/styles/global.css`
- Modify: `apps/orquesta-desktop/src/renderer/features/i18n/messages.ts`
- Test: `apps/orquesta-desktop/tests/unit/app.test.tsx`

**Interfaces:**
- `WorkspaceSurface` consumes `active: 'user-tasks' | 'records' | 'settings' | 'more'`.
- `WorkspaceSurface` consumes `initialUserTaskKind?: UserActionKind` and `initialRecordKind?: 'task' | 'error' | 'conversation' | 'decision' | 'timeline'`.
- Home User Tasks counts set the active workspace and selected kind.
- Composer history opens Records with Conversation selected.

- [x] **Step 1: Write failing app journey tests**

Assert the persistent dock exposes Home, User Tasks, Records, Settings, and More. Assert clicking User Tasks opens its heading, clicking Records exposes the five internal modes, clicking Settings exposes Display language and Diagnostics, and More contains Project Route but not Team Management. Assert Project Launcher no longer contains Project Route. Assert Composer history opens Records with Conversation selected.

- [x] **Step 2: Run the app test and verify RED**

Run: `npm test -- tests/unit/app.test.tsx`

Expected: FAIL because the legacy Tasks, Failures, Conversation, and More surfaces are still separate.

- [x] **Step 3: Implement the workspace shells**

In User Tasks, reuse the current unresolved attention list and add visible filters for All, Questions, Approvals, Reviews, and Manual work. In Records, add visible mode buttons and reuse the current TaskList, failure list, and ConversationList for the first three modes; label Decision and Timeline as not yet built for I1. In Settings, place language, Operations, and Diagnostics. In More, keep Project Route only. Remove the duplicate Team Management callback from `WorkspaceSurface` and remove Project Route from `ProjectLauncher`.

- [x] **Step 4: Connect Home direct routes**

Make Home header open User Tasks All, count buttons open the matching User Tasks kind, Now `すべて見る` open Records Task, and Composer history load the current conversation then open Records Conversation.

- [x] **Step 5: Run the three targeted files once**

Run: `npm test -- tests/unit/workspace-dock.test.tsx tests/unit/attention-card.test.tsx tests/unit/app.test.tsx`

Expected: 3 files pass with no failures.

- [x] **Step 6: Build and launch one user checkpoint**

Run: `npm run build:desktop`

Expected: TypeScript and renderer build succeed. Launch the existing desktop development entry once, then stop automated verification and ask the user to inspect the visible Home, dock, User Tasks, Records, Settings, and More surfaces.
