# Inspection Agent Detail Design

## Purpose

外部比較と敵対監査を、一時的な検査実行として扱ったまま、マップ上から現在状態と履歴を確認し、中止できるようにする。

## Behavior

- マップは `queued`、`running`、`cancelling` の検査だけを表示する。
- 検査ノードをクリックすると、Team Managementではなく専用の非モーダル詳細パネルを開く。
- 詳細パネルは現在状態、対象、注目点、実行ID、開始時刻、エラー、同種の実行履歴を表示する。
- 実行中の検査は詳細パネルとTeam Managementの両方から同じ中止処理を呼ぶ。
- `queued` でruntime IDがまだない検査も中止でき、`cancelled` として履歴へ残す。
- 中止成功後は詳細パネルを閉じ、検査ノードをマップから消す。
- 通常エージェント、管理係、ルカの役割や表示には触れない。

## Verification

- Controller単体テストでruntime ID未発行のqueued検査が中止できることを証明する。
- Renderer単体テストで検査ノードが専用詳細パネルを開き、Team Managementへ遷移しないことを証明する。
- Electronテストでデスクトップ上のクリック、中止、マップからの消失を確認する。
