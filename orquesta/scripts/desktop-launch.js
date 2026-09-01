"use strict";

const { existsSync } = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { isDeepStrictEqual } = require("node:util");
const { pathToFileURL } = require("node:url");
const {
  RELEASE_SET_RECEIPT_NAME,
  verifyDesktopReleaseSet,
  verifyDesktopReleaseAttestation,
} = require("./desktop-release-attestation");

const RELEASE_ATTESTATION_NAME = "orquesta-desktop-next.release-attestation.json";

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

function isExpectedDesktopExecutable(value, platform) {
  const basename = pathApi(platform).basename(value).toLowerCase();
  return basename === (platform === "win32" ? "orquesta-desktop-next.exe" : "orquesta-desktop-next");
}

async function resolveDesktopExecutable({
  platform = process.platform,
  env = process.env,
  fileExists = existsSync,
  existsSync: injectedExistsSync,
  repoRoot = path.resolve(__dirname, "..", ".."),
  verifyReleaseSet = verifyDesktopReleaseSet,
  verifyDevelopmentIdentity = verifyDesktopReleaseAttestation,
  verifyCurrentRelease,
} = {}) {
  const canRead = injectedExistsSync || fileExists;
  const api = pathApi(platform);
  const candidates = [];
  const candidateKeys = new Set();

  const addCandidate = ({ executable, attestationPath, releaseSetPath, repositoryRoot }) => {
    const key = api.normalize(executable).toLowerCase();
    if (candidateKeys.has(key)) return;
    candidateKeys.add(key);
    candidates.push({ executable, attestationPath, releaseSetPath, repositoryRoot });
  };

  const addDevelopmentCandidate = (root) => {
    if (typeof root !== "string" || root.trim() === "") return;
    const executable = api.join(
      root,
      "apps",
      "orquesta-desktop-next",
      "src-tauri",
      "target",
      "release",
      platform === "win32" ? "orquesta-desktop-next.exe" : "orquesta-desktop-next",
    );
    addCandidate({
      executable,
      attestationPath: api.join(api.dirname(executable), RELEASE_ATTESTATION_NAME),
      releaseSetPath: api.join(api.dirname(executable), RELEASE_SET_RECEIPT_NAME),
      repositoryRoot: root,
    });
  };
  if (env.ORQUESTA_DESKTOP_EXE && env.ORQUESTA_V5_ROOT) {
    addCandidate({
      executable: env.ORQUESTA_DESKTOP_EXE,
      attestationPath: env.ORQUESTA_DESKTOP_ATTESTATION,
      releaseSetPath: env.ORQUESTA_DESKTOP_RELEASE_SET,
      repositoryRoot: env.ORQUESTA_V5_ROOT,
    });
  }
  if (env.ORQUESTA_V5_ROOT) {
    addDevelopmentCandidate(env.ORQUESTA_V5_ROOT);
  } else if (platform === "win32") {
    addDevelopmentCandidate(repoRoot);
    addDevelopmentCandidate(api.join(api.dirname(repoRoot), "Orquesta-V5"));
  }

  for (const candidate of candidates) {
    const normalized = api.normalize(candidate.executable);
    if (!isExpectedDesktopExecutable(normalized, platform)) continue;
    if (
      !canRead(normalized)
      || typeof candidate.attestationPath !== "string"
      || typeof candidate.releaseSetPath !== "string"
    ) continue;
    const normalizedAttestation = api.normalize(candidate.attestationPath);
    const normalizedReleaseSet = api.normalize(candidate.releaseSetPath);
    if (!canRead(normalizedAttestation) || !canRead(normalizedReleaseSet)) continue;
    try {
      verifyDevelopmentIdentity({
        repositoryRoot: candidate.repositoryRoot,
        attestationPath: normalizedAttestation,
        desktopExe: normalized,
      });
      const { attestation, receipt } = verifyReleaseSet({
        releaseSetPath: normalizedReleaseSet,
        attestationPath: normalizedAttestation,
        desktopExe: normalized,
      });
      const lifecycle = desktopLifecycleCoordinates(candidate, { platform });
      const verifyCurrent = verifyCurrentRelease || (await import(pathToFileURL(
        api.join(lifecycle.root, "scripts", "build-frontend-generation.mjs"),
      ).href)).verifyCurrentDesktopRelease;
      const current = await verifyCurrent(lifecycle);
      if (!attestation || !receipt
          || !isDeepStrictEqual(attestation, current.attestation)
          || !isDeepStrictEqual(receipt, current.releaseSet)) {
        throw new Error("desktop_release_current_selection_mismatch");
      }
      return {
        desktopExe: normalized,
        attestationPath: normalizedAttestation,
        releaseSetPath: normalizedReleaseSet,
        repositoryRoot: api.normalize(candidate.repositoryRoot),
      };
    } catch {
      // Keep looking. Automatic launch is limited to a release set that still
      // matches the current V5 source. Installed selection belongs to P2-011.
    }
  }

  throw new Error(
    "A source-matched Orquesta Next development release was not found. Build the current V5 source again.",
  );
}

function desktopLifecycleCoordinates(identity, { platform = process.platform } = {}) {
  const api = pathApi(platform);
  const repositoryRoot = normalizedAbsolute(identity?.repositoryRoot, "repositoryRoot", platform);
  const productRoot = api.join(repositoryRoot, "apps", "orquesta-desktop-next");
  return {
    root: productRoot,
    stagingRoot: api.join(productRoot, ".build-generations"),
  };
}

function buildDesktopLaunch({
  projectRoot,
  desktopExe,
  desktopAttestation,
  desktopReleaseSet,
  callingThreadId = null,
  platform = process.platform,
  verifyReleaseSet = verifyDesktopReleaseSet,
} = {}) {
  const api = pathApi(platform);
  if (typeof projectRoot === "string" && /^[a-z][a-z0-9+.-]*:\/\//i.test(projectRoot.trim())) {
    throw new TypeError("projectRoot must be a filesystem project root, not a URL");
  }
  const normalizedRoot = normalizedAbsolute(projectRoot, "projectRoot", platform);
  const normalizedExe = normalizedAbsolute(desktopExe, "desktopExe", platform);
  if (!isExpectedDesktopExecutable(normalizedExe, platform)) {
    throw new TypeError("desktopExe must identify Orquesta Next");
  }
  const normalizedAttestation = normalizedAbsolute(desktopAttestation, "desktopAttestation", platform);
  const normalizedReleaseSet = normalizedAbsolute(desktopReleaseSet, "desktopReleaseSet", platform);
  verifyReleaseSet({
    releaseSetPath: normalizedReleaseSet,
    attestationPath: normalizedAttestation,
    desktopExe: normalizedExe,
  });
  const threadId = boundedThreadId(callingThreadId);
  const args = ["--orquesta-project", api.normalize(normalizedRoot)];
  if (threadId) args.push("--orquesta-calling-thread", threadId);
  return {
    kind: "orquesta-desktop",
    command: api.normalize(normalizedExe),
    args,
    attestation: normalizedAttestation,
    releaseSet: normalizedReleaseSet,
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
  const result = { projectRoot: process.cwd(), desktopExe: null, desktopAttestation: null, desktopReleaseSet: null, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--project-root") result.projectRoot = argv[++index];
    else if (argument === "--desktop-exe") result.desktopExe = argv[++index];
    else if (argument === "--desktop-attestation") result.desktopAttestation = argv[++index];
    else if (argument === "--desktop-release-set") result.desktopReleaseSet = argv[++index];
    else if (argument === "--dry-run") result.dryRun = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return result;
}

async function main() {
  const input = parseArguments(process.argv.slice(2));
  const resolutionEnvironment = input.desktopExe
    ? {
        ...process.env,
        ORQUESTA_DESKTOP_EXE: input.desktopExe,
        ORQUESTA_DESKTOP_ATTESTATION: input.desktopAttestation || process.env.ORQUESTA_DESKTOP_ATTESTATION,
        ORQUESTA_DESKTOP_RELEASE_SET: input.desktopReleaseSet || process.env.ORQUESTA_DESKTOP_RELEASE_SET,
      }
    : process.env;
  const selected = await resolveDesktopExecutable({ env: resolutionEnvironment });
  const lifecycle = desktopLifecycleCoordinates(selected);
  const { withDesktopLifecycleLock } = await import(pathToFileURL(
    path.join(lifecycle.root, "scripts", "desktop-lifecycle-lock.mjs"),
  ).href);
  await withDesktopLifecycleLock({ ...lifecycle, operation: "launch" }, async () => {
    const identity = await resolveDesktopExecutable({ env: resolutionEnvironment });
    if (
      identity.desktopExe !== selected.desktopExe
      || identity.attestationPath !== selected.attestationPath
      || identity.releaseSetPath !== selected.releaseSetPath
      || identity.repositoryRoot !== selected.repositoryRoot
    ) {
      throw new Error("Orquesta Desktop release selection changed before launch.");
    }
    const launch = buildDesktopLaunch({
      projectRoot: input.projectRoot,
      desktopExe: identity.desktopExe,
      desktopAttestation: identity.attestationPath,
      desktopReleaseSet: identity.releaseSetPath,
      callingThreadId: process.env.CODEX_THREAD_ID,
    });
    if (input.dryRun) {
      process.stdout.write(`${JSON.stringify(launch, null, 2)}\n`);
      return;
    }
    await launchDesktop(launch);
    process.stdout.write(`Opened Orquesta Desktop for ${launch.args[1]}\n`);
  });
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  buildDesktopLaunch,
  desktopLifecycleCoordinates,
  launchDesktop,
  parseArguments,
  resolveDesktopExecutable,
};
