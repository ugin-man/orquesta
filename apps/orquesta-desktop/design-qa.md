# Desktop Home design QA

確認日: 2026-07-19

比較対象は `public/reference/orquesta-desktop-home-approved.png` と `artifacts/screenshots/renderer-active-1440x900.png`。同じ1440×900の画像を横に並べた `artifacts/screenshots/comparison-approved-current-1440x900.png` で確認した。

## 判定

- P0: 0件
- P1: 0件
- P2: 0件
- 結果: 合格

## 確認したこと

- 中央マップは四角ではなく円形で、画面全体はスクロールしない。
- ユーザー、統括者、全エージェントを省略せず表示する。
- 少人数では役割を横方向へ広げ、同じ役割が複数いる場合だけ枠でまとめる。
- 入れ子の委譲線を残し、長い役割説明はノード上に出さない。
- ノードには名前、短い役割、状態、現在のタスクIDだけを出す。
- Nowは一つのパネルにまとめ、稼働証拠がある担当だけを表示する。
- AttentionとNowはパネル内部だけがスクロールする。
- 日本語と英語をProject Statusから切り替えられる。
- 1366×768と1440×900で、マップ操作、Team Management、Composerが重ならない。
- 35人、80人、深い委譲でもノードを削除せず、Fit後に重ならない。
- 100%、125%、150%、200%のElectron表示倍率でノード重なりがない。

## 既知の境界

35人以上を全体表示すると、個々の文字は概要表示になる。ノード自体は全員残り、ズームすると名前、役割、状態、タスクIDが戻る。これは全員を隠さず表示するための意図した動作。

# 適応型組織ツリー Design QA

確認日: 2026-07-21

承認したC案 `artifacts/screenshots/c-reference-approved.png` と、Electronの2ラインfixture `artifacts/screenshots/electron-map-adaptive-two-line.png` を比較した。全画面を横に並べた比較画像は `artifacts/screenshots/c-reference-vs-electron-final.png`。35体と80体はElectron E2Eで別に確認した。

## 判定

- P0: 0件
- P1: 0件
- P2: 0件
- final result: passed

## 見た目と情報設計

- 既存の温かい紙色、黒と灰色、細い点線、角丸、文字体系をそのまま使った。
- アイコンは既存のLucideとAgent glyphを使い、新しい画像や独自SVGは追加していない。
- User、Project Core、Line、Team、Role cluster、Agentの順で読める。
- Line見出しには名前、状態、LeadまたはOwnerを出す。Team見出しはAgentと重ならない専用領域を持つ。
- 同じ役割は同じTeamの中だけでまとめる。複数Roleを持つTeamだけRole枠を表示し、単一Roleでは同じ名前を二重表示しない。
- overviewでは名前、状態、タスクIDを短く表示し、長い説明は選択後の詳細へ残した。
- retired、superseded、provisioning、provisioning failedも個体を消さず、見た目だけで状態を区別する。
- 新ライン提案と壊れた組織参照は稼働中Lineへ混ぜず、別枠で表示する。

## 操作

- pan、ホイールzoom、+/-、Fit、ResetをElectronで確認した。
- Agent選択とTask選択のときだけTask委譲線を表示する。通常時は組織線だけにした。
- Agent、Team、Lineをそれぞれdragでき、TeamとLineは配下をまとめて移動する。
- 手動配置はアプリ側へ保存し、組織revision後に消えたIDのoffsetは使わない。
- 縮小時の見た目とクリック領域を分離し、overviewでは24px、通常倍率では最大44pxのhit areaにした。

## 性能と画面倍率

- 80体を4ライン、8チームへ配置し、全80 AgentのDOM nodeとlayout位置が一意であることを確認した。
- 100%、125%、150%、200%で主要node、Line見出し、Team見出し、クリック領域が重ならないことを確認した。
- pan、zoom、drag中に500ms以上のmain-thread停止がないことをE2Eで確認した。
- status、heartbeat、Task進捗だけの変更では組織配置を再計算しない。

## 修正履歴

- 80体の全体表示で透明なクリック領域が重なったため、縮小時のhit areaを24pxまで下げた。
- Team見出しよりAgentのhit layerが上にあり、Team dragを邪魔していたため、見出しの操作layerを上へ移した。
- 2ラインをFitしたときLine、Team、Agent名が小さすぎたため、semantic zoomで見出しと文字を補正した。
- 最終要件照合で、複数Roleの区切り、Agent選択時のTask線、LineのLead/Owner表示、消えたmanual offsetの破棄が不足していたため追加した。

## 既知の境界

35体以上をFitすると個々の文字は概要表示になる。全Agentは消えず、zoomすると通常情報へ戻る。稼働中接続線の常時animationは、今回のツリー構造とは分けて後のpolishで扱う。

# 一時検査エージェント User Review

確認日: 2026-07-21

1. Team Managementに青と赤のカードが常時見える。
2. 外部比較は任意の注目点を入れて起動できる。
3. 敵対監査はProject、Line、Team、複数Agentを選べる。
4. 起動中だけ統括者の左または右に発光nodeが出る。
5. 中止するとnodeが消え、履歴にcancelledが残る。
6. 完了するとnodeが消え、記録の検査タブからMarkdownレポートを読める。
7. 外部比較にURLと確認日時がある。
8. 敵対監査の指摘に証拠、重大度、改善コストがある。
9. Team ManagementとMap以外の通常Agent数が増えていない。
10. 通常チャット送信が従来どおり動く。
