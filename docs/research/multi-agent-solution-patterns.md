# Multi-Agent Solution Patterns

調査日: 2026-06-21

このメモは、`multi-agent-operational-risks.md` で見えた問題に対して、既存の解決策や再利用できる設計パターンを整理するもの。Orquesta は Codex の通常セッションを役割化して統括する構想なので、ここでは「そのまま導入できる技術」と「考え方だけ借りる技術」を分ける。

## 採用判断

Orquesta 初期版で採用すべき既存解は、フルスタックの multi-agent framework ではなく、次の6つ。

1. Explicit contract
2. Structured state and reports
3. Human approval gates
4. Persistent state and resumability
5. Observability dashboard
6. Termination and budget rules

A2A、LangGraph、OpenAI Agents SDK、CrewAI、AutoGen はそれぞれ参考になるが、Orquesta の最初の対象は「API上で動くエージェント」ではなく「Codex app 上の複数通常スレッド」なので、まずは軽い台帳・任命文・可視化から始める。

重要な前提として、Orquesta は subagent を否定するものではない。subagent は短期で read-heavy な探索や検証には有効である。一方、Orquesta は subagent が苦手または不適な領域、特に subagent 非対応の skill、画像生成系 skill、長期の専門文脈を持つ制作担当、同じ相手と継続して働く制作チーム型の運用を扱う。

もう一つの重要な前提は、ユーザーが専門担当と直接会話できること。ユーザーの細かい違和感や好みを統括者が毎回要約して専門担当へ渡すと、制作上のニュアンスが落ちる。Orquesta は統括者を唯一の会話窓口にせず、専門担当との直接反復を許し、その結果だけを台帳へ同期する。

## 問題別の既存解

### 1. エージェント増殖

既存解:
- OpenAI Agents SDK は `agents as tools` と `handoffs` を区別し、マネージャーが会話を握る型と専門家へ渡す型を分けている。
- Anthropic の multi-agent research system は、タスク複雑度に応じて subagent 数や探索努力を変えるルールを入れている。
- CrewAI には `max_rpm`, task list, sequential / hierarchical process があり、実行単位を crew と task に閉じ込める発想がある。

Orquesta への導入:
- 新規セッション作成の前に `reuse_or_create` 判定を必須にする。
- `max_active_agents` を台帳に持つ。初期値は3。
- 任命前に `why_existing_agents_cannot_handle` を書かせる。
- 同じ role が重複する場合は、新規作成ではなく既存 role の task queue に入れる。

採用度:
- すぐ採用。

### 2. コンテキスト汚染

既存解:
- Codex の subagent 公式説明は、探索ログやテストログをメイン会話から逃がし、要約だけ戻す用途を強調している。
- Anthropic は subagent の成果を filesystem など外部成果物に出すことで、伝言ゲームとトークン肥大を減らすパターンを挙げている。
- OpenAI Agents SDK には context management と sessions があり、LLM に見せる文脈とアプリ側のローカル状態を分ける。

Orquesta への導入:
- 統括者への報告は短い summary と artifact path のみ。
- 詳細は `.orquesta/reports/` に保存する。
- 統括者の真実のソースは会話ログではなく `.orquesta/state/*.json` と `CURRENT_ORCHESTRA.md`。
- UI は raw logs ではなく task state / blockers / artifacts を表示する。
- role ごとに `required_reading` と `excluded_context` を定義し、必要な文脈だけを読む。
- 統括者は全専門文書を読み込まず、必要に応じて専門 agent に問い合わせる。

採用度:
- すぐ採用。

### 3. 役割ドリフト

既存解:
- SEMAP 系の研究は、multi-agent software engineering の失敗原因を under-specification, coordination misalignment, inappropriate verification と捉え、behavioral contract、structured messaging、lifecycle verification を対策にする。
- OpenAI Agents SDK の guardrails は、入力・出力・tool call の境界で検査する。
- MCP Security Best Practices は、権限・同意・スコープ最小化・監査可能性を強調する。

Orquesta への導入:
- 任命文を contract として保存する。
- contract には `mission`, `allowed_files`, `forbidden_actions`, `acceptance_checks`, `done_signal` を必須にする。
- 統括者は専門作業を横取りしない。専門エージェントは contract 外の作業をしない。
- contract 違反は `rejected_scope_drift` として記録する。

採用度:
- すぐ採用。

### 4. 重複作業と矛盾成果

既存解:
- LangGraph の orchestrator-worker pattern は、統括者が task を分解し、worker output を共有 state に集約する。
- A2A は agent-to-agent 通信の標準として Agent Card や task lifecycle の考え方を持つ。特に「内部メモリやツールを共有せず、能力を外部に宣言する」発想が使える。
- CrewAI は YAML で agents と tasks を定義する運用を推奨しており、役割とタスクの分離がある。

Orquesta への導入:
- 各 agent に `capabilities` と `owned_files` を持たせる。
- task assignment 時に `write_boundary` を明示する。
- 同じファイルに複数 task が書き込む場合は conflict warning を出す。
- 複数成果物の統合は専門 agent ではなく orchestrator または merge role が扱う。

採用度:
- すぐ採用。ただし自動 conflict detection は後回し。

### 5. コストと速度の予測不能

既存解:
- Anthropic は multi-agent system が chat より大幅にトークンを使うことを明示し、価値が高く、並列化でき、単一 context を超える作業に向けるべきとしている。
- LangGraph fault tolerance は timeout, retry, idle timeout, heartbeat を持つ。
- CrewAI は max_rpm や usage metrics を持つ。

Orquesta への導入:
- task に `effort`: quick / focused / deep を持たせる。
- `parallel_eligible` が true の task だけ同時進行する。
- stale 判定を `last_heartbeat` で行う。
- `max_turns_without_artifact` のような停止ルールを持つ。

採用度:
- すぐ採用。実測 token メトリクスは後回し。

### 6. 評価不能

既存解:
- Anthropic は multi-agent の評価を「手順一致」ではなく、end-state と rubric で見るべきとしている。
- AutoGen は termination condition を明示し、承認 tool call で終了させる例を持つ。
- LangGraph interrupts は approval / review / edit を状態付きで止められる。

Orquesta への導入:
- task は `acceptance_checks` なしでは assigned にしない。
- report は固定形式にする。
- `accepted`, `rejected`, `needs_user_review`, `blocked` を分ける。
- 成果物受理時は、統括者が `acceptance_result` を state に書く。

採用度:
- すぐ採用。

### 7. 長期記憶の劣化

既存解:
- LangGraph persistence は checkpointer を thread-scoped memory、store を cross-thread memory として分ける。
- OpenAI Agents SDK sessions は会話履歴を session 単位で保持する。
- Anthropic は長期会話で phase summary を外部 memory に保存し、必要に応じて fresh subagent を使うパターンを挙げている。

Orquesta への導入:
- `.orquesta/state/agents.json` と `.orquesta/state/tasks.json` を正本にする。
- `.orquesta/state/decisions.jsonl` を append-only にする。
- `CURRENT_ORCHESTRA.md` は人間向け snapshot とし、機械可読 state から再生成できる形にする。
- 古い session は archived / dormant / stale として扱い、active と混ぜない。

採用度:
- すぐ採用。

### 8. 可視化がログビューアで終わる

既存解:
- LangSmith は traces, metrics, dashboards, alerts, online evaluations を提供する。
- OpenAI Agents SDK tracing は LLM generation, tool call, handoff, guardrails, custom events を trace/span として可視化する。
- LangGraph Studio は graph と state のデバッグに使える。

Orquesta への導入:
- 初期 UI は trace viewer ではなく operation board にする。
- 表示対象は agent, task, dependency, blocker, approval, artifact, staleness。
- ユーザーが専門担当と直接進めた会話のうち、統括者へ同期が必要なものを表示する。
- event log は補助ビュー。主 UI は「次に何が詰まっているか」を見せる。
- 将来、Agents SDK や LangSmith 連携をする場合も、Orquesta の state schema は独立させる。

採用度:
- 静的 HTML ダッシュボードとしてすぐ採用。

### 9. セキュリティと権限境界

既存解:
- MCP Security Best Practices は consent, token audience, SSRF, session hijacking, local server compromise, scope minimization を扱う。
- OpenAI Agents SDK HITL は sensitive tool call を人間承認まで pause / resume する。
- Guardrails は tool call ごとの検査にも使える。

Orquesta への導入:
- Codex thread を任命するときに `forbidden_actions` を必ず書く。
- 外部ツール・MCP・ネットワーク・git push・削除系操作は `requires_user_approval` にする。
- ブラウザ UI に pending approvals を出す。
- Orquesta 自体は最初、外部サービス認証やリモート実行を持たない。

採用度:
- すぐ採用。外部プロトコル連携は後回し。

## 採用候補マップ

| 候補 | Orquesta に持ち込む部分 | 初期採用 |
| --- | --- | --- |
| A2A | Agent Card、capability declaration、agent-to-agent と agent-to-tool の分離 | 部分採用 |
| MCP | tool access の権限境界、security checklist | 部分採用 |
| LangGraph | state, checkpoint, interrupt, orchestrator-worker, retry/timeout の考え方 | 部分採用 |
| LangSmith | observability dashboard / traces / alerts の方向性 | 後回し |
| OpenAI Agents SDK | manager vs handoff、sessions、tracing、guardrails、HITL | 部分採用 |
| CrewAI | agents/tasks YAML、hierarchical manager、usage metrics | 部分採用 |
| AutoGen | termination condition、user proxy、group chat control | 部分採用 |
| SEMAP | contract, structured messaging, lifecycle verification | 強く採用 |

## Subagent と long-lived thread の使い分け

| 用途 | subagent | Orquesta long-lived thread |
| --- | --- | --- |
| 短期の探索、ログ解析、テスト確認 | 向く | 必須ではない |
| 大量の中間ログをメイン文脈から逃がす | 向く | report 化で対応 |
| subagent 非対応 skill の実行 | 向かない | 向く |
| 画像生成やアート制作 pipeline | skill 次第で危険 | 向く |
| 1年以上続く専門担当 | 向かない | 向く |
| 担当ごとに読む文脈を分ける | 一時的には可能 | 向く |
| ユーザーが「同じ人と働く」感覚を持つ | 弱い | 強い |
| ユーザーが専門担当と直接ニュアンスを詰める | 弱い | 強い |
| セッション数上限を超える長期チーム管理 | 不向き | 向く |

Orquesta の原則:
- subagent は tactical helper。
- long-lived thread は production teammate。
- 統括者は teammate を任命し、状態を追跡し、成果を受理する。
- teammate は必要文脈だけを持つ。不要な文脈は持たない。
- ユーザーは teammate と直接話してよい。
- teammate は直接会話の成果を統括者へ同期する。

## Orquesta 初期版に入れる具体仕様

### Agent contract

```json
{
  "agent_id": "impl-ui-001",
  "role": "implementation",
  "mission": "Implement the assigned UI task only.",
  "allowed_files": ["src/ui/**"],
  "forbidden_actions": ["edit lore files", "push git", "create new agents"],
  "acceptance_checks": ["npm test", "manual screenshot review"],
  "done_signal": "Write a report to .orquesta/reports/TASK-agent.md",
  "requires_user_approval": ["new dependency", "delete file", "runtime adoption"]
}
```

### Task state

```json
{
  "task_id": "T001",
  "title": "Prototype agent board",
  "state": "assigned",
  "owner_agent_id": "ui-001",
  "dependencies": [],
  "parallel_eligible": true,
  "effort": "focused",
  "blocked_by": [],
  "acceptance_checks": ["loads from sample state JSON", "shows stale agents"],
  "artifacts": []
}
```

### Context scope

```json
{
  "role": "visual-art",
  "required_reading": [
    "docs/art/visual_bible.md",
    "docs/art/asset_rules.md",
    "docs/art/approved_palette.md"
  ],
  "excluded_context": [
    "implementation internals unless the task needs runtime integration",
    "full story canon unless the visual brief references it"
  ],
  "ask_orchestrator_when": [
    "art direction conflicts with lore",
    "runtime format is unclear",
    "approval state is missing"
  ]
}
```

### Report format

```md
# Agent Report

task_id:
agent_id:
status: completed | blocked | needs_review | rejected_scope

## User Directives

## Changed

## Verified

## Not Verified

## Blockers

## Artifacts

## Handoff
```

### Direct conversation sync

```json
{
  "agent_id": "visual-art-001",
  "task_id": "T014",
  "source": "user_direct_conversation",
  "summary": "User wants the trading UI to feel less thin and more physically layered.",
  "user_directives": [
    "Add visual weight and depth, not generic decoration.",
    "Keep the approved industrial terminal direction."
  ],
  "changed": [
    "Updated visual brief for the next UI pass."
  ],
  "needs_orchestrator_review": [
    "Confirm whether implementation should start now or wait for a mockup."
  ]
}
```

### Dashboard views

- Board: active / blocked / review / accepted
- Roster: role, current task, heartbeat, stale flag
- Dependencies: task graph
- Approvals: user decisions required
- Directives: user-to-specialist updates waiting for sync or review
- Artifacts: reports and output files
- Events: append-only history

## 使わないほうがいいもの

- 初期版から A2A server/client を実装すること。
- 初期版から LangGraph や CrewAI を Orquesta の実行基盤にすること。
- 全セッションの raw chat log を UI の中心にすること。
- 自律セッション作成を無制限に許すこと。
- 「専門エージェントの人格設定」だけで権限や終了条件を代替すること。
- subagent 前提でしか動かない設計にすること。
- 全 role に全プロジェクト文脈を読み込ませること。

## 直近の実装方針

1. `.orquesta/state/*.json` の schema を作る。
2. `.orquesta/reports/` の report template を作る。
3. `orquesta/references/agent-contract.md` と `orquesta/references/orchestration-protocol.md` を作る。
4. 静的ブラウザ dashboard を作る。
5. その後に `orquesta/SKILL.md` を作る。

## 調査ソース

- Anthropic Engineering, "How we built our multi-agent research system", 2025-06-13: https://www.anthropic.com/engineering/multi-agent-research-system
- OpenAI Agents SDK, "Agent orchestration": https://openai.github.io/openai-agents-python/multi_agent/
- OpenAI Agents SDK, "Tracing": https://openai.github.io/openai-agents-python/tracing/
- OpenAI Agents SDK, "Context management": https://openai.github.io/openai-agents-python/context/
- OpenAI Agents SDK, "Sessions": https://openai.github.io/openai-agents-python/sessions/
- OpenAI Agents SDK, "Guardrails": https://openai.github.io/openai-agents-python/guardrails/
- OpenAI Agents SDK, "Human-in-the-loop": https://openai.github.io/openai-agents-python/human_in_the_loop/
- A2A Protocol: https://a2a-protocol.org/latest/
- MCP Security Best Practices: https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices
- LangGraph, "Workflows and agents": https://docs.langchain.com/oss/python/langgraph/workflows-agents
- LangGraph, "Persistence": https://docs.langchain.com/oss/python/langgraph/persistence
- LangGraph, "Interrupts": https://docs.langchain.com/oss/python/langgraph/interrupts
- LangGraph, "Fault tolerance": https://docs.langchain.com/oss/python/langgraph/fault-tolerance
- LangSmith Observability: https://docs.langchain.com/langsmith/observability
- CrewAI, "Crews": https://docs.crewai.com/en/concepts/crews
- AutoGen, "Human-in-the-Loop": https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/human-in-the-loop.html
- AutoGen, "Termination": https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/termination.html
- Mao et al., "Towards Engineering Multi-Agent LLMs: A Protocol-Driven Approach", 2025: https://arxiv.org/abs/2510.12120
- Li et al., "Early Diagnosis of Wasted Computation in Multi-Agent LLM Systems via Failure-Aware Observability", 2026: https://arxiv.org/abs/2606.01365
