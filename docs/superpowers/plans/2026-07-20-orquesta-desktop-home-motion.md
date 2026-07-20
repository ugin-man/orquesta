# Orquesta Desktop Home Motion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Homeのカードと共通オーバーレイに短く一貫した開閉、押下、新項目モーションを加える。

**Architecture:** `OverlayFrame`が閉じる状態とtimer cleanupを所有する。Project StatusとProject Launcherは内容をmountしたままCSS gridで開閉し、`global.css`が共通motion tokenと描画を担当する。地図とsetupには触れない。

**Tech Stack:** React 19、TypeScript 5.7、CSS、Vitest、Testing Library

## Global Constraints

- active agentと接続線のanimationは変更しない。
- backgroundとidle要素へ常時animationを追加しない。
- open 220ms、close 160ms、press 110ms、content delay 50ms、new item 260msを使う。
- `prefers-reduced-motion`では移動と待機を無効にする。
- 既存レイアウト、色、データ契約を変更しない。

---

### Task 1: Motion behaviorの失敗テスト

**Files:**
- Create: `apps/orquesta-desktop/tests/unit/home-motion.test.tsx`
- Modify: `apps/orquesta-desktop/tests/unit/app.test.tsx`

**Interfaces:**
- Consumes: `OverlayFrame`, `ProjectStatusCard`, `ProjectLauncher`
- Produces: 開閉状態、icon状態、遅延closeを固定するtests

- [ ] **Step 1: Project StatusとProject Launcherの失敗テストを書く**

```tsx
expect(statusToggle).toHaveAttribute('aria-expanded', 'false');
await user.click(statusToggle);
expect(statusToggle).toHaveAttribute('aria-expanded', 'true');
expect(screen.getByTestId('project-status-toggle-icon')).toHaveAttribute('data-state', 'expanded');
expect(screen.getByTestId('project-status-expanded')).toHaveAttribute('aria-hidden', 'false');
```

- [ ] **Step 2: Overlay closeの失敗テストを書く**

```tsx
vi.useFakeTimers();
await user.click(screen.getByRole('button', { name: /close/i }));
expect(screen.getByRole('dialog')).toHaveAttribute('data-motion-state', 'closing');
expect(onClose).not.toHaveBeenCalled();
await vi.advanceTimersByTimeAsync(160);
expect(onClose).toHaveBeenCalledTimes(1);
```

- [ ] **Step 3: 対象テストを実行して期待した理由で失敗することを確認する**

Run: `npm test -- --run tests/unit/home-motion.test.tsx`

Expected: motion用test id、data state、遅延closeが未実装のためFAIL。

### Task 2: OverlayFrameの開閉状態

**Files:**
- Modify: `apps/orquesta-desktop/src/renderer/components/OverlayFrame.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/styles/global.css`
- Test: `apps/orquesta-desktop/tests/unit/home-motion.test.tsx`

**Interfaces:**
- Consumes: 既存`onClose(): void`
- Produces: `requestClose()`と`data-motion-state="open|closing"`

- [ ] **Step 1: close timerを1本だけ所有する`requestClose`を実装する**

```tsx
const closeTimer = useRef<number | null>(null);
const closingRef = useRef(false);
const [closing, setClosing] = useState(false);

const requestClose = useCallback(() => {
  if (closingRef.current) return;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    onClose();
    return;
  }
  closingRef.current = true;
  setClosing(true);
  closeTimer.current = window.setTimeout(onClose, 160);
}, [onClose]);
```

- [ ] **Step 2: Escape、背景、閉じるボタンを`requestClose`へ統一する**

`onClose`の直接呼び出しをなくし、dialogとbackdropへ`data-motion-state`を付ける。effect cleanupでtimerをclearする。

- [ ] **Step 3: 個別translateとscaleでopen/close keyframesを書く**

```css
@keyframes overlay-in { from { opacity: 0; translate: 0 7px; scale: .985; } }
@keyframes overlay-out { to { opacity: 0; translate: 0 4px; scale: .985; } }
.context-overlay[data-motion-state="closing"] { animation: overlay-out 160ms ease-in both; }
```

- [ ] **Step 4: 対象テストを実行してPASSを確認する**

Run: `npm test -- --run tests/unit/home-motion.test.tsx`

Expected: overlay close tests PASS。

### Task 3: Home cardとmicro motion

**Files:**
- Modify: `apps/orquesta-desktop/src/renderer/features/project/ProjectStatusCard.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/features/project/ProjectLauncher.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/styles/global.css`
- Test: `apps/orquesta-desktop/tests/unit/home-motion.test.tsx`

**Interfaces:**
- Produces: `project-status__expanded-inner`, `project-launcher__menu-inner`, icon `data-state`

- [ ] **Step 1: Project Statusの内容を常時mountし、開閉stateを属性で渡す**

```tsx
<div data-testid="project-status-expanded" className="project-status__expanded" aria-hidden={!expanded}>
  <div className="project-status__expanded-inner">...</div>
</div>
```

- [ ] **Step 2: Project StatusのiconをMaximize2とMinimize2で切り替える**

両iconを同じspanへ重ね、`data-state`に応じてopacityとrotateをtransitionする。

- [ ] **Step 3: Project Launcherを常時mountし、閉じたbuttonを操作対象から外す**

各menu buttonへ`tabIndex={expanded ? 0 : -1}`を渡し、menuへ`aria-hidden={!expanded}`を付ける。

- [ ] **Step 4: grid row、押下、新項目animationをCSSへ追加する**

```css
.project-status__expanded,
.project-launcher__menu { display: grid; grid-template-rows: 0fr; opacity: 0; }
.is-expanded > .project-status__expanded,
.is-expanded > .project-launcher__menu { grid-template-rows: 1fr; opacity: 1; }
.floating-instrument-layer button:active:not(:disabled),
.context-overlay button:active:not(:disabled) { translate: 0 1px; }
.now-item, .attention-item { animation: home-item-in 260ms ease-out both; }
```

- [ ] **Step 5: 対象テストを実行してPASSを確認する**

Run: `npm test -- --run tests/unit/home-motion.test.tsx`

Expected: 全test PASS。

### Task 4: 対象検証と一度の実画面確認

**Files:**
- Modify only if visual correction is needed: `apps/orquesta-desktop/src/renderer/styles/global.css`
- Capture: `apps/orquesta-desktop/output/playwright/home-motion-review.png`

**Interfaces:**
- Produces: user review用の動くdesktop checkpoint

- [ ] **Step 1: Home関連unit testを一度まとめて実行する**

Run: `npm test -- --run tests/unit/home-motion.test.tsx tests/unit/app.test.tsx tests/unit/layout-density.test.ts`

Expected: 0 failures。

- [ ] **Step 2: Renderer buildを実行する**

Run: `npm run build`

Expected: exit 0。

- [ ] **Step 3: 実画面でProject Statusの開閉と共通overlayの開閉を一度確認する**

開く、閉じる、icon切替、外側クリック、Escapeだけを確認する。長時間負荷試験は行わない。

- [ ] **Step 4: ユーザーへ確認用リンクと確認項目を渡して停止する**

6個のsetup gear、agent motion、edge motionには進まない。

