# Orquesta Codex runtime / conversation overhaul

## 目的

Orquesta DesktopとCodexを、見た目だけ連携した二つのシステムではなく、同じ論理エージェントと同じ会話を扱う二つの操作面にする。

完成条件は次のとおり。

- CodexからOrquestaを開始した場合、統括者、Luca、利用者支援係、専門家はCodex内の実在するタスクである。
- Desktopから送ったメッセージは、選択した論理エージェントの現在のCodexタスクへ届く。
- Codexから送ったメッセージと回答は、Desktopの同じエージェントの履歴へ出る。
- セッション交代後も、Desktopでは一人の論理エージェントの連続した履歴として読める。
- Desktop単独利用も維持するが、Codex中心モードへ暗黙に混ざらない。
- 送信受付と実行開始と完了を区別し、送れていないのに送れたようには見せない。
- 長大な統括者履歴を毎回丸ごと読み込まない。
- 永続エージェントと一時的な外部比較・敵対監査を混同しない。

## 今回わかった問題

### 実行主体が決まっていない

現在は、Codexから起動したときの呼び出し元タスクIDを受け取れる。ただし、そのIDを使うのは主に統括者だけで、Lucaや利用者支援係や専門家はDesktop側が起動した別のApp Serverから作られることがある。

そのため、新規プロジェクトでも次の状態が起こり得る。

- Codexに見えている統括者
- DesktopのApp Serverが作った別の専門家
- `.orquesta/state/sessions.json` にだけ存在する結び付け
- Desktopでは稼働中に見えるが、ユーザーが見ているCodexには出ないタスク

これは古いデータだけの問題ではなく、実行主体を表す契約がないことが原因である。

### エージェントIDとセッションIDが混ざっている

Orquestaが継続して扱うべきものは論理的な `agent_id` であり、Codexの `thread_id` は交代可能な実行席である。現状はこの区別が一部にはあるものの、すべての送信、履歴、プロファイル、表示で徹底されていない。

特にLucaは、同じ永続セッションに対して、Codex側では通常権限、Desktop側ではLuna・読み取り専用を要求する別契約が入っている。この設計では、正常なプロファイル差まで `read_only_boundary_violation` になる。

### 送信経路が複数ある

通常チャット、Lucaへの質問、チーム管理、一時監査で送信処理が分かれている。通常チャットは対象エージェントを解決して送るが、Lucaは専用JSONと専用プロファイルを使う。この分岐が、DesktopからLucaだけ送れない、通常チャットのLuca回答だけ画面へ戻らない、といった不整合を生んでいる。

また、現在の `accepted` はApp Serverが要求を受け取ったことに近く、実際の `turn/started` や完了を意味しない。UIにはこの差が出ていない。

### 会話履歴の投影が壊れている

現行の一般会話投影は、構造化ラッパーのないユーザーメッセージを統括者向けとみなす。そのため、Codexで専門家へ直接送った普通のメッセージが、Desktopの専門家履歴から除外される場合がある。

Luca専用投影は、特定のJSON形式に入っている質問だけをユーザーメッセージとして残す。Codexや一般チャットから送った生の質問は消え、Lucaの回答だけが見える。

さらに、ページングUIがあっても内部では `thread/read(includeTurns: true)` で全履歴を読み、その後に配列を切っている。論理エージェントの世代が複数あると、世代ごとに全履歴を読む。ホームのタイムラインは複数エージェント分を並列に読むため、長い統括者で読み込み停止や大きなメモリ使用が起こる。

Codex App Serverには実験的な `thread/turns/list` と `thread/items/list` があり、保存履歴をカーソルで取得できる。対応環境ではこれを使い、非対応環境ではローカル増分索引を使う。

### 双方向の実行証拠がない

Desktop自身が開始したApp Server接続のイベントは受け取れるが、ユーザーが操作しているCodex Desktop側のタスクと同じライブ接続である保証がない。プロセス内の `thread -> target` 対応表も再起動で消える。

必要なのは「同じ保存済みthreadを読める」ことではなく、次の証拠である。

- どの実行主体がそのthreadを所有しているか
- どの送信からどのturnが開始したか
- そのturnが現在どの状態か
- DesktopとCodexが同じ論理エージェントを指しているか

### テストが構造的な二重化を見ていない

現在のテストは個別のパーサー、IPC、App Serverの呼び出しをよく確認している。一方で、まっさらなプロジェクトをCodexから開始し、複数の専門家を作り、DesktopとCodexの両側から往復し、余分な永続threadが一つも作られていないことまでは確認していない。

## 正式な実行モード

### 現行Codex Desktopとの境界

公式に公開されている深い統合経路はCodex App Serverであり、threadの作成、再開、turn開始、履歴取得、イベント購読ができる。一方、外部Electronアプリが、すでにCodex Desktop内部で動いているstdin接続のApp Serverへ後から接続する公開APIはない。Codexアプリ内の `send_message_to_thread` 相当機能も、外部アプリ向けの公開IPCではない。

したがって現行版で保証する範囲は次になる。

- DesktopとCodexが同じ保存済みthread IDと同じ履歴を使う。
- Desktop起点のturnはDesktopがライブ状態を表示する。
- 完了したturnは同じCodex taskの履歴としてCodex側でも読める。
- 同じ論理エージェントの余分なthreadを作らない。

保証できないものは、Desktop起点のturnを実行中に、Codex Desktop側も同じtaskをactive表示することである。将来、Codex Desktopの正式なホスト接続APIが提供された場合だけtransportを差し替える。非公開pipeやUI自動操作には依存しない。

### codex_hosted

CodexからOrquestaを開始したときの標準モード。

- Codex側の呼び出し元タスクを統括者の最初の実行席として使う。
- 永続エージェントの新規タスク作成はCodex側の統括者が行う。
- Desktopは永続タスクを暗黙に作成しない。
- Desktopは正本へ登録された `thread_id` にだけ送信する。
- 結び付けがない場合は失敗として表示し、standalone作成へ自動フォールバックしない。

### standalone

Codexを使わずDesktop単独で開始したときのモード。

- Desktopが自分のApp Serverを実行主体として持つ。
- 永続エージェントもその実行主体が作る。
- UIには「Desktop単独」と明示する。
- Codexに見えるタスクであるかのようには表示しない。

### migrating

standaloneからCodex中心へ、ユーザーが明示的に移すときだけ使う一時状態。

- 新規送信を短時間止める。
- 論理エージェント、未完了タスク、ユーザー判断、引き継ぎ情報をスナップショットする。
- Codex側に新しい実行席を作る。
- 全エージェントの受領証を確認する。
- 実行主体を一度だけ切り替える。
- 旧Desktop実行席は読み取り専用の履歴として残す。

旧V3・旧V4の自動互換処理は通常起動へ入れない。古い状態を検出したら `legacy_project_requires_migration` で止め、OrquestaとHelpには別の一回限りの移行処理を用意する。

## 正本データ

### RuntimeBinding

`.orquesta/state/runtime-binding.json` を追加する。

最低限、次を持つ。

```json
{
  "schema_version": 1,
  "project_id": "orquesta",
  "project_root_fingerprint": "...",
  "mode": "codex_hosted",
  "runtime_authority_id": "...",
  "transport": "codex_shared_app_server",
  "calling_thread_id": "...",
  "established_at": "...",
  "verified_at": "...",
  "migration": null
}
```

秘密情報は保存しない。起動時にproject rootと呼び出し元を再検証し、別の主体が同じプロジェクトの所有権を取ろうとした場合は止める。

### AgentSessionBinding

`sessions.json` の各実行席に次の意味を持たせる。

- `agent_id`: 変わらない論理エージェント
- `generation`: セッション交代世代
- `thread_id`: Codexの実行席
- `runtime_authority_id`: どの実行主体に属するか
- `visibility`: `codex_task` または `desktop_only`
- `profile_id`: その世代で固定するモデル・権限契約
- `session_kind`: `persistent_agent` または `ephemeral_run`
- `binding_status`: `warming`, `active`, `retired`, `missing`, `conflict`

同じ `agent_id` にactiveな所有者を二つ許さない。モデルや権限契約を変えるときは同じthreadへ押し込まず、正式な世代交代を使う。

### MessageLedger

`.orquesta/state/messages.jsonl` を追加し、送信と実行証拠を追記する。

一件は次を持つ。

- `message_id`
- `idempotency_key`
- `correlation_id`
- `origin_surface`: `codex` または `desktop`
- `agent_id`
- `session_generation`
- `thread_id`
- `turn_id`
- `status`: `queued`, `dispatch_accepted`, `turn_started`, `completed`, `failed`
- `created_at`, `updated_at`
- 失敗時の短い理由

本文の正本はCodex threadとし、ledgerには重複送信防止と状態確認に必要な情報だけを持つ。

## 統一メッセージ経路

すべての永続エージェントへの送信を一つのサービスへ通す。

1. `agent_id` を受け取る。
2. RuntimeBindingが有効か確認する。
3. activeなAgentSessionBindingを一件だけ解決する。
4. プロファイル契約が一致するか確認する。
5. MessageLedgerへ `queued` を記録する。
6. 同じ `thread_id` へ `turn/start` を送る。
7. 応答のturn IDで `dispatch_accepted` を記録する。
8. `turn/started` を観測して初めて実行中にする。
9. 完了または失敗イベントで確定する。

Lucaもこの経路を使う。説明専用の軽量実行を残す場合は、永続Lucaと同じIDを偽装せず、Lucaが所有する明示的な `ephemeral_run` として扱う。

Desktopの送信直後は、履歴に保留中メッセージを表示する。受付、開始、失敗の状態を小さく表示し、タイムアウト後の再送では同じidempotency keyを使う。

## 会話履歴

### 投影

一般会話とLuca会話の別パーサーを廃止し、一つの投影器にする。

- 構造化されたOrquesta envelopeは対象agentを明示的に読む。
- 生のCodexユーザーメッセージは、そのthreadを所有するagentの発言として扱う。
- user、agent、system receiptを落とさない。
- 表示名は `Coordinator` 固定ではなくagent registryから取る。
- セッション世代は `agent_id` 単位で時系列結合する。
- 世代交代は履歴中に一行のシステムイベントとして表示する。

### 取得

起動時にApp Server capabilityを確認する。

- `thread/turns/list` が使える場合: カーソルと `itemsView` を使い、表示分だけ取得する。
- `thread/items/list` が使える場合: 新着差分の取得に使う。
- 非対応の場合: threadの更新時刻を見て、変更されたthreadだけを一度読み、ローカル索引へ差分保存する。
- UIの「さらに読み込む」は実データ取得と一致させる。
- ホームのタイムラインはローカル索引を読み、全エージェントの全threadを開かない。

履歴取得に失敗しても送信機能まで壊さない。UIは `history_unavailable` と再試行を表示する。

### ユーザー指示の扱い

専門家との直接会話は単なるチャットで終わらせない。プロジェクト判断を変える内容は `directive_candidate` として記録し、専門家が採用・却下・要確認を返す。採用した場合は統括者へ短い変更通知を送る。雑談や説明要求は通常チャットのままにする。

## ツリーと状態表示

ツリーはcanonical AgentSessionBindingの投影にする。

- activeな永続エージェントだけを稼働中として表示する。
- missing/conflictは稼働中に見せず、問題状態を表示する。
- 一時監査は常設組織へ混ぜず、実行中だけ一時ノードとして出す。
- Codex中心モードでは `codex_task` でない永続エージェントを禁止する。
- DesktopとCodexの状態が一致しない場合は、古いキャッシュで正常に見せず `同期確認中` または `競合` にする。

## 実装ワークフロー

### Phase 1: 実行主体とIDの一本化

- RuntimeBinding schema/storeを追加する。
- 起動時に `codex_hosted` と `standalone` を確定する。
- `sessions.json` にauthority、visibility、profile、kindを追加する。
- 複数active ownerと暗黙フォールバックをfail closedにする。

完了条件:

- 新規セットアップで実行モードと実行主体が永続化される。
- 各sessionが実行主体、表示種別、プロファイル、永続・一時区分を持つ。
- 実行主体の競合をテストで再現し、必ず停止できる。

### Phase 2: エージェント生成の修正

- codex_hostedの永続エージェント作成をCodex統括者側へ移す。
- 作成結果のthread IDと受領証をcanonical stateへ登録する。
- Lucaと利用者支援係も同じ規則へ入れる。
- 外部比較と敵対監査はephemeral runとして分離する。

完了条件:

- まっさらなセットアップ後、Codexで全永続エージェントを確認できる。
- 余分な隠れた永続threadがゼロである。

### Phase 3: 送信経路の一本化

- 通常チャットとLuca専用送信を統合する。
- MessageLedgerとidempotencyを入れる。
- dispatch accepted、turn started、completed、failedをUIへ出す。
- profile変更をsession rotationへ限定する。

完了条件:

- Desktopから統括者、Luca、専門家へ送り、同じCodexタスクでturn開始を確認できる。
- 連打や再試行で同じ内容が二重送信されない。

### Phase 4: 履歴と双方向同期

- 統一投影器へ置き換える。
- App Serverのページング対応とローカル増分索引を入れる。
- Codex側で行った会話をDesktopへ反映する。
- セッション世代を論理エージェント単位で結合する。
- ホームのタイムラインを増分索引へ切り替える。

完了条件:

- userとagentの両方が欠けずに見える。
- 長い統括者でも最初の画面表示で全履歴を読まない。
- 旧世代を含む履歴を一人のエージェントとして読める。

### Phase 5: 明示的なstandaloneからCodexへの移行

- Connect to Codex操作を追加する。
- スナップショット、作成、受領、切替、旧席読み取り専用化をトランザクション化する。
- 途中失敗時は旧実行主体を維持する。

完了条件:

- 移行前後で未完了タスクと履歴を失わない。
- 移行途中に二つの実行主体が同時にactiveにならない。

### Phase 6: 実Desktop総合確認

個別修正ごとに同じ重い検証は繰り返さない。契約テストは各Phaseで一度、実Desktop確認は最後にまとめる。

確認シナリオ:

1. まっさらなプロジェクトをCodexから開始する。
2. 統括者、Luca、利用者支援係、専門家を作る。
3. Desktopから各一件送り、Codexの同じタスクでturn開始を見る。
4. Codexから各一件送り、Desktopにuserとagent両方が出ることを見る。
5. Lucaの説明、失敗、再送を確認する。
6. 統括者を世代交代し、履歴が一つに見えることを確認する。
7. 長大履歴で初期表示時間とメモリを測る。
8. 永続thread数が論理エージェント数と一致することを確認する。

## ユーザーレビューの位置

レビューは三回にまとめる。

- Phase 2後: CodexとDesktopのエージェントが一つになったか
- Phase 4後: 双方向会話と履歴が自然に使えるか
- Phase 6後: 実運用として合格か

細かい内部テストのたびにユーザーを止めない。性能検証は履歴実装後に一度だけ行い、問題が実際に出ていない操作を変更のたびに再検証しない。

## 今回触らないもの

- V3以前への一般的な後方互換
- OrquestaとHelpの個別移行実行
- ツリーの組織配置ルールそのもの
- Electronから別フレームワークへの移行
- セキュリティ層の追加

これらを混ぜると、今回の正本である実行主体と会話の修復が遅れるため、別タスクにする。
