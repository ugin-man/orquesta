# Orquesta Desktop 適応型組織ツリー設計

## 目的

Desktop の中央Mapを、Core が確定した正式な組織状態をそのまま読める組織図へ更新する。小規模な1ライン構成、複数ライン、同じ役割の複数個体、生成中、停止中、引退済み、新ライン承認待ちを、個体を隠さず同じ規則で表示する。

既存の円形viewport、pan、zoom、Fit、Reset、Agent選択、Task選択、手動配置、現在の白黒と温かい紙色のデザインは維持する。変更の中心は、何を組織単位として配置するかと、倍率ごとの情報量である。

## 正式な階層

表示の意味モデルは次の順番にする。

```text
Project
├─ User
├─ Project Core
│  ├─ orchestrator
│  ├─ user-support
│  └─ orquesta-admin
└─ Production Lines
   └─ Line
      └─ Team
         └─ Role cluster
            └─ Agent
```

`Line`、`Team`、`Membership`、`reports_to`は `.orquesta/state/organization.json` を正とする。Desktop はIDや表示名の正規表現から正式組織を推測しない。旧形式だけを持つプロジェクトでは従来推測を互換表示として残し、`legacy_inferred_organization`を表示する。

## Project Core

- Userを円内上部へ置く。
- 統括者を中央軸へ置く。
- 利用者支援係と管理係はproject scopeの支援役として統括者周辺へ置く。
- 生産ラインには含めない。
- 位置と線は正式な`reports_to`を使い、表示側で上下関係を捏造しない。
- Core役が不足していても、残っているAgentは表示する。

## Production Line

- 一つのラインなら中央を広く使う。
- 二つなら左右へ配置する。
- 三つ以上ならMap world内で複数行へ配置する。
- 円へ押し込むためにAgentを省略しない。worldを広げ、Fit倍率を下げる。
- ライン上端へ表示名、状態、owner、専任Leadを表示する。
- ownerが統括者で専任Leadがいない場合、統括者をライン内へ複製しない。
- 同じ`role_id`のAgentが別ラインにいても、別々のライン枠へ置く。

## TeamとRole cluster

- Teamは正式な`team_id`ごとに独立した枠を持つ。
- Team枠は最上段Agentの座標から意味を推測せず、専用headerと接続portを持つ。
- Team内のAgentは`position`、`ordinal`、安定したAgent ID順で配置する。
- Leadは新しい役割名ではなく、個体nodeの印として表示する。
- 同一Team内に同じ役割が複数いればRole clusterとして近くへまとめる。
- Teamが単一役割だけなら、Team名とRole名を二重表示しない。
- 複数役割を含むTeamだけ、役割ごとの小さな区切りを表示する。
- Agentは`+N`へ畳まず全個体を描画する。

## Agent nodeの情報量

### 遠景

- icon
- 短縮名
- status dot
- lifecycleの外形表現

### 通常

- display name
- status dotと短いstatus
- current task ID
- Lead印
- lifecycle表現

### 詳細

- 通常情報
- current task titleを最大2行

長いrole説明、mission、進捗要約、blocked reason、required reading、証拠、履歴は選択時の詳細画面へ置く。Agent名そのものが役割名なら、同じRole名を下へ再表示しない。

見た目のnodeはcamera zoomへ連続的に追従させ、最低視認サイズでclampする。操作用hit areaは見た目と分離し、全体俯瞰では24px、通常倍率では44pxまで連続的に広げる。キーボード選択と詳細表示は倍率に関係なく残す。

## 線

通常状態では組織線だけを表示する。

- UserとProject Core
- 統括者とLine
- LineとTeam
- 正式な`reports_to`

現在Taskの委譲線はAgentまたはTaskを選択した場合だけoverlayする。組織線とTask線を同じ状態で常時混在させない。線はLine、Team、Agentの専用portへ接続し、見出しや説明文を横切らない。

稼働中接続線の常時animationは、このツリー構造が承認された後の別polishとし、最初の実装へ入れない。

## lifecycleと例外

- `provisioning`: 配置予定Team内へ点線nodeとして表示する。
- `active`: 通常nodeとして表示する。
- `retired`: 元所属内へ薄く残す。
- `superseded`: 元所属内へ薄く残し、置換済みを表示する。
- `provisioning_failed`: 同じ個体IDを残し、失敗状態を表示する。
- 新ライン承認待ち: 稼働中組織へ混ぜず、Map外周側の提案枠へ表示する。
- 専任Leadなし: 古参を自動昇格させず、Line ownerを表示する。
- 恒久移籍: 新しいorganization revisionを受け取った後に新Teamへ一度だけ移す。旧所属との二重表示をしない。
- 壊れた参照または循環: 統括者配下へ黙って補正せず、`organization data issue`枠へ残す。

## 手動配置

- Agent nodeのdragは残す。
- Team headerのdragでTeam全体を移動する。
- Line headerのdragでLine全体を移動する。
- 位置はproject localなapp-owned stateへ保存し、canonical organization stateを書き換えない。
- 旧Agent offsetは読み取れるようにし、新しい保存形式へ移行する。
- 組織revisionが変わった場合は、存在するLine、Team、Agentのoffsetだけを再利用し、消えたIDのoffsetを破棄する。

## 性能

- 組織layoutは`project.id`と`organization.revision`が変わった場合だけ再計算する。
- status、task progress、heartbeatだけの更新でlayoutを変更しない。
- panとzoomはworld全体のtransformを更新し、pointer moveごとに全nodeの構造を作り直さない。
- force simulationを常駐させない。
- pointer updateは1 animation frameに1回へcoalesceする。
- 35体と80体で全個体を維持し、500ms以上のmain-thread停止を起こさない。

## Desktop契約

`OrganizationUiSnapshot`へ次を追加する。稼働中LineとTeamは`organization.json`から読み、承認待ちの新Line提案だけは`organization-decisions.json`の`propose_line` decisionから読む。承認待ち提案を`organization.json`へ入れてはならない。

```ts
interface OrganizationLineUiModel {
  id: string;
  displayName: string;
  goal: string | null;
  status: string;
  ownerAgentId: string;
  dedicatedLeadAgentId: string | null;
  displayOrder: number;
  approvalSource: string | null;
}

interface OrganizationTeamUiModel {
  id: string;
  lineId: string | null;
  displayName: string;
  purpose: string | null;
  lifecycleState: string;
  displayOrder: number;
}

interface OrganizationRelationshipUiModel {
  id: string;
  type: string;
  fromAgentId: string;
  toAgentId: string;
}

interface OrganizationLineProposalUiModel {
  id: string;
  lineId: string;
  displayName: string;
  goal: string;
  reason: string;
  status: 'approval_wait';
  ownerAgentId: string | null;
}
```

Agentには`membershipOrdinal`と`displayOrder`を追加する。Membershipの`team_id`、`position`、`ordinal`はAgent projectionへ一度だけ解決する。

## 現行実装から残すもの

- `MapViewport`の円形viewportと操作
- `fitCamera`とFit/Reset操作
- pointer updateのanimation-frame coalescing
- project別manual layoutの保存
- current task選択
-既存のLucide iconとdesign token

## 交換するもの

- `PRODUCTION_GROUP_ORDER`
- 明示組織に対するrole名の正規表現分類
- 旧支援Agentを前提にした固定座標
- `ProductionGroupId`固定のgroup layout
- Agent一体目に依存するgroup枠
- explicit organizationで`assignedByAgentId`を組織親へ使う経路

## 実装段階

1. Desktop契約とRepository projection
2. 正式なLine/Team/Role cluster model
3. 一つまたは二つのLineを配置するadaptive layout
4. Map描画とsemantic zoom
5. lifecycle、新ライン提案、診断表示
6. Line/Team/Agentのmanual layout
7. 35体、80体、複数Lineの性能とvisual QA

最初のユーザー確認は、二つのLineに同じ`implementation` roleが存在し、それぞれ別枠へ表示された段階で行う。

## 受け入れ条件

- 基盤3体がproject scopeとして生産Lineと分かれている。
- 1Line、2Line、3Line以上で全Agentが表示される。
- 同じRoleが複数Lineにいても混ざらない。
- 同じTeam、同じRoleの複数個体が一つの役割定義として読める。
- 役割名の二重表示がない。
- Agent、Team、Lineを個別またはまとめて移動できる。
- statusまたはtaskだけの更新で配置が変わらない。
- retired、superseded、provisioningが消えない。
- 新ライン承認待ちが稼働中組織として表示されない。
- 組織線とTask委譲線の意味が分かれている。
- 35体と80体のfixtureで全IDがDOMに残り、pan、zoom、Fit、Resetが動く。
- 100、125、150、200%のWindows表示倍率で主要nodeとgroup headerが重ならない。
- source mockと同一viewportの実装画像を比較し、`design-qa.md`が`final result: passed`になる。

## 実装結果

- 明示組織契約、Line/Team/Role cluster、安定配置、例外表示、手動配置v2を実装した。
- 承認待ちLineはactive linesへ加えず、提案枠として分離した。
- 同一Teamに複数Roleがある場合だけRole枠を表示し、単一Roleでは二重見出しを出さない。
- Agent選択またはTask選択時だけTask委譲線を重ねる。
- 組織revision後、存在しないLine、Team、Agentの手動offsetを破棄する。
- 35体と80体の全IDについて一意なlayout位置とDOM nodeを確認した。
- Electronで100%、125%、150%、200%を確認し、80体表示のクリック領域重複とTeam headerのhit layer衝突を修正した。
- 承認C案と実装を1440×900で並列比較し、通常表示のLine、Team、Agent文字をsemantic zoomで補正した。
