# Validation

実行日: 2026-07-17

## 環境

- Node.js: 22.16.0
- npm: 10.9.2
- React: 19
- Vite: 8.1.5
- Vitest: 4.1.10
- Browser test: Chromium / Playwright

packageの必要条件はNode.js 20.19.0以上です。

## 最終コマンド

```bash
npm run check
```

結果: exit code 0

- Vitest: 6 files / 22 tests passed
- TypeScript + Vite production build: passed
- Playwright interaction / accessibility: 10 tests passed
- Playwright visual regression: 2 tests passed
- Browser console errorとpage error: 0件
- axeのserious / critical violation: 0件

## Browser testで確認したこと

- 標準fixtureでroster全員を個別表示し、Agent DetailとTask Detailを開ける
- dispatch acceptedだけのtaskにactive animationを出さず、actual modelを`Unknown`にする
- offline projectへ切り替えたとき、古いworking表現と送信を止める
- 1366×768でHome全体をscrollさせず、Attentionだけを内部scrollさせる
- 35 agentを集約nodeへ畳まず個別表示する
- 同じprojectのsnapshot更新後もMap cameraを維持する
- Project Route、Conversation History、Advanced Operationsを開閉できる
- Map controls、User node、Team action、Composerが重ならない
- large-rosterでもMap controlsとUser nodeが重ならない
- 標準fixtureで重大なaccessibility違反とbrowser errorがない

## Visual regression

次のbaselineと比較しました。

- `tests/visual/__screenshots__/home-active-1440x900.png`
- `tests/visual/__screenshots__/home-active-1366x768.png`

review用captureは次に保存しています。

- `artifacts/screenshots/renderer-active-1440x900.png`
- `artifacts/screenshots/renderer-active-1366x768.png`
- `artifacts/screenshots/approved-vs-renderer-1440x900.png`
- `artifacts/screenshots/renderer-large-roster-1440x900.png`
- `artifacts/screenshots/renderer-offline-1440x900.png`
- `artifacts/screenshots/renderer-japanese-1440x900.png`

## Renderer境界の静的確認

- `src/renderer/`、`src/bridges/`、`src/fixtures/`に`fs`、`path`、`child_process`のimportなし
- Rendererからlocalhost、Codex App Server、`.orquesta`への直接fetchなし
- sourceに絶対user pathなし
- sourceにAPI key、passwordなどの値らしいsecretなし
- fixtureはcomponentから分離
- Renderer componentはbridge interfaceの具体実装へ直接依存しない

## Dependency audit

```bash
npm audit
npm audit --omit=dev
```

両方とも0 vulnerabilitiesでした。Vite、Vitest、React pluginは最終検証前に安全な版へ更新し、その後にunit、build、browser、visualをすべて再実行しています。

## Archive再現性

最終ZIPを別ディレクトリへ展開し、次を実行して確認しました。

```bash
unzip -t orquesta-desktop-renderer-handoff.zip
npm ci --no-audit --no-fund
npm run check
```

結果は`unzip -t`成功、`npm ci`成功、22 unit tests、10 browser tests、2 visual tests、production build、`npm audit`のすべてが成功でした。

archiveには`node_modules`、一時的なPlaywright result、local cacheを含めません。`package-lock.json`、`dist/`、source、tests、visual baseline、review capture、handoff docsを含めます。
