# Orquesta Desktop

Orquesta V4のWindows向けElectronアプリです。中央のOrquesta Map、Now、Project Status、Attention、Composer、各種overlayをReact Rendererで表示します。Electron Main、sandboxed Preload、別utility processのOrquesta Coreで構成しています。

製品起動時は選択したプロジェクトの`.orquesta` stateを読み取り、変更を自動反映します。Composerからの指示と画像はCodex App Serverでプロジェクト専用の統括スレッドへ送り、会話履歴も同じスレッドから読みます。fixtureはレイアウトと回帰テストだけに使います。

通常起動では透明なOrquestaロゴを短く表示してから本体を開きます。日本語Windowsでは日本語を初期選択し、言語設定とプロジェクトごとのComposer下書きを次回起動まで保持します。

## 利用環境

- Windows 10または11
- Codex Desktopまたはstandalone Codex CLI

SetupまたはZIP版を使うだけならNode.jsとnpmは不要です。sourceからbuildする場合だけNode.js 22.12.0以上とnpmが必要です。

Codexの実行ファイルは、standalone CLI、インストール済みCodex Desktopの順で探します。自動検出できない場合は`ORQUESTA_CODEX_PATH`へ`codex.exe`の絶対パスを指定できます。Codex runtimeをOrquestaのpackageへ重複同梱はしません。

## 配布物

- `out/make/squirrel.windows/x64/OrquestaSetup.exe`: 通常のWindowsインストーラー
- `out/make/zip/win32/x64/Orquesta-win32-x64-0.1.0.zip`: 展開して使う版
- `out/Orquesta-win32-x64/Orquesta.exe`: build確認用の展開済み実行ファイル

現在の0.1.0開発buildはコード署名していません。Windowsが発行元の警告を出す場合があります。一般公開で警告をなくすには、別途コード署名証明書と署名工程が必要です。

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
    features/operations/ 言語とデスクトップ統合状態
    styles/              desktop固定layoutとvisual tokens
  contracts/             UI projectionとbridge interface
  bridges/               Electronとfixtureのbridge
  fixtures/              検証用snapshot
electron/
  main/                  native window、splash、画像選択、IPC、Core lifecycle
  preload/               Rendererへ公開する限定API
  core/                  projectとCodex接続を担うutility process
  shared/                host contract
```

Renderer componentはNode.js APIやfilesystemへ直接アクセスしません。読み取り統合は[`docs/validation/repository-integration.md`](./docs/validation/repository-integration.md)、Codex接続は[`docs/validation/codex-runtime.md`](./docs/validation/codex-runtime.md)、当初の実測値は[`docs/validation/desktop-foundation.md`](./docs/validation/desktop-foundation.md)にあります。
