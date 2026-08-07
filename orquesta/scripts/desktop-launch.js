"use strict";

const { existsSync } = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

function pathApi(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function normalizedAbsolute(value, label, platform) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} is required`);
  }
  const api = pathApi(platform);
  const normalized = api.normalize(value.trim());
  if (!api.isAbsolute(normalized)) {
    throw new TypeError(`${label} must be an absolute filesystem path`);
  }
  return normalized;
}

function boundedThreadId(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/u.test(value.trim())) {
    throw new TypeError("callingThreadId must be a safe Codex thread id");
  }
  return value.trim();
}

function resolveDesktopExecutable({
  platform = process.platform,
  env = process.env,
  fileExists = existsSync,
  existsSync: injectedExistsSync,
  repoRoot = path.resolve(__dirname, "..", ".."),
} = {}) {
  const canRead = injectedExistsSync || fileExists;
  const api = pathApi(platform);
  const candidates = [];

  if (env.ORQUESTA_DESKTOP_EXE) candidates.push(env.ORQUESTA_DESKTOP_EXE);
  if (platform === "win32" && env.LOCALAPPDATA) {
    candidates.push(api.join(env.LOCALAPPDATA, "Orquesta", "Orquesta.exe"));
  }
  if (platform === "win32") {
    candidates.push(api.join(repoRoot, "apps", "orquesta-desktop", "out", "Orquesta-win32-x64", "Orquesta.exe"));
  }

  for (const candidate of candidates) {
    const normalized = api.normalize(candidate);
    if (canRead(normalized)) return normalized;
  }

  throw new Error(
    "Orquesta Desktop executable was not found. Install Orquesta Desktop or set ORQUESTA_DESKTOP_EXE.",
  );
}

function buildDesktopLaunch({
  projectRoot,
  desktopExe,
  callingThreadId = null,
  platform = process.platform,
} = {}) {
  const api = pathApi(platform);
  if (typeof projectRoot === "string" && /^[a-z][a-z0-9+.-]*:\/\//i.test(projectRoot.trim())) {
    throw new TypeError("projectRoot must be a filesystem project root, not a URL");
  }
  const normalizedRoot = normalizedAbsolute(projectRoot, "projectRoot", platform);
  const normalizedExe = normalizedAbsolute(desktopExe, "desktopExe", platform);
  const threadId = boundedThreadId(callingThreadId);
  const args = ["--orquesta-project", api.normalize(normalizedRoot)];
  if (threadId) args.push("--orquesta-calling-thread", threadId);
  return {
    kind: "orquesta-desktop",
    command: api.normalize(normalizedExe),
    args,
  };
}

function launchDesktop(launch, { spawnProcess = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(launch.command, launch.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve(launch);
    });
  });
}

function parseArguments(argv) {
  const result = { projectRoot: process.cwd(), desktopExe: null, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--project-root") result.projectRoot = argv[++index];
    else if (argument === "--desktop-exe") result.desktopExe = argv[++index];
    else if (argument === "--dry-run") result.dryRun = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return result;
}

async function main() {
  const input = parseArguments(process.argv.slice(2));
  const desktopExe = input.desktopExe || resolveDesktopExecutable();
  const launch = buildDesktopLaunch({
    projectRoot: input.projectRoot,
    desktopExe,
    callingThreadId: process.env.CODEX_THREAD_ID,
  });
  if (input.dryRun) {
    process.stdout.write(`${JSON.stringify(launch, null, 2)}\n`);
    return;
  }
  await launchDesktop(launch);
  process.stdout.write(`Opened Orquesta Desktop for ${launch.args[1]}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  buildDesktopLaunch,
  launchDesktop,
  parseArguments,
  resolveDesktopExecutable,
};
