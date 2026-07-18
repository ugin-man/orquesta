# Map Stabilization validation

実施日: 2026-07-18

## 対象

production buildしたRendererとElectron hostをElectron 43で起動し、`large-roster` fixtureの35体を表示した。これはMap描画の検証であり、実リポジトリの`.orquesta`読取はまだ含まない。

確認した操作はFit、pan、Zoom inを5回、Zoom outを5回、agent選択、詳細表示、詳細を閉じた後の再Fitである。agentは省略表示やgroup化をせず、35体すべてDOMに残した。

## 結果

| 条件 | 実際のdevicePixelRatio | agent | 親子edge | node重なり | 500ms以上のlong task |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1440x900 / 100% | 1.00 | 35 | 35 | 0 | 0 |
| 1366x768 / 125% | 1.25 | 35 | 35 | 0 | 0 |
| 1440x900 / 150% | 1.50 | 35 | 35 | 0 | 0 |
| 1366x768 / 200% | 2.00 | 35 | 35 | 0 | 0 |

Windows Electronの起動引数だけでは125%以上のDPIがRendererへ反映されなかったため、DPI条件はChrome DevTools Protocolの`Emulation.setDeviceMetricsOverride`で再現した。各条件で`window.devicePixelRatio`が指定値になったことを別に確認している。

## 見た目の確認

基準画像はagent詳細を閉じた中立状態で撮った。選択中の薄暗い状態をMapの合格画像にはしていない。

- user、orchestrator、orchestrator直下5体が同じ組織階層として読める。
- specialist配下とsub-agent配下が別の深さに出る。
- 低zoomではicon、短縮名、status dotを残す。
- 拡大時は文字とiconをscreen-spaceで再描画し、Map全体のbitmap拡大にしない。
- 1366x768でもNow、Attention、Composerの裏にagent中心が隠れない。

基準画像は`tests/electron/__screenshots__/map-stability-*.png`にある。毎回の実行結果は`artifacts/map-stability-metrics.json`へ出す。

## 実行方法

```powershell
npm run build:desktop
npx playwright test --config=playwright.electron.config.ts tests/electron/map-stability.spec.ts
```

## 次の境界

ここまでで任意の組織をfixtureから描くところは完了した。次はread-only integrationで、`.orquesta/state/agents.json`とtask stateを同じprojectionへ接続する。
