# Orquesta Desktop Next current architecture

更新日: 2026-08-30

この文書は、Desktop Nextの現行source mapと状態権威を説明するliving documentです。日々のtask進捗やテスト件数はここへ複製しません。判断の優先順位は、作業中のcanonical task record、実コードと機械可読manifest、この文書、歴史資料の順です。

## 実装root

| 責務 | 現行source |
| --- | --- |
| React Renderer | `apps/orquesta-desktop-next/src/` |
| Tauri native host | `apps/orquesta-desktop-next/src-tauri/` |
| packaged Node sidecar | `apps/orquesta-desktop-next/runtime-node/` |
| shared Local Core | `packages/local-core/src/` |
| Codex App Server adapter | `packages/codex-adapter/` |
| Renderer↔Tauri contract | `packages/contracts/desktop/` |

`apps/orquesta-desktop-next/docs/v5-handoff/`は2026-08-10のhistorical snapshotです。そこにあるhost path、IPC、method policy、validation statusを現行仕様として使いません。

## 実行経路

通常の会話は次の一経路を通ります。

```text
Renderer action
  -> DesktopClient
  -> Tauri command boundary
  -> packaged Node sidecar
  -> Local Core
  -> Codex App Server adapter
  -> DomainEventEnvelope
  -> Rust projection ingestion
  -> SQLite projection
  -> Renderer ApplicationStore
```

Rendererはnative commandを迂回してLocal CoreやProviderを直接呼びません。Node sidecarはDesktop AppDataの継続writerにならず、Rustがprojectionのdurable writeを所有します。

## 単一の権威

| 対象 | 権威 |
| --- | --- |
| commandとevent名、request/response body mode | `packages/contracts/desktop/native-bridge-manifest.v1.json` |
| bridge fixture | `packages/contracts/desktop/fixtures/native-bridge-fixtures.v1.json` |
| runtime method classとrecovery strategy | `packages/contracts/desktop/runtime-method-policy.v1.json` |
| Rust/TypeScript生成物 | `packages/contracts/generated/desktop/` |
| 会話とterminal stateのdurable projection | `apps/orquesta-desktop-next/src-tauri/src/projection_service.rs` |
| project登録とSQLite初期化のPending/Ready状態 | `apps/orquesta-desktop-next/src-tauri/src/registry.rs`の同一`RegistryDocument` |
| 利用者dispatchとattachment transactionの復旧調停 | `apps/orquesta-desktop-next/src-tauri/src/dispatch_recovery.rs` |
| Provider配送結果とexact-once settlementの証拠 | `packages/local-core/src/core/message-ledger-v2.ts` |
| Desktop private paths | `apps/orquesta-desktop-next/src-tauri/src/paths.rs` |
| UI mutable state | `apps/orquesta-desktop-next/src/application/store.ts` |
| Renderer sessionのcurrent、pending、predecessor、retired state | `apps/orquesta-desktop-next/src-tauri/src/commands.rs`のNative `RendererSessionRegistry` |
| attachment stagingとcleanup | `apps/orquesta-desktop-next/src-tauri/src/attachments.rs` |
| shared Native process containment | `apps/orquesta-desktop-next/src-tauri/src/process_containment.rs` |
| immutable Desktop binary/model catalog | `docs/dependencies/desktop-assets.json` |

Renderer stateとeventはprojectionであり、durable authorityではありません。manifestとfixtureをTypeScript、Rust、Nodeへ別々に手書きして第二契約を作りません。

ProjectRegistryはproject recordと、そのprojectのSQLite初期化状態を同じdocumentで原子的に永続化します。旧schemaのprojectは`Ready`へ移行し、新規登録とStarter commitだけを`Pending`として記録します。SQLite初期化が成功した後にだけ`Ready`へ遷移し、process loss後も`Pending`だけを再開します。`Ready`のdatabase欠損、破損、空database、別project identity、複数identityは再初期化せずfail closedです。この状態は別journalや第二storeではありません。

Rendererが起動時に作るsession UUIDは、一回のopen attemptとそのtransport retryを束ねるcaller operation keyにすぎません。Renderer memoryだけに保持し、`localStorage`や`sessionStorage`へcurrent、pending、predecessorを保存しません。再起動後のpending recovery、compare、retired判定はNative `RendererSessionRegistry`だけが返し、Rendererはそのstructured detailsを一度だけ同じopen attemptへ反映します。

`SidecarSupervisor`はruntime protocolとruntime lifecycle、`VoiceService`はvoice lifecycleを所有します。両者が共有するのは、起動前から収容を保証するprocess spawnと終了確認のprimitiveだけです。

Windowsでは共有primitiveが先にnamed Jobを作り、同じDesktop executableのprivate launcherを起動してJobへ収容した後にだけ、固定長gateを解放します。launcherはgate前にtargetを起動せず、親がJob割当前に停止した場合はstdin EOFで終了します。Job割当後に停止した場合は`KILL_ON_JOB_CLOSE`がlauncherと子孫を終了します。RuntimeとVoiceはこの順序を個別実装しません。Unixでは同じprimitiveが`setsid`をexec前に適用します。

`RuntimeStatus.pid`とruntime owner documentの`pid`はdirect containment-root PIDです。Windowsではlauncher PIDであり、内側のNode runtime PIDではありません。復旧判断はPID単独ではなく、正確なgenerationから導出したnamed Jobとactive process countを権威にします。

## Approval

Provider approvalは`runtime.approval.respond`を通ります。exact requestの回答権はNative SQLite projectionがclaimし、再生済み、旧connection、別turn、unsupported、in-flight、outcome unknownの要求を再回答可能に戻しません。Providerがwriteを開始した後に応答を失った場合はblind retryせず、outcome unknownとして閉じます。

## Attachment

file pickerとdrag-and-dropは、同じRenderer adapterから一つのNative staging pathへ入ります。Rendererが申告したpath、type、size、hashは権威にしません。

```text
HTML File[] + selectionId
  -> one-file-at-a-time raw Native request
  -> signature / size / digest verification
  -> Local AppData sealed snapshot
  -> exact-owner bounded preview
  -> ordinary runtime_send
  -> ledgerまたはprocess-tree終了の証拠
  -> idempotent cleanup
```

sealed bytesとselection/quarantine stateは`attachments-v2`の一権威に置きます。remove、cancel、failed dispatch、app exitのcleanupを別storeへ複製しません。Windows owner-only DACLは独立した実機証明がない限り完了扱いにしません。

## Voice

P2-007は資産と責務境界を確定したSpikeです。P2-008Bで、既存bridge manifestとfixtureへ資産status、明示取得、取消、削除を追加し、同じgeneratorからRust handler、Rust event定数、TypeScript定数を生成しました。P2-008Cでは、同じwire authorityへPCM stage、文字起こし、取消、acknowledgementを追加し、Renderer captureから既存Composerまでを接続しました。Voice専用のsemantic portやwire manifestは置かず、既存bridge manifestから生成されたhandlerが`VoiceService`へ渡し、`VoiceService`がTauri内のWhisper Transcriberを呼び出します。

責務は次の三つに分けます。

- RendererのVoice Composer Controllerが明示的なMicrophone開始、録音表示、AudioWorkletによる16 kHz mono PCM-S16LE変換、60秒上限、現在のComposer bindingと送信意図を所有する。録音開始前の自動取得は行わず、文字起こし成功時は同じproject・agent・renderer epoch・draft revisionへだけ通常Composer draftとして直接反映する。Stopでは送信せず、通常のSendが明示されている場合だけ既存送信経路を一度通す。
- Tauri Voice Serviceが明示的な資産取得、partial resume、Hash・License・ZIP allowlist検証、導入receipt、取消、削除lease、再起動時の資産回収に加え、PCM検証、16 kHz mono WAV化、AppData一時File、Timeout、文字起こし回収、acknowledgementを所有する。
- Tauri内のWhisper Transcriberが固定済みwhisper.cpp processの`probe`、`transcribe`、`cancel`だけを担当する。

資産catalogはsource、size、SHA256、license、静的な抽出allowlistだけを保持し、Native hostがcompile timeに直接読みます。Download進捗、導入済みModel、partial transfer、delete pending、process IDは保持しません。資産の可変状態はLocal AppDataの`projection_data_root/voice-v1`だけに置き、Voice Serviceが一元管理します。Rendererへ返すのはcatalog ID、phase、byte progress、operationRef、error codeだけで、URL、Hash、License、物理pathは返しません。

Raw AudioはProject、Conversation、SQLite projection、Attachment Storeへ保存しません。Native stageの確認前はRenderer memory、確認後はVoice Serviceの専用AppData一時領域だけが所有します。成功、取消、失敗、App終了、再起動回収のどの場合も、whisper process treeの終了確認後に削除します。復元可能な正確なTranscriptは、bindingがまだ有効な場合に限り`ApplicationStore`の既存draft authorityへ一度だけ戻します。第二のTranscript editorやrecovery Composerは作らず、自動送信もしません。

Transcriptの反映は`ApplicationStore`の既存draft authorityだけを使います。capture開始時のproject、agent、renderer epoch、draft revisionが一致する場合だけcompare-and-commitし、一致しない場合は現在の利用者draftを保持して既存のtyped noticeまたはerrorで知らせます。別の編集欄へTranscriptを残しません。Native acknowledgementの応答を失った場合はstatusを読み返し、operationが消えている場合だけdurable successとして扱います。

公開日本語WAVによる自動証明は、固定assetの取得・導入、PCM stage、共有process containment、whisper実行、日本語Transcript、raw root・lease・recovery・process・acknowledgement・shutdown cleanupまでを対象にします。Tauri raw IPC header、WebView AudioWorklet、Microphone permission/device、実際の録音UXはこの証明に含めず、実Desktopでの利用者確認を別gateとして残します。

P2の初期Model候補はmultilingual `small`です。`base`は低資源比較として固定しますが、自動fallbackにはしません。実測は読み上げ音声だけであり、会話音声、雑音、固有名詞、数字の安全性や正式出荷を証明しません。上流Windows資産は未署名でSecurity Policyも公開されていないため、公式immutable ModelとHash一致資産だけを許可し、Rendererから受けた任意Modelや汎用Audio fileを直接実行しません。

## 履歴とUI

会話、activity、attentionはbounded SQLite projectionから読みます。`ApplicationStore`の`AgentExecution`がWORK、Composer、Stop、streaming、checkpoint表示のUI entityです。Provider全履歴の同期rebuildをread pathへ戻したり、同じturnを別mapで二重管理したりしません。

現在のSQLite file全体は、削除して別Journalから作り直すcacheではなく、会話とterminal stateのdurable authorityです。再構築可能なのは同じdatabase内の`conversation_index`などの派生索引だけです。新規`Pending`だけがCREATEとschema初期化を許され、`Ready`はquick checkとexact single project identityを変更前に確認してからmigrationします。Provider page refreshも同じidentity preflightを通り、失敗時はhistory pageを取得せずdatabaseへ書きません。Provider refreshはProviderに残る履歴を追加で補完しますが、SQLiteだけが保持するDomain Event、mutation claim、approval response phaseを復元する災害復旧ではありません。databaseの欠損や破損は自動再構築を装わず、fail-closedの復旧incidentとして停止します。P0-Cで受理したwhole-file rebuildとlegacy shadow comparisonは、ARCH-CONSOLIDATION-053とP2-009によってこの現在契約へ置き換えられました。

UI上の一Conversationは`projectId + targetAgentId`です。Providerの`threadId`、Runtime generation、Renderer generationで分割しません。History一覧は同じProjectionService transactionが更新する`conversation_index`からbounded pageを読み、現在の組織から外れた担当者もprojectionに履歴があれば表示します。会話本文のdurable authorityは引き続き`messages`であり、`conversation_index`は再構築可能な一覧索引です。

History検索は`idx_messages_target_page`の時系列順を使い、1 requestごとに行数と本文byte数の両方で区切るstreaming literal scanです。短い検索、長い検索、日本語を別authorityや別retry経路へ分けません。一致がない区間でも最後に走査したmessageのcursorを返し、利用者が明示的に次の古い区間へ進めます。全履歴一括転送、履歴量比例のtemp sort、Renderer検索は行いません。

Historyの`historySelectedAgentId`、query、現在page、cursor、loading ticketは`ApplicationStore`内の一つのephemeral read stateです。WORKの`selectedAgentId`とComposer draftを変更せず、明示的な「WORKで開く」操作だけが送信先を変えます。Runtime incarnationが変わると旧History read ticketとqueued refreshを無効化し、同じprojectなら選択とqueryだけを保持して新authorityで一度再読込します。projectが変わる場合はHistory read stateを破棄します。

ProjectRegistryが永続化するConversation再開hintは、projectごとの検証済み`lastWorkAgentId`一つだけです。これとは別に、同じRegistryDocumentがproject registrationとSQLite初期化の`Pending/Ready`境界を所有します。App再起動後はRuntimeを停止したままにし、利用者がprojectを明示的に開いた後にだけ、現在も有効な担当者のConversationをSQLiteから再開します。message、thread、generation、cursorはRegistryへ複製しません。

## ビルドと保守の直列化

Desktopの共有生成物を変更または参照する保守操作は、`.build-generations/build.lock`という一つの物理ロックを使います。対象はfrontend/runtime/Tauri package、release attestation、test、native clean、世代退役、source-matched executableのidentity再確認からspawn完了までです。build用、test用、clean用などの別ロックは増やしません。

通常の入口は`npm test`、`npm run test:native-contract`、`npm run clean:native`、`npm run lifecycle:retire-generation -- <build-id>`です。任意の実行ファイルを受け取る汎用exec入口と、ロック保持中の内部scriptは公開しません。P2-011の対話的NSIS installは別の利用者境界であり、silent/update modeをこの保守経路へ混ぜません。Coordinatorが異常終了した場合は、子processが残っている可能性があるためPIDだけで自動回収せず、lockを残してfail closedにします。runtimeの二領域promotionや世代退役でrollbackまで失敗した場合も同じlockを残し、分断状態のまま次操作へ進みません。

世代退役は削除ではありません。現在のrelease setが参照する世代を拒否し、検証済みgenerationとreceiptの組だけを同じlock内で`retired/`へ移します。新しいcandidateはsource input、frontend receipt、executable、installerが一つのrelease setに一致して初めて配布候補になります。機械的attestationは利用者による実機受入やtask acceptanceの代わりではありません。

P2自体の進捗はcoordination task controllerが所有する`.orquesta/state/tasks.json`へ先に一度commitし、`CURRENT_ORCHESTRA.md`とeventはそこから再生できる派生projectionとして更新します。これは専門担当の配置を所有するPlacementTaskPort V3の`.orquesta/state/placement-tasks.json`とは別の正本です。CURRENTを第二の正本にせず、途中失敗は同じcontent-addressed packetで冪等に修復します。CURRENTの表示時刻はCURRENT lock内でcanonical ledgerを読み直し、同じ`event_id`の再生はevent全体が一致する場合だけ冪等とみなします。内容が違う同一IDはcollisionとして停止します。複数境界を同時に扱う場合のlock順はDesktop lifecycle、coordination task controller、CURRENT projectionです。

## 変更ルール

- 新しいcommandやeventはbridge manifestとfixtureを先に変更し、既存generatorから反映する。
- 新しいruntime methodはmethod policyへ追加し、RendererやNodeにprivate allowlistを増やさない。
- 新しいdurable stateは既存ownerへ属せない理由を示すまでstoreを増やさない。
- task固有の受入結果はcanonical task evidenceへ置き、この文書へtest件数や一時statusを複製しない。
- historical handoffへ現行P2仕様を書き戻さない。
