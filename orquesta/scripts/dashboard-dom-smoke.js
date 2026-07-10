#!/usr/bin/env node

const targetUrl = process.argv[2] || process.env.DASHBOARD_URL || "http://127.0.0.1:4177/";

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch (error) {
    try {
      return require("playwright");
    } catch {
      throw new Error("Playwright is required for dashboard DOM smoke checks. Install it or run this from a Codex environment that provides Playwright.");
    }
  }
}

async function launchBrowser(chromium) {
  try {
    return await chromium.launch({ channel: "chrome", headless: true });
  } catch {
    return chromium.launch({ headless: true });
  }
}

async function main() {
  const { chromium } = await loadPlaywright();
  const browser = await launchBrowser(chromium);
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const consoleErrors = [];
  const pageErrors = [];

  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  await page.goto(targetUrl, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);

  const result = await page.evaluate(async () => {
    const nodes = [...document.querySelectorAll("[data-agent-id]")].map((node) => node.getAttribute("data-agent-id"));
    const viewTargets = [...document.querySelectorAll("[data-view-target]")].map((node) => node.getAttribute("data-view-target"));
    const shellText = [
      document.querySelector(".brand")?.textContent || "",
      document.querySelector(".command-navigation")?.textContent || "",
      document.querySelector(".recovery-nav")?.textContent || ""
    ].join(" ");
    const inertNav = [...document.querySelectorAll(".command-navigation button, .recovery-nav button, [role='tab']")]
      .filter((node) => /Insights|Settings/i.test(node.textContent || ""))
      .map((node) => (node.textContent || "").trim());
    const homeAwareness = document.querySelector(".home-awareness");
    const commandBoard = document.querySelector(".command-board-panel");
    const inspector = document.querySelector(".contextual-inspector");
    const runningAgents = document.querySelector("#runningAgents");
    const currentWork = document.querySelector("#currentWorkSummary");
    const userNeed = document.querySelector("#userNeedSummary");
    const userTaskSummary = document.querySelector("#userTaskSummary");
    const actionPriorityInbox = document.querySelector(".action-priority-inbox");
    const actionSummaryFilters = [...document.querySelectorAll(".action-summary-filter[data-action-category]")];
    const priorityActionItems = [...document.querySelectorAll(".action-inbox-item[data-action-priority='p0'], .action-inbox-item[data-action-priority='p1']")];
    const p2ActionShelves = [...document.querySelectorAll(".action-shelf")];
    const actionShelfControls = [...document.querySelectorAll(".action-shelf [data-action='toggle-action-handoffs'], .action-shelf [data-action='toggle-action-reports']")];
    const compactLongTextBlocks = [...document.querySelectorAll(".handoff-draft-card .report-excerpt pre, .report-review-card .report-excerpt pre")];
    const teamTree = document.querySelector("#teamTree");
    const legend = document.querySelector(".map-status-legend");
    const notificationQueue = document.querySelector("#notificationQueue");
    const delegationTruth = document.querySelector("#delegationTruthSummary");
    const delegationLedger = document.querySelector("#delegationLedger");
    const delegationCollapses = [...document.querySelectorAll("[data-view-panel='delegation'] .delegation-collapse")];
    const delegationRevealControls = [...document.querySelectorAll("[data-view-panel='delegation'] [data-action='toggle-delegation-truth'], [data-view-panel='delegation'] [data-action='toggle-delegation-ledger']")];
    const delegationTruthRevealControls = [...document.querySelectorAll("[data-view-panel='delegation'] [data-action='toggle-delegation-truth']")];
    const delegationLedgerRevealControls = [...document.querySelectorAll("[data-view-panel='delegation'] [data-action='toggle-delegation-ledger']")];
    const delegationTruthItems = [...document.querySelectorAll("#delegationTruthSummary [data-delegation-task-id]")];
    const delegationLedgerRows = [...document.querySelectorAll("#delegationLedger [data-delegation-row-id]")];
    const delegationTruthPanel = delegationTruth?.closest(".panel");
    const orgMapWorld = document.querySelector("#orgMapWorld");
    const rectFor = (node) => {
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return { top: rect.top, left: rect.left, width: rect.width, height: rect.height, area: rect.width * rect.height };
    };
    const overlapArea = (a, b) => {
      const x = Math.max(0, Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left));
      const y = Math.max(0, Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top));
      return x * y;
    };
    const commandBoardNodes = [
      ".user-node",
      ".orchestrator-node",
      ".config-node",
      ".liaison-node",
      ".agent-node.support-child-node",
      ".agent-pod"
    ].flatMap((selector) => [...document.querySelectorAll(selector)])
      .filter((node) => node.offsetParent !== null);
    const commandBoardRects = commandBoardNodes.map((node) => ({
      label: node.dataset.podId || node.dataset.agentId || node.className || node.tagName,
      rect: rectFor(node)
    })).filter((item) => item.rect && item.rect.width > 0 && item.rect.height > 0);
    const commandBoardOverlaps = [];
    for (let i = 0; i < commandBoardRects.length; i += 1) {
      for (let j = i + 1; j < commandBoardRects.length; j += 1) {
        const area = overlapArea(commandBoardRects[i].rect, commandBoardRects[j].rect);
        if (area > 80) {
          commandBoardOverlaps.push(`${commandBoardRects[i].label} overlaps ${commandBoardRects[j].label} (${Math.round(area)}px2)`);
        }
      }
    }
    const worldStyle = orgMapWorld ? getComputedStyle(orgMapWorld) : null;
    const teamLinks = [...document.querySelectorAll(".team-link")];
    const cubicTeamLinks = teamLinks
      .map((node) => node.getAttribute("d") || "")
      .filter((path) => /[Cc]/.test(path));
    const supportChildLinks = teamLinks.filter((node) => node.dataset.linkKind === "support-child");
    const supportChildNodes = ["vision-curator", "error-concierge"]
      .map((agentId) => document.querySelector(`.agent-node.support-child-node[data-agent-id="${agentId}"]`))
      .filter(Boolean);
    const supportChildDragHandles = supportChildNodes
      .filter((node) => node.querySelector("[data-layout-drag-handle]"))
      .length;
    const supportChildAbsolutePositions = supportChildNodes
      .filter((node) => getComputedStyle(node).position === "absolute")
      .length;
    const visibleMissionPlanes = [...document.querySelectorAll(".mission-plane")]
      .filter((node) => {
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0.08 && rect.width > 20 && rect.height > 20;
      })
      .length;
    let api = null;
    try {
      const response = await fetch("/api/state", { cache: "no-store" });
      api = await response.json();
    } catch {
      api = null;
    }
    const agentCount = Array.isArray(api?.agents) ? api.agents.length : null;
    const apiAgentIds = Array.isArray(api?.agents) ? api.agents.map((agent) => agent.agent_id).filter(Boolean).sort() : [];
    const domAgentIds = [...nodes].sort();
    const specialistTasks = Array.isArray(api?.tasks)
      ? api.tasks.filter((task) => task.routing_class === "specialist_required" && ["active", "blocked", "needs_review", "accepted"].includes(String(task.state || "")))
      : [];
    const directExceptionTasks = Array.isArray(api?.tasks)
      ? api.tasks.filter((task) => task.routing_class === "direct_exception" && ["active", "accepted"].includes(String(task.state || "")))
      : [];
    const delegationOpenState = (task) => ["active", "blocked", "needs_review", "needs-review", "accepted"].includes(String(task.state || "").toLowerCase());
    const reportStateForSmoke = (task) => {
      if (!task.specialist_report_required) return "not_expected";
      if (!task.specialist_report_path) return "missing";
      if (String(task.state || "").toLowerCase() === "accepted") return "accepted";
      if (String(task.state || "").toLowerCase().includes("review")) return "awaiting";
      if (task.completed_at || task.result_summary) return "present";
      return "missing";
    };
    const delegationTasks = Array.isArray(api?.tasks) ? api.tasks.filter(delegationOpenState) : [];
    const delegationSpecialistTasks = delegationTasks.filter((task) => task.routing_class === "specialist_required");
    const delegationDirectTasks = delegationTasks.filter((task) => task.routing_class === "direct_exception");
    const delegationTruthFocusCount = delegationSpecialistTasks
      .filter((task) => ["missing", "awaiting", "present"].includes(reportStateForSmoke(task)))
      .length + delegationDirectTasks.length;
    const delegationLedgerCount = delegationSpecialistTasks.length + delegationDirectTasks.length;
    const handoffDraftCount = Array.isArray(api?.handoffDrafts) ? api.handoffDrafts.length : 0;
    const reportReviewCount = Array.isArray(api?.reportReviews) ? api.reportReviews.length : 0;
    const actionItemRects = priorityActionItems.map(rectFor).filter(Boolean);
    const shelfRects = p2ActionShelves.map(rectFor).filter(Boolean);
    const firstPriorityActionTop = actionItemRects.length ? Math.min(...actionItemRects.map((rect) => rect.top)) : null;
    const firstShelfTop = shelfRects.length ? Math.min(...shelfRects.map((rect) => rect.top)) : null;
    const compactLongTextHeights = compactLongTextBlocks.map((node) => Math.round(node.getBoundingClientRect().height));
    const actionDeepLinkButtons = [...document.querySelectorAll("#notificationQueue [data-view-target='actions']")];
    const actionDeepLinksWithMetadata = actionDeepLinkButtons.filter((node) => node.dataset.actionCategory).length;
    const controlPlane = document.querySelector("[data-view-panel='control']");
    const controlSummary = document.querySelector("#controlPlaneSummary");
    const controlLedger = document.querySelector("#controlPlaneLedger");
    const controlDetail = document.querySelector("#controlPlaneDetail");
    const controlCapacityRows = [...document.querySelectorAll("#controlPlaneLedger [data-capacity-record-id]")];
    const controlActualUnknown = [...document.querySelectorAll("[data-control-actual-model]")]
      .some((node) => /unknown|不明/i.test(node.textContent || ""));
    const legendRect = rectFor(legend);
    const teamRect = rectFor(teamTree);
    const legendInsideMap = Boolean(legendRect && teamRect
      && legendRect.left >= teamRect.left
      && legendRect.top >= teamRect.top
      && legendRect.left + legendRect.width <= teamRect.left + teamRect.width + 1
      && legendRect.top + legendRect.height <= teamRect.top + teamRect.height + 1);
    const supportGrid = document.querySelector(".user-support-grid");
    const supportGridRect = rectFor(supportGrid);
    const supportGridInsideMap = Boolean(supportGridRect && teamRect
      && supportGridRect.left >= teamRect.left
      && supportGridRect.top >= teamRect.top
      && supportGridRect.left + supportGridRect.width <= teamRect.left + teamRect.width + 1
      && supportGridRect.top + supportGridRect.height <= teamRect.top + teamRect.height + 1);
    const legendGuardNodes = [
      [".user-node", "user-node"],
      [".config-node", "config-node"],
      [".orchestrator-node", "orchestrator-node"],
      [".agent-pod", "production-group"],
      [".agent-node.support-child-node", "support-child"]
    ];
    const legendTopNodeOverlaps = legendRect
      ? legendGuardNodes.flatMap(([selector, fallbackLabel]) => [...document.querySelectorAll(selector)]
        .filter((node) => node.offsetParent !== null)
        .map((node) => ({
          label: node.dataset.agentId || fallbackLabel,
          area: overlapArea(legendRect, rectFor(node))
        }))
        .filter((item) => item.area > 80)
        .map((item) => `${item.label} overlaps status legend (${Math.round(item.area)}px2)`))
      : [];
    const supportGridStyle = supportGrid ? getComputedStyle(supportGrid) : null;
    const colorHasVisibleAlpha = (value) => {
      const match = String(value || "").match(/rgba?\(([^)]+)\)/i);
      if (!match) return !/transparent|none/i.test(String(value || ""));
      const parts = match[1].split(",").map((part) => part.trim());
      const alpha = parts.length >= 4 ? Number(parts[3]) : 1;
      return Number.isFinite(alpha) && alpha > 0.05;
    };
    const supportPlateVisible = Boolean(supportGridStyle && (
      colorHasVisibleAlpha(supportGridStyle.backgroundColor)
      || (parseFloat(supportGridStyle.borderTopWidth || "0") > 0 && colorHasVisibleAlpha(supportGridStyle.borderTopColor))
      || (supportGridStyle.boxShadow && supportGridStyle.boxShadow !== "none")
      || (supportGridStyle.backdropFilter && supportGridStyle.backdropFilter !== "none")
      || (supportGridStyle.webkitBackdropFilter && supportGridStyle.webkitBackdropFilter !== "none")
    ));
    const teamTreeStyle = teamTree ? getComputedStyle(teamTree) : null;
    const orgMapWorldStyle = orgMapWorld ? getComputedStyle(orgMapWorld) : null;
    const inspectorStyle = inspector ? getComputedStyle(inspector) : null;
    const commandBoardUserSelectSuppressed = [teamTreeStyle?.userSelect, orgMapWorldStyle?.userSelect]
      .every((value) => value === "none");
    const inspectorTextSelectionAvailable = inspectorStyle ? inspectorStyle.userSelect !== "none" : true;
    return {
      title: document.title,
      agentNodeCount: nodes.length,
      agentIds: nodes,
      apiAgentIds,
      domAgentIds,
      viewTargets,
      hasHomeView: viewTargets.includes("home") && Boolean(document.querySelector("[data-view-panel='home']")),
      hasActionsView: viewTargets.includes("actions") && Boolean(document.querySelector("[data-view-panel='actions']")),
      hasDelegationView: viewTargets.includes("delegation") && Boolean(document.querySelector("[data-view-panel='delegation']")),
      hasControlView: viewTargets.includes("control") && Boolean(controlPlane),
      hasControlSummary: Boolean(controlSummary),
      hasControlLedger: Boolean(controlLedger),
      hasControlDetail: Boolean(controlDetail),
      controlCapacityRowCount: controlCapacityRows.length,
      controlActualUnknown,
      apiHasControlState: Boolean(api && api.capacity && api.controlAudit && api.modelPolicy),
      hasSetupCard: Boolean(document.querySelector("#setupWizard")),
      apiAgentCount: agentCount,
      apiSource: api?.source || null,
      apiProjectRoot: api?.projectRoot || null,
      encodingWarnings: api?.health?.encodingWarnings?.length ?? null,
      loadedFilesCount: Array.isArray(api?.loadedFiles) ? api.loadedFiles.length : null,
      hasUserOnlyMap: nodes.length === 0 && document.body.innerText.includes("User"),
      inertNav,
      hasRejectedShellLabel: /Executive Glass Tree/i.test(shellText),
      hasHomeAwareness: Boolean(homeAwareness),
      hasRunningAgentsCard: Boolean(runningAgents),
      hasCurrentWorkSummary: Boolean(currentWork),
      hasUserNeedSummary: Boolean(userNeed),
      hasNotificationQueue: Boolean(notificationQueue),
      notificationButtons: [...document.querySelectorAll("#notificationQueue [data-action='open-view']")].length,
      hasUserTaskSummary: Boolean(userTaskSummary),
      hasActionPriorityInbox: Boolean(actionPriorityInbox),
      actionSummaryFilterCount: actionSummaryFilters.length,
      priorityActionItemCount: priorityActionItems.length,
      firstPriorityActionTop,
      firstShelfTop,
      actionShelfControlCount: actionShelfControls.length,
      handoffDraftCount,
      reportReviewCount,
      compactLongTextHeights,
      actionDeepLinkButtonCount: actionDeepLinkButtons.length,
      actionDeepLinksWithMetadata,
      hasContextualInspector: Boolean(inspector),
      hasDelegationTruth: Boolean(delegationTruth),
      hasDelegationLedger: Boolean(delegationLedger),
      delegationCollapseCount: delegationCollapses.length,
      delegationRevealControlCount: delegationRevealControls.length,
      delegationTruthRevealControlCount: delegationTruthRevealControls.length,
      delegationLedgerRevealControlCount: delegationLedgerRevealControls.length,
      delegationTruthVisibleCount: delegationTruthItems.length,
      delegationLedgerVisibleCount: delegationLedgerRows.length,
      delegationTruthRect: rectFor(delegationTruth),
      delegationTruthPanelRect: rectFor(delegationTruthPanel),
      delegationTruthFocusCount,
      delegationLedgerCount,
      hasDagreVendor: Boolean(window.dagre?.graphlib?.Graph && window.dagre?.layout),
      hasLaneGridEngine: orgMapWorld?.dataset.layoutEngine === "orquesta-lane-grid-v1",
      hasCommandBoardAutoLayoutVars: Boolean(worldStyle?.getPropertyValue("--cb-agent-orchestrator-x").trim()
        && worldStyle?.getPropertyValue("--cb-virtual-user-x").trim()
        && worldStyle?.getPropertyValue("--cb-lane-support-x").trim()),
      cubicTeamLinkCount: cubicTeamLinks.length,
      cubicTeamLinks,
      supportChildLinkCount: supportChildLinks.length,
      supportChildDragHandleCount: supportChildDragHandles,
      supportChildAbsolutePositionCount: supportChildAbsolutePositions,
      visibleMissionPlanes,
      commandBoardOverlapCount: commandBoardOverlaps.length,
      commandBoardOverlaps,
      visibleSpecialistTaskIds: specialistTasks
        .map((task) => task.task_id)
        .filter((taskId) => document.body.innerText.includes(taskId)),
      visibleDirectExceptionTaskIds: directExceptionTasks
        .map((task) => task.task_id)
        .filter((taskId) => document.body.innerText.includes(taskId)),
      specialistTaskCount: specialistTasks.length,
      directExceptionTaskCount: directExceptionTasks.length,
      legendInsideMap,
      supportGridInsideMap,
      supportPlateVisible,
      commandBoardUserSelectSuppressed,
      inspectorTextSelectionAvailable,
      legendTopNodeOverlapCount: legendTopNodeOverlaps.length,
      legendTopNodeOverlaps,
      layout: {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        scrollRatio: document.documentElement.scrollHeight / window.innerHeight,
        horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 2,
        homeAwareness: rectFor(homeAwareness),
        commandBoard: rectFor(commandBoard),
        inspector: rectFor(inspector),
        teamTree: teamRect,
        legend: legendRect,
        supportGrid: supportGridRect
      }
    };
  });

  await page.click("[data-view-target='control']");
  await page.waitForTimeout(180);
  result.controlPlane = await page.evaluate(() => {
    const capacityRows = [...document.querySelectorAll("#controlPlaneLedger [data-capacity-record-id]")];
    const firstRow = capacityRows[0];
    const tabs = [...document.querySelectorAll("#controlPlaneTabs [role='tab']")];
    const detail = document.querySelector("#controlPlaneDetail");
    const actualModels = [...document.querySelectorAll("#controlPlaneLedger [data-control-actual-model]")]
      .map((node) => (node.textContent || "").trim());
    return {
      active: document.querySelector("[data-view-panel='control']")?.classList.contains("active") || false,
      capacityRows: capacityRows.length,
      tabCount: tabs.length,
      detailVisible: Boolean(detail?.textContent?.trim()),
      selectedCapacityId: firstRow?.dataset.capacityRecordId || null,
      actualModels,
      hasAcceptedStartWarning: /Dispatch accepted; turn start unconfirmed|送信受理。ターン開始は未確認/.test(document.querySelector("#controlPlaneLedger")?.textContent || ""),
      hasFalseRunningClaim: /dispatch accepted[^\n]*(running|started)|送信受理[^\n]*(実行中|稼働中)/i.test(document.querySelector("#controlPlaneLedger")?.textContent || "")
    };
  });
  if (result.controlPlane.selectedCapacityId) {
    await page.click(`#controlPlaneLedger [data-capacity-record-id='${result.controlPlane.selectedCapacityId}']`);
    await page.waitForTimeout(120);
    result.controlPlane.detailAfterSelect = await page.evaluate(() => ({
      detailText: document.querySelector("#controlPlaneDetail")?.textContent || "",
      focusedInsideDetail: document.querySelector("#controlPlaneDetail")?.contains(document.activeElement) || document.activeElement === document.querySelector("#controlPlaneDetail")
    }));
  }
  await page.click("[data-view-target='home']");
  await page.waitForTimeout(100);
  const controlHomeNotice = page.locator("#notificationQueue [data-view-target='control'][data-control-record-id]").first();
  if (await controlHomeNotice.count()) {
    await controlHomeNotice.click();
    await page.waitForTimeout(220);
    result.controlDeepLink = await page.evaluate(() => ({
      active: document.querySelector("[data-view-panel='control']")?.classList.contains("active") || false,
      selected: document.querySelector("#controlPlaneLedger .control-ledger-row.is-selected")?.dataset.capacityRecordId || null,
      focusInsideControl: document.querySelector("[data-view-panel='control']")?.contains(document.activeElement) || false
    }));
  }

  await page.click("[data-view-target='setup']");
  await page.waitForTimeout(250);
  result.setupLayout = await page.evaluate(() => {
    const rectFor = (node) => {
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return { top: rect.top, left: rect.left, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom };
    };
    const viewportWidth = window.innerWidth;
    const setupPanel = document.querySelector("[data-view-panel='setup'] .setup-wizard-panel");
    const foundationPanel = document.querySelector("[data-view-panel='setup'] .foundation-audit-panel");
    const titleInput = document.querySelector("[data-setup-field='project_title']");
    const descriptionInput = document.querySelector("[data-setup-field='project_description']");
    const setupActions = [...document.querySelectorAll("#setupWizard .answer-toolbar button")];
    const visibleWithinViewport = (rect) => Boolean(rect
      && rect.width > 40
      && rect.height > 20
      && rect.left >= -1
      && rect.right <= viewportWidth + 1);
    return {
      setupPanel: rectFor(setupPanel),
      foundationPanel: rectFor(foundationPanel),
      titleInput: rectFor(titleInput),
      descriptionInput: rectFor(descriptionInput),
      actionButtons: setupActions.map(rectFor),
      hasProjectIntakeForm: Boolean(titleInput || descriptionInput || setupActions.length),
      setupPanelWide: setupPanel ? setupPanel.getBoundingClientRect().width >= Math.min(860, viewportWidth - 64) : false,
      foundationBelowSetup: Boolean(setupPanel && foundationPanel
        && foundationPanel.getBoundingClientRect().top >= setupPanel.getBoundingClientRect().bottom - 1),
      titleVisible: titleInput ? visibleWithinViewport(rectFor(titleInput)) : true,
      descriptionVisible: descriptionInput ? visibleWithinViewport(rectFor(descriptionInput)) : true,
      actionsVisible: setupActions.length > 0 ? setupActions.every((button) => visibleWithinViewport(rectFor(button))) : true,
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 2
    };
  });

  await page.click("[data-view-target='home']");
  await page.waitForTimeout(150);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  result.mobileLayout = await page.evaluate(() => {
    const rectFor = (node) => {
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return { top: rect.top, left: rect.left, width: rect.width, height: rect.height, area: rect.width * rect.height };
    };
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 2,
      notificationQueue: rectFor(document.querySelector("#notificationQueue")),
      commandBoard: rectFor(document.querySelector(".command-board-panel"))
    };
  });

  await browser.close();

  const failures = [];
  if (pageErrors.length) failures.push(`page errors: ${pageErrors.join(" | ")}`);
  if (consoleErrors.some((message) => /ReferenceError|TypeError|SyntaxError/i.test(message))) {
    failures.push(`console errors: ${consoleErrors.join(" | ")}`);
  }
  if (result.agentNodeCount < 1) failures.push("no [data-agent-id] nodes rendered");
  if (result.apiAgentCount !== null && result.agentNodeCount === 0 && result.apiAgentCount > 0) {
    failures.push(`API returned ${result.apiAgentCount} agents but DOM rendered none`);
  }
  if (result.apiSource && result.apiSource !== "server") failures.push(`api source was ${result.apiSource}, expected server`);
  if (result.encodingWarnings !== null && result.encodingWarnings > 0) failures.push(`api reported ${result.encodingWarnings} encoding warnings`);
  if (result.apiAgentIds.length && result.domAgentIds.join("|") !== result.apiAgentIds.join("|")) {
    failures.push(`DOM agent ids did not match API agents: dom=${result.domAgentIds.join(",")} api=${result.apiAgentIds.join(",")}`);
  }
  if (!result.hasHomeView) failures.push("Home view or Home navigation is missing");
  if (!result.hasActionsView) failures.push("User Actions focused view or navigation is missing");
  if (!result.hasDelegationView) failures.push("Delegation focused view or navigation is missing");
  if (!result.hasControlView) failures.push("Control Plane view or navigation is missing");
  if (!result.apiHasControlState) failures.push("API state does not expose capacity, controlAudit, and modelPolicy");
  if (!result.hasControlSummary || !result.hasControlLedger || !result.hasControlDetail) {
    failures.push("Control Plane summary, ledger, or selected-detail target is missing");
  }
  if (result.apiHasControlState && result.controlCapacityRowCount === 0) failures.push("Control Plane did not render capacity records");
  if (result.apiHasControlState && !result.controlActualUnknown) failures.push("Control Plane does not preserve an unknown actual-model state");
  if (!result.controlPlane?.active) failures.push("Control Plane did not open from its navigation tab");
  if ((result.controlPlane?.capacityRows || 0) !== result.controlCapacityRowCount) failures.push("Control Plane capacity ledger changed unexpectedly after navigation");
  if ((result.controlPlane?.tabCount || 0) < 3) failures.push("Control Plane section tabs are missing");
  if (result.controlPlane?.capacityRows > 0 && !result.controlPlane?.detailAfterSelect?.detailText?.trim()) failures.push("Control Plane capacity selection did not render detail");
  if (result.controlPlane?.hasFalseRunningClaim) failures.push("Control Plane labels dispatch accepted as running or started");
  if (result.controlPlane?.hasAcceptedStartWarning === false) failures.push("Control Plane does not distinguish dispatch acceptance from turn start");
  if (result.controlDeepLink && (!result.controlDeepLink.active || !result.controlDeepLink.selected || !result.controlDeepLink.focusInsideControl)) {
    failures.push("Home Control Plane notification did not deep-link to a selected capacity record");
  }
  if (!result.hasSetupCard) failures.push("setup card #setupWizard was not rendered in focused views");
  if (!result.setupLayout?.setupPanelWide) failures.push("setup panel is not wide enough for first-run project intake");
  if (!result.setupLayout?.foundationBelowSetup) failures.push("foundation audit panel is not below the setup panel");
  if (!result.setupLayout?.titleVisible) failures.push("setup project title input is not fully visible");
  if (!result.setupLayout?.descriptionVisible) failures.push("setup project description textarea is not fully visible");
  if (!result.setupLayout?.actionsVisible) failures.push("setup action buttons are not fully visible");
  if (result.setupLayout?.horizontalOverflow) failures.push("setup view has horizontal overflow");
  if (result.hasRejectedShellLabel) failures.push("rejected Executive Glass Tree shell label is still visible");
  if (result.inertNav.length) failures.push(`decorative or unwired nav labels are visible: ${result.inertNav.join(", ")}`);
  if (!result.hasHomeAwareness) failures.push("Home operational awareness strip is missing");
  if (result.hasRunningAgentsCard) failures.push("Home Running Agents card should not be rendered");
  if (!result.hasCurrentWorkSummary) failures.push("Home current work summary is missing");
  if (!result.hasUserNeedSummary) failures.push("Home user-needed summary is missing");
  if (!result.hasNotificationQueue) failures.push("Home notification queue is missing");
  if (!result.hasUserTaskSummary) failures.push("User Actions summary is missing");
  if (!result.hasActionPriorityInbox) failures.push("User Actions priority inbox is missing");
  if (result.actionSummaryFilterCount < 4) failures.push(`User Actions summary filters are missing or too few: ${result.actionSummaryFilterCount}`);
  if (result.actionDeepLinkButtonCount > 0 && result.actionDeepLinksWithMetadata === 0) failures.push("Home action notifications do not expose action category metadata");
  if (result.priorityActionItemCount > 0 && result.firstShelfTop !== null && result.firstPriorityActionTop !== null && result.firstShelfTop < result.firstPriorityActionTop) {
    failures.push("User Actions lower-priority shelves appear before priority inbox items");
  }
  if ((result.handoffDraftCount > 2 || result.reportReviewCount > 2) && result.actionShelfControlCount < 1) {
    failures.push("User Actions long handoff/report shelves are missing progressive reveal controls");
  }
  if (result.compactLongTextHeights.some((height) => height > 150)) {
    failures.push(`User Actions handoff/report long text is too expanded by default: ${result.compactLongTextHeights.join(",")}`);
  }
  if (!result.hasContextualInspector) failures.push("single contextual inspector is missing");
  if (!result.hasLaneGridEngine) failures.push("Command Board is not using orquesta-lane-grid-v1");
  if (!result.hasCommandBoardAutoLayoutVars) failures.push("Command Board auto-layout CSS variables were not present on #orgMapWorld");
  if (result.cubicTeamLinkCount > 0) failures.push(`Command Board team links contain cubic commands: ${result.cubicTeamLinks.slice(0, 3).join(" | ")}`);
  if (result.supportChildLinkCount < 2) failures.push(`support child links missing: ${result.supportChildLinkCount}`);
  if (result.supportChildDragHandleCount < 2) failures.push(`support child drag handles missing: ${result.supportChildDragHandleCount}`);
  if (result.supportChildAbsolutePositionCount < 2) failures.push(`support child nodes are not absolutely positioned: ${result.supportChildAbsolutePositionCount}`);
  if (result.visibleMissionPlanes > 0) failures.push(`Command Board has visible mission/background plates: ${result.visibleMissionPlanes}`);
  if (result.commandBoardOverlapCount > 0) {
    failures.push(`Command Board nodes overlap in default desktop layout: ${result.commandBoardOverlaps.slice(0, 5).join(" | ")}`);
  }
  if (result.notificationButtons > 3) failures.push(`Home notification queue is not compact: ${result.notificationButtons} open notification buttons rendered`);
  if (!result.hasDelegationTruth) failures.push("#delegationTruthSummary was not rendered");
  if (!result.hasDelegationLedger) failures.push("#delegationLedger was not rendered");
  if (result.delegationCollapseCount > 0) failures.push(`Delegation view still uses details/accordion collapses: ${result.delegationCollapseCount}`);
  if (result.delegationTruthFocusCount > 5 && !result.delegationTruthRevealControlCount) failures.push("Delegation Truth progressive reveal control is missing");
  if (result.delegationLedgerCount > 6 && !result.delegationLedgerRevealControlCount) failures.push("Delegation Ledger progressive reveal control is missing");
  if (result.delegationTruthVisibleCount > 5) failures.push(`Delegation Truth should default to at most 5 focus items: ${result.delegationTruthVisibleCount}`);
  if (result.delegationLedgerVisibleCount > 6) failures.push(`Delegation Ledger should default to at most 6 rows: ${result.delegationLedgerVisibleCount}`);
  if (result.delegationTruthFocusCount > 0 && result.delegationTruthVisibleCount === 0) failures.push("Delegation Truth has no visible default focus items");
  if (result.delegationLedgerCount > 0 && result.delegationLedgerVisibleCount === 0) failures.push("Delegation Ledger has no visible default rows");
  if (result.delegationTruthVisibleCount <= 5 && result.delegationTruthRect?.height > 440) {
    failures.push(`Delegation Truth collapsed pane is too tall for visible content: ${Math.round(result.delegationTruthRect.height)}px`);
  }
  if (result.delegationTruthVisibleCount <= 5 && result.delegationTruthPanelRect?.height > 470) {
    failures.push(`Delegation Truth panel leaves excessive empty frame: ${Math.round(result.delegationTruthPanelRect.height)}px`);
  }
  if (result.specialistTaskCount > 0 && result.visibleSpecialistTaskIds.length === 0) {
    failures.push(`no specialist_required task ids were visible despite ${result.specialistTaskCount} relevant tasks`);
  }
  if (result.directExceptionTaskCount > 0 && result.visibleDirectExceptionTaskIds.length === 0) {
    failures.push(`no direct_exception task ids were visible despite ${result.directExceptionTaskCount} relevant tasks`);
  }
  if (!result.legendInsideMap) failures.push("status legend is not contained inside #teamTree");
  if (!result.supportGridInsideMap) failures.push("support branch grid is not contained inside #teamTree");
  if (result.supportPlateVisible) failures.push("support lane background plate is visible");
  if (!result.commandBoardUserSelectSuppressed) failures.push("Command Board text selection is not suppressed");
  if (!result.inspectorTextSelectionAvailable) failures.push("Agent Inspector text selection was disabled outside the Command Board");
  if (result.legendTopNodeOverlapCount > 0) {
    failures.push(`status legend overlaps Command Board nodes/groups: ${result.legendTopNodeOverlaps.slice(0, 5).join(" | ")}`);
  }
  if (result.layout?.horizontalOverflow) failures.push("dashboard has horizontal overflow");
  if (result.layout?.commandBoard?.top > result.layout.viewport.height) {
    failures.push(`Command Board starts below the first desktop viewport: top=${Math.round(result.layout.commandBoard.top)} viewport=${result.layout.viewport.height}`);
  }
  if (result.mobileLayout?.horizontalOverflow) failures.push("dashboard has mobile horizontal overflow");
  if (result.mobileLayout?.notificationQueue?.top > result.mobileLayout.viewport.height) {
    failures.push(`mobile notification queue starts below first viewport: top=${Math.round(result.mobileLayout.notificationQueue.top)} viewport=${result.mobileLayout.viewport.height}`);
  }
  if (result.mobileLayout?.commandBoard?.top > 1000) {
    failures.push(`mobile Command Board remains too low: top=${Math.round(result.mobileLayout.commandBoard.top)}`);
  }

  const summary = {
    url: targetUrl,
    ...result,
    consoleErrors,
    pageErrors,
    status: failures.length ? "failed" : "passed"
  };

  console.log(JSON.stringify(summary, null, 2));

  if (failures.length) {
    console.error(`Dashboard DOM smoke failed: ${failures.join("; ")}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
