#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PROBE_TIMEOUT_MS = 3_000;
const CHROME_VERSION_PATTERN = /^(?:Google Chrome|Google Chrome for Testing|Chrome|Chromium)\s+\d+(?:\.\d+){1,3}$/i;

function candidatePaths(environment = process.env) {
  const candidates = [environment.ORQUESTA_CHROME_PATH];
  for (const basePath of [environment.PROGRAMFILES, environment["PROGRAMFILES(X86)"], environment.LOCALAPPDATA]) {
    if (basePath) candidates.push(path.join(basePath, "Google", "Chrome", "Application", "chrome.exe"));
  }
  return [...new Set(candidates.filter(Boolean))];
}

function findBrowser(candidates = candidatePaths()) {
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function probeBrowserVersion(browserPath, { spawn = spawnSync, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  let result;
  try {
    result = spawn(browserPath, ["--version"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: timeoutMs
    });
  } catch (error) {
    return { ok: false, reason: "spawn_error", error };
  }
  if (result.error) {
    return {
      ok: false,
      reason: result.error.code === "ETIMEDOUT" ? "timeout_or_signal" : "spawn_error",
      error: result.error
    };
  }
  if (result.signal) return { ok: false, reason: "timeout_or_signal" };
  if (result.status !== 0) return { ok: false, reason: "non_zero_exit" };

  const version = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  if (!version) return { ok: false, reason: "empty_version" };
  if (!CHROME_VERSION_PATTERN.test(version)) return { ok: false, reason: "unapproved_version" };
  return { ok: true, version };
}

async function probeBrowserDriver(browserPath, { loadDriver = () => require("playwright-core") } = {}) {
  let driver;
  try {
    driver = loadDriver();
  } catch (error) {
    return { ok: false, reason: "driver_unavailable", error };
  }
  let browser;
  try {
    browser = await driver.chromium.launch({ executablePath: browserPath, headless: true });
    const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
    const consoleErrors = [];
    const pageErrors = [];
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.setContent("<!doctype html><title>Orquesta browser preflight</title><main>ready</main>");
    const screenshot = await page.screenshot({ type: "png" });
    if (consoleErrors.length || pageErrors.length) return { ok: false, reason: "page_error", consoleErrors, pageErrors };
    return {
      ok: true,
      version: browser.version(),
      screenshot_bytes: screenshot.length,
      driver_version: require("playwright-core/package.json").version,
    };
  } catch (error) {
    return { ok: false, reason: "launch_failed", error };
  } finally {
    if (browser) await browser.close();
  }
}

function checkChromeOnly({ find = findBrowser, spawn = spawnSync, timeoutMs = PROBE_TIMEOUT_MS, stdout = console.log, stderr = console.error } = {}) {
  const browserPath = find();
  if (!browserPath) {
    stderr("BROWSER_RUNNER_UNAVAILABLE: no configured or standard Chrome executable was found.");
    return 1;
  }
  const probe = probeBrowserVersion(browserPath, { spawn, timeoutMs });
  if (!probe.ok) {
    stderr(`BROWSER_RUNNER_UNAVAILABLE: could not verify Chrome version from ${browserPath} (${probe.reason}).`);
    return 1;
  }
  stdout(`Browser runner path: ${browserPath}`);
  stdout(`Browser runner version: ${probe.version}`);
  return 0;
}

async function checkDriver({ find = findBrowser, probe = probeBrowserDriver, stdout = console.log, stderr = console.error } = {}) {
  const browserPath = find();
  if (!browserPath) {
    stderr("BROWSER_RUNNER_UNAVAILABLE: no configured or standard Chrome executable was found.");
    return 1;
  }
  const result = await probe(browserPath);
  if (!result.ok) {
    stderr(`BROWSER_RUNNER_UNAVAILABLE: playwright-core could not launch ${browserPath} (${result.reason}).`);
    return 1;
  }
  stdout(`Browser runner path: ${browserPath}`);
  stdout(`Browser runner version: ${result.version}`);
  stdout(`Browser driver version: ${result.driver_version}`);
  stdout(`Browser preflight screenshot bytes: ${result.screenshot_bytes}`);
  return 0;
}

if (require.main === module) {
  if (process.argv.includes("--require-driver")) {
    checkDriver().then((code) => { process.exitCode = code; });
  } else if (process.argv.includes("--check-chrome-only")) process.exitCode = checkChromeOnly();
  else {
    console.error("Usage: browser-preflight.js --check-chrome-only");
    process.exitCode = 1;
  }
}

module.exports = { candidatePaths, findBrowser, probeBrowserDriver, probeBrowserVersion, checkChromeOnly, checkDriver };
