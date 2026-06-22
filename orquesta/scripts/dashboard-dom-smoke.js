#!/usr/bin/env node

const targetUrl = process.argv[2] || process.env.DASHBOARD_URL || "http://127.0.0.1:4177/";

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch (error) {
    throw new Error("Playwright is required for dashboard DOM smoke checks. Install it or run this from a Codex environment that provides Playwright.");
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
    let api = null;
    try {
      const response = await fetch("/api/state", { cache: "no-store" });
      api = await response.json();
    } catch {
      api = null;
    }
    const agentCount = Array.isArray(api?.agents) ? api.agents.length : null;
    return {
      title: document.title,
      agentNodeCount: nodes.length,
      agentIds: nodes,
      apiAgentCount: agentCount,
      hasUserOnlyMap: nodes.length === 0 && document.body.innerText.includes("User")
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
