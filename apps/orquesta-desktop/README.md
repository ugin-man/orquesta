# Orquesta Desktop

Orquesta V4のWindows向けElectronアプリです。中央のOrquesta Map、Now、Project Status、Attention、Composer、各種overlayをReact Rendererで表示します。Electron Main、sandboxed Preload、別utility processのOrquesta Coreで構成しています。

製品起動時は選択したプロジェクトの`.orquesta` stateを読み取り、変更を自動反映します。Composerからの指示はCodex App Serverでプロジェクト専用の統括スレッドへ送り、会話履歴も同じスレッドから読みます。fixtureはレイアウトと回帰テストだけに使います。

## 必要なもの

- Windows 10または11
- Node.js 22.12.0以上
- npm
- Codex Desktopまたはstandalone Codex CLI

Codexの実行ファイルは、standalone CLI、インストール済みCodex Desktopの順で探します。自動検出できない場合は`ORQUESTA_CODEX_PATH`へ`codex.exe`の絶対パスを指定できます。Codex runtimeをOrquestaのpackageへ重複同梱はしません。

## 起動

```bash
npm ci --no-audit --no-fund
npm run dev:desktop
```

`dev:desktop`は内部でViteを起動し、外部browserではなくElectron windowを開きます。

## Commands

```bash
npm run dev:desktop        # ViteとElectronを一緒に起動
npm run build:desktop      # Renderer、Main、Preload、Coreをbuild
npm run start:desktop      # production buildをElectronで起動
npm run test               # Vitest unit / component / host test
npm run test:desktop-smoke # 実Electronの起動、Preload、Core疎通test
npm run package:win        # out/Orquesta-win32-x64を生成
npm run make:win           # Windows installerとzipを生成
npm run measure:desktop    # package済みexeの起動、memory、sizeを実測
npm run validate:lockfile  # lockfileのdependency sourceを検証
```

Browser testとvisual regressionはRenderer fixtureの補助検証として残しています。製品の正式な実行環境ではありません。

```bash
npm run test:browser
npm run test:visual
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
  bridges/               Electronとfixtureのbridge
  fixtures/              検証用snapshot
electron/
  main/                  native window、IPC、Core lifecycle
  preload/               Rendererへ公開する限定API
  core/                  projectとCodex接続を担うutility process
  shared/                host contract
```

Renderer componentはNode.js APIやfilesystemへ直接アクセスしません。読み取り統合は[`docs/validation/repository-integration.md`](./docs/validation/repository-integration.md)、Codex接続は[`docs/validation/codex-runtime.md`](./docs/validation/codex-runtime.md)、当初の実測値は[`docs/validation/desktop-foundation.md`](./docs/validation/desktop-foundation.md)にあります。
