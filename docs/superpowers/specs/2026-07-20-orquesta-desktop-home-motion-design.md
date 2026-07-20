# Orquesta Desktop Home Motion Design

## 目的

Homeのカードやオーバーレイが急に切り替わる感覚をなくし、操作結果を短い動きで理解できるようにする。日常利用で目が疲れる常時演出は増やさない。

## 今回の範囲

- Project Statusの開閉を高さ、透明度、内容表示の順序でつなぐ
- Project Launcherの開閉を同じ規則へ揃える
- 展開状態に応じて開閉アイコンを切り替える
- 共通オーバーレイに開く動作と閉じる動作を入れる
- Homeとオーバーレイのボタンへ短い押下感を入れる
- NowとUser Tasksへ新しく追加された項目を一度だけ淡く表示する
- OSの`prefers-reduced-motion`を尊重する

## 今回は行わないこと

- 稼働中エージェントのアニメーション変更
- 接続線のアニメーション変更
- 待機中要素や背景の常時アニメーション
- Homeのレイアウト、情報構造、色の変更
- セットアップ画面の変更
- クリック負荷試験や長時間メモリ試験の再実施

## Motion tokens

| 用途 | 時間 | easing |
|---|---:|---|
| 押下 | 110ms | ease-out |
| 閉じる | 160ms | ease-in |
| 開く | 220ms | cubic-bezier(.2,.8,.2,1) |
| 内容の遅延 | 50ms | 外枠の開始後 |
| 新項目 | 260ms | ease-out |

閉じる方を開く方より速くし、操作の待ち時間に感じさせない。

## カードの開閉

Project StatusとProject Launcherは開閉内容をDOMに保持し、`grid-template-rows: 0fr`から`1fr`へ移す。閉じた内容は`aria-hidden`、`pointer-events: none`、必要なボタンの`tabIndex=-1`で操作対象から外す。

Project Statusは`Maximize2`と`Minimize2`を重ね、開閉時に透明度と90度未満の回転で切り替える。Project Launcherは既存のChevronを180度回転する。

## オーバーレイ

表示時は最終位置を変えず、`opacity`、個別`translate`、個別`scale`だけを動かす。既存の中央寄せ用`transform`は上書きしない。

閉じる操作は`OverlayFrame`内で160msの終了状態を作り、その後に親の`onClose`を呼ぶ。Escape、背景クリック、閉じるボタンを同じ経路へ統一し、重複操作で複数回閉じない。終了用timerはunmount時に必ず解除する。reduced motion時は待たずに閉じる。

## 押下と新項目

押下感は`transform`ではなく個別`translate`を使い、既存の地図や中央寄せtransformと競合させない。Homeの操作部とオーバーレイ内だけに適用する。

NowとUser Tasksの各項目はReactのkeyで新規mountされたときだけ260msのfadeと2px移動を行う。既存項目の更新やhoverでは再実行しない。

## 完了条件

- Project StatusとProject Launcherが開閉どちらも連続して見える
- Project Statusのアイコンが展開状態を表す
- すべての共通オーバーレイが開閉アニメーションを共有する
- Escape、背景、閉じるボタンで同じ閉じ方になる
- reduced motionでは移動せず即座に状態が切り替わる
- 地図、エージェント、接続線、Home配置に変更がない
- 対象unit testとrenderer buildが通る

