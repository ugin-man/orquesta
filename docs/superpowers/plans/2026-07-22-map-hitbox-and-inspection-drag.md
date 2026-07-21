# Map Hitbox and Inspection Drag Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agentの判定枠を丸アイコンへ一致させ、概要比較と敵対監査を永続的にドラッグ移動可能にする。

**Architecture:** `MapViewport`の既存pointer処理を検査Agentへ拡張し、`ManualLayoutState`へ後方互換なoffsetを追加する。ノードと接続線は同じeffective positionを読む。

**Tech Stack:** React、TypeScript、Vitest、Playwright、Electron

## Global Constraints

- セットアップと組織形成には触れない。
- 既存version 3の手動配置を保持する。
- 4pxのドラッグ閾値とpointer captureの後始末を維持する。
- 変更対象をMapとその直接テストに限定する。

---

### Task 1: 判定枠の中心をアイコンへ揃える

**Files:**
- Modify: `apps/orquesta-desktop/src/renderer/features/map/MapViewport.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/features/map/map.css`
- Test: `apps/orquesta-desktop/tests/electron/map-stability.spec.ts`

**Interfaces:**
- Consumes: `visualScaleForZoom(zoom)`
- Produces: `interactionSizeForZoom(zoom, baseSize)`とアイコン中心基準のDOM

- [ ] **Step 1: REDテストを追加する**

ブラウザの`getBoundingClientRect()`でAgentボタンと`.agent-node__icon`の中心差が1px以下、名前の中心がボタン下端より下にあることを検査する。

- [ ] **Step 2: REDを確認する**

Run: `npm --prefix apps/orquesta-desktop exec playwright test --config=playwright.electron.config.ts tests/electron/map-stability.spec.ts`

Expected: 現状ではボタン中心とアイコン中心がずれて失敗する。

- [ ] **Step 3: 最小実装を行う**

見た目コンテナをアイコン高へ固定し、copyをその下へoverflowさせる。判定寸法は`baseSize * visualScaleForZoom(zoom)`を24pxからbaseSizeへclampする。

- [ ] **Step 4: 対象テストを通す**

Run: `npm --prefix apps/orquesta-desktop exec playwright test --config=playwright.electron.config.ts tests/electron/map-stability.spec.ts`

Expected: PASS。

### Task 2: 検査Agentの永続ドラッグを追加する

**Files:**
- Modify: `apps/orquesta-desktop/src/renderer/features/map/manual-layout.ts`
- Modify: `apps/orquesta-desktop/src/renderer/features/map/MapViewport.tsx`
- Test: `apps/orquesta-desktop/tests/unit/manual-layout.test.ts`
- Test: `apps/orquesta-desktop/tests/unit/map-viewport.test.ts`

**Interfaces:**
- Consumes: `InspectionKind`、既存pointer frame処理
- Produces: `ManualLayoutState.inspectionOffsets: Record<string, Point>`

- [ ] **Step 1: 保存形式のREDテストを追加する**

version 3の既存保存値を読み込むと`inspectionOffsets`が空になり、2種類の有効offsetだけが保存・復元されることを検査する。

- [ ] **Step 2: ドラッグのREDテストを追加する**

検査ボタンへpointerDown、pointerMove、pointerUpを送り、localStorageの`inspectionOffsets.external_benchmark`が更新されることを検査する。

- [ ] **Step 3: REDを確認する**

Run: `npm --prefix apps/orquesta-desktop run test -- tests/unit/manual-layout.test.ts tests/unit/map-viewport.test.ts`

Expected: `inspectionOffsets`と検査pointer処理が存在せず失敗する。

- [ ] **Step 4: 最小実装を行う**

`InspectionDrag`とpending updateを追加し、effective inspection pointへoffsetを足す。終了時にversion 3 stateを保存し、ドラッグ後だけクリックを抑止する。

- [ ] **Step 5: 対象テストを通す**

Run: `npm --prefix apps/orquesta-desktop run test -- tests/unit/manual-layout.test.ts tests/unit/map-viewport.test.ts`

Expected: PASS。

### Task 3: Desktopへ反映する

**Files:**
- Verify: `apps/orquesta-desktop`

- [ ] **Step 1: Map関連テストをまとめて通す**

Run: `npm --prefix apps/orquesta-desktop run test -- tests/unit/manual-layout.test.ts tests/unit/map-viewport.test.ts`

Expected: PASS、warning 0。

- [ ] **Step 2: Desktopをbuildする**

Run: `npm --prefix apps/orquesta-desktop run build`

Expected: exit 0。

- [ ] **Step 3: packaged Desktopを再起動する**

現在のworktreeから`Orquesta.exe`を再生成または既存buildへ反映し、実画面で丸の中心クリックと検査Agentドラッグを確認する。
