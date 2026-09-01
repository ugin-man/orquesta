# Orquesta V5

Orquestaは、一人のAIに仕事を詰め込むのではなく、統括者と専門担当へ仕事を分け、長いプロジェクトをデスクトップ上で進めるためのマルチエージェント基盤です。V5では、チャットだけでなく、組織、履歴、実行状態、ファイル、音声、MAPを一つのローカルアプリにまとめています。

現在のリリース系列は `0.5.0-next` です。実際のデスクトップでチャット、ローカル音声入力、ファイル添付の基本動線を確認済みですが、まだプレビューです。

## 現在できること

- Tauri製デスクトップからCodex App Serverへ接続する
- 利用者と担当AIの会話をプロジェクト単位で保持する
- ローカルのWhisper実行系で音声を文字にする
- ファイルをNative側で検証して会話へ添付する
- 履歴、実行状態、注意事項、組織MAPを表示する
- Windows上のRuntimeと音声プロセスをアプリ終了時に回収する

## まだ完成していないこと

- 通常会話から必要な専門担当を確実に追加する本番接続
- コンテキスト圧縮後の自動セッション交代
- Workflowから組織を生成して反復運用する機能
- 複数利用者の認証と権限分離

内部機能やテストが存在するだけで、上の項目を完成扱いにはしていません。現在地は [P2完了判定とP3着手前整理](docs/v5/p2-closure-and-p3-readiness-2026-08-31.md) に記録しています。

## 構成

```text
apps/orquesta-desktop-next/   React RendererとTauriデスクトップ
packages/local-core/          会話、実行、復旧の共有Core
packages/contracts/           Renderer、Native、Runtime間の契約
packages/codex-adapter/       Codex App Serverとの接続
packages/execution-kernel/    タスク実行と専門担当の調整
packages/event-store/         イベント保存
orquesta/                     Orquestaスキルの配布元
docs/                         現行設計とV5の判断記録
```

RendererからProviderまでの現行経路と、どのファイルが状態の正本かは [Desktop Next current architecture](docs/design/2026-08-26-orquesta-desktop-next-current-architecture.md) を参照してください。

## 開発を始める

Windows、Node.js、Rust、WebView2が必要です。

```powershell
npm install
npm --prefix apps/orquesta-desktop-next install
npm --prefix apps/orquesta-desktop-next run dev:desktop
```

ブラウザ表示だけを確認する場合は次を使います。

```powershell
npm --prefix apps/orquesta-desktop-next run dev
```

ブラウザ表示はNative、音声、ファイル、Runtimeの受入証拠にはなりません。最終確認はインストールしたデスクトップで行います。

実装を再開する前に [START_HERE.md](START_HERE.md) を読んでください。

## 正本について

このリポジトリはV5だけを公開するために履歴を切り替えています。V1からV4のDesktop実装、Electron版、古いworktree、ローカルのタスク台帳は公開正本に含めません。

ファイル名に含まれる `v1`、`v2`、`v3` は、製品世代ではなくschemaやwire contractの版を表す場合があります。名前だけを根拠に削除しないでください。

## ライセンス

[MIT License](LICENSE)
