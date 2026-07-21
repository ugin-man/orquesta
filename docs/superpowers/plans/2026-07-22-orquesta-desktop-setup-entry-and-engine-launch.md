# Orquesta Desktop Setup Entry and Engine Launch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 初回起動または未セットアップのプロジェクト選択時に、Orquesta Desktop内の一枚の入力画面からセットアップを開始し、Desktop Coreが直接SetupEngineを起動してcanonicalなPhase 1を表示できるようにする。

**Architecture:** Rendererは入力と進捗表示だけを担当する。Electron Mainはアプリ所有のSetupDraft、フォルダ選択、プロジェクト登録を担当する。utility processのDesktop CoreはCodex App Serverの認証状態とSetupEngineを所有する。セットアップ開始前の対象フォルダは読み取り専用とし、開始時に初めて`.orquesta/setup/setup_state.json`を原子的に作る。既存のDashboard HTTP setup APIは、抽出したSetupEngineを呼ぶ互換アダプターへ縮小する。

**Tech Stack:** Electron 43、React 19、TypeScript 5、Vitest、Playwright Electron、Node.js、Codex App Server 0.144.5、既存のOrquesta canonical JSON state。

**Global Constraints:**

- Desktopが最終成果物。Browserは完成判定に使わない。
- Start前は対象プロジェクトに書き込まない。
- `session.json`を復活させない。setupの正本は`.orquesta/setup/setup_state.json`。
- 無条件に生成する基礎エージェントは`orchestrator`、`user-support`、`orquesta-admin`の3体だけ。
- 質問は0〜3件、すべて任意。回答なしでもStartできる。
- 新ライン以外の初期専門家生成に追加承認を要求しない。
- App ServerとSetupEngineはDesktop Coreから直接呼ぶ。RendererやMainからshell経由でCodexを起動しない。
- 実装ごとに該当する狭いtestを一度通し、最後にDesktop統合testとbuildを一度だけ通す。

## Task 1: Setup契約と古い仕様の境界を固定する

**Files:**

- Create: `apps/orquesta-desktop/src/contracts/setup.ts`
- Modify: `apps/orquesta-desktop/src/contracts/bridge.ts`
- Modify: `apps/orquesta-desktop/electron/shared/host-contract.ts`
- Modify: `apps/orquesta-desktop/electron/core/protocol.ts`
- Modify: `docs/design/2026-07-20-orquesta-initial-setup-overhaul.md`
- Test: `apps/orquesta-desktop/tests/unit/setup-contract.test.ts`
- Test: `apps/orquesta-desktop/electron/core/protocol.test.ts`

- [ ] **Step 1: RED — 新しいsetup契約の期待値を書く**

```ts
expect(parseSetupDraft({
  source: { kind: 'existing_folder', rootPath: 'C:\\work\\demo' },
  projectName: 'Demo',
  description: '',
  answers: []
})).toMatchObject({ status: 'draft' });

expect(SETUP_PHASE_IDS).toEqual([
  'environment', 'understanding', 'foundation',
  'planning', 'specialists', 'operation'
]);
```

- [ ] **Step 2: REDを確認する**

Run: `npm --prefix apps/orquesta-desktop run test -- tests/unit/setup-contract.test.ts electron/core/protocol.test.ts`

Expected: `setup.ts`と新しいprotocol messageが未実装のためFAIL。

- [ ] **Step 3: 最小の契約を実装する**

`SetupSourceDraft`、`SetupDraft`、`SetupQuestion`、`SetupAccountState`、`SetupStartInput`、`SetupStartResult`、`SetupProgressEvent`をdiscriminated unionとして定義する。IPC/Core messageは`setup.account.read`、`setup.login.start`、`setup.draft.read/save`、`setup.source.choose`、`setup.start`だけを最初の公開面にする。

- [ ] **Step 4: 古い設計文書の矛盾を消す**

`session.json`、必須6問、固定専門家、Browser起点という記述をhistorical扱いにし、現行のdesign specへリンクする。

- [ ] **Step 5: GREENを確認する**

Run: `npm --prefix apps/orquesta-desktop run test -- tests/unit/setup-contract.test.ts electron/core/protocol.test.ts`

Expected: PASS。

- [ ] **Step 6: Commit**

```powershell
git add apps/orquesta-desktop/src/contracts/setup.ts apps/orquesta-desktop/src/contracts/bridge.ts apps/orquesta-desktop/electron/shared/host-contract.ts apps/orquesta-desktop/electron/core/protocol.ts apps/orquesta-desktop/tests/unit/setup-contract.test.ts apps/orquesta-desktop/electron/core/protocol.test.ts docs/design/2026-07-20-orquesta-initial-setup-overhaul.md
git commit -m "feat(desktop): define setup entry contracts"
```

## Task 2: Start前に書き込まないSetupDraftと起動元判定を作る

**Files:**

- Create: `apps/orquesta-desktop/electron/main/setup-draft-store.ts`
- Create: `apps/orquesta-desktop/electron/main/setup-launch-intent.ts`
- Modify: `apps/orquesta-desktop/electron/main/index.ts`
- Modify: `apps/orquesta-desktop/electron/main/repository-service.ts`
- Modify: `apps/orquesta-desktop/electron/core/repository-runtime.ts`
- Test: `apps/orquesta-desktop/electron/main/setup-draft-store.test.ts`
- Test: `apps/orquesta-desktop/electron/main/setup-launch-intent.test.ts`
- Test: `apps/orquesta-desktop/electron/main/repository-service.test.ts`
- Test: `apps/orquesta-desktop/electron/core/repository-runtime.test.ts`

- [ ] **Step 1: RED — app-owned draftとread-only preflightを書く**

```ts
await store.save({ source, projectName: 'Demo', description: '', answers: [] });
expect(await readFile(projectStatePath)).rejects.toThrow();
expect(await store.read()).toMatchObject({ projectName: 'Demo' });
```

`RepositoryRuntime.select()`が未セットアップフォルダに`ensureLegacyOrganizationState()`を呼ばないこともtestで固定する。

- [ ] **Step 2: REDを確認する**

Run: `npm --prefix apps/orquesta-desktop run test -- electron/main/setup-draft-store.test.ts electron/main/setup-launch-intent.test.ts electron/main/repository-service.test.ts electron/core/repository-runtime.test.ts`

Expected: store未実装、旧migration呼び出しが残っているためFAIL。

- [ ] **Step 3: SetupDraftStoreを実装する**

Electron `userData/setup-draft.json`へtemp file + renameで保存する。保存対象は入力値とsource descriptorだけで、Codex tokenやproject stateは含めない。

- [ ] **Step 4: 起動元を正規化する**

first instance argv、second-instance argv、E2E envを同じ`SetupLaunchIntent`へ変換する。検出されたworking directoryは候補として示すだけで、自動選択・自動書き込みしない。

- [ ] **Step 5: ordinary repository selectionからlegacy migrationを外す**

既存canonical repositoryはそのまま読む。未セットアップフォルダはsetup intakeへ遷移できるread-only結果として扱う。migrationは明示的なSetupEngine内部だけに残す。

- [ ] **Step 6: GREENを確認する**

Run: `npm --prefix apps/orquesta-desktop run test -- electron/main/setup-draft-store.test.ts electron/main/setup-launch-intent.test.ts electron/main/repository-service.test.ts electron/core/repository-runtime.test.ts`

Expected: PASS。

- [ ] **Step 7: Commit**

```powershell
git add apps/orquesta-desktop/electron/main/setup-draft-store.ts apps/orquesta-desktop/electron/main/setup-launch-intent.ts apps/orquesta-desktop/electron/main/index.ts apps/orquesta-desktop/electron/main/repository-service.ts apps/orquesta-desktop/electron/core/repository-runtime.ts apps/orquesta-desktop/electron/main/*.test.ts apps/orquesta-desktop/electron/core/repository-runtime.test.ts
git commit -m "feat(desktop): keep setup intake read only"
```

## Task 3: setup中のcanonical repositoryを部分状態として読めるようにする

**Files:**

- Modify: `apps/orquesta-desktop/electron/core/repository-reader.ts`
- Modify: `apps/orquesta-desktop/src/contracts/orquesta-ui.ts`
- Test: `apps/orquesta-desktop/electron/core/repository-reader.test.ts`
- Test: `apps/orquesta-desktop/tests/unit/initial-setup-contract.test.ts`

- [ ] **Step 1: RED — setup_stateだけのrepository fixtureを書く**

```ts
await writeJson('.orquesta/setup/setup_state.json', activePhaseOneState);
const snapshot = await reader.read(root);
expect(snapshot.setup?.activePhaseId).toBe('environment');
expect(snapshot.agents).toEqual([]);
expect(snapshot.tasks).toEqual([]);
```

- [ ] **Step 2: REDを確認する**

Run: `npm --prefix apps/orquesta-desktop run test -- electron/core/repository-reader.test.ts tests/unit/initial-setup-contract.test.ts`

Expected: `agents.json`と`tasks.json`がrequiredのためFAIL。

- [ ] **Step 3: setup-activeの読み取り分岐を実装する**

`setup_state.json`がactiveならagents/tasks欠落を空配列として読む。setup完了後または通常projectでは従来どおりcanonical state欠落をfail-closedにする。

- [ ] **Step 4: GREENを確認する**

Run: `npm --prefix apps/orquesta-desktop run test -- electron/core/repository-reader.test.ts tests/unit/initial-setup-contract.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```powershell
git add apps/orquesta-desktop/electron/core/repository-reader.ts apps/orquesta-desktop/electron/core/repository-reader.test.ts apps/orquesta-desktop/src/contracts/orquesta-ui.ts apps/orquesta-desktop/tests/unit/initial-setup-contract.test.ts
git commit -m "feat(desktop): project active setup state"
```

## Task 4: Codex App Serverの認証状態をDesktop Coreへ追加する

**Files:**

- Modify: `apps/orquesta-desktop/electron/core/desktop-codex-service.ts`
- Modify: `apps/orquesta-desktop/electron/core/handler.ts`
- Modify: `apps/orquesta-desktop/electron/main/core-host.ts`
- Modify: `apps/orquesta-desktop/electron/main/ipc-handlers.ts`
- Modify: `apps/orquesta-desktop/electron/preload/host-api.ts`
- Test: `apps/orquesta-desktop/electron/core/desktop-codex-service.test.ts`
- Test: `apps/orquesta-desktop/electron/core/handler.test.ts`
- Test: `apps/orquesta-desktop/electron/main/core-host.test.ts`
- Test: `apps/orquesta-desktop/electron/main/ipc-handlers.test.ts`
- Test: `apps/orquesta-desktop/electron/preload/host-api.test.ts`

- [ ] **Step 1: RED — account/readとlogin/startのfixtureを書く**

```ts
expect(await service.readAccount()).toEqual({
  status: 'authenticated', accountType: 'chatgpt', requiresOpenaiAuth: true
});
expect(await service.startChatGptLogin()).toMatchObject({ type: 'chatgpt', loginId: expect.any(String) });
```

- [ ] **Step 2: REDを確認する**

Run: `npm --prefix apps/orquesta-desktop run test -- electron/core/desktop-codex-service.test.ts electron/core/handler.test.ts electron/main/core-host.test.ts electron/main/ipc-handlers.test.ts electron/preload/host-api.test.ts`

Expected: account methodsとIPCが未実装のためFAIL。

- [ ] **Step 3: pinned App Server methodsを実装する**

0.144.5 schemaの`account/read`、`account/rateLimits/read`、`account/login/start`だけを使う。`account/updated`と`account/login/completed`をsetup progress eventへ変換する。実際のアカウント種別はApp Server responseだけを根拠にする。

- [ ] **Step 4: Main/Preload bridgeを接続する**

Rendererからfilesystem、child process、API keyへアクセスさせず、`readSetupAccount()`と`startSetupLogin()`だけを公開する。

- [ ] **Step 5: GREENを確認する**

Run: `npm --prefix apps/orquesta-desktop run test -- electron/core/desktop-codex-service.test.ts electron/core/handler.test.ts electron/main/core-host.test.ts electron/main/ipc-handlers.test.ts electron/preload/host-api.test.ts`

Expected: PASS。

- [ ] **Step 6: Commit**

```powershell
git add apps/orquesta-desktop/electron apps/orquesta-desktop/src/contracts
git commit -m "feat(desktop): expose setup account state"
```

## Task 5: 一枚のDesktop入力画面を実装する

**Files:**

- Create: `apps/orquesta-desktop/src/renderer/features/setup/SetupIntake.tsx`
- Create: `apps/orquesta-desktop/src/renderer/features/setup/setup-intake.css`
- Modify: `apps/orquesta-desktop/src/renderer/app/DesktopRendererApp.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/bridge/desktop-repository-bridge.ts`
- Modify: `apps/orquesta-desktop/src/renderer/bridge/mock-bridge.ts`
- Test: `apps/orquesta-desktop/tests/unit/setup-intake.test.tsx`
- Test: `apps/orquesta-desktop/tests/unit/app.test.tsx`
- Test: `apps/orquesta-desktop/tests/unit/desktop-repository-bridge.test.ts`

- [ ] **Step 1: RED — 入力画面のユーザー経路を書く**

```tsx
expect(screen.getByRole('heading', { name: 'Orquestaを始める' })).toBeVisible();
expect(screen.getByRole('button', { name: 'この場所で始める' })).toBeVisible();
expect(screen.getByRole('button', { name: '既存フォルダを選ぶ' })).toBeVisible();
expect(screen.getByRole('button', { name: '新しいプロジェクト' })).toBeVisible();
expect(screen.getByRole('button', { name: 'GitHubから始める' })).toBeVisible();
```

project name、description、0〜3 optional questions、account state、開始前summaryを同一画面で検証する。

- [ ] **Step 2: REDを確認する**

Run: `npm --prefix apps/orquesta-desktop run test -- tests/unit/setup-intake.test.tsx tests/unit/app.test.tsx tests/unit/desktop-repository-bridge.test.ts`

Expected: intake component/bridge未実装のためFAIL。

- [ ] **Step 3: SetupIntakeを実装する**

初回起動の`no-project`画面を置き換える。ソース選択、project name、description、任意質問、Codex認証、開始summaryを一枚に収める。未入力descriptionと未回答質問は許可する。Start時だけ`bridge.startSetup()`を呼ぶ。

- [ ] **Step 4: GitHub入力は取得前のpreflightまで実装する**

このsliceではpublic HTTPS URLの形式、private/LFS/submodule unsupported guidanceを表示する。実際のmaterializeはTask 6のSetupEngine境界内で行い、Rendererからgitを実行しない。

- [ ] **Step 5: GREENを確認する**

Run: `npm --prefix apps/orquesta-desktop run test -- tests/unit/setup-intake.test.tsx tests/unit/app.test.tsx tests/unit/desktop-repository-bridge.test.ts`

Expected: PASS。

- [ ] **Step 6: Commit**

```powershell
git add apps/orquesta-desktop/src/renderer apps/orquesta-desktop/tests/unit
git commit -m "feat(desktop): add one-screen setup intake"
```

## Task 6: SetupEngineをDashboardから分離してDesktop Coreから直接開始する

**Files:**

- Create: `orquesta/scripts/setup-engine.js`
- Create: `orquesta/scripts/setup-engine.test.js`
- Modify: `orquesta/dashboard-server.js`
- Modify: `orquesta/scripts/adaptive-setup-state.js`
- Modify: `apps/orquesta-desktop/electron/core/handler.ts`
- Modify: `apps/orquesta-desktop/electron/main/core-host.ts`
- Modify: `apps/orquesta-desktop/electron/main/repository-service.ts`
- Test: `apps/orquesta-desktop/electron/core/handler.test.ts`
- Test: `apps/orquesta-desktop/electron/main/repository-service.test.ts`

- [ ] **Step 1: RED — 原子的かつidempotentな開始testを書く**

```js
const first = await engine.start(input);
assert.equal(first.setup_state.current_phase_id, 'environment');
assert.deepEqual(first.setup_state.foundation_agents.map(x => x.agent_id), [
  'orchestrator', 'user-support', 'orquesta-admin'
]);
const second = await engine.start(input);
assert.equal(second.setup_state.setup_id, first.setup_state.setup_id);
```

Start前は`.orquesta`が存在せず、失敗時にpartial stateを残さないことも検証する。

- [ ] **Step 2: REDを確認する**

Run: `node --test orquesta/scripts/setup-engine.test.js && npm --prefix apps/orquesta-desktop run test -- electron/core/handler.test.ts electron/main/repository-service.test.ts`

Expected: engine未実装、Core setup.start未実装のためFAIL。

- [ ] **Step 3: Dashboardの純粋処理を抽出する**

`saveProjectIntake`、`buildSetupQuestions`、project understanding、completion map、foundation state作成をSetupEngineへ移す。HTTP routeは同じengine methodを呼ぶだけにする。

- [ ] **Step 4: SetupEngine.startを実装する**

対象rootを再preflightし、temp directoryで全初期JSONを構築してからrenameする。最初のpersistで`setup_id`、`status: active`、`current_phase_id: environment`、6 phase、入力snapshot、foundation agentsを同じstateへ束ねる。

- [ ] **Step 5: Desktop Coreへ直接接続する**

MainからCoreへ`setup.start`を送り、Coreがengineを呼ぶ。成功後だけRepositoryServiceへrootを登録し、同じ`setup_id`を含むsnapshotをRendererへ返す。

- [ ] **Step 6: GREENを確認する**

Run: `node --test orquesta/scripts/setup-engine.test.js && npm --prefix apps/orquesta-desktop run test -- electron/core/handler.test.ts electron/main/repository-service.test.ts`

Expected: PASS。

- [ ] **Step 7: Commit**

```powershell
git add orquesta/scripts/setup-engine.js orquesta/scripts/setup-engine.test.js orquesta/dashboard-server.js orquesta/scripts/adaptive-setup-state.js apps/orquesta-desktop/electron
git commit -m "feat(setup): start canonical engine from desktop core"
```

## Task 7: GitHubと新規projectのsource materializationを安全に完結させる

**Files:**

- Create: `apps/orquesta-desktop/electron/main/setup-source-service.ts`
- Modify: `apps/orquesta-desktop/electron/main/index.ts`
- Modify: `apps/orquesta-desktop/electron/main/repository-service.ts`
- Test: `apps/orquesta-desktop/electron/main/setup-source-service.test.ts`

- [ ] **Step 1: RED — source別の取得境界を書く**

new projectは選んだ親フォルダ配下へsafe slugを作る。existing folderはそのrootを使う。public GitHubはapp-owned tempへ取得し、private、LFS、submoduleを明示的にrejectする。

- [ ] **Step 2: REDを確認する**

Run: `npm --prefix apps/orquesta-desktop run test -- electron/main/setup-source-service.test.ts`

Expected: service未実装のためFAIL。

- [ ] **Step 3: source serviceを実装する**

PATH上のgitやCodex tokenには依存しない。pinned app-internal Git clientを使う。target決定とsource取得が成功するまで`.orquesta`を書かない。失敗時はapp tempだけを削除する。

- [ ] **Step 4: GREENを確認する**

Run: `npm --prefix apps/orquesta-desktop run test -- electron/main/setup-source-service.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```powershell
git add apps/orquesta-desktop/electron/main/setup-source-service.ts apps/orquesta-desktop/electron/main/setup-source-service.test.ts apps/orquesta-desktop/electron/main/index.ts apps/orquesta-desktop/electron/main/repository-service.ts apps/orquesta-desktop/package.json apps/orquesta-desktop/package-lock.json
git commit -m "feat(desktop): materialize setup sources"
```

## Task 8: DesktopでStartからPhase 1表示までを受け入れる

**Files:**

- Create: `apps/orquesta-desktop/tests/electron/initial-setup.spec.ts`
- Modify: `apps/orquesta-desktop/tests/electron/fixtures/fake-codex-app-server.cjs`
- Modify: `apps/orquesta-desktop/docs/validation/repository-integration.md`
- Modify: `apps/orquesta-desktop/VALIDATION.md`

- [ ] **Step 1: Electron受入testを書く**

次を一つのtestで確認する。

1. clean userDataで一枚のintakeが出る。
2. source選択と入力中は対象rootに`.orquesta`がない。
3. Startでcanonical `setup_state.json`が一度だけ作られる。
4. Desktop画面が`environment` phaseを表示する。
5. app再起動後も同じ`setup_id`から再開する。

- [ ] **Step 2: Desktop hostとbuildを一度だけ検証する**

Run: `npm --prefix apps/orquesta-desktop run test -- tests/unit/setup-contract.test.ts tests/unit/setup-intake.test.tsx electron/main/setup-draft-store.test.ts electron/main/setup-launch-intent.test.ts electron/core/repository-reader.test.ts electron/core/desktop-codex-service.test.ts electron/core/handler.test.ts electron/main/core-host.test.ts electron/main/ipc-handlers.test.ts electron/preload/host-api.test.ts`

Expected: PASS。

Run: `npm --prefix apps/orquesta-desktop run build:desktop`

Expected: PASS。

Run: `npm --prefix apps/orquesta-desktop exec playwright test -- --config=playwright.electron.config.ts tests/electron/initial-setup.spec.ts`

Expected: PASS。Browser testは実行しない。

- [ ] **Step 3: Desktop目視確認用buildを起動する**

Run: `npm --prefix apps/orquesta-desktop run start:desktop`

確認対象は入力一枚、Start前のread-only、Start後のPhase 1表示だけ。6 phaseの最終ビジュアルは別slice。

- [ ] **Step 4: validation docsを更新する**

機械test、Desktop実画面、未実装の6 phase最終演出を分けて記録する。

- [ ] **Step 5: Commit**

```powershell
git add apps/orquesta-desktop/tests/electron/initial-setup.spec.ts apps/orquesta-desktop/tests/electron/fixtures/fake-codex-app-server.cjs apps/orquesta-desktop/docs/validation/repository-integration.md apps/orquesta-desktop/VALIDATION.md
git commit -m "test(desktop): accept setup entry to phase one"
```

## Plan self-review

- [ ] design specの全受入条件がTask 1〜8のどれかに対応している。
- [ ] `session.json`、固定6問、固定専門家、Browser完成判定が残っていない。
- [ ] Start前とStart後の書き込み境界がtestで分かれている。
- [ ] Renderer、Main、Core、SetupEngineの所有責任が重複していない。
- [ ] GitHub取得にPATH git、Codex token、Renderer shellを使わない。
- [ ] account実在証拠とモデル証拠を混同していない。
- [ ] 最終Desktop testは一回で、途中のBrowser往復を要求していない。
