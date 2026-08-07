# Orquesta Desktop Runtime Performance

## 目的

Desktopを表示装置として軽く保ち、`.orquesta` の変更を取りこぼさず、表示更新のたびにCodex側の制御処理を繰り返さないようにする。Desktopを閉じた場合でも動くべき機構を、画面監視へ追加しない。

## 実測

2026年8月1日のpackaged Windows版を3秒待機後に測定した。

- プロジェクト未選択: 490.9 MiB、8 process
- プロジェクト選択済み: 427.9 MiB、6 process
- cold start: 1.62秒
- Electron本体、renderer、GPU、networkだけで約360 MiBを使う
- 未選択画面では、アカウント確認のためCore、Codex、conhostが起動したままになり、約155 MiBを追加で使う

Electronの基礎分を短期で大幅に減らすのは難しい。まず、明確な常駐の無駄と更新経路の無駄を直す。

## 問題

### 初回画面でCodexが常駐する

Setup Intakeは表示直後にアカウント状態を確認する。この確認は必要だが、結果を返した後もCore utility processとCodex App Serverが残る。プロジェクトを選択するまで常駐させる理由はない。

### 監視範囲が欠ける

現在は `state`、`vision`、`user_tasks`、`failures`、`v4`、`setup` のうち、選択時点で存在するフォルダだけを個別に監視する。後から作られたフォルダと深い階層の変更は監視されない。

### 投影更新と制御処理が混ざる

ファイル変更のたびに、画面用snapshotの再読込だけでなく、専門家生成とCodex task照合も実行する。表示更新が制御処理の起動条件になっており、変更が多いほど無駄なCodexアクセスが増える。

## 変更

### Coreを一時利用にする

プロジェクト未選択でのアカウント確認は、応答後にCoreを正常停止する。ログイン開始やセットアップ開始時は必要に応じて再起動する。プロジェクト選択後のCoreは従来どおり常駐する。

アカウント確認とsetup draft読込は並行するが、入力画面はdraft読込だけで表示する。接続確認が遅い場合も、画面全体を待たせず接続欄だけを確認中にする。

### `.orquesta` を一本で再帰監視する

`.orquesta` rootを再帰監視し、既存・新規・深い階層の変更を同じ経路で受ける。6本のwatcherを1本に減らす。変更通知は180msでまとめる。

### 通常変更は投影だけ更新する

通常の変更通知ではrepository snapshotとV4 operationsだけを再読込する。専門家生成は `setup/provisioning_batch.json` が変わった場合だけ再確認する。Codex task照合はproject選択時、送信直前、会話読込時の既存境界で行う。

## Desktop依存の境界

今回の変更で、Desktop表示更新が専門家生成やtask照合を無条件に駆動する状態はやめる。ただし、次の機能はまだDesktop Coreに実装されている。

- setup中のfoundation/specialist生成
- Desktopから送信したmessageとLuca質問
- inspectionの起動と停止
- runtime notificationを使うsession rotationとexecution kernel

初回setupの画面操作やDesktop固有操作はDesktop依存でよい。長期運用に必要なsession rotationはPostCompact hookがcanonical stateを更新するため、Desktopが閉じていても閾値検出は動く。successor生成の完全なheadless化は別タスクで扱う。

## 受入条件

- 初回画面のアカウント確認後にCoreとCodexが常駐しない。
- `.orquesta` 配下の新規フォルダと深いファイル変更で画面が更新される。
- 通常のファイル変更で専門家生成とCodex task照合を実行しない。
- provisioning batchの変更では従来どおり専門家生成を再確認する。
- project選択、message送信、conversation読込の既存動作を壊さない。
- focused unit testsとpackaged measurementを通す。

## 今回やらないこと

- GPU無効化による見かけ上のprocess削減
- Electronから別frameworkへの移行
- Setupの3D演出削除
- session rotation successor生成のheadless service化
