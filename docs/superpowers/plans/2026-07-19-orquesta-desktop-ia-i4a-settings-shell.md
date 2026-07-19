# Orquesta Desktop IA I4A Settings Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the temporary Settings card grid with the approved left-section/right-content workspace while keeping unsupported preferences visibly read-only.

**Architecture:** Add one focused `SettingsWorkspace` component. It owns only section selection and runtime-info loading; locale remains in `I18nProvider`, repository truth remains in the project snapshot, and Operations remains the existing overlay. The Records and User Tasks workspaces are not modified.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, existing Renderer bridge contracts.

## Global Constraints

- Keep the whole desktop shell fixed; only the settings content pane may scroll.
- Sections are Display, Notifications, Codex connection, Startup & project, and Details & diagnostics.
- Only settings with an existing write contract look interactive. Language is writable; unsupported notification and startup preferences are read-only.
- `getRuntimeInfo({ probe: false })` reads current Codex state. The explicit reconnect button may call `getRuntimeInfo({ probe: true })`.
- Operations stays the existing overlay and is opened only from Details & diagnostics.
- More remains Project Route only.
- Use one focused app test, one desktop build, one Windows x64 package update, then stop for user review.

---

### Task 1: Lock the visible Settings journey

**Files:**
- Modify: `apps/orquesta-desktop/tests/unit/app.test.tsx`

**Interfaces:**
- Consumes: the persistent Settings dock button.
- Produces: one user-visible journey across Display, Codex connection, and Details & diagnostics.

- [x] **Step 1: Write one failing flow test**

Add `uses sectioned settings without presenting unsupported preferences as controls`. Open Settings and assert a `Settings sections` navigation with five buttons. Confirm Display is initially selected and language controls remain available. Select Codex connection and observe truthful runtime status. Select Details & diagnostics and open the existing Operations overlay.

- [x] **Step 2: Run the focused test and verify RED**

Run: `npm test -- tests/unit/app.test.tsx -t "uses sectioned settings"`

Expected: FAIL because Settings still renders a three-card grid without section navigation.

### Task 2: Build the sectioned Settings workspace

**Files:**
- Create: `apps/orquesta-desktop/src/renderer/features/settings/SettingsWorkspace.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/features/navigation/WorkspaceSurface.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/app/DesktopRendererApp.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/styles/global.css`
- Modify: `docs/superpowers/specs/2026-07-19-orquesta-desktop-information-architecture-design.md`

**Interfaces:**

```ts
export type SettingsSection = 'display' | 'notifications' | 'codex' | 'startup' | 'details';

export interface SettingsWorkspaceProps {
  project: ProjectUiModel;
  reducedMotion: boolean;
  getRuntimeInfo(input: { probe: boolean }): Promise<RuntimeInfoUi>;
  onOpenOperations(): void;
}
```

- [x] **Step 1: Implement section navigation and truthful content**

Create a five-button left navigation and one right content pane. Display keeps the existing JA/EN control and shows detected reduced-motion state. Notifications and Startup show current application behavior as read-only rows with an explicit unavailable-setting note, not toggles. Codex loads the runtime state and provides one explicit reconnect action. Details shows repository state, root, last sync, and the Operations button.

- [x] **Step 2: Replace the temporary card grid**

Render `SettingsWorkspace` from `WorkspaceSurface`. Pass `reducedMotion` and `getRuntimeInfo` from `DesktopRendererApp`. Remove the old card-grid Settings markup and its unused icon imports. Do not change More or any Records component.

- [x] **Step 3: Add fixed-shell styling**

Use a two-column settings layout with a fixed section rail and locally scrollable content. Visually distinguish writable controls, read-only state rows, and unavailable preferences. Preserve the existing paper, line, and serif-heading visual language.

- [x] **Step 4: Run the focused test and verify GREEN**

Run: `npm test -- tests/unit/app.test.tsx -t "uses sectioned settings"`

Expected: PASS.

- [x] **Step 5: Build, package, and prepare the user checkpoint**

Run `npm run build:desktop`, replace the Windows x64 package, mark Settings as `I4A visual shell implemented, awaiting user review`, and stop. Do not run the full suite before the user checkpoint.
