# START HERE

このリポジトリで作業するときは、古いチャットや似た名前のDesktopを先に探さず、次の順で現在地を確認します。

1. [README.md](README.md)
2. [現行アーキテクチャ](docs/design/2026-08-26-orquesta-desktop-next-current-architecture.md)
3. [P2完了判定とP3着手前整理](docs/v5/p2-closure-and-p3-readiness-2026-08-31.md)
4. 変更対象の実コード

現行デスクトップは `apps/orquesta-desktop-next` です。旧Electron DesktopやV1からV4の実装を入口にしません。この公開履歴には、それらの実装資産を含めていません。

## 変更先の目安

- 画面と操作: `apps/orquesta-desktop-next/src`
- Native境界とSQLite: `apps/orquesta-desktop-next/src-tauri/src`
- packaged Runtime: `apps/orquesta-desktop-next/runtime-node`
- 会話と実行のCore: `packages/local-core/src`
- Desktop契約: `packages/contracts/desktop`
- Provider接続: `packages/codex-adapter`

状態の権威を増やす前に、現行アーキテクチャに同じ責務の保存先がないか確認してください。エラーごとに新しいledger、journal、queue、fallbackを足すのではなく、既存の責務境界を直します。

`.orquesta`、`.agents`、`.codex-live-proof`、`output`、build成果物はローカル状態です。GitHubの製品正本には含めません。

## 製品世代とschema版を区別する

`native-bridge-manifest.v1.json`や`runtime-binding`のV2などは、製品のV1/V2ではなく保存形式や通信契約の版です。V5から過去製品を除去するときも、これらを一括削除しないでください。

## 最小確認

変更範囲に応じた型検査と対象検査だけを先に実行します。全検査の成功だけでDesktopの完成を宣言しません。チャット、音声、添付、Native lifecycleの最終判定は、インストールしたアプリを利用者が操作した結果で行います。
