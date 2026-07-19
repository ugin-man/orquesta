# Orquesta Desktop Startup Curtain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 写真1のロゴを通常のメインウィンドウ内に最低1400ms表示し、読み込み完了後に上へフェードしてホーム画面を見せる。

**Architecture:** `index.html` がReactより先に静的な起動カーテンを描画し、独立した `startup-curtain.ts` が最低表示時間、準備完了、6秒上限を管理する。既存の別BrowserWindowスプラッシュとrenderer-ready IPCは削除し、メインウィンドウを `ready-to-show` で直接表示する。

**Tech Stack:** Electron 43、React 19、TypeScript、Vite、Vitest、Testing Library

## Global Constraints

- ロゴはユーザー提供の `1-写真1.jpg` を加工せず使用する。
- ロゴの最低静止時間は1400ms、通常の終了アニメーションは300ms、上方向の移動は24pxとする。
- 準備完了が届かない場合も6000msで起動カーテンを終了する。
- reduced motionでは上方向へ動かさず、160msのフェードだけにする。
- `startup=instant` のときは準備完了後に待機とアニメーションを省略する。
- プロジェクト切り替えや画面移動では再表示せず、アプリ起動時だけ表示する。
- 現在未コミットのホーム画面変更を起動機能のコミットに含めない。

---

### Task 1: 起動時間を管理するコントローラー

**Files:**
- Create: `apps/orquesta-desktop/src/renderer/startup/startup-curtain.ts`
- Create: `apps/orquesta-desktop/tests/unit/startup-curtain.test.ts`

**Interfaces:**
- Produces: `createStartupCurtainController(): { markReady(): void; dispose(): void }`
- Produces: `STARTUP_MINIMUM_MS = 1400`、`STARTUP_EXIT_MS = 300`、`STARTUP_REDUCED_EXIT_MS = 160`、`STARTUP_FALLBACK_MS = 6000`
- Consumes: `#startup-curtain` と `.startup-curtain__logo`

- [ ] **Step 1: 最低表示時間、終了、上限、instantの失敗テストを書く**

```ts
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createStartupCurtainController } from '../../src/renderer/startup/startup-curtain';

describe('startup curtain controller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="startup-curtain"><img class="startup-curtain__logo"></div>';
    window.history.replaceState({}, '', '/');
  });
  afterEach(() => vi.useRealTimers());

  test('waits 1400ms before starting the 300ms exit', () => {
    const controller = createStartupCurtainController();
    controller.markReady();
    vi.advanceTimersByTime(1399);
    expect(document.getElementById('startup-curtain')).not.toHaveClass('startup-curtain--exiting');
    vi.advanceTimersByTime(1);
    expect(document.getElementById('startup-curtain')).toHaveClass('startup-curtain--exiting');
    vi.advanceTimersByTime(300);
    expect(document.getElementById('startup-curtain')).toBeNull();
  });

  test('falls back after 6000ms when readiness never arrives', () => {
    createStartupCurtainController();
    vi.advanceTimersByTime(6000);
    expect(document.getElementById('startup-curtain')).toHaveClass('startup-curtain--exiting');
  });

  test('removes immediately after readiness in instant mode', () => {
    window.history.replaceState({}, '', '/?startup=instant');
    const controller = createStartupCurtainController();
    controller.markReady();
    expect(document.getElementById('startup-curtain')).toBeNull();
  });
});
```

- [ ] **Step 2: テストが未実装で失敗することを確認する**

Run: `npm test -- tests/unit/startup-curtain.test.ts`

Expected: `startup-curtain.ts` が存在しないためFAIL。

- [ ] **Step 3: 最小のコントローラーを実装する**

```ts
export const STARTUP_MINIMUM_MS = 1400;
export const STARTUP_EXIT_MS = 300;
export const STARTUP_REDUCED_EXIT_MS = 160;
export const STARTUP_FALLBACK_MS = 6000;

export function createStartupCurtainController() {
  const curtain = document.getElementById('startup-curtain');
  if (!curtain) return { markReady() {}, dispose() {} };
  const startedAt = Date.now();
  const instant = new URLSearchParams(window.location.search).get('startup') === 'instant';
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  let exitTimer: ReturnType<typeof setTimeout> | null = null;
  let removalTimer: ReturnType<typeof setTimeout> | null = null;
  let exited = false;
  const finish = () => curtain.remove();
  const beginExit = () => {
    if (exited) return;
    exited = true;
    if (instant) return finish();
    curtain.classList.add('startup-curtain--exiting');
    removalTimer = setTimeout(finish, reduced ? STARTUP_REDUCED_EXIT_MS : STARTUP_EXIT_MS);
  };
  const fallbackTimer = setTimeout(beginExit, STARTUP_FALLBACK_MS);
  return {
    markReady() {
      const remaining = instant ? 0 : Math.max(0, STARTUP_MINIMUM_MS - (Date.now() - startedAt));
      exitTimer = setTimeout(beginExit, remaining);
    },
    dispose() {
      clearTimeout(fallbackTimer);
      if (exitTimer) clearTimeout(exitTimer);
      if (removalTimer) clearTimeout(removalTimer);
    }
  };
}
```

- [ ] **Step 4: 対象テストを通す**

Run: `npm test -- tests/unit/startup-curtain.test.ts`

Expected: 3 tests PASS。

- [ ] **Step 5: 起動コントローラーだけをコミットする**

```powershell
git add apps/orquesta-desktop/src/renderer/startup/startup-curtain.ts apps/orquesta-desktop/tests/unit/startup-curtain.test.ts
git commit -m "feat(desktop): control startup curtain timing"
```

---

### Task 2: ロゴカーテンをReactの準備完了へ接続する

**Files:**
- Create: `apps/orquesta-desktop/public/brand/orquesta-startup.jpg`
- Modify: `apps/orquesta-desktop/index.html`
- Modify: `apps/orquesta-desktop/src/main.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/app/DesktopRendererApp.tsx`
- Modify: `apps/orquesta-desktop/tests/unit/app.test.tsx`
- Create: `apps/orquesta-desktop/tests/unit/startup-curtain-markup.test.ts`

**Interfaces:**
- Consumes: `createStartupCurtainController()` from Task 1
- Produces: `DesktopRendererApp` optional prop `onStartupReady?: () => void`
- Produces: static DOM id `startup-curtain` and class `startup-curtain__logo`

- [ ] **Step 1: 成功と失敗の両方で準備完了が一度だけ通知されるテストを書く**

```ts
test('reports startup readiness once after the snapshot is prepared', async () => {
  const onStartupReady = vi.fn();
  render(<DesktopRendererApp bridge={new MockOrquestaBridge('active-project')} onStartupReady={onStartupReady} />);
  await screen.findByText('Demo data');
  expect(onStartupReady).toHaveBeenCalledTimes(1);
});

test('reports startup readiness when the recovery screen is prepared', async () => {
  const bridge = new MockOrquestaBridge('active-project');
  vi.spyOn(bridge, 'getInitialSnapshot').mockRejectedValue(new Error('broken snapshot'));
  const onStartupReady = vi.fn();
  render(<DesktopRendererApp bridge={bridge} onStartupReady={onStartupReady} />);
  await screen.findByText('Renderer snapshot unavailable');
  expect(onStartupReady).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: 未対応のpropでテストが失敗することを確認する**

Run: `npm test -- tests/unit/app.test.tsx -t "reports startup readiness"`

Expected: callbackが呼ばれずFAIL。

- [ ] **Step 3: `Workspace` から準備完了を一度だけ通知する**

`Workspace` に `onStartupReady?: () => void` を渡し、`snapshot` または `loadingError` が初めて用意された時点で一度だけ呼ぶ。既存の `notifyRendererReady()` effectとrefは削除する。

```ts
const startupReadyReported = useRef(false);
useEffect(() => {
  if (startupReadyReported.current || (!snapshot && !loadingError)) return;
  startupReadyReported.current = true;
  onStartupReady?.();
}, [loadingError, onStartupReady, snapshot]);
```

- [ ] **Step 4: HTML構造とreduced motionのスタイルを検査する失敗テストを書く**

```ts
import { describe, expect, test } from 'vitest';
import documentHtml from '../../index.html?raw';

describe('startup curtain markup', () => {
  test('ships the selected local logo before the React root', () => {
    expect(documentHtml).toContain('id="startup-curtain"');
    expect(documentHtml).toContain('./brand/orquesta-startup.jpg');
    expect(documentHtml.indexOf('id="startup-curtain"')).toBeLessThan(documentHtml.indexOf('id="root"'));
  });
  test('moves the logo upward and disables movement for reduced motion', () => {
    expect(documentHtml).toContain('translateY(-24px)');
    expect(documentHtml).toContain('prefers-reduced-motion: reduce');
  });
});
```

- [ ] **Step 5: HTMLテストが起動カーテン未実装で失敗することを確認する**

Run: `npm test -- tests/unit/startup-curtain-markup.test.ts`

Expected: `startup-curtain` がなくFAIL。

- [ ] **Step 6: 写真1を配置し、静的カーテンと制御接続を実装する**

`index.html` の `#root` より前に、次の静的要素を置く。

```html
<div id="startup-curtain" class="startup-curtain" aria-hidden="true">
  <img class="startup-curtain__logo" src="./brand/orquesta-startup.jpg" alt="" />
</div>
```

インラインCSSで白い全面背景、中央配置、画像最大420px、終了時 `opacity: 0` と `translateY(-24px)`、reduced motion時の移動無効を定義する。`src/main.tsx` でコントローラーを作成し、`onStartupReady={startupCurtain.markReady}` を渡す。

- [ ] **Step 7: ReactとHTMLの対象テストを通す**

Run: `npm test -- tests/unit/app.test.tsx tests/unit/startup-curtain-markup.test.ts tests/unit/startup-curtain.test.ts`

Expected: 対象テストがすべてPASS。

- [ ] **Step 8: 起動カーテンの変更だけを選択してコミットする**

既存のホーム画面差分がある `DesktopRendererApp.tsx` と `app.test.tsx` は、起動関連hunkだけをステージする。`git diff --cached --name-only` と `git diff --cached` でホーム配置変更が混ざっていないことを確認する。

```powershell
git commit -m "feat(desktop): reveal workspace through branded startup"
```

---

### Task 3: 旧スプラッシュとreadiness IPCを撤去する

**Files:**
- Modify: `apps/orquesta-desktop/electron/main/index.ts`
- Modify: `apps/orquesta-desktop/electron/main/window-options.ts`
- Modify: `apps/orquesta-desktop/electron/main/window-options.test.ts`
- Delete: `apps/orquesta-desktop/electron/main/window-readiness.ts`
- Delete: `apps/orquesta-desktop/electron/main/window-readiness.test.ts`
- Modify: `apps/orquesta-desktop/electron/shared/host-contract.ts`
- Modify: `apps/orquesta-desktop/electron/preload/host-api.ts`
- Modify: `apps/orquesta-desktop/electron/preload/host-api.test.ts`
- Modify: `apps/orquesta-desktop/tests/unit/desktop-repository-bridge.test.ts`

**Interfaces:**
- Main window: `ready-to-show` で `show()`
- E2E query: `startup=instant`
- Removes: `createSplashWindowOptions`、`splashDocument`、`createWindowReadinessGate`、`DesktopHostApi.notifyRendererReady`、`DESKTOP_IPC.rendererReady`

- [ ] **Step 1: メインウィンドウの初期背景を白にする失敗テストを書く**

```ts
expect(createMainWindowOptions('C:\\app\\preload.cjs')).toMatchObject({
  show: false,
  backgroundColor: '#ffffff'
});
```

旧スプラッシュの二つのテストとimportは削除する。

- [ ] **Step 2: 背景色テストが現在の紙色で失敗することを確認する**

Run: `npm test -- electron/main/window-options.test.ts`

Expected: `#efede8` と `#ffffff` の差でFAIL。

- [ ] **Step 3: メインプロセスを一つのウィンドウに整理する**

`window-options.ts` は `createMainWindowOptions` だけを残し、背景を `#ffffff` にする。`index.ts` は旧スプラッシュとgateの変数、生成、IPC登録を削除し、次を使用する。

```ts
window.once('ready-to-show', () => window.show());
if (process.env.ORQUESTA_E2E === '1') {
  query.lang = 'en';
  query.startup = 'instant';
}
```

- [ ] **Step 4: readiness専用の契約とテストを削除する**

`DesktopHostApi.notifyRendererReady`、`DESKTOP_IPC.rendererReady`、preload実装とその期待値、テスト用host mockの同メソッドを削除する。`window-readiness.ts` と専用テストも削除する。

- [ ] **Step 5: Electron単体テストと型ビルドを通す**

Run: `npm run test:desktop-unit && npm run build:desktop`

Expected: 全テストPASS、TypeScriptとElectron bundle成功。

- [ ] **Step 6: 旧スプラッシュ参照がゼロであることを確認する**

Run: `rg -n "createSplashWindow|splashDocument|createWindowReadinessGate|rendererReady|notifyRendererReady" apps/orquesta-desktop`

Expected: 検索結果0件。

- [ ] **Step 7: 旧スプラッシュ撤去だけをコミットする**

```powershell
git add apps/orquesta-desktop/electron apps/orquesta-desktop/tests/unit/desktop-repository-bridge.test.ts
git commit -m "refactor(desktop): retire separate splash window"
```

---

### Task 4: 統合確認とWindowsパッケージ

**Files:**
- Verify only

**Interfaces:**
- Consumes: Tasks 1–3の起動カーテンと単一BrowserWindow構成

- [ ] **Step 1: 起動関連の対象テストをまとめて実行する**

Run: `npm test -- tests/unit/startup-curtain.test.ts tests/unit/startup-curtain-markup.test.ts tests/unit/app.test.tsx electron/main/window-options.test.ts electron/preload/host-api.test.ts tests/unit/desktop-repository-bridge.test.ts`

Expected: 全対象テストPASS。

- [ ] **Step 2: デスクトップ全体をビルドする**

Run: `npm run build:desktop`

Expected: renderer、main、preload、coreの全bundle成功。

- [ ] **Step 3: Windowsパッケージを更新する**

Run: `npm run package:win`

Expected: `out/Orquesta-win32-x64/Orquesta.exe` が生成される。

- [ ] **Step 4: 実機確認用アプリを起動する**

Run: `Start-Process -FilePath 'out/Orquesta-win32-x64/Orquesta.exe' -WindowStyle Normal`

Expected: 写真1が中央に表示され、最低約1.4秒後に上へフェードし、既存ホーム画面が操作可能になる。

- [ ] **Step 5: 自動確認と実機確認を区別して報告する**

自動テストとビルドの結果、起動した実行ファイルの絶対パスを報告する。アニメーションの見た目はユーザーの目視承認が必要と明記する。
