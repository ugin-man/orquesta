# Orquesta Desktop UX Recovery D1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 現在の円形HomeとElectron基盤を保持したまま、表示状態の意味、常設navigation、要対応概要、Toast、Map操作、読み込み導線をD1のユーザーレビューが可能な状態へ直す。

**Architecture:** 現行の`OrquestaUiSnapshot`、`DesktopRepositoryBridge`、overlay、Home componentを拡張し、新しいrouter、状態管理library、pagination IPCは導入しない。Homeは現在のcomponentを再配置し、専用workspaceが未完成のD1中もドック操作を無効にせず、既存snapshotから最低限の一覧を表示する。canonical stateの意味はElectron coreで一度だけ投影し、Rendererは推測し直さない。

**Tech Stack:** Electron 43、React 19、TypeScript 5.7、Vite 7、Vitest 4、Playwright、CSS

## Global Constraints

- 対象は`apps/orquesta-desktop`とし、Codex App Server、preload、typed IPC、Windows package基盤を作り直さない。
- Homeの紙質、白黒基調、円形Orquesta Map、全agent表示を保持する。
- Home全体は1366 x 768でもscrollさせず、各workspaceの一覧だけを局所scrollさせる。
- Project Status、Now、Attention、Composer、Toast、MapViewport、ProjectSwitcher、ConversationHistoryを再利用する。
- 266件規模のtaskは既存`snapshot.tasks`を使い、新しいpagination IPCをD1では作らない。
- Rendererはfilesystem、Node、Codex App Serverへ直接触れない。
- 新しいproduction behaviorは必ず失敗するtestを先に確認してから実装する。
- D1の自動検証が通っても完了扱いにせず、packaged appのユーザー確認で止める。

---

## File Structure

新しく作るfile:

- `src/renderer/features/navigation/WorkspaceDock.tsx`: Homeから常に使うworkspace navigation。
- `src/renderer/features/navigation/WorkspaceSurface.tsx`: D1時点の要対応、Tasks、Failures、その他を表示する共通surface。
- `src/renderer/features/project/ProjectLauncher.tsx`: project切替、folder追加、root表示の常設入口。
- `src/renderer/features/project/RepositoryStatusPill.tsx`: demoかどうかではなく、現在表示しているstate sourceを説明するstatus。
- `src/renderer/features/attention/attention-summary.ts`: 要対応四分類と件数計算。
- `src/renderer/features/toast/toast-queue.ts`: 重複排除、最大表示、overflow計算。

主に変更するfile:

- `src/contracts/orquesta-ui.ts`: action kindとrepository display stateを追加する。
- `electron/core/repository-reader.ts`: current task fallbackと追加user-action台帳のprojectionを直す。
- `electron/core/repository-runtime.ts`: watcherが存在するかをsnapshotへ明示する。
- `src/renderer/app/DesktopRendererApp.tsx`: Home componentの再配置とworkspace stateを管理する。
- `src/renderer/features/now/NowListOverlay.tsx`: Now cardと同じevidence filterを使う。
- `src/renderer/features/attention/AttentionCard.tsx`: 四分類の件数と上位5件だけをHomeへ表示する。
- `src/renderer/features/project/ProjectStatusCard.tsx`: project操作と言語toggleを外し、状態表示へ戻す。
- `src/renderer/features/toast/ToastStack.tsx`: 3件と`ほかN件`を表示する。
- `src/renderer/features/map/MapViewport.tsx`: world scalingとpointer lifecycleを直す。
- `src/renderer/features/project/ProjectRoute.tsx`: 現在snapshotの時刻とsourceを示す。
- `src/renderer/features/i18n/messages.ts`: 新しい日本語・英語labelを追加する。
- `src/renderer/styles/global.css`: Home配置、dock、workspace、Map icon、Toastのstyleを追加する。

---

### Task 1: canonical task truthとrepository status

**Files:**
- Modify: `apps/orquesta-desktop/src/contracts/orquesta-ui.ts`
- Modify: `apps/orquesta-desktop/electron/core/repository-reader.ts`
- Modify: `apps/orquesta-desktop/electron/core/repository-runtime.ts`
- Modify: `apps/orquesta-desktop/src/renderer/features/now/NowListOverlay.tsx`
- Modify: `apps/orquesta-desktop/src/fixtures/helpers.ts`
- Modify: `apps/orquesta-desktop/src/fixtures/active-project.ts`
- Modify: `apps/orquesta-desktop/src/fixtures/large-roster.ts`
- Modify: `apps/orquesta-desktop/src/fixtures/nested-roster.ts`
- Modify: `apps/orquesta-desktop/src/fixtures/unknown-evidence.ts`
- Modify: `apps/orquesta-desktop/src/fixtures/wide-roster.ts`
- Modify: `apps/orquesta-desktop/electron/main/repository-service.ts`
- Test: `apps/orquesta-desktop/electron/core/repository-reader.test.ts`
- Test: `apps/orquesta-desktop/electron/core/repository-runtime.test.ts`
- Test: `apps/orquesta-desktop/tests/unit/now-items.test.ts`

**Interfaces:**
- Produces: `RepositoryDisplayState = "watching" | "snapshot" | "offline" | "demo" | "error"`
- Produces: `ProjectUiModel.repositoryDisplayState`
- Consumes: existing `activeItems(agents, tasks, allowActive)`

- [ ] **Step 1: stale fallbackを再現する失敗testを書く**

`repository-reader.test.ts`へ、`agent.current_task`が空でownerの最新taskが`completed`の場合、agentの`currentTaskId`が`null`、statusが`standby`になるtestを追加する。

```ts
test('does not infer a completed review task as an agent current task', () => {
  const input = documents();
  const worker = input.agents.agents.find((agent) => agent.agent_id === 'worker');
  worker.current_task = null;
  input.tasks.tasks[0].state = 'completed';

  const snapshot = projectSnapshotFromDocuments({
    rootPath: 'C:/repo/sample', documents: input,
    now: new Date('2026-07-18T11:00:00.000Z')
  });

  expect(snapshot.agents.find((agent) => agent.id === 'worker')).toMatchObject({
    currentTaskId: null,
    status: 'standby'
  });
});
```

- [ ] **Step 2: testが古いfallback選択によって失敗することを確認する**

Run: `npm test -- electron/core/repository-reader.test.ts`

Expected: `currentTaskId`が完了taskのIDになり、testがFAILする。

- [ ] **Step 3: fallback候補をexecution stateだけに限定する**

`repository-reader.ts`へ次を追加し、`tasksByOwner`作成時に使う。

```ts
const FALLBACK_CURRENT_TASK_STATES = new Set([
  'queued', 'assigned', 'dispatch_accepted', 'turn_started',
  'in_progress', 'active', 'working', 'blocked', 'approval_wait'
]);

function rawTaskCanBeCurrentFallback(raw: JsonObject): boolean {
  return FALLBACK_CURRENT_TASK_STATES.has(string(raw.state) ?? 'unknown');
}
```

declared `current_task`はcanonical指定を尊重するが、空欄時のfallbackには`completed`、`report_ready`、review stateを使わない。

- [ ] **Step 4: Now一覧もNow cardと同じtruth functionを使う失敗testを書く**

`now-items.test.ts`へ、`currentTaskId`はあるが`report_ready`のagentが`activeItems`へ入らないtestを追加する。`NowListOverlay`内の独自filterは削除し、`activeItems`を呼ぶ。

```ts
expect(activeItems([
  agent({ status: 'report_ready', statusEvidence: 'proven', currentTaskId: 'T-review' })
], [task({ id: 'T-review', state: 'report_ready', turnStarted: true })], true)).toEqual([]);
```

Run: `npm test -- tests/unit/now-items.test.ts`

Expected: 新しいassertionはPASSし、`NowListOverlay`用component testは独自一覧の不一致でFAILする。

- [ ] **Step 5: repository表示状態をcontractへ追加する**

```ts
export type RepositoryDisplayState = 'watching' | 'snapshot' | 'offline' | 'demo' | 'error';

export interface ProjectUiModel {
  // existing fields
  repositoryDisplayState: RepositoryDisplayState;
}
```

`repository-reader`は実project読取時に`snapshot`、fixtureは`demo`、offline snapshotは`offline`を返す。`RepositoryRuntime.select()`でwatcherが一つ以上開始できた後だけ`watching`へ変更する。fixture helperと各project literal、project未選択snapshotにも対応する値を明記する。緑は`watching`だけに使い、`isDemoData === false`だけでは緑にしない。

- [ ] **Step 6: repository runtimeのwatcher testをREDからGREENへする**

```ts
test('reports watching only after at least one canonical directory watcher starts', async () => {
  const first = snapshot('repo-first', 'C:\\first');
  first.project.repositoryDisplayState = 'snapshot';
  const runtime = new RepositoryRuntime({
    readSnapshot: async () => first,
    watchDirectory: () => ({ close() {} })
  });
  const selected = await runtime.select({ projectId: 'p1', rootPath: 'C:/repo' });
  expect(selected.project.repositoryDisplayState).toBe('watching');
});
```

`watchDirectory`へerror callbackを追加する。作成済みwatcherがerrorになった場合は`repositoryDisplayState`を`snapshot`へ戻し、`connectionLabel`を`Watcher stopped`へ変えてsnapshot eventを送る。したがって緑は「実projectである」ではなく「少なくとも一つのcanonical directory watcherが現在有効である」を示す。

Run: `npm test -- electron/core/repository-reader.test.ts electron/core/repository-runtime.test.ts tests/unit/now-items.test.ts`

Expected: PASS、warning 0。

- [ ] **Step 7: Task 1をcommitする**

```powershell
git add -- apps/orquesta-desktop/src/contracts/orquesta-ui.ts apps/orquesta-desktop/electron/core/repository-reader.ts apps/orquesta-desktop/electron/core/repository-runtime.ts apps/orquesta-desktop/src/renderer/features/now/NowListOverlay.tsx apps/orquesta-desktop/src/fixtures apps/orquesta-desktop/electron/main/repository-service.ts apps/orquesta-desktop/electron/core/repository-reader.test.ts apps/orquesta-desktop/electron/core/repository-runtime.test.ts apps/orquesta-desktop/tests/unit/now-items.test.ts
git commit -m "fix(desktop): align current work with canonical evidence"
```

---

### Task 2: unified Home attention projection

**Files:**
- Modify: `apps/orquesta-desktop/src/contracts/orquesta-ui.ts`
- Modify: `apps/orquesta-desktop/electron/core/repository-reader.ts`
- Modify: `apps/orquesta-desktop/electron/core/repository-runtime.ts`
- Test: `apps/orquesta-desktop/electron/core/repository-reader.test.ts`
- Test: `apps/orquesta-desktop/electron/core/repository-runtime.test.ts`

**Interfaces:**
- Produces: `UserActionKind = "answer" | "approve" | "review" | "do"`
- Produces: `AttentionUiItem.actionKind`
- Consumes: `.orquesta/vision/questions.json`、`.orquesta/user_tasks/queue.json`、`.orquesta/failures/user_actions.json`、`.orquesta/state/dashboard_actions.json`、runtime approval

- [ ] **Step 1: 四種類を一つのattention配列へ投影する失敗testを書く**

```ts
test('projects open user-facing ledgers into four action kinds', () => {
  const input = documents();
  const snapshot = projectSnapshotFromDocuments({
    rootPath: 'C:/repo/sample',
    documents: {
      ...input,
      questions: { questions: [{ question_id: 'Q1', status: 'pending', question: 'Choose', task_id: 'T1' }] },
      userTasks: { tasks: [{ user_task_id: 'UT1', status: 'open', title: 'Run locally', prompt: 'Open the app' }] },
      userActions: { actions: [{ action_id: 'UA1', status: 'open', title: 'Repair permission', instructions: 'Grant access' }] },
      dashboardActions: { actions: [
        { action_id: 'DA1', status: 'open', kind: 'review', title: 'Review UI' },
        { action_id: 'DA2', status: 'open', kind: 'approval', title: 'Approve scope' }
      ] }
    }
  });

  expect(snapshot.attention.map((item) => item.actionKind)).toEqual(
    expect.arrayContaining(['answer', 'approve', 'review', 'do'])
  );
});
```

Run: `npm test -- electron/core/repository-reader.test.ts`

Expected: `userTasks`などが未定義、またはitemが投影されずFAILする。

- [ ] **Step 2: contractとdocument inputを追加する**

```ts
export type UserActionKind = 'answer' | 'approve' | 'review' | 'do';

export interface AttentionUiItem {
  // existing fields
  actionKind: UserActionKind;
}
```

`RepositoryDocuments`へ`userTasks`、`userActions`、`dashboardActions`を追加する。open判定は各ledgerのresolved、answered、closed、dismissedを除外する。IDが同じsource itemは一度だけ出す。

`fixtures/helpers.ts`の`attention()`には既存`AttentionType`から決定するdefault `actionKind`を入れる。runtime approval、repository projection、直接作られているfixture itemにも必ず`actionKind`を設定し、Renderer側の推測を残さない。

- [ ] **Step 3: canonical fileをbounded readへ追加する**

`readRepositorySnapshot()`で次を既存`Promise.all`へ追加する。

```ts
const userTasksPath = await confinedFile(root, path.join('.orquesta', 'user_tasks', 'queue.json'));
const userActionsPath = await confinedFile(root, path.join('.orquesta', 'failures', 'user_actions.json'));
const dashboardActionsPath = await confinedFile(root, path.join('.orquesta', 'state', 'dashboard_actions.json'));
```

`.orquesta/user_tasks`も`RepositoryRuntime.#startWatching()`対象へ追加する。

- [ ] **Step 4: sourceごとのaction kindを明示する**

- questionは`answer`
- runtime approvalは`approve`
- report review、design review、dashboard reviewは`review`
- repair、user taskは`do`
- user action不要のincidentはHome attentionへ出さない

Run: `npm test -- electron/core/repository-reader.test.ts electron/core/repository-runtime.test.ts`

Expected: PASS、既存question、incident、review task testも維持される。

- [ ] **Step 5: Task 2をcommitする**

```powershell
git add -- apps/orquesta-desktop/src/contracts/orquesta-ui.ts apps/orquesta-desktop/electron/core/repository-reader.ts apps/orquesta-desktop/electron/core/repository-runtime.ts apps/orquesta-desktop/electron/core/repository-reader.test.ts apps/orquesta-desktop/electron/core/repository-runtime.test.ts
git commit -m "feat(desktop): project unified user attention"
```

---

### Task 3: Project Launcherと常設workspace dock

**Files:**
- Create: `apps/orquesta-desktop/src/renderer/features/navigation/WorkspaceDock.tsx`
- Create: `apps/orquesta-desktop/src/renderer/features/navigation/WorkspaceSurface.tsx`
- Create: `apps/orquesta-desktop/src/renderer/features/project/ProjectLauncher.tsx`
- Create: `apps/orquesta-desktop/src/renderer/features/project/RepositoryStatusPill.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/app/DesktopRendererApp.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/features/project/ProjectStatusCard.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/features/i18n/messages.ts`
- Modify: `apps/orquesta-desktop/src/renderer/styles/global.css`
- Test: `apps/orquesta-desktop/tests/unit/app.test.tsx`
- Test: `apps/orquesta-desktop/tests/unit/workspace-dock.test.tsx`

**Interfaces:**
- Produces: `WorkspaceId = "home" | "attention" | "tasks" | "failures" | "conversation" | "more"`
- Produces: `WorkspaceDock({ active, counts, onSelect })`
- Consumes: existing project switch、conversation loading、task detail、attention open callbacks

- [ ] **Step 1: navigationの失敗testを書く**

```tsx
test('keeps frequent workspaces in one bottom interaction dock', async () => {
  const user = userEvent.setup();
  render(<DesktopRendererApp bridge={new MockRendererBridge('active-project')} initialLocale="ja" />);
  await screen.findByRole('application');

  const navigation = screen.getByRole('navigation', { name: 'ワークスペース' });
  expect(within(navigation).getByRole('button', { name: 'Home' })).toBeVisible();
  expect(within(navigation).getByRole('button', { name: /要対応/ })).toBeVisible();
  expect(within(navigation).getByRole('button', { name: 'Tasks' })).toBeVisible();
  expect(within(navigation).getByRole('button', { name: 'Failures' })).toBeVisible();
  expect(within(navigation).getByRole('button', { name: '会話' })).toBeVisible();

  await user.click(within(navigation).getByRole('button', { name: 'Tasks' }));
  expect(screen.getByRole('heading', { name: 'Tasks' })).toBeVisible();
});
```

Run: `npm test -- tests/unit/app.test.tsx tests/unit/workspace-dock.test.tsx`

Expected: navigationが存在せずFAILする。

- [ ] **Step 2: dockを実装する**

`WorkspaceDock`は6項目を固定順で出す。選択中だけ文字labelを常時表示し、未選択も`aria-label`とtooltipを持つ。badgeは要対応合計、Tasksのblocked+review、Failuresのopen error、会話未読だけに使う。

```ts
export type WorkspaceId = 'home' | 'attention' | 'tasks' | 'failures' | 'conversation' | 'more';

export interface WorkspaceCounts {
  attention: number;
  tasks: number;
  failures: number;
  conversation: number;
}
```

- [ ] **Step 3: Project Launcherを左上へ実装する**

表示と操作:

- 現在project名
- project switcherを開く
- 新しいproject folderを選ぶ
- project root pathを表示し、既存Project Routeを開く

OS Explorerでrootを開く新しいwrite/IPCはD1に追加せず、既存contractで実行できない操作を実行可能に見せない。

- [ ] **Step 4: 上中央pillを意味のあるsource表示へ置き換える**

`RepositoryStatusPill`のcopy:

- `watching`: `状態ファイル監視中`、緑の静止dot
- `snapshot`: `状態ファイル読取済み`、灰色dot
- `offline`: `前回データ表示中`、橙dot
- `demo`: `デモデータ`、灰色dot
- `error`: `読込エラー`、赤dot

光彩やpulseは使わない。tooltipへ最終同期時刻と`connectionLabel`を出す。

- [ ] **Step 5: workspace surfaceを実装する**

D1ではdead buttonを作らない。

- `attention`: current attentionの全件一覧
- `tasks`: `snapshot.tasks`のstate別簡易一覧と既存`TaskDetail`
- `failures`: current `error`と`repair` item一覧
- `conversation`: 既存`ConversationHistory`
- `more`: Project Route、Operations、Team Management、表示言語、診断の入口

Home以外ではMapを隠し、dockとComposerは残す。workspace内部だけscrollさせる。

- [ ] **Step 6: Project Statusを状態表示へ戻す**

`ProjectStatusCard`からproject切替、Route、Operations、JA/EN toggleを外す。project名、agent数、proven working数、状態、最終同期だけを表示する。

- [ ] **Step 7: focused testsを通す**

Run: `npm test -- tests/unit/app.test.tsx tests/unit/workspace-dock.test.tsx`

Expected: PASS、Home、各workspace、project switcher、locale persistenceが操作できる。

- [ ] **Step 8: Task 3をcommitする**

```powershell
git add -- apps/orquesta-desktop/src/renderer/features/navigation apps/orquesta-desktop/src/renderer/features/project/ProjectLauncher.tsx apps/orquesta-desktop/src/renderer/features/project/RepositoryStatusPill.tsx apps/orquesta-desktop/src/renderer/app/DesktopRendererApp.tsx apps/orquesta-desktop/src/renderer/features/project/ProjectStatusCard.tsx apps/orquesta-desktop/src/renderer/features/i18n/messages.ts apps/orquesta-desktop/src/renderer/styles/global.css apps/orquesta-desktop/tests/unit/app.test.tsx apps/orquesta-desktop/tests/unit/workspace-dock.test.tsx
git commit -m "feat(desktop): add persistent workspace navigation"
```

---

### Task 4: Home要対応概要とToast queue

**Files:**
- Create: `apps/orquesta-desktop/src/renderer/features/attention/attention-summary.ts`
- Create: `apps/orquesta-desktop/src/renderer/features/toast/toast-queue.ts`
- Modify: `apps/orquesta-desktop/src/renderer/features/attention/AttentionCard.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/features/toast/ToastStack.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/app/DesktopRendererApp.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/styles/global.css`
- Test: `apps/orquesta-desktop/tests/unit/attention-card.test.tsx`
- Test: `apps/orquesta-desktop/tests/unit/toast-stack.test.tsx`

**Interfaces:**
- Produces: `summarizeAttention(items): Record<UserActionKind, number> & { total: number }`
- Produces: `visibleToastQueue(items): { visible: RuntimeUiEvent[]; hiddenCount: number }`

- [ ] **Step 1: attention summaryの失敗testを書く**

```ts
test('shows total and only non-zero action-kind counts', () => {
  render(<AttentionCard items={[
    attention({ id: 'q1', actionKind: 'answer' }),
    attention({ id: 'q2', actionKind: 'answer' }),
    attention({ id: 'r1', actionKind: 'review' })
  ]} {...handlers} />);

  expect(screen.getByText('要対応 3')).toBeVisible();
  expect(screen.getByText('回答 2')).toBeVisible();
  expect(screen.getByText('確認 1')).toBeVisible();
  expect(screen.queryByText(/承認 0/)).not.toBeInTheDocument();
});
```

Home本文はpriority、blocking、createdAtでsortした上位5件だけにする。全件は要対応workspaceへdeep linkする。

- [ ] **Step 2: Toast queueの失敗testを書く**

```ts
test('deduplicates repeated events and summarizes overflow above three', () => {
  const result = visibleToastQueue([
    toast({ id: '1', title: 'Done', message: 'T1' }),
    toast({ id: '2', title: 'Done', message: 'T1' }),
    toast({ id: '3', title: 'Failed', message: 'T2' }),
    toast({ id: '4', title: 'Question', message: 'Q1' }),
    toast({ id: '5', title: 'Reply', message: 'C1' })
  ]);
  expect(result.visible).toHaveLength(3);
  expect(result.hiddenCount).toBe(1);
});
```

dedupe keyは`tone|title|message|taskId`、windowは5秒とする。新しいeventを優先する。

- [ ] **Step 3: queueと配置を実装する**

- 表示は最大3件
- 4件目以降は`ほかN件`一行
- bottomはComposerと同じ基準線
- 上方向へ積む
- right Attention領域に入る前にoverflowへまとめる
- 対応が必要な内容はsnapshot attentionに残し、Toastだけで消費しない

- [ ] **Step 4: focused testsを通す**

Run: `npm test -- tests/unit/attention-card.test.tsx tests/unit/toast-stack.test.tsx tests/unit/app.test.tsx`

Expected: PASS、React warning 0。

- [ ] **Step 5: Task 4をcommitする**

```powershell
git add -- apps/orquesta-desktop/src/renderer/features/attention apps/orquesta-desktop/src/renderer/features/toast apps/orquesta-desktop/src/renderer/app/DesktopRendererApp.tsx apps/orquesta-desktop/src/renderer/styles/global.css apps/orquesta-desktop/tests/unit/attention-card.test.tsx apps/orquesta-desktop/tests/unit/toast-stack.test.tsx apps/orquesta-desktop/tests/unit/app.test.tsx
git commit -m "feat(desktop): clarify attention and toast priority"
```

---

### Task 5: Map zoom fidelityとpointer lifecycle

**Files:**
- Modify: `apps/orquesta-desktop/src/renderer/features/map/MapViewport.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/styles/global.css`
- Test: `apps/orquesta-desktop/tests/unit/map-viewport.test.ts`
- Test: `apps/orquesta-desktop/tests/electron/map-stability.spec.ts`
- Test: `apps/orquesta-desktop/tests/electron/interaction-retention.spec.ts`

**Interfaces:**
- Produces: `schedulePointerFrame`をcomponent内部で使い、1 animation frameに1 camera updateまでとする。
- Consumes: existing `manual-layout.ts`と`createStableLayout()`。

- [ ] **Step 1: min zoomでSVGがicon frameを越えない失敗testを書く**

`map-stability.spec.ts`でmin zoom後の全`.agent-node__icon svg`と親frameを測る。

```ts
const overflows = await window.locator('.agent-node__icon').evaluateAll((icons) => icons.flatMap((icon) => {
  const frame = icon.getBoundingClientRect();
  const svg = icon.querySelector('svg')?.getBoundingClientRect();
  return svg && (svg.width > frame.width + 0.5 || svg.height > frame.height + 0.5) ? [icon.textContent] : [];
}));
expect(overflows).toEqual([]);
```

Run: `npm run build:desktop && npx playwright test --config=playwright.electron.config.ts tests/electron/map-stability.spec.ts`

Expected: 現在のoverviewで固定size SVGがframeを越えFAILする。

- [ ] **Step 2: icon内のSVGをworld-scaled frameへ収める**

```css
.agent-node__icon > svg,
.map-user-node__icon > svg {
  width: 58%;
  height: 58%;
  max-width: 100%;
  max-height: 100%;
}
```

selected overview nodeも同じruleを使い、iconだけscreen-space固定pxにしない。

- [ ] **Step 3: pointer cleanupの失敗testを追加する**

interaction testで100回のpan、click、agent drag後にpointer captureがなく、animation frame counterとlistener counterが基準へ戻ることを確認する。productionへtest-only APIは追加せず、Playwrightの`requestAnimationFrame`、DOM状態、既存process metricsを使う。

- [ ] **Step 4: pointer updateをframe単位へまとめる**

- `pointermove`は最新座標だけrefへ保存
- pending frameがなければ`requestAnimationFrame`を一つだけ登録
- frame内でcameraまたはmanual offsetを一回更新
- `pointerup`、`pointercancel`、window blur、Escapeでdrag state、capture、pending frameを解除
- unmount cleanupでpending frameをcancel
- click閾値未満はmanual offsetとして保存しない

- [ ] **Step 5: focused Map testsを通す**

Run: `npm test -- tests/unit/map-viewport.test.ts tests/unit/manual-layout.test.ts tests/unit/map-layout.test.ts`

Run: `npm run build:desktop && npx playwright test --config=playwright.electron.config.ts tests/electron/map-stability.spec.ts tests/electron/interaction-retention.spec.ts`

Expected: 全test PASS。100 cycle後に操作回数へ比例するretained growthがなく、CPU activityがidleへ戻る。

- [ ] **Step 6: Task 5をcommitする**

```powershell
git add -- apps/orquesta-desktop/src/renderer/features/map/MapViewport.tsx apps/orquesta-desktop/src/renderer/styles/global.css apps/orquesta-desktop/tests/unit/map-viewport.test.ts apps/orquesta-desktop/tests/electron/map-stability.spec.ts apps/orquesta-desktop/tests/electron/interaction-retention.spec.ts
git commit -m "fix(desktop): stabilize map scaling and pointer lifecycle"
```

---

### Task 6: loading、Project Route、言語導線、D1 acceptance

**Files:**
- Modify: `apps/orquesta-desktop/src/renderer/app/DesktopRendererApp.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/features/project/ProjectRoute.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/features/navigation/WorkspaceSurface.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/features/i18n/messages.ts`
- Modify: `apps/orquesta-desktop/src/renderer/styles/global.css`
- Modify: `apps/orquesta-desktop/tests/unit/app.test.tsx`
- Modify: `apps/orquesta-desktop/tests/visual/home.visual.spec.ts`
- Modify: `apps/orquesta-desktop/tests/electron/desktop-shell.spec.ts`
- Create: `apps/orquesta-desktop/docs/validation/ux-recovery-d1.md`

**Interfaces:**
- Consumes: `ProjectUiModel.repositoryDisplayState`
- Consumes: existing persisted locale key `orquesta.desktop.locale`
- Produces: D1 machine evidenceとuser walkthrough checklist。

- [ ] **Step 1: loadingとerrorの失敗testを書く**

```tsx
test('distinguishes project loading from no project and repository read failure', async () => {
  const bridge = deferredBridge();
  render(<DesktopRendererApp bridge={bridge} initialLocale="ja" />);
  expect(screen.getByText('プロジェクトを読み込み中')).toBeVisible();
  bridge.resolve(noProjectSnapshot());
  expect(await screen.findByRole('heading', { name: 'Orquestaプロジェクトを開く' })).toBeVisible();
});
```

別testでinitial snapshot rejection時に白画面ではなく、error title、理由、再試行、project選択を表示する。

- [ ] **Step 2: Project Routeへfreshnessを表示する**

Project Routeは開くたびに現在の`snapshot.project.lastSyncedAt`と`repositoryDisplayState`を受け取る。静的作成日だけを現在routeに見せない。project切替後に古いoverlay stateを閉じる既存effectを維持する。

- [ ] **Step 3: 言語切替をその他へ移す**

`その他 > 設定 > 表示言語`へJA/EN toggleを置く。`I18nProvider`のlocalStorage保存をそのまま使う。Project Statusの小さいtoggleは削除する。

- [ ] **Step 4: Home visual baselineを意図的に更新する**

Run: `npm run build && npx playwright test --config=playwright.visual.config.ts tests/visual/home.visual.spec.ts`

Expected: 旧baselineとの差分でFAILする。1440 x 900と1366 x 768の差分画像を確認し、円形Mapが主役、Home全体scrollなし、dockとLauncherが重ならないことを目視確認してから`--update-snapshots`を実行する。

Run: `npm run build && npx playwright test --config=playwright.visual.config.ts tests/visual/home.visual.spec.ts --update-snapshots`

Expected: 新baselineが保存される。

- [ ] **Step 5: D1全体の自動検証を実行する**

Run: `npm test`

Expected: 全unit/core test PASS、fail 0。

Run: `npm run build:desktop`

Expected: TypeScript、Renderer、Electron host buildがexit 0。

Run: `npm run test:desktop-smoke`

Expected: desktop shell、repository、runtime、Map、responsivenessがPASS。

Run: `npm run test:interaction-retention`

Expected: interaction retention gateがPASSし、結果JSONが更新される。

Run: `npm run test:visual`

Expected: 1440 x 900、1366 x 768のvisual testがPASS。

- [ ] **Step 6: packaged appを検証する**

Run: `npm run make:win`

Run: `npm run verify:packaged-runtime`

Expected: Windows package生成とbundled Codex runtime検証がexit 0。

実機walkthrough:

- project未選択、読込中、読込失敗が白画面にならない
- Homeの円形Map、Now、要対応、Composerが同時に見える
- 上部statusの緑は`状態ファイル監視中`だけに使われ、意味が文面で分かる
- 左下dockから全workspaceへ一回で移動できる
- project切替後にMapとProject Routeが新projectへ変わる
- 質問、承認、確認、作業の件数がfixtureと一致する
- min zoomでiconが丸から飛び出さない
- panと連打後にCPU activityが残らない
- Toast 3件が要対応と重ならない
- 言語切替をその他から発見でき、再起動後も保持される

- [ ] **Step 7: validation documentを書く**

`ux-recovery-d1.md`へ、実行command、exit code、test数、package path、visual screenshot、未確認のuser walkthrough項目を分けて記録する。機械testをユーザー承認として記録しない。

- [ ] **Step 8: Task 6をcommitする**

```powershell
git add -- apps/orquesta-desktop/src/renderer apps/orquesta-desktop/tests apps/orquesta-desktop/docs/validation/ux-recovery-d1.md
git commit -m "test(desktop): validate UX recovery D1"
```

- [ ] **Step 9: ユーザーレビューで停止する**

package起動方法、確認する9項目、既知の非目標を渡す。ユーザーが合格するまでD2へ進まない。

---

## Self-Review Result

- D1の全項目をTask 1からTask 6へ割り当てた。
- Homeの既存component、bridge、snapshot、Electron shellを再利用し、全面rewriteを避けた。
- D1で新しいpagination、router、状態管理library、Codex安全機構を追加しない。
- DockのボタンはD1時点から最低限の実データを開き、無効な見せかけ操作にしない。
- D2の完全なInbox／Conversation identity、D3の検索・仮想化・Failure cluster、D4の質問候補protocolは混ぜていない。
- 設計上の未確定事項や、実装者へ丸投げするstepは残していない。
