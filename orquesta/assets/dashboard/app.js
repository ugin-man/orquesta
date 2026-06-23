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
  setup: {
    options: { available_packs: [], enabled_packs: [] },
    wizard: { steps: [], gates: {} },
    projectIntake: { status: "empty" },
    specialistPlan: { status: "not_generated", candidates: [] },
    productionStart: { status: "not_started", activation_requests: [] }
  },
  completionMap: {
    project_title: "",
    status: "draft",
    definition_of_done: "",
    revision_policy: {},
    phases: []
  },
  health: {
    encodingWarnings: []
  },
  reportReviews: [],
  handoffDrafts: [],
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
  liveEtag: null,
  pollTimer: null,
  selectedAgentId: "orchestrator",
  previewAgentId: null,
  showMoreTasks: false,
  showMoreEvents: false,
  currentView: "operations",
  answerDrafts: {},
  answerStatus: null,
  reviewDrafts: {},
  reviewStatus: null,
  reportReviewDrafts: {},
  reportReviewStatus: null,
  handoffStatus: null,
  setupDraft: {},
  setupStatus: null,
  specialistPlanDrafts: {},
  productionStartDrafts: {},
  isSetupEditing: false,
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
        source_agent_id: "vision-curator",
        task_id: "SAMPLE",
        scope: "setup",
        priority: "medium",
        status: "draft",
        question: "プロジェクト説明を保存すると、このプロジェクト専用の質問がここに表示されます。",
        why_it_matters: "質問はプロジェクト説明の後に生成されることを示すため。",
        answer_format: "free_text",
        options: []
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
  },
  setup: {
    options: {
      dashboard_url: "http://127.0.0.1:4177/",
      enabled_packs: ["minimal_core", "vision_alignment"],
      available_packs: [
        { pack_id: "minimal_core", label: "Minimal Core", status: "enabled", description: "Orquesta Admin plus production orchestrator." },
        { pack_id: "vision_alignment", label: "Vision Alignment", status: "enabled", description: "Question curation and answer interpretation." },
        { pack_id: "research_team", label: "Research Team", status: "available", description: "Future external research team." }
      ]
    },
    wizard: {
      status: "ready_for_operation",
      current_step: "operation_ready",
      steps: [
        { step_id: "welcome", title: "ようこそOrquestaへ", summary: "進め方を説明する。", status: "done" },
        { step_id: "project_intake", title: "プロジェクト説明", summary: "作りたいものを説明する。", status: "done" },
        { step_id: "question_gate", title: "必須質問への回答", summary: "質問に答えて方向性を固める。", status: "done" },
        { step_id: "auto_finalize", title: "初期セットアップ自動完了", summary: "初期完成マップと専門AI体制を用意する。", status: "done" },
        { step_id: "operation_ready", title: "運用開始", summary: "必要に応じて後から調整する。", status: "active" }
      ],
      gates: {
        completion_map_requires_user_approval: false,
        completion_map_approved: true,
        setup_autopilot_finalized: true,
        specialist_plan_reviewed: true,
        specialist_plan_approved: true
      }
    },
    projectIntake: {
      status: "submitted",
      project_title: "Orquesta ベータ",
      project_description: "長期的に付き合う専門AIチームをセッション単位で管理するマルチエージェント運用システム。"
    },
    specialistPlan: {
      status: "not_generated",
      candidates: []
    }
  },
  completionMap: {
    project_title: "Orquesta ベータ",
    status: "in_progress",
    definition_of_done: "統括者から専門AIへ作業を割り振り、完了報告を受け、統括者が受理する一連の流れを確認する。",
    revision_policy: {
      review_triggers: ["major_direction_change", "repeated_failure"]
    },
    phases: [
      {
        phase_id: "CM001",
        title: "基盤システム",
        summary: "最低限の基礎AI、ダッシュボード、状態管理を揃える。",
        status: "done",
        owner_agent_id: "orchestrator",
        items: [
          { item_id: "CM001.1", title: "基礎AIが存在している", status: "done" },
          { item_id: "CM001.2", title: "ダッシュボードが状態を読める", status: "done" }
        ]
      },
      {
        phase_id: "CM002",
        title: "案内付き初回セットアップ",
        summary: "READMEを全部読まなくても使い始められる状態にする。",
        status: "in_progress",
        owner_agent_id: "orquesta-admin",
        items: [
          { item_id: "CM002.1", title: "最初の案内を表示する", status: "queued" },
          { item_id: "CM002.2", title: "プロジェクト説明の入口を用意する", status: "queued" }
        ]
      }
    ]
  }
};

Object.assign(state, sample);

const $ = (id) => document.getElementById(id);
const LANG_KEY = "orquesta.dashboard.lang";
const savedLang = localStorage.getItem(LANG_KEY);
let currentLang = savedLang || ((navigator.language || "").toLowerCase().startsWith("ja") ? "ja" : "en");

const dictionary = {
  en: {
    "brand.subtitle": "Production command board for long-lived Codex teammates",
    "load.button": "Load state",
    "load.title": "Load Orquesta state files, including agents.json, tasks.json, events.jsonl, and completion_map.json",
    "view.operations": "Operations",
    "view.setup": "Setup",
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
    "eyebrow.completion": "completion",
    "eyebrow.setup": "setup",
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
    "section.completionMap": "Completion Map",
    "section.setupWizard": "First Setup Wizard",
    "section.vision": "Vision Questions",
    "section.userTasks": "User Tasks",
    "section.repairs": "Repair Cards",
    "user.readyQuestions": "Questions to answer",
    "user.reviewDirectives": "Reviews needed",
    "user.blockedTasks": "Blocked asks",
    "user.repairCards": "Repair cards",
    "user.liaisonTasks": "Liaison tasks",
    "user.visionReviews": "Vision reviews",
    "user.reportReviews": "Specialist reports",
    "user.handoffDrafts": "Handoff drafts",
    "user.approvalWaits": "Approval waits",
    "user.noTasks": "Nothing needs you right now",
    "user.noTasksDetail": "The AI team has no user-side action queued.",
    "user.questionsDetail": "Ready Vision Alignment questions waiting for your answers.",
    "user.reviewDetail": "Directives or specialist updates waiting for your decision.",
    "user.blockedDetail": "Tasks that need user input before the team can continue.",
    "user.repairsDetail": "Environment or permission fixes proposed by the Failure Concierge.",
    "user.liaisonDetail": "Accepted user-side work sequenced by the User Liaison.",
    "user.visionReviewDetail": "Answer interpretations waiting for your adoption decision.",
    "user.reportReviewDetail": "Specialist completion reports waiting for orchestrator acceptance.",
    "user.handoffDraftDetail": "Copy-ready prompts for sending work or revisions to specialist threads.",
    "user.approvalWaitDetail": "Specialists waiting for your Codex approval or permission decision.",
    "approval.title": "Approval wait",
    "approval.type": "Approval",
    "approval.agent": "Waiting agent",
    "approval.task": "Blocked task",
    "approval.reason": "Reason",
    "approval.requestedAction": "Requested action",
    "approval.resume": "Resume after approval",
    "approval.codex_safety_approval": "Codex approval",
    "approval.scope_expansion_approval": "Scope approval",
    "approval.destructive_action_approval": "Destructive action approval",
    "approval.environment_permission_approval": "Environment permission",
    "approval.user_direction_approval": "User direction",
    "handoff.title": "Thread handoff draft",
    "handoff.empty": "No handoff drafts waiting",
    "handoff.emptyDetail": "Prepared production tasks and requested revisions will appear here as copy-ready prompts.",
    "handoff.agent": "Agent",
    "handoff.thread": "Thread",
    "handoff.mode": "Mode",
    "handoff.prompt": "Prompt",
    "handoff.copy": "Copy prompt",
    "handoff.copied": "Handoff prompt copied",
    "handoff.copyError": "Could not copy handoff prompt",
    "report.title": "Specialist report review",
    "report.empty": "No specialist reports waiting",
    "report.emptyDetail": "Submitted specialist reports will appear here before they are accepted or sent back.",
    "report.agent": "Agent",
    "report.file": "Report",
    "report.excerpt": "Excerpt",
    "report.result": "Result",
    "report.note": "Orchestrator note",
    "report.notePlaceholder": "Optional: acceptance summary, revision request, or reason for holding.",
    "report.accept": "Accept report",
    "report.request_changes": "Request changes",
    "report.hold": "Hold for review",
    "report.save": "Save report review",
    "report.saved": "Report review saved",
    "report.saveError": "Could not save report review",
    "report.choose": "Choose a report review decision.",
    "review.title": "Review before adoption",
    "review.batch": "Answer batch",
    "review.prompt": "Prompt",
    "review.seeds": "Discussion seeds",
    "review.signals": "Strong signals",
    "review.questions": "Needs review",
    "review.note": "Your note",
    "review.notePlaceholder": "Optional: what should change before Orquesta adopts this?",
    "review.save": "Save review",
    "review.localOnly": "Review saving works from the localhost dashboard.",
    "review.saved": "Review saved",
    "review.saveError": "Could not save review",
    "review.choose": "Choose a review decision.",
    "review.keep_as_is": "Keep as-is",
    "review.revise": "Revise",
    "review.reject": "Reject",
    "review.ask_orquesta_for_alternatives": "Ask Orquesta for alternatives",
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
    "attention.encoding.title": "{count} encoding warnings in state files",
    "attention.encoding.text": "Some Orquesta state text may be garbled. Run npm run check:encoding and inspect the listed files.",
    "metric.agents": "Agents",
    "metric.tasks": "Tasks",
    "metric.blocked": "Blocked",
    "metric.review": "Review",
    "metric.vision": "Vision",
    "metric.sessions": "Sessions",
    "metric.completion": "Map",
    "metric.agents.detail": "{active} active · {standby} standby",
    "metric.tasks.detail": "{active} active · {accepted} accepted",
    "metric.blocked.detail": "hard stops",
    "metric.review.detail": "directives + stale",
    "metric.vision.detail": "{ready} ready · {draft} draft",
    "metric.sessions.detail": "{linked} linked · {unassigned} unassigned",
    "metric.completion.detail": "{done} done · {active} active",
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
    "completion.definition": "Definition of done",
    "completion.remaining": "{count} remaining",
    "completion.done": "{count} done",
    "completion.current": "Current focus",
    "completion.revision": "Revision triggers",
    "completion.noMap": "No completion map yet",
    "completion.noMapDetail": "After project intake, Orquesta will generate the big pieces needed to finish the project.",
    "completion.noItems": "No milestone items recorded",
    "completion.owner": "Owner",
    "setup.welcome": "Welcome",
    "setup.current": "Current step",
    "setup.autopilot": "Autopilot setup",
    "setup.operationReady": "Ready",
    "setup.autopilotDetail": "Describe the project, answer generated questions, then Orquesta prepares the initial map and team automatically.",
    "setup.readyForOperation": "Ready for operation",
    "setup.readyForOperationDetail": "Initial setup is complete. Adjust the map, team, or priorities during normal operations.",
    "setup.autopilotDone": "Autopilot done",
    "setup.autopilotWaiting": "Waiting",
    "setup.answerQuestions": "Answer questions",
    "setup.finalizeAutopilot": "Finalize initial setup",
    "setup.finalized": "Initial setup finalized",
    "setup.finalizeError": "Could not finalize setup",
    "setup.finishedTitle": "Orquesta is ready",
    "setup.finishedDetail": "The initial Completion Map and specialist team are prepared. You can now steer changes from normal operations.",
    "setup.generateAfterIntake": "Project description is saved. Generate project-specific questions next.",
    "setup.answerQuestionsFirst": "Answer the generated setup questions. After that, Orquesta finalizes setup automatically.",
    "setup.readyToFinalize": "Questions are answered. Orquesta can finalize the initial map and team automatically.",
    "setup.intakeBeforeQuestions": "Describe the project first. Orquesta will generate project-specific questions after that.",
    "setup.project": "Project intake",
    "setup.projectTitle": "Project title",
    "setup.projectDescription": "Project description",
    "setup.projectPlaceholder": "Describe what you want to make, what matters, and what should be avoided.",
    "setup.saveProject": "Save project description",
    "setup.generateQuestions": "Generate required questions",
    "setup.approveMap": "Approve Completion Map",
    "setup.approvedMap": "Completion Map approved",
    "setup.generateSpecialists": "Generate specialist candidates",
    "setup.saveSpecialistPlan": "Save specialist decisions",
    "setup.specialistPlan": "Specialist candidates",
    "setup.specialistPlanDetail": "Choose which specialists should be available for the next production step. This does not create new sessions.",
    "setup.specialistPlanEmpty": "No specialist candidates generated yet.",
    "setup.specialistGenerated": "Generated {count} specialist candidates",
    "setup.specialistReviewed": "Saved {count} specialist decisions",
    "setup.specialistError": "Could not save specialist plan",
    "setup.productionStart": "Production start",
    "setup.productionStartDetail": "Prepare first handoff tasks for approved specialists. This does not create sessions or send messages.",
    "setup.productionStartEmpty": "Approve specialist candidates before preparing production handoffs.",
    "setup.prepareProduction": "Prepare handoff tasks",
    "setup.productionPrepared": "Prepared {count} handoff tasks",
    "setup.productionError": "Could not prepare production start",
    "setup.handoffReady": "Handoff ready",
    "setup.handoffPrepared": "Handoff prepared",
    "setup.handoffSent": "Sent by orchestrator",
    "setup.handoffAccepted": "Report accepted",
    "setup.productionLocked": "Handoff tasks already prepared",
    "setup.noSessionsCreated": "No session created",
    "setup.productionLegend": "Status legend",
    "setup.legendSelected": "Selected before preparation",
    "setup.legendPrepared": "Task prepared; orchestrator still needs to send",
    "setup.legendSent": "Sent to the specialist thread",
    "setup.legendAccepted": "Specialist report accepted",
    "setup.selectForHandoff": "Select for handoff",
    "setup.waitForLater": "Keep waiting",
    "setup.noThreadMessage": "No thread message sent",
    "setup.approveNow": "Approve for next step",
    "setup.later": "Later",
    "setup.reject": "Do not use",
    "setup.revise": "Revise",
    "setup.reuse": "Reuse existing agent",
    "setup.newAgent": "New agent candidate",
    "setup.scope": "Scope",
    "setup.reading": "Reading",
    "setup.deferred": "Deferred topics",
    "setup.next": "Next",
    "setup.enabledPacks": "Enabled packs",
    "setup.availablePacks": "Available packs",
    "setup.gates": "Setup gates",
    "setup.dashboard": "Dashboard",
    "setup.localOnly": "Saving works from the localhost dashboard.",
    "setup.noSteps": "No setup steps recorded",
    "setup.saved": "Project description saved",
    "setup.saveError": "Could not save setup",
    "setup.approveError": "Could not approve Completion Map",
    "setup.noDescription": "Write a project description before saving.",
    "setup.readyForSpecialists": "Ready to plan specialists from the approved map.",
    "setup.questionsReady": "{count} required questions ready",
    "setup.questionsAnswered": "{answered}/{total} required questions answered",
    "setup.questionsGenerated": "Generated {count} required questions",
    "setup.generateError": "Could not generate questions",
    "setup.mapBlockedByQuestions": "Answer required questions before approving the Completion Map.",
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
    "value.in-progress": "in progress",
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
    "load.title": "agents.json, tasks.json, events.jsonl, completion_map.json などを読み込む",
    "eyebrow.attention": "注目",
    "eyebrow.progress": "進行",
    "eyebrow.now": "稼働中",
    "eyebrow.chain": "指揮系統",
    "eyebrow.team": "チーム",
    "eyebrow.teamMap": "チーム図",
    "eyebrow.work": "作業",
    "eyebrow.intent": "意図",
    "eyebrow.timeline": "履歴",
    "eyebrow.completion": "完成",
    "section.progress": "作業進行度",
    "section.running": "現在稼働中",
    "section.command": "指揮マップ",
    "section.roster": "専門AI一覧",
    "section.teamVisualizer": "チームビジュアライザー",
    "section.tasks": "タスク進行",
    "section.directives": "ユーザー指示",
    "section.events": "最近のイベント",
    "section.completionMap": "完成マップ",
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
    "attention.encoding.title": "状態ファイルに{count}件の文字化け警告があります",
    "attention.encoding.text": "Orquestaの状態テキストが壊れている可能性があります。npm run check:encoding を実行して対象ファイルを確認してください。",
    "metric.agents": "AI",
    "metric.tasks": "タスク",
    "metric.blocked": "停止",
    "metric.review": "確認",
    "metric.sessions": "セッション",
    "metric.completion": "完成",
    "metric.agents.detail": "稼働 {active} · 待機 {standby}",
    "metric.tasks.detail": "進行 {active} · 完了 {accepted}",
    "metric.blocked.detail": "作業停止要因",
    "metric.review.detail": "指示 + stale",
    "metric.sessions.detail": "紐付き {linked} · 未任命 {unassigned}",
    "metric.completion.detail": "完了 {done} · 進行 {active}",
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
    "completion.definition": "完成条件",
    "completion.remaining": "残り {count}件",
    "completion.done": "完了 {count}件",
    "completion.current": "現在の焦点",
    "completion.revision": "見直し条件",
    "completion.noMap": "完成マップはまだありません",
    "completion.noMapDetail": "プロジェクト説明後に、Orquestaが完成に必要な大項目を作ります。",
    "completion.noItems": "項目未記録",
    "completion.owner": "担当",
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
    "value.in-progress": "進行中",
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
  "view.setup": "セットアップ",
  "view.userTasks": "ユーザータスク",
  "eyebrow.userTasks": "あなたの席",
  "eyebrow.repairs": "修理",
  "eyebrow.setup": "セットアップ",
  "section.userTasks": "ユーザータスク",
  "section.repairs": "修理カード",
  "section.setupWizard": "初回セットアップ",
  "user.readyQuestions": "回答待ち質問",
  "user.reviewDirectives": "確認待ち",
  "user.blockedTasks": "相談待ち",
  "user.repairCards": "修理カード",
  "user.liaisonTasks": "窓口タスク",
  "user.visionReviews": "回答レビュー",
  "user.reportReviews": "専門AI報告",
  "user.handoffDrafts": "ハンドオフ文面",
  "user.approvalWaits": "承認待ち",
  "user.noTasks": "今あなた待ちの作業はありません",
  "user.noTasksDetail": "AIチーム側に、ユーザーが今すぐ対応する項目はありません。",
  "user.questionsDetail": "回答できる Vision Alignment 質問です。",
  "user.reviewDetail": "判断や確認が必要な指示・専門AI更新です。",
  "user.blockedDetail": "ユーザー入力がないと進めにくいタスクです。",
  "user.repairsDetail": "Failure Concierge が提案した、環境・権限まわりのユーザー側対応です。",
  "user.liaisonDetail": "User Liaison が整理した、ユーザー側で対応する作業です。",
  "user.visionReviewDetail": "回答の解釈を採用前に見直す項目です。",
  "user.reportReviewDetail": "専門AIの完了報告を、統括者が受理するか差し戻すか確認します。",
  "user.handoffDraftDetail": "専門AIスレッドへ送る作業依頼や差し戻し依頼の文面です。",
  "user.approvalWaitDetail": "専門AIが Codex の承認や権限判断を待っている項目です。",
  "approval.title": "承認待ち",
  "approval.type": "承認種別",
  "approval.agent": "待機中のAI",
  "approval.task": "停止中タスク",
  "approval.reason": "理由",
  "approval.requestedAction": "ユーザー側でやること",
  "approval.resume": "承認後の再開指示",
  "approval.codex_safety_approval": "Codex承認",
  "approval.scope_expansion_approval": "範囲拡張の承認",
  "approval.destructive_action_approval": "破壊的操作の承認",
  "approval.environment_permission_approval": "環境・権限の承認",
  "approval.user_direction_approval": "方針判断",
  "handoff.title": "スレッド用ハンドオフ文面",
  "handoff.empty": "送信待ちのハンドオフ文面はありません",
  "handoff.emptyDetail": "準備済み制作タスクや差し戻しが発生すると、コピー可能な文面として表示されます。",
  "handoff.agent": "担当AI",
  "handoff.thread": "スレッド",
  "handoff.mode": "種別",
  "handoff.prompt": "文面",
  "handoff.copy": "文面をコピー",
  "handoff.copied": "ハンドオフ文面をコピーしました",
  "handoff.copyError": "ハンドオフ文面をコピーできませんでした",
  "report.title": "専門AI報告レビュー",
  "report.empty": "確認待ちの専門AI報告はありません",
  "report.emptyDetail": "専門AIが完了報告を出すと、受理または差し戻し前にここへ表示されます。",
  "report.agent": "担当AI",
  "report.file": "報告書",
  "report.excerpt": "抜粋",
  "report.result": "結果",
  "report.note": "統括メモ",
  "report.notePlaceholder": "任意: 受理理由、差し戻し内容、保留理由を書く",
  "report.accept": "報告を受理",
  "report.request_changes": "差し戻す",
  "report.hold": "保留する",
  "report.save": "報告レビューを保存",
  "report.saved": "報告レビューを保存しました",
  "report.saveError": "報告レビューを保存できませんでした",
  "report.choose": "報告レビューの判断を選んでください。",
  "review.title": "採用前レビュー",
  "review.batch": "回答バッチ",
  "review.prompt": "確認内容",
  "review.seeds": "議論の種",
  "review.signals": "強いシグナル",
  "review.questions": "確認したいこと",
  "review.note": "メモ",
  "review.notePlaceholder": "任意: 採用前にどう直したいかを書く",
  "review.save": "レビューを保存",
  "review.localOnly": "レビュー保存は localhost のダッシュボードで使えます。",
  "review.saved": "レビューを保存しました",
  "review.saveError": "レビューを保存できませんでした",
  "review.choose": "レビュー判断を選んでください。",
  "review.keep_as_is": "このまま採用",
  "review.revise": "書き換えて採用",
  "review.reject": "採用しない",
  "review.ask_orquesta_for_alternatives": "Orquestaに代案を出させる",
  "repair.noCards": "待機中の修理カードはありません",
  "repair.noCardsDetail": "環境、権限、品質劣化回避に関わるユーザー対応が必要になったらここに表示されます。",
  "repair.why": "理由",
  "repair.userSteps": "ユーザー側でやること",
  "repair.codexCanDo": "Codex側でできること",
  "repair.risk": "リスク",
  "list.showMore": "すべて表示 {count}件",
  "list.showLess": "折りたたむ",
  "list.showing": "{total}件中 {shown}件を表示",
    "setup.welcome": "ようこそ",
    "setup.current": "現在の段階",
    "setup.autopilot": "自動初期化",
    "setup.operationReady": "運用開始",
    "setup.autopilotDetail": "プロジェクト説明と質問回答が終わると、Orquestaが初期完成マップと専門AI体制を自動で用意します。",
    "setup.readyForOperation": "運用準備完了",
    "setup.readyForOperationDetail": "初期セットアップは完了しています。体制、完成マップ、優先順位は運用中に調整できます。",
    "setup.autopilotDone": "自動完了済み",
    "setup.autopilotWaiting": "待機中",
    "setup.answerQuestions": "質問に答える",
    "setup.finalizeAutopilot": "初期セットアップを完了",
    "setup.finalized": "初期セットアップを完了しました",
    "setup.finalizeError": "初期セットアップを完了できませんでした",
    "setup.finishedTitle": "Orquestaは運用できます",
    "setup.finishedDetail": "初期完成マップと専門AI体制は用意済みです。ここから先は通常運用として調整できます。",
    "setup.generateAfterIntake": "プロジェクト説明は保存済みです。次に、このプロジェクト専用の質問を生成します。",
    "setup.answerQuestionsFirst": "生成された質問に答えてください。回答後、Orquestaが初期セットアップを自動完了します。",
    "setup.readyToFinalize": "質問回答は完了しています。Orquestaが初期完成マップと専門AI体制を自動で用意できます。",
    "setup.intakeBeforeQuestions": "まずプロジェクトを説明してください。その後、このプロジェクト専用の質問を生成します。",
    "setup.project": "プロジェクト説明",
  "setup.projectTitle": "プロジェクト名",
  "setup.projectDescription": "プロジェクト説明",
  "setup.projectPlaceholder": "作りたいもの、重視したい体験、避けたい方向性を書く",
  "setup.saveProject": "プロジェクト説明を保存",
  "setup.generateQuestions": "必須質問を生成",
  "setup.approveMap": "完成マップを承認",
  "setup.approvedMap": "完成マップ承認済み",
  "setup.generateSpecialists": "専門AI候補を生成",
  "setup.saveSpecialistPlan": "専門AI判断を保存",
  "setup.specialistPlan": "専門AI候補",
  "setup.specialistPlanDetail": "次の制作段階で使う専門AIを選びます。ここでは新しいセッションは作成しません。",
  "setup.specialistPlanEmpty": "専門AI候補はまだ生成されていません。",
  "setup.specialistGenerated": "{count}件の専門AI候補を生成しました",
  "setup.specialistReviewed": "{count}件の専門AI判断を保存しました",
  "setup.specialistError": "専門AI計画を保存できませんでした",
  "setup.productionStart": "制作開始",
  "setup.productionStartDetail": "承認済み専門AIに最初のハンドオフタスクを準備します。セッション作成やメッセージ送信は行いません。",
  "setup.productionStartEmpty": "制作開始の前に専門AI候補を承認してください。",
  "setup.prepareProduction": "ハンドオフタスクを準備",
  "setup.productionPrepared": "{count}件のハンドオフタスクを準備しました",
  "setup.productionError": "制作開始を準備できませんでした",
  "setup.handoffReady": "ハンドオフ準備済み",
  "setup.handoffPrepared": "ハンドオフ準備済み",
  "setup.handoffSent": "統括者から送信済み",
  "setup.handoffAccepted": "報告受理済み",
  "setup.productionLocked": "ハンドオフタスクは準備済み",
  "setup.noSessionsCreated": "セッション作成なし",
  "setup.productionLegend": "状態の見方",
  "setup.legendSelected": "準備前に選択されている状態",
  "setup.legendPrepared": "タスクは準備済み。統括者の送信待ち",
  "setup.legendSent": "専門AIスレッドへ送信済み",
  "setup.legendAccepted": "専門AIの報告を受理済み",
  "setup.selectForHandoff": "ハンドオフ対象",
  "setup.waitForLater": "待機のまま",
  "setup.noThreadMessage": "スレッド送信なし",
  "setup.approveNow": "次に使う",
  "setup.later": "後で",
  "setup.reject": "使わない",
  "setup.revise": "見直し",
  "setup.reuse": "既存AIを再利用",
  "setup.newAgent": "新規AI候補",
  "setup.scope": "担当範囲",
  "setup.reading": "読むもの",
  "setup.deferred": "後で研究",
  "setup.next": "次に進む",
  "setup.enabledPacks": "有効な機能",
  "setup.availablePacks": "追加できる機能",
  "setup.gates": "セットアップ条件",
  "setup.dashboard": "ダッシュボード",
  "setup.localOnly": "保存はlocalhostのダッシュボードで使えます。",
  "setup.noSteps": "セットアップ段階はまだ記録されていません",
  "setup.saved": "プロジェクト説明を保存しました",
  "setup.saveError": "セットアップを保存できませんでした",
  "setup.approveError": "完成マップを承認できませんでした",
  "setup.noDescription": "保存する前にプロジェクト説明を書いてください。",
  "setup.readyForSpecialists": "承認済みの完成マップをもとに、専門AI編成へ進めます。",
  "setup.questionsReady": "必須質問 {count}件が回答待ちです",
  "setup.questionsAnswered": "必須質問 {total}件中 {answered}件回答済み",
  "setup.questionsGenerated": "必須質問を{count}件生成しました",
  "setup.generateError": "質問を生成できませんでした",
  "setup.mapBlockedByQuestions": "完成マップを承認する前に、必須質問へ回答してください。"
});

Object.assign(dictionary.en, {
  "completion.trigger.major-direction-change": "major direction change",
  "completion.trigger.user-changes-project-goal": "user changes project goal",
  "completion.trigger.repeated-failure": "repeated failure",
  "completion.trigger.completion-item-no-longer-matches-project": "completion item no longer matches",
  "completion.trigger.new-required-surface-discovered": "new required surface discovered"
});

Object.assign(dictionary.ja, {
  "completion.trigger.major-direction-change": "大きな方向転換",
  "completion.trigger.user-changes-project-goal": "ユーザーが目的を変更した",
  "completion.trigger.repeated-failure": "同種の失敗が繰り返された",
  "completion.trigger.completion-item-no-longer-matches-project": "完成項目が現在の企画と合わなくなった",
  "completion.trigger.new-required-surface-discovered": "新しく必要な画面や機能が見つかった"
});

function t(key, vars = {}, fallback = key) {
  const template = dictionary[currentLang]?.[key] ?? dictionary.en[key] ?? fallback;
  return template.replace(/\{(\w+)\}/g, (_, name) => vars[name] ?? "");
}

function valueLabel(value, vars = {}) {
  const key = String(value || "unknown").toLowerCase().replaceAll("_", "-").replace(/\s+/g, "-");
  return t(`value.${key}`, vars, value);
}

function completionTriggerLabel(value) {
  const key = String(value || "unknown").toLowerCase().replaceAll("_", "-").replace(/\s+/g, "-");
  return t(`completion.trigger.${key}`, {}, value);
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
  const encodingWarnings = state.health?.encodingWarnings || [];
  return { blockedTasks, activeTasks, reviewDirectives, activeAgents, staleAgents, encodingWarnings };
}

function renderAttention() {
  const { blockedTasks, activeTasks, reviewDirectives, staleAgents, encodingWarnings } = getSignals();
  let title = t("attention.ready.title");
  let text = t("attention.ready.text");
  const actions = [];

  if (encodingWarnings.length) {
    title = t("attention.encoding.title", { count: encodingWarnings.length });
    text = encodingWarnings.slice(0, 3).map((warning) => `${warning.file}: ${warning.kind}`).join(" · ") || t("attention.encoding.text");
    actions.push(pill("Encoding", "blocked"));
  } else if (blockedTasks.length) {
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
  const completion = completionMapCounts();
  $("metrics").innerHTML = [
    [t("metric.agents"), state.agents.length, t("metric.agents.detail", { active: activeAgents.length, standby })],
    [t("metric.sessions"), state.sessions.length, t("metric.sessions.detail", { linked: linkedSessions, unassigned: unassignedSessions })],
    [t("metric.tasks"), state.tasks.length, t("metric.tasks.detail", { active: activeTasks.length, accepted })],
    [t("metric.blocked"), blockedTasks.length, t("metric.blocked.detail")],
    [t("metric.review"), reviewDirectives.length + staleAgents.length, t("metric.review.detail")],
    [t("metric.vision"), visionStats.totalQuestions, t("metric.vision.detail", { ready: visionStats.ready, draft: visionStats.draft })],
    [t("metric.completion"), `${completion.percent}%`, t("metric.completion.detail", { done: completion.done, active: completion.active })]
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
  const openUserTasks = (state.userTasks?.tasks || []).filter((task) => !["resolved", "skipped", "retired"].includes(String(task.status || "").toLowerCase()));
  const approvalWaits = openUserTasks.filter((task) => task.source === "approval_wait");
  const visionReviewTasks = openUserTasks.filter((task) => task.source === "vision_answer_review");
  const liaisonTasks = openUserTasks.filter((task) => !["approval_wait", "vision_answer_review"].includes(task.source));
  const reportReviews = state.reportReviews || [];
  const handoffDrafts = state.handoffDrafts || [];
  return {
    readyQuestions,
    reviewDirectives,
    blockedTasks,
    repairCards,
    approvalWaits,
    visionReviewTasks,
    liaisonTasks,
    reportReviews,
    handoffDrafts,
    total: readyQuestions.length + reviewDirectives.length + blockedTasks.length + repairCards.length + approvalWaits.length + visionReviewTasks.length + liaisonTasks.length + reportReviews.length + handoffDrafts.length
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
  const availableViews = new Set([...document.querySelectorAll("[data-view-target]")].map((button) => button.dataset.viewTarget));
  if (!availableViews.has(state.currentView)) state.currentView = "operations";
  document.querySelectorAll("[data-view-target]").forEach((button) => {
    const active = button.dataset.viewTarget === state.currentView;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  document.querySelectorAll("[data-view-panel]").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.viewPanel === state.currentView);
  });
}

function reviewChoiceLabel(choice) {
  return t(`review.${choice}`) || valueLabel(choice);
}

function batchForReviewTask(task) {
  const batchId = (task.source_ids || [])[0];
  return (state.vision?.answerBatches || []).find((batch) => batch.batch_id === batchId) || null;
}

function renderReviewList(title, items) {
  return (items || []).length
    ? `
      <div class="review-list-block">
        <b>${escapeHtml(title)}</b>
        <ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
      </div>
    `
    : "";
}

function renderVisionReviewTasks(tasks) {
  const canSave = ["localhost", "127.0.0.1"].includes(window.location.hostname);
  if (!tasks.length) return "";

  return `
    <section class="vision-review-board">
      <div class="section-title compact-title">
        <div>
          <span class="eyebrow">${escapeHtml(t("review.title"))}</span>
          <h3>${escapeHtml(t("user.visionReviews"))}</h3>
        </div>
      </div>
      ${state.reviewStatus?.message ? `<div class="answer-status ${escapeHtml(state.reviewStatus.type || "")}">${escapeHtml(state.reviewStatus.message)}</div>` : ""}
      ${tasks.map((task) => {
        const batch = batchForReviewTask(task);
        const draft = state.reviewDrafts[task.user_task_id] || {};
        const choices = task.review_choices || ["keep_as_is", "revise", "reject", "ask_orquesta_for_alternatives"];
        return `
          <article class="vision-review-card ${statusClass(task.status)}">
            <div class="review-card-head">
              <div>
                <span class="eyebrow">${escapeHtml(task.user_task_id || "review")}</span>
                <h3>${escapeHtml(task.title || t("review.title"))}</h3>
              </div>
              <div class="meta">
                ${pill(task.status || "ready")}
                ${batch ? pill(`${t("review.batch")}: ${batch.batch_id}`, batch.status || "queued") : ""}
              </div>
            </div>
            ${task.prompt ? `<div class="text-row"><b>${escapeHtml(t("review.prompt"))}</b><span>${escapeHtml(task.prompt)}</span></div>` : ""}
            ${batch ? `
              ${renderReviewList(t("review.seeds"), batch.discussion_seeds || [])}
              ${renderReviewList(t("review.signals"), batch.strong_signals || [])}
              ${renderReviewList(t("review.questions"), batch.needs_user_review || [])}
            ` : `<div class="answer-status error">${escapeHtml(t("vision.noAnswers"))}</div>`}
            <div class="review-choice-grid" role="radiogroup" aria-label="${escapeHtml(t("review.title"))}">
              ${choices.map((choice) => `
                <button type="button" class="${draft.decision === choice ? "selected" : ""}" data-review-choice="${escapeHtml(choice)}" data-review-task-id="${escapeHtml(task.user_task_id)}">
                  ${escapeHtml(reviewChoiceLabel(choice))}
                </button>
              `).join("")}
            </div>
            <label class="answer-field review-note-field">
              <span>${escapeHtml(t("review.note"))}</span>
              <textarea data-review-note-task-id="${escapeHtml(task.user_task_id)}" placeholder="${escapeHtml(t("review.notePlaceholder"))}">${escapeHtml(draft.note || "")}</textarea>
            </label>
            <div class="answer-toolbar review-actions">
              <span>${escapeHtml(canSave ? t("review.title") : t("review.localOnly"))}</span>
              <button type="button" data-action="save-vision-review" data-review-task-id="${escapeHtml(task.user_task_id)}" ${canSave && draft.decision ? "" : "disabled"}>
                ${escapeHtml(state.reviewStatus?.type === "saving" ? t("vision.saving") : t("review.save"))}
              </button>
            </div>
          </article>
        `;
      }).join("")}
    </section>
  `;
}

function reportReviewChoiceLabel(choice) {
  return t(`report.${choice}`) || valueLabel(choice);
}

function renderSpecialistReportReviews(reviews) {
  const canSave = ["localhost", "127.0.0.1"].includes(window.location.hostname);
  if (!reviews.length) return "";

  return `
    <section class="vision-review-board report-review-board">
      <div class="section-title compact-title">
        <div>
          <span class="eyebrow">${escapeHtml(t("report.title"))}</span>
          <h3>${escapeHtml(t("user.reportReviews"))}</h3>
        </div>
      </div>
      ${state.reportReviewStatus?.message ? `<div class="answer-status ${escapeHtml(state.reportReviewStatus.type || "")}">${escapeHtml(state.reportReviewStatus.message)}</div>` : ""}
      ${reviews.map((review) => {
        const draft = state.reportReviewDrafts[review.task_id] || {};
        const choices = ["accept", "request_changes", "hold"];
        return `
          <article class="vision-review-card report-review-card ${statusClass(review.state)}">
            <div class="review-card-head">
              <div>
                <span class="eyebrow">${escapeHtml(review.task_id || "report")}</span>
                <h3>${escapeHtml(review.title || t("report.title"))}</h3>
              </div>
              <div class="meta">
                ${pill(review.state || "needs_review")}
                ${review.owner_display_name ? pill(review.owner_display_name) : ""}
              </div>
            </div>
            <div class="text-row"><b>${escapeHtml(t("report.agent"))}</b><span>${escapeHtml(review.owner_display_name || review.owner_agent_id || t("task.none"))}</span></div>
            <div class="text-row"><b>${escapeHtml(t("report.file"))}</b><span>${escapeHtml(review.report_path || t("task.none"))}</span></div>
            ${review.result_summary ? `<div class="text-row"><b>${escapeHtml(t("report.result"))}</b><span>${escapeHtml(review.result_summary)}</span></div>` : ""}
            <div class="review-list-block report-excerpt">
              <b>${escapeHtml(t("report.excerpt"))}</b>
              <pre>${escapeHtml(review.report_excerpt || (review.report_exists ? t("task.none") : t("empty.records")))}</pre>
            </div>
            <div class="review-choice-grid" role="radiogroup" aria-label="${escapeHtml(t("report.title"))}">
              ${choices.map((choice) => `
                <button type="button" class="${draft.decision === choice ? "selected" : ""}" data-report-choice="${escapeHtml(choice)}" data-report-task-id="${escapeHtml(review.task_id)}">
                  ${escapeHtml(reportReviewChoiceLabel(choice))}
                </button>
              `).join("")}
            </div>
            <label class="answer-field review-note-field">
              <span>${escapeHtml(t("report.note"))}</span>
              <textarea data-report-note-task-id="${escapeHtml(review.task_id)}" placeholder="${escapeHtml(t("report.notePlaceholder"))}">${escapeHtml(draft.note || "")}</textarea>
            </label>
            <div class="answer-toolbar review-actions">
              <span>${escapeHtml(canSave ? t("report.title") : t("review.localOnly"))}</span>
              <button type="button" data-action="save-report-review" data-report-task-id="${escapeHtml(review.task_id)}" ${canSave && draft.decision ? "" : "disabled"}>
                ${escapeHtml(state.reportReviewStatus?.type === "saving" ? t("vision.saving") : t("report.save"))}
              </button>
            </div>
          </article>
        `;
      }).join("")}
    </section>
  `;
}

function renderHandoffDrafts(drafts) {
  if (!drafts.length) return "";

  return `
    <section class="vision-review-board handoff-draft-board">
      <div class="section-title compact-title">
        <div>
          <span class="eyebrow">${escapeHtml(t("handoff.title"))}</span>
          <h3>${escapeHtml(t("user.handoffDrafts"))}</h3>
        </div>
      </div>
      ${state.handoffStatus?.message ? `<div class="answer-status ${escapeHtml(state.handoffStatus.type || "")}">${escapeHtml(state.handoffStatus.message)}</div>` : ""}
      ${drafts.map((draft) => `
        <article class="vision-review-card handoff-draft-card ${statusClass(draft.task_state)}">
          <div class="review-card-head">
            <div>
              <span class="eyebrow">${escapeHtml(draft.handoff_id || draft.task_id || "handoff")}</span>
              <h3>${escapeHtml(draft.title || t("handoff.title"))}</h3>
            </div>
            <div class="meta">
              ${pill(draft.mode || "initial", draft.mode || "active")}
              ${pill(draft.task_state || "queued")}
            </div>
          </div>
          <div class="text-row"><b>${escapeHtml(t("handoff.agent"))}</b><span>${escapeHtml(draft.agent_display_name || draft.agent_id || t("task.none"))}</span></div>
          <div class="text-row"><b>${escapeHtml(t("handoff.thread"))}</b><span>${escapeHtml(draft.thread_id || t("task.none"))}</span></div>
          <div class="review-list-block report-excerpt">
            <b>${escapeHtml(t("handoff.prompt"))}</b>
            <pre>${escapeHtml(draft.prompt_preview || draft.prompt || "")}</pre>
          </div>
          <div class="answer-toolbar review-actions">
            <span>${escapeHtml(t("handoff.title"))}</span>
            <button type="button" data-action="copy-handoff" data-handoff-id="${escapeHtml(draft.handoff_id)}">
              ${escapeHtml(t("handoff.copy"))}
            </button>
          </div>
        </article>
      `).join("")}
    </section>
  `;
}

function approvalTypeLabel(type) {
  return t(`approval.${type}`) || valueLabel(type);
}

function renderApprovalWaits(tasks) {
  if (!tasks.length) return "";

  return `
    <section class="vision-review-board approval-wait-board">
      <div class="section-title compact-title">
        <div>
          <span class="eyebrow">${escapeHtml(t("approval.title"))}</span>
          <h3>${escapeHtml(t("user.approvalWaits"))}</h3>
        </div>
      </div>
      ${tasks.map((task) => {
        const sourceIds = (task.source_ids || task.source_task_ids || [task.source_task_id]).filter(Boolean);
        const agent = task.source_agent_id || task.support_agent_id || task.assigned_by || t("task.none");
        return `
          <article class="vision-review-card approval-wait-card ${statusClass(task.status)}">
            <div class="review-card-head">
              <div>
                <span class="eyebrow">${escapeHtml(task.user_task_id || "approval")}</span>
                <h3>${escapeHtml(task.title || t("approval.title"))}</h3>
              </div>
              <div class="meta">
                ${pill(task.status || "ready", "blocked")}
                ${task.priority ? pill(task.priority, task.priority) : ""}
                ${task.approval_type ? pill(approvalTypeLabel(task.approval_type), "blocked") : ""}
              </div>
            </div>
            <div class="text-row"><b>${escapeHtml(t("approval.agent"))}</b><span>${escapeHtml(agent)}</span></div>
            ${sourceIds.length ? `<div class="text-row"><b>${escapeHtml(t("approval.task"))}</b><span>${escapeHtml(sourceIds.join(", "))}</span></div>` : ""}
            ${task.prompt ? `<div class="text-row"><b>${escapeHtml(t("review.prompt"))}</b><span>${escapeHtml(task.prompt)}</span></div>` : ""}
            ${task.reason ? `<div class="text-row"><b>${escapeHtml(t("approval.reason"))}</b><span>${escapeHtml(task.reason)}</span></div>` : ""}
            ${task.requested_action ? `<div class="text-row"><b>${escapeHtml(t("approval.requestedAction"))}</b><span>${escapeHtml(task.requested_action)}</span></div>` : ""}
            ${task.resume_instruction ? `<div class="text-row"><b>${escapeHtml(t("approval.resume"))}</b><span>${escapeHtml(task.resume_instruction)}</span></div>` : ""}
          </article>
        `;
      }).join("")}
    </section>
  `;
}

function renderUserTaskSummary() {
  const stats = getUserTaskStats();
  $("userTaskCount").textContent = formatCount("total", stats.total);
  const cards = [
    [t("user.readyQuestions"), stats.readyQuestions.length, t("user.questionsDetail"), "active"],
    [t("user.approvalWaits"), stats.approvalWaits.length, t("user.approvalWaitDetail"), stats.approvalWaits.length ? "blocked" : "standby"],
    [t("user.handoffDrafts"), stats.handoffDrafts.length, t("user.handoffDraftDetail"), stats.handoffDrafts.length ? "active" : "standby"],
    [t("user.visionReviews"), stats.visionReviewTasks.length, t("user.visionReviewDetail"), stats.visionReviewTasks.length ? "active" : "standby"],
    [t("user.reportReviews"), stats.reportReviews.length, t("user.reportReviewDetail"), stats.reportReviews.length ? "blocked" : "standby"],
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
  $("userTaskSummary").insertAdjacentHTML("beforeend", renderHandoffDrafts(stats.handoffDrafts));
  $("userTaskSummary").insertAdjacentHTML("beforeend", renderApprovalWaits(stats.approvalWaits));
  $("userTaskSummary").insertAdjacentHTML("beforeend", renderVisionReviewTasks(stats.visionReviewTasks));
  $("userTaskSummary").insertAdjacentHTML("beforeend", renderSpecialistReportReviews(stats.reportReviews));
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

function orderedInteractiveQuestions() {
  return (state.vision?.questions || [])
    .filter((question) => question.status !== "adopted" && question.status !== "retired")
    .slice()
    .sort((a, b) => {
      const setupDelta = Number(Boolean(b.required_for_setup)) - Number(Boolean(a.required_for_setup));
      if (setupDelta) return setupDelta;
      const readyDelta = Number(b.status === "ready") - Number(a.status === "ready");
      if (readyDelta) return readyDelta;
      const priorityRank = { high: 3, medium: 2, low: 1 };
      const priorityDelta = (priorityRank[b.priority] || 0) - (priorityRank[a.priority] || 0);
      if (priorityDelta) return priorityDelta;
      return String(a.question_id || "").localeCompare(String(b.question_id || ""), undefined, { numeric: true });
    });
}

function renderVisionPanelV2() {
  const vision = state.vision || {};
  const answerBatches = vision.answerBatches || [];
  const policy = vision.curationPolicy || {};
  const stats = getVisionStats();
  const curator = policy.curator_agent_id || "vision-curator";
  const canSaveAnswers = ["localhost", "127.0.0.1"].includes(window.location.hostname);
  const draftCount = Object.values(state.answerDrafts).filter((value) => String(value || "").trim()).length;
  const interactiveQuestions = orderedInteractiveQuestions();
  const intakeSubmitted = state.setup?.projectIntake?.status === "submitted";

  $("visionCount").textContent = `${stats.totalQuestions} ${t("vision.questions")} · ${stats.answerBatches} ${t("vision.answers")}`;

  if (!intakeSubmitted) {
    $("visionPanel").innerHTML = `
      <div class="vision-summary">
        <div class="vision-curator-card">
          <span class="eyebrow">${escapeHtml(t("vision.curator"))}</span>
          <h3>${escapeHtml(curator)}</h3>
          <div class="meta">${pill(t("setup.project"), "active")}</div>
        </div>
        <div class="setup-form-card">
          <b>${escapeHtml(t("setup.project"))}</b>
          <p>${escapeHtml(t("setup.intakeBeforeQuestions"))}</p>
        </div>
      </div>
    `;
    return;
  }

  const selectedCandidate = interactiveQuestions.find((question) => question.question_id === state.selectedQuestionId);
  const firstRequiredReady = interactiveQuestions.find((question) => question.required_for_setup && question.status === "ready");
  if (firstRequiredReady && (!selectedCandidate || !selectedCandidate.required_for_setup || selectedCandidate.status !== "ready")) {
    state.selectedQuestionId = firstRequiredReady.question_id;
  } else if (!selectedCandidate) {
    state.selectedQuestionId = interactiveQuestions[0]?.question_id || null;
  }

  const selectedIndex = Math.max(0, interactiveQuestions.findIndex((question) => question.question_id === state.selectedQuestionId));
  const selectedQuestion = interactiveQuestions[selectedIndex] || null;
  const visibleQuestions = state.showAllQuestions ? interactiveQuestions : interactiveQuestions.slice(0, 12);
  const hiddenQuestionCount = Math.max(0, interactiveQuestions.length - visibleQuestions.length);
  const triggerItems = (policy.wake_triggers || []).slice(0, 6);
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

function completionMapCounts() {
  const phases = state.completionMap?.phases || [];
  const items = phases.flatMap((phase) => phase.items || []);
  const total = items.length || phases.length;
  const done = items.length
    ? items.filter((item) => item.status === "done" || item.status === "accepted").length
    : phases.filter((phase) => phase.status === "done" || phase.status === "accepted").length;
  const active = phases.filter((phase) => ["active", "in_progress", "review"].includes(phase.status)).length
    + items.filter((item) => ["active", "in_progress", "review"].includes(item.status)).length;
  const blocked = phases.filter((phase) => phase.status === "blocked").length
    + items.filter((item) => item.status === "blocked").length;
  return { phases, items, total, done, active, blocked, percent: pct(done, total) };
}

function pct(value, total) {
  if (!total) return 0;
  return Math.round((value / total) * 100);
}

function agentById(agentId) {
  return state.agents.find((agent) => agent.agent_id === agentId);
}

function agentDisplayName(agentOrId) {
  const agent = typeof agentOrId === "string" ? agentById(agentOrId) : agentOrId;
  if (!agent) return String(agentOrId || "");
  if (currentLang === "en") return agent.display_name_en || agent.display_name || agent.agent_id;
  return agent.display_name || agent.display_name_ja || agent.agent_id;
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
        <b>${escapeHtml(agentDisplayName(agent))}</b>
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
  const visible = pod.agents.slice(0, 6);
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
        <h3>${escapeHtml(agentDisplayName(agent))}</h3>
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
        <p>${collaborators.length ? collaborators.map(agentDisplayName).join(", ") : escapeHtml(t("team.noCollaborators"))}</p>
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

function renderCompletionMap() {
  const map = state.completionMap || {};
  const { phases, total, done, active, percent } = completionMapCounts();
  const node = $("completionMap");
  if (!node) return;
  $("completionCount").textContent = phases.length
    ? `${percent}% · ${t("completion.remaining", { count: Math.max(0, total - done) })}`
    : t("completion.noMap");

  if (!phases.length) {
    node.innerHTML = `
      <div class="completion-empty">
        <b>${escapeHtml(t("completion.noMap"))}</b>
        <p>${escapeHtml(t("completion.noMapDetail"))}</p>
      </div>
    `;
    return;
  }

  const currentPhase = phases.find((phase) => ["active", "in_progress", "review"].includes(phase.status)) || phases.find((phase) => phase.status !== "done") || phases[0];
  const triggers = map.revision_policy?.review_triggers || [];
  node.innerHTML = `
    <div class="completion-hero">
      <div class="completion-radial" style="--progress:${percent * 3.6}deg">
        <strong>${percent}%</strong>
        <span>${escapeHtml(valueLabel(map.status || "draft"))}</span>
      </div>
      <div class="completion-brief">
        <span class="eyebrow">${escapeHtml(map.project_title || t("section.completionMap"))}</span>
        <h3>${escapeHtml(t("completion.definition"))}</h3>
        <p>${escapeHtml(map.definition_of_done || t("completion.noMapDetail"))}</p>
        <div class="completion-brief-meta">
          ${pill(t("completion.done", { count: done }), "accepted")}
          ${active ? pill(t("completion.current"), "active") : ""}
          ${pill(t("completion.remaining", { count: Math.max(0, total - done) }), "queued")}
        </div>
      </div>
      <div class="completion-current">
        <span>${escapeHtml(t("completion.current"))}</span>
        <b>${escapeHtml(currentPhase?.title || t("task.none"))}</b>
        <small>${escapeHtml(currentPhase?.summary || "")}</small>
      </div>
    </div>
    <div class="completion-phase-track">
      ${phases.map((phase, index) => renderCompletionPhase(phase, index)).join("")}
    </div>
    <div class="completion-footer">
      <b>${escapeHtml(t("completion.revision"))}</b>
      <span>${escapeHtml(triggers.length ? triggers.map(completionTriggerLabel).join(" · ") : t("task.none"))}</span>
    </div>
  `;
}

function renderCompletionPhase(phase, index) {
  const items = phase.items || [];
  const doneItems = items.filter((item) => item.status === "done" || item.status === "accepted").length;
  const itemPct = pct(doneItems, items.length);
  return `
    <article class="completion-phase ${statusClass(phase.status)}">
      <div class="completion-phase-index">${String(index + 1).padStart(2, "0")}</div>
      <div class="completion-phase-body">
        <div class="completion-phase-head">
          <div>
            <span>${escapeHtml(phase.phase_id || "")}</span>
            <h3>${escapeHtml(phase.title || "")}</h3>
          </div>
          ${pill(phase.status || "unknown")}
        </div>
        <p>${escapeHtml(phase.summary || "")}</p>
        <div class="completion-phase-meta">
          ${phase.owner_agent_id ? `<span>${escapeHtml(t("completion.owner"))}: ${escapeHtml(agentDisplayName(phase.owner_agent_id))}</span>` : ""}
          <span>${escapeHtml(t("completion.done", { count: doneItems }))} / ${items.length || 0}</span>
        </div>
        <div class="completion-mini-track"><i style="--fill:${itemPct}%"></i></div>
        <div class="completion-items">
          ${items.length ? items.map((item) => `
            <div class="completion-item ${statusClass(item.status)}">
              <span></span>
              <b>${escapeHtml(item.title || item.item_id || "")}</b>
              <em>${escapeHtml(valueLabel(item.status || "unknown"))}</em>
            </div>
          `).join("") : `<div class="empty">${escapeHtml(t("completion.noItems"))}</div>`}
        </div>
      </div>
    </article>
  `;
}

function setupStepTone(status) {
  const normalized = String(status || "queued").toLowerCase().replaceAll("_", "-");
  if (normalized === "done" || normalized === "accepted") return "done";
  if (normalized === "active" || normalized === "in-progress") return "active";
  if (normalized === "blocked") return "blocked";
  return "queued";
}

function getSetupStats() {
  const steps = state.setup?.wizard?.steps || [];
  const done = steps.filter((step) => setupStepTone(step.status) === "done").length;
  const active = steps.find((step) => setupStepTone(step.status) === "active") || steps.find((step) => setupStepTone(step.status) !== "done");
  return { steps, done, active, total: steps.length };
}

function getSetupQuestionStats() {
  const questions = (state.vision?.questions || []).filter((question) => question.required_for_setup);
  const unresolved = questions.filter((question) => !["answered", "adopted", "retired"].includes(String(question.status || "")));
  return {
    total: questions.length,
    answered: questions.length - unresolved.length,
    unresolved: unresolved.length,
    ready: unresolved.filter((question) => question.status === "ready").length
  };
}

function specialistDecisionLabel(decision) {
  const labels = {
    approve_now: t("setup.approveNow"),
    later: t("setup.later"),
    reject: t("setup.reject"),
    revise: t("setup.revise")
  };
  return labels[decision] || valueLabel(decision);
}

function renderSpecialistPlan(plan, canSave, gates) {
  const candidates = plan?.candidates || [];
  const deferred = plan?.deferred_topics || [];
  const canGenerate = canSave && gates.completion_map_approved;
  const hasDrafts = Object.values(state.specialistPlanDrafts || {}).some((draft) => draft?.decision);

  return `
    <section class="specialist-plan-card">
      <div class="specialist-plan-head">
        <div>
          <span class="eyebrow">${escapeHtml(t("setup.specialistPlan"))}</span>
          <h3>${escapeHtml(t("setup.specialistPlan"))}</h3>
          <p>${escapeHtml(t("setup.specialistPlanDetail"))}</p>
        </div>
        <div class="meta">
          ${pill(plan?.status || "not_generated")}
          ${candidates.length ? pill(t("team.podAgents", { count: candidates.length }), "active") : ""}
        </div>
      </div>
      <div class="answer-toolbar specialist-plan-toolbar">
        <span>${escapeHtml(candidates.length ? t("setup.specialistPlanDetail") : t("setup.specialistPlanEmpty"))}</span>
        <button type="button" data-action="generate-specialist-plan" ${canGenerate ? "" : "disabled"}>${escapeHtml(t("setup.generateSpecialists"))}</button>
        <button type="button" data-action="save-specialist-plan" ${canSave && hasDrafts ? "" : "disabled"}>${escapeHtml(t("setup.saveSpecialistPlan"))}</button>
      </div>
      ${candidates.length ? `
        <div class="specialist-candidate-list">
          ${candidates.map((candidate) => {
            const draft = state.specialistPlanDrafts[candidate.candidate_id] || {};
            const selectedDecision = draft.decision || candidate.user_decision || "";
            return `
              <article class="specialist-candidate ${statusClass(candidate.status)}">
                <div class="specialist-candidate-head">
                  <div>
                    <span class="eyebrow">${escapeHtml(candidate.candidate_id || candidate.agent_id || "")}</span>
                    <h4>${escapeHtml(candidate.display_name || candidate.agent_id || "")}</h4>
                  </div>
                  <div class="meta">
                    ${pill(candidate.priority || "medium", candidate.priority)}
                    ${pill(candidate.reuse_existing_agent ? t("setup.reuse") : t("setup.newAgent"), candidate.reuse_existing_agent ? "accepted" : "queued")}
                    ${candidate.user_decision ? pill(specialistDecisionLabel(candidate.user_decision), "accepted") : ""}
                  </div>
                </div>
                <p>${escapeHtml(candidate.reason || "")}</p>
                <div class="text-row"><b>${escapeHtml(t("setup.scope"))}</b><span>${escapeHtml(candidate.proposed_scope || "")}</span></div>
                <div class="text-row"><b>${escapeHtml(t("completion.current"))}</b><span>${escapeHtml((candidate.completion_items || []).join(" · ") || t("task.none"))}</span></div>
                <div class="text-row"><b>${escapeHtml(t("setup.reading"))}</b><span>${escapeHtml((candidate.required_reading || []).join(" · ") || t("task.none"))}</span></div>
                <div class="specialist-choice-grid">
                  ${["approve_now", "later", "reject", "revise"].map((decision) => `
                    <button type="button" class="${selectedDecision === decision ? "selected" : ""}" data-specialist-choice="${escapeHtml(decision)}" data-specialist-candidate-id="${escapeHtml(candidate.candidate_id)}">
                      ${escapeHtml(specialistDecisionLabel(decision))}
                    </button>
                  `).join("")}
                </div>
                <label class="answer-field specialist-note-field">
                  <span>${escapeHtml(t("review.note"))}</span>
                  <textarea data-specialist-note-id="${escapeHtml(candidate.candidate_id)}" placeholder="${escapeHtml(t("review.notePlaceholder"))}">${escapeHtml(draft.note ?? candidate.user_note ?? "")}</textarea>
                </label>
              </article>
            `;
          }).join("")}
        </div>
      ` : `<div class="empty">${escapeHtml(t("setup.specialistPlanEmpty"))}</div>`}
      ${deferred.length ? `
        <div class="specialist-deferred">
          <b>${escapeHtml(t("setup.deferred"))}</b>
          ${deferred.map((topic) => `<span>${escapeHtml(topic.title || topic.topic_id || "")}</span>`).join("")}
        </div>
      ` : ""}
    </section>
  `;
}

function approvedSpecialistCandidates(plan) {
  return (plan?.candidates || []).filter((candidate) => candidate.user_decision === "approve_now");
}

function productionPreparedByCandidate(productionStart) {
  return new Map((productionStart?.activation_requests || []).map((request) => [request.candidate_id, request]));
}

function productionRequestStage(request) {
  if (!request) return "queued";
  if (request.status === "accepted" || request.accepted_at) return "accepted";
  if (request.status === "active" || request.status === "handoff_sent" || request.sent_at) return "sent";
  return "prepared";
}

function productionStageLabel(stage) {
  if (stage === "accepted") return t("setup.handoffAccepted");
  if (stage === "sent") return t("setup.handoffSent");
  if (stage === "prepared") return t("setup.handoffPrepared");
  if (stage === "selected") return t("setup.selectForHandoff");
  return t("setup.noThreadMessage");
}

function productionStageTone(stage) {
  if (stage === "accepted") return "accepted";
  if (stage === "sent") return "sent";
  if (stage === "prepared") return "prepared";
  if (stage === "selected") return "active";
  return "queued";
}

function productionSummaryStage(productionStart) {
  const requests = productionStart?.activation_requests || [];
  if (!requests.length) return "";
  const stages = requests.map(productionRequestStage);
  if (stages.every((stage) => stage === "accepted")) return "accepted";
  if (stages.some((stage) => stage === "sent" || stage === "accepted")) return "sent";
  return "prepared";
}

function isProductionCandidateSelected(candidate, index, productionStart) {
  const draft = state.productionStartDrafts?.[candidate.candidate_id];
  if (typeof draft?.selected === "boolean") return draft.selected;
  const prepared = productionPreparedByCandidate(productionStart);
  if (prepared.has(candidate.candidate_id)) return true;
  const hasExistingRequests = (productionStart?.activation_requests || []).length > 0;
  return !hasExistingRequests && candidate.priority === "high" && index < 2;
}

function selectedProductionCandidateIds(plan, productionStart) {
  return approvedSpecialistCandidates(plan)
    .filter((candidate, index) => isProductionCandidateSelected(candidate, index, productionStart))
    .map((candidate) => candidate.candidate_id);
}

function renderProductionStart(plan, productionStart, canSave, gates) {
  const approved = approvedSpecialistCandidates(plan);
  const prepared = productionPreparedByCandidate(productionStart);
  const selectedIds = selectedProductionCandidateIds(plan, productionStart);
  const hasPreparedRequests = prepared.size > 0;
  const canPrepare = canSave && gates.specialist_plan_approved && approved.length && selectedIds.length && !hasPreparedRequests;
  const summaryStage = productionSummaryStage(productionStart);
  const prepareButtonLabel = hasPreparedRequests ? t("setup.productionLocked") : t("setup.prepareProduction");

  return `
    <section class="production-start-card">
      <div class="specialist-plan-head">
        <div>
          <span class="eyebrow">${escapeHtml(t("setup.productionStart"))}</span>
          <h3>${escapeHtml(t("setup.productionStart"))}</h3>
          <p>${escapeHtml(t("setup.productionStartDetail"))}</p>
        </div>
        <div class="meta">
          ${pill(productionStart?.status || "not_started")}
          ${summaryStage ? pill(productionStageLabel(summaryStage), productionStageTone(summaryStage)) : ""}
          ${hasPreparedRequests ? pill(t("setup.noSessionsCreated"), "queued") : ""}
        </div>
      </div>
      <div class="answer-toolbar specialist-plan-toolbar">
        <span>${escapeHtml(approved.length ? t("setup.productionStartDetail") : t("setup.productionStartEmpty"))}</span>
        <button type="button" data-action="start-production" ${canPrepare ? "" : "disabled"}>${escapeHtml(prepareButtonLabel)}</button>
      </div>
      ${approved.length ? `
        <div class="production-legend" aria-label="${escapeHtml(t("setup.productionLegend"))}">
          <b>${escapeHtml(t("setup.productionLegend"))}</b>
          <span><i class="legend-dot active"></i>${escapeHtml(t("setup.legendSelected"))}</span>
          <span><i class="legend-dot prepared"></i>${escapeHtml(t("setup.legendPrepared"))}</span>
          <span><i class="legend-dot sent"></i>${escapeHtml(t("setup.legendSent"))}</span>
          <span><i class="legend-dot accepted"></i>${escapeHtml(t("setup.legendAccepted"))}</span>
        </div>
        <div class="production-candidate-list">
          ${approved.map((candidate, index) => {
            const selected = isProductionCandidateSelected(candidate, index, productionStart);
            const request = prepared.get(candidate.candidate_id);
            const stage = request ? productionRequestStage(request) : selected ? "selected" : "queued";
            const stageTone = productionStageTone(stage);
            const stageLabel = productionStageLabel(stage);
            return `
              <article class="production-candidate ${stageTone}">
                <div class="specialist-candidate-head">
                  <div>
                    <span class="eyebrow">${escapeHtml(candidate.candidate_id || "")}</span>
                    <h4>${escapeHtml(candidate.display_name || candidate.agent_id || "")}</h4>
                  </div>
                  <div class="meta">
                    ${pill(candidate.priority || "medium", candidate.priority)}
                    ${request ? pill(`${stageLabel} · ${request.task_id || ""}`, stageTone) : pill(stageLabel, stageTone)}
                    ${request ? pill(t("setup.noSessionsCreated"), "queued") : ""}
                  </div>
                </div>
                <p>${escapeHtml(candidate.proposed_scope || candidate.reason || "")}</p>
                <div class="text-row"><b>${escapeHtml(t("setup.scope"))}</b><span>${escapeHtml((candidate.completion_items || []).join(" · ") || t("task.none"))}</span></div>
                <div class="production-choice-row">
                  <button type="button" class="${selected ? "selected" : ""}" data-production-toggle="${escapeHtml(candidate.candidate_id)}" ${hasPreparedRequests ? "disabled" : ""}>
                    ${escapeHtml(request ? stageLabel : selected ? t("setup.selectForHandoff") : t("setup.waitForLater"))}
                  </button>
                  <span>${escapeHtml(request ? stageLabel : t("setup.noThreadMessage"))}</span>
                </div>
              </article>
            `;
          }).join("")}
        </div>
      ` : `<div class="empty">${escapeHtml(t("setup.productionStartEmpty"))}</div>`}
    </section>
  `;
}

function renderSetupWizard() {
  const node = $("setupWizard");
  if (!node) return;
  const setup = state.setup || {};
  const wizard = setup.wizard || {};
  const intake = setup.projectIntake || {};
  const gates = wizard.gates || {};
  const { steps, done, active, total } = getSetupStats();
  const setupQuestions = getSetupQuestionStats();
  const canSave = ["localhost", "127.0.0.1"].includes(window.location.hostname);
  const projectTitle = state.setupDraft.project_title ?? intake.project_title ?? state.completionMap?.project_title ?? "";
  const projectDescription = state.setupDraft.project_description ?? intake.project_description ?? "";
  const projectSubmitted = intake.status === "submitted";
  const questionsReady = setupQuestions.total > 0;
  const questionsAnswered = questionsReady && setupQuestions.unresolved === 0;
  const finalized = Boolean(gates.setup_autopilot_finalized || wizard.status === "ready_for_operation");
  const canGenerateQuestions = canSave && projectSubmitted && !questionsReady;
  const canFinalize = canSave && projectSubmitted && questionsAnswered && !finalized;
  const compactSteps = [
    [t("setup.project"), projectSubmitted ? "done" : "active"],
    [t("vision.questions"), !projectSubmitted ? "queued" : questionsAnswered ? "done" : questionsReady ? "active" : "queued"],
    [t("setup.autopilot"), finalized ? "done" : questionsAnswered ? "active" : "queued"],
    [t("setup.operationReady"), finalized ? "active" : "queued"]
  ];
  const compactDone = compactSteps.filter(([, tone]) => tone === "done" || tone === "active" && finalized).length;

  $("setupCount").textContent = `${compactDone}/${compactSteps.length}`;

  node.innerHTML = `
    <div class="setup-compact">
      <aside class="setup-steps compact">
        ${compactSteps.map(([label, tone], index) => `
          <button class="setup-step ${tone}" type="button">
            <span>${String(index + 1).padStart(2, "0")}</span>
            <b>${escapeHtml(label)}</b>
          </button>
        `).join("")}
      </aside>

      <section class="setup-main compact">
        <div class="setup-hero-card">
          <span class="eyebrow">${escapeHtml(t("setup.current"))}</span>
          <h3>${escapeHtml(finalized ? t("setup.readyForOperation") : active?.title || t("section.setupWizard"))}</h3>
          <p>${escapeHtml(finalized ? t("setup.readyForOperationDetail") : t("setup.autopilotDetail"))}</p>
          <div class="completion-brief-meta">
            ${pill(wizard.status || "draft")}
            ${pill(t("completion.done", { count: done }), "accepted")}
            ${setupQuestions.total ? pill(t("setup.questionsAnswered", { answered: setupQuestions.answered, total: setupQuestions.total }), setupQuestions.unresolved ? "active" : "accepted") : ""}
            ${finalized ? pill(t("setup.autopilotDone"), "accepted") : pill(t("setup.autopilotWaiting"), "active")}
          </div>
        </div>

        ${finalized ? `
          <div class="setup-form-card setup-finished-card">
            <b>${escapeHtml(t("setup.finishedTitle"))}</b>
            <p>${escapeHtml(t("setup.finishedDetail"))}</p>
          </div>
        ` : `
          <div class="setup-form-card">
            <label>
              <span>${escapeHtml(t("setup.projectTitle"))}</span>
              <input data-setup-field="project_title" value="${escapeHtml(projectTitle)}" placeholder="${escapeHtml(t("setup.projectTitle"))}">
            </label>
            <label>
              <span>${escapeHtml(t("setup.projectDescription"))}</span>
              <textarea data-setup-field="project_description" placeholder="${escapeHtml(t("setup.projectPlaceholder"))}">${escapeHtml(projectDescription)}</textarea>
            </label>
            <div class="answer-toolbar">
              <button type="button" data-action="save-setup-intake" ${canSave ? "" : "disabled"}>${escapeHtml(t("setup.saveProject"))}</button>
              <button type="button" data-action="generate-setup-questions" ${canGenerateQuestions ? "" : "disabled"}>${escapeHtml(t("setup.generateQuestions"))}</button>
              <button type="button" data-action="show-user-tasks" ${questionsReady ? "" : "disabled"}>${escapeHtml(t("setup.answerQuestions"))}</button>
              <button type="button" data-action="auto-finalize-setup" ${canFinalize ? "" : "disabled"}>${escapeHtml(t("setup.finalizeAutopilot"))}</button>
            </div>
            ${state.setupStatus ? `<div class="answer-status ${escapeHtml(state.setupStatus.type || "")}">${escapeHtml(state.setupStatus.message || "")}</div>` : ""}
            ${projectSubmitted && !questionsReady ? `<div class="answer-status success">${escapeHtml(t("setup.generateAfterIntake"))}</div>` : ""}
            ${setupQuestions.unresolved ? `<div class="answer-status error">${escapeHtml(t("setup.answerQuestionsFirst"))}</div>` : ""}
            ${questionsAnswered && !finalized ? `<div class="answer-status success">${escapeHtml(t("setup.readyToFinalize"))}</div>` : ""}
            ${canSave ? "" : `<div class="answer-status error">${escapeHtml(t("setup.localOnly"))}</div>`}
          </div>
        `}
      </section>
    </div>
  `;
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
  renderCompletionMap();
  renderSetupWizard();
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
  if (fileName === "options.json") state.setup.options = data || state.setup.options;
  if (fileName === "wizard.json") state.setup.wizard = data || state.setup.wizard;
  if (fileName === "project_intake.json") state.setup.projectIntake = data || state.setup.projectIntake;
  if (fileName === "specialist_plan.json") state.setup.specialistPlan = data || state.setup.specialistPlan;
  if (fileName === "production_start.json") state.setup.productionStart = data || state.setup.productionStart;
  if (fileName === "completion_map.json") state.completionMap = data || state.completionMap;
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
  state.setup = {
    options: data.setup?.options || state.setup.options || {},
    wizard: data.setup?.wizard || state.setup.wizard || {},
    projectIntake: data.setup?.projectIntake || state.setup.projectIntake || {},
    specialistPlan: data.setup?.specialistPlan || state.setup.specialistPlan || {},
    productionStart: data.setup?.productionStart || state.setup.productionStart || {}
  };
  state.health = {
    encodingWarnings: data.health?.encodingWarnings || []
  };
  state.reportReviews = data.reportReviews || [];
  state.handoffDrafts = data.handoffDrafts || [];
  state.completionMap = data.completionMap || state.completionMap;
  state.loadedFiles = data.loadedFiles || ["agents.json", "sessions.json", "tasks.json", "directives.json", "events.jsonl"];
  state.loadedAt = new Date(data.loadedAt || Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  state.isLive = true;
  state.liveSource = data.source || "server";
  if (!agentById(state.selectedAgentId) && state.agents[0]) {
    state.selectedAgentId = state.agents[0].agent_id;
  }
}

async function refreshServerState(options = {}) {
  if (!["localhost", "127.0.0.1"].includes(window.location.hostname)) return;
  const headers = {};
  if (state.liveEtag && !options.force) {
    headers["if-none-match"] = state.liveEtag;
  }
  const response = await fetch("/api/state", { cache: "no-store", headers });
  if (response.status === 304) {
    state.loadedAt = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    renderSync();
    return;
  }
  if (!response.ok) throw new Error(`state refresh failed: ${response.status}`);
  state.liveEtag = response.headers.get("etag") || null;
  mergeLiveState(await response.json());
  if (document.activeElement?.matches?.("[data-answer-question-id], [data-setup-field], [data-review-note-task-id], [data-report-note-task-id], [data-specialist-note-id]")) {
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
      message: result.setup_autopilot?.finalized
        ? `${t("vision.saved", { count: result.saved, batch: result.batch_id })} · ${t("setup.finalized")}`
        : t("vision.saved", { count: result.saved, batch: result.batch_id })
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

async function saveVisionReview(taskId) {
  const task = (state.userTasks?.tasks || []).find((item) => item.user_task_id === taskId);
  const draft = state.reviewDrafts[taskId] || {};
  const batchId = (task?.source_ids || [])[0];

  if (!task || !batchId || !draft.decision) {
    state.reviewStatus = { type: "error", message: t("review.choose") };
    renderUserTaskSummary();
    return;
  }

  state.reviewStatus = { type: "saving", message: t("vision.saving") };
  renderUserTaskSummary();

  try {
    const response = await fetch("/api/vision-review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        user_task_id: taskId,
        batch_id: batchId,
        decision: draft.decision,
        note: String(draft.note || "").trim()
      })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "save failed");
    delete state.reviewDrafts[taskId];
    state.reviewStatus = { type: "success", message: t("review.saved") };
    await refreshServerState();
  } catch (error) {
    state.reviewStatus = {
      type: "error",
      message: `${t("review.saveError")}: ${error.message || error}`
    };
    renderUserTaskSummary();
  }
}

async function saveSpecialistReportReview(taskId) {
  const review = (state.reportReviews || []).find((item) => item.task_id === taskId);
  const draft = state.reportReviewDrafts[taskId] || {};

  if (!review || !draft.decision) {
    state.reportReviewStatus = { type: "error", message: t("report.choose") };
    renderUserTaskSummary();
    return;
  }

  state.reportReviewStatus = { type: "saving", message: t("vision.saving") };
  renderUserTaskSummary();

  try {
    const response = await fetch("/api/reports/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        task_id: taskId,
        decision: draft.decision,
        note: String(draft.note || "").trim()
      })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "save failed");
    delete state.reportReviewDrafts[taskId];
    state.reportReviewStatus = { type: "success", message: t("report.saved") };
    await refreshServerState();
  } catch (error) {
    state.reportReviewStatus = {
      type: "error",
      message: `${t("report.saveError")}: ${error.message || error}`
    };
    renderUserTaskSummary();
  }
}

async function saveSetupIntake() {
  const projectTitle = String(state.setupDraft.project_title ?? state.setup?.projectIntake?.project_title ?? "").trim();
  const projectDescription = String(state.setupDraft.project_description ?? state.setup?.projectIntake?.project_description ?? "").trim();

  if (!projectDescription) {
    state.setupStatus = { type: "error", message: t("setup.noDescription") };
    renderSetupWizard();
    return;
  }

  state.setupStatus = { type: "saving", message: t("vision.saving") };
  renderSetupWizard();

  try {
    const response = await fetch("/api/setup/project-intake", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project_title: projectTitle,
        project_description: projectDescription
      })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "save failed");
    state.setupDraft = {};
    state.setupStatus = { type: "success", message: t("setup.saved") };
    state.isSetupEditing = false;
    state.pendingLiveRender = false;
    await refreshServerState();
  } catch (error) {
    state.setupStatus = { type: "error", message: `${t("setup.saveError")}: ${error.message || error}` };
    renderSetupWizard();
  }
}

async function generateSetupQuestions() {
  state.setupStatus = { type: "saving", message: t("vision.saving") };
  renderSetupWizard();

  try {
    const response = await fetch("/api/setup/generate-questions", { method: "POST" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "generate failed");
    const count = result.generated || result.reused || 0;
    state.setupStatus = { type: "success", message: t("setup.questionsGenerated", { count }) };
    state.pendingLiveRender = false;
    await refreshServerState();
    state.currentView = "user";
    render();
  } catch (error) {
    state.setupStatus = { type: "error", message: `${t("setup.generateError")}: ${error.message || error}` };
    renderSetupWizard();
  }
}

async function autoFinalizeSetup() {
  state.setupStatus = { type: "saving", message: t("vision.saving") };
  renderSetupWizard();

  try {
    const response = await fetch("/api/setup/auto-finalize", { method: "POST" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "finalize failed");
    state.setupStatus = { type: "success", message: t("setup.finalized") };
    state.pendingLiveRender = false;
    await refreshServerState();
  } catch (error) {
    state.setupStatus = { type: "error", message: `${t("setup.finalizeError")}: ${error.message || error}` };
    renderSetupWizard();
  }
}

async function approveSetupCompletionMap() {
  state.setupStatus = { type: "saving", message: t("vision.saving") };
  renderSetupWizard();

  try {
    const response = await fetch("/api/setup/approve-completion-map", { method: "POST" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "approve failed");
    state.setupStatus = { type: "success", message: t("setup.readyForSpecialists") };
    state.pendingLiveRender = false;
    await refreshServerState();
  } catch (error) {
    state.setupStatus = { type: "error", message: `${t("setup.approveError")}: ${error.message || error}` };
    renderSetupWizard();
  }
}

async function generateSpecialistPlan() {
  state.setupStatus = { type: "saving", message: t("vision.saving") };
  renderSetupWizard();

  try {
    const response = await fetch("/api/setup/generate-specialist-plan", { method: "POST" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "generate failed");
    const count = result.candidates || result.reused || 0;
    state.setupStatus = { type: "success", message: t("setup.specialistGenerated", { count }) };
    state.pendingLiveRender = false;
    await refreshServerState();
  } catch (error) {
    state.setupStatus = { type: "error", message: `${t("setup.specialistError")}: ${error.message || error}` };
    renderSetupWizard();
  }
}

async function saveSpecialistPlan() {
  const decisions = Object.entries(state.specialistPlanDrafts || {})
    .map(([candidate_id, draft]) => ({
      candidate_id,
      decision: draft?.decision,
      note: String(draft?.note || "").trim()
    }))
    .filter((draft) => draft.decision);

  if (!decisions.length) {
    state.setupStatus = { type: "error", message: t("review.choose") };
    renderSetupWizard();
    return;
  }

  state.setupStatus = { type: "saving", message: t("vision.saving") };
  renderSetupWizard();

  try {
    const response = await fetch("/api/setup/review-specialist-plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decisions })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "save failed");
    state.specialistPlanDrafts = {};
    state.setupStatus = { type: "success", message: t("setup.specialistReviewed", { count: result.reviewed || decisions.length }) };
    state.pendingLiveRender = false;
    await refreshServerState();
  } catch (error) {
    state.setupStatus = { type: "error", message: `${t("setup.specialistError")}: ${error.message || error}` };
    renderSetupWizard();
  }
}

async function startProduction() {
  const candidateIds = selectedProductionCandidateIds(state.setup?.specialistPlan || {}, state.setup?.productionStart || {});

  if (!candidateIds.length) {
    state.setupStatus = { type: "error", message: t("review.choose") };
    renderSetupWizard();
    return;
  }

  state.setupStatus = { type: "saving", message: t("vision.saving") };
  renderSetupWizard();

  try {
    const response = await fetch("/api/setup/start-production", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        candidate_ids: candidateIds,
        note: "Prepared from the production start dashboard gate."
      })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "start failed");
    state.productionStartDrafts = {};
    state.setupStatus = { type: "success", message: t("setup.productionPrepared", { count: result.prepared || candidateIds.length }) };
    state.pendingLiveRender = false;
    await refreshServerState();
  } catch (error) {
    state.setupStatus = { type: "error", message: `${t("setup.productionError")}: ${error.message || error}` };
    renderSetupWizard();
  }
}

function startServerPolling() {
  if (!["localhost", "127.0.0.1"].includes(window.location.hostname)) return;
  const poll = async () => {
    try {
      await refreshServerState();
    } catch (error) {
      console.warn(error);
    } finally {
      const delay = document.hidden ? 30000 : 5000;
      state.pollTimer = window.setTimeout(poll, delay);
    }
  };
  poll();
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      refreshServerState({ force: true }).catch((error) => console.warn(error));
    }
  });
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

$("userTaskSummary").addEventListener("input", (event) => {
  const reportNote = event.target.closest("[data-report-note-task-id]");
  if (reportNote) {
    const taskId = reportNote.dataset.reportNoteTaskId;
    state.reportReviewDrafts[taskId] = {
      ...(state.reportReviewDrafts[taskId] || {}),
      note: reportNote.value
    };
    return;
  }

  const note = event.target.closest("[data-review-note-task-id]");
  if (!note) return;
  const taskId = note.dataset.reviewNoteTaskId;
  state.reviewDrafts[taskId] = {
    ...(state.reviewDrafts[taskId] || {}),
    note: note.value
  };
});

$("userTaskSummary").addEventListener("click", (event) => {
  const copyHandoffButton = event.target.closest("[data-action='copy-handoff']");
  if (copyHandoffButton) {
    const draft = (state.handoffDrafts || []).find((item) => item.handoff_id === copyHandoffButton.dataset.handoffId);
    if (!draft?.prompt || !navigator.clipboard?.writeText) {
      state.handoffStatus = { type: "error", message: t("handoff.copyError") };
      renderUserTaskSummary();
      return;
    }
    navigator.clipboard.writeText(draft.prompt)
      .then(() => {
        state.handoffStatus = { type: "success", message: t("handoff.copied") };
        renderUserTaskSummary();
      })
      .catch((error) => {
        state.handoffStatus = { type: "error", message: `${t("handoff.copyError")}: ${error.message || error}` };
        renderUserTaskSummary();
      });
    return;
  }

  const reportChoice = event.target.closest("[data-report-choice]");
  if (reportChoice) {
    const taskId = reportChoice.dataset.reportTaskId;
    state.reportReviewDrafts[taskId] = {
      ...(state.reportReviewDrafts[taskId] || {}),
      decision: reportChoice.dataset.reportChoice
    };
    renderUserTaskSummary();
    return;
  }

  const reportSaveButton = event.target.closest("[data-action='save-report-review']");
  if (reportSaveButton) {
    saveSpecialistReportReview(reportSaveButton.dataset.reportTaskId);
    return;
  }

  const choice = event.target.closest("[data-review-choice]");
  if (choice) {
    const taskId = choice.dataset.reviewTaskId;
    state.reviewDrafts[taskId] = {
      ...(state.reviewDrafts[taskId] || {}),
      decision: choice.dataset.reviewChoice
    };
    renderUserTaskSummary();
    return;
  }

  const saveButton = event.target.closest("[data-action='save-vision-review']");
  if (!saveButton) return;
  saveVisionReview(saveButton.dataset.reviewTaskId);
});

$("userTaskSummary").addEventListener("focusout", (event) => {
  if (!event.target.closest("[data-review-note-task-id], [data-report-note-task-id]")) return;
  window.setTimeout(() => {
    if (document.activeElement?.matches?.("[data-review-note-task-id], [data-report-note-task-id]")) return;
    if (state.pendingLiveRender) {
      state.pendingLiveRender = false;
      render();
    }
  }, 0);
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
    const questions = orderedInteractiveQuestions();
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

$("setupWizard").addEventListener("input", (event) => {
  const note = event.target.closest("[data-specialist-note-id]");
  if (note) {
    const candidateId = note.dataset.specialistNoteId;
    state.specialistPlanDrafts[candidateId] = {
      ...(state.specialistPlanDrafts[candidateId] || {}),
      note: note.value
    };
    return;
  }

  const field = event.target.closest("[data-setup-field]");
  if (!field) return;
  state.setupDraft[field.dataset.setupField] = field.value;
});

$("setupWizard").addEventListener("focusin", (event) => {
  if (!event.target.closest("[data-setup-field], [data-specialist-note-id]")) return;
  state.isSetupEditing = true;
});

$("setupWizard").addEventListener("focusout", (event) => {
  if (!event.target.closest("[data-setup-field], [data-specialist-note-id]")) return;
  window.setTimeout(() => {
    if (document.activeElement?.matches?.("[data-setup-field], [data-specialist-note-id]")) return;
    state.isSetupEditing = false;
    if (state.pendingLiveRender) {
      state.pendingLiveRender = false;
      render();
    }
  }, 0);
});

$("setupWizard").addEventListener("click", (event) => {
  const productionToggle = event.target.closest("[data-production-toggle]");
  if (productionToggle) {
    const candidateId = productionToggle.dataset.productionToggle;
    const current = state.productionStartDrafts[candidateId];
    const productionStart = state.setup?.productionStart || {};
    const candidate = approvedSpecialistCandidates(state.setup?.specialistPlan || {})
      .find((item) => item.candidate_id === candidateId);
    const index = approvedSpecialistCandidates(state.setup?.specialistPlan || {})
      .findIndex((item) => item.candidate_id === candidateId);
    const selected = candidate ? isProductionCandidateSelected(candidate, index, productionStart) : false;
    state.productionStartDrafts[candidateId] = {
      ...(current || {}),
      selected: !selected
    };
    renderSetupWizard();
    return;
  }

  const specialistChoice = event.target.closest("[data-specialist-choice]");
  if (specialistChoice) {
    const candidateId = specialistChoice.dataset.specialistCandidateId;
    state.specialistPlanDrafts[candidateId] = {
      ...(state.specialistPlanDrafts[candidateId] || {}),
      decision: specialistChoice.dataset.specialistChoice
    };
    renderSetupWizard();
    return;
  }

  const saveButton = event.target.closest("[data-action='save-setup-intake']");
  if (saveButton) {
    saveSetupIntake();
    return;
  }
  const generateButton = event.target.closest("[data-action='generate-setup-questions']");
  if (generateButton) {
    generateSetupQuestions();
    return;
  }
  const showUserTasksButton = event.target.closest("[data-action='show-user-tasks']");
  if (showUserTasksButton) {
    state.currentView = "user";
    render();
    return;
  }
  const autoFinalizeButton = event.target.closest("[data-action='auto-finalize-setup']");
  if (autoFinalizeButton) {
    autoFinalizeSetup();
    return;
  }
  const approveButton = event.target.closest("[data-action='approve-completion-map']");
  if (approveButton) {
    approveSetupCompletionMap();
    return;
  }
  const generateSpecialistsButton = event.target.closest("[data-action='generate-specialist-plan']");
  if (generateSpecialistsButton) {
    generateSpecialistPlan();
    return;
  }
  const saveSpecialistsButton = event.target.closest("[data-action='save-specialist-plan']");
  if (saveSpecialistsButton) {
    saveSpecialistPlan();
    return;
  }
  const startProductionButton = event.target.closest("[data-action='start-production']");
  if (startProductionButton) {
    startProduction();
  }
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
