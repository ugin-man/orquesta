# Orquesta Luca Fish Hatch Design

## 目的

Lucaを従来の固定ボタンだけで呼び出す説明係から、Home画面を泳ぐ赤い金魚へ変えられるようにする。魚になった後も、Lucaの読み取り専用の質問機能、Codex thread、回答履歴は変更しない。

この機能は効率化ではなく、Orquestaを毎日開いたときの遊び心を作る機能である。利便性を優先する利用者は卵の状態を使える。

## 確定した仕様

- 孵化はOrquestaアプリ全体で一度だけ行う。projectごとの状態にはしない。
- 孵化状態は全projectで共通にする。
- 孵化前は、Home左上に現在のLucaボタンを表示する。
- HomeのLucaパネルで「自由に聞く」の隣に「Lucaを孵化させる」を表示する。
- タスク、エラー、監査から開いたLucaパネルには孵化ボタンを表示しない。
- 孵化後は左上の固定Lucaボタンを消し、魚そのものをLucaの入口にする。
- 魚はHome画面全体を自由に泳ぐ。Home以外には移動せず、他workspaceでは描画を停止する。
- マップ、ウィジェット、dock、composerなどの操作領域では魚が背後へ潜る。魚が操作を奪わない。
- 魚へpointerを近づけると減速し、hoverまたはkeyboard focusで停止する。clickまたはEnterでLucaパネルを開く。
- 設定の表示セクションに「Lucaを卵に戻す」を追加する。魚状態のときだけ表示し、会話履歴は削除しない。
- 見た目は赤いローポリゴンの3D金魚とし、ヒレは半透明にする。
- 2D比較画面は方向性の確認にのみ使い、実際の3DモデルはDesktop上でユーザーが最終確認する。

## 対象外

- Lucaの人格、prompt、読み取り専用制約、回答形式の変更
- projectごとの育成状態、餌、成長、複数個体
- Home以外のworkspaceでの常駐表示
- Codex pet用8x11 spritesheetへの変換
- 外部から3Dモデルをdownloadする仕組み

## 状態モデル

永続状態は`egg`と`fish`の二つだけにする。`hatching`はrenderer内の一時状態で、保存しない。

```ts
export type LucaPetMode = 'egg' | 'fish';
export type LucaPetVisualState = LucaPetMode | 'hatching';
```

localStorage keyは`orquesta.desktop.luca-pet.v1`とする。保存値が壊れている場合は`egg`へ戻す。孵化animationが最後まで完了した時点で初めて`fish`を保存する。途中でアプリが終了した場合、次回起動時は`egg`になる。

設定で卵へ戻した場合は、保存値を`egg`へ変更するだけで、Luca thread、回答履歴、project状態には触れない。

## 3D方式

Three.js `0.185.1`を直接使う。React Three Fiberは追加しない。魚1体のために別のrendering frameworkを増やさないためである。

透明なWebGL canvasをHome全体に1枚だけ配置する。モデルは外部GLBではなく、Three.jsのgeometryを組み合わせてコード内で生成する。

- 胴体: 低分割の楕円体。赤から深紅の面を混ぜ、面構造が読めるflat shadingにする。
- 尾: 左右に開く扇形。胴体より薄く、opacityは`0.58`を基準にする。
- 背びれ、胸びれ、腹びれ: 薄い三角面。opacityは`0.46`から`0.62`の範囲にする。
- 目: 暗い球と小さいアイボリーのhighlight。画面上で大きく見えすぎない。
- 全体: 通常表示時のbody長は約`58px`から`78px`。奥行きで`0.86`から`1.08`倍まで変化する。
- geometry総量は`400 triangles`以下を目標にする。

光源はambient lightとdirectional lightを1個ずつに限定する。床、影、水槽、背景画像は作らない。Homeの紙色をcanvas越しに残す。

## 表示階層と潜水表現

魚用layerをpaper grainより上、mapと操作UIより下に置く。

```text
z-index 0  paper/background
z-index 1  Luca fish canvas + fish hit target
z-index 2  Orquesta map viewport
z-index 20 floating instruments
z-index 35-45 project controls, status, dock
z-index 80+ modal/overlay
```

魚がmapやwidgetの領域へ入ると、上のDOM要素によって自然に隠れる。個別のwidget形状を毎frame計算してmaskしない。これにより既存のclick領域を変えず、魚が操作を横取りしない。

魚のclick用DOM buttonはcanvasと同じlayerに置き、projected positionへ追従させる。最低hit areaは`44x44px`とする。mapやwidgetが上にある間は、そのDOMがclickを受け取るため魚はclickできない。空いた背景へ出たときだけ魚を捕まえられる。

## 通常時の泳ぎ

魚はviewport内のランダムな目的地へ、滑らかな曲線で移動する。

- 外周から`48px`以上内側を基本領域にする。
- 1本の経路は`4.5`秒から`8`秒で移動する。
- 方向変更はquaternion補間で滑らかにし、瞬間的な左右反転をしない。
- 速度はおおよそ`35px/s`から`55px/s`にする。
- 奥行き値で大きさと明るさを少し変えるが、急なsize popは起こさない。
- 尾と胸びれは泳ぐ速度に応じて小さく往復させる。
- pointerが`90px`以内に入ると速度を落とし、hoverまたはfocusで停止する。
- panelが開いている間は、魚をpanelの近くで静止させる。panelを閉じたら再開する。
- window resize時は現在位置を新しいsafe bounds内へ収め、次の経路だけを作り直す。

Homeを離れた場合、`requestAnimationFrame`とWebGL描画を停止する。documentがhiddenの場合も停止する。Homeへ戻ったときに再開する。

## 孵化animation

孵化は約`3.2秒`で終わる。長い動画は使わない。

1. `0-250ms`: 孵化buttonをlockし、Luca panelを閉じる。
2. `250-650ms`: 左上の丸い「？」が少し縮み、白い卵へ変化する。
3. `650-1250ms`: 卵が下へ落ちる。後半から加速を弱め、水中へ入ったような抵抗へ切り替える。
4. `1250-1750ms`: 小さい波紋を一度だけ表示し、卵がゆっくり沈んでHome中央より少し下で止まる。
5. `1750-2350ms`: 卵が左右へ三回揺れ、細いひびが入る。
6. `2350-2850ms`: 殻が二つに開き、赤い3D金魚が現れる。
7. `2850-3200ms`: Lucaが小さく一周し、通常遊泳へ入る。この時点で`fish`を保存する。

演出中もElectronやCodex処理は止めない。Home内の孵化buttonと魚layerだけを操作不能にする。project監視や通知は継続する。

## Luca panel

既存の`LucaPanel`へ任意の`onHatch`と`petMode`を渡す。`context.kind === 'home'`かつ`petMode === 'egg'`のときだけ孵化buttonを表示する。

「自由に聞く」と「Lucaを孵化させる」はHome panelの最初の横並びaction rowに置く。狭いheightでも潰れないよう、二つとも同じ高さにする。

孵化後に魚を押したときは、現在と同じ`openLuca({ kind: 'home' })`を呼ぶ。質問送信、pending、回答、error表示は変更しない。

## 設定

設定の「表示」にLucaの項目を追加する。

日本語:

- 見出し: `Lucaの姿`
- 説明: `Homeに表示するLucaを卵の状態へ戻します。会話履歴は残ります。`
- button: `Lucaを卵に戻す`

英語:

- Heading: `Luca's form`
- Detail: `Return Luca to the egg state on Home. Conversation history is kept.`
- Button: `Return Luca to the egg`

この設定行は`fish`のときだけ追加し、`egg`のときは表示しない。resetは破壊的操作ではなく、再孵化できるため確認dialogを出さない。

## reduced motionとfallback

OSのreduced motionが有効な場合、落下、揺れ、自由遊泳を行わない。卵を`250ms`でfade outし、魚を固定位置へfade inする。魚はclickでき、Luca panelは通常どおり使える。

WebGL初期化に失敗した場合は、赤い魚の軽量DOM fallback buttonを左上のLuca位置へ表示する。Luca機能を使えなくしてはならない。console errorだけで終わらせず、renderer stateを`fallback`へ切り替える。

## 性能制限

- Three.jsはHomeで魚または孵化を表示するときだけdynamic importする。
- rendererは1個、sceneは1個、fish modelは1体だけにする。
- device pixel ratioは`Math.min(window.devicePixelRatio, 1.5)`へ制限する。
- animationは最大`30fps`にする。
- Home外、document hidden、reduced motionの静止中は連続描画しない。
- component unmount時にgeometry、material、renderer、ResizeObserver、event listenerをdisposeする。

## 検証

同じ検証を何度も繰り返さない。

- unit: 保存値、状態遷移、経路境界、Luca panelの孵化button、設定reset
- component: Homeだけにfish layerが出ること、魚clickがLucaを開くこと
- Electron: 孵化から魚表示、project切替後も魚状態、設定reset後に卵へ戻ることを1本の試験で確認する
- user review: 実際のDesktopで3Dモデル、ヒレの透過、大きさ、孵化速度、泳ぎの邪魔さを確認する

既存のmap stabilityや長時間pointer負荷試験は、この機能で回帰が実際に出ない限り繰り返さない。

## 受入条件

- 魚は本物の3D geometryとして描画され、方向転換時に立体として回転する。
- 魚はHome内だけを泳ぎ、操作領域の背後へ入る。
- 魚がmap、widget、dock、composerのclickを奪わない。
- hover、focus、click、Enterで魚を捕まえてLucaを開ける。
- projectを切り替えても魚状態が維持される。
- 設定から卵へ戻してもLuca会話履歴が残る。
- 日本語と英語の表示が揃う。
- reduced motionとWebGL fallbackでLucaが利用不能にならない。
- Desktop上でユーザーが3Dモデルを確認できる。
