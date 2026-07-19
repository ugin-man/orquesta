# Orquesta Desktop UX Recovery D1 検証記録

検証日: 2026-07-19

D1では、既存の円形HomeとElectron基盤を残したまま、表示状態の意味、プロジェクト切り替え、常設ドック、要対応の概要、Toast、Map操作、読み込み画面を直した。ここに書くPASSは機械検証の結果であり、ユーザーの使いやすさの承認ではない。

## 実装した内容

- 左上にプロジェクト名と切り替え操作をまとめた。
- 上中央の状態表示を、Demo、状態ファイル読取済み、監視中、オフライン、読取エラーに分けた。緑は監視中だけに使う。
- 左下にHome、要対応、Tasks、Failures、会話、Moreの常設ドックを置いた。
- 要対応は質問、承認、確認、作業の件数をまとめ、優先度順の上位5件を表示する。
- taskに結び付かない要対応でも、アプリ内の詳細を開けるようにした。
- Toastは同じ通知を5秒間重複させず、画面には新しい3件まで表示する。
- Mapのアイコンをズーム倍率と一緒に縮小し、pointer capture、listener、requestAnimationFrameを操作後に解放する。
- 会話画面は選択中の相手を見出しに表示し、相手を変えたときに会話も読み直す。
- 読み込み中、プロジェクト未選択、snapshot読取失敗を別画面にした。
- Moreに表示言語とrepository診断を置いた。

## 自動検証

| コマンド | 結果 |
| --- | --- |
| `npm test` | 36 files、177 tests、0 fail |
| `npm run build:desktop` | TypeScript、Renderer、Electron hostすべてexit 0 |
| `npm run test:desktop-smoke` | 6 tests、0 fail |
| `npm run test:interaction-retention` | 2 tests、0 fail |
| `npm run test:visual` | 7 tests、0 fail |
| `npm run make:win` | Windows x64 package、Setup、zip生成、exit 0 |
| `npm run verify:packaged-runtime` | integrity verified、4 files verified |

Electron smokeでは、デスクトップAPI境界、Mapの4表示倍率、実repositoryの監視、初回起動、Codex App Serverとの送受信、実行中の応答性を確認した。

Mapは35 agentsを100%、125%、150%、200%で確認した。全倍率でagent同士の重なりは0、500ms以上のlong taskは0、アイコンの丸枠からのはみ出しは0だった。

保持試験では100回のMap操作と、6 batchの繰り返し操作を実行した。1分後のDOM増加は0、live DOM増加は0、event listener増加は0だった。詳しい数値は[desktop-interaction-retention.md](desktop-interaction-retention.md)と[desktop-interaction-retention.json](desktop-interaction-retention.json)に残した。

## Visual確認

次の画面を実画像で確認してからbaselineを更新した。

- [Home 1440 x 900](../../artifacts/screenshots/renderer-active-1440x900.png)
- [Home 1366 x 768](../../artifacts/screenshots/renderer-active-1366x768.png)
- [Operations 1440 x 900](../../artifacts/screenshots/operations-1440x900.png)
- [Operations 1366 x 768](../../artifacts/screenshots/operations-1366x768.png)

Homeでは円形Mapが中央の主役になっており、画面全体のスクロールは発生していない。左上のlauncher、左下のdock、中央下のComposerは重なっていない。ToastはComposerと同じ下端に置き、右側の要対応と重ならない。

## 配布物

- 実行ファイル: `out/Orquesta-win32-x64/Orquesta.exe`
- インストーラー: `out/make/squirrel.windows/x64/OrquestaSetup.exe`
- zip: `out/make/zip/win32/x64/Orquesta-win32-x64-0.1.0.zip`

package内のCodex実行ファイルは`resources/codex-runtime/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe`から解決でき、integrity検証を通った。

最終差分は独立reviewを2回行った。最初の指摘を直した後、非同期会話の競合も遅延responseのtestで再現して修正した。最後のreview結果はCritical 0、Important 0だった。

## ユーザー確認が必要な項目

- [ ] 初回起動、読込中、読込失敗で白画面にならない。
- [ ] Homeで円形Map、Now、要対応、Composerが同時に見える。
- [ ] 左上からプロジェクト切り替えとフォルダー選択を見つけられる。
- [ ] 左下のドックから各画面へ一回で移動できる。
- [ ] 要対応とTasksの件数が実際の内容と一致する。
- [ ] 会話相手を変えると見出しと履歴が同じ相手へ変わる。
- [ ] 最小ズームでもアイコンが丸枠から飛び出さない。
- [ ] pan、zoom、連打の後にCPU負荷が残り続けない。
- [ ] Toastが要対応やComposerを隠さない。
- [ ] Moreの言語切り替えが再起動後も保持される。

## D1ではまだ行わないこと

- 100件以上のTasksを対象にしたpaginationと検索はD2以降で行う。D1は現在snapshotの一覧を部分スクロールで表示する。
- 過去のfailureを分類、集約する専用ledgerはD3以降で行う。D1のFailuresは現在未解決のerrorとrepairだけを表示する。
- Home以外の各workspaceを最終デザインに仕上げる作業は、D1のユーザー承認後に進める。

D1はこの実機確認で止める。ユーザーが合格するまではD2へ進まない。
