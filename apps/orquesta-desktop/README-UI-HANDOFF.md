# Orquesta Desktop Renderer UI Handoff

作成日: 2026-07-17

## この成果物について

これは、承認画像を基準に作ったOrquesta Desktop HomeのReact Rendererです。ブラウザ上では型付きfixtureと`MockOrquestaBridge`で動きます。Codex側では、このRendererを作り直さず、同じ`apps/orquesta-desktop/`へElectronの`main`、`preload`、実データadapterを追加してください。

画面内には`Prototype data`と表示します。Electron、Codex App Server、ローカルファイル、実際の`.orquesta` stateにはまだ接続していません。

## 必要な環境

- Node.js 20.19.0以上
- npm
- browser test用のChromium

Linux環境では`/usr/bin/chromium`を自動利用します。別のChromiumを使う場合は`PLAYWRIGHT_CHROMIUM_PATH`で指定できます。

## Install / Run / Verify

```bash
npm ci
npm run dev
npm run build
npm test
npm run test:browser
npm run test:visual
npm run check
```

主なcommandの意味:

- `npm run dev`: Vite開発サーバー
- `npm run build`: TypeScript確認とproduction build
- `npm test`: Vitest unit / component test
- `npm run test:browser`: build後にPlaywright interaction / accessibility test
- `npm run test:visual`: build後に1440×900と1366×768のvisual regression
- `npm run check`: unit test、build、browser test、visual testをまとめて実行
- `npm run preview`: `dist/`のローカルpreview

## Entry points

- Renderer bootstrap: `src/main.tsx`
- App controller: `src/renderer/app/DesktopRendererApp.tsx`
- UI projection: `src/contracts/orquesta-ui.ts`
- Bridge contract: `src/contracts/bridge.ts`
- Prototype bridge: `src/bridges/mock-bridge.ts`
- Fixture catalog: `src/fixtures/index.ts`
- Global desktop styling: `src/renderer/styles/global.css`

## Fixture一覧

| Query value | 確認内容 |
|---|---|
| `active-project` | 標準Home、working agents、delegation、question、approval、error |
| `all-idle` | activityとAttentionがない静かな状態 |
| `attention-heavy` | 40件以上の未処理項目と100件以上の履歴、内部scroll |
| `large-roster` | 35 agentを畳まず個別表示、pan / zoom / fit |
| `offline-project` | stale snapshot、animation停止、Composer送信不可 |
| `unknown-evidence` | dispatch acceptedとturn startedを区別、actual model unknown |
| `long-japanese-text` | 長い日本語project名、task、role、Attention文 |

例:

```text
http://localhost:5173/?fixture=unknown-evidence
http://localhost:5173/?fixture=long-japanese-text&lang=ja
```

## 実装済みUI

- Home全体を固定viewportへ収めたfloating instrument構成
- roster全員を個別nodeとして表示する2D Orquesta Map
- pan、zoom、Fit、Reset、agent focus、task selection
- runtime evidenceがあるactive routeだけのmotion
- `prefers-reduced-motion`対応
- Now card stackとactive work一覧
- Project Status、Project Route、Project Switcher
- Attention、Attention History、mock resolution
- 下中央Composer、target切り替え、Enter送信、Shift+Enter改行
- mock Conversation History
- Agent Detail、Task Detail
- Team Managementとmock proposal approval
- Advanced Operations shellと日本語 / 英語切り替え
- offline、unknown、stale、empty、large roster状態
- keyboard focus、Escape close、modal focus trap、基本accessibility
- Vitest unit / component test
- Playwright interaction / accessibility / visual test

## Electron統合で追加する範囲

次の実装は、Renderer componentから分離したまま追加します。

```text
apps/orquesta-desktop/
  electron/
    main/
    preload/
    adapters/
```

追加対象:

- Electron mainとcontext-isolated preload
- typed IPC
- project registryとdirectory picker
- `.orquesta` reader、UI projection、watcher
- Codex App Server stdio adapter
- repository-only fallback
- thread / turn / event接続
- message、approval、review、attachment action
- Windows splash、window設定、installer

`ElectronOrquestaBridge`は`src/contracts/bridge.ts`の`OrquestaRendererBridge`を満たし、component側のAPIを変えずに差し替えます。App ServerやfilesystemのschemaはadapterでUI projectionへ変換してください。

## 触ってはいけない境界

- Rendererから`fs`、`path`、`child_process`、Node.js APIをimportしない。
- Rendererからlocalhost dashboardやCodex App Serverへ直接fetchしない。
- `.orquesta` stateやApp Server eventをcomponentへ直接渡さない。
- `dispatch accepted`を`turn started`や`working`へ昇格させない。
- actual modelの証拠がなければ`unknown`のままにする。
- offline時に古いworking animationを続けない。
- rosterのidle / standby agentを折り畳まない。
- Homeへ固定rail、top tab、全体縦scrollを追加しない。
- 中央Mapよりfloating panelを強くしない。
- component内へfixtureや実state schemaをhard-codeしない。

## Visual invariants

- warm off-whiteの紙感、白黒中心、semantic colorは小さなmarkerだけ
- 中央Mapが最大の情報面積と視線を持つ
- Nowは左、Project Statusは右上、Attentionは右、Composerは下中央
- Homeの`html`、`body`、rootはviewport高へ固定
- scrollはAttention、履歴、詳細、Routeなど各overlay内部だけ
- active motionはruntime evidenceのあるagent / edgeだけ
- panelはfloating cardであり、左右いっぱいのrailにしない
- 1366×768でもComposerと主要panelを重ねない
- 35 agent fixtureでも全員を個別nodeとして残す

## Visual assetsと確認画像

- 承認済みreference: `public/reference/orquesta-desktop-home-approved.png`
- 紙grain: `public/reference/paper-grain.png`
- 1440×900標準fixture: `artifacts/screenshots/renderer-active-1440x900.png`
- 1366×768標準fixture: `artifacts/screenshots/renderer-active-1366x768.png`
- 承認画像との比較: `artifacts/screenshots/approved-vs-renderer-1440x900.png`
- large roster: `artifacts/screenshots/renderer-large-roster-1440x900.png`
- offline: `artifacts/screenshots/renderer-offline-1440x900.png`
- 長い日本語: `artifacts/screenshots/renderer-japanese-1440x900.png`
- visual regression baseline: `tests/visual/__screenshots__/`

承認済みreferenceは実行時の背景や装飾には使わず、比較資料として保持しています。承認画像は1487×1058、必須確認viewportは1440×900と1366×768なので、完全なpixel matchではなく、構図、情報階層、余白、配色、浮遊窓の位置関係を基準に合わせています。

## 最終検証

2026-07-17に`npm run check`を実行し、次を確認しました。

- Vitest: 6 test files、22 tests passed
- TypeScript + Vite production build: passed
- Playwright interaction / accessibility: 10 tests passed
- Playwright visual regression: 2 tests passed
- browser console errorとpage error: 0件
- axeのserious / critical violation: 0件（`region` ruleのみ画面構成上の理由で除外）
- `npm audit`: 0 vulnerabilities

詳細は`VALIDATION.md`を参照してください。

## 既知の未実装

- 実project folderの選択とregistry保存
- 実conversation、approval、review、attachment処理
- filesystem watcherとApp Server streamed event
- Advanced Operations各sectionの本体
- Electron splash、native menu、installer
- cameraとComposer draftの永続化
- floating panelのdrag再配置

これらをRenderer側で偽装するbrowser fallbackは入れていません。

## Codex intakeの順番

```bash
npm ci
npm run check
```

その後、`src/contracts/bridge.ts`と`src/contracts/orquesta-ui.ts`を読んでからElectron adapterを追加します。layout変更が必要な場合は、先に差分と理由をユーザーへ示し、Rendererを一から作り直さないでください。
