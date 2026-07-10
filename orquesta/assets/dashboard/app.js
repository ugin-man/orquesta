// ---- extracted inline script block 1 from orquesta_cursor_attached_reflection_v6_no_white_awareness_fix(2).html ----
const COMMAND_BOARD_LAYOUT_VERSION = "command-board-lane-grid-v1";
const COMMAND_BOARD_OVERRIDE_KEY = "orquesta.commandBoard.layoutOverrides.v1";
const COMMAND_BOARD_DRAG_THRESHOLD = 4;

const state = {
  agents: [],
  sessions: [],
  tasks: [],
  directives: [],
  triggerAudit: {
    status: "not_run",
    summary: {},
    sessions: {},
    foundation_agents: []
  },
  capacity: null,
  controlAudit: null,
  modelPolicy: null,
  dashboardActions: { actions: [] },
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
  currentView: "home",
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
  showAllDelegationTruth: false,
  showAllDelegationLedger: false,
  actionFocusCategory: null,
  actionFocusId: null,
  showAllActionHandoffs: false,
  showAllActionReports: false,
  controlPlane: {
    tab: "capacity",
    selectedCapacityId: null,
    deepLinkMessage: null
  },
  isAnswerEditing: false,
  pendingLiveRender: false,
  commandBoardGraph: null,
  commandBoardLayout: null,
  commandBoardOverrides: loadCommandBoardLayoutOverrides(),
  commandBoardDrag: null,
  suppressTeamClick: false,
  map: {
    x: -24,
    y: 0,
    scale: 0.92
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
  triggerAudit: {
    status: "sample",
    summary: { clear: 2, trigger_ready: 0, standby_stale: 2, wake_needed: 0, wake_required: 0 },
    sessions: { status: "fresh", synced_at: null, age_minutes: 0 },
    foundation_agents: [
      { agent_id: "vision-curator", trigger_status: "standby_stale", reasons: ["No active trigger; event-driven standby is expected."] },
      { agent_id: "error-concierge", trigger_status: "clear", reasons: ["No open repeated incidents."] }
    ]
  },
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
    "team.manualLayout": "manual",
    "team.dragNode": "Drag node",
    "team.resetSelectedLayout": "Reset selected",
    "team.resetAllLayout": "Reset all",
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
    "team.manualLayout": "手動",
    "team.dragNode": "ノードを移動",
    "team.resetSelectedLayout": "選択を戻す",
    "team.resetAllLayout": "全て戻す",
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

Object.assign(dictionary.en, {
  "actions.summary": "Action filters",
  "actions.inbox": "Priority Action Inbox",
  "actions.inboxDetail": "P0/P1 work that needs user attention now.",
  "actions.inboxEmpty": "No urgent user action is waiting.",
  "actions.workShelves": "Work shelves",
  "actions.openSource": "Open",
  "actions.priority": "Priority",
  "actions.priority.p0": "P0",
  "actions.priority.p1": "P1",
  "actions.priority.p2": "P2",
  "actions.priority.p3": "P3",
  "actions.filtered": "Focused: {label}",
  "actions.all": "All actions",
  "actions.noneInCategory": "No current items in this category."
});

Object.assign(dictionary.ja, {
  "actions.summary": "対応フィルター",
  "actions.inbox": "優先対応インボックス",
  "actions.inboxDetail": "今すぐ見える場所に置くP0/P1のユーザー対応です。",
  "actions.inboxEmpty": "今すぐ必要なユーザー対応はありません。",
  "actions.workShelves": "作業棚",
  "actions.openSource": "開く",
  "actions.priority": "優先度",
  "actions.priority.p0": "P0",
  "actions.priority.p1": "P1",
  "actions.priority.p2": "P2",
  "actions.priority.p3": "P3",
  "actions.filtered": "表示中: {label}",
  "actions.all": "すべての対応",
  "actions.noneInCategory": "このカテゴリの現在の項目はありません。"
});

Object.assign(dictionary.en, {
  "view.home": "Home",
  "view.actions": "User Actions",
  "view.delegation": "Delegation",
  "view.progress": "Progress",
  "recovery.health": "Orchestra Health",
  "recovery.healthReady": "Ready",
  "recovery.commandBoard": "Command Board",
  "recovery.commandBoardDetail": "Live specialist map with handoff status",
  "recovery.selectedAgent": "selected agent",
  "recovery.inspector": "Inspector",
  "recovery.projectRoute": "Project Route",
  "recovery.secondary": "secondary",
  "recovery.secondaryTitle": "Operations Detail",
  "recovery.progressAndTasks": "Progress And Task Flow",
  "recovery.supportQueues": "Repair, Vision, Directives, Events",
  "recovery.projectRouteDetail": "Project Route Detail",
  "home.now": "now",
  "home.running": "running agents",
  "home.runningTitle": "Running Agents",
  "home.current": "current work",
  "home.currentTitle": "What Orquesta Is Doing",
  "home.userNeed": "your move",
  "home.userNeedTitle": "What Needs You",
  "home.notifications": "notifications",
  "home.notificationsTitle": "Attention Queue",
  "home.commandDetail": "Organization graph and active specialist structure",
  "home.context": "context",
  "home.inspector": "Agent Inspector",
  "home.back": "Back to Home",
  "home.noRunning": "No agents are running right now",
  "home.noNotifications": "No notifications need action",
  "home.open": "Open",
  "home.activeTask": "Active task",
  "actions.title": "Focused Action Workspace",
  "actions.detail": "Open notifications here to answer questions, review approvals, inspect blockers, or handle reports.",
  "progress.focusDetail": "Completion map, current phase, and task flow live here instead of Home.",
  "setup.focusDetail": "Setup, directives, and history are kept out of Home.",
  "delegation.eyebrow": "delegation truth",
  "delegation.title": "Delegation Truth",
  "delegation.ledger": "Delegation Ledger",
  "delegation.specialist": "Specialist handoffs",
  "delegation.missing": "Missing reports",
  "delegation.awaiting": "Awaiting review",
  "delegation.direct": "Direct exceptions",
  "delegation.handoff": "Handoff",
  "delegation.report": "Report",
  "delegation.owner": "Owner",
  "delegation.routing": "Routing",
  "delegation.sent": "sent",
  "delegation.notSent": "not sent",
  "delegation.expected": "expected",
  "delegation.notExpected": "not expected",
  "delegation.present": "present",
  "delegation.missingStatus": "missing",
  "delegation.awaitingStatus": "awaiting review",
  "delegation.acceptedStatus": "accepted",
  "delegation.directException": "direct exception",
  "delegation.reason": "Reason",
  "delegation.reviewOwner": "Review owner",
  "delegation.none": "No delegation evidence to show",
  "delegation.focusDetail": "Handoff, report, and direct-exception evidence from task state.",
  "delegation.summary": "{count} records",
  "delegation.truthSummary": "{specialist} handoffs · {missing} missing · {awaiting} awaiting · {direct} direct",
  "legend.active": "Active",
  "legend.busy": "Busy",
  "legend.idle": "Idle",
  "legend.approval": "Awaiting Approval",
  "legend.done": "Completed",
  "legend.offline": "Offline"
});

Object.assign(dictionary.ja, {
  "view.home": "ホーム",
  "view.actions": "ユーザー対応",
  "view.delegation": "委任状況",
  "view.progress": "進行",
  "recovery.health": "オーケストラ状態",
  "recovery.healthReady": "準備完了",
  "recovery.commandBoard": "指揮ボード",
  "recovery.commandBoardDetail": "ハンドオフ状況つきの専門AIマップ",
  "recovery.selectedAgent": "選択中のAI",
  "recovery.inspector": "インスペクター",
  "recovery.projectRoute": "プロジェクト進路",
  "recovery.secondary": "詳細",
  "recovery.secondaryTitle": "運用詳細",
  "recovery.progressAndTasks": "進行とタスクフロー",
  "recovery.supportQueues": "修理・ビジョン・指示・履歴",
  "recovery.projectRouteDetail": "プロジェクト進路の詳細",
  "home.now": "現在",
  "home.running": "稼働中のAI",
  "home.runningTitle": "稼働中のAI",
  "home.current": "現在の作業",
  "home.currentTitle": "Orquestaが今していること",
  "home.userNeed": "あなたの対応",
  "home.userNeedTitle": "あなたに必要な対応",
  "home.notifications": "通知",
  "home.notificationsTitle": "対応キュー",
  "home.commandDetail": "組織図と稼働中の専門AI構成",
  "home.context": "詳細",
  "home.inspector": "AIインスペクター",
  "home.back": "ホームへ戻る",
  "home.noRunning": "現在稼働中のAIはありません",
  "home.noNotifications": "今すぐ対応が必要な通知はありません",
  "home.open": "開く",
  "home.activeTask": "進行中タスク",
  "actions.title": "対応ワークスペース",
  "actions.detail": "通知を開くと、質問への回答、承認確認、ブロッカー確認、報告レビューをここで扱えます。",
  "progress.focusDetail": "完成マップ、現在フェーズ、タスクフローはホームではなくここで確認します。",
  "setup.focusDetail": "セットアップ、指示、履歴はホームから分けてここにまとめています。",
  "delegation.eyebrow": "委任の証跡",
  "delegation.title": "委任状況",
  "delegation.ledger": "委任台帳",
  "delegation.specialist": "専門AIハンドオフ",
  "delegation.missing": "報告未提出",
  "delegation.awaiting": "レビュー待ち",
  "delegation.direct": "直接対応例外",
  "delegation.handoff": "ハンドオフ",
  "delegation.report": "報告",
  "delegation.owner": "担当",
  "delegation.routing": "ルーティング",
  "delegation.sent": "送信済み",
  "delegation.notSent": "未送信",
  "delegation.expected": "必要",
  "delegation.notExpected": "不要",
  "delegation.present": "あり",
  "delegation.missingStatus": "未提出",
  "delegation.awaitingStatus": "レビュー待ち",
  "delegation.acceptedStatus": "受理済み",
  "delegation.directException": "直接対応例外",
  "delegation.reason": "理由",
  "delegation.reviewOwner": "レビュー担当",
  "delegation.none": "表示できる委任証跡はありません",
  "delegation.focusDetail": "タスク状態から、ハンドオフ、報告、直接対応例外の証跡を確認します。",
  "delegation.summary": "{count}件",
  "delegation.truthSummary": "専門AI {specialist}件 · 未提出 {missing}件 · レビュー待ち {awaiting}件 · 直接例外 {direct}件",
  "legend.active": "稼働中",
  "legend.busy": "作業中",
  "legend.idle": "待機中",
  "legend.approval": "承認待ち",
  "legend.done": "完了",
  "legend.offline": "オフライン"
});

Object.assign(dictionary.ja, {
  "brand.subtitle": "長期稼働するCodexチームメイトの制作司令盤",
  "load.button": "状態を読み込む",
  "load.title": "agents.json、tasks.json、events.jsonl、completion_map.json などのOrquesta状態ファイルを読み込む",
  "lang.toggle": "English",
  "sync.live": "ライブ · {count}ファイル",
  "sync.server": "自動更新 · {time}",
  "sync.sample": "サンプル状態",
  "eyebrow.attention": "注目",
  "eyebrow.progress": "進行",
  "eyebrow.now": "現在",
  "eyebrow.chain": "指揮系統",
  "eyebrow.team": "チーム",
  "eyebrow.teamMap": "指揮ボード",
  "eyebrow.work": "作業",
  "eyebrow.intent": "指示",
  "eyebrow.timeline": "履歴",
  "eyebrow.completion": "プロジェクト進路",
  "eyebrow.setup": "セットアップ",
  "eyebrow.vision": "ビジョン",
  "eyebrow.userTasks": "あなたの対応",
  "eyebrow.repairs": "修理",
  "section.progress": "作業進行",
  "section.running": "稼働中",
  "section.command": "指揮マップ",
  "section.roster": "専門AI一覧",
  "section.teamVisualizer": "チーム可視化",
  "section.tasks": "タスクフロー",
  "section.directives": "指示",
  "section.events": "最近のイベント",
  "section.completionMap": "完成マップ",
  "section.setupWizard": "初回セットアップ",
  "section.vision": "ビジョン質問",
  "section.userTasks": "ユーザー対応",
  "section.repairs": "修理カード",
  "empty.records": "まだ記録がありません",
  "attention.ready.title": "統括準備完了",
  "attention.ready.text": "表示中の作業は落ち着いています。ライブ状態を読み込むか、次の専門タスクを割り当てられます。",
  "attention.blocked.title": "{count}件のブロッカーがあります",
  "attention.review.title": "{count}件の確認待ち指示があります",
  "attention.review.text": "ユーザーと専門AIの更新に、統括側の確認が必要です。",
  "attention.active.title": "{count}件のタスクが進行中です",
  "attention.stale.title": "{count}体の稼働AIにハートビートがありません",
  "attention.encoding.title": "状態ファイルに{count}件の文字化け警告があります",
  "attention.encoding.text": "Orquestaの状態テキストが壊れている可能性があります。npm run check:encoding を実行し、対象ファイルを確認してください。",
  "metric.agents": "AI",
  "metric.tasks": "タスク",
  "metric.blocked": "停止中",
  "metric.review": "確認",
  "metric.vision": "ビジョン",
  "metric.sessions": "セッション",
  "metric.completion": "マップ",
  "metric.agents.detail": "稼働 {active} · 待機 {standby}",
  "metric.tasks.detail": "進行 {active} · 受理済み {accepted}",
  "metric.blocked.detail": "進行停止",
  "metric.review.detail": "指示 + stale",
  "metric.vision.detail": "提示可 {ready} · 下書き {draft}",
  "metric.sessions.detail": "紐づき {linked} · 未任命 {unassigned}",
  "metric.completion.detail": "完了 {done} · 進行 {active}",
  "count.total": "全{count}件",
  "count.complete": "{count}% 完了",
  "count.noTasks": "タスクなし",
  "count.running": "{count}件稼働中",
  "count.calm": "稼働なし",
  "progress.acceptedOf": "{total}件中{accepted}件が受理済み",
  "progress.detail": "進行 {active}、待機 {queued}、停止 {blocked}、レビュー中 {review}",
  "progress.accepted": "受理済み",
  "progress.active": "進行中",
  "progress.blocked": "停止中",
  "completion.definition": "完了条件",
  "completion.remaining": "残り {count}件",
  "completion.done": "完了 {count}件",
  "completion.current": "現在の焦点",
  "completion.revision": "見直し条件",
  "completion.noMap": "完成マップはまだありません",
  "completion.noMapDetail": "プロジェクト説明後に、Orquestaが完了に必要な大項目を作ります。",
  "completion.noItems": "項目未記録",
  "completion.owner": "担当",
  "team.user": "ユーザー",
  "team.userRole": "発案と承認",
  "team.floor": "指揮フロア",
  "team.currentTask": "現在のタスク",
  "team.ownedTasks": "担当タスク",
  "team.dependsOn": "依存",
  "team.collaboratesWith": "協力",
  "team.noCurrentTask": "進行中タスクなし",
  "team.noDependencies": "現在の依存なし",
  "team.noCollaborators": "他AIとの協力記録なし",
  "team.moreAgents": "+{count}体",
  "team.podAgents": "{count}体",
  "team.podActive": "{count}体稼働",
  "team.manualLayout": "手動",
  "team.dragNode": "ノードを移動",
  "team.resetSelectedLayout": "選択を戻す",
  "team.resetAllLayout": "全て戻す",
  "team.panHint": "ドラッグで移動 · ホイールでズーム",
  "team.sessionLinked": "セッション紐づき",
  "task.checks": "確認項目",
  "task.result": "結果",
  "task.none": "なし",
  "task.notAccepted": "未受理",
  "value.active": "稼働中",
  "value.in-progress": "進行中",
  "value.accepted": "受理済み",
  "value.blocked": "停止中",
  "value.queued": "待機中",
  "value.standby": "待機中",
  "value.needs-review": "レビュー待ち",
  "value.needs-orchestrator-review": "統括レビュー待ち",
  "value.live-files-loaded": "ライブ状態読み込み済み",
  "value.sample-preview": "サンプル表示",
  "value.loaded": "{time} 読み込み",
  "value.active-work": "進行中作業",
  "value.stale-heartbeat": "ハートビート未記録",
  "value.no-task": "タスクなし",
  "value.unassigned": "未割り当て",
  "value.unknown": "不明",
  "value.orchestrator": "統括",
  "value.visual-art": "ビジュアル",
  "value.implementation": "実装",
  "value.world-lore": "世界観",
  "value.playtest-qa": "プレイテストQA",
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
  "user.questionsDetail": "回答できるビジョン調整質問です。",
  "user.reviewDetail": "判断や確認が必要な指示・専門AI更新です。",
  "user.blockedDetail": "ユーザー入力がないと進めにくいタスクです。",
  "user.repairsDetail": "Failure Concierge が提案した、環境・権限まわりのユーザー側対応です。",
  "user.liaisonDetail": "User Liaison が整理した、ユーザー側で対応する作業です。",
  "user.visionReviewDetail": "回答の解釈を採用前に見直す項目です。",
  "user.reportReviewDetail": "専門AIの完了報告を、統括者が受理するか差し戻すか確認します。",
  "user.handoffDraftDetail": "専門AIスレッドへ送る作業依頼や差し戻し依頼の文面です。",
  "user.approvalWaitDetail": "専門AIが Codex の承認や権限判断を待っている項目です。",
  "handoff.title": "スレッド用ハンドオフ文面",
  "handoff.empty": "送信待ちのハンドオフ文面はありません",
  "handoff.agent": "AI",
  "handoff.thread": "スレッド",
  "handoff.mode": "種別",
  "handoff.prompt": "文面",
  "handoff.copy": "文面をコピー",
  "handoff.copied": "ハンドオフ文面をコピーしました",
  "handoff.copyError": "ハンドオフ文面をコピーできませんでした",
  "report.title": "専門AI報告レビュー",
  "report.empty": "確認待ちの専門AI報告はありません",
  "report.agent": "AI",
  "report.file": "報告書",
  "report.excerpt": "抜粋",
  "report.result": "結果",
  "report.note": "統括メモ",
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
  "review.save": "レビューを保存",
  "review.saved": "レビューを保存しました",
  "review.saveError": "レビューを保存できませんでした",
  "review.keep_as_is": "このまま採用",
  "review.revise": "書き換えて採用",
  "review.reject": "採用しない",
  "review.ask_orquesta_for_alternatives": "Orquestaに代案を出させる",
  "repair.noCards": "待機中の修理カードはありません",
  "repair.noCardsDetail": "環境、権限、品質低下回避に関わるユーザー対応が必要になったらここに表示されます。",
  "repair.why": "理由",
  "repair.userSteps": "ユーザー側でやること",
  "repair.codexCanDo": "Codex側でできること",
  "repair.risk": "リスク",
  "setup.welcome": "ようこそ",
  "setup.current": "現在の段階",
  "setup.autopilot": "自動セットアップ",
  "setup.operationReady": "準備完了",
  "setup.autopilotDetail": "プロジェクト説明と質問回答が終わると、Orquestaが初期マップと専門AI体制を準備します。",
  "setup.readyForOperation": "運用準備完了",
  "setup.readyForOperationDetail": "初期セットアップは完了しています。マップ、チーム、優先順位は運用中に調整できます。",
  "setup.autopilotDone": "自動セットアップ完了",
  "setup.autopilotWaiting": "待機中",
  "setup.answerQuestions": "質問に答える",
  "setup.finalizeAutopilot": "初期セットアップを完了",
  "setup.finishedTitle": "Orquestaは運用できます",
  "setup.finishedDetail": "初期完成マップと専門AI体制は準備済みです。ここから通常運用として調整できます。",
  "setup.project": "プロジェクト説明",
  "setup.projectTitle": "プロジェクト名",
  "setup.projectDescription": "プロジェクト説明",
  "setup.saveProject": "プロジェクト説明を保存",
  "setup.generateQuestions": "必要質問を生成",
  "setup.approveMap": "完成マップを承認",
  "setup.generateSpecialists": "専門AI候補を生成",
  "setup.saveSpecialistPlan": "専門AI判断を保存",
  "setup.specialistPlan": "専門AI候補",
  "setup.productionStart": "制作開始",
  "setup.prepareProduction": "ハンドオフタスクを準備",
  "setup.productionLegend": "状態の見方",
  "setup.noSessionsCreated": "セッション作成なし",
  "setup.localOnly": "保存はlocalhostのダッシュボードで使えます。"
});

Object.assign(dictionary.ja, {
  "value.done": "完了",
  "value.completed": "完了",
  "value.review": "レビュー中",
  "value.awaiting-review": "レビュー待ち",
  "value.ready-for-operation": "運用準備完了",
  "value.specialist-required": "専門AI必須",
  "value.direct-exception": "直接対応例外",
  "value.missing": "未提出",
  "value.present": "あり",
  "value.sent": "送信済み",
  "value.not-sent": "未送信",
  "value.expected": "必要",
  "value.not-expected": "不要",
  "value.busy": "作業中",
  "value.idle": "待機中",
  "value.offline": "オフライン",
  "value.thread": "スレッド",
  "value.dashboard-ux": "ダッシュボード設計",
  "value.bootstrap-qa": "初期設定検証",
  "value.docs-release": "文書公開",
  "value.protocol-architect": "設計規約",
  "value.user": "ユーザー"
});

Object.assign(dictionary.en, {
  "section.foundationAudit": "Foundation Audit",
  "foundation.detail": "Event-driven foundation trigger checks and stale-state visibility.",
  "foundation.status": "Audit status",
  "foundation.sessions": "Session snapshot",
  "foundation.generated": "Generated",
  "foundation.wakeRequired": "Wake required",
  "foundation.triggerReady": "Trigger ready",
  "foundation.standbyStale": "Standby stale",
  "foundation.noAudit": "No trigger audit has been generated yet.",
  "foundation.noReason": "No active trigger; event-driven standby is expected.",
  "value.wake-needed": "wake needed",
  "value.wake-required": "wake required",
  "value.trigger-ready": "trigger ready",
  "value.standby-stale": "standby stale",
  "value.not-run": "not run",
  "value.fresh": "fresh",
  "value.stale": "stale"
});

Object.assign(dictionary.ja, {
  "section.foundationAudit": "基盤AI監査",
  "foundation.detail": "イベント駆動の基盤AIを起こす条件と古い状態を確認します。",
  "foundation.status": "監査状態",
  "foundation.sessions": "セッション同期",
  "foundation.generated": "生成時刻",
  "foundation.wakeRequired": "起動必要",
  "foundation.triggerReady": "起動条件あり",
  "foundation.standbyStale": "待機が古い",
  "foundation.noAudit": "基盤AI監査はまだ生成されていません。",
  "foundation.noReason": "起動条件はありません。イベント駆動の待機状態です。",
  "value.wake-needed": "起動必要",
  "value.wake-required": "起動必須",
  "value.trigger-ready": "起動条件あり",
  "value.standby-stale": "待機が古い",
  "value.not-run": "未実行",
  "value.fresh": "新しい",
  "value.stale": "古い"
});

Object.assign(dictionary.en, {
  "view.control": "Control Plane",
  "control.title": "Control Plane",
  "control.eyebrow": "control evidence",
  "control.detail": "Capacity, evidence, and dispatch records stay separate from Home.",
  "control.capacity": "Capacity",
  "control.audit": "Audit",
  "control.evidence": "Evidence",
  "control.loading": "Loading control state",
  "control.empty": "No capacity records have been created yet.",
  "control.legacy": "Capacity state is unavailable. This is not a healthy-capacity claim.",
  "control.mode": "Orchestra mode",
  "control.openCircuits": "Open circuits",
  "control.userReview": "User review",
  "control.auditTime": "Last audit",
  "control.scope": "Scope",
  "control.capacityState": "Capacity",
  "control.dispatch": "Dispatch",
  "control.circuit": "Circuit",
  "control.model": "Fallback / model",
  "control.next": "Next",
  "control.noAction": "No action recorded",
  "control.actualUnknown": "Actual model: unknown",
  "control.actualVerified": "Actual model",
  "control.requested": "Requested model",
  "control.recommended": "Recommended model",
  "control.applied": "Applied model evidence",
  "control.none": "No record",
  "control.select": "Select a capacity record to inspect evidence.",
  "control.lifecycle": "Dispatch lifecycle",
  "control.queued": "Queued",
  "control.dispatchAccepted": "Dispatch accepted; turn start unconfirmed",
  "control.turnStarted": "Turn start observed",
  "control.progressObserved": "Progress observed",
  "control.reportProduced": "Report produced",
  "control.notObserved": "No evidence",
  "control.evidenceLevel": "Evidence",
  "control.classification": "Classification",
  "control.cooldown": "Cooldown / probe",
  "control.fallback": "Fallback evidence",
  "control.completion": "Completion envelope",
  "control.findings": "Audit findings",
  "control.noFindings": "No matching audit finding.",
  "control.noFallback": "No fallback evidence recorded.",
  "control.noEnvelope": "No completion envelope recorded.",
  "control.modelPolicy": "Model policy",
  "control.policyRules": "Route rules",
  "control.recovered": "Capacity recovery recorded",
  "control.paused": "Orquesta is paused",
  "control.approval": "Fallback review needs attention",
  "control.showEvidence": "View evidence",
  "value.paused": "paused",
  "value.available": "available",
  "value.unavailable": "unavailable",
  "value.cooldown": "cooldown",
  "value.probing": "probing",
  "value.open": "open",
  "value.closed": "closed",
  "value.half-open": "half-open",
  "value.report-produced": "report produced",
  "value.dispatch-accepted": "dispatch accepted",
  "value.turn-started": "turn started",
  "value.progress-observed": "progress observed",
  "value.normal": "normal",
  "value.degraded": "degraded",
  "value.e0": "E0 no evidence",
  "value.e1": "E1 ambiguous signal",
  "value.e2": "E2 correlated repeated failure",
  "value.e3": "E3 confirmed"
});

Object.assign(dictionary.ja, {
  "view.control": "Control Plane",
  "control.title": "Control Plane",
  "control.eyebrow": "制御証拠",
  "control.detail": "容量、証拠、dispatch記録はHomeと分けて確認します。",
  "control.capacity": "容量",
  "control.audit": "監査",
  "control.evidence": "証拠",
  "control.loading": "制御状態を読み込み中",
  "control.empty": "容量記録はまだありません。",
  "control.legacy": "容量状態を取得できません。これは利用可能の主張ではありません。",
  "control.mode": "Orquestaの状態",
  "control.openCircuits": "開放中の回路",
  "control.userReview": "ユーザー確認",
  "control.auditTime": "最終監査",
  "control.scope": "対象",
  "control.capacityState": "容量",
  "control.dispatch": "Dispatch",
  "control.circuit": "回路",
  "control.model": "Fallback / モデル",
  "control.next": "次の対応",
  "control.noAction": "対応記録なし",
  "control.actualUnknown": "実モデル: 不明",
  "control.actualVerified": "実モデル",
  "control.requested": "要求モデル",
  "control.recommended": "推奨モデル",
  "control.applied": "適用モデルの証拠",
  "control.none": "記録なし",
  "control.select": "容量記録を選ぶと証拠の詳細を確認できます。",
  "control.lifecycle": "Dispatchの段階",
  "control.queued": "キュー記録済み",
  "control.dispatchAccepted": "送信受理。ターン開始は未確認",
  "control.turnStarted": "ターン開始確認",
  "control.progressObserved": "進行確認",
  "control.reportProduced": "レポート確認",
  "control.notObserved": "証拠なし",
  "control.evidenceLevel": "証拠レベル",
  "control.classification": "判定種別",
  "control.cooldown": "再試行待ち / probe",
  "control.fallback": "Fallback証拠",
  "control.completion": "Completion envelope",
  "control.findings": "監査finding",
  "control.noFindings": "対応する監査findingはありません。",
  "control.noFallback": "Fallback証拠は記録されていません。",
  "control.noEnvelope": "Completion envelopeは記録されていません。",
  "control.modelPolicy": "モデル方針",
  "control.policyRules": "ルール",
  "control.recovered": "容量の回復記録があります",
  "control.paused": "Orquestaは停止中です",
  "control.approval": "Fallback確認が必要です",
  "control.showEvidence": "証拠を見る",
  "value.paused": "停止",
  "value.available": "開始可能を確認",
  "value.unavailable": "開始不能",
  "value.cooldown": "再試行待ち",
  "value.probing": "再開確認中",
  "value.open": "開放",
  "value.closed": "閉鎖",
  "value.half-open": "半開放",
  "value.report-produced": "レポート確認",
  "value.dispatch-accepted": "送信受理",
  "value.turn-started": "ターン開始確認",
  "value.progress-observed": "進行確認",
  "value.normal": "通常",
  "value.degraded": "縮退",
  "value.e0": "E0 証拠なし",
  "value.e1": "E1 曖昧な信号",
  "value.e2": "E2 相関した反復失敗",
  "value.e3": "E3 確認済み"
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

function renderProgressiveRevealControl(records, visibleRecords, expanded, toggleAction) {
  if (records.length <= visibleRecords.length && !expanded) return "";
  const hiddenCount = Math.max(0, records.length - visibleRecords.length);
  return `
    <div class="list-collapse-control delegation-reveal-control">
      <span>${escapeHtml(t("list.showing", { shown: visibleRecords.length, total: records.length }))}</span>
      <button type="button" data-action="${escapeHtml(toggleAction)}">
        ${escapeHtml(expanded ? t("list.showLess") : t("list.showMore", { count: hiddenCount }))}
      </button>
    </div>
  `;
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
  const metricsNode = $("metrics");
  if (!metricsNode) return;
  const { blockedTasks, activeTasks, reviewDirectives, activeAgents, staleAgents } = getSignals();
  const accepted = state.tasks.filter((task) => task.state === "accepted").length;
  const standby = state.agents.filter((agent) => agent.status === "standby").length;
  const visionStats = getVisionStats();
  const linkedSessions = state.agents.filter((agent) => agent.codex_session).length;
  const unassignedSessions = state.agents.filter((agent) => agent.role === "session").length;
  const completion = completionMapCounts();
  metricsNode.innerHTML = [
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

function userActionCategoryLabel(category) {
  const labels = {
    "ready-questions": t("user.readyQuestions"),
    "approval-waits": t("user.approvalWaits"),
    "handoff-drafts": t("user.handoffDrafts"),
    "vision-reviews": t("user.visionReviews"),
    "report-reviews": t("user.reportReviews"),
    "review-directives": t("user.reviewDirectives"),
    "blocked-tasks": t("user.blockedTasks"),
    "repair-cards": t("user.repairCards"),
    "liaison-tasks": t("user.liaisonTasks")
  };
  return labels[category] || t("actions.all");
}

function userActionPriorityRank(priority) {
  return { p0: 0, p1: 1, p2: 2, p3: 3 }[String(priority || "p3").toLowerCase()] ?? 3;
}

function actionTargetId(category, id) {
  return `${category}:${id || "all"}`;
}

function isFocusedActionTarget(category, id) {
  if (!state.actionFocusCategory) return false;
  if (state.actionFocusCategory !== category) return false;
  return !state.actionFocusId || state.actionFocusId === actionTargetId(category, id);
}

function actionTargetAttrs(category, id) {
  const targetId = actionTargetId(category, id);
  return `data-action-category="${escapeHtml(category)}" data-action-target-id="${escapeHtml(targetId)}"`;
}

function actionTargetClass(category, id) {
  return isFocusedActionTarget(category, id) ? " is-deeplink-target" : "";
}

function buildUserActionModel() {
  const stats = getUserTaskStats();
  const items = [];
  const add = (item) => {
    items.push({
      status: "ready",
      source: "dashboard",
      detail: "",
      ...item
    });
  };

  stats.approvalWaits.forEach((task) => add({
    id: actionTargetId("approval-waits", task.user_task_id),
    category: "approval-waits",
    priority: "p0",
    status: task.status || "ready",
    source: task.source || "approval_wait",
    title: task.title || t("user.approvalWaits"),
    detail: task.prompt || task.requested_action || t("user.approvalWaitDetail"),
    sourceId: task.user_task_id
  }));

  stats.repairCards.forEach((card) => add({
    id: actionTargetId("repair-cards", card.action_id || card.title),
    category: "repair-cards",
    priority: "p0",
    status: card.status || "ready",
    source: "repair_card",
    title: card.title || card.summary || t("user.repairCards"),
    detail: card.why_this_helps || t("user.repairsDetail"),
    sourceId: card.action_id || card.title
  }));

  stats.blockedTasks.forEach((task) => add({
    id: actionTargetId("blocked-tasks", task.task_id),
    category: "blocked-tasks",
    priority: "p0",
    status: task.state || "blocked",
    source: "task",
    title: task.title || task.task_id || t("user.blockedTasks"),
    detail: (task.blocked_by || []).join(", ") || t("user.blockedDetail"),
    sourceId: task.task_id
  }));

  stats.reviewDirectives.forEach((directive, index) => add({
    id: actionTargetId("review-directives", directive.directive_id || directive.id || index),
    category: "review-directives",
    priority: "p0",
    status: directive.status || "review",
    source: "directive",
    title: directive.title || directive.summary || t("user.reviewDirectives"),
    detail: directive.detail || directive.note || t("user.reviewDetail"),
    sourceId: directive.directive_id || directive.id || index
  }));

  stats.readyQuestions.forEach((question) => add({
    id: actionTargetId("ready-questions", question.question_id),
    category: "ready-questions",
    priority: question.priority === "high" ? "p0" : "p1",
    status: question.status || "ready",
    source: "vision_question",
    title: question.question_id ? `${question.question_id} ${question.question || ""}` : question.question || t("user.readyQuestions"),
    detail: question.why_it_matters || t("user.questionsDetail"),
    sourceId: question.question_id
  }));

  stats.visionReviewTasks.forEach((task) => add({
    id: actionTargetId("vision-reviews", task.user_task_id),
    category: "vision-reviews",
    priority: "p1",
    status: task.status || "ready",
    source: task.source || "vision_answer_review",
    title: task.title || t("user.visionReviews"),
    detail: task.prompt || t("user.visionReviewDetail"),
    sourceId: task.user_task_id
  }));

  stats.liaisonTasks.forEach((task) => add({
    id: actionTargetId("liaison-tasks", task.user_task_id),
    category: "liaison-tasks",
    priority: "p1",
    status: task.status || "ready",
    source: task.source || "user_task",
    title: task.title || t("user.liaisonTasks"),
    detail: task.prompt || t("user.liaisonDetail"),
    sourceId: task.user_task_id
  }));

  stats.handoffDrafts.forEach((draft) => add({
    id: actionTargetId("handoff-drafts", draft.handoff_id || draft.task_id),
    category: "handoff-drafts",
    priority: "p2",
    status: draft.task_state || "queued",
    source: "handoff_draft",
    title: draft.title || t("user.handoffDrafts"),
    detail: draft.agent_display_name || draft.agent_id || t("user.handoffDraftDetail"),
    sourceId: draft.handoff_id || draft.task_id
  }));

  stats.reportReviews.forEach((review) => add({
    id: actionTargetId("report-reviews", review.task_id),
    category: "report-reviews",
    priority: "p2",
    status: review.state || "needs_review",
    source: "report_review",
    title: review.title || t("user.reportReviews"),
    detail: review.owner_display_name || review.owner_agent_id || t("user.reportReviewDetail"),
    sourceId: review.task_id
  }));

  items.sort((a, b) => userActionPriorityRank(a.priority) - userActionPriorityRank(b.priority)
    || String(a.category).localeCompare(String(b.category))
    || String(a.id).localeCompare(String(b.id)));

  return { stats, items };
}

function applyActionFocus(category, targetId) {
  state.actionFocusCategory = category || null;
  state.actionFocusId = targetId || null;
  if (category === "ready-questions" && targetId) {
    const questionId = String(targetId).replace(/^ready-questions:/, "");
    if (questionId && questionId !== "all") state.selectedQuestionId = questionId;
  }
  if (category === "handoff-drafts" && targetId) state.showAllActionHandoffs = true;
  if (category === "report-reviews" && targetId) state.showAllActionReports = true;
}

function actionFocusSelector() {
  if (!state.actionFocusCategory) return null;
  if (state.actionFocusId) return `[data-action-target-id="${CSS.escape(state.actionFocusId)}"]:not(.action-inbox-item)`;
  return `[data-action-section="${CSS.escape(state.actionFocusCategory)}"]`;
}

function scheduleActionFocus() {
  if (state.currentView !== "actions" || !state.actionFocusCategory) return;
  window.setTimeout(() => {
    const selector = actionFocusSelector();
    let target = selector ? document.querySelector(selector) : null;
    if (!target && state.actionFocusCategory) {
      target = document.querySelector(`[data-action-category="${CSS.escape(state.actionFocusCategory)}"][data-action-target-id]`);
    }
    if (!target) return;
    target.classList.add("is-deeplink-target");
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    const focusable = target.matches("button, textarea, input, select, a, [tabindex]")
      ? target
      : target.querySelector("button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [tabindex]");
    (focusable || target).focus?.({ preventScroll: true });
    window.setTimeout(() => target.classList.remove("is-deeplink-target"), 1700);
  }, 40);
}

function getFailureStats() {
  const incidents = state.failures?.incidents || [];
  const repairCards = state.failures?.userActions || [];
  const openIncidents = incidents.filter((incident) => !["resolved", "retired"].includes(String(incident.status || "").toLowerCase()));
  const readyCards = repairCards.filter((action) => !["resolved", "skipped", "retired"].includes(String(action.status || "").toLowerCase()));
  return { incidents, repairCards, openIncidents, readyCards };
}

function activeTaskForHome() {
  return state.tasks.find((task) => task.state === "active")
    || state.tasks.find((task) => String(task.state || "").includes("review"))
    || state.tasks.find((task) => task.state === "blocked")
    || null;
}

function renderFoundationAudit() {
  const node = $("foundationAudit");
  if (!node) return;
  const audit = state.triggerAudit || {};
  const agents = audit.foundation_agents || [];
  if (!audit.status || (!agents.length && audit.status === "not_run")) {
    node.innerHTML = `<div class="empty compact-empty">${escapeHtml(t("foundation.noAudit"))}</div>`;
    return;
  }
  const summary = audit.summary || {};
  const sessions = audit.sessions || {};
  const generated = audit.generated_at || audit.updated_at || "n/a";
  const sessionDetail = sessions.status
    ? `${valueLabel(sessions.status)}${Number.isFinite(sessions.age_minutes) ? ` · ${Math.round(sessions.age_minutes)}m` : ""}`
    : "n/a";
  node.innerHTML = `
    <div class="foundation-audit-summary">
      <div><span>${escapeHtml(t("foundation.status"))}</span><strong>${escapeHtml(valueLabel(audit.status || "not_run"))}</strong></div>
      <div><span>${escapeHtml(t("foundation.sessions"))}</span><strong>${escapeHtml(sessionDetail)}</strong></div>
      <div><span>${escapeHtml(t("foundation.generated"))}</span><strong>${escapeHtml(generated)}</strong></div>
    </div>
    <div class="foundation-audit-counts">
      ${pill(`${t("foundation.wakeRequired")}: ${summary.wake_required || 0}`, summary.wake_required ? "blocked" : "accepted")}
      ${pill(`${t("foundation.triggerReady")}: ${summary.trigger_ready || 0}`, summary.trigger_ready ? "active" : "accepted")}
      ${pill(`${t("foundation.standbyStale")}: ${summary.standby_stale || 0}`, summary.standby_stale ? "queued" : "accepted")}
    </div>
    <div class="foundation-audit-list">
      ${agents.length ? agents.map((agent) => `
        <article class="foundation-audit-row ${statusClass(agent.trigger_status || "clear")}">
          <div>
            <b>${escapeHtml(agent.agent_id || agent.role || "foundation")}</b>
            <span>${escapeHtml(agent.reasons?.[0] || t("foundation.noReason"))}</span>
          </div>
          <em>${escapeHtml(valueLabel(agent.trigger_status || "clear"))}</em>
        </article>
      `).join("") : `<div class="empty compact-empty">${escapeHtml(t("foundation.noReason"))}</div>`}
    </div>
  `;
}

function renderHomeOverview() {
  const currentNode = $("currentWorkSummary");
  const needNode = $("userNeedSummary");
  const queueNode = $("notificationQueue");
  if (!currentNode || !needNode || !queueNode) return;

  const task = activeTaskForHome();
  currentNode.innerHTML = task ? `
    <article class="current-work-card ${statusClass(task.state)}">
      <div>
        <span class="eyebrow">${escapeHtml(task.task_id || t("home.activeTask"))}</span>
        <h3>${escapeHtml(task.title || t("home.activeTask"))}</h3>
        <p>${escapeHtml(task.owner_agent_id || t("value.unassigned"))} · ${escapeHtml(delegationStatusLabel(task))}</p>
      </div>
      <button type="button" data-action="open-view" data-view-target="delegation">${escapeHtml(t("home.open"))}</button>
    </article>
  ` : `<div class="empty compact-empty">${escapeHtml(t("team.noCurrentTask"))}</div>`;

  const stats = getUserTaskStats();
  const blocked = stats.blockedTasks.length + stats.approvalWaits.length + stats.repairCards.length;
  needNode.innerHTML = `
    <div class="user-need-grid">
      <button type="button" data-action="open-view" data-view-target="actions" data-focus-label="${escapeHtml(t("user.approvalWaits"))}" data-action-category="approval-waits" data-action-id="${escapeHtml(stats.approvalWaits[0] ? actionTargetId("approval-waits", stats.approvalWaits[0].user_task_id) : "")}">
        <strong>${stats.approvalWaits.length}</strong><span>${escapeHtml(t("user.approvalWaits"))}</span>
      </button>
      <button type="button" data-action="open-view" data-view-target="actions" data-focus-label="${escapeHtml(t("user.readyQuestions"))}" data-action-category="ready-questions" data-action-id="${escapeHtml(stats.readyQuestions[0] ? actionTargetId("ready-questions", stats.readyQuestions[0].question_id) : "")}">
        <strong>${stats.readyQuestions.length}</strong><span>${escapeHtml(t("user.readyQuestions"))}</span>
      </button>
      <button type="button" data-action="open-view" data-view-target="actions" data-focus-label="${escapeHtml(t("user.reportReviews"))}" data-action-category="report-reviews" data-action-id="${escapeHtml(stats.reportReviews[0] ? actionTargetId("report-reviews", stats.reportReviews[0].task_id) : "")}">
        <strong>${stats.reportReviews.length}</strong><span>${escapeHtml(t("user.reportReviews"))}</span>
      </button>
      <button type="button" data-action="open-view" data-view-target="actions" data-focus-label="${escapeHtml(t("user.blockedTasks"))}" data-action-category="blocked-tasks" data-action-id="${escapeHtml(stats.blockedTasks[0] ? actionTargetId("blocked-tasks", stats.blockedTasks[0].task_id) : "")}">
        <strong>${blocked}</strong><span>${escapeHtml(t("user.blockedTasks"))}</span>
      </button>
    </div>
  `;

  const notifications = compactHomeNotifications(buildHomeNotifications(stats));
  queueNode.innerHTML = notifications.length
    ? notifications.map(renderHomeNotification).join("")
    : `<div class="empty compact-empty">${escapeHtml(t("home.noNotifications"))}</div>`;
}

function compactHomeNotifications(notices) {
  const selected = [];
  ["control", "actions", "delegation", "progress"].forEach((view) => {
    const notice = notices.find((item) => item.view === view && !selected.includes(item));
    if (notice) selected.push(notice);
  });
  notices.forEach((notice) => {
    if (selected.length < 3 && !selected.includes(notice)) selected.push(notice);
  });
  return selected.slice(0, 3);
}

function buildHomeNotifications(stats) {
  const truth = delegationTruth();
  const notices = [];
  const capacity = state.capacity;
  const orchestra = capacity?.orchestra || {};
  if (orchestra.mode === "paused") {
    const taskId = Array.isArray(orchestra.affected_task_ids) ? orchestra.affected_task_ids[0] : null;
    const dispatch = controlDispatches().find((item) => item.task_id === taskId);
    const record = controlCapacityRecords().find((item) => item.scope?.agent_id === dispatch?.agent_id || item.scope?.thread_id === dispatch?.thread_id);
    notices.push({ title: t("control.paused"), count: Array.isArray(orchestra.affected_task_ids) ? orchestra.affected_task_ids.length : 1, detail: orchestra.reason_codes?.[0] || t("control.detail"), view: "control", tone: "blocked", controlRecordId: record?.capacity_id || "" });
  }
  const fallbackFinding = controlFindings().find((finding) => /fallback/i.test(String(finding.category || "") + String(finding.code || "")) && /approval|review/i.test(String(finding.recommended_action || "") + String(finding.message || "")));
  if (fallbackFinding) notices.push({ title: t("control.approval"), count: 1, detail: fallbackFinding.message || fallbackFinding.code, view: "control", tone: "blocked", controlRecordId: fallbackFinding.capacity_id || "" });
  const recovered = Array.isArray(capacity?.notifications) ? capacity.notifications.find((item) => item.status === "recovered" && !item.resolved_at) : null;
  if (recovered) notices.push({ title: t("control.recovered"), count: 1, detail: recovered.summary || recovered.notification_key || t("control.detail"), view: "control", tone: "active", controlRecordId: recovered.capacity_id || "" });
  if (stats.approvalWaits.length) notices.push({ title: t("user.approvalWaits"), count: stats.approvalWaits.length, detail: t("user.approvalWaitDetail"), view: "actions", tone: "blocked", category: "approval-waits", actionId: actionTargetId("approval-waits", stats.approvalWaits[0].user_task_id) });
  if (stats.readyQuestions.length) notices.push({ title: t("user.readyQuestions"), count: stats.readyQuestions.length, detail: t("user.questionsDetail"), view: "actions", tone: "active", category: "ready-questions", actionId: actionTargetId("ready-questions", stats.readyQuestions[0].question_id) });
  if (stats.reportReviews.length) notices.push({ title: t("user.reportReviews"), count: stats.reportReviews.length, detail: t("user.reportReviewDetail"), view: "actions", tone: "blocked", category: "report-reviews", actionId: actionTargetId("report-reviews", stats.reportReviews[0].task_id) });
  if (stats.repairCards.length) notices.push({ title: t("user.repairCards"), count: stats.repairCards.length, detail: t("user.repairsDetail"), view: "actions", tone: "blocked", category: "repair-cards", actionId: actionTargetId("repair-cards", stats.repairCards[0].action_id || stats.repairCards[0].title) });
  if (stats.handoffDrafts.length) notices.push({ title: t("user.handoffDrafts"), count: stats.handoffDrafts.length, detail: t("user.handoffDraftDetail"), view: "actions", tone: "active", category: "handoff-drafts", actionId: actionTargetId("handoff-drafts", stats.handoffDrafts[0].handoff_id || stats.handoffDrafts[0].task_id) });
  if (truth.missing.length) notices.push({ title: t("delegation.missing"), count: truth.missing.length, detail: t("delegation.focusDetail"), view: "delegation", tone: "blocked" });
  if (truth.direct.length) notices.push({ title: t("delegation.direct"), count: truth.direct.length, detail: t("delegation.focusDetail"), view: "delegation", tone: "direct-exception" });
  const blockedTasks = state.tasks.filter((task) => task.state === "blocked" || (task.blocked_by || []).length);
  if (blockedTasks.length) notices.push({ title: t("metric.blocked"), count: blockedTasks.length, detail: blockedTasks[0]?.title || t("task.none"), view: "progress", tone: "blocked" });
  return notices;
}

function renderHomeNotification(item) {
  return `
    <button type="button" class="notification-card ${item.tone || "active"}" data-action="open-view" data-view-target="${escapeHtml(item.view)}" data-focus-label="${escapeHtml(item.title)}" ${item.category ? `data-action-category="${escapeHtml(item.category)}"` : ""} ${item.actionId ? `data-action-id="${escapeHtml(item.actionId)}"` : ""} ${item.controlRecordId ? `data-control-record-id="${escapeHtml(item.controlRecordId)}"` : ""}>
      <strong>${escapeHtml(item.count)}</strong>
      <span>
        <b>${escapeHtml(item.title)}</b>
        <small>${escapeHtml(item.detail || "")}</small>
      </span>
      <em>${escapeHtml(t("home.open"))}</em>
    </button>
  `;
}

function renderViewSwitch() {
  const availableViews = new Set([...document.querySelectorAll("[data-view-target]")].map((button) => button.dataset.viewTarget));
  if (!availableViews.has(state.currentView)) state.currentView = "home";
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
    <section class="vision-review-board action-source-board" data-action-section="vision-reviews">
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
          <article class="vision-review-card ${statusClass(task.status)}${actionTargetClass("vision-reviews", task.user_task_id)}" ${actionTargetAttrs("vision-reviews", task.user_task_id)} tabindex="-1">
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

function renderSpecialistReportReviews(reviews, options = {}) {
  const canSave = ["localhost", "127.0.0.1"].includes(window.location.hostname);
  if (!reviews.length) return "";
  const limit = options.limit || 2;
  const expanded = Boolean(options.expanded);
  const visibleReviews = expanded ? reviews : reviews.slice(0, limit);

  return `
    <section class="vision-review-board report-review-board action-shelf" data-action-section="report-reviews">
      <div class="section-title compact-title">
        <div>
          <span class="eyebrow">${escapeHtml(t("report.title"))}</span>
          <h3>${escapeHtml(t("user.reportReviews"))}</h3>
        </div>
      </div>
      ${state.reportReviewStatus?.message ? `<div class="answer-status ${escapeHtml(state.reportReviewStatus.type || "")}">${escapeHtml(state.reportReviewStatus.message)}</div>` : ""}
      ${visibleReviews.map((review) => {
        const draft = state.reportReviewDrafts[review.task_id] || {};
        const choices = ["accept", "request_changes", "hold"];
        return `
          <article class="vision-review-card report-review-card ${statusClass(review.state)}${actionTargetClass("report-reviews", review.task_id)}" ${actionTargetAttrs("report-reviews", review.task_id)} tabindex="-1">
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
      ${reviews.length > limit ? renderProgressiveRevealControl(reviews, visibleReviews, expanded, "toggle-action-reports") : ""}
    </section>
  `;
}

function renderHandoffDrafts(drafts, options = {}) {
  if (!drafts.length) return "";
  const limit = options.limit || 2;
  const expanded = Boolean(options.expanded);
  const visibleDrafts = expanded ? drafts : drafts.slice(0, limit);

  return `
    <section class="vision-review-board handoff-draft-board action-shelf" data-action-section="handoff-drafts">
      <div class="section-title compact-title">
        <div>
          <span class="eyebrow">${escapeHtml(t("handoff.title"))}</span>
          <h3>${escapeHtml(t("user.handoffDrafts"))}</h3>
        </div>
      </div>
      ${state.handoffStatus?.message ? `<div class="answer-status ${escapeHtml(state.handoffStatus.type || "")}">${escapeHtml(state.handoffStatus.message)}</div>` : ""}
      ${visibleDrafts.map((draft) => `
        <article class="vision-review-card handoff-draft-card ${statusClass(draft.task_state)}${actionTargetClass("handoff-drafts", draft.handoff_id || draft.task_id)}" ${actionTargetAttrs("handoff-drafts", draft.handoff_id || draft.task_id)} tabindex="-1">
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
      ${drafts.length > limit ? renderProgressiveRevealControl(drafts, visibleDrafts, expanded, "toggle-action-handoffs") : ""}
    </section>
  `;
}

function approvalTypeLabel(type) {
  return t(`approval.${type}`) || valueLabel(type);
}

function renderApprovalWaits(tasks) {
  if (!tasks.length) return "";

  return `
    <section class="vision-review-board approval-wait-board action-source-board" data-action-section="approval-waits">
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
          <article class="vision-review-card approval-wait-card ${statusClass(task.status)}${actionTargetClass("approval-waits", task.user_task_id)}" ${actionTargetAttrs("approval-waits", task.user_task_id)} tabindex="-1">
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

function isDelegationTaskOpen(task) {
  return ["active", "blocked", "needs_review", "needs-review", "accepted"].includes(String(task.state || "").toLowerCase());
}

function reportStateForTask(task) {
  if (!task.specialist_report_required) return "not_expected";
  if (!task.specialist_report_path) return "missing";
  if (String(task.state || "").toLowerCase() === "accepted") return "accepted";
  if (String(task.state || "").toLowerCase().includes("review")) return "awaiting";
  if (task.completed_at || task.result_summary) return "present";
  return "missing";
}

function delegationTruth() {
  const visibleTasks = state.tasks.filter(isDelegationTaskOpen);
  const specialist = visibleTasks.filter((task) => task.routing_class === "specialist_required");
  const direct = visibleTasks.filter((task) => task.routing_class === "direct_exception");
  const missing = specialist.filter((task) => reportStateForTask(task) === "missing");
  const awaiting = specialist.filter((task) => ["awaiting", "present"].includes(reportStateForTask(task)));
  return { specialist, direct, missing, awaiting };
}

function delegationStatusLabel(task) {
  const reportState = reportStateForTask(task);
  if (task.routing_class === "direct_exception") return t("delegation.directException");
  if (reportState === "accepted") return t("delegation.acceptedStatus");
  if (reportState === "awaiting" || reportState === "present") return t("delegation.awaitingStatus");
  if (reportState === "missing") return t("delegation.missingStatus");
  return valueLabel(task.routing_class || task.state || "unknown");
}

function delegationTone(task) {
  if (task.routing_class === "direct_exception") return "direct-exception";
  const reportState = reportStateForTask(task);
  if (reportState === "missing") return "missing-report";
  if (reportState === "accepted") return "accepted";
  if (reportState === "awaiting" || reportState === "present") return "awaiting-report";
  return "standby";
}

function tasksForAgentDelegation(agentId) {
  return state.tasks
    .filter((task) => isDelegationTaskOpen(task) && task.owner_agent_id === agentId)
    .filter((task) => task.routing_class === "specialist_required" || task.routing_class === "direct_exception");
}

function renderDelegationTruth() {
  const node = $("delegationTruthSummary") || $("delegationTruth");
  if (!node) return;
  const truth = delegationTruth();
  const cards = [
    [t("delegation.specialist"), truth.specialist.length, "active"],
    [t("delegation.missing"), truth.missing.length, truth.missing.length ? "blocked" : "standby"],
    [t("delegation.awaiting"), truth.awaiting.length, truth.awaiting.length ? "active" : "standby"],
    [t("delegation.direct"), truth.direct.length, truth.direct.length ? "direct-exception" : "standby"]
  ];
  const focus = [...truth.missing, ...truth.awaiting, ...truth.direct];
  const limit = 5;
  const visibleFocus = state.showAllDelegationTruth ? focus : focus.slice(0, limit);
  node.classList.toggle("is-collapsed", !state.showAllDelegationTruth && focus.length > limit);
  node.innerHTML = `
    <div class="delegation-stat-grid">
      ${cards.map(([label, count, tone]) => `
        <div class="delegation-stat ${tone}">
          <strong>${count}</strong>
          <span>${escapeHtml(label)}</span>
        </div>
      `).join("")}
    </div>
    <div class="delegation-focus-list" data-delegation-reveal="truth">
      ${visibleFocus.length ? visibleFocus.map((task) => renderDelegationMiniTask(task)).join("") : `<div class="empty">${escapeHtml(t("delegation.none"))}</div>`}
    </div>
    ${focus.length > limit ? renderProgressiveRevealControl(focus, visibleFocus, state.showAllDelegationTruth, "toggle-delegation-truth") : ""}
  `;
}

function renderDelegationMiniTask(task) {
  return `
    <article class="delegation-mini ${delegationTone(task)}" data-delegation-task-id="${escapeHtml(task.task_id)}">
      <div>
        <b>${escapeHtml(task.task_id || "task")}</b>
        <span>${escapeHtml(task.owner_agent_id || t("value.unassigned"))}</span>
      </div>
      <em>${escapeHtml(delegationStatusLabel(task))}</em>
    </article>
  `;
}

function renderDelegationLedger() {
  const node = $("delegationLedger");
  if (!node) return;
  const truth = delegationTruth();
  const rows = [...truth.specialist, ...truth.direct]
    .sort((a, b) => String(b.handoff_sent_at || b.started_at || b.created_at || "").localeCompare(String(a.handoff_sent_at || a.started_at || a.created_at || "")));
  const limit = 6;
  const visibleRows = state.showAllDelegationLedger ? rows : rows.slice(0, limit);
  node.classList.toggle("is-collapsed", !state.showAllDelegationLedger && rows.length > limit);
  node.innerHTML = `
    ${visibleRows.length
      ? visibleRows.map((task) => renderDelegationLedgerRow(task)).join("")
      : `<div class="empty">${escapeHtml(t("delegation.none"))}</div>`}
    ${rows.length > limit ? renderProgressiveRevealControl(rows, visibleRows, state.showAllDelegationLedger, "toggle-delegation-ledger") : ""}
  `;
}

function renderDelegationLedgerRow(task) {
  const reportState = reportStateForTask(task);
  return `
    <article class="delegation-row ${delegationTone(task)}" data-delegation-row-id="${escapeHtml(task.task_id)}">
      <div class="delegation-row-head">
        <div>
          <span class="eyebrow">${escapeHtml(task.task_id || "task")}</span>
          <h3>${escapeHtml(task.title || "")}</h3>
        </div>
        <div class="meta">
          ${pill(task.routing_class || "unknown", task.routing_class || "unknown")}
          ${pill(delegationStatusLabel(task), delegationTone(task))}
        </div>
      </div>
      <div class="delegation-fields">
        <div><b>${escapeHtml(t("delegation.owner"))}</b><span>${escapeHtml(task.owner_agent_id || t("value.unassigned"))}</span></div>
        <div><b>${escapeHtml(t("delegation.handoff"))}</b><span>${escapeHtml(task.handoff_sent_at ? `${t("delegation.sent")} ${shortTime(task.handoff_sent_at)}` : t("delegation.notSent"))}</span></div>
        <div><b>${escapeHtml(t("delegation.report"))}</b><span>${escapeHtml(task.specialist_report_required ? `${t("delegation.expected")} / ${valueLabel(reportState)}` : t("delegation.notExpected"))}</span></div>
        <div><b>${escapeHtml(t("report.file"))}</b><span>${escapeHtml(task.specialist_report_path || t("task.none"))}</span></div>
        ${task.direct_exception_reason ? `<div><b>${escapeHtml(t("delegation.reason"))}</b><span>${escapeHtml(task.direct_exception_reason)}</span></div>` : ""}
        ${task.bypass_review_owner ? `<div><b>${escapeHtml(t("delegation.reviewOwner"))}</b><span>${escapeHtml(task.bypass_review_owner)}</span></div>` : ""}
      </div>
    </article>
  `;
}

function renderActionSummaryFilters(model) {
  const categories = [
    ["approval-waits", t("user.approvalWaits"), model.stats.approvalWaits.length, t("user.approvalWaitDetail"), "blocked"],
    ["ready-questions", t("user.readyQuestions"), model.stats.readyQuestions.length, t("user.questionsDetail"), "active"],
    ["repair-cards", t("user.repairCards"), model.stats.repairCards.length, t("user.repairsDetail"), "blocked"],
    ["blocked-tasks", t("user.blockedTasks"), model.stats.blockedTasks.length + model.stats.reviewDirectives.length, t("user.blockedDetail"), "blocked"],
    ["vision-reviews", t("user.visionReviews"), model.stats.visionReviewTasks.length, t("user.visionReviewDetail"), "active"],
    ["handoff-drafts", t("user.handoffDrafts"), model.stats.handoffDrafts.length, t("user.handoffDraftDetail"), "active"],
    ["report-reviews", t("user.reportReviews"), model.stats.reportReviews.length, t("user.reportReviewDetail"), "blocked"],
    ["liaison-tasks", t("user.liaisonTasks"), model.stats.liaisonTasks.length, t("user.liaisonDetail"), "active"]
  ];
  return `
    <section class="action-summary-row" data-action-section="summary">
      <div class="section-title compact-title">
        <div>
          <span class="eyebrow">${escapeHtml(t("actions.summary"))}</span>
          <h3>${escapeHtml(state.actionFocusCategory ? t("actions.filtered", { label: userActionCategoryLabel(state.actionFocusCategory) }) : t("actions.all"))}</h3>
        </div>
      </div>
      <div class="action-summary-grid">
        ${categories.map(([category, label, value, detail, tone]) => `
          <button type="button" class="user-task-card action-summary-filter ${tone} ${state.actionFocusCategory === category ? "selected" : ""}" data-action="filter-user-actions" data-action-category="${escapeHtml(category)}" data-action-id="">
            <strong>${value}</strong>
            <div>
              <b>${escapeHtml(label)}</b>
              <p>${escapeHtml(detail)}</p>
            </div>
          </button>
        `).join("")}
      </div>
    </section>
  `;
}

function renderPriorityInbox(model) {
  const priorityItems = model.items.filter((item) => userActionPriorityRank(item.priority) <= 1);
  const visibleItems = state.actionFocusCategory
    ? priorityItems.filter((item) => item.category === state.actionFocusCategory)
    : priorityItems;
  return `
    <section class="action-priority-inbox" data-action-section="priority-inbox">
      <div class="section-title compact-title">
        <div>
          <span class="eyebrow">${escapeHtml(t("actions.priority"))}</span>
          <h3>${escapeHtml(t("actions.inbox"))}</h3>
          <p>${escapeHtml(t("actions.inboxDetail"))}</p>
        </div>
        <span>${escapeHtml(formatCount("total", visibleItems.length))}</span>
      </div>
      <div class="action-inbox-list">
        ${visibleItems.length ? visibleItems.map(renderPriorityInboxItem).join("") : `
          <article class="user-task-empty action-inbox-empty">
            <b>${escapeHtml(t("actions.inboxEmpty"))}</b>
            <p>${escapeHtml(state.actionFocusCategory ? t("actions.noneInCategory") : t("user.noTasksDetail"))}</p>
          </article>
        `}
      </div>
    </section>
  `;
}

function renderPriorityInboxItem(item) {
  return `
    <article class="action-inbox-item ${item.priority} ${statusClass(item.status)}${state.actionFocusId === item.id ? " is-deeplink-target" : ""}" data-action-priority="${escapeHtml(item.priority)}" data-action-category="${escapeHtml(item.category)}" data-action-target-id="${escapeHtml(item.id)}" tabindex="-1">
      <div>
        <span class="eyebrow">${escapeHtml(t(`actions.priority.${item.priority}`))} / ${escapeHtml(userActionCategoryLabel(item.category))}</span>
        <h3>${escapeHtml(item.title || userActionCategoryLabel(item.category))}</h3>
        <p>${escapeHtml(item.detail || "")}</p>
      </div>
      <button type="button" data-action="focus-user-action" data-action-category="${escapeHtml(item.category)}" data-action-id="${escapeHtml(item.id)}">
        ${escapeHtml(t("actions.openSource"))}
      </button>
    </article>
  `;
}

function renderUserTaskSummary() {
  const model = buildUserActionModel();
  const stats = model.stats;
  $("userTaskCount").textContent = formatCount("total", stats.total);
  const focusLabel = $("actionFocusLabel");
  if (focusLabel) {
    focusLabel.textContent = state.actionFocusCategory
      ? t("actions.filtered", { label: userActionCategoryLabel(state.actionFocusCategory) })
      : t("actions.detail");
  }
  $("userTaskSummary").innerHTML = `
    ${renderActionSummaryFilters(model)}
    ${renderPriorityInbox(model)}
    ${renderApprovalWaits(stats.approvalWaits)}
    ${renderVisionReviewTasks(stats.visionReviewTasks)}
    ${renderHandoffDrafts(stats.handoffDrafts, { limit: 2, expanded: state.showAllActionHandoffs })}
    ${renderSpecialistReportReviews(stats.reportReviews, { limit: 2, expanded: state.showAllActionReports })}
    ${stats.total ? "" : `
      <article class="user-task-empty">
        <b>${escapeHtml(t("user.noTasks"))}</b>
        <p>${escapeHtml(t("user.noTasksDetail"))}</p>
      </article>
    `}
  `;
}

function renderRepairCards() {
  const stats = getFailureStats();
  $("repairCount").textContent = formatCount("total", stats.readyCards.length);
  $("repairCards").setAttribute("data-action-section", "repair-cards");
  $("repairCards").innerHTML = stats.readyCards.length
    ? stats.readyCards.map((card) => `
      <article class="repair-card ${statusClass(card.status)}${actionTargetClass("repair-cards", card.action_id || card.title)}" ${actionTargetAttrs("repair-cards", card.action_id || card.title)} tabindex="-1">
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
  $("visionPanel").setAttribute("data-action-section", "ready-questions");

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
      <button class="question-nav-item ${selected ? "selected" : ""} ${answered ? "answered" : "unanswered"}${actionTargetClass("ready-questions", question.question_id)}" type="button" data-question-id="${escapeHtml(question.question_id)}" ${actionTargetAttrs("ready-questions", question.question_id)}>
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

function nodeEntityId(node) {
  return node?.dataset?.agentId || node?.dataset?.sessionId || "";
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
  const normalized = String(role || "").toLowerCase();
  if (normalized === "dashboard-ux" || normalized.includes("dashboard") || normalized.includes("design")) return "visual";
  if (role === "visual-art") return "visual";
  if (role === "implementation") return "build";
  if (role === "world-lore") return "world";
  if (normalized.includes("qa") || normalized.includes("review")) return "qa";
  if (normalized.includes("docs") || normalized.includes("release")) return "docs";
  if (normalized.includes("protocol")) return "protocol";
  return "other";
}

function podMeta(podId) {
  const meta = {
    visual: { label: currentLang === "ja" ? "ビジュアル" : "Visual", tone: "#7c5cff" },
    build: { label: currentLang === "ja" ? "実装" : "Build", tone: "#2478ff" },
    world: { label: currentLang === "ja" ? "世界観" : "World", tone: "#21a67a" },
    qa: { label: currentLang === "ja" ? "QA" : "QA", tone: "#d58a00" },
    docs: { label: currentLang === "ja" ? "文書" : "Docs", tone: "#9a6bff" },
    protocol: { label: currentLang === "ja" ? "規約" : "Protocol", tone: "#69717d" },
    other: { label: currentLang === "ja" ? "その他" : "Other", tone: "#69717d" }
  };
  return meta[podId] || meta.other;
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
  const delegationTasks = tasksForAgentDelegation(agent.agent_id);
  const delegationTask = delegationTasks[0];
  const idAttr = agent.role === "session"
    ? `data-session-id="${escapeHtml(agent.agent_id)}"`
    : `data-agent-id="${escapeHtml(agent.agent_id)}"`;
  const layoutNodeId = commandBoardNodeId("agent", agent.agent_id);
  const layoutNode = state.commandBoardLayout?.nodes?.get(layoutNodeId);
  const layoutAttr = layoutNode ? `data-layout-node-id="${escapeHtml(layoutNodeId)}" data-map-node="agent"` : "";
  const supportDragHandle = layoutNode?.draggable && variant.includes("user-support-node")
    ? `<span class="layout-drag-handle support-drag-handle" data-layout-drag-handle aria-label="${escapeHtml(t("team.dragNode"))}" title="${escapeHtml(t("team.dragNode"))}"><span aria-hidden="true">⋮⋮</span></span>`
    : "";
  return `
    <button class="agent-node ${variant} ${statusClass(agent.status)} ${active ? "has-work" : ""} ${linkedSession ? "session-linked" : ""} ${selected ? "selected" : ""} ${preview ? "preview" : ""} ${layoutNode?.manual ? "manual-layout" : ""}"
      type="button"
      ${idAttr}
      ${layoutAttr}
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
      ${delegationTask ? `<span class="node-delegation ${delegationTone(delegationTask)}">${escapeHtml(delegationStatusLabel(delegationTask))}</span>` : ""}
      ${linkedSession ? `<span class="node-session-chip">${escapeHtml(t("team.sessionLinked"))}</span>` : ""}
      <span class="node-count">${owned.length}</span>
      ${supportDragHandle}
    </button>
  `;
}

function buildPods(specialists) {
  const order = ["build", "visual", "qa", "docs", "protocol", "world", "other"];
  const groups = new Map(order.map((podId) => [podId, []]));
  for (const agent of specialists) {
    groups.get(rolePod(agent.role)).push(agent);
  }
  return order
    .map((podId) => ({ podId, agents: groups.get(podId), ...podMeta(podId) }))
    .filter((pod) => pod.agents.length);
}

function commandBoardNodeId(kind, id) {
  return `${kind}:${id}`;
}

function cssVarNameForLayoutNode(nodeId) {
  return nodeId.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function loadCommandBoardLayoutOverrides() {
  try {
    const parsed = JSON.parse(localStorage.getItem(COMMAND_BOARD_OVERRIDE_KEY) || "null");
    if (!parsed || parsed.layout_version !== COMMAND_BOARD_LAYOUT_VERSION || typeof parsed.offsets !== "object") {
      return { layout_version: COMMAND_BOARD_LAYOUT_VERSION, base_signature: "", offsets: {} };
    }
    return parsed;
  } catch {
    return { layout_version: COMMAND_BOARD_LAYOUT_VERSION, base_signature: "", offsets: {} };
  }
}

function saveCommandBoardLayoutOverrides() {
  try {
    localStorage.setItem(COMMAND_BOARD_OVERRIDE_KEY, JSON.stringify(state.commandBoardOverrides));
  } catch {
    // Local storage is best-effort; auto layout remains usable without persistence.
  }
}

function commandBoardRolePriority(agent) {
  const role = String(agent?.role || "").toLowerCase();
  if (role.includes("orchestrator")) return 0;
  if (role.includes("admin")) return 1;
  if (role.includes("liaison")) return 2;
  if (role.includes("implementation") || role.includes("build")) return 10;
  if (role.includes("dashboard") || role.includes("visual")) return 20;
  if (role.includes("qa") || role.includes("review")) return 30;
  if (role.includes("world") || role.includes("vision")) return 40;
  if (role.includes("error") || role.includes("support") || role.includes("concierge")) return 50;
  return 90;
}

function stableCommandBoardSort(a, b) {
  const priority = commandBoardRolePriority(a) - commandBoardRolePriority(b);
  if (priority) return priority;
  const active = Number(hasLiveWork(b)) - Number(hasLiveWork(a));
  if (active) return active;
  return String(a?.agent_id || "").localeCompare(String(b?.agent_id || ""), "en");
}

function commandBoardBaseSignature(nodes, edges) {
  const nodeIds = nodes.map((node) => node.id).sort().join("|");
  const edgeIds = edges.map((edge) => `${edge.from}>${edge.to}`).sort().join("|");
  return `${nodeIds}::${edgeIds}`;
}

function commandBoardRect(id, kind, lane, x, y, width, height, extra = {}) {
  const rect = { id, kind, lane, x, y, autoX: x, autoY: y, width, height, ...extra };
  return updateCommandBoardPorts(rect);
}

function updateCommandBoardPorts(rect) {
  rect.ports = {
    top: { x: rect.x + rect.width / 2, y: rect.y },
    bottom: { x: rect.x + rect.width / 2, y: rect.y + rect.height },
    left: { x: rect.x, y: rect.y + rect.height / 2 },
    right: { x: rect.x + rect.width, y: rect.y + rect.height / 2 }
  };
  return rect;
}

function buildCommandBoardGraph({ agents, orchestrator, orquestaAdmin, userLiaison, supportAgents, pods }) {
  const nodes = [
    { id: commandBoardNodeId("virtual", "user") },
    orchestrator ? { id: commandBoardNodeId("agent", orchestrator.agent_id) } : null,
    orquestaAdmin ? { id: commandBoardNodeId("agent", orquestaAdmin.agent_id) } : null,
    userLiaison ? { id: commandBoardNodeId("agent", userLiaison.agent_id) } : null,
    supportAgents.length ? { id: commandBoardNodeId("lane", "support") } : null,
    ...supportAgents.map((agent) => ({ id: commandBoardNodeId("agent", agent.agent_id) })),
    ...pods.map((pod) => ({ id: commandBoardNodeId("pod", pod.podId) }))
  ].filter(Boolean);
  const edges = [
    orchestrator ? { from: commandBoardNodeId("virtual", "user"), to: commandBoardNodeId("agent", orchestrator.agent_id), type: "spine" } : null,
    orquestaAdmin ? { from: commandBoardNodeId("virtual", "user"), to: commandBoardNodeId("agent", orquestaAdmin.agent_id), type: "admin" } : null,
    userLiaison ? { from: commandBoardNodeId("virtual", "user"), to: commandBoardNodeId("agent", userLiaison.agent_id), type: "support" } : null,
    ...supportAgents.map((agent) => userLiaison ? { from: commandBoardNodeId("agent", userLiaison.agent_id), to: commandBoardNodeId("agent", agent.agent_id), type: "support-child" } : null),
    ...pods.map((pod) => orchestrator ? { from: commandBoardNodeId("agent", orchestrator.agent_id), to: commandBoardNodeId("pod", pod.podId), type: "production" } : null)
  ].filter(Boolean);
  return {
    version: "orquesta-lane-grid-v1",
    engine: "orquesta-lane-grid-v1",
    agents,
    orchestrator,
    orquestaAdmin,
    userLiaison,
    supportAgents: supportAgents.slice().sort(stableCommandBoardSort),
    pods,
    nodes,
    edges,
    signature: commandBoardBaseSignature(nodes, edges)
  };
}

function productionGroupHeight(agentCount, maxVisibleRows) {
  const visibleRows = Math.min(agentCount, maxVisibleRows);
  return 56 + visibleRows * 44 + 24;
}

function computeCommandBoardLayout(model) {
  const padding = { top: 48, right: 56, bottom: 64, left: 56 };
  const nodes = new Map();
  const groups = new Map();
  const lanes = new Map();
  const warnings = [];
  const centerX = 520;
  const supportLaneX = centerX + 165;
  const userWidth = 210;
  const userHeight = 72;
  const user = commandBoardRect(commandBoardNodeId("virtual", "user"), "source", "root", centerX - userWidth / 2, padding.top, userWidth, userHeight, {
    visible: true,
    draggable: true
  });
  nodes.set(user.id, user);

  if (model.orquestaAdmin) {
    const admin = commandBoardRect(commandBoardNodeId("agent", model.orquestaAdmin.agent_id), "admin", "admin-satellite", user.x - 28 - 150, user.y + (user.height - 80) / 2, 150, 80, {
      agent: model.orquestaAdmin,
      agentId: model.orquestaAdmin.agent_id,
      visible: true,
      draggable: true
    });
    nodes.set(admin.id, admin);
  }

  if (model.orchestrator) {
    const orchestrator = commandBoardRect(commandBoardNodeId("agent", model.orchestrator.agent_id), "orchestrator", "orchestrator-branch", centerX - 125, user.y + user.height + 96, 250, 120, {
      agent: model.orchestrator,
      agentId: model.orchestrator.agent_id,
      visible: true,
      draggable: true
    });
    nodes.set(orchestrator.id, orchestrator);
  }

  if (model.userLiaison) {
    const liaison = commandBoardRect(commandBoardNodeId("agent", model.userLiaison.agent_id), "liaison", "user-support", supportLaneX, user.y + 54, 212, 112, {
      agent: model.userLiaison,
      agentId: model.userLiaison.agent_id,
      visible: true,
      draggable: true
    });
    nodes.set(liaison.id, liaison);
  }

  if (model.supportAgents.length) {
    const supportTop = model.userLiaison ? user.y + 212 : user.y + user.height + 80;
    const supportLane = commandBoardRect(commandBoardNodeId("lane", "support"), "support-group", "user-support", supportLaneX, supportTop, 360, 120, {
      agents: model.supportAgents,
      visible: true,
      draggable: false
    });
    nodes.set(supportLane.id, supportLane);
    groups.set(supportLane.id, supportLane);
    const childWidth = 174;
    const childGap = 12;
    model.supportAgents.forEach((agent, index) => {
      const child = commandBoardRect(commandBoardNodeId("agent", agent.agent_id), "support-child", "user-support", supportLane.x + index * (childWidth + childGap), supportLane.y, childWidth, 118, {
        agent,
        agentId: agent.agent_id,
        visible: true,
        draggable: true
      });
      nodes.set(child.id, child);
    });
  }

  const productionCount = model.pods.reduce((count, pod) => count + pod.agents.length, 0);
  const denseMode = productionCount >= 10;
  const groupWidth = denseMode ? 280 : 260;
  const maxVisibleRows = denseMode ? 3 : 4;
  const groupGap = 72;
  const rowGap = 88;
  const maxColumns = 3;
  const columns = Math.max(1, Math.min(maxColumns, model.pods.length || 1));
  const productionLaneWidth = columns * groupWidth + Math.max(0, columns - 1) * groupGap;
  const productionStartX = Math.max(padding.left, centerX - productionLaneWidth / 2);
  const orchestratorNode = model.orchestrator ? nodes.get(commandBoardNodeId("agent", model.orchestrator.agent_id)) : null;
  const productionStartY = (orchestratorNode ? orchestratorNode.y + orchestratorNode.height : user.y + user.height) + 112;

  model.pods.forEach((pod, index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    const rowItems = model.pods.slice(row * columns, row * columns + columns);
    const rowWidth = rowItems.length * groupWidth + Math.max(0, rowItems.length - 1) * groupGap;
    const rowStartX = Math.max(padding.left, centerX - rowWidth / 2);
    const previousRows = [...Array(row).keys()].reduce((sum, rowIndex) => {
      const rowPods = model.pods.slice(rowIndex * columns, rowIndex * columns + columns);
      const rowHeight = Math.max(...rowPods.map((item) => productionGroupHeight(item.agents.length, maxVisibleRows)));
      return sum + rowHeight + rowGap;
    }, 0);
    const height = productionGroupHeight(pod.agents.length, maxVisibleRows);
    const id = commandBoardNodeId("pod", pod.podId);
    const group = commandBoardRect(id, "production-group", "production", rowStartX + column * (groupWidth + groupGap), productionStartY + previousRows, groupWidth, height, {
      pod,
      groupId: id,
      agentIds: pod.agents.map((agent) => agent.agent_id),
      visibleRows: Math.min(pod.agents.length, maxVisibleRows),
      visible: true,
      draggable: true
    });
    nodes.set(id, group);
    groups.set(id, group);
  });

  lanes.set("root", { id: "root", x: user.x, y: user.y, width: user.width, height: user.height, role: "source" });
  lanes.set("production", { id: "production", x: productionStartX - 28, y: productionStartY - 54, width: productionLaneWidth + 56, height: Math.max(220, Math.max(0, ...[...groups.values()].filter((group) => group.lane === "production").map((group) => group.y + group.height)) - productionStartY + 104), role: "production" });
  const supportRects = [nodes.get(commandBoardNodeId("agent", model.userLiaison?.agent_id || "")), nodes.get(commandBoardNodeId("lane", "support"))].filter(Boolean);
  if (supportRects.length) {
    const sx = Math.min(...supportRects.map((rect) => rect.x)) - 28;
    const sy = Math.min(...supportRects.map((rect) => rect.y)) - 36;
    const sr = Math.max(...supportRects.map((rect) => rect.x + rect.width)) + 28;
    const sb = Math.max(...supportRects.map((rect) => rect.y + rect.height)) + 42;
    lanes.set("user-support", { id: "user-support", x: sx, y: sy, width: sr - sx, height: sb - sy, role: "support" });
  }

  const layout = {
    version: "orquesta-lane-grid-v1",
    engine: "orquesta-lane-grid-v1",
    bounds: { x: 0, y: 0, width: 1220, height: 720, padding },
    nodes,
    groups,
    lanes,
    edges: model.edges.map((edge, index) => ({
      id: `${edge.type}:${index}:${edge.from}->${edge.to}`,
      from: edge.from,
      to: edge.to,
      fromPort: edge.type === "admin" ? "left" : edge.type === "support" ? "right" : "bottom",
      toPort: edge.type === "admin" ? "right" : edge.type === "support" ? "left" : "top",
      kind: edge.type,
      style: edge.type === "admin" ? "secondary" : "primary",
      path: []
    })),
    warnings,
    signature: model.signature,
    usedDagre: false,
    overrides: { baseSignature: model.signature, appliedIds: [], staleIds: [] }
  };
  layout.bounds.height = Math.max(720, Math.max(0, ...[...nodes.values()].map((node) => node.y + node.height)) + padding.bottom);
  applyCommandBoardOverrides(layout);
  finalizeCommandBoardEdges(layout);
  detectCommandBoardCollisions(layout);
  return layout;
}

function commandBoardRectsOverlap(a, b, threshold = 80) {
  const x = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return x * y > threshold;
}

function detectCommandBoardCollisions(layout) {
  const objects = [...layout.nodes.values()].filter((node) => node.visible !== false && !node.id.startsWith("lane:"));
  for (let i = 0; i < objects.length; i += 1) {
    for (let j = i + 1; j < objects.length; j += 1) {
      if (commandBoardRectsOverlap(objects[i], objects[j])) {
        layout.warnings.push({
          code: "overlap",
          severity: "blocking",
          nodeIds: [objects[i].id, objects[j].id],
          message: `${objects[i].id} overlaps ${objects[j].id}`
        });
      }
    }
  }
}

function applyCommandBoardOverrides(layout) {
  const overrides = state.commandBoardOverrides || {};
  const sameSignature = overrides.base_signature === layout.signature;
  for (const [id, node] of layout.nodes.entries()) {
    const offset = overrides.offsets?.[id];
    if (!offset) continue;
    node.x = Math.round(node.autoX + Number(offset.dx || 0));
    node.y = Math.round(node.autoY + Number(offset.dy || 0));
    node.manual = true;
    node.staleManual = !sameSignature;
    updateCommandBoardPorts(node);
    if (layout.groups?.has(id)) {
      layout.groups.set(id, node);
    }
    if (sameSignature) layout.overrides?.appliedIds?.push(id);
    else layout.overrides?.staleIds?.push(id);
  }
  return layout;
}

function finalizeCommandBoardEdges(layout) {
  for (const edge of layout.edges) {
    const source = layout.nodes.get(edge.from) || layout.groups.get(edge.from);
    const target = layout.nodes.get(edge.to) || layout.groups.get(edge.to);
    if (!source || !target || !source.ports?.[edge.fromPort] || !target.ports?.[edge.toPort]) {
      layout.warnings.push({
        code: "missing-port",
        severity: "blocking",
        nodeIds: [edge.from, edge.to],
        message: `Missing port for ${edge.from} -> ${edge.to}`
      });
      edge.path = [];
      continue;
    }
    edge.path = commandBoardEdgePoints(source.ports[edge.fromPort], target.ports[edge.toPort], edge.kind);
  }
}

function commandBoardEdgePoints(from, to, kind) {
  if (kind === "spine" || Math.abs(from.x - to.x) < 2 || Math.abs(from.y - to.y) < 2) {
    return [from, to];
  }
  if (kind === "production") {
    const busY = Math.round(Math.max(from.y + 64, to.y - 32));
    return [from, { x: from.x, y: busY }, { x: to.x, y: busY }, to];
  }
  if (kind === "support-child") {
    const busY = Math.round(from.y + Math.max(22, Math.min(40, (to.y - from.y) * 0.55)));
    return [from, { x: from.x, y: busY }, { x: to.x, y: busY }, to];
  }
  const midX = Math.round(from.x + (to.x - from.x) * 0.52);
  return [from, { x: midX, y: from.y }, { x: midX, y: to.y }, to];
}

function commandBoardWorldStyle(layout) {
  if (!layout) return "";
  const rules = [];
  for (const [id, node] of layout.nodes.entries()) {
    const cssId = cssVarNameForLayoutNode(id);
    rules.push(`--cb-${cssId}-x:${node.x}px`);
    rules.push(`--cb-${cssId}-y:${node.y}px`);
  }
  rules.push(`--cb-layout-engine:${layout.usedDagre ? 1 : 0}`);
  return rules.join("; ");
}

function setCommandBoardOverride(nodeId, dx, dy) {
  if (!state.commandBoardLayout) return;
  state.commandBoardOverrides.layout_version = COMMAND_BOARD_LAYOUT_VERSION;
  state.commandBoardOverrides.base_signature = state.commandBoardLayout.signature;
  state.commandBoardOverrides.offsets = state.commandBoardOverrides.offsets || {};
  state.commandBoardOverrides.offsets[nodeId] = { dx: Math.round(dx), dy: Math.round(dy), updated_at: new Date().toISOString() };
}

function clearCommandBoardOverride(nodeId) {
  if (!state.commandBoardOverrides?.offsets || !nodeId) return;
  delete state.commandBoardOverrides.offsets[nodeId];
  saveCommandBoardLayoutOverrides();
  renderTeamVisualizer();
}

function clearAllCommandBoardOverrides() {
  state.commandBoardOverrides = { layout_version: COMMAND_BOARD_LAYOUT_VERSION, base_signature: "", offsets: {} };
  saveCommandBoardLayoutOverrides();
  renderTeamVisualizer();
}

function podPosition(pod, index, total) {
  const id = commandBoardNodeId("pod", pod.podId);
  const node = state.commandBoardLayout?.nodes?.get(id);
  if (node) return { x: node.x, y: node.y, width: node.width, height: node.height, visibleRows: node.visibleRows, side: node.x < 610 ? -1 : 1, manual: node.manual };
  const side = index % 2 === 0 ? -1 : 1;
  return {
    x: 520 + side * 240,
    y: 460 + Math.floor(index / 2) * 160,
    side: total === 1 ? 0 : side
  };
}

function renderPod(pod, index, total) {
  const pos = podPosition(pod, index, total);
  const visible = pod.agents.slice(0, pos.visibleRows || 4);
  const hiddenCount = Math.max(0, pod.agents.length - visible.length);
  const activeCount = pod.agents.filter(hasLiveWork).length;
  const layoutId = commandBoardNodeId("pod", pod.podId);
  return `
    <section class="agent-pod production-group-card ${activeCount ? "pod-active" : ""} ${pos.manual ? "manual-layout" : ""}" data-pod-id="${escapeHtml(pod.podId)}" data-layout-node-id="${escapeHtml(layoutId)}" data-map-node="pod" style="--pod-color: ${pod.tone}; --map-x: ${pos.x}px; --map-y: ${pos.y}px; width: ${pos.width || 260}px; min-height: ${pos.height || 124}px">
      <header class="pod-head">
        <div>
          <b>${escapeHtml(pod.label)}</b>
          <span>${escapeHtml(t("team.podAgents", { count: pod.agents.length }))}</span>
        </div>
        ${pos.manual ? `<span class="manual-layout-badge">${escapeHtml(t("team.manualLayout"))}</span>` : ""}
        <em>${escapeHtml(t("team.podActive", { count: activeCount }))}</em>
        <button class="layout-drag-handle" type="button" data-layout-drag-handle aria-label="${escapeHtml(t("team.dragNode"))}" title="${escapeHtml(t("team.dragNode"))}"><span aria-hidden="true">⋮⋮</span></button>
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
  state.commandBoardGraph = buildCommandBoardGraph({ agents, orchestrator, orquestaAdmin, userLiaison, supportAgents, pods });
  state.commandBoardLayout = computeCommandBoardLayout(state.commandBoardGraph);
  const activeCount = agents.filter(hasLiveWork).length;
  const commandLabel = currentLang === "ja" ? "制作指揮ツリー" : "Production Command";
  const supportLabel = currentLang === "ja" ? "利用者連携ツリー" : "User Alignment";
  if (!agentById(state.selectedAgentId) && orchestrator) {
    state.selectedAgentId = orchestrator.agent_id;
  }

  $("teamCount").textContent = t("count.podsActive", { pods: pods.length, agents: agents.length, active: activeCount });
  const layoutBottom = Math.max(0, ...[...state.commandBoardLayout.nodes.values()].map((node) => node.y + node.height));
  const worldHeight = Math.max(720, layoutBottom + 120);
  const worldStyle = commandBoardWorldStyle(state.commandBoardLayout);
  $("teamTree").innerHTML = `
    <div class="map-hud">
      <span>${escapeHtml(t("team.panHint"))}</span>
      <span id="mapZoomReadout">${escapeHtml(t("map.zoom", { zoom: Math.round(state.map.scale * 100) }))}</span>
      <button class="layout-reset-button" type="button" data-layout-reset="selected">${escapeHtml(t("team.resetSelectedLayout"))}</button>
      <button class="layout-reset-button" type="button" data-layout-reset="all">${escapeHtml(t("team.resetAllLayout"))}</button>
    </div>
    <div class="map-status-legend" aria-label="Agent status legend">
      <span><i class="active"></i>${escapeHtml(t("legend.active"))}</span>
      <span><i class="busy"></i>${escapeHtml(t("legend.busy"))}</span>
      <span><i class="idle"></i>${escapeHtml(t("legend.idle"))}</span>
      <span><i class="approval"></i>${escapeHtml(t("legend.approval"))}</span>
      <span><i class="done"></i>${escapeHtml(t("legend.done"))}</span>
      <span><i class="offline"></i>${escapeHtml(t("legend.offline"))}</span>
    </div>
    <div class="org-map-world" id="orgMapWorld" data-layout-engine="${escapeHtml(state.commandBoardLayout.engine)}" data-layout-warning-count="${state.commandBoardLayout.warnings.length}" style="--map-x:${state.map.x}px; --map-y:${state.map.y}px; --map-scale:${state.map.scale}; ${worldStyle}; width: ${state.commandBoardLayout.bounds.width}px; height: ${worldHeight}px">
      <svg class="team-link-layer" id="teamLinkLayer" aria-hidden="true"></svg>
      <div class="mission-plane command-plane" aria-hidden="true"><span>${escapeHtml(commandLabel)}</span></div>
      <div class="mission-plane support-plane" aria-hidden="true"><span>${escapeHtml(supportLabel)}</span></div>
      <div class="floor-core split-command-core" data-map-node="core">
        <div class="user-node" data-layout-node-id="${escapeHtml(commandBoardNodeId("virtual", "user"))}">
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
          <div class="user-support-grid" data-layout-node-id="${escapeHtml(commandBoardNodeId("lane", "support"))}" aria-hidden="true"></div>
          ${visionCurator ? renderAgentNode(visionCurator, "curator-node user-support-node support-child-node compact-node") : ""}
          ${errorConcierge ? renderAgentNode(errorConcierge, "error-concierge-node user-support-node support-child-node compact-node") : ""}
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

function orthogonalPath(points) {
  return points
    .filter((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y))
    .map((point, index) => `${index ? "L" : "M"} ${Math.round(point.x)} ${Math.round(point.y)}`)
    .join(" ");
}

function drawTeamLinks() {
  const stage = $("orgMapWorld");
  const layer = $("teamLinkLayer");
  if (!stage || !layer) return;

  const width = stage.offsetWidth;
  const height = stage.offsetHeight;
  layer.setAttribute("viewBox", `0 0 ${width} ${height}`);
  layer.innerHTML = "";

  const layout = state.commandBoardLayout;
  if (!layout?.edges?.length) return;
  const links = [];
  for (const edge of layout.edges) {
    if (!edge.path?.length) continue;
    const target = layout.nodes.get(edge.to) || layout.groups.get(edge.to);
    const agents = target?.pod?.agents || target?.agents || (target?.agent ? [target.agent] : []);
    const selected = agents.some((agent) => agent.agent_id === state.selectedAgentId);
    const active = agents.some(hasLiveWork);
    const color = target?.pod?.tone || roleTone(agents[0]?.role || (edge.kind === "support" ? "user-liaison" : "orchestrator"));
    links.push({
      d: orthogonalPath(edge.path),
      active,
      selected,
      color,
      trunk: edge.kind === "spine",
      peer: edge.kind === "support" || edge.kind === "support-child",
      admin: edge.kind === "admin",
      kind: edge.kind
    });
  }

  layer.innerHTML = links.map((link, index) => `
      <path class="team-link ${link.trunk ? "trunk-link" : ""} ${link.peer ? "peer-link" : ""} ${link.admin ? "admin-link" : ""} ${link.active ? "active-link" : ""} ${link.selected ? "selected-link" : ""}"
      d="${link.d}"
      style="--link-color: ${link.color || "#2478ff"}"
      pathLength="1"
      data-link-kind="${escapeHtml(link.kind)}"
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
  const delegationTasks = tasksForAgentDelegation(agent.agent_id).slice(0, 3);
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
    <div class="inspector-section">
      <b>${escapeHtml(t("delegation.title"))}</b>
      ${delegationTasks.length ? delegationTasks.map((task) => `
        <p><strong>${escapeHtml(task.task_id)}</strong> ${escapeHtml(delegationStatusLabel(task))} · ${escapeHtml(task.specialist_report_path || task.direct_exception_reason || t("task.none"))}</p>
      `).join("") : `<p>${escapeHtml(t("delegation.none"))}</p>`}
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
  const detailNode = $("completionMapDetail");
  if (!node) return;
  $("completionCount").textContent = phases.length
    ? `${percent}% · ${t("completion.remaining", { count: Math.max(0, total - done) })}`
    : t("completion.noMap");

  if (!phases.length) {
    const emptyHtml = `
      <div class="completion-empty">
        <b>${escapeHtml(t("completion.noMap"))}</b>
        <p>${escapeHtml(t("completion.noMapDetail"))}</p>
      </div>
    `;
    node.innerHTML = emptyHtml;
    if (detailNode) detailNode.innerHTML = emptyHtml;
    return;
  }

  const currentPhase = phases.find((phase) => ["active", "in_progress", "review"].includes(phase.status)) || phases.find((phase) => phase.status !== "done") || phases[0];
  const triggers = map.revision_policy?.review_triggers || [];
  const compactHtml = `
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
  `;
  const detailHtml = `
    ${compactHtml}
    <div class="completion-phase-track">
      ${phases.map((phase, index) => renderCompletionPhase(phase, index)).join("")}
    </div>
    <div class="completion-footer">
      <b>${escapeHtml(t("completion.revision"))}</b>
      <span>${escapeHtml(triggers.length ? triggers.map(completionTriggerLabel).join(" · ") : t("task.none"))}</span>
    </div>
  `;
  node.innerHTML = compactHtml;
  if (detailNode) detailNode.innerHTML = detailHtml;
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
        <div class="setup-guidance-card" aria-label="${escapeHtml(t("section.setupWizard"))}">
          <b>${escapeHtml(t("setup.next"))}</b>
          <ol>
            <li>${escapeHtml(t("setup.intakeBeforeQuestions"))}</li>
            <li>${escapeHtml(t("setup.answerQuestionsFirst"))}</li>
            <li>${escapeHtml(t("setup.readyToFinalize"))}</li>
            <li>${escapeHtml(t("setup.productionStartDetail"))}</li>
          </ol>
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

function controlCapacityRecords() {
  return Array.isArray(state.capacity?.capacity_records) ? state.capacity.capacity_records : [];
}

function controlDispatches() {
  return Array.isArray(state.capacity?.dispatches) ? state.capacity.dispatches : [];
}

function controlFindings() {
  return Array.isArray(state.controlAudit?.findings) ? state.controlAudit.findings : [];
}

function controlTimestamp(value) {
  if (!value) return t("time.none");
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleString(currentLang === "ja" ? "ja-JP" : "en-US", { dateStyle: "short", timeStyle: "short" });
}

function latestDispatchForCapacity(record) {
  const scope = record?.scope || {};
  const matches = controlDispatches().filter((dispatch) => {
    if (scope.agent_id && dispatch.agent_id === scope.agent_id) return true;
    return Boolean(scope.thread_id && dispatch.thread_id === scope.thread_id);
  });
  return matches.sort((left, right) => Date.parse(right.queued_at || 0) - Date.parse(left.queued_at || 0))[0] || null;
}

function taskForControlDispatch(dispatch) {
  return dispatch?.task_id ? state.tasks.find((task) => task.task_id === dispatch.task_id) || null : null;
}

function controlRecordPriority(record) {
  const stateRank = { unavailable: 0, suspected_unavailable: 1, cooldown: 2, probing: 3, unknown: 4, available: 5 };
  const circuitRank = { open: -2, half_open: -1, closed: 0 };
  return (stateRank[record?.state] ?? 6) * 10 + (circuitRank[record?.circuit?.state] ?? 0);
}

function controlRecordsSorted() {
  return controlCapacityRecords().slice().sort((left, right) => controlRecordPriority(left) - controlRecordPriority(right)
    || Date.parse(right.observed_at || 0) - Date.parse(left.observed_at || 0)
    || String(left.capacity_id || "").localeCompare(String(right.capacity_id || "")));
}

function controlLifecycle(dispatch) {
  const stages = [
    ["queued", "queued_at", t("control.queued")],
    ["dispatch_accepted", "dispatch_accepted_at", t("control.dispatchAccepted")],
    ["turn_started", "turn_started_at", t("control.turnStarted")],
    ["progress_observed", "progress_observed_at", t("control.progressObserved")],
    ["report_produced", "report_produced_at", t("control.reportProduced")]
  ];
  return `<ol class="control-lifecycle">${stages.map(([name, field, label]) => {
    const observed = Boolean(dispatch?.[field]);
    const current = dispatch?.state === name;
    return `<li class="${observed ? "is-observed" : ""} ${current ? "is-current" : ""}"><b>${escapeHtml(label)}</b><span>${escapeHtml(observed ? controlTimestamp(dispatch[field]) : t("control.notObserved"))}</span></li>`;
  }).join("")}</ol>`;
}

function controlModelEvidence(task) {
  const route = task?.model_route || {};
  const actual = route.actual_model || task?.completion_envelope?.model_route?.actual_model || null;
  const requested = route.requested_model || null;
  const applied = route.applied_model || null;
  return `
    <dl class="control-definition-list">
      <div><dt>${escapeHtml(t("control.recommended"))}</dt><dd>${escapeHtml(route.recommended_model || t("control.none"))}</dd></div>
      <div><dt>${escapeHtml(t("control.requested"))}</dt><dd>${escapeHtml(requested || t("control.none"))}</dd></div>
      <div><dt>${escapeHtml(t("control.applied"))}</dt><dd>${escapeHtml(applied || t("control.none"))}</dd></div>
      <div><dt>${escapeHtml(t("control.actualVerified"))}</dt><dd data-control-actual-model>${escapeHtml(actual || t("control.actualUnknown"))}</dd></div>
    </dl>
  `;
}

function renderControlPlaneSummary() {
  const summaryNode = $("controlPlaneSummary");
  const stateNode = $("controlPlaneState");
  if (!summaryNode || !stateNode) return;
  const ledger = state.capacity;
  if (!ledger || !Array.isArray(ledger.capacity_records)) {
    stateNode.textContent = t("control.loading");
    summaryNode.innerHTML = `<div class="control-empty" aria-busy="true">${escapeHtml(state.liveSource === "server" ? t("control.legacy") : t("control.loading"))}</div>`;
    return;
  }
  const auditSummary = state.controlAudit?.summary || {};
  const openCircuits = ledger.capacity_records.filter((record) => record.circuit?.state === "open").length;
  const reviewCount = Number(auditSummary.fallbacks_requiring_user_approval || 0);
  stateNode.textContent = valueLabel(ledger.orchestra?.mode || "unknown");
  summaryNode.innerHTML = `
    <div class="control-summary-item"><span>${escapeHtml(t("control.mode"))}</span><b>${escapeHtml(valueLabel(ledger.orchestra?.mode || "unknown"))}</b></div>
    <div class="control-summary-item"><span>${escapeHtml(t("control.openCircuits"))}</span><b>${openCircuits}</b></div>
    <div class="control-summary-item"><span>${escapeHtml(t("control.userReview"))}</span><b>${reviewCount}</b></div>
    <div class="control-summary-item"><span>${escapeHtml(t("control.auditTime"))}</span><b>${escapeHtml(controlTimestamp(state.controlAudit?.generated_at || state.controlAudit?.updated_at || ledger.updated_at))}</b></div>
  `;
}

function renderControlTabs() {
  const node = $("controlPlaneTabs");
  if (!node) return;
  const tabs = [
    ["capacity", t("control.capacity")],
    ["audit", t("control.audit")],
    ["evidence", t("control.evidence")]
  ];
  node.innerHTML = tabs.map(([id, label]) => `<button type="button" role="tab" data-action="control-tab" data-control-tab="${id}" aria-controls="controlPlaneLedger" aria-selected="${String(state.controlPlane.tab === id)}" tabindex="${state.controlPlane.tab === id ? "0" : "-1"}">${escapeHtml(label)}</button>`).join("");
}

function renderControlCapacityLedger() {
  const records = controlRecordsSorted();
  if (!records.length) return `<div class="control-empty">${escapeHtml(t("control.empty"))}</div>`;
  return `
    <div class="control-ledger-head" aria-hidden="true"><span>${escapeHtml(t("control.scope"))}</span><span>${escapeHtml(t("control.capacityState"))}</span><span>${escapeHtml(t("control.dispatch"))}</span><span>${escapeHtml(t("control.circuit"))}</span><span>${escapeHtml(t("control.model"))}</span><span>${escapeHtml(t("control.next"))}</span></div>
    <div class="control-ledger-rows">${records.map((record) => {
      const dispatch = latestDispatchForCapacity(record);
      const task = taskForControlDispatch(dispatch);
      const selected = state.controlPlane.selectedCapacityId === record.capacity_id;
      const actual = task?.model_route?.actual_model || task?.completion_envelope?.model_route?.actual_model || null;
      const next = record.circuit?.state === "open" ? valueLabel("cooldown") : t("control.noAction");
      return `
        <button type="button" class="control-ledger-row ${selected ? "is-selected" : ""}" data-action="select-control-record" data-capacity-record-id="${escapeHtml(record.capacity_id)}" aria-expanded="${String(selected)}" aria-controls="controlPlaneDetail">
          <span><b>${escapeHtml(record.scope?.agent_id || record.scope?.scope_key || record.capacity_id)}</b><small>${escapeHtml(record.scope?.scope_type || "unknown")} · ${escapeHtml(record.scope?.scope_confidence || "unknown")}</small></span>
          <span><b>${escapeHtml(valueLabel(record.state || "unknown"))}</b><small>${escapeHtml(record.cause || "unknown")} · ${escapeHtml(valueLabel(record.evidence_level || "E0"))}</small></span>
          <span><b>${escapeHtml(valueLabel(dispatch?.state || "unknown"))}</b><small>${escapeHtml(dispatch?.task_id || t("control.none"))}</small></span>
          <span><b>${escapeHtml(valueLabel(record.circuit?.state || "unknown"))}</b><small>${escapeHtml(record.cooldown_until || record.circuit?.next_probe_not_before || t("time.none"))}</small></span>
          <span><b>${escapeHtml(task?.model_route?.requested_model || t("control.none"))}</b><small data-control-actual-model>${escapeHtml(actual || t("control.actualUnknown"))}</small></span>
          <span><b>${escapeHtml(next)}</b><small>${escapeHtml(record.capacity_id)}</small></span>
        </button>
      `;
    }).join("")}</div>
  `;
}

function renderControlRecordDetail() {
  const record = controlCapacityRecords().find((item) => item.capacity_id === state.controlPlane.selectedCapacityId);
  if (!record) return `<div class="control-empty">${escapeHtml(state.controlPlane.deepLinkMessage || t("control.select"))}</div>`;
  const dispatch = latestDispatchForCapacity(record);
  const task = taskForControlDispatch(dispatch);
  const matchingFindings = controlFindings().filter((finding) => finding.capacity_id === record.capacity_id || (dispatch?.task_id && finding.task_id === dispatch.task_id));
  const evidence = (state.capacity?.evidence || []).filter((item) => (record.evidence_refs || []).includes(item.evidence_id));
  const fallback = task?.completion_envelope?.capacity_evidence?.fallback || task?.capacity_evidence?.fallback || null;
  return `
    <section class="control-detail-section" data-control-detail-id="${escapeHtml(record.capacity_id)}">
      <div class="section-title compact-title"><div><span class="eyebrow">${escapeHtml(record.capacity_id)}</span><h3>${escapeHtml(record.scope?.agent_id || t("control.scope"))}</h3></div></div>
      <div class="control-detail-columns">
        <div><h4>${escapeHtml(t("control.lifecycle"))}</h4>${controlLifecycle(dispatch)}</div>
        <div><h4>${escapeHtml(t("control.evidenceLevel"))}</h4><p>${escapeHtml(valueLabel(record.evidence_level || "E0"))} · ${escapeHtml(valueLabel(record.classification || "unknown"))}</p><p>${escapeHtml(evidence.map((item) => item.summary).filter(Boolean).join(" / ") || t("control.notObserved"))}</p></div>
        <div><h4>${escapeHtml(t("control.cooldown"))}</h4><p>${escapeHtml(record.cooldown_until || record.reset_at || record.circuit?.next_probe_not_before || t("time.none"))}</p><p>${escapeHtml(valueLabel(record.circuit?.state || "unknown"))}</p></div>
      </div>
      <div class="control-detail-columns">
        <div><h4>${escapeHtml(t("control.model"))}</h4>${controlModelEvidence(task)}</div>
        <div><h4>${escapeHtml(t("control.fallback"))}</h4><p>${escapeHtml(fallback ? JSON.stringify(fallback) : t("control.noFallback"))}</p></div>
        <div><h4>${escapeHtml(t("control.completion"))}</h4><p>${escapeHtml(task?.completion_envelope?.status || t("control.noEnvelope"))}</p></div>
      </div>
      <div class="control-audit-mini"><h4>${escapeHtml(t("control.findings"))}</h4>${matchingFindings.length ? `<ul>${matchingFindings.slice(0, 4).map((finding) => `<li><b>${escapeHtml(valueLabel(finding.severity || "unknown"))}</b> ${escapeHtml(finding.message || finding.code || finding.finding_id)}</li>`).join("")}</ul>` : `<p>${escapeHtml(t("control.noFindings"))}</p>`}</div>
    </section>
  `;
}

function renderControlAuditLedger() {
  const findings = controlFindings();
  const summary = state.controlAudit?.summary || {};
  return `
    <section class="control-audit-summary"><p>${escapeHtml(t("control.findings"))}: ${findings.length}</p><p>${escapeHtml(t("control.userReview"))}: ${Number(summary.fallbacks_requiring_user_approval || 0)}</p></section>
    <div class="control-flat-list">${findings.length ? findings.slice(0, 24).map((finding) => `<div><b>${escapeHtml(valueLabel(finding.severity || "unknown"))}</b><span>${escapeHtml(finding.task_id || finding.capacity_id || finding.finding_id)}</span><p>${escapeHtml(finding.message || finding.code || "")}</p></div>`).join("") : `<div class="control-empty">${escapeHtml(t("control.noFindings"))}</div>`}</div>
  `;
}

function renderControlEvidenceLedger() {
  const tasks = state.tasks.filter((task) => task.model_route || task.completion_envelope).slice().sort((left, right) => String(right.task_id).localeCompare(String(left.task_id)));
  const rules = Array.isArray(state.modelPolicy?.rules) ? state.modelPolicy.rules : [];
  return `
    <section class="control-policy-strip"><b>${escapeHtml(t("control.modelPolicy"))}</b><span>${escapeHtml(t("control.policyRules"))}: ${rules.length}</span></section>
    <div class="control-flat-list">${tasks.length ? tasks.map((task) => `
      <div data-control-task-id="${escapeHtml(task.task_id)}"><b>${escapeHtml(task.task_id)}</b><span>${escapeHtml(task.title || "")}</span>${controlModelEvidence(task)}<p>${escapeHtml(t("control.completion"))}: ${escapeHtml(task.completion_envelope?.status || t("control.noEnvelope"))}</p></div>
    `).join("") : `<div class="control-empty">${escapeHtml(t("control.none"))}</div>`}</div>
  `;
}

function renderControlPlane() {
  renderControlPlaneSummary();
  renderControlTabs();
  const ledger = $("controlPlaneLedger");
  const detail = $("controlPlaneDetail");
  if (!ledger || !detail) return;
  if (state.controlPlane.tab === "audit") {
    ledger.innerHTML = renderControlAuditLedger();
    detail.innerHTML = "";
    return;
  }
  if (state.controlPlane.tab === "evidence") {
    ledger.innerHTML = renderControlEvidenceLedger();
    detail.innerHTML = "";
    return;
  }
  ledger.innerHTML = renderControlCapacityLedger();
  detail.innerHTML = renderControlRecordDetail();
}

function applyControlFocus(recordId) {
  state.controlPlane.tab = "capacity";
  state.controlPlane.selectedCapacityId = recordId || null;
  state.controlPlane.deepLinkMessage = recordId ? t("control.select") : null;
}

function scheduleControlFocus() {
  if (state.currentView !== "control" || !state.controlPlane.selectedCapacityId) return;
  window.setTimeout(() => {
    const target = document.querySelector(`[data-capacity-record-id="${CSS.escape(state.controlPlane.selectedCapacityId)}"]`);
    const detail = $("controlPlaneDetail");
    if (!target || !detail) {
      state.controlPlane.deepLinkMessage = t("control.select");
      renderControlPlane();
      return;
    }
    target.classList.add("is-deeplink-target");
    detail.classList.add("is-deeplink-target");
    detail.scrollIntoView({ block: "center", behavior: "smooth" });
    detail.focus({ preventScroll: true });
    window.setTimeout(() => {
      target.classList.remove("is-deeplink-target");
      detail.classList.remove("is-deeplink-target");
    }, 1700);
  }, 40);
}


function renderLiquidGlassState() {
  document.documentElement.classList.add("orquesta-liquid-ready");
  document.body.dataset.currentView = state.currentView || "home";
  document.body.classList.toggle("is-live-state", Boolean(state.isLive));
  document.body.classList.toggle("is-sample-state", !state.isLive);
  queueLiquidMotionRefresh();
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
  renderLiquidGlassState();
  renderSync();
  renderAttention();
  renderMetrics();
  renderHomeOverview();
  renderTeamVisualizer();
  renderCompletionMap();
  renderDelegationTruth();
  renderDelegationLedger();
  renderFoundationAudit();
  renderSetupWizard();
  renderProgressPanel();
  renderControlPlane();
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
  if (fileName === "model_policy.json") state.modelPolicy = data || state.modelPolicy;
  if (fileName === "capacity.json") state.capacity = data || state.capacity;
  if (fileName === "control_audit.json") state.controlAudit = data || state.controlAudit;
  if (fileName === "dashboard_actions.json") state.dashboardActions = data || state.dashboardActions;
  if (fileName === "trigger_audit.json") state.triggerAudit = data || state.triggerAudit;
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
  state.modelPolicy = data.modelPolicy || state.modelPolicy || null;
  state.capacity = data.capacity || state.capacity || null;
  state.controlAudit = data.controlAudit || state.controlAudit || null;
  state.dashboardActions = data.dashboardActions || state.dashboardActions || { actions: [] };
  state.triggerAudit = data.triggerAudit || state.triggerAudit || {};
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
    state.currentView = "actions";
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
    state.currentView = button.dataset.viewTarget || "home";
    render();
  });
});

document.addEventListener("click", (event) => {
  const viewButton = event.target.closest("[data-action='open-view']");
  if (viewButton) {
    state.currentView = viewButton.dataset.viewTarget || "home";
    if (state.currentView === "actions") {
      applyActionFocus(viewButton.dataset.actionCategory || null, viewButton.dataset.actionId || null);
    }
    if (state.currentView === "control") {
      applyControlFocus(viewButton.dataset.controlRecordId || null);
    }
    const focusLabel = $("actionFocusLabel");
    if (focusLabel && viewButton.dataset.focusLabel) {
      focusLabel.textContent = viewButton.dataset.focusLabel;
    }
    render();
    scheduleActionFocus();
    scheduleControlFocus();
    return;
  }
  const controlTab = event.target.closest("[data-action='control-tab']");
  if (controlTab) {
    state.controlPlane.tab = controlTab.dataset.controlTab || "capacity";
    state.controlPlane.deepLinkMessage = null;
    renderControlPlane();
    return;
  }
  const controlRecord = event.target.closest("[data-action='select-control-record']");
  if (controlRecord) {
    state.controlPlane.selectedCapacityId = controlRecord.dataset.capacityRecordId || null;
    state.controlPlane.deepLinkMessage = null;
    renderControlPlane();
    $("controlPlaneDetail")?.focus({ preventScroll: true });
    return;
  }
  const delegationTruthToggle = event.target.closest("[data-action='toggle-delegation-truth']");
  if (delegationTruthToggle) {
    state.showAllDelegationTruth = !state.showAllDelegationTruth;
    renderDelegationTruth();
    return;
  }
  const delegationLedgerToggle = event.target.closest("[data-action='toggle-delegation-ledger']");
  if (delegationLedgerToggle) {
    state.showAllDelegationLedger = !state.showAllDelegationLedger;
    renderDelegationLedger();
    return;
  }
  const inspectButton = event.target.closest("[data-action='inspect-agent']");
  if (inspectButton) {
    state.selectedAgentId = inspectButton.dataset.agentIdRef;
    state.previewAgentId = inspectButton.dataset.agentIdRef;
    renderTeamVisualizer();
  }
});

$("controlPlaneTabs")?.addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const tabs = [...event.currentTarget.querySelectorAll("[role='tab']")];
  if (!tabs.length) return;
  event.preventDefault();
  const current = Math.max(0, tabs.indexOf(document.activeElement));
  const next = event.key === "Home" ? 0
    : event.key === "End" ? tabs.length - 1
      : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  tabs[next].focus();
  tabs[next].click();
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
  const handoffShelfToggle = event.target.closest("[data-action='toggle-action-handoffs']");
  if (handoffShelfToggle) {
    state.showAllActionHandoffs = !state.showAllActionHandoffs;
    renderUserTaskSummary();
    return;
  }

  const reportShelfToggle = event.target.closest("[data-action='toggle-action-reports']");
  if (reportShelfToggle) {
    state.showAllActionReports = !state.showAllActionReports;
    renderUserTaskSummary();
    return;
  }

  const actionFocusButton = event.target.closest("[data-action='filter-user-actions'], [data-action='focus-user-action']");
  if (actionFocusButton) {
    applyActionFocus(actionFocusButton.dataset.actionCategory || null, actionFocusButton.dataset.actionId || null);
    renderUserTaskSummary();
    if (state.actionFocusCategory === "ready-questions") renderVisionPanelV2();
    if (state.actionFocusCategory === "repair-cards") renderRepairCards();
    scheduleActionFocus();
    return;
  }

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
    state.currentView = "actions";
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
  const resetButton = event.target.closest("[data-layout-reset]");
  if (resetButton) {
    if (resetButton.dataset.layoutReset === "all") clearAllCommandBoardOverrides();
    else resetSelectedCommandBoardLayout();
    return;
  }
  if (state.suppressTeamClick) return;
  const node = event.target.closest("[data-agent-id], [data-session-id]");
  if (!node) return;
  state.selectedAgentId = nodeEntityId(node);
  state.previewAgentId = nodeEntityId(node);
  renderTeamVisualizer();
});

$("teamTree").addEventListener("pointerover", (event) => {
  const node = event.target.closest("[data-agent-id], [data-session-id]");
  if (!node) return;
  state.previewAgentId = nodeEntityId(node);
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

function commandBoardNodeIdFromElement(target) {
  const pod = target.closest(".agent-pod");
  if (pod?.dataset.podId) return commandBoardNodeId("pod", pod.dataset.podId);
  const agentNode = target.closest("[data-agent-id], [data-session-id]");
  if (agentNode) return commandBoardNodeId("agent", nodeEntityId(agentNode));
  const layoutNode = target.closest("[data-layout-node-id]");
  return layoutNode?.dataset.layoutNodeId || "";
}

function beginCommandBoardDrag(event) {
  const handle = event.target.closest("[data-layout-drag-handle], .agent-node.core-peer-node, .agent-node.config-node, .user-node");
  if (!handle || event.button !== 0) return false;
  const nodeId = commandBoardNodeIdFromElement(handle);
  const node = state.commandBoardLayout?.nodes?.get(nodeId);
  if (!node) return false;
  const current = state.commandBoardOverrides.offsets?.[nodeId] || { dx: node.x - node.autoX, dy: node.y - node.autoY };
  state.commandBoardDrag = {
    pointerId: event.pointerId,
    nodeId,
    startX: event.clientX,
    startY: event.clientY,
    originDx: Number(current.dx || 0),
    originDy: Number(current.dy || 0),
    active: false
  };
  $("teamTree").setPointerCapture(event.pointerId);
  return true;
}

function updateCommandBoardDrag(event) {
  const drag = state.commandBoardDrag;
  if (!drag || event.pointerId !== drag.pointerId || !state.commandBoardLayout) return false;
  const dx = (event.clientX - drag.startX) / state.map.scale;
  const dy = (event.clientY - drag.startY) / state.map.scale;
  if (!drag.active && Math.hypot(dx, dy) < COMMAND_BOARD_DRAG_THRESHOLD) return true;
  drag.active = true;
  $("teamTree").classList.add("is-node-dragging");
  setCommandBoardOverride(drag.nodeId, drag.originDx + dx, drag.originDy + dy);
  state.commandBoardLayout = applyCommandBoardOverrides({
    ...state.commandBoardLayout,
    nodes: new Map([...state.commandBoardLayout.nodes].map(([id, node]) => [id, { ...node, x: node.autoX, y: node.autoY, manual: false }]))
  });
  finalizeCommandBoardEdges(state.commandBoardLayout);
  applyCommandBoardPositions();
  requestAnimationFrame(drawTeamLinks);
  return true;
}

function finishCommandBoardDrag(event) {
  const drag = state.commandBoardDrag;
  if (!drag || event.pointerId !== drag.pointerId) return false;
  if (drag.active) {
    saveCommandBoardLayoutOverrides();
    state.suppressTeamClick = true;
    setTimeout(() => {
      state.suppressTeamClick = false;
    }, 0);
  }
  state.commandBoardDrag = null;
  $("teamTree").classList.remove("is-node-dragging");
  return true;
}

function applyCommandBoardPositions() {
  const world = $("orgMapWorld");
  if (!world || !state.commandBoardLayout) return;
  const styleText = commandBoardWorldStyle(state.commandBoardLayout);
  for (const entry of styleText.split(";").map((part) => part.trim()).filter(Boolean)) {
    const [name, value] = entry.split(":");
    if (name && value) world.style.setProperty(name, value);
  }
  for (const pod of world.querySelectorAll(".agent-pod[data-pod-id]")) {
    const node = state.commandBoardLayout.nodes.get(commandBoardNodeId("pod", pod.dataset.podId));
    if (!node) continue;
    pod.style.setProperty("--map-x", `${node.x}px`);
    pod.style.setProperty("--map-y", `${node.y}px`);
    pod.classList.toggle("manual-layout", Boolean(node.manual));
  }
  for (const agentNode of world.querySelectorAll(".agent-node[data-layout-node-id]")) {
    const node = state.commandBoardLayout.nodes.get(agentNode.dataset.layoutNodeId);
    if (!node) continue;
    agentNode.classList.toggle("manual-layout", Boolean(node.manual));
  }
}

function resetSelectedCommandBoardLayout() {
  const selectedId = state.selectedAgentId ? commandBoardNodeId("agent", state.selectedAgentId) : "";
  if (state.commandBoardLayout?.nodes?.has(selectedId)) {
    clearCommandBoardOverride(selectedId);
    return;
  }
  for (const [id, node] of state.commandBoardLayout?.nodes || []) {
    if (id.startsWith("pod:") && node.pod?.agents?.some((agent) => agent.agent_id === state.selectedAgentId)) {
      clearCommandBoardOverride(id);
      return;
    }
  }
}

let mapDrag = null;
$("teamTree").addEventListener("pointerdown", (event) => {
  if (event.target.closest("[data-layout-reset]")) return;
  if (beginCommandBoardDrag(event)) return;
  if (event.target.closest("[data-agent-id], [data-session-id]")) return;
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
  const rect = $("teamTree").getBoundingClientRect();
  $("teamTree").style.setProperty("--cursor-x", `${event.clientX - rect.left}px`);
  $("teamTree").style.setProperty("--cursor-y", `${event.clientY - rect.top}px`);
  $("teamTree").classList.add("has-cursor-light");
  if (updateCommandBoardDrag(event)) return;
  if (!mapDrag || event.pointerId !== mapDrag.pointerId) return;
  state.map.x = mapDrag.originX + event.clientX - mapDrag.startX;
  state.map.y = mapDrag.originY + event.clientY - mapDrag.startY;
  applyMapTransform();
});

$("teamTree").addEventListener("pointerleave", () => {
  $("teamTree").classList.remove("has-cursor-light");
});

$("teamTree").addEventListener("pointerup", (event) => {
  if (finishCommandBoardDrag(event)) return;
  if (!mapDrag || event.pointerId !== mapDrag.pointerId) return;
  mapDrag = null;
  $("teamTree").classList.remove("is-panning");
});

$("teamTree").addEventListener("pointercancel", () => {
  state.commandBoardDrag = null;
  mapDrag = null;
  $("teamTree").classList.remove("is-panning");
  $("teamTree").classList.remove("is-node-dragging");
});

window.addEventListener("resize", () => {
  requestAnimationFrame(drawTeamLinks);
});


const LIQUID_MOTION_TARGETS = [
  ".recovery-nav",
  ".home-awareness",
  ".command-board-panel",
  ".contextual-inspector",
  ".focused-head",
  ".focused-grid > .panel",
  ".home-awareness-grid > section",
  ".home-notifications",
  ".current-work-card",
  ".notification-card",
  ".user-need-grid button",
  ".agent-node",
  ".user-node",
  ".agent-pod",
  ".record",
  ".view-tab",
  ".lang-toggle",
  ".file-button",
  ".view-back",
  ".sync-chip"
].join(",");

const LIQUID_REVEAL_TARGETS = [
  ".home-awareness-grid > section",
  ".home-notifications",
  ".current-work-card",
  ".notification-card",
  ".user-need-grid button",
  ".home-command-layout .command-board-panel",
  ".home-command-layout .contextual-inspector",
  ".focused-head",
  ".focused-grid > .panel",
  ".record",
  ".completion-phase",
  ".agent-node"
].join(",");

let liquidMotionRaf = null;
let liquidSpotlightEl = null;

function prefersReducedLiquidMotion() {
  return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function queueLiquidMotionRefresh() {
  if (liquidMotionRaf) return;
  liquidMotionRaf = requestAnimationFrame(() => {
    liquidMotionRaf = null;
    refreshLiquidMotion();
  });
}

function refreshLiquidMotion() {
  const reduce = prefersReducedLiquidMotion();
  document.documentElement.classList.toggle("orquesta-reduce-motion", reduce);
  const activeView = document.querySelector(".dashboard-view.active");
  if (!activeView) return;
  activeView.querySelectorAll(LIQUID_REVEAL_TARGETS).forEach((element, index) => {
    element.classList.add("liquid-reveal-item");
    const revealIndex = Math.min(index, 12);
    element.style.setProperty("--reveal-index", String(revealIndex));
    element.style.setProperty("--reveal-delay", `${revealIndex * 34}ms`);
  });
}

function setLiquidPointer(element, event) {
  const rect = element.getBoundingClientRect();
  element.style.setProperty("--mx", `${Math.max(0, event.clientX - rect.left)}px`);
  element.style.setProperty("--my", `${Math.max(0, event.clientY - rect.top)}px`);
}

function addLiquidRipple(element, event) {
  if (prefersReducedLiquidMotion()) return;
  const rect = element.getBoundingClientRect();
  const ripple = document.createElement("span");
  ripple.className = "liquid-ripple";
  ripple.style.setProperty("--tap-x", `${event.clientX - rect.left}px`);
  ripple.style.setProperty("--tap-y", `${event.clientY - rect.top}px`);
  element.appendChild(ripple);
  element.classList.add("is-liquid-press");
  window.setTimeout(() => ripple.remove(), 620);
  window.setTimeout(() => element.classList.remove("is-liquid-press"), 170);
}

function installLiquidMotion() {
  document.documentElement.classList.add("orquesta-motion-ready");

  document.addEventListener("pointermove", (event) => {
    if (prefersReducedLiquidMotion()) return;
    const target = event.target.closest(LIQUID_MOTION_TARGETS);
    if (!target) {
      if (liquidSpotlightEl) liquidSpotlightEl.classList.remove("is-spotlit");
      liquidSpotlightEl = null;
      return;
    }
    if (liquidSpotlightEl && liquidSpotlightEl !== target) {
      liquidSpotlightEl.classList.remove("is-spotlit");
    }
    liquidSpotlightEl = target;
    setLiquidPointer(target, event);
    target.classList.add("is-spotlit");
  }, { passive: true });

  document.addEventListener("pointerout", (event) => {
    if (!liquidSpotlightEl) return;
    const next = event.relatedTarget;
    if (next && liquidSpotlightEl.contains(next)) return;
    liquidSpotlightEl.classList.remove("is-spotlit");
    liquidSpotlightEl = null;
  }, { passive: true });

  document.addEventListener("pointerdown", (event) => {
    const target = event.target.closest([
      ".view-tab",
      ".view-back",
      ".lang-toggle",
      ".file-button",
      ".current-work-card",
      ".notification-card",
      ".user-need-grid button",
      ".review-choice-grid button",
      ".specialist-choice-grid button",
      ".production-choice-row button",
      ".agent-node",
      ".record"
    ].join(","));
    if (!target) return;
    setLiquidPointer(target, event);
    addLiquidRipple(target, event);
  }, { passive: true });

  if (window.matchMedia) {
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    motionQuery.addEventListener?.("change", queueLiquidMotionRefresh);
  }

  queueLiquidMotionRefresh();
}

installLiquidMotion();
render();
startServerPolling();


// ---- extracted inline script block 2 (id: refero-cursor-attached-light-script) from orquesta_cursor_attached_reflection_v6_no_white_awareness_fix(2).html ----
(function () {
  const SVG_NS = "http://www.w3.org/2000/svg";
  const RADIUS = 85;
  const MASK_PADDING = RADIUS + 80;

  const hostSelectors = [
    ".recovery-nav",
    ".home-awareness",
    ".command-board-panel",
    ".contextual-inspector",
    ".focused-head",
    ".focused-grid > .panel",
    ".home-command-layout .visualizer-shell",
    ".contextual-inspector .agent-inspector",
    ".team-tree"
  ].join(",");

  const cardSelectors = [
    ".home-awareness-grid > section",
    ".home-notifications",
    ".current-work-card",
    ".notification-card",
    ".user-need-grid button",
    ".record",
    ".agent-node",
    ".user-node",
    ".agent-pod",
    ".inspector-section",
    ".inspector-grid > div",
    ".user-task-card",
    ".user-task-empty",
    ".vision-question",
    ".answer-batch",
    ".repair-card",
    ".repair-empty",
    ".completion-brief",
    ".completion-current",
    ".completion-empty",
    ".completion-footer",
    ".completion-phase-body",
    ".setup-step",
    ".setup-hero-card",
    ".setup-form-card",
    ".setup-side-card",
    ".specialist-plan-card",
    ".production-start-card",
    ".specialist-candidate",
    ".production-candidate",
    ".delegation-stat",
    ".delegation-mini",
    ".delegation-row",
    ".answer-toolbar",
    ".review-list-block",
    ".trigger-list span",
    ".completion-item",
    ".question-nav-item",
    ".specialist-choice-grid button",
    ".production-choice-row button",
    ".review-choice-grid button"
  ].join(",");

  const allSelectors = [hostSelectors, cardSelectors].join(",");
  let svg;
  let maskGroup;
  let lightCore;
  let lightEdge;
  let maskFrame;
  let activePointer = null;
  let pointerRaf = 0;
  let maskRaf = 0;

  document.body.classList.add("refero-one-light");

  function prefersReducedMotion() {
    return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function svgEl(name, attrs = {}) {
    const node = document.createElementNS(SVG_NS, name);
    Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value));
    return node;
  }

  function ensureOverlay() {
    if (svg) return;

    const gradientId = "orquestaCursorLightGradient";
    const edgeGradientId = "orquestaCursorLightEdgeGradient";
    const maskId = "orquestaReflectiveSurfaceMask";

    svg = svgEl("svg", {
      class: "orquesta-cursor-glass-light",
      "aria-hidden": "true",
      focusable: "false"
    });

    const defs = svgEl("defs");
    const gradient = svgEl("radialGradient", {
      id: gradientId,
      gradientUnits: "userSpaceOnUse",
      cx: "-1000",
      cy: "-1000",
      r: String(RADIUS)
    });
    [
      ["0", "rgba(255,255,255,0.98)"],
      ["0.12", "rgba(255,255,255,0.58)"],
      ["0.30", "rgba(196,217,255,0.28)"],
      ["0.48", "rgba(94,106,210,0.18)"],
      ["0.64", "rgba(2,184,204,0.10)"],
      ["1", "rgba(255,255,255,0)"]
    ].forEach(([offset, color]) => gradient.append(svgEl("stop", { offset, "stop-color": color })));

    const edgeGradient = svgEl("radialGradient", {
      id: edgeGradientId,
      gradientUnits: "userSpaceOnUse",
      cx: "-1000",
      cy: "-1000",
      r: String(RADIUS * 1.16)
    });
    [
      ["0", "rgba(255,255,255,0)"],
      ["0.34", "rgba(255,255,255,0.16)"],
      ["0.52", "rgba(2,184,204,0.12)"],
      ["0.74", "rgba(94,106,210,0.08)"],
      ["1", "rgba(255,255,255,0)"]
    ].forEach(([offset, color]) => edgeGradient.append(svgEl("stop", { offset, "stop-color": color })));

    const mask = svgEl("mask", { id: maskId, maskUnits: "userSpaceOnUse" });
    maskFrame = svgEl("rect", { x: "0", y: "0", fill: "black" });
    maskGroup = svgEl("g", { fill: "white" });
    mask.append(maskFrame, maskGroup);
    defs.append(gradient, edgeGradient, mask);

    lightCore = svgEl("rect", {
      class: "cursor-light-core",
      x: "0",
      y: "0",
      fill: `url(#${gradientId})`,
      mask: `url(#${maskId})`
    });
    lightEdge = svgEl("rect", {
      class: "cursor-light-edge",
      x: "0",
      y: "0",
      fill: `url(#${edgeGradientId})`,
      mask: `url(#${maskId})`
    });

    svg.append(defs, lightCore, lightEdge);
    document.body.appendChild(svg);
  }

  function markTargets() {
    document.querySelectorAll(hostSelectors).forEach((el) => {
      if (!el.classList.contains("one-light-host")) el.classList.add("one-light-host");
    });
    document.querySelectorAll(cardSelectors).forEach((el) => {
      if (!el.classList.contains("one-light-card")) el.classList.add("one-light-card");
    });
  }

  function visibleRadius(value, rect) {
    if (!value) return 0;
    const first = String(value).trim().split(/\s+/)[0] || "0";
    const amount = parseFloat(first);
    if (!Number.isFinite(amount)) return 0;
    const radius = first.includes("%") ? Math.min(rect.width, rect.height) * amount / 100 : amount;
    return Math.max(0, Math.min(radius, rect.width / 2, rect.height / 2));
  }

  function isVisibleReflector(el, viewportWidth, viewportHeight) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 3 || rect.height < 3) return null;
    if (rect.right < -MASK_PADDING || rect.left > viewportWidth + MASK_PADDING) return null;
    if (rect.bottom < -MASK_PADDING || rect.top > viewportHeight + MASK_PADDING) return null;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return null;
    return { rect, style };
  }

  function refreshMask() {
    ensureOverlay();
    const viewportWidth = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0);
    const viewportHeight = Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0);
    svg.setAttribute("viewBox", `0 0 ${viewportWidth} ${viewportHeight}`);
    [maskFrame, lightCore, lightEdge].forEach((node) => {
      node.setAttribute("width", String(viewportWidth));
      node.setAttribute("height", String(viewportHeight));
    });

    const fragment = document.createDocumentFragment();
    const seen = new Set();
    document.querySelectorAll(allSelectors).forEach((el) => {
      if (seen.has(el) || el.closest(".orquesta-cursor-glass-light")) return;
      seen.add(el);
      const visible = isVisibleReflector(el, viewportWidth, viewportHeight);
      if (!visible) return;
      const { rect, style } = visible;
      const radius = visibleRadius(style.borderTopLeftRadius, rect);
      const maskRect = svgEl("rect", {
        x: rect.left.toFixed(2),
        y: rect.top.toFixed(2),
        width: rect.width.toFixed(2),
        height: rect.height.toFixed(2),
        rx: radius.toFixed(2),
        ry: radius.toFixed(2)
      });
      fragment.appendChild(maskRect);
    });
    maskGroup.replaceChildren(fragment);
  }

  function scheduleMaskRefresh() {
    if (maskRaf) return;
    maskRaf = requestAnimationFrame(() => {
      maskRaf = 0;
      markTargets();
      refreshMask();
    });
  }

  function setLightPosition(x, y) {
    const gradients = svg.querySelectorAll("radialGradient");
    gradients.forEach((gradient) => {
      gradient.setAttribute("cx", x.toFixed(2));
      gradient.setAttribute("cy", y.toFixed(2));
    });
  }

  function clearLight() {
    activePointer = null;
    if (svg) svg.classList.remove("is-active");
  }

  function isReflectiveTarget(target) {
    return !!(target && target.closest && target.closest(allSelectors));
  }

  function applyPointer() {
    pointerRaf = 0;
    ensureOverlay();
    if (!activePointer || prefersReducedMotion()) {
      clearLight();
      return;
    }

    if (!isReflectiveTarget(activePointer.target)) {
      clearLight();
      return;
    }

    setLightPosition(activePointer.x, activePointer.y);
    svg.classList.add("is-active");
  }

  function schedulePointer(event) {
    activePointer = { x: event.clientX, y: event.clientY, target: event.target };
    if (!pointerRaf) pointerRaf = requestAnimationFrame(applyPointer);
  }

  ensureOverlay();
  markTargets();
  refreshMask();

  const observer = new MutationObserver(scheduleMaskRefresh);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "style", "hidden", "aria-hidden"]
  });

  document.addEventListener("pointermove", schedulePointer, { passive: true });
  document.addEventListener("pointerover", schedulePointer, { passive: true });
  document.addEventListener("pointerout", (event) => {
    const next = event.relatedTarget;
    if (next && isReflectiveTarget(next)) return;
    clearLight();
  }, { passive: true });
  document.addEventListener("pointerleave", clearLight, { passive: true });
  document.addEventListener("scroll", scheduleMaskRefresh, { passive: true, capture: true });
  window.addEventListener("resize", scheduleMaskRefresh, { passive: true });
  window.addEventListener("blur", clearLight, { passive: true });

  if (window.matchMedia) {
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    motionQuery.addEventListener?.("change", () => {
      if (prefersReducedMotion()) clearLight();
      scheduleMaskRefresh();
    });
  }

  window.OrquestaCursorLight = {
    refresh: scheduleMaskRefresh,
    clear: clearLight
  };
})();


// ---- extracted inline script block 3 (id: orquesta-v4-runtime-radius-fix) from orquesta_cursor_attached_reflection_v6_no_white_awareness_fix(2).html ----
// v4 runtime guard: if an older cursor overlay already exists, force its gradients smaller too.
(() => {
  const shrink = () => {
    document.querySelectorAll('#orquestaCursorLightGradient, #orquestaCursorLightEdgeGradient').forEach((g) => {
      g.setAttribute('r', g.id.includes('Edge') ? '98' : '85');
    });
  };
  shrink();
  window.addEventListener('DOMContentLoaded', shrink, { once: true });
  window.addEventListener('load', shrink, { once: true });
})();

