# Desktop product polish

2026-07-18の仕上げでは、見た目だけ存在する操作を製品画面から外し、実際に接続できた操作だけを残した。

- 日本語Windowsでは日本語を初回選択し、手動選択も保持する
- プロジェクトごとのComposer下書きを保持する
- 実repositoryではcanonical stateを書き換えるResolve操作を表示しない
- Add Agentという誤解を招く表示をTeam Managementへ変更する
- Advanced Operationsの仮説明を、現在のCodex、repository、desktop境界の説明へ置き換える
- 透明なframeless splashを最短420 ms表示し、本体の準備後に切り替える
- Windows画像選択をCodex App Serverの`localImage`入力まで接続する

検証時点ではVitest 22 files / 82 tests、browser interaction 12 tests、Electron integration 5 testsが通過した。Mapのvisual baselineは意図したTeam ManagementとComposer変更を目視確認した後に更新した。展開済みの配布EXEでも、ComposerからCodex互換processへ送り、会話履歴を開くところまで通した。実モデルへの有料turnは自動検証に含めていない。

配布版の最終60秒アイドル実測は、起動1225 ms、4 process、working set 334.00 MiB、footprint 305.14 MiBだった。Coreを初回メッセージ、履歴、診断pingまで遅延起動し、待機中の約50 MiBのCore processをなくした。計測値は実行ごとに変動するため、削減量をworking setの単一差分だけでは断定しない。

`npm audit --omit=dev`は0 vulnerabilities。通常の`npm audit`はElectron Forgeの開発用`tar`と`tmp`に未修正版のadvisoryを報告するが、配布ASARには`node_modules`、Forge、tarを含めていないことを別に確認した。

また、make scriptがSetupとZIPだけを更新し、展開済みpackageを古いまま残す問題を修正した。現在は同じForge出力から`out/Orquesta-win32-x64`と`out/make`を両方入れ替える。

EXEとSetupには、splashと同じ白黒の4ノードアイコンを埋め込んだ。生成元PNGを目視し、両EXEから抽出したアイコンのSHA-256が一致することも確認した。
