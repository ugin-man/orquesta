# Codex runtime integration

Orquesta Desktopは、配布物にbundledした一つのCodex App ServerをCoreから使います。Codex Desktopの画面を自動操作せず、general OpenAI APIも直接呼びません。

## Runtime identity

runtimeは次のexact versionです。

- `@openai/codex-sdk@0.144.5`
- `@openai/codex@0.144.5`
- `@openai/codex-win32-x64@0.144.5-win32-x64`

package工程は`resources/codex-runtime/node_modules/@openai`へこの3ディレクトリだけを置きます。metadataと`codex.exe`のsize、SHA-256、platform、architectureをmanifestへ記録し、実行時にもresources外へ逃げていないことを確認します。

PATH、環境変数、WindowsApps、任意実行ファイルの注入にはfallbackしません。Coreは検証済みの`codex.exe app-server`をshellなしで遅延起動します。

## Protocol and thread ownership

App Server接続ごとに`initialize`と`initialized`を一度だけ実行します。Desktopで使う主なmethodは次の通りです。

- `thread/start`
- `thread/resume`
- `thread/read`
- `turn/start`
- runtimeが提示したapproval requestへのresponse

projectごとのcoordinator thread IDはElectronのapp-owned registryへ保存します。保存済みthreadを再開できない場合だけ新しいthreadへ置き換え、その事実をruntime eventとして返します。

専門家宛ての入力も初期版では同じcoordinator threadへOrquesta routing envelopeとして送ります。別threadを作った証拠がない限り、専門家threadへ直接送ったとは表示しません。

## Composer and history

Composerは文章と画像を送れます。PNG、JPEG、GIF、WebPはMainがopaque attachment IDとして管理し、実pathをRendererへ返しません。1回に最大4枚、1枚20 MiBまでです。Coreが送信時にIDを解決し、`turn/start`の`localImage`へ変換します。

送信成功はApp Serverがthreadとturnを受理した後だけ返します。dispatch accepted、turn started、agent message、turn completed、turn failedは別eventです。dispatchだけでagentをactive表示にしません。

conversation historyは`thread/read`から読みます。Orquesta routing wrapperは表示時に外し、秘密情報やtool output全文はRendererへ渡しません。

## Approval boundary

threadはCodexのnormal runtime approval boundaryを使います。Orquestaが自動許可したり、固定した無承認モードへ上書きしたりしません。

App Serverから届いたrequestはrequest ID、thread ID、turn ID、correlation IDへbindし、Attentionへ追加します。ユーザーが選べるのはruntimeが実際に提示したoptionだけです。存在しないID、別turn、stale、二重response、未提示optionは拒否します。終了時にpending requestへ自動responseは送りません。

## Model evidence

requested model、applied model、actual modelを分けます。`thread/start`や`thread/resume`の返却値はapplied modelです。actual modelは独立したruntime観測がある場合だけ記録し、それ以外は`null`とunknownを保ちます。

## Repository-only and draft fallback

runtimeの検証や起動に失敗した場合はrepository-onlyになります。同じSend操作を成功扱いにしません。

ユーザーが選んだ場合だけ、Mainが`codex://threads/new`を使ってCodex Desktopへ下書きを開きます。project pathとrouting envelopeはMain側で組み立て、Rendererから渡された任意URLやpathは使いません。この操作はComposerを開くだけで、自動送信ではありません。

## Shutdown

終了時はrepository watcherとsubscriptionを止め、App Serverのstdinを閉じます。短い猶予後も残るprocessは終了し、最後にCoreを閉じます。project切り替えでも古いwatcherとthread bindingを解除します。

## Verification

決定論テストはruntime path、realpath、version、integrity、JSONL framing、request correlation、approval binding、model evidence、thread、history、shutdownを確認します。

Fake runtimeのElectron testはRenderer、Preload、Main、Coreの結線、遅延turn中の入力応答、project切り替え後の古いwatcher停止を確認します。これは本物のCodex証拠ではありません。

Real packaged runtime testは`out/Orquesta-win32-x64/Orquesta.exe`を一時projectと一時user-dataで起動します。runtime overrideなしでinitialize、thread作成、無害な1 turn、agent message、turn completion、`thread/read`を完了し、終了後に`codex.exe`を含む子processが残らないことを確認しました。詳しい証拠は[packaged-runtime.md](./packaged-runtime.md)と[packaged-runtime.json](./packaged-runtime.json)にあります。

Codex 0.144.5が送る未知のinformational notificationはtransportを閉じず、bounded diagnosticとして扱います。既知notificationはschema検証し、responseが必要な未知server requestはfail closedのままです。
