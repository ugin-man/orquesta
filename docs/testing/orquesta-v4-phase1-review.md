# Orquesta V4 Phase 1 レビュー手順

Phase 1の最終確認は、リポジトリルートで次を実行する。

```powershell
npm run review:v4:phase1
```

このコマンドはV3、V4、OneDrive live probe、三fixture、Workbench API、実Chrome、projection replayを一度に確認する。途中の一項目が失敗した場合も、独立して実行できる確認は続ける。ただし最終状態は`changes_requested`になり、`ready_for_user_review`にはしない。

成功時に見るファイルは次のとおり。

- `output/v4-phase1-review/phase-1-review.md`
- `output/v4-phase1-review/checks.json`
- `output/v4-phase1-review/fixture-results.json`
- `output/v4-phase1-review/browser-smoke.json`
- `output/v4-phase1-review/workbench.png`
- `output/v4-phase1-review/workbench-mobile.png`
- `output/v4-phase1-review/recovery-report.json`

`phase-1-review.md`の5分手順で三fixtureを確認した後、このCodex統括タスクへ戻る。Workbenchには採用やPhase承認を書き込む操作はない。ユーザーがこのタスク上で`Phase 1 approved`または変更内容を明示するまで、Phase 2は始めない。

Nodeの`engines >=20`は互換対象であり、レビュー資料の`tested_node_versions`には実際にfull gateを通したruntimeだけを記録する。実行していないNode versionを確認済みとは書かない。
