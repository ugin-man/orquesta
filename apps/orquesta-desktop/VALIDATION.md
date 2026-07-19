# Orquesta Desktop Validation

このファイルはV4統合後のWindows Desktop gateです。ChatGPT Renderer handoff時点の記録は正にしません。実行日は2026-07-19、環境はWindows 11 Pro 10.0.26200 x64、Node.js 24.12.0、npm 11.6.2です。packageの最低条件はNode.js 22.12.0です。

## 証拠の分け方

- Deterministic：schema、projection、adapter、Core、Main、Preload、componentの決定論テスト
- Browser：fixtureを使うlayout、interaction、accessibility、visual regression。filesystemや実Codexの証拠にはしない
- Electron：本物のRenderer、Preload、Main、Core utility processを起動するtest
- Fake runtime：protocol互換fixtureでthread、turn、approval、failure、遅延応答を再現するtest
- Real packaged runtime：同梱したCodex 0.144.5で実際にinitialize、turn、history、shutdownを行うtest

これらは代用できません。たとえばBrowserが通ってもpackage済みEXEの証拠にはならず、Fake runtimeが通っても本物のCodexが起動した証拠にはなりません。

Fake runtime testはpackage前のElectronだけで使います。package済みEXEは`ORQUESTA_E2E_CODEX_SCRIPT`を渡してもfake Coreへ切り替わらず、必ず同梱runtimeを使います。

## 依存の準備

repository rootで実行します。rootとDesktopはlockfileを分けています。

```powershell
npm ci --no-audit --no-fund
npm ci --no-audit --no-fund --prefix apps/orquesta-desktop
```

## V4 verifier

```powershell
npm run check:v4:phase1
npm run check:v4:phase15
npm run check:v4:phase2
npm run check
```

Phase 1、1.5、2A、2Bのcontract、projection、Core command、Audit、Evidenceをroot側で確認します。Desktop testへ暗黙に混ぜません。

## Desktop deterministic、Browser、Visual

```powershell
npm run validate:lockfile --prefix apps/orquesta-desktop
npm run test:desktop-scripts --prefix apps/orquesta-desktop
npm run check --prefix apps/orquesta-desktop
```

`check`はVitest、TypeScript/Vite build、Browser interaction/accessibility、Visual regressionを実行します。Browserはfixture補助証拠です。

## ElectronとFake runtime

```powershell
npm run test:desktop-smoke --prefix apps/orquesta-desktop
```

このcommandは次を確認します。

- sandboxed Rendererが限定Preload APIだけを使う
- 実`.orquesta`をCoreが読み、canonical file更新を反映する
- 初回起動で偽fixtureを表示せずproject chooserを出す
- 35 agentを省略せず、Windows 100、125、150、200%でMapを操作できる
- fake App ServerでComposer、history、runtime eventを結線できる
- delayed turn中も100文字入力とMap操作が500 ms以上止まらない
- project切り替え後に古いwatcher eventを出さず、終了後にfake/runtime childが残らない

## Packageと本物のCodex

```powershell
npm run make:win --prefix apps/orquesta-desktop
npm run verify:packaged-runtime --prefix apps/orquesta-desktop
npm run test:packaged-runtime --prefix apps/orquesta-desktop
```

package verifierは`resources/codex-runtime/node_modules/@openai`が`codex-sdk`、`codex`、`codex-win32-x64`の3つだけであることを確認します。3つのmetadataと一つのregular `codex.exe`をmanifestと照合します。

Real packaged runtime testはruntime overrideを設定せず、一時projectと一時user-dataで次を行います。

- App Server initialize
- project thread作成
- 無害な一つのprompt
- `turn_started`、agent message、`turn_completed`
- `thread/read`でuserとagentのmessageを再読取
- app終了後のdescendant process 0
- 一時projectとuser-dataの削除

このtestはpackage済みEXEの実画面でComposerへpromptを入力し、Send buttonを押します。fake runtimeで代用せず、実Codexの完了後に同じthreadのuser／agent messageを再読取します。approvalとfailureの制御された異常系はpackage前のFake runtime testが担当します。

詳細は[packaged-runtime.md](./docs/validation/packaged-runtime.md)にあります。

## Performanceとメモリ

```powershell
npm run measure:desktop --prefix apps/orquesta-desktop
npm run test:interaction-retention --prefix apps/orquesta-desktop
```

60秒計測は計測用windowのnative mouse inputを無効にして行います。現在の結果は次の通りです。

- cold start 1,075 ms、上限4,000 ms
- no-project working set 314.95 MiB、上限400 MiB
- selected-project working set 390.33 MiB、上限400 MiB
- UI/Core footprint 306.28 MiB
- Codex runtime footprint 390.28 MiB
- total footprint 696.56 MiB

30分runは10〜20分が385.55〜385.46 MiBで横ばいでした。22分と26.5分付近にユーザー操作が入ったため、純idle証拠とは呼びません。最終値は434.73 MiB、5分時点からの増加は43.11 MiBでした。

操作保持testは35 agentへ6回のpan、wheel、detail開閉、Fit、zoom batchを行います。Playwright traceを切り、詳細開閉はnative eventとして実行します。最新結果は次の通りです。

- baseline 348.92 MiB
- 6 batch直後395.88 MiB
- 1分回復後387.97 MiB
- final retained working set 39.05 MiB、上限75 MiB
- first warmed batch後からの追加9.06 MiB、上限30 MiB
- post-GC JS heap +0.74 MiB、上限8 MiB
- DOM counter、live DOM、event listenerの最終増加0

最終増加の内訳はRenderer +33.68 MiB、GPU +6.55 MiBです。Mainとnetworkはbaselineより微減しました。これは操作後のWorking Set増加が最初の描画／V8容量確保に集中し、その後は頭打ちになることを示します。予約されたWorking SetはすぐにはOSへ返らない場合がありますが、処理中のtask、DOM、listener、到達可能なJS objectが操作回数に比例して残っている状態ではありません。詳しいprocess別証拠は[desktop-interaction-retention.md](./docs/validation/desktop-interaction-retention.md)にあります。

## Security boundary

最終gateでは次も個別に確認します。

```powershell
npm run test:desktop-unit --prefix apps/orquesta-desktop -- window-options.test.ts host-api.test.ts ipc-handlers.test.ts
```

確認対象は`sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`、local packaged content、navigation/new-window拒否、opaque attachment ID、IPC input上限です。Rendererから`process`、`require`、filesystem、child process APIへ到達できないこともElectron testで確認します。

## 配布物

- `out/make/squirrel.windows/x64/OrquestaSetup.exe`
- `out/make/zip/win32/x64/Orquesta-win32-x64-0.1.0.zip`
- `out/Orquesta-win32-x64/Orquesta.exe`

SetupとZIPはコード署名していません。Windowsの発行元警告をなくすには、証明書と署名工程が必要です。auto update、Microsoft Store、macOS、Linux packageも今回の対象外です。

要件ごとの証拠と残る制限は[V4 Desktop統合レビュー](./docs/validation/v4-desktop-integration.md)にまとめます。
