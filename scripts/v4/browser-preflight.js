#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

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

function checkChromeOnly() {
  const browserPath = findBrowser();
  if (!browserPath) {
    console.error("BROWSER_RUNNER_UNAVAILABLE: no configured or standard Chrome executable was found.");
    return 1;
  }
  const version = spawnSync(browserPath, ["--version"], { encoding: "utf8", windowsHide: true });
  if (version.error || version.status !== 0) {
    console.error(`BROWSER_RUNNER_UNAVAILABLE: could not read browser version from ${browserPath}.`);
    return 1;
  }
  console.log(`Browser runner path: ${browserPath}`);
  console.log(`Browser runner version: ${(version.stdout || version.stderr).trim()}`);
  return 0;
}

if (require.main === module) {
  if (process.argv.includes("--check-chrome-only")) process.exitCode = checkChromeOnly();
  else {
    console.error("Usage: browser-preflight.js --check-chrome-only");
    process.exitCode = 1;
  }
}

module.exports = { candidatePaths, findBrowser, checkChromeOnly };
