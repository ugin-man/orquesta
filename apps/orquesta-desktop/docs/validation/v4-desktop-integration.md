# Orquesta V4 Desktop統合レビュー

実施日: 2026-07-19

対象branch: `codex/orquesta-desktop-electron`

性能と実packageの証拠commit: `6cdfcf2`

この文書は[承認済み設計](../../../../docs/superpowers/specs/2026-07-18-orquesta-v4-desktop-integration-design.md)を、現在のsource、test、package、実測へ対応させたレビュー資料です。自動testの合格とユーザーの使用感レビューは分けます。最終ユーザー承認はまだ記録しません。

## 結論

one-runtime architecture、project switching、approval relay、conversation history、V4 Operations、repository-only fallback、package footprint、memory gatesは実装と再実行可能な証拠があります。DesktopはV4 Phase 1、1.5、2A、2Bの正規packageを使い、MainやRendererへ別の判断ロジックを複製していません。

Setup、ZIP、展開packageは生成済みです。code signingは未実施です。selected-project idle memoryは上限400 MiBに対して390.33 MiBで合格していますが、余裕は9.67 MiBしかありません。これは隠さず既知の監視点にします。

## 証拠クラス

- Deterministic: schema、projection、adapter、Core、Main、Preload、componentの再現可能なtest
- Browser: fixtureによるlayout、interaction、accessibility、visual regression
- Electron: Renderer、Preload、Main、Core utility processを同時に起動するtest
- Fake runtime: protocol fixtureでapproval、failure、遅延turnを制御するtest
- Real packaged runtime: 配布package内の本物のCodex 0.144.5を起動するtest

Browserはwindow、filesystem、package、実Codexを証明しません。Fake runtimeは実runtimeのidentityやsessionを証明しません。Real packaged runtime testも、実行していない画像入力やapproval requestまで証明したことにはしません。

Fake runtimeへの切り替えはpackage前のElectronだけに限定しています。package済みEXEでは`ORQUESTA_E2E_CODEX_SCRIPT`を渡してもfake Coreを選ばず、同梱runtimeを使います。したがってpackageの正常系は実Codex、制御されたapproval／failure異常系はpackage前のFake runtimeという二つの証拠を組み合わせています。

## 要件と証拠

| 要件 | 判定 | 証拠クラス | 主な証拠 |
| --- | --- | --- | --- |
| V4 Phase 1、1.5、2A、2BとDesktopが一つのbranchにある | 証明済み | Deterministic | `npm run check:v4:phase1`、`check:v4:phase15`、`check:v4:phase2`、merge履歴 |
| one-runtime architectureで正規Adapterだけを使う | 証明済み | Deterministic | `packages/codex-adapter/test/*`、`electron/core/runtime-location.test.ts`、source-boundary audit |
| pinned Windows runtime以外を起動しない | 証明済み | Deterministic、Real packaged runtime | `verify-packaged-runtime.mjs`、`runtime-integrity.test.ts`、[packaged-runtime.md](./packaged-runtime.md) |
| Composerの文章がproject threadへ届く | 証明済み | Electron、Fake runtime、Real packaged runtime | `runtime-integration.spec.ts`、`packaged-runtime.spec.ts`。package testも実画面のComposerとSend buttonを使う |
| 画像をopaque IDで送り、実pathをRendererへ出さない | 結線を証明 | Deterministic | `attachment-service.test.ts`、`ipc-handlers.test.ts`、`desktop-codex-service.test.ts`。実runtime turnでは画像を送っていない |
| conversation historyを同じthreadから読む | 証明済み | Deterministic、Electron、Real packaged runtime | `app-server-adapter.test.js`、`runtime-integration.spec.ts`、`packaged-runtime.spec.ts` |
| approval relayが提示optionだけを一度返す | 結線を証明 | Deterministic、Electron、Fake runtime | `approval-relay.test.js`、`desktop-codex-service.test.ts`、`runtime-integration.spec.ts`。実runtime testではapprovalを強制していない |
| dispatch、turn started、completion、failureを分ける | 証明済み | Deterministic、Electron、Fake runtime | `desktop-codex-service.test.ts`、`runtime-integration.spec.ts` |
| requested、applied、actual modelを混同しない | 証明済み | Deterministic、Electron | `model-evidence.test.js`、`repository-integration.spec.ts` |
| project switching後に古いwatcherとstateを出さない | 証明済み | Deterministic、Electron | `project-registry.test.ts`、`repository-integration.spec.ts`、`runtime-responsiveness.spec.ts` |
| V3 stateとV4 journalをCoreでprojectionする | 証明済み | Deterministic、Electron | `repository-reader.test.ts`、`repository-runtime.test.ts`、`v4-operations-projection.test.ts` |
| V4 OperationsでCapability、Acquisition、Audit、Evidenceを確認する | 証明済み | Deterministic、Browser、Visual | `v4-operations-projection.test.ts`、`interaction.spec.ts`、`home.visual.spec.ts` |
| repository-only fallbackを実行成功に見せない | 証明済み | Deterministic、Electron、Fake runtime | `repository-adapter.test.js`、`desktop-codex-service.test.ts`、`runtime-integration.spec.ts` |
| `codex://` fallbackは下書きだけを開く | 証明済み | Deterministic | `ipc-handlers.test.ts`。Mainがproject pathとpromptを作り、任意URLを受け取らない |
| 35 agentを省略せずMapへ表示する | 証明済み | Deterministic、Browser、Electron | map unit tests、`interaction.spec.ts`、`map-stability.spec.ts` |
| 100、125、150、200%で主要labelを表示し、Home全体をscrollしない | 証明済み | Electron | `map-stability.spec.ts` |
| turn中もComposerとMapが500 ms以上止まらない | 証明済み | Electron、Fake runtime | `runtime-responsiveness.spec.ts` |
| RendererからNode、filesystem、child processへ到達できない | 証明済み | Deterministic、Electron | `window-options.test.ts`、`host-api.test.ts`、`ipc-handlers.test.ts`、`desktop-shell.spec.ts` |
| package identity、realpath、version、integrityを検査する | 証明済み | Deterministic、Real packaged runtime | `verify-packaged-runtime.test.mjs`、`verify-packaged-runtime`、[packaged-runtime.json](./packaged-runtime.json) |
| 終了後にCore、watcher、App Server、Codexが残らない | 証明済み | Electron、Real packaged runtime | `runtime-responsiveness.spec.ts`、`packaged-runtime.spec.ts` |
| Setup、ZIP、展開packageを同じbuildから生成する | 証明済み | Package artifact | `npm run make:win`と下記SHA-256 |
| Windows performance gateを満たす | 証明済み | Packaged measurement、Electron | [desktop-foundation.md](./desktop-foundation.md)、[desktop-interaction-retention.md](./desktop-interaction-retention.md) |
| code signing未実施を明記する | 既知の制限 | Distribution review | README、VALIDATION、本書 |

## Package artifacts

- Setup: `apps/orquesta-desktop/out/make/squirrel.windows/x64/OrquestaSetup.exe`
  - 267,076,096 bytes、254.70 MiB
  - SHA-256 `69D51A8DC67D8989261FEDF79BE3263748EB16E70DE9AB09641E72E2ECA4DAA3`
- ZIP: `apps/orquesta-desktop/out/make/zip/win32/x64/Orquesta-win32-x64-0.1.0.zip`
  - 275,598,166 bytes、262.83 MiB
  - SHA-256 `4E7D2C95E5186C6B3EBF33A1B1DF9FD7D7DB5729C966D95DCAE74FB05426EDC1`
- 展開package EXE: `apps/orquesta-desktop/out/Orquesta-win32-x64/Orquesta.exe`
  - 225,485,824 bytes、215.04 MiB
  - SHA-256 `60FBAB8557FA77B7050C487A427926109A9CDCE808DD241BD2F6A5D2C98C5DDB`

SetupとZIPはコード署名していません。hashは同一性確認用で、発行元署名の代わりにはなりません。

## Package footprint

展開packageの計測値です。

- UI/Core: 306.28 MiB
- Codex runtime: 390.28 MiB
- total: 696.56 MiB

350 MiBは合計packageの合否条件に使いません。runtimeを除外して小さく見せず、内訳と合計を両方公開します。

## Memory gates

60秒idleは計測windowへのnative mouse inputを無効にして測りました。

- cold start: 1,075 ms、上限4,000 ms
- no-project working set: 314.95 MiB、上限400 MiB
- selected-project working set: 390.33 MiB、上限400 MiB

30分観測は10〜20分がほぼ横ばいでした。22分と26.5分付近にユーザー操作が入ったので、純idle証拠とは呼びません。[desktop-leak.md](./desktop-leak.md)はinteractive long-run observationとして残しています。

この操作後増加を別testで再現しました。35 agentに6 batchのpan、wheel、detail開閉、Fit、zoomを行った結果は次の通りです。

- baseline: 348.92 MiB
- 6 batch直後: 395.88 MiB
- 1分回復後: 387.97 MiB
- final retained working set: +39.05 MiB、上限75 MiB
- first warmed batch後からの追加: +9.06 MiB、上限30 MiB
- post-GC JS heap: +0.74 MiB、上限8 MiB
- DOM counter、live DOM、event listenerの最終増加: 0

最初の描画容量確保後は増加が頭打ちになり、一部は1分で戻りました。操作回数に比例するreachable object leakではありません。

## Security boundary

DesktopはCodex sandboxを再実装しません。受け持つのはElectron sandbox、context isolation、nodeIntegration無効、typed IPC、input上限、opaque attachment ID、local packaged content、navigation拒否、pinned runtime identity、approval bindingです。

独自command risk parser、別sandbox、credential vault、Codex Desktop UI automationは追加していません。runtimeが提示したapprovalだけをユーザーへ渡します。

## 残る制限

- code signing、auto update、Microsoft Store公開は未実施
- Windows x64以外のpackageはない
- Real packaged runtime testは無害なtext turnとhistoryを確認した。画像とapprovalの実runtime発火は強制しておらず、そこはDeterministic、Electron、Fake runtime証拠である
- selected-project idle working setの余裕は9.67 MiBで小さい。今後の常駐機能追加では同じ計測を再実行する必要がある
- 30分観測の最後10分には手動操作が入り、純idle 30分の証拠ではない。10〜20分の横ばいと操作保持testを別々に採用した
- Phase 3のExperience Ledger、Intent Graph、macOS、Linux、cloud worker、enterprise SSOは今回含めない

## ユーザーレビュー

自動gateの後に、SetupまたはZIPからの起動、project切り替え、Mapの見やすさ、日常利用時の重さをユーザーが確認します。明示的な合格が出るまで、Desktop統合の最終承認とは記録しません。
