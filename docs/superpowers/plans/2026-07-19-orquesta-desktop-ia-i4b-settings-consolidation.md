# Orquesta Desktop IA I4B Settings Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the one-item More workspace, move Project Route into Settings, and collect read-only state under one Status & diagnostics section.

**Architecture:** Keep the existing Settings workspace and Project Route overlay. Change only top-level navigation and Settings presentation: Display remains writable, Notifications and Codex remain intentionally unconfigured shells, Startup & project owns the Project Route entry, and Status & diagnostics owns repository/runtime state plus Operations.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, Electron Forge.

## Global Constraints

- Keep Home, User Tasks, Records, and Settings as the four top-level workspaces.
- Do not change Project Route data, overlay behavior, bridge contracts, or Home layout.
- Do not invent notification, Codex, or startup settings without a write contract.
- Run one focused unit-test group, one desktop build, and one Windows x64 package update before user review.

---

### Task 1: Lock the consolidated visible journey

**Files:**
- Modify: `apps/orquesta-desktop/tests/unit/app.test.tsx`
- Modify: `apps/orquesta-desktop/tests/unit/workspace-dock.test.tsx`

**Interfaces:**
- Consumes: existing `WorkspaceDock`, `SettingsWorkspace`, Project Route overlay, and Operations overlay.
- Produces: an executable user journey proving four top-level workspaces and the new Settings locations.

- [x] **Step 1: Write the failing navigation tests**

Update the dock test to expect exactly these IDs:

```ts
expect(buttons.map((button) => button.getAttribute('data-workspace'))).toEqual([
  'home',
  'user-tasks',
  'records',
  'settings'
] satisfies WorkspaceId[]);
```

Replace the old More assertion with a flow that opens Settings, verifies that More is absent, opens Startup & project and then Project Route, and opens Status & diagnostics to inspect state and Operations.

- [x] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
npm test -- tests/unit/app.test.tsx tests/unit/workspace-dock.test.tsx -t "four workspaces|consolidates Settings"
```

Expected: fail because More still exists, Project Route is outside Settings, and runtime state is still split across sections.

### Task 2: Consolidate Settings and remove More

**Files:**
- Modify: `apps/orquesta-desktop/src/renderer/features/navigation/WorkspaceDock.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/features/navigation/WorkspaceSurface.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/features/settings/SettingsWorkspace.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/app/DesktopRendererApp.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/styles/global.css`
- Modify: `apps/orquesta-desktop/tests/visual/home.visual.spec.ts`

**Interfaces:**
- `WorkspaceId = 'home' | 'user-tasks' | 'records' | 'settings'`.
- `SettingsSection = 'display' | 'notifications' | 'codex' | 'startup' | 'status'`.
- `SettingsWorkspaceProps` gains `onOpenRoute(): void` and keeps `onOpenOperations(): void`.

- [x] **Step 1: Remove More from the persistent dock**

Delete the `more` workspace definition and label. `WorkspaceSurface.active` continues to accept every non-Home `WorkspaceId`, so no replacement route is added.

- [x] **Step 2: Put low-frequency actions in their approved Settings sections**

Use the following section behavior:

```tsx
{section === 'notifications' ? <UnconfiguredSection title={copy.notifications} detail={copy.unconfigured} /> : null}
{section === 'codex' ? <UnconfiguredSection title={copy.codex} detail={copy.unconfigured} /> : null}
{section === 'startup' ? <StartupProjectSection onOpenRoute={onOpenRoute} /> : null}
{section === 'status' ? <StatusDiagnosticsSection project={project} runtimeInfo={runtimeInfo} onReconnect={() => loadRuntime(true)} onOpenOperations={onOpenOperations} /> : null}
```

Display contains the language control only. Status & diagnostics loads cached runtime information on entry, groups all read-only repository/runtime/OS state, and keeps the existing reconnect and Operations actions.

- [x] **Step 3: Remove obsolete More styling and update the visual-test path**

Delete `.workspace-more-grid` rules. Change the visual Operations helper to open Settings, select Status & diagnostics, and then open Operations. Do not update screenshots in this checkpoint.

- [x] **Step 4: Run the focused tests and verify GREEN**

Run:

```powershell
npm test -- tests/unit/app.test.tsx tests/unit/workspace-dock.test.tsx -t "four workspaces|consolidates Settings"
```

Expected: all selected tests pass.

- [x] **Step 5: Build, package, commit, and stop for user review**

Run `npm run build:desktop`, package with `npx electron-forge package --platform win32 --arch x64`, commit the code and documents, and hand the exact executable to the user. Do not run the full suite or visual baseline in this checkpoint.
