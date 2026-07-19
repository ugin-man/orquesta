# Orquesta Desktop IA I2B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user answer, approve, review, or report manual work from the approved User Tasks workspace without falsely marking canonical work complete.

**Architecture:** `UserTasksWorkspace` owns draft text and transient `sending`, `pending`, `failed`, and `held` presentation state. `DesktopRendererApp` owns the side effect: runtime approvals use `resolveAttentionItem`; repository-backed work first uses the bridge resolution path and falls back to an explicit coordinator message when the repository is read-only. The item remains visible until a canonical snapshot removes it.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, Electron bridge.

## Global Constraints

- Preserve the approved Home, workspace width, two-pane layout, filters, and internal scrolling.
- Questions use free-text answers. Approvals, reviews, and manual work use explicit choices.
- Runtime approval options remain exactly those supplied by the runtime.
- Do not remove a repository-backed item locally after message acceptance.
- Preserve draft text after failure and offer retry.
- Home and User Tasks continue to count the same `snapshot.attention` array.
- Stop after one targeted test pass, one build, one package update, and one user checkpoint.

---

### Task 1: Add actionable User Task states

**Files:**
- Modify: `apps/orquesta-desktop/src/renderer/features/attention/UserTasksWorkspace.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/features/navigation/WorkspaceSurface.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/app/DesktopRendererApp.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/styles/global.css`
- Modify: `apps/orquesta-desktop/tests/unit/user-tasks-workspace.test.tsx`
- Modify: `apps/orquesta-desktop/tests/unit/app.test.tsx`

**Interfaces:**
- `UserTasksWorkspace.onSubmit(item, response)` returns `Promise<UiActionResult>`.
- Repository-backed submissions fall back to `bridge.sendMessage` only when `resolveAttentionItem` returns `unsupported`.
- Accepted submissions display `pending`; rejected or thrown submissions display `failed`; canonical snapshot removal controls the count.

- [x] **Step 1: Write failing component interaction tests**

Assert that a question has a textarea and disabled submit until text exists, shows sending while unresolved, shows pending after acceptance, preserves text and shows retry after failure, and exposes appropriate two-choice actions for review and manual work.

- [x] **Step 2: Run the component test and verify RED**

Run: `npm test -- tests/unit/user-tasks-workspace.test.tsx`

Expected: FAIL because only preview buttons exist.

- [x] **Step 3: Implement transient action state and controls**

Keep drafts by attention ID. Render runtime options verbatim. Render answer textarea for `answer`; accept/reject for `approve`; pass/request changes for `review`; complete/cannot complete for `do`. Keep held items unresolved. Disable controls while sending and preserve the current draft on failure.

- [x] **Step 4: Write and verify the app-level RED test**

Assert that resolving fixture question `A67` through `MockOrquestaBridge` removes it from the canonical snapshot and changes the dock badge from 3 to 2. Assert a desktop-style `unsupported` repository resolution falls back to `sendMessage` with the attention ID and response.

- [x] **Step 5: Connect the side effect**

Return the bridge result from `DesktopRendererApp`. Use runtime approval response for runtime items. For repository items, try repository resolution first; on `unsupported`, send a structured response to the source agent when present, otherwise the orchestrator. Return failure results to the workspace instead of hiding them in a global toast.

- [x] **Step 6: Run one targeted pass and build**

Run: `npm test -- tests/unit/user-tasks-workspace.test.tsx tests/unit/app.test.tsx`

Then run: `npm run build:desktop`

Expected: both test files and the desktop build pass. Package and launch once, then stop for user review.
