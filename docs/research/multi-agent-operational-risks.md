# Multi-Agent Operational Risks

調査日: 2026-06-21

このメモは Orquesta skill を作る前の問題発見メモ。目的は、Codex 上で複数の通常セッションを専門エージェントとして任命・監督する仕組みを作る前に、マルチエージェント運用で壊れやすい点を明確にすること。

## 結論

Orquesta が作るべきものは、単なる「たくさんのエージェントを起動する仕組み」ではない。必要なのは、統括者が専門セッションを任命し、各セッションの契約・状態・成果物・停止条件を台帳化し、ユーザーが現在の全体像を見失わないようにする運用プロトコルである。

特にゲーム制作では、実装・UI・アート・世界観・QA・ビルド検証が並行しやすい一方で、成果物同士の依存関係が強い。したがって「並列化できる作業」と「統括者が順番を握るべき作業」を分けないと、速度より手戻りが増える。

## 現在よく使われる運用パターン

1. Orchestrator-worker
   - 統括者がタスクを分解し、専門ワーカーに渡し、戻ってきた成果を統合する。
   - Anthropic Research、LangGraph、OpenAI Agents SDK で中心的に扱われている。
   - Orquesta の基本形に最も近い。

2. Manager keeps control
   - OpenAI Agents SDK の `agents as tools` 型。マネージャーが最終応答とガードレールを握り、専門エージェントは限定作業を行う。
   - Codex の通常セッション運用に置き換えるなら、統括セッションがユーザーへの最終報告とタスク台帳を握る形。

3. Handoff
   - トリアージ担当が専門家へ会話を渡し、専門家が次の応答を所有する。
   - 長期ゲーム制作では便利だが、誰が最終統合するのかが曖昧になると危険。

4. Graph / workflow
   - LangGraph や CrewAI Flows のように、状態・分岐・リトライ・終了条件をコードで管理する。
   - Orquesta 初期版では完全な実行基盤にしないほうがよい。まずは Codex セッションの台帳と視覚化から始めるのが現実的。

5. Codex subagents
   - Codex 公式マニュアルでは、subagent は主に read-heavy な探索、テスト、ログ解析、要約など、ノイズをメイン文脈から逃がす用途に向く。
   - Orquesta の構想は「subagent ではなく通常セッションを役割化する」ものなので、subagent は置き換え対象ではなく、短期補助の選択肢にとどめる。

## 失敗モード

### 1. エージェント増殖

症状:
- 単純な作業にも多数のセッションを立てる。
- 似た役割のエージェントが重複する。
- 統括者が全員の状態を追えなくなる。

原因:
- タスク複雑度に対する起動上限がない。
- 「新しいエージェントを立てる条件」と「既存エージェントへ追記する条件」が未定義。
- 停止、休止、統合、破棄の lifecycle がない。

Orquesta 対策:
- 役割作成前に `classification`: persistent role / bounded task / review / standby を必須にする。
- 同時 active session 数に soft limit を置く。
- 新規セッション作成には `why_existing_roles_cannot_do_this` を要求する。

### 2. コンテキスト汚染とコンテキスト腐敗

症状:
- 統括者の会話が調査ログ、エラー、途中経過で埋まる。
- 重要な判断や承認条件が埋もれる。
- 長期タスクで前提が曖昧になり、同じ議論を繰り返す。

原因:
- 中間出力をそのまま統括者へ貼る。
- 成果物への参照ではなく、会話本文で受け渡しする。
- 何が決定済みで何が仮説かを分けない。

Orquesta 対策:
- 各エージェントは会話で長文報告せず、成果物ファイルと短い status を返す。
- 統括者は `decision log` と `agent registry` を更新する。
- ブラウザアプリは「最新状態」「ブロッカー」「成果物リンク」を表示し、会話ログを主 UI にしない。

### 3. 役割ドリフト

症状:
- 統括者が実装者になる。
- 専門エージェントが許可されていない領域まで編集する。
- Review-only / standby のはずのセッションが勝手に production 作業を始める。

原因:
- 役割定義が抽象的すぎる。
- 入力、出力、禁止事項、承認ゲートがない。
- 「できること」と「任命されたこと」が混同される。

Orquesta 対策:
- 任命メッセージに `mission`, `allowed_files`, `forbidden_actions`, `done_signal`, `report_path` を必ず含める。
- 統括者は各セッションの `scope_hash` または短い contract を台帳化する。
- エージェントの完了報告は contract に照合してから受理する。

### 4. 重複作業と矛盾成果

症状:
- 複数セッションが同じファイルや同じ設計判断を別々に変更する。
- UI とゲームロジックの前提がずれる。
- 片方の成果物がもう片方の成果物を壊す。

原因:
- 所有境界がない。
- 依存関係を統括者が解決せず、各セッションが推測する。
- 作業開始前に対象ファイルと成果物の粒度を固定していない。

Orquesta 対策:
- active task ごとに owner と write boundary を明示する。
- 同じファイルを複数セッションが編集する場合は、統括者が merge role を別に持つ。
- ブラウザアプリに file ownership と conflict warning を出す。

### 5. コストと速度の予測不能

症状:
- 並列化したのに遅い。
- トークン使用量が急増する。
- 同期待ちで全体が止まる。

原因:
- 全員が広く探索する。
- 完了条件が曖昧。
- 依存作業を並列化してしまう。

Orquesta 対策:
- 各タスクに effort budget を持たせる: `quick scan`, `focused implementation`, `deep review`。
- 依存関係のない task だけ parallel eligible にする。
- 統括者は `waiting_on`, `blocked_by`, `next_unblock_action` を管理する。

### 6. 評価不能

症状:
- 専門エージェントの報告が「やりました」だけになる。
- 統括者が成果を検証できない。
- 後から何が正しかったのか追跡できない。

原因:
- 成果物、検証方法、合格条件が定義されていない。
- multi-agent は実行経路が非決定的なので、手順一致型の評価に向かない。

Orquesta 対策:
- タスクごとに `acceptance_checks` を必須にする。
- 統括者は end-state evaluation を基本にする。
- report は `changed`, `verified`, `not_verified`, `blocked`, `handoff` の固定形式にする。

### 7. 長期記憶の劣化

症状:
- 数日後にセッションを再開すると前提が失われる。
- 古い判断が現在も有効か分からない。
- 完了済みタスクと未完了タスクが混ざる。

原因:
- 会話ログ頼り。
- 決定ログ、タスク台帳、成果物索引がない。
- アーカイブと再開のルールがない。

Orquesta 対策:
- `orquesta/state/agents.json` と `orquesta/state/tasks.json` のような機械可読台帳を持つ。
- 人間向けには `CURRENT_ORCHESTRA.md` を生成する。
- 完了・休止・破棄・再開を lifecycle として扱う。

### 8. 可視化がログビューアで終わる

症状:
- ブラウザアプリに情報はあるが、判断に使えない。
- 何が詰まっているのか見えない。
- ユーザーが統括者に聞かないと全体像が分からない。

原因:
- UI が会話ログ中心。
- 役割、状態、依存、ブロッカー、成果物の構造化データがない。

Orquesta 対策:
- 最初の UI はログではなく operation board にする。
- 必須表示: active agents, task state, dependency graph, blocked items, stale sessions, pending approvals, artifacts.
- 各エージェントに heartbeat を要求し、古いセッションを visually stale にする。

## Orquesta 初期設計への示唆

1. エージェントは人格ではなく「任命された通常 Codex セッション + contract + state」で定義する。
2. 統括者は実装者ではなく、台帳管理、任命、受理判定、ユーザー報告を主責務にする。
3. subagent は Orquesta の基本単位にしない。短時間・読取中心・ノイズ隔離のためだけに使う。
4. 長期タスクでは会話ログを真実のソースにしない。台帳と成果物ファイルを真実のソースにする。
5. ブラウザアプリは「今何が起きているか」を見るための運用盤であり、チャット UI ではない。
6. ゲーム制作ではファイル所有権、承認ゲート、プレイテスト結果、アート/コード/仕様の同期が特に重要。

## 調査ソース

- Anthropic Engineering, "How we built our multi-agent research system", 2025-06-13: https://www.anthropic.com/engineering/multi-agent-research-system
- OpenAI Agents SDK, "Agent orchestration": https://openai.github.io/openai-agents-python/multi_agent/
- Codex Manual, "Agent Skills", "Subagents", "Codex app commands", fetched 2026-06-21 from https://developers.openai.com/codex/codex-manual.md
- LangGraph docs, "Workflows and agents": https://docs.langchain.com/oss/python/langgraph/workflows-agents
- LangGraph docs, "Persistence": https://docs.langchain.com/oss/python/langgraph/persistence
- LangGraph docs, "Fault tolerance": https://docs.langchain.com/oss/python/langgraph/fault-tolerance
- CrewAI docs, "Crews": https://docs.crewai.com/en/concepts/crews
- Mao et al., "Towards Engineering Multi-Agent LLMs: A Protocol-Driven Approach", 2025: https://arxiv.org/abs/2510.12120
- Tran et al., "Multi-Agent Collaboration Mechanisms: A Survey of LLMs", 2025: https://arxiv.org/abs/2501.06322

