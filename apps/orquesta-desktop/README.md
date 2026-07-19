# Orquesta Desktop

Orquesta V4をWindowsで使うためのElectronアプリです。中央のOrquesta Mapを残したまま、プロジェクトの状態、Codexとの会話、承認要求、V4の判断記録を一つの画面から扱えます。

このアプリは単なるRendererではありません。Electron Main、sandboxed Preload、別utility processのOrquesta Core、同梱したCodex App Serverで動きます。`.orquesta`の読取とCodex接続はCoreが担当し、Rendererからfilesystemや子processへ直接触れません。

## できること

- Orquesta projectを開き、最近使ったprojectを切り替える
- agentとtaskを35体以上でも省略せずMapへ表示し、パン、ズーム、個別配置を行う
- Composerから統括者または選択したagent宛てに文章と画像を送る
- 同じproject threadの会話履歴をアプリ内で読む
- Codexから届いた承認要求をAttentionで確認し、提示された選択肢だけを返す
- Capability、Acquisition、Audit、EvidenceをV4 Operationsで確認する
- Codexが起動できない場合、repository-onlyとして表示し、送信成功を偽らない
- 必要な場合だけCodex Desktopへ下書きを開く。これは自動送信ではない

projectごとのthread ID、最近使ったproject、言語、Composer下書きはアプリ用のregistryへ保存します。project切り替え時は古いwatcher、subscription、runtime bindingを終了します。

## Codex runtime

Windows x64向けruntimeをOrquestaの配布物へ固定して同梱します。

- `@openai/codex-sdk@0.144.5`
- `@openai/codex@0.144.5`
- `@openai/codex-win32-x64@0.144.5-win32-x64`

PATH、`ORQUESTA_CODEX_PATH`、WindowsApps、任意の`codex.exe`は使いません。package時に3つのmetadataと実行ファイルのSHA-256をmanifestへ記録し、起動前にも同じresources内にあることを検査します。Coreは`spawn(..., { shell: false })`で一つのApp Serverを遅延起動します。

Codexのsandboxと通常のapproval boundaryをそのまま使います。Orquestaが別のcommand risk parserやsandboxを重ねることはありません。アプリはAPI keyを要求せず、ユーザーの通常のCodex sessionを使います。

## 利用環境

- Windows 10または11、x64
- SetupまたはZIP版の利用にはNode.jsとnpmは不要
- sourceからbuildする場合はNode.js 22.12.0以上とnpm
- Codex操作には利用可能な通常のCodex sessionが必要

## 配布物

- `out/make/squirrel.windows/x64/OrquestaSetup.exe`：Windows installer、267,076,096 bytes、254.70 MiB
- `out/make/zip/win32/x64/Orquesta-win32-x64-0.1.0.zip`：展開して使う版、275,598,166 bytes、262.83 MiB
- `out/Orquesta-win32-x64/Orquesta.exe`：build確認用の展開済み実行ファイル

同じ`npm run make:win`からSetup、ZIP、展開packageを生成します。展開packageの内訳はUI/Core 306.28 MiB、Codex runtime 390.28 MiB、合計696.56 MiBです。圧縮後のZIPサイズとは別の値です。

現在の0.1.0開発buildはコード署名していません。Windowsが発行元の警告を出す場合があります。一般配布にはコード署名証明書と署名工程が別途必要です。

## 起動と開発

source checkoutから起動する場合は、repository rootで依存を入れます。

```powershell
npm ci --no-audit --no-fund
npm ci --no-audit --no-fund --prefix apps/orquesta-desktop
npm run dev:desktop --prefix apps/orquesta-desktop
```

`dev:desktop`はViteとElectronを一緒に起動します。外部browserは製品実行環境ではありません。

よく使うcommandは次の通りです。

```powershell
npm run build:desktop --prefix apps/orquesta-desktop
npm run start:desktop --prefix apps/orquesta-desktop
npm run test:desktop-smoke --prefix apps/orquesta-desktop
npm run make:win --prefix apps/orquesta-desktop
npm run verify:packaged-runtime --prefix apps/orquesta-desktop
npm run test:packaged-runtime --prefix apps/orquesta-desktop
npm run test:interaction-retention --prefix apps/orquesta-desktop
npm run measure:desktop --prefix apps/orquesta-desktop
npm run validate:lockfile --prefix apps/orquesta-desktop
```

V4とDesktopはlockfileを分けています。最終確認ではrootのV4 verifierとDesktop suiteを別々に実行します。詳しいcommandと証拠の違いは[VALIDATION.md](./VALIDATION.md)にあります。

## 主な構成

```text
src/
  renderer/              画面、入力、選択、表示用state
  contracts/             UI projectionとbridge interface
  bridges/               Electron bridgeとfixture bridge
  fixtures/              layoutと回帰検証用snapshot
electron/
  main/                  window、splash、picker、IPC、Core lifecycle
  preload/               Rendererへ公開する限定API
  core/                  repository projectionとCodex接続
  shared/                host contract
```

Coreはroot packageの`@orquesta/codex-adapter`、EventStore、V4 projectionを使います。Mainに重複したApp Server clientや`.orquesta`判定は置きません。

## 検証資料

- [V4 Desktop統合レビュー](./docs/validation/v4-desktop-integration.md)
- [実Codex runtime検証](./docs/validation/packaged-runtime.md)
- [Codex接続の構成](./docs/validation/codex-runtime.md)
- [起動、idle memory、package内訳](./docs/validation/desktop-foundation.md)
- [操作後メモリ保持](./docs/validation/desktop-interaction-retention.md)
- [repository読取と切り替え](./docs/validation/repository-integration.md)

## 現在の制限

- Windows x64だけをpackageする
- code signing、auto update、Microsoft Store公開は未実施
- macOS、Linux、cloud worker、enterprise SSOは対象外
- Phase 3のExperience LedgerとIntent Graphは今回含めない
- V4 Operationsは読取を中心にし、正規commandとrevision bindingがない操作ボタンは出さない
- `codex://` fallbackは下書きを開くだけで、自動送信しない
