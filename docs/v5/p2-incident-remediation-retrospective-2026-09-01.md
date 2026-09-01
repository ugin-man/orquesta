# P2 障害・対処パターン総括

作成日: 2026-09-01

## 結論

P2は、試作品として使うための最低限の動線を満たしたため、ここで閉じる。

最新版のinstalledアプリで、利用者本人が通常チャット、音声入力、送信前の添付解除、ファイル添付送信を確認した。最後の広い確認でも「特に大きな問題はなかった」という終了判定が出ている。最終readbackも、孤児process 0、監視port 0、添付のlive record 0、音声operation 0だった。

一方、開発工程は良くなかった。実物を早く渡さず、テスト、監査、build、再監査を完成の代理にした。内部でgreenになった後に実機で覆った完成判断は11回あり、最終監査と修正の反復は57時間を超えた。P2の問題は、個々のバグ数だけでなく、何をもって動いたと判断するかを間違えたことにある。

## 数え方

数字は次の四層に分けた。同じ原因の再報告、別担当からの同じ指摘、同じ修正に対する複数テストは一件へまとめた。

| 層 | 件数 | 意味 |
| --- | ---: | --- |
| ユーザー可視の独立不具合・誤判定 | 24 | 利用者の画面や実操作で確認できたもの |
| 製品内部・正本・実行経路の独立障害クラスタ | 33 | source、Native、runtime、package照合で確認したもの。上の24件と一部重なる |
| テスト・監査道具だけの失敗 | 14 | 製品障害へ加算しない |
| 工程・統括・監査上の独立イベント | 36 | 開発方法、root、false green、停止条件など。製品障害へ加算しない |

この四つは母集団が違うため、足して「合計107バグ」とはしない。特に内部33件のうち8件は利用者症状まで到達しており、ユーザー可視24件と重複する。

また、親ログのP2期間には実行tool outputが15,800件あり、wrapperが明示的に`Script failed`を返した試行は203回だった。内訳は、patch context不一致105、policy・approval rejection 68、構文・module系9、path・file系10、process・session系4、その他7である。これは失敗した実行回数であり、製品バグ数ではない。

## 監査範囲と限界

確認に使った主な母集団は次のとおり。

- 統括者の親ログ1本
- P2 lineage inventoryに記録された143ログ
- そのうちnamed product-agent session 111件
- 公開実行証拠を選択確認したログ27件
- 限定した末尾を確認したログ3件
- 過去の選択証拠5件
- P2期間の実ユーザー発言109件。このうち障害や不一致を示すもの48件
- 最終UAT、release、installed、Native readbackの正本

143ログすべての本文を一行ずつ意味解析したわけではない。既存inventory自身も`fully_reviewed_logs: 0`としている。このレポートの件数は、正本、利用者報告、選択済み実行証拠から独立事象として確定できた保守的な下限である。「親子ログを完全に全文監査した全バグ総数」とは言わない。

## ユーザー可視の24件

### 分類

| 分類 | 件数 | 最終状態 |
| --- | ---: | --- |
| プロジェクト選択・作成・MAP | 5 | 5件解消 |
| UI・表示・ナビゲーション・文言 | 5 | 4件解消、Browser Previewは用途分離で緩和 |
| 音声入力 | 5 | 5件解消。速度は要求水準内として保留 |
| 起動・実行・通常チャット | 5 | 3件解消、1件再UAT不足、1件は原因未確定 |
| インストーラー | 1 | 解消 |
| 添付 | 3 | 3件解消 |
| 合計 | 24 | 解消21、緩和1、再UAT不足1、原因未確定1 |

### 個別内容

| ID | 分類 | 起きたこと | 対処・状態 |
| --- | --- | --- | --- |
| U01 | Project | 未選択時に空のWORKへ入れず、プロジェクト選択を強制した | 空WORKへ変更。解消 |
| U02 | Project | V2をunknown/V3混在と誤判定し、選択後に巻き戻った | 選択判定を修正。V2からV3の移行機能そのものは後続 |
| U03 | Project | 「新しいプロジェクト」が実質的なstubだった | 名前、保存先、Starter作成を接続。解消 |
| U04 | Project | 作成成功後も作成modalが残った | 成功時の状態遷移を修正。解消 |
| U05 | MAP | 正常なStarterにstructure warningを誤表示した | hierarchy判定を修正。解消 |
| U06 | UI | Composerとtext boxの配置が崩れた | layoutを修正。解消 |
| U07 | UI | Browser PreviewとNative Desktopで見た目と機能が違った | Previewを実機証明に使わず、用途を分離。完全同一化ではなく緩和 |
| U08 | UI | project選択が重複し、label、並び順も不自然だった | 一つの導線へ整理。解消 |
| U09 | UI | 古いlogoを使い、最初の差替えも指定画像と違った | `oru.png`へ統一。解消 |
| U10 | UI | 永続台帳、配信状態、実行権限、復旧など内部用語を画面へ出した | 主画面から外し、短い通知へ変更。解消 |
| U11 | Voice | Browserのmicrophoneが録音せず固定文を成功として返した | Browserでは無効化し、Native専用と明示 |
| U12 | Voice | Desktopの再試行が効かず、正規model CDNも拒否した | CDN許可と導線を修正。解消 |
| U13 | Voice | backend完了後も「文字起こし中」のまま止まった | 永続状態との再同期を修正。解消 |
| U14 | Voice | 3.8秒から6.4秒の音声に32秒から34秒かかった | 約6.2秒まで短縮。利用者確認済み |
| U15 | Voice | transcript用の第二入力欄と挿入確認が必要だった | Composer一つへ統合。再発後に再修正 |
| U16 | Startup | 空の旧添付folderを復活対象と誤認し、通常profile起動を拒否した | guard条件を修正。解消 |
| U17 | Startup | 一時profileではdev server不在でlocalhost接続拒否になった | 正規起動経路へ変更。解消 |
| U18 | Chat | 正常完了した送信にも「送信を復旧」と表示した | 正常待機と異常復旧を分離。解消 |
| U19 | Runtime | 選択projectではなく親のOrquestaを探索し、`CURRENT_ORCHESTRA.md`不足を出した | root境界修正の証拠はあるが、単独の再UATは不足 |
| U20 | Performance | 単純な一行chatでもPowerShellを複数回実行し、重くなった | 原因と恒久対処は未確定 |
| U21 | Install | NSIS成功表示後も標準場所へ入らず、仮想化先と孤立shortcutだけ残った | MSIX仮想化を特定し、Explorer経由のcurrent-user導入へ変更 |
| U22 | Attachment | 添付入口が画像専用だった | 一般fileへ拡張。解消 |
| U23 | Attachment | 実file送信が「ファイルを処理できませんでした」になった | `utf8`と`utf-8`の契約、応答処理を修正。実機合格 |
| U24 | Attachment | 送信前のXでも同じerrorになり、chipを外せなかった | owner、null応答、UI stateを修正。実機合格 |

## 実装済み判断が実機で覆った11回

| 回 | その時点の完成判断 | 実機で判明したこと |
| ---: | --- | --- |
| 1 | projectを開ける | V2誤判定で選択状態が巻き戻った |
| 2 | UI再構築、238 test、build成功 | Browser音声は録音せず固定文を返した |
| 3 | Browser/Desktopの音声導線を整えた | Desktopには古い上部boxが残り、再試行も無反応だった |
| 4 | 240 testとbuild成功 | 実音声では「文字起こし中」のまま止まった |
| 5 | 第二入力欄を除去しNative確認済み | 翌日の実機で二入力欄が再出現した |
| 6 | bundle attestationとNSIS完了 | 標準install先には入らず、仮想化先に入っていた |
| 7 | 新規project作成を実装 | 作成後もmodalが閉じなかった |
| 8 | Starter生成とMAP表示を実装 | 正常projectにstructure warningが出た |
| 9 | 作成直後をready表示 | agentは親repositoryを探索し、不足fileを出した |
| 10 | 添付実装、test、canary成功 | 利用者の実file送信は失敗した |
| 11 | 添付修正版を導入 | 送信前のX解除がまだ失敗した |

11回は同じ不具合の再報告回数ではない。別々の完成判断が、後の実機確認で否定された回数である。

## 製品内部の33件

### 分類

| 分類 | 件数 | 主な問題 |
| --- | ---: | --- |
| 状態・保存・台帳・権限 | 10 | migration、正本混在、Foundation再生成、projection、progress、Registry、archive、lock |
| runtime・process・provider | 7 | Windows Job、stack overflow、receipt routing、未bound thread、ack loss、Stop/Steer、connection再読 |
| build・release・install | 6 | wrong root、stale skill、dev URL、旧installed、MSIX仮想化、build ownership |
| 添付 | 5 | encoding、preflight cleanup、owner混在、startup cleanup、Renderer stale state |
| 音声 | 5 | ack、transcript競合、asset role、CDN、legacy scaffold |
| 合計 | 33 | 8件は利用者症状まで到達、25件は監査やpackage照合で事前捕捉 |

### 主な根本原因

状態・保存では、PlacementTaskと既存task台帳、SessionBindingと既存session投影を同じものとして扱ったこと、Foundation stateが消えた時に空の正本を再生成したこと、legacy markerとprepared stateを併存させたこと、実際に書いたのに`no_write`を返したことが中心だった。progress packetの同cycle上書きもあり、以前の失敗投影が復旧不能になった。

runtimeでは、`runtime_outcome_unknown`の後の`idle + turns=[]`を安全な終了と誤認し、早期archiveできた。accepted sendのack loss、StopとSteerの重複状態遷移、connection変更後の古いreadが新状態を上書きする問題もあった。

buildでは、主要実装を旧Orquesta rootへ入れたこと、実際の配布skillが旧controllerのままでも通常testがgreenだったこと、Browser Preview、source、package、installedの世代を混ぜたことがfalse greenを作った。

添付では、表面上の一つの失敗の下に、encoding、preflight、draft owner、dispatch owner、startup cleanup、Renderer cacheの境界不整合があった。音声では、ack loss、draft競合、assetのready判定、CDN、旧Voice routeが重なった。

## テスト・監査道具だけの14件

これは製品障害へ加算しない。

1. VitestのEPERMと子processへの起動条件未継承
2. test内の`events is not defined`
3. Cargo lockまたはaccess denied
4. 古いprojection revisionまたはmigration fixture
5. approval、DTO、history limitの古い期待値
6. standalone Vitestのjsdom解決失敗で0件実行
7. 並列full runの9 failureを、原因未証明のままserial 280 passで覆った
8. Foundation testが失敗時のasync bootstrapを回収しなかった
9. 古いhookが共有配列から次testの資源を取った
10. fakeRuntimeの`attachmentToolState`欠落が13件の型errorに見えた
11. 401-agent camera testが無関係な5秒timeoutで落ちた
12. accepted-dispatch UI testがclick/enabled assertionを外して7/7になった
13. obsolete layout、string-only architecture test、stale generated fixture
14. read-only auditでcorepack/pnpmを動かし、`node_modules`の22依存を`.ignored`へ移した

直したtestと、良くなった製品は同じではない。P2後半ではここを同じ優先度で扱ったことが遅延の一因になった。

## 工程・統括・監査上の36件

| 分類 | 件数 | 内容 |
| --- | ---: | --- |
| root・authority・旧版混入 | 8 | 旧root実装、state-root未拘束、stale配布、旧資料、root誤読、旧build残骸 |
| false green・実機不一致 | 7 | canary、archive、UI test、fixture、並列実行、build世代、添付実機 |
| test runner・fixture運用 | 8 | EPERM、未定義値、Cargo lock、古い期待値、jsdom、引数、cwd |
| 進捗・lock・archive・終了判定 | 6 | packet消失、late turn、lock、cleanup競合、blocker bypass、P2状態混在 |
| 監査・委任・承認・実機操作 | 7 | error狩り、局所修正、read-only変異、誤install、過剰承認、Computer Use、監査範囲不足 |
| 合計 | 36 | 重複除外した最低確認数 |

### 工程の量

| 指標 | 数値 | 読み方 |
| --- | ---: | --- |
| named product-agent session | 111 | 独立bug数ではない |
| audit、review、adversarial、counterexample系session | 53 | 監査投入量 |
| implementation、correction系session | 16 | 名前から確認できた実装投入量 |
| 8月29日以降の`spawn_agent` | 70回 | 委任回数 |
| `wait_agent` | 424回 | 待機・再確認回数 |
| goalをblockedへ更新 | 14回 | 一部は正当だが、同じ許可境界の再確認を含む |
| Computer Use用Node REPL | 199回 | うち明示操作91回以上 |
| build receipt | 9世代 | source、package、installedのずれで増えた |
| 最終監査と修正反復 | 57時間超 | 停止条件がなかった |
| 最終使用量 | 49,183,549 tokens | P2最終工程の記録値 |
| 経過 | 約2日18時間22分 | 同上 |
| 利用者による最後の添付確認 | 2操作、約3分 | 最終的に一番直接的な証明だった |

## 対処パターン

### 製品内部33件の一次対処

一件につき、主となった対処を一つ割り当てた。

| 対処 | 件数 |
| --- | ---: |
| 状態遷移・ownershipの根本修正 | 9 |
| 削除・統合・正本一本化 | 8 |
| 局所条件・validation追加 | 6 |
| root・build・install経路の置換 | 5 |
| evidence・readback強化 | 4 |
| 証明付きの限定compat処理 | 1 |
| 単純retryだけを正式対処にしたもの | 0 |
| 合計 | 33 |

診断目的のrerunは3回確認したが、根本対処としては数えていない。一般的なcompat layerを新設した例も0で、旧routeは削除または隔離した。

### ユーザー可視24件の一次対処

| 対処 | 件数 |
| --- | ---: |
| UI導線・表示・文言の単純化 | 8 |
| 状態・ownership・root境界の修正 | 5 |
| Browser PreviewとNative実動作の分離 | 2 |
| 配布・設定・起動経路の修正 | 4 |
| API・文字コード・応答契約の修正 | 3 |
| 性能の局所最適化 | 1 |
| 原因未確定 | 1 |
| 合計 | 24 |

### 工程で繰り返した補助対処

こちらは同じイベントに複数回使っているため重複集計である。

| 対処 | 回数・規模 | 評価 |
| --- | ---: | --- |
| root・authority訂正、旧root復元、配布同期 | 8件 | 必要。今後は書込前に機械確認する |
| test期待値、fixture、runner、cwd訂正 | 最低11件 | 製品改善とは別集計にする |
| realpath、archive、active-zero、ownership guard | 8系統 | 根本寄りだが、第二authorityを作らない |
| 重複authority、dead route、test-only claim削除 | 最低7領域 | 最も良かった対処 |
| build、attest、candidate更新 | 9世代 | 試作品としては過剰 |
| audit、review再投入 | 53 session | error件数ではなく工程過剰の指標 |
| goal blocked化 | 14回 | 同じ意味の再承認が多かった |
| Computer Use | 199呼出、明示操作91回以上 | 単純UI確認には過剰 |
| 利用者の直接確認 | 添付2操作、約3分 | 製品価値を直接証明した |

## 主要な失敗ループ

### 旧rootと配布先のループ

慣れたfile名から対象を推定し、旧rootへ実装した。焦点testがgreenになっても、配布skillやinstalledアプリは旧版だった。その後に復元、同期、再buildが必要になった。

対策は、書込前に`canonical_state_root`と全write pathのrealpathを機械確認し、release gateに実配布先の同期確認を入れることである。

### テストを代理指標にしたループ

過去の失敗をfixture化し、testを直し、greenを完成扱いにした。実機では別の境界が壊れ、さらにfixtureを足した。Lucaだけを通したfixtureでWORKを見なかった例、添付の内部testとbuild後に実送信とX解除が失敗した例がある。

対策は、test failure、runner failure、product failure、installed failureを別の状態として扱うこと。数分で利用者が確認できるUIは、内部監査より先にinstalled候補へ出す。

### 最終監査のループ

敵対的監査は本来、重複authority、局所patch、多重防御を止めるためのものだった。途中から未知error探索へ変わり、修正、build、Critical 0、Important 0、別監査、新修正を繰り返した。

明示的なEscapeや停止指示を無視した確定例は0件だった。問題は停止命令の無視ではなく、監査自身に停止条件がなかったことである。停止条件欠落と、利用者中心へのreframe遅延を、それぞれ1件の工程障害として扱う。

### 承認とComputer Useのループ

同じ意味の許可を定型文で繰り返し求め、操作面が変わるたびに再承認した。Computer Useも単純なUI確認へ使いすぎた。利用者が数秒から数分で確認できることを、遅い自動操作で代替した。

対策は、承認を文言ではなく操作の意味単位で扱うこと。Computer Useは利用者が再現できない診断へ限定し、簡単な見た目や操作は利用者確認を優先する。

## 肥大化の結果

Desktop主要範囲は90file、約59,981行だった。外置きDesktop testは約9,295行、Rust source内のtest blockは約8,745行で、合計約18,040行ある。

特に大きいものは、`projection_service.rs` 9,395行、`commands.rs` 5,240行、`voice.rs` 3,863行、`application-store.test.ts` 3,691行、`attachments.rs` 3,496行、`store.ts` 3,107行だった。正本を一本化した代わりに、一つのfileへ責務が集中した。

利用者向けmessage IDは47種類、主要Storeからの呼出は53か所あった。内部状態を正確に説明しようとして、利用者には意味の分からないrecovery文言を増やした。

この数値だけで全面改修はしない。P2を閉じるための追加refactorは、同じ失敗を繰り返すだけになる。次に各領域へ機能変更が入る時に、責務単位で分ける。

## P3以降へ残す停止条件

- 利用者が数分で確認できるUIは、内部監査より先にinstalled候補へ載せる。
- 同じ問題で修正が二回外れたら、三つ目のguardを足す前に問題定義を見直す。
- 敵対的監査は重複authority、局所patch、多重防御を探す。未知errorの全探索はしない。
- source、package、installed、Browser Previewの証拠を混ぜない。
- 新しいrecovery state、ledger、validatorを追加する前に、既存authorityへ吸収できない理由を示す。
- user review後に変わりやすいUIを、正式製品相当まで先回りしてhardeningしない。
- prototype usable、formal accepted、blocked、runtime unknown、test failedを同じ状態へ入れない。
- P2終了のための追加test、追加監査、追加refactorは始めない。

## 閉鎖根拠

2026-08-31の中間レポートと、2026-09-01早朝の振り返りには「正式受入は未完了」とある。その後、利用者本人がinstalledアプリで通常chat、voice、添付解除、添付送信を確認し、最終的に終了判定を出した。後続の`p2-012-final-closure-20260901.json`は、Critical 0、Important 0、追加guard 0、利用者受入後の製品変更0、最終readback全項目0としてP2をacceptedにしている。

したがって、証拠の時間順では後続の閉鎖記録が優先される。P2の判定は「Orquesta全機能が完成」ではなく、「日常利用の試作品として、chat、voice、attachmentの最低経路が実機で通ったため終了」である。

通常会話からの自動agent増員、compaction後の自動session rotation、WorkflowからFormation、複数user runtimeは、P2で完成したとは扱わず、後続の機能開発へ残す。

## 主な証跡

- `D:\Orquesta-Archive-Staging\2026-09-01-pre-v5-cleanup\local-pre-v5-Orquesta-root\workbench\inbox\V5-DESKTOP-PLATFORM-P2-012-067\p2-log-review-inventory-20260901.json`
- `D:\Orquesta-Archive-Staging\2026-09-01-pre-v5-cleanup\local-pre-v5-Orquesta-root\workbench\inbox\V5-DESKTOP-PLATFORM-P2-012-067\p2-final-adversarial-retrospective-20260901.md`
- `D:\Orquesta-Archive-Staging\2026-09-01-pre-v5-cleanup\local-pre-v5-Orquesta-root\workbench\inbox\V5-DESKTOP-PLATFORM-P2-012-067\p2-012-final-closure-20260901.json`
- `D:\Orquesta-Archive-Staging\2026-09-01-pre-v5-cleanup\p2-audit-user-messages.jsonl`
- `D:\Orquesta-Archive-Staging\2026-09-01-pre-v5-cleanup\p2-audit-tool-failure-candidates.jsonl`
- `D:\Orquesta-Archive-Staging\2026-09-01-pre-v5-cleanup\codex-session-move-manifest.csv`
- `docs/v5/p2-closure-and-p3-readiness-2026-08-31.md`

## 最終状態

P2: closed / accepted for daily-use prototype.

このレポートをP2の最終総括とし、P2のための追加実装、追加test、追加監査は行わない。
