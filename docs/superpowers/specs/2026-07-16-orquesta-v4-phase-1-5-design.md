# Orquesta V4 Phase 1.5 リスク適応型実行設計

作成日: 2026-07-16

対象: Orquesta V4 Preview / Phase 1.5

状態: ユーザー承認済み

承認根拠: Phase 1の評価工程を薄くし、Phase 2へ進む前に実行方式を改良して、そのまま実装まで完了するようユーザーから明示された。

## 結論

Phase 1.5では、評価をなくさない。タスクの危険性と不確実性に応じて、評価に使うagent、handoff、review、correctionの量を変える。

すべてのタスクは最初に一度だけExecution Planを作る。通常は同じタスクの中で実装、確認、修正を進める。レビューや修正のたびに新しいtask entryを作らない。

実行レーンはfast、standard、criticalの三つとする。

- fastは、可逆、local-only、低不確実性、機械検証可能な仕事に使う。
- standardは、通常の専門実装や複数境界の変更に使う。実装担当と独立レビューを一回ずつ使う。
- criticalは、秘密情報、課金、公開、破壊的変更、データ移行、権限、安全境界、不可逆な変更に使う。

Phase 1で作ったTaskIntent、Capability Graph、Inventory、Audit、Resolver、Context Packは残す。これらは一つの計画パスとしてCore内で処理し、各段階を別agentへ委譲しない。

## 解決する問題

Phase 1の実装では、本体13タスクに対してレビュー、修正、再レビューなどの補助task entryが55件作られた。レビューで実際の欠陥は見つかったが、次の運用コストも生じた。

- 一つの指摘を閉じるたびに新しいtask entry、handoff、reportが増えた。
- 同じ差分を複数のturnが読み直した。
- 製品の問題と、state、report、completion envelopeの問題が混ざった。
- worktree内の古いstateと通常checkout側の正本が並存し、同期確認が増えた。
- 壁時計時間と並列agent全体のtoken消費を正確に分けて測れなかった。
- 完了条件が製品品質よりもwrapper整合へ寄る場面があった。

Phase 1.5は、この運用増幅を止める。

## 採用しなかった案

### 規約だけを変更する

SkillとProtocolにfast、standard、criticalを書く案。

実装は速いが、agentが古い習慣でtaskを増やしても検出できない。Event JournalにもExecution Planが残らないため、採用しない。

### Delegation Gateだけを変更する

既存のdelegation-gate-checkへ軽量ルートだけを追加する案。

現在の運用には効くが、V4 Core、TaskIntent、Event Journal、計測と分離する。将来のPhase 3学習で、なぜそのレーンを選んだかを再利用できないため、採用しない。

### Coreと運用gateを統合する

V4 Coreが決定的なExecution Planを作り、既存のDelegation Gateがtask state上の計画、cycle、budget、evidenceを検査する案。

この案を採用する。判断、強制、証拠、計測を一つの契約へまとめられる。

## 設計原則

### 評価は一度まとめて行う

TaskIntent、Capability Graph、local inventory、Audit、Resolver、Context Packを、一つの計画処理として扱う。別の専門家が必要なのは、Coreが判断できない領域知識または独立性が必要な場合だけとする。

### 修正は同じtaskで行う

review、correction、verificationはexecution_cyclesへ追加する。R、F1、RR1のような補助task IDを作らない。

### 予算超過は新しいtaskを作らず昇格する

fastの途中でriskや失敗が増えたら、同じtaskのExecution Planをstandardへ昇格する。standardの一回のcorrectionで閉じない意味上の問題が残った場合だけcriticalへ昇格する。

### 安全境界を二重実装しない

OS権限、filesystem sandbox、network制御、credential保護、command承認はCodex harnessへ任せる。Orquestaは意味上のrisk、権限境界、証拠binding、review量を決める。

### token不明をゼロにしない

各threadのtoken値を取得できない場合はunknownまたはpartialとして記録する。goal meterや一部threadの値を全体値として扱わない。

### legacyを壊さない

execution_policy_versionがない既存taskは従来のDelegation Gateで検査する。Phase 1.5契約はversion 1を明示した新規taskだけに適用する。

## 全体フロー

~~~mermaid
flowchart TD
    U["User request"] --> TI["TaskIntent"]
    TI --> CG["Capability Graph"]
    CG --> EP["Execution Policy"]
    EP --> L{"Lane"}
    L -->|fast| F["Inline owner + deterministic checks"]
    L -->|standard| S["One owner + one independent review"]
    L -->|critical| C["Owner + independent review + optional QA"]
    F --> G["Acceptance gate"]
    S --> G
    C --> G
    G -->|pass| A["Accepted"]
    G -->|trigger| E["Escalate same task"]
    E --> EP
    A --> M["Execution metrics and outcome"]
~~~

## リスク入力

Execution Policyは自由文を直接採点しない。次の列挙値だけを受け取る。

~~~json
{
  "reversibility": "easy",
  "scope": "single_boundary",
  "verification": "deterministic",
  "uncertainty": "low",
  "effects": ["workspace_write"],
  "repeated_failures": 0,
  "user_review": "default"
}
~~~

reversibility:

- easy
- costly
- irreversible

scope:

- single_boundary
- multiple_boundaries

verification:

- deterministic
- mixed
- human_only

uncertainty:

- low
- medium
- high

effects:

- local_read
- workspace_write
- dependency_change
- network_access
- external_write
- public_release
- credential_access
- payment
- destructive_operation
- data_migration
- security_boundary

user_review:

- default
- strict

## レーン分類

### critical

次のどれかがあればcriticalにする。

- reversibilityがirreversible
- user_reviewがstrict
- external_write
- public_release
- credential_access
- payment
- destructive_operation
- data_migration
- security_boundary

### standard

critical条件がなく、次のどれかがあればstandardにする。

- reversibilityがcostly
- scopeがmultiple_boundaries
- verificationがmixedまたはhuman_only
- uncertaintyがmediumまたはhigh
- dependency_change
- network_access
- repeated_failuresが1以上

### fast

critical条件もstandard条件もなく、次をすべて満たす場合だけfastにする。

- reversibilityがeasy
- scopeがsingle_boundary
- verificationがdeterministic
- uncertaintyがlow
- effectsがlocal_readまたはworkspace_writeだけ
- repeated_failuresが0
- user_reviewがdefault

条件が欠ける場合は安全側のstandardにする。数値risk scoreは表示しない。理由コードを残す。

## レーン予算

| 項目 | fast | standard | critical |
|---|---:|---:|---:|
| owner handoff | 0 | 1 | 1 |
| independent review | 0 | 1 | 最大2 |
| correction batch | 最大1 | 最大1 | 最大2 |
| QA handoff | 0 | 0 | 最大1 |
| handoff合計 | 0 | 最大2 | 最大4 |
| report | 0 | review report最大1 | 最大2 |
| auxiliary task entry | 0 | 0 | 0 |

implementation ownerの完了はtask state内のcompletion_evidenceへ記録する。standardでMarkdown reportを書くのは独立reviewerだけとする。criticalは意味上のriskに応じてreviewまたはQA reportを最大2本まで許す。

report wrapper、task metadata、event整形は機械処理で作る。強い推論turnを使わない。

## Execution Plan

Coreは次のExecution Planを作る。

~~~json
{
  "execution_plan_id": "EP-...",
  "task_intent_id": "TI-...",
  "policy_version": 1,
  "lane": "standard",
  "risk_profile": {
    "reversibility": "easy",
    "scope": "multiple_boundaries",
    "verification": "deterministic",
    "uncertainty": "low",
    "effects": ["workspace_write"],
    "repeated_failures": 0,
    "user_review": "default"
  },
  "reason_codes": ["multiple_boundaries"],
  "routing": {
    "routing_class": "specialist_required",
    "handoff_required": true,
    "specialist_report_required": true
  },
  "budget": {
    "max_handoffs": 2,
    "max_independent_reviews": 1,
    "max_correction_batches": 1,
    "max_reports": 1,
    "max_auxiliary_tasks": 0
  },
  "review_policy": "independent_once",
  "escalation_triggers": [
    "critical_risk_discovered",
    "scope_drift",
    "budget_exhausted",
    "semantic_finding_not_machine_verifiable"
  ]
}
~~~

execution_plan_idは、task_intent_id、risk_profile、lane、routing、budget、review_policy、escalation_triggersのcanonical hashから決定する。

## task state

Phase 1.5 taskは既存fieldに加えて次を持つ。

~~~json
{
  "execution_policy_version": 1,
  "execution_plan": {},
  "canonical_state_root": "C:\\project",
  "execution_cycles": [
    {
      "cycle_id": "implementation-1",
      "kind": "implementation",
      "owner_agent_id": "implementation-001",
      "status": "completed",
      "started_at": "2026-07-16T00:00:00.000Z",
      "completed_at": "2026-07-16T00:10:00.000Z",
      "evidence_refs": ["commit:abc"]
    }
  ],
  "completion_evidence": [
    {
      "kind": "test",
      "ref": "npm run check:v4:phase15",
      "status": "passed"
    }
  ],
  "execution_metrics": {
    "wall_time_ms": 600000,
    "agent_turns": 1,
    "handoffs": 1,
    "independent_reviews": 0,
    "correction_batches": 0,
    "reports": 0,
    "token_usage": {
      "coverage": "unknown",
      "known_total": null,
      "by_thread": []
    }
  }
}
~~~

token_usage.coverage:

- complete: すべての参加threadに実測tokenがある
- partial: 一部threadだけ実測できる
- unknown: 合計を証明できない

known_totalはcoverageがunknownならnullにする。partialの場合は確認できた分だけを入れ、総額とは表示しない。

## cycleの扱い

kindは次に限定する。

- implementation
- review
- correction
- qa

同じtask内でcycle_idを増やす。cycleごとにowner、開始、終了、evidenceを記録する。

standardのreviewでImportantが見つかった場合、実装者はcorrectionを一括で一回行う。修正内容を機械検証できればorchestratorが閉じる。意味上の修正で機械検証できない場合はtaskをcriticalへ昇格し、二回目の独立reviewを許す。

Minorだけなら、受理を妨げない。採用する修正は同じcorrection batchへまとめる。

## 昇格

Execution Planは同じtask_intent_idへ新revisionとして追加する。

- fastからstandard: test failure、scope drift、新しいdependencyまたはnetwork、uncertainty上昇
- standardからcritical: critical effect発見、独立reviewの意味上の未解決、reviewまたはcorrection予算超過
- criticalで予算超過: 自動でtaskを増やさず、user decision requiredにする

自動降格はしない。riskが減った場合でも、そのtaskは現在のlaneを維持する。次の別taskで再分類する。

## Acceptance Gate

### fast

- routing_classがinline_verified
- handoffとreportが0
- completion_evidenceが一件以上ある
- deterministic acceptance checkがすべてpassed
- metricsがある
- budget内である

### standard

- routing_classがspecialist_required
- owner handoffが一回ある
- implementation completion evidenceがある
- 独立review cycleが一回以下
- accepted時は独立review evidenceが一件ある
- correctionは一回以下
- CriticalとImportantが0
- metricsがある
- budget内である

### critical

- routing_classがspecialist_required
- owner handoffがある
- 独立review evidenceがある
- 必要なuser approvalがある
- reviewは二回以下、correctionは二回以下、handoffは四回以下
- CriticalとImportantが0
- metricsがある
- budget内である

## 正本state

task、agent、session、eventの正本は通常checkout側のcanonical_state_rootに一つだけ置く。product worktree内の古い.orquesta stateはroutingやacceptanceの証拠に使わない。

handoff contractはcanonical_state_rootを必須で渡す。Delegation Gateは明示されたstate rootを検査し、暗黙に現在worktreeの古いstateへ切り替えない。

reportはcanonical stateから参照する。product commitとreport/state commitは別の証拠として扱う。

## Core統合

packages/coreへexecution-policy moduleを追加する。

公開interface:

- createExecutionPlan
- assessExecutionBudget
- escalateExecutionPlan
- EXECUTION_LANES
- EXECUTION_BUDGETS

command boundaryへexecution-plan.createを追加する。task.intent.createdとcapability.graph.compiledの後にだけ実行できる。

Event Journalへexecution.plan.createdを記録し、projectionはexecution_plansとcurrent_execution_plan_idを持つ。

既存Phase 1 fixtureはExecution Planがなくても動く。Phase 1.5 taskだけが新commandを使う。

## Delegation Gate統合

orquesta/scripts/delegation-gate-check.jsは二つの経路を持つ。

- legacy: execution_policy_versionがない既存taskを現在の規則で検査する
- phase15: version 1 taskをlane、cycle、budget、evidence、metricsで検査する

phase15 taskのcorrectionやreviewを別task entryとして作った場合はエラーにする。execution_parent_task_idでPhase 1.5 taskを参照する補助taskもエラーにする。

inline_verifiedは例外扱いにしない。direct_exception_reasonも要求しない。

## SkillとProtocol

Delegation Gateの短い規則を次へ変更する。

- 全taskでExecution Policyを一度決める。
- fastはinline_verifiedとして統括または一人のownerが完結できる。
- standardは一人のownerと一回の独立reviewを使う。
- criticalだけが最大二回のreviewと追加QAを使える。
- review、correction、QAは原則として同一taskのcycleである。
- reportとwrapperの作成は機械処理を優先する。
- 予算を超えたら同じtaskを昇格し、新しいtaskを連鎖させない。

direct_exceptionはlegacy互換と本当の緊急例外のために残す。fastの通常ルートには使わない。

## 計測

Phase 1.5は時間短縮だけで評価しない。

必須metric:

- wall_time_ms
- agent_turns
- handoffs
- independent_reviews
- correction_batches
- reports
- token_usage.coverage
- known token subtotal
- review findings
- escaped defects
- user changes requested

評価時は次を一緒に見る。

- timeとtoken
- reviewで防いだImportant以上の欠陥
- user差し戻し
- context drift
- wrapperまたはstateだけが原因のfailure

## テスト

### Core

- 同じrisk profileから同じExecution Planができる
- fast、standard、criticalの境界
- effect順序によらず同じIDになる
- 不明または不完全なrisk profileはstandardへfail closedする
- budget内と超過
- fastからstandard、standardからcriticalの昇格
- 自動降格を拒否する
- execution-plan.createの順序とEvent Journal replay

### Delegation Gate

- legacy taskは従来どおり通る
- valid fast task
- fastでhandoffまたはreviewがある場合は失敗
- valid standard task
- standardでreviewなしのacceptedは失敗
- standardで二回reviewまたは二回correctionは失敗
- valid critical task
- criticalの予算超過は失敗
- metrics欠落はacceptedを失敗
- token unknownを0として扱うtaskは失敗
- child review、fix、re-review taskを失敗
- explicit canonical state rootを使う

### 回帰

- npm run check
- npm run check:v4:phase1
- npm run check:v4:phase15
- UTF-8 validation

## Phase 1.5でやらないこと

- live Web探索
- external package install
- Audition
- Codex App Server dispatch
- Desktop packaging
- dashboard redesign
- Experience Ledger
- Intent Graph
- Phase 2のschemaまたはUI
- 過去187 taskの移行
- 過去reportの書き直し

## 合格条件

- designとimplementation planがcommitされている
- Execution Plan contractとCore implementationがある
- Event Journalへ計画が記録されreplayできる
- fast、standard、criticalのgateが実際に強制される
- reviewとcorrectionを同一task cycleで表現できる
- canonical state rootを明示してworktreeの古いstateを正本にしない
- token coverageをcomplete、partial、unknownで区別できる
- legacy taskが壊れない
- V3とV4 Phase 1の回帰が通る
- Phase 1.5のfocused checkが通る
- 一回の独立reviewでCritical 0、Important 0になる
- Phase 2は開始されていない

