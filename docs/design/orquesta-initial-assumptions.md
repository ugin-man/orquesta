# Orquesta Initial Assumptions

作成日: 2026-06-21

このファイルは Orquesta skill の初期設計仮説。まだ確定仕様ではない。

## 目的

Orquesta は、Codex 上で長期の複数セッション運用を行うための統括 skill とする。中心ユースケースはゲーム制作。統括者は必要に応じて通常 Codex セッションを立ち上げ、専門エージェントとして任命し、各エージェントの状態・成果物・ブロッカーを追跡し、全タスク完了後にユーザーへ報告する。

重要なのは「AI を増やすこと」ではなく、「私たちが同じ状況認識を持ち続けること」。

## 設計思想

Orquesta の基本思想は、必要になった瞬間だけ短期 worker を生成することではない。実際の会社や制作チームのように、同じ専門家と1年、2年と一緒に働き、各メンバーが自分の専門領域、判断履歴、成果物、禁止事項を持ち続けることを目指す。

このため、Orquesta の agent は disposable な subagent ではなく、長期的な専門スレッドとして扱う。統括者は全分野の詳細を読み込む万能作業者ではなく、必要最低限の運用文脈だけを持ち、専門判断は該当する agent session に委任する。

ユーザーは統括者ではない。ユーザーは発案者であり、最終的な意図、好み、違和感、優先順位を持つ上位の制作主体である。統括者はユーザーの意図を整理して進行を助けるが、ユーザーの細かいニュアンスを必ず統括者経由で要約して専門担当へ渡す構造にはしない。

Orquesta の重要な利点は、ユーザーが必要に応じて専門担当と直接会話できることにある。たとえば UI が薄く見える、アートワークに積みを足したい、世界観の温度を少し変えたい、という細かい反復は、統括者に毎回翻訳させるより、その領域の文脈を深く持つ担当 agent と直接進めたほうがよい。

ただし、直接会話で進んだ内容は統括者から見えなくなってはいけない。専門担当は一定の節目で、何を決め、何を変更し、何が未確認で、統括判断が必要かを Orquesta state と report に同期する。

ゲーム制作では守るべき文脈が膨大になる。たとえば:
- コーディング担当は、実装規約、禁止パターン、検証方法を読む。
- ビジュアル担当は、アート規律、比率、画風、生成手順、承認済み素材を読む。
- 世界観・ストーリー担当は、世界設定、語り口、キャラクター、ユーザーの物語意図を読む。
- 統括者は、全体の運用、依存関係、承認ゲート、成果物状態だけを読む。

Orquesta はこの文脈分離を維持するための仕組みにする。全 agent が全ドキュメントを読む構造にはしない。

## なぜ subagent を基本単位にしないか

Codex の subagent は便利であり、短期の探索、テスト、ログ解析、要約、並列調査には有効である。OpenAI 側で調整された仕組みなので、必要に応じてうまくタスクを割り振り、完了後に停止する用途には向く。

ただし Orquesta の基本単位にはしない。理由:
- subagent には同時起動数や運用上の上限がある可能性があり、長期制作チームの基盤にしづらい。
- 画像生成系など一部の skill には、subagent では実行しないことを要求するものがある。skill 互換性のため、最初から通常スレッドで運用できる設計にする必要がある。
- subagent はタスク発生時に生成される短期 worker になりやすく、長期的な専門性や継続した認識を育てる設計とずれる。
- ゲーム制作では、専門領域ごとに読むべき文脈を限定したい。通常スレッドなら、各担当スレッドに必要な文脈だけを持たせやすい。
- 統括者と専門担当の関係を、短期委託ではなく継続した制作チームとして扱いたい。

したがって、Orquesta では通常スレッドを long-lived agent session として扱い、subagent は必要なときだけ使う補助手段に留める。

## 非目標

- subagent を基本単位にした並列実行フレームワークにはしない。
- 完全自律で無制限にセッションを増やす仕組みにはしない。
- 会話ログを主な状態管理にしない。
- 最初から複雑なクラウド orchestration 基盤を作らない。
- 統括者がすべての専門作業を自分で実装する運用にはしない。
- 全 agent に全ドキュメントを読ませる運用にはしない。

## 基本単位

### Orchestrator

統括者。責務:
- ユーザーの意図を task graph に変換する。
- 既存エージェントで処理できるか、新規セッションが必要か判定する。
- エージェント任命 contract を作る。
- 各エージェントの状態を台帳化する。
- 成果物と検証結果を受理または差し戻す。
- 全体完了時にユーザーへ短く報告する。

統括者が避けること:
- 専門エージェントに任命した作業を横取りする。
- ブロック状態を推測で突破する。
- ユーザー承認が必要な判断を勝手に採用する。
- ユーザーと専門担当の直接対話を不要に仲介し、ニュアンスを潰す。
- 専門担当との直接対話で進んだ内容を台帳へ同期しないまま放置する。

### Agent Session

通常 Codex セッションを専門エージェントとして扱う。人格や常駐プロセスではなく、以下を持つ運用単位:
- `agent_id`
- `role`
- `mission`
- `workspace_path`
- `allowed_files`
- `forbidden_actions`
- `current_task`
- `status`
- `last_heartbeat`
- `report_path`
- `artifacts`
- `context_scope`
- `required_reading`
- `excluded_context`

Agent session は、担当領域に必要な文脈だけを読み込む。たとえば visual agent はアート規律を読むが、通常はコード規約や世界観全文を読まない。story agent は世界観と物語意図を読むが、通常は実装詳細を読まない。統括者は全専門文書を常時読むのではなく、必要に応じて該当 agent に確認する。

ユーザーは agent session と直接会話してよい。直接会話は Orquesta の例外ではなく、専門性を活かすための主要導線である。ただし、agent session は直接会話で進んだ内容を統括者が追跡できる形に戻す責務を持つ。

### Task

統括者が割り当てる作業単位:
- `task_id`
- `title`
- `owner_agent_id`
- `state`: queued / assigned / active / blocked / review / accepted / archived
- `acceptance_checks`
- `dependencies`
- `blocked_by`
- `result_summary`

## 初期ファイル構成案

```text
orquesta/
  SKILL.md
  references/
    orchestration-protocol.md
    agent-contract.md
    state-schema.md
    game-production-patterns.md
  assets/
    dashboard/
      index.html
      app.js
      styles.css
```

リポジトリ運用中の状態ファイル:

```text
.orquesta/
  CURRENT_ORCHESTRA.md
  state/
    agents.json
    tasks.json
    decisions.jsonl
    events.jsonl
  reports/
    <task-id>-<agent-id>.md
```

## 初期ワークフロー

1. Intake
   - ユーザーの依頼を受け、統括者が task graph を作る。
   - 必要なら質問する。ただし低価値な質問は避ける。

2. Classification
   - 各作業を persistent role / bounded task / review / standby に分類する。
   - 新規セッションが必要か、既存セッションでよいかを判定する。

3. Appointment
   - 統括者が新規セッションを作る、または既存セッションへ任命文を送る。
   - 任命文は contract として保存する。

4. Execution
   - 専門エージェントは契約範囲だけで作業する。
   - 中間ログではなく、必要な成果物と短い heartbeat を返す。
   - ユーザーが専門エージェントと直接会話した場合、その会話で決まった内容を report / state に同期する。

5. Report
   - 専門エージェントは固定形式で報告する。
   - 統括者は acceptance checks に照合する。
   - 直接会話によるニュアンス変更、好み、決定、未決事項を `user_directives` として残す。

6. Synthesis
   - すべての依存タスクが accepted になったら、統括者がユーザーへ報告する。
   - 未完了がある場合は、残タスクとブロッカーを明示する。

## ブラウザアプリ初期要件

最初の UI は美麗な管理画面ではなく、運用盤にする。

表示:
- Agent roster
- Task board
- Dependency graph
- Blockers
- Pending approvals
- Stale sessions
- Recent decisions
- Artifact links
- User-direct conversations needing sync

操作:
- 状態ファイルを読み込む。
- agent / task をフィルタする。
- stale / blocked / review-needed を強調する。
- 任命文テンプレートをコピーできる。

将来:
- Codex thread deep link を開く。
- `send_message_to_thread` などの Codex thread tool と連携する。
- 状態ファイルから静的 HTML を生成する。

## 最初に決めるべき問い

1. Orquesta の統括者は、ユーザーの明示なしに新規セッションを作ってよいか。
2. 同時 active agent 数の初期上限をいくつにするか。
3. 専門エージェントが直接ファイル編集してよい範囲をどう表すか。
4. ブラウザアプリは静的 HTML から始めるか、ローカルサーバーありにするか。
5. ゲーム制作向けの最初の専門 role を何にするか。
6. 各 role が読むべき必須文脈と、読まない文脈をどう定義するか。
7. ユーザーと専門担当の直接会話を、どの粒度で統括者へ同期するか。

小陽の暫定意見:
- 新規セッション作成は、最初は統括者が提案しユーザー承認後に実行。
- active agent は初期上限 3。
- ファイル編集は `allowed_files` と `forbidden_actions` を両方書く。
- ブラウザアプリは静的 HTML + JSON 読み込みから始める。
- 最初の role は `game-design`, `implementation`, `playtest-qa` の 3 つでよい。
- 各 role には `required_reading` と `excluded_context` を持たせる。
- 直接会話で進んだ内容は、担当 agent が `user_directives`, `changed`, `needs_orchestrator_review` に整理して同期する。
