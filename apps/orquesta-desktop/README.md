# Orquesta Desktop Renderer

Orquesta V4 DesktopのHome画面を、Electron統合前にブラウザで確認するためのReact Rendererです。中央のOrquesta Map、Now、Project Status、Attention、Composer、各種overlayを、型付きfixtureと`MockOrquestaBridge`で動かします。

この段階ではElectron、Codex App Server、ローカルファイル、実際の`.orquesta` stateには接続しません。画面内にも`Prototype data`と表示します。

## 必要なもの

- Node.js 20.19.0以上
- npm
- browser testを実行する場合はChromium

## 起動

```bash
npm ci
npm run dev
```

## Commands

```bash
npm run dev          # Vite開発サーバー
npm run build        # TypeScript確認とproduction build
npm test             # Vitest unit / component test
npm run test:browser # Playwright interaction / accessibility test
npm run test:visual  # 1440×900 / 1366×768 visual regression
npm run check        # test、build、browser、visualをまとめて実行
npm run preview      # distのローカルpreview
```

Playwrightで既定のChromiumを使えない環境では、実行ファイルを指定できます。

```bash
PLAYWRIGHT_CHROMIUM_PATH=/path/to/chromium npm run test:browser
```

## Fixture切り替え

URL queryの`fixture`で状態を切り替えます。

```text
?fixture=active-project
?fixture=all-idle
?fixture=attention-heavy
?fixture=large-roster
?fixture=offline-project
?fixture=unknown-evidence
?fixture=long-japanese-text
```

日本語表示は`lang=ja`です。

```text
?fixture=long-japanese-text&lang=ja
```

## 主な構成

```text
src/
  renderer/
    app/                 画面全体のstateとbridge呼び出し
    features/map/        2D Map、stable layout、pan / zoom / fit / reset
    features/now/        現在作業の要約
    features/attention/  未処理項目と履歴
    features/project/    Project Status、Route、Switcher
    features/composer/   命令入力と会話履歴への入口
    features/details/    Agent Detail、Task Detail
    features/team/       Team Management
    features/operations/ Advanced Operations shellと言語切り替え
    styles/              desktop固定layoutとvisual tokens
  contracts/             UI projectionとbridge interface
  bridges/               MockOrquestaBridge
  fixtures/              検証用snapshot
```

Renderer componentはNode.js APIやfilesystemへ直接アクセスしません。Electron統合境界、visual invariant、検証結果は[`README-UI-HANDOFF.md`](./README-UI-HANDOFF.md)と[`VALIDATION.md`](./VALIDATION.md)を参照してください。
