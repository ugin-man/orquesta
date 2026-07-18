# Orquesta Desktop Home と組織マップの設計

## 目的

Desktop版のHomeを、Orquestaの全体像を一画面で把握できる操作面として完成させる。

今回優先するのはHomeである。過去タスク、過去エラー、質問一覧などの専用タブは後続へ分ける。Homeでは、今の組織、実行証拠のある作業、ユーザー対応、プロジェクト状況、統括者への入力を扱う。

## 現状の問題

現在の画面は任意階層を描画する基礎はあるが、Orquesta固有の組織構造を表していない。

- `assignedByAgentId`だけで全員を汎用ツリーへ流し込み、基盤役、利用者支援役、制作役が同じ列に並ぶ。
- agentの組織上の親と、現在タスクの委譲元が混ざっている。タスク更新で組織図まで動く可能性がある。
- 通常ズームでも長いmissionを表示するため、説明文と接続線が重なる。
- 実装係のような同じ役割のagentが視覚的にまとまらない。
- Mapの外形が点線の四角になり、中央の円形観測窓を中心にウィジェットが周囲を囲む構図が崩れている。
- Nowが複数の大きなカードを縦に積み、画面の下へはみ出す。完了ログに近い長文もHomeへ出ている。
- Project Statusの`working`は実行証拠の意味が分かりにくく、Nowとの表示条件も揃っていない。
- 言語切替が詳細操作の中に隠れている。初回言語も起動URLから英語へ固定される。
- Main Windowは`ready-to-show`で表示されるため、Reactが初期状態を描く前の背景だけが見える余地がある。

## 検討した方法

### 汎用ツリーをそのまま改善する

現在の階層計算へ余白と衝突回避だけを足す方法である。実装量は少ないが、利用者支援役と制作役の意味を表せない。同じ役割もまとまらず、今回の問題を見た目だけで隠すことになるため採用しない。

### agentごとの位置を固定する

今いる12体に合わせて座標を決める方法である。現在の画面は整えやすいが、agentが増減した時点で破綻する。プロジェクトごとの構成差にも対応できないため採用しない。

### Orquesta固有の意味を投影してから自動配置する

agentを指揮軸、運用、利用者支援、制作へ分類し、制作役だけを役割別グループへ入れる。その意味モデルから座標と線を計算する。agentは全員個別表示し、折り畳みや`+N`は使わない。

この方法を採用する。固定座標ではなく分類規則と配置規則を固定するため、現在の12体にも将来の1体から80体にも同じ考え方を使える。

## 組織の意味

### 指揮軸

- `user`を最上位に置く。
- `orchestrator`をuserの下へ置く。
- この縦軸は他の枝より強い線で結ぶ。

### 運用ノード

- `orquesta-admin`はuserの左側へ小さく置く。
- 制作agentとして数えず、統括者の制作枝へ接続しない。
- 現行Orquestaプロトコルでは初回設定、option、Orquesta自体の調整を持つ必須基盤役なので、今回のUI変更では削除しない。
- 長期的にDesktopの設定機能へ吸収するかは、bootstrapとstate schemaを含む別のプロトコル移行として判断する。

### 利用者支援枝

- `user-liaison`はuserから分岐する。
- `vision-curator`と`error-concierge`はuser-liaisonの下へ置く。
- user-liaisonが存在しない古いprojectでは、vision-curatorとerror-conciergeをuserへ直接接続する。
- この枝は統括者の制作指揮下に見せない。

### 制作枝

- 上記の基盤役以外は制作agentとして扱う。
- 統括者直下の制作agentを、安定したrole分類で次のグループへ分ける。
  - implementation
  - design
  - qa
  - docs
  - protocol
  - research
  - other
- 同じグループのagentは一つの薄い枠の中へ配置する。実装係1、2、3は同じimplementation枠へ入る。
- 枠は折り畳みではない。全agent nodeを常にDOMとMapへ残す。
- agentが別の制作agentを明示的な親に持つ場合は、その親の下へ委譲階層として配置する。子agentの存在も隠さない。
- status、current task、heartbeatの変化ではグループと基本位置を変えない。

### 古いprojectとの互換

agent stateに明示的な組織親がなければ、上記の基盤role規則とrole分類を使う。現在タスクの`assigned_by_agent_id`は作業線には使うが、組織上の親を決める材料には使わない。

新しいcanonical組織ファイルは今回追加しない。まずDesktop側の意味投影を安定させる。将来projectごとにrole分類そのものを変更する必要が確認できた場合だけ、別タスクで組織メタデータをstate schemaへ加える。

## 円形Map

- Map viewportは画面中央の真円にする。点線はworld boundsではなく、観測窓の境界である。
- Mapのworldは円の中でpan、zoomできる。Home全体はscrollしない。
- Fitは全agentと全groupが円の安全領域へ入る倍率を計算する。
- agentが多い場合はworldを広げ、semantic zoomを下げる。nodeを消さない。
- 点線の四角いworld boundaryは削除する。
- Map操作ボタンは円の上部へ置き、周囲のウィジェットより弱く見せる。

## agent nodeの情報量

Homeのnodeに常時出す情報を次へ限定する。

- icon
- display name
- 短いrole名
- status dotと短いstatus
- current task ID

mission、長いtask title、progress summary、evidence、required readingはagentまたはtaskを押した詳細画面へ移す。

semantic zoomは次の三段階とする。

- overview: icon、短縮名、status dot
- normal: display name、短いrole、status、task ID
- detail: current task titleを最大2行まで追加

接続線は直線または直交線にする。通常状態でCubic Bezierは使わない。線はnodeやgroupのportへ接続し、説明文の領域を横切らない。

## 手動配置

- 自動配置を初期値とする。
- userはagentをdragして位置を微調整できる。
- 移動量はproject IDとagent IDに紐づくapp-owned localStorageへ保存する。canonical `.orquesta` stateは書き換えない。
- group枠は中のagent位置から再計算する。
- Fitは現在の手動配置を保つ。
- Resetは手動配置を消して自動配置へ戻し、その後Fitする。
- 4px未満の移動はclickとして扱い、詳細画面を開く操作を壊さない。

## 周囲のウィジェット

### Now

Nowは左側の一つの固定パネルへまとめる。見出しは一度だけ表示し、実行証拠のある現在作業だけを行として並べる。

各行はagent、task ID、短い進捗、経過時間、進捗線を表示する。長文は2行で切り、完全な内容はtask detailへ移す。件数が多い場合はNow内部だけscrollする。

NowとProject Statusは同じ実行証拠条件を使う。staleなturnやdispatch acceptedだけをWorkingにしない。

### Project Status

- `working`は`実行確認済み`または`proven working`と明示する。
- agent総数と、実行証拠のある稼働数を分ける。
- 日本語と英語の切替をProject Status上で常に見える小さな切替として置く。
- 保存済み言語を優先し、保存がない場合はWindowsの言語から初期値を決める。

### AttentionとComposer

Attentionの内部scroll、画面下中央のComposer、右下toastは維持する。Home全体を下へ伸ばさない。

## 起動表示

Main WindowはRendererの初期snapshotまたは明示的な読込エラーが描画された通知を受けてから表示する。

- splashはRenderer ready通知まで残す。
- 通知が来ない場合も永久に隠れないよう、上限時間でエラーを表示できるMain Windowへ切り替える。
- 二回目の起動は既存Windowを復元して前面へ出す。
- project未選択の状態では、白い背景だけでなく`Orquesta projectを開く`画面が最初の可視状態になる。

## エラー時の扱い

- roleが未知でもother groupへ置き、agentを落とさない。
- 親が欠ける、自己参照、cycleがある場合は統括者直下へ戻し、diagnosticを残す。
- user-liaisonなどの基盤roleが欠けても残りのagentを表示する。
- localStorageの配置値が壊れている場合はその値だけ無視する。
- Renderer ready通知が失敗しても、Main Windowを永久に非表示にしない。

## 検証

新しい挙動はテストを先に追加する。

- 役割分類と基盤枝の親子関係
- 実装係1、2、3が同じgroupへ入り、全員が個別nodeとして残ること
- nested delegation、missing parent、cycle
- statusとtaskだけの更新で組織配置が変わらないこと
- 1、12、35、80 agentでnodeを落とさないこと
- 円形viewportと四角いworld boundaryの削除
- overview、normal、detailの表示内容
- drag保存、Fit維持、Reset消去
- NowとProject Statusの証拠条件一致
- 日本語初期値とHome上の言語切替
- project未選択起動でonboardingが最初の可視画面になること
- 1366x768と1440x900でHome全体scrollがなく、Composerと主要ウィジェットが欠けないこと
- Windows表示倍率100、125、150、200%でagent nodeが重ならず、500ms以上の停止がないこと

最終の見た目は、承認済みreference画像と同じviewportの実装画像を並べて比較する。文字、余白、色、画像品質、copyを確認し、P0からP2が残る場合は完成扱いにしない。

## 今回含めないもの

- 過去タスク専用タブ
- 過去エラー専用タブ
- 質問一覧専用タブ
- Orquesta Adminのプロトコルからの削除
- canonical state schemaへの自由配置座標の追加
- agentの折り畳み、非表示、`+N`集約
- Phase 3機能

## 完成条件

- 中央Mapが真円の観測窓として表示される。
- user、統括者、運用、利用者支援、制作groupの意味が一目で読める。
- 同じ役割がまとまり、agentは全員個別表示される。
- Home nodeの長文が消え、線と説明文が重ならない。
- Mapのpan、zoom、Fit、Reset、agent選択、task選択、手動配置が動く。
- Now、Project Status、Attention、ComposerがHome内へ収まる。
- 表示するWorkingが実行証拠と一致する。
- Homeから日本語と英語を切り替えられる。
- project未選択の初回起動で白画面にならない。
- unit、browser、visual、Electron、buildの検証が通る。
- 実リポジトリを開いた完成画面をユーザーが確認できる。
