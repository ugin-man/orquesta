"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const {
  buildDesktopLaunch,
  desktopLifecycleCoordinates,
  resolveDesktopExecutable,
} = require("./desktop-launch.js");

const nextExecutable = (root) => path.win32.join(
  root,
  "apps",
  "orquesta-desktop-next",
  "src-tauri",
  "target",
  "release",
  "orquesta-desktop-next.exe",
);
const attestationFor = (executable) => path.win32.join(
  path.win32.dirname(executable),
  "orquesta-desktop-next.release-attestation.json",
);
const releaseSetFor = (executable) => path.win32.join(
  path.win32.dirname(executable),
  "orquesta-desktop-next.release-set.json",
);
const attestationIdentity = { schemaVersion: 2, frontendBuildId: "build-current" };
const releaseIdentity = { schemaVersion: 1, frontendBuildId: "build-current" };
const acceptingVerifier = () => ({ attestation: attestationIdentity, receipt: releaseIdentity });
const acceptingCurrentRelease = async () => ({ attestation: attestationIdentity, releaseSet: releaseIdentity });

test("the executable identity check and spawn share the Desktop lifecycle lock", async () => {
  const source = fs.readFileSync(path.join(__dirname, "desktop-launch.js"), "utf8");
  assert.match(source, /withDesktopLifecycleLock\(\{ \.\.\.lifecycle, operation: "launch" \}, async \(\) =>/u);
  assert.match(source, /const identity = await resolveDesktopExecutable[\s\S]+release selection changed before launch[\s\S]+await launchDesktop/u);
});

test("product and distributed launchers load verifier and lifecycle modules from the selected V5 root", async (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-launch-distribution-"));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  const repositoryRoot = path.join(fixtureRoot, "selected V5 #配布");
  const lifecycle = desktopLifecycleCoordinates({ repositoryRoot });
  const productScripts = path.join(lifecycle.root, "scripts");
  const releaseDirectory = path.join(lifecycle.root, "src-tauri", "target", "release");
  const desktopExe = path.join(releaseDirectory, process.platform === "win32"
    ? "orquesta-desktop-next.exe" : "orquesta-desktop-next");
  const attestationPath = path.join(releaseDirectory, "orquesta-desktop-next.release-attestation.json");
  const releaseSetPath = path.join(releaseDirectory, "orquesta-desktop-next.release-set.json");
  fs.mkdirSync(productScripts, { recursive: true });
  fs.mkdirSync(releaseDirectory, { recursive: true });
  for (const fixtureFile of [desktopExe, attestationPath, releaseSetPath]) {
    fs.writeFileSync(fixtureFile, "dry-run fixture only");
  }
  fs.writeFileSync(path.join(productScripts, "build-frontend-generation.mjs"), `
    import assert from "node:assert/strict";
    export async function verifyCurrentDesktopRelease(coordinates) {
      assert.deepEqual(coordinates, ${JSON.stringify(lifecycle)});
      process.stderr.write("verify-current\\n");
      return ${JSON.stringify({ attestation: attestationIdentity, releaseSet: releaseIdentity })};
    }
  `);
  fs.writeFileSync(path.join(productScripts, "desktop-lifecycle-lock.mjs"), `
    import assert from "node:assert/strict";
    export async function withDesktopLifecycleLock(coordinates, callback) {
      assert.deepEqual(coordinates, ${JSON.stringify({ ...lifecycle, operation: "launch" })});
      process.stderr.write("lifecycle-lock\\n");
      return callback();
    }
  `);
  const verificationStub = `
    module.exports = {
      RELEASE_SET_RECEIPT_NAME: "orquesta-desktop-next.release-set.json",
      verifyDesktopReleaseAttestation() {},
      verifyDesktopReleaseSet() {
        return ${JSON.stringify({ attestation: attestationIdentity, receipt: releaseIdentity })};
      },
    };
  `;
  const locations = [
    ["product", path.join(repositoryRoot, "orquesta", "scripts")],
    ["coordination skill copy", path.join(fixtureRoot, "Orquesta", ".agents", "skills", "orquesta", "scripts")],
    ["global skill copy", path.join(fixtureRoot, ".codex", "skills", "orquesta", "scripts")],
  ];
  for (const [name, scriptsDirectory] of locations) {
    await t.test(name, () => {
      fs.mkdirSync(scriptsDirectory, { recursive: true });
      const launcherPath = path.join(scriptsDirectory, "desktop-launch.js");
      fs.copyFileSync(path.join(__dirname, "desktop-launch.js"), launcherPath);
      fs.writeFileSync(path.join(scriptsDirectory, "desktop-release-attestation.js"), verificationStub);
      const result = spawnSync(process.execPath, [launcherPath, "--dry-run", "--project-root", fixtureRoot], {
        cwd: fixtureRoot,
        env: {
          ...process.env,
          ORQUESTA_V5_ROOT: repositoryRoot,
          ORQUESTA_DESKTOP_EXE: "",
          ORQUESTA_DESKTOP_ATTESTATION: "",
          ORQUESTA_DESKTOP_RELEASE_SET: "",
          CODEX_THREAD_ID: "",
        },
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "verify-current\nlifecycle-lock\nverify-current\n");
      assert.deepEqual(JSON.parse(result.stdout), {
        kind: "orquesta-desktop",
        command: desktopExe,
        args: ["--orquesta-project", fixtureRoot],
        attestation: attestationPath,
        releaseSet: releaseSetPath,
      });
    });
  }
});

test("resolves an explicitly declared source-matched Orquesta Next release set", async () => {
  const explicit = "D:\\Orquesta Next\\orquesta-desktop-next.exe";
  const attestation = "D:\\proof\\release-attestation.json";
  const releaseSet = "D:\\proof\\release-set.json";
  assert.deepEqual(await resolveDesktopExecutable({
    platform: "win32",
    env: {
      ORQUESTA_DESKTOP_EXE: explicit,
      ORQUESTA_DESKTOP_ATTESTATION: attestation,
      ORQUESTA_DESKTOP_RELEASE_SET: releaseSet,
      ORQUESTA_V5_ROOT: "D:\\repo",
      LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
    },
    repoRoot: "D:\\repo",
    existsSync: (candidate) => [explicit, attestation, releaseSet].includes(candidate),
    verifyReleaseSet: acceptingVerifier,
    verifyDevelopmentIdentity: acceptingVerifier,
    verifyCurrentRelease: acceptingCurrentRelease,
  }), { desktopExe: explicit, attestationPath: attestation, releaseSetPath: releaseSet, repositoryRoot: "D:\\repo" });
});

test("resolves the current V5 development release with full source verification", async () => {
  const productRoot = "D:\\Orquesta-V5";
  const currentRelease = nextExecutable(productRoot);
  const attestation = attestationFor(currentRelease);
  const releaseSet = releaseSetFor(currentRelease);
  const probed = [];
  let fullVerifications = 0;
  assert.deepEqual(await resolveDesktopExecutable({
    platform: "win32",
    env: {
      ORQUESTA_V5_ROOT: productRoot,
      LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
      ProgramFiles: "C:\\Program Files",
    },
    repoRoot: "D:\\coordination-root",
    existsSync: (candidate) => {
      probed.push(candidate);
      return [currentRelease, attestation, releaseSet].includes(candidate);
    },
    verifyReleaseSet: acceptingVerifier,
    verifyDevelopmentIdentity: () => { fullVerifications += 1; },
    verifyCurrentRelease: acceptingCurrentRelease,
  }), { desktopExe: currentRelease, attestationPath: attestation, releaseSetPath: releaseSet, repositoryRoot: productRoot });
  assert.equal(fullVerifications, 1);
  assert.ok(probed.every((candidate) => !candidate.endsWith("\\Orquesta\\Orquesta.exe")));
  assert.ok(probed.every((candidate) => !candidate.includes("\\apps\\orquesta-desktop\\out\\")));
});

test("rejects an old self-consistent V5 pair when it no longer matches current source", async () => {
  const productRoot = "D:\\Orquesta-V5";
  const oldExecutable = nextExecutable(productRoot);
  const attestation = attestationFor(oldExecutable);
  const releaseSet = releaseSetFor(oldExecutable);
  await assert.rejects(() => resolveDesktopExecutable({
    platform: "win32",
    env: { ORQUESTA_V5_ROOT: productRoot },
    repoRoot: "D:\\missing",
    existsSync: (candidate) => [oldExecutable, attestation, releaseSet].includes(candidate),
    verifyReleaseSet: acceptingVerifier,
    verifyDevelopmentIdentity: () => { throw new Error("desktop_release_source_changed"); },
  }), /source-matched Orquesta Next development release was not found/u);
});

test("fails closed when only the retired Electron desktop exists", async () => {
  const localAppData = "C:\\Users\\test\\AppData\\Local";
  const retired = path.win32.join(localAppData, "Orquesta", "Orquesta.exe");
  const probed = [];
  await assert.rejects(() => resolveDesktopExecutable({
    platform: "win32",
    env: { LOCALAPPDATA: localAppData },
    repoRoot: "D:\\coordination-root",
    existsSync: (candidate) => {
      probed.push(candidate);
      return candidate === retired;
    },
    verifyReleaseSet: acceptingVerifier,
    verifyDevelopmentIdentity: acceptingVerifier,
    verifyCurrentRelease: acceptingCurrentRelease,
  }), /source-matched Orquesta Next development release was not found/u);
  assert.ok(!probed.includes(retired));
});

test("finds a sibling current Orquesta-V5 checkout from the coordination workspace", async () => {
  const coordinationRoot = "D:\\workspace\\Orquesta";
  const productRoot = "D:\\workspace\\Orquesta-V5";
  const currentRelease = nextExecutable(productRoot);
  const attestation = attestationFor(currentRelease);
  const releaseSet = releaseSetFor(currentRelease);
  assert.deepEqual(await resolveDesktopExecutable({
    platform: "win32",
    env: {},
    repoRoot: coordinationRoot,
    existsSync: (candidate) => [currentRelease, attestation, releaseSet].includes(candidate),
    verifyReleaseSet: acceptingVerifier,
    verifyDevelopmentIdentity: acceptingVerifier,
    verifyCurrentRelease: acceptingCurrentRelease,
  }), { desktopExe: currentRelease, attestationPath: attestation, releaseSetPath: releaseSet, repositoryRoot: productRoot });
});

test("launch locks the checkout that owns the selected release", async () => {
  assert.deepEqual(
    desktopLifecycleCoordinates({ repositoryRoot: "E:\\selected-v5" }, { platform: "win32" }),
    {
      root: "E:\\selected-v5\\apps\\orquesta-desktop-next",
      stagingRoot: "E:\\selected-v5\\apps\\orquesta-desktop-next\\.build-generations",
    },
  );
});

test("never searches the working-directory ancestry for another checkout", async () => {
  const declaredRoot = "D:\\declared\\Orquesta-V5";
  const nearbyOldRoot = "E:\\work\\Orquesta-V5";
  const nearbyOldExecutable = nextExecutable(nearbyOldRoot);
  const nearbyOldAttestation = attestationFor(nearbyOldExecutable);
  const nearbyOldReleaseSet = releaseSetFor(nearbyOldExecutable);
  let verifications = 0;
  await assert.rejects(() => resolveDesktopExecutable({
    platform: "win32",
    env: {},
    repoRoot: declaredRoot,
    workingDirectory: "E:\\work\\some-project",
    existsSync: (candidate) => [nearbyOldExecutable, nearbyOldAttestation, nearbyOldReleaseSet].includes(candidate),
    verifyReleaseSet: () => { verifications += 1; },
    verifyDevelopmentIdentity: () => { verifications += 1; },
  }), /source-matched Orquesta Next development release was not found/u);
  assert.equal(verifications, 0);
});

test("an installed executable is not auto-selected even with an adjacent self-consistent release set", async () => {
  const localAppData = "C:\\Users\\test\\AppData\\Local";
  const installed = path.win32.join(localAppData, "Programs", "Orquesta Next", "orquesta-desktop-next.exe");
  const attestation = attestationFor(installed);
  const releaseSet = releaseSetFor(installed);
  let releaseSetVerifications = 0;
  await assert.rejects(() => resolveDesktopExecutable({
    platform: "win32",
    env: { LOCALAPPDATA: localAppData },
    repoRoot: "D:\\missing",
    existsSync: (candidate) => [installed, attestation, releaseSet].includes(candidate),
    verifyReleaseSet: () => { releaseSetVerifications += 1; },
    verifyDevelopmentIdentity: acceptingVerifier,
    verifyCurrentRelease: acceptingCurrentRelease,
  }), /source-matched Orquesta Next development release was not found/u);
  assert.equal(releaseSetVerifications, 0);
});

test("rejects an explicit retired executable even when it exists", async () => {
  const retired = "C:\\Users\\test\\AppData\\Local\\Orquesta\\Orquesta.exe";
  await assert.rejects(() => resolveDesktopExecutable({
    platform: "win32",
    env: { ORQUESTA_DESKTOP_EXE: retired },
    repoRoot: "D:\\missing",
    existsSync: (candidate) => candidate === retired,
    verifyReleaseSet: acceptingVerifier,
    verifyDevelopmentIdentity: acceptingVerifier,
    verifyCurrentRelease: acceptingCurrentRelease,
  }), /source-matched Orquesta Next development release was not found/u);
  assert.throws(() => buildDesktopLaunch({
    projectRoot: "D:\\project",
    desktopExe: retired,
    desktopAttestation: "D:\\proof.json",
    desktopReleaseSet: "D:\\release-set.json",
    platform: "win32",
    verifyReleaseSet: acceptingVerifier,
  }), /must identify Orquesta Next/u);
});

test("rejects a renamed same-basename executable at resolver and direct launch boundaries", async () => {
  const fake = "D:\\fake\\orquesta-desktop-next.exe";
  const attestation = attestationFor(fake);
  const releaseSet = releaseSetFor(fake);
  const reject = () => { throw new Error("desktop_release_set_executable_hash_mismatch"); };
  await assert.rejects(() => resolveDesktopExecutable({
    platform: "win32",
    env: {
      ORQUESTA_DESKTOP_EXE: fake,
      ORQUESTA_DESKTOP_ATTESTATION: attestation,
      ORQUESTA_DESKTOP_RELEASE_SET: releaseSet,
      ORQUESTA_V5_ROOT: "D:\\repo",
    },
    repoRoot: "D:\\repo",
    existsSync: (candidate) => [fake, attestation, releaseSet].includes(candidate),
    verifyReleaseSet: reject,
    verifyDevelopmentIdentity: acceptingVerifier,
    verifyCurrentRelease: acceptingCurrentRelease,
  }), /source-matched Orquesta Next development release was not found/u);
  assert.throws(() => buildDesktopLaunch({
    projectRoot: "D:\\project",
    desktopExe: fake,
    desktopAttestation: attestation,
    desktopReleaseSet: releaseSet,
    platform: "win32",
    verifyReleaseSet: reject,
  }), /executable_hash_mismatch/u);
});

test("builds a launch only after release-set verification", async () => {
  const executable = "D:\\repo\\orquesta-desktop-next.exe";
  const attestation = "D:\\repo\\orquesta-desktop-next.release-attestation.json";
  const releaseSet = "D:\\repo\\orquesta-desktop-next.release-set.json";
  let verified = 0;
  const launch = buildDesktopLaunch({
    projectRoot: "D:\\project",
    desktopExe: executable,
    desktopAttestation: attestation,
    desktopReleaseSet: releaseSet,
    callingThreadId: "thread-1",
    platform: "win32",
    verifyReleaseSet: (input) => {
      verified += 1;
      assert.equal(input.desktopExe, executable);
      assert.equal(input.attestationPath, attestation);
      assert.equal(input.releaseSetPath, releaseSet);
    },
  });
  assert.equal(verified, 1);
  assert.deepEqual(launch.args, ["--orquesta-project", "D:\\project", "--orquesta-calling-thread", "thread-1"]);
  assert.equal(launch.attestation, attestation);
  assert.equal(launch.releaseSet, releaseSet);
});


test("a valid materialized pair cannot bypass a missing or different current promotion", async () => {
  const productRoot = "D:\\Orquesta-V5";
  const desktopExe = nextExecutable(productRoot);
  const attestationPath = attestationFor(desktopExe);
  const releaseSetPath = releaseSetFor(desktopExe);
  const input = {
    platform: "win32",
    env: { ORQUESTA_V5_ROOT: productRoot },
    repoRoot: productRoot,
    existsSync: (candidate) => [desktopExe, attestationPath, releaseSetPath].includes(candidate),
    verifyDevelopmentIdentity: acceptingVerifier,
    verifyReleaseSet: acceptingVerifier,
  };
  for (const verifyCurrentRelease of [
    async () => { throw Object.assign(new Error("missing current pointer"), { code: "ENOENT" }); },
    async () => ({ attestation: { ...attestationIdentity, frontendBuildId: "other-build" }, releaseSet: releaseIdentity }),
    async () => ({ attestation: attestationIdentity, releaseSet: { ...releaseIdentity, generatedAt: "different-promotion" } }),
  ]) {
    await assert.rejects(
      resolveDesktopExecutable({ ...input, verifyCurrentRelease }),
      /source-matched Orquesta Next development release was not found/u,
    );
  }
  await resolveDesktopExecutable({
    ...input,
    verifyCurrentRelease: async (coordinates) => {
      assert.deepEqual(coordinates, desktopLifecycleCoordinates({ repositoryRoot: productRoot }, { platform: "win32" }));
      return acceptingCurrentRelease();
    },
  });
});
