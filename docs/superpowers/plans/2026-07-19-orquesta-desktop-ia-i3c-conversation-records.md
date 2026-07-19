# Orquesta Desktop IA I3C Conversation Records Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the temporary single-channel conversation list with a two-pane conversation workspace that makes logical targets and the real coordinator-thread route distinct.

**Architecture:** Keep the existing canonical `listConversation(targetAgentId)` query and project-owned coordinator thread. Add a focused `ConversationRecordsWorkspace` that uses the current agent projection as the logical channel index, switches history through the existing callback, and labels the actual route honestly as the coordinator Codex thread plus the selected `agent_id` route. Keep the shared Composer below the workspace and synchronize its target when the channel changes.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, existing Codex App Server conversation projection.

## Global Constraints

- Reuse the approved Records workspace, five large record tabs, and shared Composer.
- Do not claim that each agent owns a separate Codex thread. The current runtime uses one project coordinator thread.
- Do not display a fabricated thread ID, unread count, or delivery success state.
- The whole application shell stays fixed. Only the channel list and message pane scroll.
- Channel switching must update the shared Composer target and must not leak the previous channel's messages while loading.
- Use one focused app test, one desktop build, one Windows package update, then stop for user review.

---

### Task 1: Define the conversation workspace behavior in one app test

**Files:**
- Modify: `apps/orquesta-desktop/tests/unit/app.test.tsx`

**Interfaces:**
- `ConversationRecordsWorkspace` consumes `agents`, `targetAgentId`, `messages`, `loading`, `hasOlder`, `onSelectTarget`, and `onLoadOlder`.
- Selecting a logical channel invokes `onSelectTarget(agentId)`.
- The right header always shows the logical destination separately from `Coordinator Codex thread`.

- [x] **Step 1: Replace the narrow conversation test with the full user flow**

Open `Records > Conversation`, verify the channel search and grouped Coordinator/Agent routes, select Analyst inside the workspace, verify the Composer target changes to Analyst, verify Analyst history loads, and verify the route header says the message is delivered through the coordinator Codex thread with `agent_id=analyst`.

- [x] **Step 2: Run the focused test and verify RED**

Run: `npm test -- tests/unit/app.test.tsx -t "uses the conversation workspace"`

Expected: FAIL because the temporary conversation pane has no channel navigation or route header.

### Task 2: Build and integrate the two-pane conversation workspace

**Files:**
- Create: `apps/orquesta-desktop/src/renderer/features/records/ConversationRecordsWorkspace.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/features/navigation/WorkspaceSurface.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/app/DesktopRendererApp.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/styles/global.css`
- Modify: `docs/superpowers/specs/2026-07-19-orquesta-desktop-information-architecture-design.md`

**Interfaces:**

```ts
export interface ConversationRecordsWorkspaceProps {
  agents: AgentUiModel[];
  targetAgentId: string;
  messages: ConversationMessage[];
  loading: boolean;
  hasOlder: boolean;
  onSelectTarget(agentId: string): void;
  onLoadOlder(): void;
}
```

- [x] **Step 1: Implement the visual shell**

The left pane contains a search input, a Coordinator group, and an Agent routes group. Each row shows display name, role, and current agent state without adding unread badges. The right header renders:

```text
Logical target: <display name> (<agent id>)
Actual delivery: Coordinator Codex thread
Route: direct coordinator message | agent_id=<agent id>
```

The message pane reuses the current author, timestamp, evidence label, older-message action, and empty state. System messages remain visibly distinct inside the selected logical route.

- [x] **Step 2: Synchronize channel selection and Composer**

`openConversation(agentId)` immediately selects that logical target, clears stale messages, sets a dedicated initial-loading state, and updates the shared Composer target. A delayed response is still ignored through the existing request counter. Target changes from either the workspace or Composer use the same function.

- [x] **Step 3: Run the focused test and verify GREEN**

Run: `npm test -- tests/unit/app.test.tsx -t "uses the conversation workspace"`

Expected: PASS.

- [x] **Step 4: Build, package, and launch once**

Run `npm run build:desktop`, replace the Windows x64 package, launch it, and stop for user review. Update the IA matrix for conversation history and conversation switching to `implemented, awaiting user review`.
