# Orquesta On-Demand Inspection Agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Team Managementから青い外部比較と赤い敵対監査を読み取り専用で起動し、実行中だけMapへ表示して、完了後に検査レポートを記録画面へ残す。

**Architecture:** 正式なAgent、Role、Team、Lineは増やさず、`.orquesta/state/inspection-runs.json`をsource of truthとする独立したInspection Runを追加する。Desktop CoreがCodex App Serverへ専用のread-only profileでturnを送り、最終応答を検証してから信頼されたCore processがMarkdownレポートを保存する。RendererはsnapshotとIPC actionだけを使い、Team Management、記録、Mapへ同じRun状態を投影する。

**Tech Stack:** TypeScript 5.7、Node.js 22、Electron 43、React 19、Vitest、Playwright、Codex App Server adapter、Lucide React

## Global Constraints

- 二つの起動テンプレートは常設するが、正式組織のAgentとして登録しない。
- `roles.json`、`agents.json`、`organization.json`、`sessions.json`、通常の`tasks.json`へ書き込まない。
- Inspection threadは`sandbox: "read-only"`、`approvalPolicy: "never"`で作成する。
- 外部比較だけ`webSearchMode: "live"`、敵対監査は`webSearchMode: "disabled"`とする。
- live Web探索を適用できない外部比較は`failed/source_unavailable`にし、ローカル知識で代用しない。
- 通常Composerと専門家threadのruntime profileは変更しない。
- 同じProjectで同じ種類のInspection Runを同時に二つ起動しない。
- Agent自身はレポートファイルを書かず、Desktop Coreだけが`.orquesta/reports/inspections/<run-id>.md`へ保存する。
- 生成画像は発光、色、左右配置、カードの縦横比だけの参考とし、現行Desktopの寸法と余白を優先する。
- 外部比較は青、統括者の左。敵対監査は赤、統括者の右。通常Agentと同じ外寸にする。
- 光量変化は2.8秒、位置移動と常時回転は使わず、`prefers-reduced-motion`では停止する。
- 既存のdirty worktreeを保ち、各commitではこの計画に列挙したファイルだけをstageする。

---

## File Structure

### New files

- `apps/orquesta-desktop/electron/core/inspection-run-store.ts` — versioned stateの検証、原子的保存、report pathの生成。
- `apps/orquesta-desktop/electron/core/inspection-run-controller.ts` — 起動、通知処理、中止、回復、レポート検証を担当。
- `apps/orquesta-desktop/electron/core/inspection-prompts.ts` — 二種類のpromptと構造化出力契約。
- `apps/orquesta-desktop/electron/core/inspection-run-store.test.ts` — stateとpath confinementのテスト。
- `apps/orquesta-desktop/electron/core/inspection-run-controller.test.ts` — lifecycle、boundary、report検証のテスト。
- `apps/orquesta-desktop/src/renderer/features/team/InspectionTemplateCard.tsx` — Team Management用の横長起動カード。
- `apps/orquesta-desktop/src/renderer/features/records/InspectionRecordsWorkspace.tsx` — 検査履歴、filter、詳細modal。
- `apps/orquesta-desktop/src/renderer/features/map/inspection-layout.ts` — 統括者左右の一時node位置を計算。
- `apps/orquesta-desktop/src/fixtures/inspection-running.ts` — blue/red active runのvisual fixture。
- `apps/orquesta-desktop/tests/unit/inspection-template-card.test.tsx` — 起動、中止、report導線のテスト。
- `apps/orquesta-desktop/tests/unit/inspection-records-workspace.test.tsx` — filterとreport表示のテスト。
- `apps/orquesta-desktop/tests/unit/inspection-layout.test.ts` — 左右配置と既存layout非変更のテスト。
- `apps/orquesta-desktop/tests/electron/inspection-runtime.spec.ts` — Desktop IPCからreport保存までのsmoke test。

### Existing files to modify

- `packages/codex-adapter/src/app-server-adapter.js`
- `packages/codex-adapter/test/app-server-adapter.test.js`
- `apps/orquesta-desktop/src/contracts/orquesta-ui.ts`
- `apps/orquesta-desktop/src/contracts/bridge.ts`
- `apps/orquesta-desktop/electron/core/protocol.ts`
- `apps/orquesta-desktop/electron/core/desktop-codex-service.ts`
- `apps/orquesta-desktop/electron/core/desktop-codex-service.test.ts`
- `apps/orquesta-desktop/electron/core/core-runner.ts`
- `apps/orquesta-desktop/electron/core/repository-reader.ts`
- `apps/orquesta-desktop/electron/core/repository-reader.test.ts`
- `apps/orquesta-desktop/electron/core/repository-runtime.ts`
- `apps/orquesta-desktop/electron/main/core-host.ts`
- `apps/orquesta-desktop/electron/main/core-host.test.ts`
- `apps/orquesta-desktop/electron/main/ipc-handlers.ts`
- `apps/orquesta-desktop/electron/main/ipc-handlers.test.ts`
- `apps/orquesta-desktop/electron/shared/host-contract.ts`
- `apps/orquesta-desktop/electron/preload/host-api.ts`
- `apps/orquesta-desktop/electron/preload/host-api.test.ts`
- `apps/orquesta-desktop/src/bridges/desktop-repository-bridge.ts`
- `apps/orquesta-desktop/src/bridges/mock-bridge.ts`
- `apps/orquesta-desktop/src/renderer/app/DesktopRendererApp.tsx`
- `apps/orquesta-desktop/src/renderer/features/team/TeamManagement.tsx`
- `apps/orquesta-desktop/src/renderer/features/navigation/WorkspaceSurface.tsx`
- `apps/orquesta-desktop/src/renderer/features/map/MapViewport.tsx`
- `apps/orquesta-desktop/src/renderer/features/i18n/messages.ts`
- `apps/orquesta-desktop/src/renderer/styles/global.css`
- `apps/orquesta-desktop/src/renderer/features/map/map.css`
- `apps/orquesta-desktop/src/fixtures/index.ts`
- `apps/orquesta-desktop/tests/unit/app.test.tsx`
- `apps/orquesta-desktop/tests/unit/desktop-repository-bridge.test.ts`
- `apps/orquesta-desktop/tests/unit/map-viewport.test.ts`
- `apps/orquesta-desktop/tests/visual/home.visual.spec.ts`

---

### Task 1: Inspection State Contract and Repository Projection

**Files:**
- Create: `apps/orquesta-desktop/electron/core/inspection-run-store.ts`
- Create: `apps/orquesta-desktop/electron/core/inspection-run-store.test.ts`
- Modify: `apps/orquesta-desktop/src/contracts/orquesta-ui.ts`
- Modify: `apps/orquesta-desktop/electron/core/repository-reader.ts`
- Modify: `apps/orquesta-desktop/electron/core/repository-reader.test.ts`
- Modify: `apps/orquesta-desktop/electron/core/repository-runtime.ts`
- Modify: `apps/orquesta-desktop/src/fixtures/helpers.ts`

**Interfaces:**
- Produces: `InspectionKind`, `InspectionRunStatus`, `InspectionTargetUi`, `InspectionTemplateUiModel`, `InspectionRunUiModel`.
- Produces: `readInspectionState(rootPath)`, `writeInspectionState(rootPath, state)`, `inspectionReportPath(rootPath, runId)`.
- Changes: `OrquestaUiSnapshot` gains required `inspectionTemplates` and `inspectionRuns` arrays.

- [ ] **Step 1: Write failing persistence and projection tests**

```ts
it('returns two permanent templates and no runs when inspection state is absent', async () => {
  const snapshot = await readRepositorySnapshot(root);
  expect(snapshot.inspectionTemplates.map((item) => item.kind)).toEqual([
    'external_benchmark',
    'adversarial_audit'
  ]);
  expect(snapshot.inspectionRuns).toEqual([]);
});

it('rejects a report path that escapes the selected project', async () => {
  await expect(inspectionReportPath(root, '../escape')).rejects.toThrow(/run id/i);
});

it('writes versioned state atomically and reads it back', async () => {
  await writeInspectionState(root, { version: 1, runs: [runningRun] });
  await expect(readInspectionState(root)).resolves.toEqual({ version: 1, runs: [runningRun] });
});
```

- [ ] **Step 2: Run the focused tests and confirm failure**

Run:

```powershell
npm --prefix apps/orquesta-desktop run test -- electron/core/inspection-run-store.test.ts electron/core/repository-reader.test.ts
```

Expected: FAIL because the inspection contract, store and snapshot fields do not exist.

- [ ] **Step 3: Add exact public UI types and snapshot fields**

```ts
export type InspectionKind = 'external_benchmark' | 'adversarial_audit';
export type InspectionRunStatus =
  | 'queued' | 'running' | 'cancelling' | 'report_ready'
  | 'partial' | 'failed' | 'cancelled' | 'closed';

export interface InspectionTargetUi {
  kind: 'project' | 'line' | 'team' | 'agents';
  ids: string[];
  label: string;
}

export interface InspectionTemplateUiModel {
  kind: InspectionKind;
  displayName: string;
  summary: string;
  color: 'blue' | 'red';
  activeRunId: string | null;
  lastReportRunId: string | null;
}

export interface InspectionRunUiModel {
  runId: string;
  kind: InspectionKind;
  displayName: string;
  status: InspectionRunStatus;
  target: InspectionTargetUi;
  focus: string | null;
  threadId: string | null;
  turnId: string | null;
  reportPath: string | null;
  sourceCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}
```

Append to `OrquestaUiSnapshot`:

```ts
inspectionTemplates: InspectionTemplateUiModel[];
inspectionRuns: InspectionRunUiModel[];
```

- [ ] **Step 4: Implement the versioned state store**

The persisted shape is exact:

```ts
export interface InspectionRunRecord extends Omit<InspectionRunUiModel, 'displayName' | 'target'> {
  requestedBy: 'user';
  target: { kind: InspectionTargetUi['kind']; ids: string[] };
  startedAt: string | null;
  closedAt: string | null;
  runtimeBoundary: {
    sandbox: 'read-only';
    approvalPolicy: 'never';
    webSearchMode: 'live' | 'disabled';
  } | null;
}

export interface InspectionStateFile {
  version: 1;
  runs: InspectionRunRecord[];
}
```

Use `mkdir({recursive:true})`, write UTF-8 JSON to `inspection-runs.json.<uuid>.tmp`, then `rename` onto `.orquesta/state/inspection-runs.json`. Validate safe IDs with `/^[a-zA-Z0-9._:-]{1,128}$/u`, cap the file at 1 MiB and runs at 500, and never silently drop an invalid record.

- [ ] **Step 5: Project state into repository snapshots**

Add `inspectionRuns` to `RepositoryDocuments`, read `.orquesta/state/inspection-runs.json`, map target labels from current Project/Line/Team/Agent names, and derive templates with:

```ts
const activeStatuses = new Set<InspectionRunStatus>(['queued', 'running', 'cancelling']);
const reportStatuses = new Set<InspectionRunStatus>(['report_ready', 'partial', 'closed']);

function inspectionTemplates(runs: InspectionRunUiModel[]): InspectionTemplateUiModel[] {
  return TEMPLATE_DEFINITIONS.map((template) => ({
    ...template,
    activeRunId: runs.find((run) => run.kind === template.kind && activeStatuses.has(run.status))?.runId ?? null,
    lastReportRunId: runs.find((run) => run.kind === template.kind && reportStatuses.has(run.status) && run.reportPath)?.runId ?? null
  }));
}
```

Add `inspections` to the watched canonical directories so state transitions refresh the UI.

- [ ] **Step 6: Run the focused tests and TypeScript build**

Run:

```powershell
npm --prefix apps/orquesta-desktop run test -- electron/core/inspection-run-store.test.ts electron/core/repository-reader.test.ts electron/core/repository-runtime.test.ts
npm --prefix apps/orquesta-desktop run build
```

Expected: all selected tests PASS and the build exits 0.

- [ ] **Step 7: Commit the state contract**

```powershell
git add -- apps/orquesta-desktop/electron/core/inspection-run-store.ts apps/orquesta-desktop/electron/core/inspection-run-store.test.ts apps/orquesta-desktop/src/contracts/orquesta-ui.ts apps/orquesta-desktop/electron/core/repository-reader.ts apps/orquesta-desktop/electron/core/repository-reader.test.ts apps/orquesta-desktop/electron/core/repository-runtime.ts apps/orquesta-desktop/src/fixtures/helpers.ts
git commit -m "feat(desktop): add inspection run state contract"
```

### Task 2: Read-Only Codex Runtime and Inspection Lifecycle

**Files:**
- Create: `apps/orquesta-desktop/electron/core/inspection-prompts.ts`
- Create: `apps/orquesta-desktop/electron/core/inspection-run-controller.ts`
- Create: `apps/orquesta-desktop/electron/core/inspection-run-controller.test.ts`
- Modify: `packages/codex-adapter/src/app-server-adapter.js`
- Modify: `packages/codex-adapter/test/app-server-adapter.test.js`
- Modify: `apps/orquesta-desktop/electron/core/desktop-codex-service.ts`
- Modify: `apps/orquesta-desktop/electron/core/desktop-codex-service.test.ts`
- Modify: `apps/orquesta-desktop/electron/core/core-runner.ts`

**Interfaces:**
- Consumes: `InspectionRunRecord`, `readInspectionState`, `writeInspectionState`, `inspectionReportPath` from Task 1.
- Produces: `DesktopCodexService.startInspection`, `interruptInspection`, `readInspectionThread`.
- Produces: `InspectionRunController.start`, `cancel`, `readReport`, `handleRuntimeNotification`, `handleRuntimeApproval`, `reconcileProject`.

- [ ] **Step 1: Write adapter and service boundary tests**

```ts
it('starts an inspection thread with an isolated profile', async () => {
  await service.startInspection({
    correlationId: 'inspect-1', projectId: 'repo-1', rootPath: 'C:\\repo',
    kind: 'external_benchmark', prompt: 'inspect'
  });
  expect(adapter.createThread).toHaveBeenCalledWith(expect.objectContaining({
    params: {
      cwd: 'C:\\repo',
      sandbox: 'read-only',
      approvalPolicy: 'never',
      webSearchMode: 'live'
    }
  }));
});

it('keeps normal composer thread parameters unchanged', async () => {
  await service.sendMessage(normalSendInput);
  expect(adapter.createThread).toHaveBeenCalledWith(expect.objectContaining({ params: { cwd: 'C:\\repo' } }));
});
```

In the adapter test, make the fake `thread/start` response return `sandbox: "read-only"` and `approvalPolicy: "never"`, then assert `runtime_profile` is returned to Desktop.

- [ ] **Step 2: Run the runtime tests and confirm failure**

Run:

```powershell
node --test packages/codex-adapter/test/app-server-adapter.test.js
npm --prefix apps/orquesta-desktop run test -- electron/core/desktop-codex-service.test.ts electron/core/inspection-run-controller.test.ts
```

Expected: FAIL because the runtime profile evidence and inspection methods are absent.

- [ ] **Step 3: Preserve App Server boundary evidence**

Return these fields from adapter `createThread` and `resumeThread`:

```js
runtime_profile: {
  cwd: result.cwd ?? null,
  sandbox: result.sandbox ?? null,
  approval_policy: result.approvalPolicy ?? null,
  requested_web_search_mode: params.webSearchMode ?? null
}
```

Add `interruptTurn` to `CanonicalCodexAdapter`. `startInspection` must always create a fresh thread, compare returned sandbox and approval policy against the requested values before `startTurn`, and reject a mismatch with `read_only_boundary_violation`.

- [ ] **Step 4: Define prompts with a machine-checked final envelope**

Both prompts must end with exactly one JSON object:

```ts
export interface InspectionOutputEnvelope {
  outcome: 'report_ready' | 'partial';
  sourceCount: number;
  markdown: string;
}
```

External prompt requires URL, access date, selection reason, comparison axes, strengths, gaps, differentiation and reusable assets. Adversarial prompt requires evidence reference, severity, current impact, recommendation, change cost and no-change risk; unsupported criticism goes under a hypothesis heading.

- [ ] **Step 5: Write controller lifecycle tests**

```ts
it('does not add inspection runs to canonical organization files', async () => {
  await controller.start(startRequest);
  expect(writeFileCalls.map((call) => call.path)).toEqual([
    expect.stringMatching(/inspection-runs\.json$/u)
  ]);
});

it('saves a validated external report and closes the active node', async () => {
  await controller.start(externalRequest);
  await controller.handleRuntimeNotification(agentMessage(validExternalEnvelope));
  await controller.handleRuntimeNotification(turnCompleted);
  expect((await readInspectionState(root)).runs[0]).toMatchObject({
    status: 'report_ready', sourceCount: 2,
    reportPath: expect.stringMatching(/reports[\\/]inspections[\\/].+\.md$/u)
  });
});

it('fails external comparison when no URL is present', async () => {
  await controller.start(externalRequest);
  await controller.handleRuntimeNotification(agentMessage(envelopeWithoutUrls));
  await controller.handleRuntimeNotification(turnCompleted);
  expect((await readInspectionState(root)).runs[0]).toMatchObject({
    status: 'failed', errorCode: 'source_unavailable'
  });
});
```

Also cover duplicate kind rejection, adversarial Web disabled, cancel/interrupt, approval auto-decline plus boundary failure, invalid output, and restart reconciliation through `readInspectionThread`.

- [ ] **Step 6: Implement the controller**

The public request is:

```ts
export interface StartInspectionInput {
  projectId: string;
  rootPath: string;
  kind: InspectionKind;
  target: { kind: 'project' | 'line' | 'team' | 'agents'; ids: string[] };
  focus: string | null;
}
```

Lifecycle order:

```ts
queued -> running -> report_ready | partial | failed | cancelled -> closed
```

Persist `queued` before runtime dispatch. Capture the newest `agent_message` for the matching thread. On `turn_completed`, parse the final envelope, validate URL count for external comparison, write Markdown through the Core process, set completion fields, then leave the report-visible status in state while removing it from the active status set. On `turn_failed`, persist `runtime_turn_failed`. On approval request from an inspection thread, choose `decline` or `cancel`, interrupt the turn and persist `read_only_boundary_violation`.

- [ ] **Step 7: Wire the controller into Core without changing normal runtime notifications**

Create one controller in `runDesktopCore`. Send every runtime notification to the existing UI notification channel and to the controller. Route approvals as:

```ts
runtime.subscribeApprovals((approval) => {
  if (!inspections.handleRuntimeApproval(approval)) repository.addRuntimeApproval(approval);
});
```

On repository selection call `reconcileProject(projectId, rootPath)` once before emitting the selected snapshot.

- [ ] **Step 8: Run focused tests**

Run:

```powershell
node --test packages/codex-adapter/test/app-server-adapter.test.js
npm --prefix apps/orquesta-desktop run test -- electron/core/desktop-codex-service.test.ts electron/core/inspection-run-controller.test.ts electron/core/repository-runtime.test.ts
```

Expected: all selected tests PASS.

- [ ] **Step 9: Commit runtime lifecycle**

```powershell
git add -- packages/codex-adapter/src/app-server-adapter.js packages/codex-adapter/test/app-server-adapter.test.js apps/orquesta-desktop/electron/core/inspection-prompts.ts apps/orquesta-desktop/electron/core/inspection-run-controller.ts apps/orquesta-desktop/electron/core/inspection-run-controller.test.ts apps/orquesta-desktop/electron/core/desktop-codex-service.ts apps/orquesta-desktop/electron/core/desktop-codex-service.test.ts apps/orquesta-desktop/electron/core/core-runner.ts
git commit -m "feat(desktop): run inspections in read-only Codex threads"
```

### Task 3: Core Protocol, IPC and Renderer Bridge

**Files:**
- Modify: `apps/orquesta-desktop/electron/core/protocol.ts`
- Modify: `apps/orquesta-desktop/electron/core/protocol.test.ts`
- Modify: `apps/orquesta-desktop/electron/core/core-runner.ts`
- Modify: `apps/orquesta-desktop/electron/main/core-host.ts`
- Modify: `apps/orquesta-desktop/electron/main/core-host.test.ts`
- Modify: `apps/orquesta-desktop/electron/main/ipc-handlers.ts`
- Modify: `apps/orquesta-desktop/electron/main/ipc-handlers.test.ts`
- Modify: `apps/orquesta-desktop/electron/shared/host-contract.ts`
- Modify: `apps/orquesta-desktop/electron/preload/host-api.ts`
- Modify: `apps/orquesta-desktop/electron/preload/host-api.test.ts`
- Modify: `apps/orquesta-desktop/src/contracts/bridge.ts`
- Modify: `apps/orquesta-desktop/src/bridges/desktop-repository-bridge.ts`
- Modify: `apps/orquesta-desktop/src/bridges/mock-bridge.ts`
- Modify: `apps/orquesta-desktop/tests/unit/desktop-repository-bridge.test.ts`

**Interfaces:**
- Consumes: controller methods from Task 2.
- Produces renderer methods:

```ts
startInspection(input: StartInspectionUiInput): Promise<UiActionResult>;
cancelInspection(runId: string): Promise<UiActionResult>;
readInspectionReport(runId: string): Promise<InspectionReportUi>;
```

- [ ] **Step 1: Write failing protocol and bridge tests**

Test exact accepted input, reject `../bad` IDs, reject more than 32 agent target IDs, reject focus over 4,096 characters, and confirm all three methods traverse preload IPC with unchanged typed payloads.

```ts
expect(isCoreRequest({
  type: 'inspection.start', correlationId: 'corr-1', projectId: 'repo-1', rootPath: 'C:\\repo',
  kind: 'adversarial_audit', target: { kind: 'agents', ids: ['coder-1', 'coder-2'] }, focus: null
})).toBe(true);
```

- [ ] **Step 2: Run focused tests and confirm failure**

```powershell
npm --prefix apps/orquesta-desktop run test -- electron/core/protocol.test.ts electron/main/core-host.test.ts electron/main/ipc-handlers.test.ts electron/preload/host-api.test.ts tests/unit/desktop-repository-bridge.test.ts
```

Expected: FAIL on missing inspection messages and host methods.

- [ ] **Step 3: Add Core messages**

```ts
export type InspectionCoreRequest =
  | ({ type: 'inspection.start'; correlationId: string } & StartInspectionInput)
  | { type: 'inspection.cancel'; correlationId: string; projectId: string; rootPath: string; runId: string }
  | { type: 'inspection.read-report'; correlationId: string; projectId: string; rootPath: string; runId: string };

export type InspectionCoreEvent =
  | { type: 'inspection.action.accepted'; correlationId: string; runId: string }
  | { type: 'inspection.report.result'; correlationId: string; runId: string; markdown: string };
```

Extend `runtime.request.failed` handling so pending inspection requests reject through the same bounded error route.

- [ ] **Step 4: Add Host and IPC actions**

Add these IPC channels:

```ts
startInspection: 'orquesta.desktop.inspection.start',
cancelInspection: 'orquesta.desktop.inspection.cancel',
readInspectionReport: 'orquesta.desktop.inspection.read-report'
```

Main IPC obtains `projectId` and `rootPath` from `repositories.getCurrentRuntimeContext()`; Renderer cannot supply a different root. `readInspectionReport` returns Markdown only after controller confirms the run belongs to the selected Project and its report path remains under `.orquesta/reports/inspections`.

- [ ] **Step 5: Implement Desktop and mock bridges**

The mock bridge must update only fixture-local in-memory `inspectionRuns`, emit `snapshot_changed`, and allow visual/unit tests to exercise queued, running, cancelled and report-ready states. It must not pretend that a real Codex turn ran; generated mock reports use `evidenceLabel: "Prototype inspection"` in their Markdown header.

- [ ] **Step 6: Run focused tests and build**

```powershell
npm --prefix apps/orquesta-desktop run test -- electron/core/protocol.test.ts electron/main/core-host.test.ts electron/main/ipc-handlers.test.ts electron/preload/host-api.test.ts tests/unit/desktop-repository-bridge.test.ts tests/unit/mock-bridge.test.ts
npm --prefix apps/orquesta-desktop run build:desktop
```

Expected: tests PASS; Core and preload typecheck/build exits 0.

- [ ] **Step 7: Commit the transport layer**

```powershell
git add -- apps/orquesta-desktop/electron/core/protocol.ts apps/orquesta-desktop/electron/core/protocol.test.ts apps/orquesta-desktop/electron/core/core-runner.ts apps/orquesta-desktop/electron/main/core-host.ts apps/orquesta-desktop/electron/main/core-host.test.ts apps/orquesta-desktop/electron/main/ipc-handlers.ts apps/orquesta-desktop/electron/main/ipc-handlers.test.ts apps/orquesta-desktop/electron/shared/host-contract.ts apps/orquesta-desktop/electron/preload/host-api.ts apps/orquesta-desktop/electron/preload/host-api.test.ts apps/orquesta-desktop/src/contracts/bridge.ts apps/orquesta-desktop/src/bridges/desktop-repository-bridge.ts apps/orquesta-desktop/src/bridges/mock-bridge.ts apps/orquesta-desktop/tests/unit/desktop-repository-bridge.test.ts apps/orquesta-desktop/tests/unit/mock-bridge.test.ts
git commit -m "feat(desktop): expose inspection run actions"
```

### Task 4: Team Management Launch Cards

**Files:**
- Create: `apps/orquesta-desktop/src/renderer/features/team/InspectionTemplateCard.tsx`
- Create: `apps/orquesta-desktop/tests/unit/inspection-template-card.test.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/features/team/TeamManagement.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/app/DesktopRendererApp.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/features/i18n/messages.ts`
- Modify: `apps/orquesta-desktop/src/renderer/styles/global.css`
- Modify: `apps/orquesta-desktop/tests/unit/app.test.tsx`

**Interfaces:**
- Consumes: `snapshot.inspectionTemplates`, `snapshot.inspectionRuns`, bridge actions from Task 3.
- Produces: two always-visible cards, scoped launch input, cancel and last-report actions.

- [ ] **Step 1: Write failing Team Management tests**

```tsx
expect(screen.getByRole('heading', { name: '外部比較' })).toBeVisible();
expect(screen.getByRole('heading', { name: '敵対監査' })).toBeVisible();
await user.click(screen.getByRole('button', { name: '外部比較を起動' }));
expect(onStartInspection).toHaveBeenCalledWith({
  kind: 'external_benchmark',
  target: { kind: 'project', ids: [] },
  focus: null
});
```

Also assert a running card shows `中止`, a completed card shows `直近レポート`, and clicking either does not invoke role approval.

- [ ] **Step 2: Run focused tests and confirm failure**

```powershell
npm --prefix apps/orquesta-desktop run test -- tests/unit/inspection-template-card.test.tsx tests/unit/app.test.tsx
```

Expected: FAIL because the inspection cards and handlers do not exist.

- [ ] **Step 3: Build the horizontal capsule cards**

Use `Search` for external comparison and `ShieldAlert` for adversarial audit. Each card shows display name, one-line summary, `読み取り専用`, current state and one primary action. External card expands one optional focus text field. Adversarial card expands one scope selector; `agents` scope uses checkboxes over current agents and requires at least one selection.

Do not mix the cards into `proposal-list`. Use:

```tsx
<section className="inspection-template-section" aria-label={t('inspectionAgents')}>
  <div className="inspection-template-list">
    {templates.map((template) => (
      <InspectionTemplateCard key={template.kind} {...propsFor(template)} />
    ))}
  </div>
</section>
```

- [ ] **Step 4: Connect live state in DesktopRendererApp**

Pass snapshot templates/runs directly. After accepted start/cancel actions, rely on repository snapshot updates instead of locally inventing final state. Keep a per-card busy ID only until IPC returns. Opening a report switches to Records with `recordKind = 'inspection'` and the selected run ID.

- [ ] **Step 5: Add restrained LED styling**

Cards retain the current paper background. Blue/red is limited to the icon ring, a 3px left keyline, a small state dot and button focus ring. No black sci-fi panel, no full-card neon fill, and no image-derived absolute positions.

- [ ] **Step 6: Run focused tests and build**

```powershell
npm --prefix apps/orquesta-desktop run test -- tests/unit/inspection-template-card.test.tsx tests/unit/app.test.tsx
npm --prefix apps/orquesta-desktop run build
```

Expected: tests PASS and build exits 0.

- [ ] **Step 7: Commit Team Management UI**

```powershell
git add -- apps/orquesta-desktop/src/renderer/features/team/InspectionTemplateCard.tsx apps/orquesta-desktop/tests/unit/inspection-template-card.test.tsx apps/orquesta-desktop/src/renderer/features/team/TeamManagement.tsx apps/orquesta-desktop/src/renderer/app/DesktopRendererApp.tsx apps/orquesta-desktop/src/renderer/features/i18n/messages.ts apps/orquesta-desktop/src/renderer/styles/global.css apps/orquesta-desktop/tests/unit/app.test.tsx
git commit -m "feat(desktop): add on-demand inspection cards"
```

### Task 5: Inspection Records and Report Viewer

**Files:**
- Create: `apps/orquesta-desktop/src/renderer/features/records/InspectionRecordsWorkspace.tsx`
- Create: `apps/orquesta-desktop/tests/unit/inspection-records-workspace.test.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/features/navigation/WorkspaceSurface.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/app/DesktopRendererApp.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/features/i18n/messages.ts`
- Modify: `apps/orquesta-desktop/src/renderer/styles/global.css`

**Interfaces:**
- Consumes: `inspectionRuns`, `readInspectionReport(runId)`.
- Changes: `RecordKind` adds `'inspection'`.
- Produces: filters `all | external_benchmark | adversarial_audit | complete | failed` and report detail modal.

- [ ] **Step 1: Write failing records tests**

```tsx
expect(screen.getByRole('button', { name: '検査' })).toBeVisible();
await user.click(screen.getByRole('button', { name: '敵対監査' }));
expect(screen.getByText('AUDIT-001')).toBeVisible();
expect(screen.queryByText('BENCH-001')).not.toBeInTheDocument();
await user.click(screen.getByText('AUDIT-001'));
expect(await screen.findByRole('dialog', { name: '敵対監査レポート' })).toBeVisible();
```

Assert the modal closes by outside click and Escape, Markdown is rendered as safe text with headings/lists/links only, and report load failure leaves the run row visible with retry.

- [ ] **Step 2: Run the focused test and confirm failure**

```powershell
npm --prefix apps/orquesta-desktop run test -- tests/unit/inspection-records-workspace.test.tsx tests/unit/app.test.tsx
```

Expected: FAIL because `inspection` is not a record type.

- [ ] **Step 3: Add the Records tab and workspace**

Use the existing two-column record card density and task-style modal. The list is sorted newest first, renders at most 100 rows at once, and offers `さらに表示` in 100-row increments. Filters operate on the already projected runs and never reread the repository per keystroke.

Report Markdown rendering supports:

```ts
type ReportBlock =
  | { kind: 'heading'; level: 2 | 3; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'link'; label: string; url: string };
```

Only `http:` and `https:` links become anchors. Render all other input as text; do not use `dangerouslySetInnerHTML`.

- [ ] **Step 4: Connect direct report navigation**

Store `selectedInspectionRunId` in `DesktopRendererApp`. Team Management `直近レポート` and Records rows set this ID, switch to Records, and open the report modal through one path. Reset the selection on Project switch.

- [ ] **Step 5: Run focused tests and build**

```powershell
npm --prefix apps/orquesta-desktop run test -- tests/unit/inspection-records-workspace.test.tsx tests/unit/app.test.tsx tests/unit/workspace-dock.test.tsx
npm --prefix apps/orquesta-desktop run build
```

Expected: tests PASS and build exits 0.

- [ ] **Step 6: Commit inspection records**

```powershell
git add -- apps/orquesta-desktop/src/renderer/features/records/InspectionRecordsWorkspace.tsx apps/orquesta-desktop/tests/unit/inspection-records-workspace.test.tsx apps/orquesta-desktop/src/renderer/features/navigation/WorkspaceSurface.tsx apps/orquesta-desktop/src/renderer/app/DesktopRendererApp.tsx apps/orquesta-desktop/src/renderer/features/i18n/messages.ts apps/orquesta-desktop/src/renderer/styles/global.css
git commit -m "feat(desktop): show inspection reports in records"
```

### Task 6: Temporary Map Beacons

**Files:**
- Create: `apps/orquesta-desktop/src/renderer/features/map/inspection-layout.ts`
- Create: `apps/orquesta-desktop/tests/unit/inspection-layout.test.ts`
- Create: `apps/orquesta-desktop/src/fixtures/inspection-running.ts`
- Modify: `apps/orquesta-desktop/src/fixtures/index.ts`
- Modify: `apps/orquesta-desktop/src/renderer/features/map/MapViewport.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/features/map/map.css`
- Modify: `apps/orquesta-desktop/src/renderer/styles/global.css`
- Modify: `apps/orquesta-desktop/tests/unit/map-viewport.test.ts`
- Modify: `apps/orquesta-desktop/tests/visual/home.visual.spec.ts`

**Interfaces:**
- Consumes: active runs where status is `queued | running | cancelling`.
- Produces: `inspectionPosition(kind, orchestratorPoint, nodeWidth)`.
- Produces: map nodes with `data-node-kind="inspection"` and `data-inspection-kind`.

- [ ] **Step 1: Write failing layout and render tests**

```ts
expect(inspectionPosition('external_benchmark', { x: 500, y: 300 }, 126)).toEqual({ x: 311, y: 300 });
expect(inspectionPosition('adversarial_audit', { x: 500, y: 300 }, 126)).toEqual({ x: 689, y: 300 });
```

```tsx
expect(screen.getByRole('button', { name: /外部比較.*実行中/u })).toHaveAttribute('data-inspection-kind', 'external_benchmark');
expect(screen.getByRole('button', { name: /敵対監査.*実行中/u })).toHaveAttribute('data-inspection-kind', 'adversarial_audit');
expect(screen.getAllByTestId('inspection-edge')).toHaveLength(2);
```

Also assert the input snapshot agent count and `layout.agentPositions` are unchanged when runs are added.

- [ ] **Step 2: Run focused tests and confirm failure**

```powershell
npm --prefix apps/orquesta-desktop run test -- tests/unit/inspection-layout.test.ts tests/unit/map-viewport.test.ts
```

Expected: FAIL because inspection beacons do not exist.

- [ ] **Step 3: Add fixed overlay positions without mutating organization layout**

```ts
export function inspectionPosition(kind: InspectionKind, orchestrator: Point, nodeWidth: number): Point {
  const offset = nodeWidth * 1.5;
  return {
    x: orchestrator.x + (kind === 'external_benchmark' ? -offset : offset),
    y: orchestrator.y
  };
}
```

Do not add these points to `createStableLayout`, organization projection, manual offsets, agent count or role clusters. Compute them after `effectivePositions` from the orchestrator point. If orchestrator is absent, do not render a beacon and leave the run visible in Team Management.

- [ ] **Step 4: Render dotted edges and beacon nodes**

Use `Search` and `ShieldAlert` Lucide icons. Reuse `visualScaleForZoom` and `interactionSizeForZoom` so icons and circles shrink together at semantic zoom. Clicking a beacon opens Team Management focused on its card; it never opens `AgentDetail`.

Classes are exact:

```tsx
className={`inspection-node inspection-node--${run.kind === 'external_benchmark' ? 'blue' : 'red'}${reducedMotion ? ' is-reduced-motion' : ''}`}
```

```css
.inspection-node__ring { animation: inspection-breathe 2.8s ease-in-out infinite; }
.inspection-node.is-reduced-motion .inspection-node__ring { animation: none; }
@keyframes inspection-breathe {
  0%, 100% { opacity: .58; transform: scale(.96); }
  50% { opacity: 1; transform: scale(1.04); }
}
```

Limit animated properties to `transform`, `opacity` and `box-shadow` on compositor-friendly elements.

- [ ] **Step 5: Add the active-run fixture and visual assertions**

The fixture contains both running types and the current adaptive organization. Add one 1440x900 visual capture for Home and one Team Management capture. Assert beacon bounding boxes do not overlap the orchestrator and remain inside the map viewport at 100%, 125%, 150% and 200% display scale in the Electron map stability test.

- [ ] **Step 6: Run map and visual checks once**

```powershell
npm --prefix apps/orquesta-desktop run test -- tests/unit/inspection-layout.test.ts tests/unit/map-viewport.test.ts tests/unit/app.test.tsx
npm --prefix apps/orquesta-desktop run test:visual -- --grep "inspection"
```

Expected: unit tests PASS; two new visual snapshots pass after deliberate baseline creation. Do not regenerate unrelated screenshots.

- [ ] **Step 7: Commit Map polish**

```powershell
git add -- apps/orquesta-desktop/src/renderer/features/map/inspection-layout.ts apps/orquesta-desktop/tests/unit/inspection-layout.test.ts apps/orquesta-desktop/src/fixtures/inspection-running.ts apps/orquesta-desktop/src/fixtures/index.ts apps/orquesta-desktop/src/renderer/features/map/MapViewport.tsx apps/orquesta-desktop/src/renderer/features/map/map.css apps/orquesta-desktop/src/renderer/styles/global.css apps/orquesta-desktop/tests/unit/map-viewport.test.ts apps/orquesta-desktop/tests/visual/home.visual.spec.ts apps/orquesta-desktop/tests/visual/__screenshots__
git commit -m "feat(desktop): visualize active inspection agents"
```

### Task 7: Desktop Integration and User Review Build

**Files:**
- Create: `apps/orquesta-desktop/tests/electron/inspection-runtime.spec.ts`
- Modify: `apps/orquesta-desktop/tests/electron/fixtures/fake-codex-app-server.cjs`
- Modify: `apps/orquesta-desktop/package.json`
- Modify: `apps/orquesta-desktop/design-qa.md`

**Interfaces:**
- Consumes all preceding tasks.
- Produces one runnable Desktop build and an exact user review checklist.

- [ ] **Step 1: Write the end-to-end inspection test**

The fake App Server records `thread/start` params, emits one `agentMessage` and `turn/completed`, and supports `turn/interrupt`. The Electron test must prove:

```ts
expect(threadStart.params).toMatchObject({
  sandbox: 'read-only', approvalPolicy: 'never', webSearchMode: 'live'
});
expect(await reportFile.text()).toContain('https://example.test/competitor');
expect(await canonicalAgentsFile.text()).toBe(canonicalAgentsBefore);
expect(await canonicalTasksFile.text()).toBe(canonicalTasksBefore);
```

Then start adversarial audit and assert `webSearchMode: "disabled"`. Start and cancel another run and assert `turn/interrupt` receives the exact thread/turn IDs.

- [ ] **Step 2: Run the E2E test and fix only failures inside this feature**

```powershell
npm --prefix apps/orquesta-desktop run build:desktop
npm --prefix apps/orquesta-desktop exec playwright test --config=playwright.electron.config.ts tests/electron/inspection-runtime.spec.ts
```

Expected: PASS with report saved and canonical organization files byte-identical.

- [ ] **Step 3: Run one final proportional verification pass**

```powershell
node --test packages/codex-adapter/test/app-server-adapter.test.js
npm --prefix apps/orquesta-desktop run test -- electron/core/inspection-run-store.test.ts electron/core/inspection-run-controller.test.ts electron/core/desktop-codex-service.test.ts electron/core/protocol.test.ts electron/main/core-host.test.ts electron/main/ipc-handlers.test.ts electron/preload/host-api.test.ts tests/unit/inspection-template-card.test.tsx tests/unit/inspection-records-workspace.test.tsx tests/unit/inspection-layout.test.ts tests/unit/map-viewport.test.ts tests/unit/app.test.tsx
npm --prefix apps/orquesta-desktop run build:desktop
npm --prefix apps/orquesta-desktop exec playwright test --config=playwright.electron.config.ts tests/electron/inspection-runtime.spec.ts
```

Expected: every command exits 0. This is the only final aggregate rerun; do not repeat unrelated performance checks already proven by unchanged components.

- [ ] **Step 4: Record the user review procedure**

Append these exact checks to `apps/orquesta-desktop/design-qa.md`:

1. Team Managementに青と赤のカードが常時見える。
2. 外部比較は任意の注目点を入れて起動できる。
3. 敵対監査はProject、Line、Team、複数Agentを選べる。
4. 起動中だけ統括者の左または右に発光nodeが出る。
5. 中止するとnodeが消え、履歴にcancelledが残る。
6. 完了するとnodeが消え、記録の検査タブからMarkdownレポートを読める。
7. 外部比較にURLと確認日時がある。
8. 敵対監査の指摘に証拠、重大度、改善コストがある。
9. Team ManagementとMap以外の通常Agent数が増えていない。
10. 通常チャット送信が従来どおり動く。

- [ ] **Step 5: Commit the integrated review build**

```powershell
git add -- apps/orquesta-desktop/tests/electron/inspection-runtime.spec.ts apps/orquesta-desktop/tests/electron/fixtures/fake-codex-app-server.cjs apps/orquesta-desktop/package.json apps/orquesta-desktop/design-qa.md
git commit -m "test(desktop): verify inspection agent workflow"
```

---

## Self-Review Result

- Spec coverage: 二種類の責務、正式組織との分離、read-only runtime、live/disabled Web境界、report writer、Team Management、Map、Records、cancel、failure、restart reconciliation、reduced-motionをTask 1から7へ割り当てた。
- Placeholder scan: 実装を委ねる未確定語は残していない。入力上限、path、status、method名、test commandを固定した。
- Type consistency: `InspectionKind`、`InspectionRunStatus`、`StartInspectionInput`、三つのbridge method、`inspection` RecordKindを全Taskで同じ名前にした。
- Cost control: 各Taskは対象testだけを実行し、全体に近いaggregate checkはTask 7で一回だけ行う。
