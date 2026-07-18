# Orquesta Desktop Map Stabilization Implementation Plan

## Goal

中央Mapを固定リング配置から、実際の委任関係を表す折り畳みなしの組織図へ変える。ユーザー、統括者、専門家、実装係、さらにその下のsub-agentまで全員を常にMapへ残し、1体でも80体でもpan、zoom、fit、選択が破綻しない状態にする。

## Fixed decisions

- agentを件数やstatusで非表示にしない。
- 待機中agentも動作中agentも同じ組織図へ出す。
- grouping、clusterへの折り畳み、`+N`表示は使わない。
- `assignedByAgentId`を親子関係の第一候補にする。
- userは最上位、orchestratorはその下を基本形にする。
- statusやtask evidenceは配置を変えない。更新でnodeが飛ばないことを優先する。
- Home全体はscrollさせず、Map viewportの中だけをpan、zoomする。
- 低zoomでも全nodeの存在とstatusを残す。詳細文字はsemantic zoomで段階表示する。
- agent nodeの文字とiconはscreen-spaceで描き、world全体の拡大縮小によるぼやけを避ける。

## Task 1: hierarchy projectionを作る

**Files**

- Create: `apps/orquesta-desktop/src/renderer/features/map/hierarchy.ts`
- Create: `apps/orquesta-desktop/tests/unit/map-hierarchy.test.ts`

`buildAgentHierarchy(agents)`はagent順序に依存せず、次を返す。

```ts
interface AgentHierarchy {
  rootIds: string[];
  parentByAgentId: Map<string, string | 'user'>;
  childrenByParentId: Map<string | 'user', string[]>;
  depthByAgentId: Map<string, number>;
  diagnostics: Array<{ agentId: string; kind: 'missing_parent' | 'cycle' | 'self_parent' }>;
}
```

親が存在しないagent、自己参照、cycleがあってもnodeを落とさない。壊れた関係だけをuserまたはorchestrator直下へ戻し、diagnosticを残す。兄弟順はroleやstatusではなく、入力の安定順とidで決める。

**Acceptance**

- nested delegationを正しいdepthへ置く。
- missing parent、self parent、cycleでも全agentが一度だけ現れる。
- statusだけ変えたsnapshotでhierarchyが変わらない。

## Task 2: collision-free layered layoutへ置き換える

**Files**

- Modify: `apps/orquesta-desktop/src/renderer/features/map/layout.ts`
- Modify: `apps/orquesta-desktop/tests/unit/layout.test.ts`
- Modify: `apps/orquesta-desktop/tests/unit/map-layout.test.ts`

subtreeの必要幅を下から計算し、userをdepth 0、orchestratorをdepth 1として上から下へ配置する。兄弟が多い場合はworld幅を広げ、深い場合はworld高さを伸ばす。nodeを重ねてworldを固定サイズへ押し込まない。

layoutはnode centerだけでなく、parent edgeとworld boundsを返す。node幅、縦間隔、兄弟間隔は定数へまとめる。

**Acceptance**

- 1、3、10、35、80 agentで座標が一意になる。
- wide treeとdeep treeのnode rectangleが衝突しない。
- 同じ組織でstatusとtaskだけ変えても座標が変わらない。
- 全nodeがworld bounds内に入る。

## Task 3: Map viewportをscreen-space node renderingへ変える

**Files**

- Modify: `apps/orquesta-desktop/src/renderer/features/map/MapViewport.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/styles/global.css`
- Modify: `apps/orquesta-desktop/tests/unit/map-viewport.test.tsx`

edge geometryはcamera transformを受けるSVG layerへ描く。agent nodeとtask chipは`screenX = camera.x + worldX * zoom`で配置し、文字やicon自体へworld scaleを掛けない。

semantic zoomは次の三段階にする。

- overview: icon、status、短いdisplay name
- normal: role summaryとstatus labelを追加
- detail: task chipと補助情報を追加

overviewでもnodeを消さない。選択nodeとその接続先は常にnormal以上の情報を出す。

pointer moveは`requestAnimationFrame`単位へまとめる。pan中にagent全体の意味データを再計算しない。fitはworld boundsから決め、projectが同じならsnapshot更新でcameraを維持する。

**Acceptance**

- zoom後も文字とiconが読みやすい。
- wheel anchor zoom、drag pan、fit、resetが維持される。
- 同一project更新でcameraが変わらない。
- selected agent、task、active evidenceの強調が維持される。

## Task 4: representative fixturesとbrowser testを増やす

**Files**

- Create: `apps/orquesta-desktop/src/fixtures/nested-roster.ts`
- Create: `apps/orquesta-desktop/src/fixtures/wide-roster.ts`
- Modify: `apps/orquesta-desktop/src/fixtures/index.ts`
- Modify: `apps/orquesta-desktop/tests/browser/interaction.spec.ts`
- Modify: `apps/orquesta-desktop/tests/unit/fixtures.test.ts`

fixturesは少なくとも次を含む。

- orchestrator直下に複数の同職実装係
- specialistの下に3体のsub-agent
- depth 5の委任
- 35体の混合tree
- 80体のwide tree
- missing parentとcycleを含む壊れたsnapshot

**Acceptance**

- 全fixtureでagent countとDOM node countが一致する。
- browser上のnode rectangleが重ならない。
- Home document自体にscrollが発生しない。
- Map controls、Composer、Now、Attentionがagent nodeを操作不能にしない。

## Task 5: Electron visual and performance validation

**Files**

- Create: `apps/orquesta-desktop/tests/electron/map-stability.spec.ts`
- Modify: `apps/orquesta-desktop/playwright.electron.config.ts`
- Create: `apps/orquesta-desktop/docs/validation/map-stabilization.md`

package済みElectronまたはproduction Electronで35体fixtureを開き、fit、連続zoom、pan、agent選択を行う。操作中のlong taskを計測し、500ms以上の停止を失敗にする。

100%、125%、150%、200% DPI相当と1366x768、1440x900で主要状態を確認する。visual baselineはMap Stabilization専用に作り、旧browser prototype画像をそのまま合格証拠にしない。

**Completion boundary**

Map Stabilizationでは実repositoryを読まない。fixtureで任意組織を正しく描けるところまでを完成させる。次のRead-only Integrationで`.orquesta/state/agents.json`とtask stateをこのprojectionへ接続する。
