const state = {
  agents: [],
  sessions: [],
  tasks: [],
  directives: [],
  vision: {
    questions: [],
    answerBatches: [],
    curationPolicy: {}
  },
  failures: {
    incidents: [],
    userActions: [],
    wakePolicy: {}
  },
  userTasks: {
    tasks: [],
    policy: {}
  },
  events: [
    {
      ts: "2026-06-21T13:55:00+09:00",
      type: "sample_loaded",
      summary: "Load .orquesta/state JSON files to inspect live state."
    }
  ],
  loadedFiles: [],
  loadedAt: null,
  isLive: false,
  liveSource: "sample",
  selectedAgentId: "orchestrator",
  previewAgentId: null,
  showMoreTasks: false,
  showMoreEvents: false,
  currentView: "operations",
  answerDrafts: {},
  answerStatus: null,
  selectedQuestionId: null,
  showAllQuestions: false,
  isAnswerEditing: false,
  pendingLiveRender: false,
  map: {
    x: 0,
    y: 0,
    scale: 0.82
  }
};

const sample = {
  agents: [
    {
      agent_id: "orchestrator",
      role: "orchestrator",
      status: "standby",
      current_task: null,
      mission: "Coordinate state, blockers, approvals, and final reports."
    },
    {
      agent_id: "visual-art-001",
      role: "visual-art",
      status: "standby",
      current_task: null,
      mission: "Own visual direction and direct visual refinement."
    },
    {
      agent_id: "vision-curator",
      role: "vision-curator",
      status: "standby",
      current_task: null,
      mission: "Own user questions, answer interpretation, and vision synthesis as a user-facing peer."
    },
    {
      agent_id: "error-concierge",
      role: "error-concierge",
      status: "standby",
      current_task: null,
      mission: "Own failure clustering, user-side repair cards, and fallback quality warnings."
    },
    {
      agent_id: "user-liaison",
      role: "user-liaison",
      status: "standby",
      current_task: null,
      mission: "Own user-side task presentation and coordinate vision/error user asks."
    },
    {
      agent_id: "implementation-001",
      role: "implementation",
      status: "standby",
      current_task: null,
      mission: "Implement scoped code tasks and verify them concretely."
    }
  ],
  sessions: [],
  tasks: [
    {
      task_id: "T001",
      title: "Build Orquesta minimum viable operating protocol and dashboard",
      state: "accepted",
      owner_agent_id: "orchestrator",
      blocked_by: [],
      acceptance_checks: ["Dashboard loads state JSON"],
      result_summary: "Initial protocol and dashboard are accepted."
    },
    {
      task_id: "T003",
      title: "Review Orquesta dashboard visual direction",
      state: "accepted",
      owner_agent_id: "visual-art-001",
      blocked_by: [],
      acceptance_checks: ["visual review report exists"],
      result_summary: "Needs clearer severity hierarchy and stronger live-state cues."
    },
    {
      task_id: "T004",
      title: "Redesign Orquesta dashboard visual UI",
      state: "accepted",
      owner_agent_id: "orchestrator",
      dependencies: ["T003"],
      blocked_by: [],
      acceptance_checks: ["light product UI", "desktop and mobile review"],
      result_summary: "Light product command board direction is accepted."
    }
  ],
  directives: [
    {
      directive_id: "D001",
      status: "needs_orchestrator_review",
      agent_id: "orchestrator",
      task_id: "T001",
      summary: "Direct specialist conversations should preserve user nuance and sync back."
    }
  ],
  vision: {
    questions: [
      {
        question_id: "Q001",
        source_agent_id: "visual-art-001",
        task_id: "T013",
        scope: "visual",
        priority: "medium",
        status: "draft",
        question: "Should the first game prototype feel more like a precise instrument or a lived-in creative workspace?",
        why_it_matters: "This changes UI density, surface treatment, and animation restraint.",
        answer_format: "choice_with_optional_note",
        options: ["precise instrument", "lived-in workspace", "hybrid"]
      }
    ],
    answerBatches: [],
    curationPolicy: {
      curator_agent_id: "vision-curator",
      wake_triggers: ["project_kickoff", "uncurated_questions_gte_10", "high_priority_question", "user_requests_question_review"]
    }
  },
  failures: {
    incidents: [],
    userActions: [],
    wakePolicy: {
      concierge_agent_id: "error-concierge",
      wake_triggers: ["equivalent_failures_gte_2", "permission_or_admin_denial", "quality_lowering_fallback_proposed"]
    }
  },
  userTasks: {
    tasks: [],
    policy: {
      coordinator_agent_id: "user-liaison",
      managed_agents: ["vision-curator", "error-concierge"]
    }
  }
};

Object.assign(state, sample);

const $ = (id) => document.getElementById(id);
const LANG_KEY = "orquesta.dashboard.lang";
let currentLang = localStorage.getItem(LANG_KEY) === "ja" ? "ja" : "en";

const dictionary = {
  en: {
    "brand.subtitle": "Production command board for long-lived Codex teammates",
    "load.button": "Load state",
    "load.title": "Load agents.json, tasks.json, directives.json, and events.jsonl",
    "view.operations": "Operations",
    "view.userTasks": "User Tasks",
    "eyebrow.attention": "attention",
    "eyebrow.progress": "progress",
    "eyebrow.now": "now",
    "eyebrow.chain": "chain",
    "eyebrow.team": "team",
    "eyebrow.teamMap": "team map",
    "eyebrow.work": "work",
    "eyebrow.intent": "intent",
    "eyebrow.timeline": "timeline",
    "eyebrow.vision": "vision",
    "eyebrow.userTasks": "your desk",
    "eyebrow.repairs": "repairs",
    "section.progress": "Work Progress",
    "section.running": "Running Now",
    "section.command": "Command Map",
    "section.roster": "Specialist Roster",
    "section.teamVisualizer": "Team Visualizer",
    "section.tasks": "Task Flow",
    "section.directives": "Directives",
    "section.events": "Recent Events",
    "section.vision": "Vision Questions",
    "section.userTasks": "User Tasks",
    "section.repairs": "Repair Cards",
    "user.readyQuestions": "Questions to answer",
    "user.reviewDirectives": "Reviews needed",
    "user.blockedTasks": "Blocked asks",
    "user.repairCards": "Repair cards",
    "user.liaisonTasks": "Liaison tasks",
    "user.noTasks": "Nothing needs you right now",
    "user.noTasksDetail": "The AI team has no user-side action queued.",
    "user.questionsDetail": "Ready Vision Alignment questions waiting for your answers.",
    "user.reviewDetail": "Directives or specialist updates waiting for your decision.",
    "user.blockedDetail": "Tasks that need user input before the team can continue.",
    "user.repairsDetail": "Environment or permission fixes proposed by the Failure Concierge.",
    "user.liaisonDetail": "Accepted user-side work sequenced by the User Liaison.",
    "repair.noCards": "No repair cards queued",
    "repair.noCardsDetail": "Environment, permission, and fallback issues will appear here when user action can help.",
    "repair.why": "Why",
    "repair.userSteps": "User steps",
    "repair.codexCanDo": "Codex can do",
    "repair.risk": "Risk",
    "list.showMore": "Show all {count}",
    "list.showLess": "Collapse",
    "list.showing": "Showing {shown} of {total}",
    "empty.records": "No records yet",
    "lang.toggle": "日本語",
    "sync.live": "Live · {count} files",
    "sync.server": "Auto · refreshed {time}",
    "sync.sample": "Sample state",
    "attention.ready.title": "Ready for orchestration",
    "attention.ready.text": "All visible work is calm. Load live state or assign the next specialist task when you are ready.",
    "attention.blocked.title": "{count} blockers need attention",
    "attention.review.title": "{count} directives awaiting review",
    "attention.review.text": "A user-to-specialist update needs orchestrator review.",
    "attention.active.title": "{count} active tasks in motion",
    "attention.stale.title": "{count} active agents without heartbeat",
    "metric.agents": "Agents",
    "metric.tasks": "Tasks",
    "metric.blocked": "Blocked",
    "metric.review": "Review",
    "metric.vision": "Vision",
    "metric.sessions": "Sessions",
    "metric.agents.detail": "{active} active · {standby} standby",
    "metric.tasks.detail": "{active} active · {accepted} accepted",
    "metric.blocked.detail": "hard stops",
    "metric.review.detail": "directives + stale",
    "metric.vision.detail": "{ready} ready · {draft} draft",
    "metric.sessions.detail": "{linked} linked · {unassigned} unassigned",
    "count.total": "{count} total",
    "count.complete": "{count}% complete",
    "count.noTasks": "no tasks",
    "count.running": "{count} running",
    "count.calm": "calm",
    "count.links": "{count} links",
    "count.noLinks": "no links",
    "count.agentsActive": "{agents} agents · {active} running",
    "count.podsActive": "{pods} pods · {agents} agents · {active} running",
    "map.zoom": "{zoom}% zoom",
    "progress.acceptedOf": "{accepted} of {total} tasks accepted",
    "progress.detail": "{active} active, {queued} queued, {blocked} blocked, {review} in review.",
    "progress.accepted": "Accepted",
    "progress.active": "Active",
    "progress.blocked": "Blocked",
    "running.noTask": "No current task recorded",
    "running.taskOwner": "task owner",
    "team.user": "User",
    "team.userRole": "creative authority",
    "team.floor": "Command floor",
    "team.currentTask": "Current task",
    "team.ownedTasks": "Owned tasks",
    "team.dependsOn": "Depends on",
    "team.collaboratesWith": "Collaborates with",
    "team.noCurrentTask": "No active task",
    "team.noDependencies": "No current dependencies",
    "team.noCollaborators": "No cross-agent collaborators",
    "team.moreAgents": "+{count} more",
    "team.podAgents": "{count} agents",
    "team.podActive": "{count} running",
    "team.panHint": "Drag to pan · wheel to zoom",
    "team.sessionLinked": "session linked",
    "map.commander": "commander",
    "map.owner": "owner",
    "map.depends": "Depends on {items}",
    "map.noDependencies": "No task dependencies",
    "map.cooperates": "Cooperates with {items}",
    "map.noCollaborators": "No cross-agent collaborators recorded",
    "agent.mission": "Mission",
    "agent.scope": "Scope",
    "agent.session": "Codex session",
    "agent.unspecified": "unspecified",
    "task.checks": "Checks",
    "task.result": "Result",
    "task.none": "none",
    "task.notAccepted": "not accepted yet",
    "vision.curator": "Curator",
    "vision.wake": "Wake check",
    "vision.wakeNow": "Curator trigger ready",
    "vision.noWake": "No trigger yet",
    "vision.questions": "Questions",
    "vision.answers": "Answer batches",
    "vision.highPriority": "High priority",
    "vision.uncurated": "Uncurated",
    "vision.latest": "Latest questions",
    "vision.questionList": "Question list",
    "vision.allQuestions": "All questions",
    "vision.openQuestion": "Open question",
    "vision.answeredMark": "Answered",
    "vision.unansweredMark": "Needs answer",
    "vision.previous": "Previous",
    "vision.next": "Next",
    "vision.why": "Why",
    "vision.options": "Options",
    "vision.answer": "Your answer",
    "vision.answerPlaceholder": "Write your answer here...",
    "vision.saveAnswers": "Save written answers",
    "vision.saving": "Saving...",
    "vision.saved": "Saved {count} answers as {batch}",
    "vision.saveError": "Could not save answers",
    "vision.noDrafts": "Write at least one answer before saving.",
    "vision.localOnly": "Answer saving works from the localhost dashboard.",
    "vision.triggers": "Triggers",
    "vision.noQuestions": "No vision questions queued",
    "vision.noAnswers": "No answer batches yet",
    "time.none": "no time",
    "value.active": "active",
    "value.accepted": "accepted",
    "value.blocked": "blocked",
    "value.queued": "queued",
    "value.standby": "standby",
    "value.needs-review": "Needs review",
    "value.needs-orchestrator-review": "needs orchestrator review",
    "value.live-files-loaded": "Live files loaded",
    "value.sample-preview": "Sample preview",
    "value.loaded": "Loaded {time}",
    "value.active-work": "Active work",
    "value.stale-heartbeat": "Stale heartbeat",
    "value.no-task": "no task",
    "value.unassigned": "unassigned",
    "value.unknown": "unknown",
    "value.orchestrator": "orchestrator",
    "value.visual-art": "visual-art",
    "value.implementation": "implementation",
    "value.world-lore": "world-lore",
    "value.playtest-qa": "playtest-qa",
    "value.vision-curator": "vision-curator",
    "value.error-concierge": "error-concierge",
    "value.user-liaison": "user-liaison",
    "value.orquesta-admin": "settings",
    "value.session": "unassigned session",
    "value.ready": "ready",
    "value.draft": "draft",
    "value.answered": "answered",
    "value.adopted": "adopted",
    "value.retired": "retired",
    "value.low": "low",
    "value.medium": "medium",
    "value.high": "high",
    "value.needs-curation": "needs curation"
  },
  ja: {
    "brand.subtitle": "長期稼働するCodexチームメイトの制作司令盤",
    "load.button": "状態を読み込む",
    "load.title": "agents.json, tasks.json, directives.json, events.jsonl を読み込む",
    "eyebrow.attention": "注目",
    "eyebrow.progress": "進行",
    "eyebrow.now": "稼働中",
    "eyebrow.chain": "指揮系統",
    "eyebrow.team": "チーム",
    "eyebrow.teamMap": "チーム図",
    "eyebrow.work": "作業",
    "eyebrow.intent": "意図",
    "eyebrow.timeline": "履歴",
    "section.progress": "作業進行度",
    "section.running": "現在稼働中",
    "section.command": "指揮マップ",
    "section.roster": "専門AI一覧",
    "section.teamVisualizer": "チームビジュアライザー",
    "section.tasks": "タスク進行",
    "section.directives": "ユーザー指示",
    "section.events": "最近のイベント",
    "empty.records": "まだ記録がありません",
    "lang.toggle": "English",
    "sync.live": "ライブ · {count}ファイル",
    "sync.server": "自動更新 · {time}",
    "sync.sample": "サンプル状態",
    "attention.ready.title": "統括準備完了",
    "attention.ready.text": "表示中の作業は落ち着いています。ライブ状態を読み込むか、次の専門タスクを割り当てられます。",
    "attention.blocked.title": "{count}件のブロッカーがあります",
    "attention.review.title": "{count}件の指示が確認待ちです",
    "attention.review.text": "ユーザーと専門AIの会話更新に、統括者の確認が必要です。",
    "attention.active.title": "{count}件のタスクが進行中です",
    "attention.stale.title": "{count}体の稼働AIにハートビートがありません",
    "metric.agents": "AI",
    "metric.tasks": "タスク",
    "metric.blocked": "停止",
    "metric.review": "確認",
    "metric.sessions": "セッション",
    "metric.agents.detail": "稼働 {active} · 待機 {standby}",
    "metric.tasks.detail": "進行 {active} · 完了 {accepted}",
    "metric.blocked.detail": "作業停止要因",
    "metric.review.detail": "指示 + stale",
    "metric.sessions.detail": "紐付き {linked} · 未任命 {unassigned}",
    "count.total": "全{count}件",
    "count.complete": "{count}% 完了",
    "count.noTasks": "タスクなし",
    "count.running": "{count}件稼働中",
    "count.calm": "稼働なし",
    "count.links": "{count}件の関係",
    "count.noLinks": "関係なし",
    "count.agentsActive": "AI {agents}体 · 稼働 {active}体",
    "count.podsActive": "{pods}部署 · AI {agents}体 · 稼働 {active}体",
    "map.zoom": "ズーム {zoom}%",
    "progress.acceptedOf": "{total}件中{accepted}件が受理済み",
    "progress.detail": "進行 {active}、待機 {queued}、停止 {blocked}、確認中 {review}。",
    "progress.accepted": "受理済み",
    "progress.active": "進行中",
    "progress.blocked": "停止",
    "running.noTask": "現在タスクの記録なし",
    "running.taskOwner": "タスク担当",
    "team.user": "ユーザー",
    "team.userRole": "発案・承認",
    "team.floor": "コマンドフロア",
    "team.currentTask": "現在タスク",
    "team.ownedTasks": "担当タスク",
    "team.dependsOn": "依存",
    "team.collaboratesWith": "協力",
    "team.noCurrentTask": "進行中タスクなし",
    "team.noDependencies": "現在依存なし",
    "team.noCollaborators": "他AIとの協力なし",
    "team.moreAgents": "+{count}体",
    "team.podAgents": "{count}体",
    "team.podActive": "稼働 {count}体",
    "team.panHint": "ドラッグで移動 · ホイールでズーム",
    "team.sessionLinked": "実セッション",
    "map.commander": "命令元",
    "map.owner": "担当",
    "map.depends": "{items} に依存",
    "map.noDependencies": "タスク依存なし",
    "map.cooperates": "{items} と協力",
    "map.noCollaborators": "他AIとの協力記録なし",
    "agent.mission": "任務",
    "agent.scope": "範囲",
    "agent.session": "Codexセッション",
    "agent.unspecified": "未指定",
    "task.checks": "確認項目",
    "task.result": "結果",
    "task.none": "なし",
    "task.notAccepted": "未受理",
    "time.none": "時刻なし",
    "value.active": "稼働中",
    "value.accepted": "受理済み",
    "value.blocked": "停止",
    "value.queued": "待機",
    "value.standby": "待機中",
    "value.needs-review": "確認待ち",
    "value.needs-orchestrator-review": "統括確認待ち",
    "value.live-files-loaded": "ライブ状態読込済み",
    "value.sample-preview": "サンプル表示",
    "value.loaded": "{time} 読込",
    "value.active-work": "進行中作業",
    "value.stale-heartbeat": "ハートビート未記録",
    "value.no-task": "タスクなし",
    "value.unassigned": "未割当",
    "value.unknown": "不明",
    "value.orchestrator": "統括",
    "value.visual-art": "ビジュアル",
    "value.implementation": "実装",
    "value.world-lore": "世界観",
    "value.playtest-qa": "プレイテストQA"
  }
};

Object.assign(dictionary.ja, {
  "eyebrow.vision": "ビジョン",
  "section.vision": "ビジョン質問",
  "metric.vision": "ビジョン",
  "metric.vision.detail": "提示可 {ready} · 下書き {draft}",
  "vision.curator": "キュレーター",
  "vision.wake": "起動判定",
  "vision.wakeNow": "Curator 起動条件あり",
  "vision.noWake": "まだ起動不要",
  "vision.questions": "質問",
  "vision.answers": "回答バッチ",
  "vision.highPriority": "高優先度",
  "vision.uncurated": "未整理",
  "vision.latest": "最新の質問",
  "vision.questionList": "質問一覧",
  "vision.allQuestions": "すべての質問",
  "vision.openQuestion": "質問を開く",
  "vision.answeredMark": "回答あり",
  "vision.unansweredMark": "未回答",
  "vision.previous": "前の質問",
  "vision.next": "次の質問",
  "vision.why": "理由",
  "vision.options": "選択肢",
  "vision.answer": "あなたの回答",
  "vision.answerPlaceholder": "ここにテキストで回答を書く",
  "vision.saveAnswers": "書いた回答を保存",
  "vision.saving": "保存中...",
  "vision.saved": "{batch} として {count}件保存しました",
  "vision.saveError": "回答を保存できませんでした",
  "vision.noDrafts": "保存する前に、少なくとも1つ回答を書いてください。",
  "vision.localOnly": "回答保存は localhost のダッシュボードで使えます。",
  "vision.triggers": "起動条件",
  "vision.noQuestions": "待機中のビジョン質問はありません",
  "vision.noAnswers": "回答バッチはまだありません",
  "value.vision-curator": "ビジョン整理",
  "value.error-concierge": "失敗整理",
  "value.user-liaison": "ユーザー窓口",
  "value.orquesta-admin": "設定",
  "value.session": "未任命セッション",
  "value.ready": "提示可",
  "value.draft": "下書き",
  "value.answered": "回答済み",
  "value.adopted": "反映済み",
  "value.retired": "破棄",
  "value.low": "低",
  "value.medium": "中",
  "value.high": "高",
  "value.needs-curation": "整理待ち"
});

Object.assign(dictionary.ja, {
  "view.operations": "運用",
  "view.userTasks": "ユーザータスク",
  "eyebrow.userTasks": "あなたの席",
  "eyebrow.repairs": "修理",
  "section.userTasks": "ユーザータスク",
  "section.repairs": "修理カード",
  "user.readyQuestions": "回答待ち質問",
  "user.reviewDirectives": "確認待ち",
  "user.blockedTasks": "相談待ち",
  "user.repairCards": "修理カード",
  "user.liaisonTasks": "窓口タスク",
  "user.noTasks": "今あなた待ちの作業はありません",
  "user.noTasksDetail": "AIチーム側に、ユーザーが今すぐ対応する項目はありません。",
  "user.questionsDetail": "回答できる Vision Alignment 質問です。",
  "user.reviewDetail": "判断や確認が必要な指示・専門AI更新です。",
  "user.blockedDetail": "ユーザー入力がないと進めにくいタスクです。",
  "user.repairsDetail": "Failure Concierge が提案した、環境・権限まわりのユーザー側対応です。",
  "user.liaisonDetail": "User Liaison が整理した、ユーザー側で対応する作業です。",
  "repair.noCards": "待機中の修理カードはありません",
  "repair.noCardsDetail": "環境、権限、品質劣化回避に関わるユーザー対応が必要になったらここに表示されます。",
  "repair.why": "理由",
  "repair.userSteps": "ユーザー側でやること",
  "repair.codexCanDo": "Codex側でできること",
  "repair.risk": "リスク",
  "list.showMore": "すべて表示 {count}件",
  "list.showLess": "折りたたむ",
  "list.showing": "{total}件中 {shown}件を表示"
});

function t(key, vars = {}, fallback = key) {
  const template = dictionary[currentLang]?.[key] ?? dictionary.en[key] ?? fallback;
  return template.replace(/\{(\w+)\}/g, (_, name) => vars[name] ?? "");
}

function valueLabel(value, vars = {}) {
  const key = String(value || "unknown").toLowerCase().replaceAll("_", "-").replace(/\s+/g, "-");
  return t(`value.${key}`, vars, value);
}

function applyLanguage() {
  document.documentElement.lang = currentLang;
  document.querySelectorAll("[data-i18n]").forEach((node) => {
    node.textContent = t(node.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-title]").forEach((node) => {
    node.title = t(node.dataset.i18nTitle);
  });
  $("langToggle").textContent = t("lang.toggle");
  $("langToggle").setAttribute("aria-label", currentLang === "ja" ? "Switch to English" : "日本語に切り替え");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function normalizeClass(value) {
  return String(value || "unknown").replaceAll("_", "-").replace(/[^a-zA-Z0-9-]/g, "-");
}

function pill(text, extra = "") {
  const cls = normalizeClass(extra || text);
  return `<span class="pill ${cls}">${escapeHtml(valueLabel(text))}</span>`;
}

function renderList(id, records, renderer) {
  const node = $(id);
  node.innerHTML = records.length
    ? records.map(renderer).join("")
    : $("emptyTemplate").innerHTML;
}

function renderCollapsibleList(id, records, renderer, options) {
  const { expanded, limit, toggleAction } = options;
  const node = $(id);
  const visibleRecords = expanded ? records : records.slice(0, limit);
  const hiddenCount = Math.max(0, records.length - visibleRecords.length);
  const listHtml = visibleRecords.length
    ? visibleRecords.map(renderer).join("")
    : $("emptyTemplate").innerHTML;
  const controlHtml = records.length > limit
    ? `
      <div class="list-collapse-control">
        <span>${escapeHtml(t("list.showing", { shown: visibleRecords.length, total: records.length }))}</span>
        <button type="button" data-action="${toggleAction}">
          ${escapeHtml(expanded ? t("list.showLess") : t("list.showMore", { count: hiddenCount }))}
        </button>
      </div>
    `
    : "";
  node.classList.toggle("is-collapsed", !expanded && records.length > limit);
  node.innerHTML = `${listHtml}${controlHtml}`;
}

function statusClass(status) {
  return normalizeClass(status || "unknown");
}

function formatCount(labelKey, count) {
  return t(`count.${labelKey}`, { count }, `${count} ${labelKey}`);
}

function shortTime(ts) {
  if (!ts) return t("time.none");
  const match = String(ts).match(/T(\d{2}:\d{2})/);
  return match ? match[1] : String(ts).slice(0, 12);
}

function getSignals() {
  const blockedTasks = state.tasks.filter((task) => (task.blocked_by || []).length || task.state === "blocked");
  const activeTasks = state.tasks.filter((task) => task.state === "active");
  const reviewDirectives = state.directives.filter((directive) => String(directive.status).includes("review"));
  const activeAgents = state.agents.filter((agent) => agent.status === "active");
  const staleAgents = state.agents.filter((agent) => agent.status === "active" && !agent.last_heartbeat);
  return { blockedTasks, activeTasks, reviewDirectives, activeAgents, staleAgents };
}

function renderAttention() {
  const { blockedTasks, activeTasks, reviewDirectives, staleAgents } = getSignals();
  let title = t("attention.ready.title");
  let text = t("attention.ready.text");
  const actions = [];

  if (blockedTasks.length) {
    title = t("attention.blocked.title", { count: blockedTasks.length });
    text = blockedTasks.map((task) => `${task.task_id}: ${(task.blocked_by || []).join(", ")}`).join(" · ");
    actions.push(pill("Blocked", "blocked"));
  } else if (reviewDirectives.length) {
    title = t("attention.review.title", { count: reviewDirectives.length });
    text = reviewDirectives[0].summary || t("attention.review.text");
    actions.push(pill("Needs review", "needs_review"));
  } else if (activeTasks.length) {
    title = t("attention.active.title", { count: activeTasks.length });
    text = activeTasks.map((task) => `${task.task_id}: ${task.title}`).join(" · ");
    actions.push(pill("Active work", "active"));
  } else if (staleAgents.length) {
    title = t("attention.stale.title", { count: staleAgents.length });
    text = staleAgents.map((agent) => agent.agent_id).join(", ");
    actions.push(pill("Stale heartbeat", "blocked"));
  }

  $("attentionTitle").textContent = title;
  $("attentionText").textContent = text;
  $("attentionActions").innerHTML = [
    ...actions,
    pill(state.isLive ? "Live files loaded" : "Sample preview", state.isLive ? "accepted" : "queued"),
    state.loadedAt ? `<span class="pill active">${escapeHtml(t("value.loaded", { time: state.loadedAt }))}</span>` : ""
  ].join("");
}

function renderMetrics() {
  const { blockedTasks, activeTasks, reviewDirectives, activeAgents, staleAgents } = getSignals();
  const accepted = state.tasks.filter((task) => task.state === "accepted").length;
  const standby = state.agents.filter((agent) => agent.status === "standby").length;
  const visionStats = getVisionStats();
  const linkedSessions = state.agents.filter((agent) => agent.codex_session).length;
  const unassignedSessions = state.agents.filter((agent) => agent.role === "session").length;
  $("metrics").innerHTML = [
    [t("metric.agents"), state.agents.length, t("metric.agents.detail", { active: activeAgents.length, standby })],
    [t("metric.sessions"), state.sessions.length, t("metric.sessions.detail", { linked: linkedSessions, unassigned: unassignedSessions })],
    [t("metric.tasks"), state.tasks.length, t("metric.tasks.detail", { active: activeTasks.length, accepted })],
    [t("metric.blocked"), blockedTasks.length, t("metric.blocked.detail")],
    [t("metric.review"), reviewDirectives.length + staleAgents.length, t("metric.review.detail")],
    [t("metric.vision"), visionStats.totalQuestions, t("metric.vision.detail", { ready: visionStats.ready, draft: visionStats.draft })]
  ].map(([label, value, detail]) => `
    <div class="metric">
      <strong>${value}</strong>
      <span>${label}</span>
      <small>${escapeHtml(detail)}</small>
    </div>
  `).join("");
}

function getVisionStats() {
  const questions = state.vision?.questions || [];
  const answerBatches = state.vision?.answerBatches || [];
  const draft = questions.filter((question) => question.status === "draft").length;
  const ready = questions.filter((question) => question.status === "ready").length;
  const answered = questions.filter((question) => question.status === "answered").length;
  const adopted = questions.filter((question) => question.status === "adopted").length;
  const high = questions.filter((question) => question.priority === "high").length;
  const uncurated = questions.filter((question) => ["draft", "answered"].includes(question.status)).length;
  const needsCuration = answerBatches.filter((batch) => String(batch.status || "").includes("curation")).length;
  const shouldWake = high > 0 || uncurated >= 10 || needsCuration > 0;
  return {
    totalQuestions: questions.length,
    answerBatches: answerBatches.length,
    draft,
    ready,
    answered,
    adopted,
    high,
    uncurated,
    needsCuration,
    shouldWake
  };
}

function getUserTaskStats() {
  const vision = state.vision || {};
  const questions = vision.questions || [];
  const readyQuestions = questions.filter((question) => question.status === "ready");
  const reviewDirectives = state.directives.filter((directive) => String(directive.status || "").includes("review"));
  const blockedTasks = state.tasks.filter((task) => (task.blocked_by || []).some((blocker) => String(blocker).toLowerCase().includes("user")));
  const repairCards = (state.failures?.userActions || []).filter((action) => !["resolved", "skipped", "retired"].includes(String(action.status || "").toLowerCase()));
  const liaisonTasks = (state.userTasks?.tasks || []).filter((task) => !["resolved", "skipped", "retired"].includes(String(task.status || "").toLowerCase()));
  return {
    readyQuestions,
    reviewDirectives,
    blockedTasks,
    repairCards,
    liaisonTasks,
    total: readyQuestions.length + reviewDirectives.length + blockedTasks.length + repairCards.length + liaisonTasks.length
  };
}

function getFailureStats() {
  const incidents = state.failures?.incidents || [];
  const repairCards = state.failures?.userActions || [];
  const openIncidents = incidents.filter((incident) => !["resolved", "retired"].includes(String(incident.status || "").toLowerCase()));
  const readyCards = repairCards.filter((action) => !["resolved", "skipped", "retired"].includes(String(action.status || "").toLowerCase()));
  return { incidents, repairCards, openIncidents, readyCards };
}

function renderViewSwitch() {
  document.querySelectorAll("[data-view-target]").forEach((button) => {
    const active = button.dataset.viewTarget === state.currentView;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  document.querySelectorAll("[data-view-panel]").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.viewPanel === state.currentView);
  });
}

function renderUserTaskSummary() {
  const stats = getUserTaskStats();
  $("userTaskCount").textContent = formatCount("total", stats.total);
  const cards = [
    [t("user.readyQuestions"), stats.readyQuestions.length, t("user.questionsDetail"), "active"],
    [t("user.reviewDirectives"), stats.reviewDirectives.length, t("user.reviewDetail"), stats.reviewDirectives.length ? "blocked" : "standby"],
    [t("user.blockedTasks"), stats.blockedTasks.length, t("user.blockedDetail"), stats.blockedTasks.length ? "blocked" : "standby"],
    [t("user.repairCards"), stats.repairCards.length, t("user.repairsDetail"), stats.repairCards.length ? "blocked" : "standby"],
    [t("user.liaisonTasks"), stats.liaisonTasks.length, t("user.liaisonDetail"), stats.liaisonTasks.length ? "active" : "standby"]
  ];
  $("userTaskSummary").innerHTML = stats.total
    ? cards.map(([label, value, detail, tone]) => `
      <article class="user-task-card ${tone}">
        <strong>${value}</strong>
        <div>
          <b>${escapeHtml(label)}</b>
          <p>${escapeHtml(detail)}</p>
        </div>
      </article>
    `).join("")
    : `
      <article class="user-task-empty">
        <b>${escapeHtml(t("user.noTasks"))}</b>
        <p>${escapeHtml(t("user.noTasksDetail"))}</p>
      </article>
    `;
}

function renderRepairCards() {
  const stats = getFailureStats();
  $("repairCount").textContent = formatCount("total", stats.readyCards.length);
  $("repairCards").innerHTML = stats.readyCards.length
    ? stats.readyCards.map((card) => `
      <article class="repair-card ${statusClass(card.status)}">
        <div class="repair-card-head">
          <div>
            <span class="eyebrow">${escapeHtml(card.action_id || "repair")}</span>
            <h3>${escapeHtml(card.title || card.summary || t("section.repairs"))}</h3>
          </div>
          <div class="meta">
            ${pill(card.status || "ready")}
            ${card.risk ? pill(`${t("repair.risk")}: ${valueLabel(card.risk)}`, card.risk) : ""}
          </div>
        </div>
        ${card.why_this_helps ? `<div class="text-row"><b>${escapeHtml(t("repair.why"))}</b><span>${escapeHtml(card.why_this_helps)}</span></div>` : ""}
        ${(card.user_steps || []).length ? `<div class="text-row"><b>${escapeHtml(t("repair.userSteps"))}</b><span>${escapeHtml(card.user_steps.join(" · "))}</span></div>` : ""}
        ${(card.codex_can_do || []).length ? `<div class="text-row"><b>${escapeHtml(t("repair.codexCanDo"))}</b><span>${escapeHtml(card.codex_can_do.join(" · "))}</span></div>` : ""}
      </article>
    `).join("")
    : `
      <article class="repair-empty">
        <b>${escapeHtml(t("repair.noCards"))}</b>
        <p>${escapeHtml(t("repair.noCardsDetail"))}</p>
      </article>
    `;
}

function renderVisionPanel() {
  const vision = state.vision || {};
  const questions = vision.questions || [];
  const answerBatches = vision.answerBatches || [];
  const policy = vision.curationPolicy || {};
  const stats = getVisionStats();
  const curator = policy.curator_agent_id || "vision-curator";
  const canSaveAnswers = ["localhost", "127.0.0.1"].includes(window.location.hostname);
  const draftCount = Object.values(state.answerDrafts).filter((value) => String(value || "").trim()).length;
  $("visionCount").textContent = `${stats.totalQuestions} ${t("vision.questions")} · ${stats.answerBatches} ${t("vision.answers")}`;

  const latestQuestions = questions.filter((question) => question.status !== "adopted" && question.status !== "retired").slice(-8).reverse();
  const triggerItems = (policy.wake_triggers || []).slice(0, 6);
  $("visionPanel").innerHTML = `
    <div class="vision-summary">
      <div class="vision-curator-card ${stats.shouldWake ? "wake" : ""}">
        <span class="eyebrow">${escapeHtml(t("vision.curator"))}</span>
        <h3>${escapeHtml(curator)}</h3>
        <div class="meta">
          ${pill(stats.shouldWake ? t("vision.wakeNow") : t("vision.noWake"), stats.shouldWake ? "active" : "standby")}
          ${pill(t("vision.uncurated"), stats.uncurated ? "queued" : "standby")}
        </div>
      </div>
      <div class="vision-stat-grid">
        ${[
          [t("vision.uncurated"), stats.uncurated, "queued"],
          [t("vision.highPriority"), stats.high, stats.high ? "blocked" : "standby"],
          [t("vision.answers"), stats.needsCuration, stats.needsCuration ? "active" : "standby"]
        ].map(([label, value, tone]) => `
          <div class="vision-stat ${tone}">
            <strong>${value}</strong>
            <span>${escapeHtml(label)}</span>
          </div>
        `).join("")}
      </div>
    </div>

    <div class="vision-lists">
      <div>
        <h3>${escapeHtml(t("vision.latest"))}</h3>
        <div class="answer-toolbar">
          <span>${escapeHtml(draftCount ? t("list.showing", { shown: draftCount, total: latestQuestions.length }) : canSaveAnswers ? t("vision.answer") : t("vision.localOnly"))}</span>
          <button type="button" data-action="save-vision-answers" ${canSaveAnswers && draftCount ? "" : "disabled"}>
            ${escapeHtml(state.answerStatus === "saving" ? t("vision.saving") : t("vision.saveAnswers"))}
          </button>
        </div>
        ${state.answerStatus?.message ? `<div class="answer-status ${state.answerStatus.type}">${escapeHtml(state.answerStatus.message)}</div>` : ""}
        <div class="vision-question-list">
          ${latestQuestions.length ? latestQuestions.map((question) => `
            <article class="vision-question ${statusClass(question.status)}">
              <div class="question-head">
                <b>${escapeHtml(question.question_id || "Q?")}</b>
                <span>${pill(question.status || "draft")}${pill(question.priority || "medium")}</span>
              </div>
              <p>${escapeHtml(question.question || "")}</p>
              ${question.why_it_matters ? `<div class="text-row"><b>${escapeHtml(t("vision.why"))}</b><span>${escapeHtml(question.why_it_matters)}</span></div>` : ""}
              ${(question.options || []).length ? `<div class="text-row"><b>${escapeHtml(t("vision.options"))}</b><span>${escapeHtml(question.options.join(" · "))}</span></div>` : ""}
              ${question.status === "ready" ? `
                <label class="answer-field">
                  <span>${escapeHtml(t("vision.answer"))}</span>
                  <textarea data-answer-question-id="${escapeHtml(question.question_id)}" placeholder="${escapeHtml(t("vision.answerPlaceholder"))}">${escapeHtml(state.answerDrafts[question.question_id] || "")}</textarea>
                </label>
              ` : ""}
            </article>
          `).join("") : `<div class="empty">${escapeHtml(t("vision.noQuestions"))}</div>`}
        </div>
      </div>
      <div>
        <h3>${escapeHtml(t("vision.triggers"))}</h3>
        <div class="trigger-list">
          ${triggerItems.length ? triggerItems.map((trigger) => `<span>${escapeHtml(trigger)}</span>`).join("") : `<div class="empty">${escapeHtml(t("vision.noWake"))}</div>`}
        </div>
        <h3 class="answer-heading">${escapeHtml(t("vision.answers"))}</h3>
        <div class="answer-list">
          ${answerBatches.length ? answerBatches.slice(-3).reverse().map((batch) => `
            <div class="answer-batch">
              <b>${escapeHtml(batch.batch_id || "A?")}</b>
              ${pill(batch.status || "unknown")}
              <span>${escapeHtml((batch.question_ids || []).join(", ") || t("task.none"))}</span>
            </div>
          `).join("") : `<div class="empty">${escapeHtml(t("vision.noAnswers"))}</div>`}
        </div>
      </div>
    </div>
  `;
}

function renderVisionPanelV2() {
  const vision = state.vision || {};
  const questions = vision.questions || [];
  const answerBatches = vision.answerBatches || [];
  const policy = vision.curationPolicy || {};
  const stats = getVisionStats();
  const curator = policy.curator_agent_id || "vision-curator";
  const canSaveAnswers = ["localhost", "127.0.0.1"].includes(window.location.hostname);
  const draftCount = Object.values(state.answerDrafts).filter((value) => String(value || "").trim()).length;
  const interactiveQuestions = questions.filter((question) => question.status !== "adopted" && question.status !== "retired");

  if (!interactiveQuestions.some((question) => question.question_id === state.selectedQuestionId)) {
    state.selectedQuestionId = interactiveQuestions[0]?.question_id || null;
  }

  const selectedIndex = Math.max(0, interactiveQuestions.findIndex((question) => question.question_id === state.selectedQuestionId));
  const selectedQuestion = interactiveQuestions[selectedIndex] || null;
  const visibleQuestions = state.showAllQuestions ? interactiveQuestions : interactiveQuestions.slice(0, 12);
  const hiddenQuestionCount = Math.max(0, interactiveQuestions.length - visibleQuestions.length);
  const triggerItems = (policy.wake_triggers || []).slice(0, 6);
  $("visionCount").textContent = `${stats.totalQuestions} ${t("vision.questions")} · ${stats.answerBatches} ${t("vision.answers")}`;

  const questionButtons = visibleQuestions.length ? visibleQuestions.map((question) => {
    const answered = question.status === "answered" || Boolean(state.answerDrafts[question.question_id]?.trim()) || Boolean(question.answer_id);
    const selected = question.question_id === state.selectedQuestionId;
    return `
      <button class="question-nav-item ${selected ? "selected" : ""} ${answered ? "answered" : "unanswered"}" type="button" data-question-id="${escapeHtml(question.question_id)}">
        <span class="question-nav-id">${escapeHtml(question.question_id || "Q?")}</span>
        <span class="question-nav-text">${escapeHtml(question.question || "")}</span>
        <span class="question-nav-state">${escapeHtml(answered ? t("vision.answeredMark") : t("vision.unansweredMark"))}</span>
      </button>
    `;
  }).join("") : `<div class="empty">${escapeHtml(t("vision.noQuestions"))}</div>`;

  $("visionPanel").innerHTML = `
    <div class="vision-summary">
      <div class="vision-curator-card ${stats.shouldWake ? "wake" : ""}">
        <span class="eyebrow">${escapeHtml(t("vision.curator"))}</span>
        <h3>${escapeHtml(curator)}</h3>
        <div class="meta">
          ${pill(stats.shouldWake ? t("vision.wakeNow") : t("vision.noWake"), stats.shouldWake ? "active" : "standby")}
          ${pill(t("vision.uncurated"), stats.uncurated ? "queued" : "standby")}
        </div>
      </div>
      <div class="vision-stat-grid">
        ${[
          [t("vision.uncurated"), stats.uncurated, "queued"],
          [t("vision.highPriority"), stats.high, stats.high ? "blocked" : "standby"],
          [t("vision.answers"), stats.needsCuration, stats.needsCuration ? "active" : "standby"]
        ].map(([label, value, tone]) => `
          <div class="vision-stat ${tone}">
            <strong>${value}</strong>
            <span>${escapeHtml(label)}</span>
          </div>
        `).join("")}
      </div>
    </div>

    <div class="vision-workbench">
      <aside class="question-sidebar">
        <div class="question-sidebar-head">
          <h3>${escapeHtml(t("vision.questionList"))}</h3>
          <span>${escapeHtml(t("list.showing", { shown: visibleQuestions.length, total: interactiveQuestions.length }))}</span>
        </div>
        <div class="question-nav-list ${!state.showAllQuestions && hiddenQuestionCount ? "is-collapsed" : ""}">
          ${questionButtons}
          ${interactiveQuestions.length > 12 ? `
            <div class="list-collapse-control question-collapse-control">
              <span>${escapeHtml(t("list.showing", { shown: visibleQuestions.length, total: interactiveQuestions.length }))}</span>
              <button type="button" data-action="toggle-question-list">
                ${escapeHtml(state.showAllQuestions ? t("list.showLess") : t("list.showMore", { count: hiddenQuestionCount }))}
              </button>
            </div>
          ` : ""}
        </div>
      </aside>

      <section class="answer-workspace">
        <div class="answer-toolbar">
          <span>${escapeHtml(selectedQuestion ? `${selectedQuestion.question_id} · ${selectedIndex + 1}/${interactiveQuestions.length}` : t("vision.noQuestions"))}</span>
          <button type="button" data-action="save-vision-answers" ${canSaveAnswers && draftCount ? "" : "disabled"}>
            ${escapeHtml(state.answerStatus === "saving" ? t("vision.saving") : t("vision.saveAnswers"))}
          </button>
        </div>
        ${state.answerStatus?.message ? `<div class="answer-status ${state.answerStatus.type}">${escapeHtml(state.answerStatus.message)}</div>` : ""}
        ${selectedQuestion ? `
          <article class="vision-question answer-focus ${statusClass(selectedQuestion.status)}">
            <div class="question-head">
              <b>${escapeHtml(selectedQuestion.question_id || "Q?")}</b>
              <span>${pill(selectedQuestion.status || "draft")}${pill(selectedQuestion.priority || "medium")}${pill(selectedQuestion.scope || "project")}</span>
            </div>
            <p>${escapeHtml(selectedQuestion.question || "")}</p>
            ${selectedQuestion.why_it_matters ? `<div class="text-row"><b>${escapeHtml(t("vision.why"))}</b><span>${escapeHtml(selectedQuestion.why_it_matters)}</span></div>` : ""}
            ${(selectedQuestion.options || []).length ? `<div class="text-row"><b>${escapeHtml(t("vision.options"))}</b><span>${escapeHtml(selectedQuestion.options.join(" · "))}</span></div>` : ""}
            ${selectedQuestion.status === "ready" ? `
              <label class="answer-field">
                <span>${escapeHtml(t("vision.answer"))}</span>
                <textarea data-answer-question-id="${escapeHtml(selectedQuestion.question_id)}" placeholder="${escapeHtml(t("vision.answerPlaceholder"))}">${escapeHtml(state.answerDrafts[selectedQuestion.question_id] || "")}</textarea>
              </label>
            ` : `<div class="answer-status success">${escapeHtml(t("vision.answeredMark"))}</div>`}
          </article>
          <div class="question-stepper">
            <button type="button" data-action="previous-question" ${selectedIndex <= 0 ? "disabled" : ""}>${escapeHtml(t("vision.previous"))}</button>
            <button type="button" data-action="next-question" ${selectedIndex >= interactiveQuestions.length - 1 ? "disabled" : ""}>${escapeHtml(t("vision.next"))}</button>
          </div>
        ` : `<div class="empty">${escapeHtml(t("vision.noQuestions"))}</div>`}
      </section>

      <aside class="vision-side-meta">
        <h3>${escapeHtml(t("vision.triggers"))}</h3>
        <div class="trigger-list">
          ${triggerItems.length ? triggerItems.map((trigger) => `<span>${escapeHtml(trigger)}</span>`).join("") : `<div class="empty">${escapeHtml(t("vision.noWake"))}</div>`}
        </div>
        <h3 class="answer-heading">${escapeHtml(t("vision.answers"))}</h3>
        <div class="answer-list">
          ${answerBatches.length ? answerBatches.slice(-3).reverse().map((batch) => `
            <div class="answer-batch">
              <b>${escapeHtml(batch.batch_id || "A?")}</b>
              ${pill(batch.status || "unknown")}
              <span>${escapeHtml((batch.question_ids || []).join(", ") || t("task.none"))}</span>
            </div>
          `).join("") : `<div class="empty">${escapeHtml(t("vision.noAnswers"))}</div>`}
        </div>
      </aside>
    </div>
  `;
}

function getTaskCounts() {
  const total = state.tasks.length;
  const accepted = state.tasks.filter((task) => task.state === "accepted").length;
  const active = state.tasks.filter((task) => task.state === "active").length;
  const blocked = state.tasks.filter((task) => task.state === "blocked" || (task.blocked_by || []).length).length;
  const queued = state.tasks.filter((task) => task.state === "queued").length;
  const review = state.tasks.filter((task) => String(task.state).includes("review")).length;
  return { total, accepted, active, blocked, queued, review };
}

function pct(value, total) {
  if (!total) return 0;
  return Math.round((value / total) * 100);
}

function agentById(agentId) {
  return state.agents.find((agent) => agent.agent_id === agentId);
}

function taskById(taskId) {
  return state.tasks.find((task) => task.task_id === taskId);
}

function initials(value) {
  return String(value || "?")
    .split(/[-_\s]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("") || "?";
}

function inferCommander(task) {
  if (task.owner_agent_id === "orchestrator") return "user";
  return "orchestrator";
}

function collaboratorsFor(task) {
  const ids = new Set();
  for (const depId of task.dependencies || []) {
    const dep = taskById(depId);
    if (dep?.owner_agent_id && dep.owner_agent_id !== task.owner_agent_id) {
      ids.add(dep.owner_agent_id);
    }
  }
  return [...ids];
}

function roleTone(role) {
  const tones = {
    orchestrator: "#111827",
    "visual-art": "#7c5cff",
    implementation: "#2478ff",
    "world-lore": "#21a67a",
    "playtest-qa": "#d58a00",
    "vision-curator": "#00a7b5",
    "error-concierge": "#d58a00",
    "user-liaison": "#2478ff",
    "orquesta-admin": "#69717d",
    session: "#69717d"
  };
  return tones[role] || "#69717d";
}

function sessionThreadId(session) {
  return session.thread_id || session.threadId || session.id || "";
}

function normalizeSession(session) {
  const threadId = sessionThreadId(session);
  return {
    thread_id: threadId,
    title: session.title || threadId,
    status: session.status || "unknown",
    host_id: session.host_id || session.hostId || "",
    cwd: session.cwd || "",
    created_at: session.created_at || session.createdAt || null,
    updated_at: session.updated_at || session.updatedAt || null
  };
}

function codexStatusToAgentStatus(status) {
  if (["active", "running", "working"].includes(status)) return "active";
  if (["idle", "standby", "completed"].includes(status)) return "standby";
  if (["blocked", "failed"].includes(status)) return "blocked";
  return status || "unknown";
}

function sessionUpdatedAt(session) {
  const raw = session.updated_at || session.updatedAt || null;
  if (!raw) return null;
  if (typeof raw === "number") return new Date(raw * 1000).toISOString();
  return raw;
}

function applySessionOverlay(agents, sessions) {
  const registeredAgents = (agents || []).filter((agent) => !(agent.role === "session" && agent.codex_session));
  const normalizedSessions = (sessions || []).map(normalizeSession).filter((session) => session.thread_id);
  const byThreadId = new Map(normalizedSessions.map((session) => [session.thread_id, session]));
  const assignedThreadIds = new Set();

  const linkedAgents = registeredAgents.map((agent) => {
    const direct = agent.thread_id ? byThreadId.get(agent.thread_id) : null;
    const titleMatch = normalizedSessions.find((session) => session.title && session.title.includes(agent.agent_id));
    const session = direct || titleMatch || null;
    if (session) assignedThreadIds.add(session.thread_id);
    return session
      ? {
          ...agent,
          thread_id: agent.thread_id || session.thread_id,
          status: codexStatusToAgentStatus(session.status),
          last_heartbeat: sessionUpdatedAt(session) || agent.last_heartbeat || null,
          codex_session: session
        }
      : agent;
  });

  const unassignedSessions = normalizedSessions
    .filter((session) => !assignedThreadIds.has(session.thread_id))
    .map((session) => ({
      agent_id: `session-${session.thread_id.slice(-6)}`,
      role: "session",
      thread_id: session.thread_id,
      status: codexStatusToAgentStatus(session.status),
      mission: session.title || "Unassigned Codex project session.",
      workspace_path: session.cwd || ".",
      current_task: null,
      context_scope: "unassigned Codex session discovered from the project thread list",
      required_reading: [],
      excluded_context: [],
      allowed_files: [],
      forbidden_actions: [],
      last_heartbeat: sessionUpdatedAt(session),
      artifacts: [],
      codex_session: session
    }));

  return [...linkedAgents, ...unassignedSessions];
}

function rolePod(role) {
  if (role === "visual-art") return "visual";
  if (role === "implementation") return "build";
  if (role === "world-lore") return "world";
  if (role === "playtest-qa") return "qa";
  return "support";
}

function podMeta(podId) {
  const meta = {
    visual: { label: currentLang === "ja" ? "Visual" : "Visual", tone: "#7c5cff" },
    build: { label: currentLang === "ja" ? "Build" : "Build", tone: "#2478ff" },
    world: { label: currentLang === "ja" ? "World" : "World", tone: "#21a67a" },
    qa: { label: currentLang === "ja" ? "QA" : "QA", tone: "#d58a00" },
    support: { label: currentLang === "ja" ? "Support" : "Support", tone: "#69717d" }
  };
  return meta[podId] || meta.support;
}

function taskForAgent(agent) {
  if (agent.current_task) return taskById(agent.current_task);
  return state.tasks.find((task) => task.owner_agent_id === agent.agent_id && task.state === "active") || null;
}

function ownedTasksForAgent(agent) {
  return state.tasks.filter((task) => task.owner_agent_id === agent.agent_id);
}

function hasLiveWork(agent) {
  return agent.status === "active" || Boolean(agent.current_task) || Boolean(taskForAgent(agent));
}

function agentCollaborators(agent) {
  const ids = new Set();
  for (const task of ownedTasksForAgent(agent)) {
    for (const collaboratorId of collaboratorsFor(task)) {
      ids.add(collaboratorId);
    }
  }
  return [...ids];
}

function agentDependencies(agent) {
  const deps = new Set();
  for (const task of ownedTasksForAgent(agent)) {
    for (const dep of task.dependencies || []) {
      deps.add(dep);
    }
  }
  return [...deps];
}

function renderPixelWorker(agent, active) {
  return `
    <div class="pixel-worker ${active ? "working" : ""}" aria-hidden="true">
      <span class="pixel-head"></span>
      <span class="pixel-body"></span>
      <span class="pixel-leg left"></span>
      <span class="pixel-leg right"></span>
      <span class="work-bars"><i></i><i></i><i></i></span>
    </div>
  `;
}

function renderAgentNode(agent, variant = "") {
  const task = taskForAgent(agent);
  const active = hasLiveWork(agent);
  const selected = state.selectedAgentId === agent.agent_id;
  const preview = state.previewAgentId === agent.agent_id;
  const owned = ownedTasksForAgent(agent);
  const linkedSession = Boolean(agent.codex_session);
  return `
    <button class="agent-node ${variant} ${statusClass(agent.status)} ${active ? "has-work" : ""} ${linkedSession ? "session-linked" : ""} ${selected ? "selected" : ""} ${preview ? "preview" : ""}"
      type="button"
      data-agent-id="${escapeHtml(agent.agent_id)}"
      style="--role-color: ${roleTone(agent.role)}">
      ${renderPixelWorker(agent, active)}
      <span class="node-copy">
        <b>${escapeHtml(agent.agent_id)}</b>
        <small>${escapeHtml(valueLabel(agent.role))}</small>
      </span>
      <span class="node-status">
        ${escapeHtml(valueLabel(agent.status || "unknown"))}
        <em>${task ? escapeHtml(task.task_id) : escapeHtml(t("team.noCurrentTask"))}</em>
      </span>
      ${linkedSession ? `<span class="node-session-chip">${escapeHtml(t("team.sessionLinked"))}</span>` : ""}
      <span class="node-count">${owned.length}</span>
    </button>
  `;
}

function buildPods(specialists) {
  const order = ["visual", "build", "world", "qa", "support"];
  const groups = new Map(order.map((podId) => [podId, []]));
  for (const agent of specialists) {
    groups.get(rolePod(agent.role)).push(agent);
  }
  return order
    .map((podId) => ({ podId, agents: groups.get(podId), ...podMeta(podId) }))
    .filter((pod) => pod.agents.length);
}

function podPosition(index, total) {
  const row = index;
  const side = row % 2 === 0 ? -1 : 1;
  if (total === 1) return { x: 310, y: 430, side: 0 };
  return {
    x: 380 + side * 170,
    y: 430 + row * 155,
    side
  };
}

function renderPod(pod, index, total) {
  const visible = pod.agents.slice(0, 3);
  const hiddenCount = Math.max(0, pod.agents.length - visible.length);
  const activeCount = pod.agents.filter(hasLiveWork).length;
  const pos = podPosition(index, total);
  return `
    <section class="agent-pod ${activeCount ? "pod-active" : ""}" data-pod-id="${escapeHtml(pod.podId)}" data-map-node="pod" style="--pod-color: ${pod.tone}; --map-x: ${pos.x}px; --map-y: ${pos.y}px">
      <header class="pod-head">
        <div>
          <b>${escapeHtml(pod.label)}</b>
          <span>${escapeHtml(t("team.podAgents", { count: pod.agents.length }))}</span>
        </div>
        <em>${escapeHtml(t("team.podActive", { count: activeCount }))}</em>
      </header>
      <div class="pod-agent-list">
        ${visible.map((agent) => renderAgentNode(agent, "specialist-node compact-node")).join("")}
        ${hiddenCount ? `<button class="pod-more" type="button">${escapeHtml(t("team.moreAgents", { count: hiddenCount }))}</button>` : ""}
      </div>
    </section>
  `;
}

function shouldShowOnTeamMap(agent) {
  return Boolean(agent.codex_session || agent.thread_id || agent.current_task || agent.status === "active");
}

function renderTeamVisualizer() {
  const agents = state.agents.filter(shouldShowOnTeamMap);
  const orchestrator = agents.find((agent) => agent.agent_id === "orchestrator") || agents[0];
  const orquestaAdmin = agents.find((agent) => agent.agent_id === "orquesta-admin" || agent.role === "orquesta-admin");
  const userLiaison = agents.find((agent) => agent.agent_id === "user-liaison" || agent.role === "user-liaison");
  const visionCurator = agents.find((agent) => agent.agent_id === "vision-curator" || agent.role === "vision-curator");
  const errorConcierge = agents.find((agent) => agent.agent_id === "error-concierge" || agent.role === "error-concierge");
  const supportAgents = [visionCurator, errorConcierge].filter(Boolean);
  const coreAgentIds = new Set([orchestrator?.agent_id, orquestaAdmin?.agent_id, userLiaison?.agent_id, visionCurator?.agent_id, errorConcierge?.agent_id].filter(Boolean));
  const specialists = agents.filter((agent) => !coreAgentIds.has(agent.agent_id));
  const pods = buildPods(specialists);
  const activeCount = agents.filter(hasLiveWork).length;
  if (!agentById(state.selectedAgentId) && orchestrator) {
    state.selectedAgentId = orchestrator.agent_id;
  }

  $("teamCount").textContent = t("count.podsActive", { pods: pods.length, agents: agents.length, active: activeCount });
  const worldHeight = Math.max(820, 500 + pods.length * 155);
  $("teamTree").innerHTML = `
    <div class="map-hud">
      <span>${escapeHtml(t("team.panHint"))}</span>
      <span id="mapZoomReadout">${escapeHtml(t("map.zoom", { zoom: Math.round(state.map.scale * 100) }))}</span>
    </div>
    <div class="org-map-world" id="orgMapWorld" style="--map-x:${state.map.x}px; --map-y:${state.map.y}px; --map-scale:${state.map.scale}; width: 1000px; height: ${worldHeight}px">
      <svg class="team-link-layer" id="teamLinkLayer" aria-hidden="true"></svg>
      <div class="floor-core split-command-core" data-map-node="core">
        <div class="user-node">
          <span class="user-orb">U</span>
          <div>
            <b>${escapeHtml(t("team.user"))}</b>
            <small>${escapeHtml(t("team.userRole"))}</small>
          </div>
        </div>
        ${orquestaAdmin ? renderAgentNode(orquestaAdmin, "admin-node config-node") : ""}
        ${orchestrator ? renderAgentNode(orchestrator, "orchestrator-node core-peer-node") : ""}
        ${userLiaison ? renderAgentNode(userLiaison, "liaison-node core-peer-node") : ""}
        ${supportAgents.length ? `
          <div class="user-support-grid">
            ${visionCurator ? renderAgentNode(visionCurator, "curator-node user-support-node compact-node") : ""}
            ${errorConcierge ? renderAgentNode(errorConcierge, "error-concierge-node user-support-node compact-node") : ""}
          </div>
        ` : ""}
      </div>
      <div class="pod-ring">
        ${pods.map((pod, index) => renderPod(pod, index, pods.length)).join("")}
      </div>
    </div>
  `;

  renderAgentInspector();
  requestAnimationFrame(drawTeamLinks);
}

function pointFor(parentRect, childRect, side) {
  let x = childRect.left - parentRect.left + childRect.width / 2;
  let y = childRect.top - parentRect.top + childRect.height / 2;
  if (side === "top") y = childRect.top - parentRect.top;
  if (side === "bottom") y = childRect.bottom - parentRect.top;
  if (side === "left") x = childRect.left - parentRect.left;
  if (side === "right") x = childRect.right - parentRect.left;
  return { x, y };
}

function linkPath(from, to) {
  const midY = from.y + Math.max(36, (to.y - from.y) * 0.45);
  return `M ${from.x} ${from.y} C ${from.x} ${midY}, ${to.x} ${midY}, ${to.x} ${to.y}`;
}

function branchPath(spine, to) {
  const midX = spine.x + (to.x - spine.x) * 0.55;
  return `M ${spine.x} ${spine.y} C ${midX} ${spine.y}, ${midX} ${to.y}, ${to.x} ${to.y}`;
}

function drawTeamLinks() {
  const stage = $("orgMapWorld");
  const layer = $("teamLinkLayer");
  if (!stage || !layer) return;

  const width = stage.offsetWidth;
  const height = stage.offsetHeight;
  layer.setAttribute("viewBox", `0 0 ${width} ${height}`);
  layer.innerHTML = "";

  const userNode = stage.querySelector(".user-node");
  const adminNode = stage.querySelector(".admin-node");
  const orchestratorNode = stage.querySelector(".orchestrator-node");
  const liaisonNode = stage.querySelector(".liaison-node");
  const curatorNode = stage.querySelector(".curator-node");
  const errorConciergeNode = stage.querySelector(".error-concierge-node");
  if (!userNode || !orchestratorNode) return;

  const links = [];
  const userPoint = { x: 500, y: 104 };
  const adminPoint = { x: 288, y: 112 };
  const orchestratorTop = liaisonNode ? { x: 330, y: 188 } : { x: 500, y: 188 };
  const orchestratorBottom = liaisonNode ? { x: 330, y: 302 } : { x: 500, y: 302 };
  const liaisonTop = { x: 650, y: 188 };
  const liaisonBottom = { x: 650, y: 302 };
  const curatorTop = { x: errorConciergeNode ? 570 : 650, y: 390 };
  const errorTop = { x: 750, y: 390 };
  const userSupportSpine = { x: 650, y: 352 };
  const spineTop = { x: 380, y: 350 };
  const trunkBottom = { x: 500, y: Math.max(350, height - 110) };
  links.push({
    d: linkPath(userPoint, orchestratorTop),
    active: hasLiveWork(agentById(orchestratorNode.dataset.agentId) || {}),
    selected: state.selectedAgentId === orchestratorNode.dataset.agentId,
    color: roleTone("orchestrator")
  });
  if (adminNode) {
    links.push({
      d: `M ${userPoint.x - 118} ${userPoint.y} C ${userPoint.x - 154} ${userPoint.y}, ${adminPoint.x + 48} ${adminPoint.y}, ${adminPoint.x} ${adminPoint.y}`,
      active: hasLiveWork(agentById(adminNode.dataset.agentId) || {}),
      selected: state.selectedAgentId === adminNode.dataset.agentId,
      color: roleTone("orquesta-admin"),
      admin: true
    });
  }
  if (liaisonNode) {
    links.push({
      d: linkPath(userPoint, liaisonTop),
      active: hasLiveWork(agentById(liaisonNode.dataset.agentId) || {}),
      selected: state.selectedAgentId === liaisonNode.dataset.agentId,
      color: roleTone("user-liaison"),
      peer: true
    });
  }
  if (curatorNode) {
    links.push({
      d: `M ${liaisonBottom.x} ${liaisonBottom.y} L ${userSupportSpine.x} ${userSupportSpine.y} C ${userSupportSpine.x} ${curatorTop.y - 22}, ${curatorTop.x} ${curatorTop.y - 22}, ${curatorTop.x} ${curatorTop.y}`,
      active: hasLiveWork(agentById(curatorNode.dataset.agentId) || {}),
      selected: state.selectedAgentId === curatorNode.dataset.agentId,
      color: roleTone("vision-curator"),
      peer: true
    });
  }
  if (errorConciergeNode) {
    links.push({
      d: `M ${liaisonBottom.x} ${liaisonBottom.y} L ${userSupportSpine.x} ${userSupportSpine.y} C ${userSupportSpine.x} ${errorTop.y - 22}, ${errorTop.x} ${errorTop.y - 22}, ${errorTop.x} ${errorTop.y}`,
      active: hasLiveWork(agentById(errorConciergeNode.dataset.agentId) || {}),
      selected: state.selectedAgentId === errorConciergeNode.dataset.agentId,
      color: roleTone("error-concierge"),
      peer: true
    });
  }
  links.push({
    d: `M ${orchestratorBottom.x} ${orchestratorBottom.y} C ${orchestratorBottom.x} ${spineTop.y - 28}, ${spineTop.x} ${spineTop.y - 28}, ${spineTop.x} ${spineTop.y} L ${spineTop.x} ${trunkBottom.y}`,
    active: false,
    selected: false,
    color: "#8c96a3",
    trunk: true
  });

  for (const pod of stage.querySelectorAll(".agent-pod")) {
    const podAgents = [...pod.querySelectorAll("[data-agent-id]")]
      .map((node) => agentById(node.dataset.agentId))
      .filter(Boolean);
    const selected = podAgents.some((agent) => agent.agent_id === state.selectedAgentId);
    const active = podAgents.some(hasLiveWork);
    const tone = pod.style.getPropertyValue("--pod-color") || "#2478ff";
    const podRect = {
      x: parseFloat(pod.style.getPropertyValue("--map-x")) || 500,
      y: parseFloat(pod.style.getPropertyValue("--map-y")) || 360
    };
    const podPoint = {
      x: podRect.x < spineTop.x ? podRect.x + 112 : podRect.x - 112,
      y: podRect.y + 60
    };
    const spinePoint = { x: spineTop.x, y: podPoint.y };
    links.push({
      d: branchPath(spinePoint, podPoint),
      active,
      selected,
      color: tone,
    });
  }

  layer.innerHTML = links.map((link, index) => `
      <path class="team-link ${link.trunk ? "trunk-link" : ""} ${link.peer ? "peer-link" : ""} ${link.admin ? "admin-link" : ""} ${link.active ? "active-link" : ""} ${link.selected ? "selected-link" : ""}"
      d="${link.d}"
      style="--link-color: ${link.color || "#2478ff"}"
      pathLength="1"
      data-link-index="${index}"></path>
  `).join("");
}

function renderAgentInspector() {
  const agent = agentById(state.previewAgentId) || agentById(state.selectedAgentId) || state.agents[0];
  if (!agent) {
    $("agentInspector").innerHTML = $("emptyTemplate").innerHTML;
    return;
  }
  const currentTask = taskForAgent(agent);
  const owned = ownedTasksForAgent(agent);
  const deps = agentDependencies(agent);
  const collaborators = agentCollaborators(agent);
  const session = agent.codex_session || null;
  $("agentInspector").innerHTML = `
    <div class="inspector-head" style="--role-color: ${roleTone(agent.role)}">
      ${renderPixelWorker(agent, hasLiveWork(agent))}
      <div>
        <span class="eyebrow">${escapeHtml(valueLabel(agent.role))}</span>
        <h3>${escapeHtml(agent.agent_id)}</h3>
        <div class="meta">${pill(agent.status || "unknown")}${agent.thread_id ? pill("thread", "active") : ""}</div>
      </div>
    </div>
    <div class="inspector-section">
      <b>${escapeHtml(t("team.currentTask"))}</b>
      <p>${currentTask ? `${escapeHtml(currentTask.task_id)} · ${escapeHtml(currentTask.title)}` : escapeHtml(t("team.noCurrentTask"))}</p>
    </div>
    <div class="inspector-section">
      <b>${escapeHtml(t("agent.mission"))}</b>
      <p>${escapeHtml(agent.mission || "")}</p>
    </div>
    ${session ? `
      <div class="inspector-section">
        <b>${escapeHtml(t("agent.session"))}</b>
        <p>${escapeHtml(session.title || session.thread_id)} · ${escapeHtml(valueLabel(session.status || "unknown"))}</p>
      </div>
    ` : ""}
    <div class="inspector-grid">
      <div>
        <b>${escapeHtml(t("team.ownedTasks"))}</b>
        <p>${owned.length ? owned.map((task) => task.task_id).join(", ") : escapeHtml(t("task.none"))}</p>
      </div>
      <div>
        <b>${escapeHtml(t("team.dependsOn"))}</b>
        <p>${deps.length ? deps.join(", ") : escapeHtml(t("team.noDependencies"))}</p>
      </div>
      <div>
        <b>${escapeHtml(t("team.collaboratesWith"))}</b>
        <p>${collaborators.length ? collaborators.join(", ") : escapeHtml(t("team.noCollaborators"))}</p>
      </div>
    </div>
  `;
}

function applyMapTransform() {
  const world = $("orgMapWorld");
  if (!world) return;
  world.style.setProperty("--map-x", `${state.map.x}px`);
  world.style.setProperty("--map-y", `${state.map.y}px`);
  world.style.setProperty("--map-scale", state.map.scale);
  const readout = $("mapZoomReadout");
  if (readout) readout.textContent = t("map.zoom", { zoom: Math.round(state.map.scale * 100) });
}

function clampMapScale(value) {
  return Math.min(1.7, Math.max(0.45, value));
}

function renderProgressPanel() {
  const counts = getTaskCounts();
  const donePct = pct(counts.accepted, counts.total);
  const activePct = pct(counts.active, counts.total);
  const blockedPct = pct(counts.blocked, counts.total);
  $("progressCount").textContent = counts.total ? t("count.complete", { count: donePct }) : t("count.noTasks");
  $("progressPanel").innerHTML = `
    <div class="progress-ring-row">
      <div class="progress-ring" style="--progress: ${donePct * 3.6}deg">
        <strong>${donePct}%</strong>
      </div>
      <div class="progress-copy">
        <h3>${escapeHtml(t("progress.acceptedOf", { accepted: counts.accepted, total: counts.total }))}</h3>
        <p>${escapeHtml(t("progress.detail", { active: counts.active, queued: counts.queued, blocked: counts.blocked, review: counts.review }))}</p>
      </div>
    </div>
    <div class="progress-bars">
      <div class="bar-row"><span>${escapeHtml(t("progress.accepted"))}</span><div class="bar-track"><div class="bar-fill accepted" style="--fill:${donePct}%"></div></div><span>${counts.accepted}</span></div>
      <div class="bar-row"><span>${escapeHtml(t("progress.active"))}</span><div class="bar-track"><div class="bar-fill active" style="--fill:${activePct}%"></div></div><span>${counts.active}</span></div>
      <div class="bar-row"><span>${escapeHtml(t("progress.blocked"))}</span><div class="bar-track"><div class="bar-fill blocked" style="--fill:${blockedPct}%"></div></div><span>${counts.blocked}</span></div>
    </div>
  `;
}

function renderSync() {
  const chip = $("syncChip");
  if (state.liveSource === "server") {
    chip.textContent = t("sync.server", { time: state.loadedAt || "--:--" });
  } else {
    chip.textContent = state.isLive
      ? t("sync.live", { count: state.loadedFiles.length })
      : t("sync.sample");
  }
  chip.classList.toggle("live", state.isLive);
}

function render() {
  applyLanguage();
  renderViewSwitch();
  renderSync();
  renderAttention();
  renderMetrics();
  renderTeamVisualizer();
  renderProgressPanel();
  renderVisionPanelV2();
  renderUserTaskSummary();
  renderRepairCards();
  $("taskCount").textContent = formatCount("total", state.tasks.length);
  $("directiveCount").textContent = formatCount("total", state.directives.length);
  $("eventCount").textContent = formatCount("total", state.events.length);

  renderCollapsibleList("tasks", state.tasks, (task) => `
    <div class="record ${statusClass(task.state)}">
      <h3>${escapeHtml(task.task_id)} · ${escapeHtml(task.title)}</h3>
      <div class="meta">
        ${pill(task.state || "unknown")}
        ${task.owner_agent_id ? pill(task.owner_agent_id) : pill("unassigned", "queued")}
        ${(task.blocked_by || []).length ? pill("blocked", "blocked") : ""}
      </div>
      <div class="text-row"><b>${escapeHtml(t("task.checks"))}</b><span>${escapeHtml((task.acceptance_checks || []).slice(0, 2).join(" · ") || t("task.none"))}</span></div>
      <div class="text-row"><b>${escapeHtml(t("task.result"))}</b><span>${escapeHtml(task.result_summary || t("task.notAccepted"))}</span></div>
    </div>
  `, { expanded: state.showMoreTasks, limit: 4, toggleAction: "toggle-tasks" });

  renderList("directives", state.directives, (directive) => `
    <div class="record ${statusClass(directive.status)}">
      <h3>${escapeHtml(directive.directive_id)} · ${escapeHtml(directive.agent_id)}</h3>
      <div class="meta">
        ${pill(directive.status || "unknown")}
        ${directive.task_id ? pill(directive.task_id) : ""}
      </div>
      <div class="text">${escapeHtml(directive.summary || "")}</div>
    </div>
  `);

  renderCollapsibleList("events", state.events.slice().reverse(), (event) => `
    <div class="event">
      <div class="event-time">${escapeHtml(shortTime(event.ts))}</div>
      <div>
        <h3>${escapeHtml(event.type || "event")}</h3>
        <div class="text">${escapeHtml(event.summary || "")}</div>
      </div>
    </div>
  `, { expanded: state.showMoreEvents, limit: 6, toggleAction: "toggle-events" });
}

async function readFile(file) {
  const text = await file.text();
  if (file.name.endsWith(".jsonl")) {
    return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  }
  return JSON.parse(text);
}

function mergeState(fileName, data) {
  if (fileName === "agents.json") state.agents = data.agents || [];
  if (fileName === "sessions.json") state.sessions = data.sessions || [];
  if (fileName === "tasks.json") state.tasks = data.tasks || [];
  if (fileName === "directives.json") state.directives = data.directives || [];
  if (fileName === "events.jsonl") state.events = Array.isArray(data) ? data : [];
  if (fileName === "questions.json") {
    state.vision.questions = data.questions || [];
    state.vision.curationPolicy = data.curation_policy || state.vision.curationPolicy || {};
  }
  if (fileName === "answers.json") state.vision.answerBatches = data.answer_batches || [];
  if (fileName === "incidents.json") {
    state.failures.incidents = data.incidents || [];
    state.failures.wakePolicy = data.wake_policy || state.failures.wakePolicy || {};
  }
  if (fileName === "user_actions.json") state.failures.userActions = data.actions || [];
  if (fileName === "queue.json") {
    state.userTasks.tasks = data.tasks || [];
    state.userTasks.policy = data.policy || state.userTasks.policy || {};
  }
  state.agents = applySessionOverlay(state.agents, state.sessions);
}

function mergeLiveState(data) {
  state.sessions = data.sessions || [];
  state.agents = applySessionOverlay(data.agents || [], state.sessions);
  state.tasks = data.tasks || [];
  state.directives = data.directives || [];
  state.events = data.events || [];
  state.vision = {
    questions: data.vision?.questions?.questions || [],
    answerBatches: data.vision?.answers?.answer_batches || [],
    curationPolicy: data.vision?.questions?.curation_policy || {}
  };
  state.failures = {
    incidents: data.failures?.incidents?.incidents || [],
    userActions: data.failures?.userActions?.actions || [],
    wakePolicy: data.failures?.incidents?.wake_policy || {}
  };
  state.userTasks = {
    tasks: data.userTasks?.tasks || [],
    policy: data.userTasks?.policy || {}
  };
  state.loadedFiles = data.loadedFiles || ["agents.json", "sessions.json", "tasks.json", "directives.json", "events.jsonl"];
  state.loadedAt = new Date(data.loadedAt || Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  state.isLive = true;
  state.liveSource = data.source || "server";
  if (!agentById(state.selectedAgentId) && state.agents[0]) {
    state.selectedAgentId = state.agents[0].agent_id;
  }
}

async function refreshServerState() {
  if (!["localhost", "127.0.0.1"].includes(window.location.hostname)) return;
  const response = await fetch("/api/state", { cache: "no-store" });
  if (!response.ok) throw new Error(`state refresh failed: ${response.status}`);
  mergeLiveState(await response.json());
  if (document.activeElement?.matches?.("[data-answer-question-id]")) {
    state.pendingLiveRender = true;
    return;
  }
  render();
}

async function saveVisionAnswers() {
  const answers = Object.entries(state.answerDrafts)
    .map(([question_id, answer]) => ({ question_id, answer: String(answer || "").trim() }))
    .filter((answer) => answer.answer);

  if (!answers.length) {
    state.answerStatus = { type: "error", message: t("vision.noDrafts") };
    renderVisionPanelV2();
    return;
  }

  state.answerStatus = { type: "saving", message: t("vision.saving") };
  renderVisionPanelV2();

  try {
    const response = await fetch("/api/answers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answers })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "save failed");
    for (const answer of answers) {
      delete state.answerDrafts[answer.question_id];
    }
    state.answerStatus = {
      type: "success",
      message: t("vision.saved", { count: result.saved, batch: result.batch_id })
    };
    state.isAnswerEditing = false;
    state.pendingLiveRender = false;
    await refreshServerState();
  } catch (error) {
    state.answerStatus = {
      type: "error",
      message: `${t("vision.saveError")}: ${error.message || error}`
    };
    renderVisionPanelV2();
  }
}

function startServerPolling() {
  if (!["localhost", "127.0.0.1"].includes(window.location.hostname)) return;
  refreshServerState().catch((error) => console.warn(error));
  window.setInterval(() => {
    refreshServerState().catch((error) => console.warn(error));
  }, 5000);
}

$("stateFiles").addEventListener("change", async (event) => {
  const files = [...event.target.files];
  for (const file of files) {
    const data = await readFile(file);
    mergeState(file.name, data);
  }
  state.loadedFiles = files.map((file) => file.name);
  state.loadedAt = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  state.isLive = true;
  state.liveSource = "files";
  render();
});

document.querySelectorAll("[data-view-target]").forEach((button) => {
  button.addEventListener("click", () => {
    state.currentView = button.dataset.viewTarget || "operations";
    render();
  });
});

$("tasks").addEventListener("click", (event) => {
  const button = event.target.closest("[data-action='toggle-tasks']");
  if (!button) return;
  state.showMoreTasks = !state.showMoreTasks;
  render();
});

$("events").addEventListener("click", (event) => {
  const button = event.target.closest("[data-action='toggle-events']");
  if (!button) return;
  state.showMoreEvents = !state.showMoreEvents;
  render();
});

$("visionPanel").addEventListener("input", (event) => {
  const field = event.target.closest("[data-answer-question-id]");
  if (!field) return;
  state.answerDrafts[field.dataset.answerQuestionId] = field.value;
  const navItem = $("visionPanel").querySelector(`[data-question-id="${CSS.escape(field.dataset.answerQuestionId)}"]`);
  if (navItem) {
    const hasDraft = Boolean(String(field.value || "").trim());
    navItem.classList.toggle("answered", hasDraft);
    navItem.classList.toggle("unanswered", !hasDraft);
    const stateLabel = navItem.querySelector(".question-nav-state");
    if (stateLabel) stateLabel.textContent = hasDraft ? t("vision.answeredMark") : t("vision.unansweredMark");
  }
  const button = $("visionPanel").querySelector("[data-action='save-vision-answers']");
  if (button) {
    const hasDrafts = Object.values(state.answerDrafts).some((value) => String(value || "").trim());
    button.disabled = !hasDrafts || !["localhost", "127.0.0.1"].includes(window.location.hostname);
  }
});

$("visionPanel").addEventListener("focusin", (event) => {
  if (!event.target.closest("[data-answer-question-id]")) return;
  state.isAnswerEditing = true;
});

$("visionPanel").addEventListener("focusout", (event) => {
  if (!event.target.closest("[data-answer-question-id]")) return;
  window.setTimeout(() => {
    if (document.activeElement?.matches?.("[data-answer-question-id]")) return;
    state.isAnswerEditing = false;
    if (state.pendingLiveRender) {
      state.pendingLiveRender = false;
      render();
    }
  }, 0);
});

$("visionPanel").addEventListener("click", (event) => {
  const questionNode = event.target.closest("[data-question-id]");
  if (questionNode) {
    state.selectedQuestionId = questionNode.dataset.questionId;
    renderVisionPanelV2();
    return;
  }

  const toggleQuestions = event.target.closest("[data-action='toggle-question-list']");
  if (toggleQuestions) {
    state.showAllQuestions = !state.showAllQuestions;
    renderVisionPanelV2();
    return;
  }

  const previous = event.target.closest("[data-action='previous-question']");
  const next = event.target.closest("[data-action='next-question']");
  if (previous || next) {
    const questions = (state.vision?.questions || []).filter((question) => question.status !== "adopted" && question.status !== "retired");
    const currentIndex = Math.max(0, questions.findIndex((question) => question.question_id === state.selectedQuestionId));
    const nextIndex = previous ? Math.max(0, currentIndex - 1) : Math.min(questions.length - 1, currentIndex + 1);
    state.selectedQuestionId = questions[nextIndex]?.question_id || state.selectedQuestionId;
    renderVisionPanelV2();
    return;
  }

  const button = event.target.closest("[data-action='save-vision-answers']");
  if (!button) return;
  saveVisionAnswers();
});

$("langToggle").addEventListener("click", () => {
  currentLang = currentLang === "ja" ? "en" : "ja";
  localStorage.setItem(LANG_KEY, currentLang);
  render();
});

$("teamTree").addEventListener("click", (event) => {
  const node = event.target.closest("[data-agent-id]");
  if (!node) return;
  state.selectedAgentId = node.dataset.agentId;
  state.previewAgentId = node.dataset.agentId;
  renderTeamVisualizer();
});

$("teamTree").addEventListener("pointerover", (event) => {
  const node = event.target.closest("[data-agent-id]");
  if (!node) return;
  state.previewAgentId = node.dataset.agentId;
  renderAgentInspector();
});

$("teamTree").addEventListener("pointerout", (event) => {
  if (event.relatedTarget && event.currentTarget.contains(event.relatedTarget)) return;
  state.previewAgentId = null;
  renderAgentInspector();
});

$("teamTree").addEventListener("wheel", (event) => {
  event.preventDefault();
  const before = state.map.scale;
  const next = clampMapScale(before * (event.deltaY > 0 ? 0.92 : 1.08));
  const rect = $("teamTree").getBoundingClientRect();
  const mx = event.clientX - rect.left;
  const my = event.clientY - rect.top;
  state.map.x = mx - ((mx - state.map.x) / before) * next;
  state.map.y = my - ((my - state.map.y) / before) * next;
  state.map.scale = next;
  applyMapTransform();
}, { passive: false });

let mapDrag = null;
$("teamTree").addEventListener("pointerdown", (event) => {
  if (event.target.closest("[data-agent-id]")) return;
  mapDrag = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    originX: state.map.x,
    originY: state.map.y
  };
  $("teamTree").setPointerCapture(event.pointerId);
  $("teamTree").classList.add("is-panning");
});

$("teamTree").addEventListener("pointermove", (event) => {
  if (!mapDrag || event.pointerId !== mapDrag.pointerId) return;
  state.map.x = mapDrag.originX + event.clientX - mapDrag.startX;
  state.map.y = mapDrag.originY + event.clientY - mapDrag.startY;
  applyMapTransform();
});

$("teamTree").addEventListener("pointerup", (event) => {
  if (!mapDrag || event.pointerId !== mapDrag.pointerId) return;
  mapDrag = null;
  $("teamTree").classList.remove("is-panning");
});

$("teamTree").addEventListener("pointercancel", () => {
  mapDrag = null;
  $("teamTree").classList.remove("is-panning");
});

window.addEventListener("resize", () => {
  requestAnimationFrame(drawTeamLinks);
});

render();
startServerPolling();
