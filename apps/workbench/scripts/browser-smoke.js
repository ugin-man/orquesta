#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { chromium } = require("playwright-core");
const { startWorkbench } = require("../server");

const REPOSITORY_ROOT = path.resolve(__dirname, "../../..");
const DEFAULT_REVIEW_ROOT = path.join(REPOSITORY_ROOT, "output", "v4-phase1-review");
const CHROME_CANDIDATES = [
  process.env.ORQUESTA_CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean);

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value) throw new Error(`Missing value for ${flag}`);
    if (flag === "--url") options.url = value;
    else if (flag === "--state-root") options.stateRoot = value;
    else if (flag === "--output") options.outputRoot = value;
    else throw new Error(`Unknown option: ${flag}`);
  }
  return options;
}

function resolveChrome() {
  const executablePath = CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate));
  if (!executablePath) {
    const error = new Error("Chrome or Edge executable was not found. Set ORQUESTA_CHROME_PATH.");
    error.code = "BROWSER_RUNNER_UNAVAILABLE";
    throw error;
  }
  return executablePath;
}

function insideRepository(targetPath) {
  const relative = path.relative(REPOSITORY_ROOT, targetPath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function reviewPath(input, fallback) {
  const resolved = path.resolve(input || fallback);
  if (!insideRepository(resolved)) throw new Error(`Review artifact path must stay inside the repository: ${resolved}`);
  return resolved;
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

async function horizontalOverflow(page) {
  return page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
}

async function assertNoHorizontalOverflow(page, label) {
  const measured = await horizontalOverflow(page);
  if (measured.document > measured.viewport || measured.body > measured.viewport) {
    throw new Error(`${label} has horizontal overflow: ${JSON.stringify(measured)}`);
  }
  return measured;
}

async function runBrowserSmoke(options = {}) {
  const outputRoot = reviewPath(options.outputRoot, DEFAULT_REVIEW_ROOT);
  const stateParent = reviewPath(options.stateRoot, path.join(REPOSITORY_ROOT, "output", "v4-browser-smoke"));
  fs.mkdirSync(outputRoot, { recursive: true });
  fs.mkdirSync(stateParent, { recursive: true });
  const stateRoot = fs.mkdtempSync(path.join(stateParent, "run-"));
  const desktopScreenshot = path.join(outputRoot, "workbench.png");
  const mobileScreenshot = path.join(outputRoot, "workbench-mobile.png");
  const evidencePath = path.join(outputRoot, "browser-smoke.json");
  const executablePath = resolveChrome();
  const app = options.url ? null : await startWorkbench({ feature: "v4", stateRoot, port: 0 });
  const url = options.url || app.url;
  const browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  try {
    await page.goto(url, { waitUntil: "networkidle" });
    if (await page.locator('[data-testid="fixture-tabs"] button').count() !== 3) throw new Error("Expected exactly three fixture tabs.");

    const cases = [
      ["local-reuse", "REUSE"],
      ["adapt-vs-build", "ADAPT"],
      ["blocked-candidate", "BUILD"],
    ];
    for (const [index, [fixtureId, expectedMode]] of cases.entries()) {
      const tab = page.locator(`[data-testid="fixture-${fixtureId}"]`);
      if (index === 0) {
        await tab.focus();
        await page.keyboard.press("Enter");
      } else {
        await tab.click();
      }
      await page.locator('[data-testid="decision-mode"]').waitFor({ state: "visible" });
      if ((await page.locator('[data-testid="decision-mode"]').textContent()).trim() !== expectedMode) {
        throw new Error(`${fixtureId} did not render ${expectedMode}.`);
      }
      if ((await tab.getAttribute("aria-pressed")) !== "true") throw new Error(`${fixtureId} tab did not expose active state.`);
    }

    const blockedText = await page.locator('[data-testid="step-candidates"]').textContent();
    if (!blockedText.includes("license: fail") || !blockedText.includes("棄却: license gate")) {
      throw new Error("Blocked candidate does not expose its license gate rejection.");
    }
    const resolutionText = await page.locator('[data-testid="step-resolution"]').textContent();
    if (!resolutionText.includes("pending_user") || !resolutionText.includes("Codexの統括タスク")) {
      throw new Error("Read-only user checkpoint is not visible.");
    }
    const firstCandidateDetails = page.locator('[data-testid="step-candidates"] details').first();
    await firstCandidateDetails.locator("summary").focus();
    await page.keyboard.press("Enter");
    if (!await firstCandidateDetails.evaluate((node) => node.open)) throw new Error("Candidate detail is not keyboard operable.");

    await page.locator('[data-testid="replay-button"]').focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector('[data-testid="journal-status"]')?.textContent?.includes("18 batches"));
    const journalText = await page.locator('[data-testid="journal-status"]').textContent();
    if (!journalText.includes("42 events")) throw new Error(`Unexpected journal evidence: ${journalText}`);

    await page.evaluate(() => window.scrollTo(0, 0));
    const desktopOverflow = await assertNoHorizontalOverflow(page, "1440px Workbench");
    await page.screenshot({ path: desktopScreenshot, fullPage: true });
    await page.setViewportSize({ width: 360, height: 800 });
    await page.evaluate(() => window.scrollTo(0, 0));
    const mobileOverflow = await assertNoHorizontalOverflow(page, "360px Workbench");
    await page.screenshot({ path: mobileScreenshot, fullPage: true });

    if (consoleErrors.length || pageErrors.length) throw new Error(`Browser errors: ${JSON.stringify({ consoleErrors, pageErrors })}`);
    const evidence = {
      status: "passed",
      url,
      fixtures: cases.map(([fixtureId, mode]) => ({ fixture_id: fixtureId, mode })),
      journal: { batches: 18, events: 42 },
      console_errors: consoleErrors,
      page_errors: pageErrors,
      viewports: { desktop: desktopOverflow, mobile: mobileOverflow },
      browser: { engine: "chromium", version: browser.version(), executable: path.basename(executablePath) },
      screenshots: {
        desktop: { path: path.relative(REPOSITORY_ROOT, desktopScreenshot).replaceAll("\\", "/"), sha256: sha256(desktopScreenshot) },
        mobile: { path: path.relative(REPOSITORY_ROOT, mobileScreenshot).replaceAll("\\", "/"), sha256: sha256(mobileScreenshot) },
      },
    };
    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    return evidence;
  } finally {
    await browser.close();
    if (app) await app.close();
  }
}

if (require.main === module) {
  runBrowserSmoke(parseArgs(process.argv.slice(2))).then((evidence) => {
    process.stdout.write(`Orquesta V4 Workbench browser smoke passed: ${evidence.fixtures.length} fixtures, ${evidence.console_errors.length} console errors, ${evidence.page_errors.length} page errors\n`);
  }).catch((error) => {
    process.stderr.write(`${error.code || "V4_BROWSER_SMOKE_FAILED"}: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, resolveChrome, runBrowserSmoke };
