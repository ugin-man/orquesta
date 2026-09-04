# P2完了判定とP3着手前整理

作成日: 2026-08-31

> この文書は2026-08-31時点の中間判定である。後続のinstalled利用者確認と最終readbackを含む閉鎖判定は、[P2 障害・対処パターン総括](./p2-incident-remediation-retrospective-2026-09-01.md)を正本とする。

> 2026-09-05追記：この文書のP3順序とB03の旧役割構成は、[P3再構成計画案](./p3-human-review-plan-2026-09-05.md)で見直している。新しい案は一回ごとにユーザーが実物を確認してから進む方式で、まだ実装は始めていない。以下は当時の記録として残す。

## 結論

P2は未完了である。状態正本の分離、Foundationの再開条件、旧形式との混在停止、実際の変更と`no_write`の対応は修正したが、その後の累積監査で実行結果の扱い、進捗保存、配布されたlauncher、会話読み込みの接続依存に問題が見つかった。これらの修正と限定した独立再監査を終え、2026-08-31夜のNative検査は225成功、失敗0、未実施3となった。配布用ビルドとinstalled実利用、P2全体の最終判定は別に残る。「コード上の問題は残っていない」という以前の判定は取り下げたままとする。

一方、Orquestaを実際に使ったときの重要な動線には未接続が残っている。内部機能が存在することと、通常のDesktop操作からその機能が動くことを分けて扱う必要がある。P3の最初の主題は、新機能の追加ではなく、この未接続を一つずつ本番経路へつなぐことである。

## P2で閉じた問題

- `tasks.json`は既存の調整用台帳として残し、Placement専用正本を`placement-tasks.json`へ分離した。
- `sessions.json`はCodexのthread投影として残し、SessionBinding正本を`session-bindings.json`へ分離した。
- 専用正本がreadyなら、旧共有pathの内容を正本判定に使わない。
- 認識可能な旧共有pathから移す場合もcopy-onlyとし、旧ファイルをrenameまたは削除しない。
- Foundationが最初のsession requestを記録した後は、Session正本が消えても空の正本を作り直さない。repairとして停止する。
- legacy Foundation markerとprepared Organization transitionが同居した場合、inspectとrecoverの両方で停止する。
- ready preflightの後にSessionまたはPlacement正本が消えても、`require_existing`は再生成しない。
- Foundationの回復やstore-owned staging cleanupも、実際に変更した場合は`no_write: false`として返す。

同型の条件テストを増やし続けるのではなく、service admission、store policy、kernel failpointの三層で不変条件を確認した。

## 以前のソースに対する検証結果

以下は追加修正前の検証記録であり、現在のソースがすべて同じ検査を通ったことを意味しない。最新修正に対する結果は次の節に分け、最終ビルドとinstalled実利用の証拠は取り直す。

- local-core typecheck: pass
- Foundation / Organizationの対象検査: 37 tests pass
- local-coreの主要6ファイル: 98 pass、1 skip
- Orquesta skill同期: 4配布先に差分なし
- root `npm run check`: pass
- Desktop Rust native contract: 222 pass、2 ignored
- 10万件履歴とagent別cursor/index試験: pass
- 検査後のOrquesta-V5由来Node、Cargo、rustc、makensis、Desktop残留process: 0

`npm run check`には通常のworkspace、Desktop、native contract、product boundary、状態の原子性、task controller、skill同期、encoding検査が含まれる。OneDrive live canaryとinstalled Desktopの人間確認は別ゲートであり、この結果へ混ぜていない。

## 追加修正に対する直近の検証

- Desktopの対象検査: 195成功。型検査も成功。
- Native contract: integration 3成功、Rust 225成功、失敗0、未実施3。再コンパイルは15分45秒、Rustの検査実行は7.48秒だった。
- 未実施3件は通常検査から分けた履歴の負荷試験と、固定した音声資産を使う2件であり、実音声を今回通したとは扱わない。
- 製品境界の全体検査: 成功。配布launcherだけで必要となる二つの固定module参照を限定して許可し、他の動的参照は引き続き拒否する。
- 配布スキル: 4配布先を同期し、差分0を確認した。
- 進捗の再投影、固定保存先へのリンク差込み、実行結果不明の保全、二重起動、配布launcher、接続変更時の承認表示は、それぞれ限定した独立再監査を実施した。

これらは今回の変更に対する証拠であり、全P2要件の受入やinstalledアプリの動作確認ではない。過去の実機証拠と今回のソースを同じ候補として扱わない。

## 過去に作成したDesktop候補

- Frontend build ID: `e5f7306c-5b21-4a24-8acd-75943203ffdf`
- Build input digest: `37ff941e95bb4faf22ccde1367bc6f408462fa0f53c06379fbf0f16281af912a`
- Desktop exe SHA-256: `a89dc19052d6fe784955861bdd1459e69de2bcf6a4c92bb1bd7ae88e17d14b7e`
- MSI SHA-256: `800e5eba7c98b7552b1cdc4bfe353e63bcf28ba2700ec5b74c3a9d29fa3c1c65`
- NSIS SHA-256: `b9525d910fd53f1b39c83b4be27cd85117180c3049bf6b827110096f46bd1952`

この候補のattestationとrelease setは作成時点のソースに対する履歴であり、現在のソースとは一致しない。2026-08-31夜の確認ではcurrent-release pointerとmaterialized releaseは存在せず、この候補を現在起動できる成果物として案内してはいけない。インストール済みアプリは以前の419ed625系で、今回の追加修正はまだ含まれない。

## 実運用で見つかった未接続

### 通常会話から担当追加

WORKの通常会話はApp Serverへの送信までつながっている。永続担当を作る`placePersistentAgent`とDesktop operationも存在する。しかし、会話からその公開処理を呼ぶCore requestとruntime methodが存在しない。

そのため、統括者が文章で「担当を追加した」と返しても、Organization、PlacementTask、SessionBinding、MAPが変化する保証はない。現在の最大の問題は配置ロジックの弱さではなく、会話判断を正規のPlacementIntentへ渡すconnectorがないことである。

### compactionからsession rotation

`compaction_count`の観測とSessionBinding rotationの状態機械は存在する。ただし、観測値からrotationを起動するproduction driverがない。

### WorkflowからFormation

現在のWorkflowは、保存した定義からread-onlyの一時threadを繰り返す機能として動く。Organization Formation、member、lead、MAP上のwork cellへつなぐ呼び出しはない。

### 複数ユーザー

schema、RepositoryReader、MAPは複数participantを表示できる。認証identity、current user切替、ユーザー別SessionBindingを扱うruntimeは未実装である。

## 最初に必要な実運用ベンチ

最初から大きなベンチ基盤を作らず、通常会話から担当追加できるかだけを判定する。

1. public Native経路でstarter projectを作る。
2. activateとFoundation bootstrapを行う。
3. 初期3 agentと1 humanを確認する。
4. 通常の`runtime.send`で、作業拡大により専門担当が必要になる内容を伝える。
5. repository eventを待つ。
6. active agent、実行可能なPlacementTask、accepted SessionBinding、Organization関係、MAP投影が同じagentを指すか確認する。

agent名やIDは固定しない。`placePersistentAgent`の直接呼び出し、手書きfixture、AIの返答文だけによる成功判定は禁止する。現行ソースではこのベンチは失敗するはずであり、その失敗が未接続の正しい検出になる。

## 外部資産の扱い

外部アプリを丸ごと混ぜず、既存の正本、回復、process containmentを残したまま境界ごとに使う。

- assistant-ui: 既に導入済みのExternal Store方式を維持する。別のchat storeや履歴DBは作らない。
- ACP: 現行Codexと互換する隔離canaryを先に作る。本番採用はCodex、ACP SDK、adapter、同梱binary、runtime manifestを一つの変更として扱う。experimental v2は使わない。
- xterm.js: terminal表示だけに使う。process supervisorは既存のWindows Job Objectを残す。
- MCP: Node sidecarのstdio clientから始める。renderer、HTTP、OAuth、runtime時の`npx`取得は初期範囲に入れない。

参考:

- [assistant-ui External Store](https://www.assistant-ui.com/docs/api-reference/external-store/runtime)
- [Agent Client Protocol v1](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v1/overview.mdx)
- [ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk)
- [codex-acp](https://github.com/agentclientprotocol/codex-acp)
- [xterm.js](https://github.com/xtermjs/xterm.js)
- [MCP TypeScript SDK packages](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/get-started/packages.md)

OpenHands、Cline、Roo Code、Continue、Goose、Aider、OpenCodeなどのアプリ全体は統合しない。既存のstate、recovery、process管理を二重化し、P0/P1で解消した増築型の問題を戻すためである。

## P3の順序

1. 通常会話からPlacementIntentへ渡すproduction connectorを作る。
2. 上記の小さなtruth detectorを通す。
3. 同じconnectorを使って、規模拡大、line/team、失敗後の再配置へ広げる。
4. compaction telemetryとSessionBinding rotationをつなぐ。
5. Workflow runとFormationをつなぐ。
6. 複数ユーザーruntimeは認証とcurrent-user authorityを決めてから扱う。
7. 外部資産はcomponent catalog、shadow比較、rollback期間を通して段階採用する。

## B03 production connectorの確定設計

追加する経路は一つに限定する。

```text
通常のWORK会話
→ 統括者が担当追加の意味だけをDynamic Toolへ渡す
→ 既存user-supportが正式なDesktop operationへ正規化する
→ Coreの型付きrequest
→ 既存ProjectBootstrapPlacementService
→ 既存Placement saga
→ Organization / PlacementTask / SessionBinding
→ repository.snapshot.changed
→ WORK / MAP
```

統括者の文章をCoreがキーワード解析することはしない。統括者にはID、path、hash、schema、保存形式を書かせず、担当追加の意図だけを渡させる。user-supportは既存のoperation workflowに従ってrole、scope、capability、人数を正規化し、不足があれば推測で埋めず統括者へ戻す。Coreは検証済みreceiptだけを受け取り、ID生成、正本選択、永続化、replay判定を担当する。

Dynamic Toolは`orquesta_request_persistent_specialist`の一つだけとし、active owner SessionBindingを持つorchestrator turnでのみ公開する。新しいController、Placement ledger、Organization writer、Session registry、approval UIは作らない。exact replayは既存MessageLedger V2とPlacement sagaの決定的IDを使い、同じagent、task、sessionへ収束させる。

B03実装前に必要な証明は二つだけである。

1. 既存threadを再開した際に、新しいDynamic Toolを追加できること。
2. orchestratorのtool request処理中に、同じApp Server接続でuser-supportの別threadを完了できること。

前者が成立しなければ正式なSessionBinding rotationを使う。後者が成立しなければMessageLedgerへ正規化依頼を残し、次turnで再開する。どちらの場合も専用queueやledgerを追加しない。

production connector自体はstatelessな新規ファイル一つに収める。もう一つの新規資産はproduct-ownedなversioned role catalogだけとする。現在テストがcallerから受け取っているrole catalogとtemplateはproduction権限境界として不適切なので廃止し、operation catalogとbuild attestationへ結合する。

B03 truth detectorは内部serviceを直接呼ばない。通常の`runtime.send`から開始し、user-supportの正規化receipt、PlacementTaskの`dispatch_accepted`、accepted SessionBinding、Organization関係、repository event、MAP node、WORK会話入口が同じagentを指すことを機械判定する。AIの返答文、手書きfixture、固定agent名だけでは成功としない。

## P3 hardeningの確定方針

- `no_write`は互換性のため残し、`authority_changed`と`maintenance_changed`を追加する。常に`no_write === !(authority_changed || maintenance_changed)`とし、UIのsnapshot再読とWORK遷移は`authority_changed`だけで起動する。
- 正常処理中に作って解放した一時lockはmaintenanceへ数えない。呼出し前から残っていたstaging、dead lock、recovery metadataの回収だけをmaintenanceとする。
- `runtime-binding.json`をschema V2へ上げ、`writer_generation: desktop-next-v5`を必須にする。未知fieldの追加では旧V4 parserが捨てるためfenceにならない。
- V2 bindingの確立はProjectWriterLeaseの内側へ移す。旧V4 processが動いている間はcopyを始めず、`legacy_writer_retirement_required`で停止する。他プロジェクトで使われている可能性があるため、V5からV4を自動終了しない。
- legacy移行履歴は`.orquesta/state/legacy-authority-cutover-v1.json`の一正本へ隔離する。継続的な同一性はproject ID、root binding、runtime authority ID、writer generationへ束縛する。`runtime-binding.json`全体のSHAは`verified_at`だけでも変わるため、fence時の監査証拠に限る。
- 通常のSessionBindingStoreとPlacementTaskPortから旧共有pathの判定を外す。旧`tasks.json`と`sessions.json`を読めるのは専用cutover storeだけにする。
- copyはreceipt revision、project/root、source path、source hashを束縛したpermit必須にする。`copied`後に専用正本が消えても旧pathから再コピーせず、repairとして停止する。
- Codex版、runtime hash、license情報の複数定義を、一つのruntime component catalogへ集約する。
- root LICENSE、THIRD_PARTY_NOTICES、SBOMの配布境界を確定する。

hardeningの最小acceptanceは、cleanup-only、authority-only、両方、完全no-opのeffect分類、V4 parserのV2拒否、旧process稼働中の無書込、copy直後crashのreceipt回復、`copied`後の再輸入拒否、source drift時のfail-closedに絞る。過去の同型テストをさらに複製しない。

## まだ完了と呼ばないもの

- P2-002、P2-006、P2-008、P2-010、P2-011、P2-012に残るliveまたは人間確認
- installed Desktopでの操作証拠
- 通常会話から担当が増えること
- compaction後の自動session交代
- Workflowの組織化
- 複数ユーザー運用

これらはテストがgreenという理由だけで完了扱いにしない。
