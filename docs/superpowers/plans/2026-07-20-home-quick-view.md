# Home Quick View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Homeの要約カードから、Homeを離れずに現在情報を少し詳しく確認できる中間表示を追加する。

**Architecture:** `DesktopRendererApp`のオーバーレイ状態へ作業一覧とユーザータスク一覧を追加する。既存の`NowListOverlay`を拡張し、新しい`UserTaskQuickView`を同じ`OverlayFrame`上に実装する。専用ワークスペースへの移動は各オーバーレイ内の明示的なボタンだけが行う。

**Tech Stack:** React 19、TypeScript、Vitest、Testing Library、既存CSS

## Global Constraints

- 既存のHome配置、データ契約、Electron境界は変更しない。
- ユーザータスクの種類別ボタンと個別項目の既存操作は維持する。
- 長時間の負荷試験と既確認のクリック耐久試験は実行しない。

---

### Task 1: Home中間表示の回帰テスト

**Files:**
- Modify: `apps/orquesta-desktop/tests/unit/app.test.tsx`
- Modify: `apps/orquesta-desktop/tests/unit/now-list-overlay.test.tsx`
- Create: `apps/orquesta-desktop/tests/unit/user-task-quick-view.test.tsx`

**Interfaces:**
- Consumes: `DesktopRendererApp`, `NowListOverlay`, `MockOrquestaBridge`
- Produces: Homeに留まる拡大操作と、明示的な全件表示操作の期待値

- [ ] **Step 1: 失敗する統合テストを書く**

```tsx
await user.click(await screen.findByRole('button', { name: 'View all work' }));
expect(screen.getByRole('dialog', { name: 'Active work' })).toBeVisible();
expect(screen.getByRole('button', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
```

```tsx
await user.click(await screen.findByRole('button', { name: 'Open all User Tasks' }));
expect(screen.getByRole('dialog', { name: 'User Tasks' })).toBeVisible();
expect(screen.getByRole('button', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
```

- [ ] **Step 2: 対象テストを実行して、現在の直接遷移が原因で失敗することを確認する**

Run: `npm test -- tests/unit/app.test.tsx tests/unit/now-list-overlay.test.tsx tests/unit/user-task-quick-view.test.tsx`

Expected: オーバーレイが存在せず、Homeが選択状態でないためFAIL。

### Task 2: 2種類の軽量オーバーレイ

**Files:**
- Modify: `apps/orquesta-desktop/src/renderer/features/now/NowListOverlay.tsx`
- Create: `apps/orquesta-desktop/src/renderer/features/attention/UserTaskQuickView.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/features/i18n/messages.ts`
- Modify: `apps/orquesta-desktop/src/renderer/styles/global.css`

**Interfaces:**
- Consumes: `AgentUiModel[]`, `TaskUiModel[]`, `AttentionUiItem[]`, `OverlayFrame`
- Produces: `NowListOverlay({ onOpenAllRecords })`と`UserTaskQuickView({ onOpenAll })`

- [ ] **Step 1: 作業一覧に明示的な全件表示ボタンを追加する**

```tsx
<button type="button" className="overlay-list__all" onClick={onOpenAllRecords}>
  {t('viewAllRecords')}
</button>
```

- [ ] **Step 2: ユーザータスクの軽量一覧を追加する**

```tsx
<OverlayFrame title={t('userTasks')} ariaLabel={t('userTasks')} className="user-task-quick-view" onClose={onClose}>
  <div className="overlay-list">{items.map(renderItem)}</div>
  <button type="button" className="overlay-list__all" onClick={onOpenAll}>{t('openAllUserTasks')}</button>
</OverlayFrame>
```

- [ ] **Step 3: 一覧とフッター操作の最小CSSを追加する**

```css
.overlay-list__all { width: 100%; border: 0; border-top: 1px solid var(--line); }
.user-task-quick-view { width: min(680px, 68vw); }
```

### Task 3: Homeから中間表示へ配線

**Files:**
- Modify: `apps/orquesta-desktop/src/renderer/app/DesktopRendererApp.tsx`

**Interfaces:**
- Consumes: `NowListOverlay`, `UserTaskQuickView`
- Produces: `OpenOverlay`の`now-list`と`user-task-quick-view`

- [ ] **Step 1: Homeカードの拡大操作をオーバーレイ状態へ接続する**

```tsx
onOpenAll={() => setOverlay({ kind: 'now-list' })}
onOpenAll={() => setOverlay({ kind: 'user-task-quick-view' })}
```

- [ ] **Step 2: オーバーレイ内の明示操作だけを専用ワークスペースへ接続する**

```tsx
<NowListOverlay onOpenAllRecords={() => openRecords('task')} />
<UserTaskQuickView onOpenAll={() => openUserTasks()} />
```

- [ ] **Step 3: 対象テストを実行する**

Run: `npm test -- tests/unit/app.test.tsx tests/unit/now-list-overlay.test.tsx tests/unit/user-task-quick-view.test.tsx`

Expected: 対象テストがすべてPASS。

- [ ] **Step 4: 通常ビルドを実行する**

Run: `npm run build`

Expected: TypeScriptとRendererビルドがexit code 0。
