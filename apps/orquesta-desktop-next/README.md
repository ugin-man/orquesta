# Orquesta Desktop Next

Orquesta Desktop Next は、Orquesta V5の現行デスクトップ本体です。React 19 + TypeScriptのRenderer、Tauri 2のnative host、Node sidecar、共有Core / Codex adapterを一つの実行経路で接続します。

## 現行の実装入口

- 製品 host: `apps/orquesta-desktop-next/src-tauri/`
- Renderer: `apps/orquesta-desktop-next/src/`
- Node sidecar: `apps/orquesta-desktop-next/runtime-node/`
- 共有 Core: `packages/local-core/src/`
- Renderer↔Tauri 契約: `packages/contracts/desktop/`
- Codex App Server adapter: `packages/codex-adapter/`

詳細な責務と状態権威は [Desktop Next current architecture](../../docs/design/2026-08-26-orquesta-desktop-next-current-architecture.md) に集約します。リポジトリ全体の入口は [README](../../README.md)、実装を再開するときの入口は [START_HERE](../../START_HERE.md) です。

## 開発コマンド

```text
npm --prefix apps/orquesta-desktop-next install
npm run typecheck
npm test
npm run test:runtime
npm run build
npm run dev:desktop
```

Windows bundle、Rust compile、OS containment は対応 toolchain 上で別途検証が必要です。JavaScript / TypeScript の成功を native compile の証明として扱わないでください。
