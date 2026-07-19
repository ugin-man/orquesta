# Orquesta Desktop IA I3B Error Records Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the temporary current-error list with a canonical error history that exposes recurrence, last occurrence, and repair results.

**Architecture:** Project the existing `.orquesta/failures/incidents.json`, `incident_candidates.json`, and `incident_clusters.json` ledgers into bounded `FailureUiModel[]` records inside the repository snapshot. Render those records in a dedicated `FailureRecordsWorkspace` with error-specific filters, a compact comparison list, and a readable detail pane. Keep User Tasks separate: an error that needs user action may appear there too, but error history is not derived from the unresolved User Tasks queue.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, Electron repository reader, existing canonical Orquesta failure ledgers.

## Global Constraints

- Reuse the approved Records workspace and its five large type tabs.
- Do not add another top-level workspace or duplicate User Tasks.
- Do not infer an accepted incident from a candidate. Candidate and cluster provenance stays visible.
- Use canonical `occurrence_count` for a cluster and canonical ledger rows for occurrence detail.
- Read-only display only. Incident acceptance, repair execution, and resolution mutation are outside I3B.
- Keep the whole application shell fixed; only the error workspace list and detail sections scroll.
- Run the focused projection/component/app tests once, one desktop build, one Windows package update, then stop for user review.

---

### Task 1: Project canonical failure ledgers

**Files:**
- Modify: `apps/orquesta-desktop/src/contracts/orquesta-ui.ts`
- Modify: `apps/orquesta-desktop/electron/core/repository-reader.ts`
- Modify: `apps/orquesta-desktop/electron/core/repository-reader.test.ts`

**Interfaces:**

```ts
export type FailureUiSeverity = 'low' | 'medium' | 'high' | 'blocker' | 'unknown';
export type FailureUiResolution = 'open' | 'resolved' | 'unknown';
export type FailureUiSource = 'incident' | 'candidate' | 'cluster';

export interface FailureOccurrenceUi {
  id: string;
  source: 'incident' | 'candidate';
  status: string;
  summary: string;
  occurredAt: string | null;
  taskId: string | null;
  sourceAgentId: string | null;
  evidence: string[];
  attemptedFixes: string[];
  outcome: string | null;
}

export interface FailureUiModel {
  id: string;
  source: FailureUiSource;
  failureClass: string;
  title: string;
  summary: string;
  severity: FailureUiSeverity;
  status: string;
  resolution: FailureUiResolution;
  occurrenceCount: number;
  firstOccurredAt: string | null;
  lastOccurredAt: string | null;
  taskIds: string[];
  sourceAgentIds: string[];
  suspectedOwner: string | null;
  repairStatus: string | null;
  cause: string | null;
  fix: string | null;
  prevention: string[];
  evidence: string[];
  occurrences: FailureOccurrenceUi[];
}
```

`OrquestaUiSnapshot` produces `failures: FailureUiModel[]`. `RepositoryDocuments` consumes optional `incidentCandidates` and `incidentClusters` documents in addition to `incidents`.

- [x] **Step 1: Write the failing projection test**

Add accepted incidents, two candidates with one fingerprint, and an explicit cluster. Assert that the snapshot keeps accepted/candidate provenance, uses the cluster occurrence count, derives first and last occurrence, preserves repair evidence, and does not put non-user-action incidents into `attention`.

- [x] **Step 2: Run the reader test and verify RED**

Run: `npm test -- electron/core/repository-reader.test.ts`

Expected: FAIL because `OrquestaUiSnapshot.failures` and the two candidate/cluster documents are not projected.

- [x] **Step 3: Implement the bounded projection**

Add pure helpers with these responsibilities:

```ts
function failureSeverity(value: unknown): FailureUiSeverity;
function failureResolution(value: unknown): FailureUiResolution;
function projectFailures(documents: RepositoryDocuments): FailureUiModel[];
```

Create explicit cluster records first and consume only referenced candidate/incident IDs. Group remaining accepted incidents by `failure_class`. Group remaining active candidates by `global_fingerprint` or their own ID. Exclude `noise` and `retired` candidates from active records, but never relabel a candidate as an accepted incident. Sort records by unresolved first, severity, then last occurrence.

Read both optional files through the existing confined UTF-8 JSON path:

```text
.orquesta/failures/incident_candidates.json
.orquesta/failures/incident_clusters.json
```

- [x] **Step 4: Run the reader test and verify GREEN**

Run: `npm test -- electron/core/repository-reader.test.ts`

Expected: PASS.

### Task 2: Build the error-specific Records workspace

**Files:**
- Create: `apps/orquesta-desktop/src/renderer/features/records/FailureRecordsWorkspace.tsx`
- Create: `apps/orquesta-desktop/tests/unit/failure-records-workspace.test.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/styles/global.css`
- Modify: `apps/orquesta-desktop/src/fixtures/helpers.ts`
- Modify: `apps/orquesta-desktop/src/fixtures/active-project.ts`

**Interfaces:**

```ts
export type FailureRecordScope = 'open' | 'repeated' | 'resolved' | 'all';
export type FailureRecordSort = 'last_desc' | 'occurrences_desc' | 'severity_desc';

export interface FailureRecordView {
  scope: FailureRecordScope;
  query: string;
  severity: FailureUiSeverity | 'all';
  sort: FailureRecordSort;
  selectedFailureId: string | null;
}

export function createDefaultFailureRecordView(): FailureRecordView;
```

- [x] **Step 1: Write the failing component test**

Cover the default unresolved view, four equal scope buttons in the order Unresolved, Repeated, Resolved, All, class/title/task search, severity filter, recurrence sort, selected-row detail, occurrence history, repair result, and the zero-result state.

- [x] **Step 2: Run the component test and verify RED**

Run: `npm test -- tests/unit/failure-records-workspace.test.tsx`

Expected: FAIL because `FailureRecordsWorkspace` does not exist.

- [x] **Step 3: Implement the workspace**

Use a fixed header plus locally scrolling body. The main area uses a compact single list and a right detail pane:

```text
Error class / summary | Severity | State | Count | Last occurrence | Repair
```

Do not use the task two-column card grid. Keep occurrence count and last occurrence aligned across rows. The detail pane shows provenance, affected tasks and agents, cause, current or completed fix, evidence, prevention, and every bounded occurrence. Candidate records must display `候補` or `Candidate` rather than `Incident`.

- [x] **Step 4: Run the component test and verify GREEN**

Run: `npm test -- tests/unit/failure-records-workspace.test.tsx`

Expected: PASS.

### Task 3: Integrate per-project error view state

**Files:**
- Modify: `apps/orquesta-desktop/src/renderer/features/navigation/WorkspaceSurface.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/app/DesktopRendererApp.tsx`
- Modify: `apps/orquesta-desktop/tests/unit/app.test.tsx`
- Modify: `docs/superpowers/specs/2026-07-19-orquesta-desktop-information-architecture-design.md`

**Interfaces:**

- `WorkspaceSurface` consumes `failureRecordView` and `onFailureRecordViewChange`.
- `DesktopRendererApp` owns one `FailureRecordView` for the selected project and resets it only when the project ID changes.
- `Records > Errors` renders `FailureRecordsWorkspace` from `snapshot.failures`, never from `snapshot.attention`.

- [x] **Step 1: Write the failing app test**

Open Records, switch to Errors, assert that canonical history includes resolved records not present in User Tasks, select a repeated record, and verify its recurrence and repair details remain visible.

- [x] **Step 2: Run the focused app test and verify RED**

Run: `npm test -- tests/unit/app.test.tsx`

Expected: FAIL because Errors still renders only unresolved error/repair attention items.

- [x] **Step 3: Connect the controlled view**

Replace the temporary `AttentionList` branch for `recordKind === 'error'`. Preserve the Error view when switching among Records types. Reset the Error view only for a different project. Update the implementation matrix rows for error history and main switching to `implemented, awaiting user review`.

- [x] **Step 4: Run the focused verification and package**

Run:

```text
npm test -- electron/core/repository-reader.test.ts tests/unit/failure-records-workspace.test.tsx tests/unit/app.test.tsx
npm run build:desktop
electron-forge package --platform win32 --arch x64
```

Expected: focused tests and desktop build pass, and the Windows package is replaced. Launch the packaged real repository once and stop for user review.
