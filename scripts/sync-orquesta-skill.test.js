"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  compareSourceToTarget,
  LEGACY_BROWSER_FILES,
  acquireDistributionLock,
  loadDistributionManifest,
  parseArguments,
  syncDistributionTargets,
  syncSkillTree,
} = require("./sync-orquesta-skill");

const roots = [];
test.afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "orquesta-skill-sync-"));
  roots.push(root);
  const source = path.join(root, "source");
  const target = path.join(root, "target");
  mkdirSync(path.join(source, "references"), { recursive: true });
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(source, "SKILL.md"), "v5\n", "utf8");
  writeFileSync(path.join(source, "references", "user-support.md"), "support\n", "utf8");
  writeFileSync(path.join(target, "SKILL.md"), "legacy\n", "utf8");
  writeFileSync(path.join(target, "package.json"), "{\"private\":true}\n", "utf8");
  return { root, source, target };
}

function distributionFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "orquesta-skill-distribution-"));
  roots.push(root);
  const repositoryRoot = path.join(root, "Orquesta-V5");
  const coordinationRoot = path.join(root, "Orquesta");
  const homeDirectory = path.join(root, "home");
  mkdirSync(path.join(repositoryRoot, "orquesta"), { recursive: true });
  mkdirSync(path.join(repositoryRoot, ".agents", "skills"), { recursive: true });
  mkdirSync(path.join(coordinationRoot, ".orquesta"), { recursive: true });
  mkdirSync(path.join(coordinationRoot, ".agents", "skills"), { recursive: true });
  mkdirSync(path.join(homeDirectory, ".codex", "skills"), { recursive: true });
  writeFileSync(path.join(repositoryRoot, "package.json"), "{}\n", "utf8");
  writeFileSync(path.join(repositoryRoot, "orquesta", "SKILL.md"), "canonical\n", "utf8");
  writeFileSync(path.join(coordinationRoot, ".orquesta", "CURRENT_ORCHESTRA.md"), "current\n", "utf8");
  const manifestPath = path.join(repositoryRoot, "distribution.json");
  writeFileSync(manifestPath, JSON.stringify({
    schemaVersion: 1,
    source: "orquesta",
    targets: [
      { id: "repo", base: "repository", path: ".agents/skills/orquesta", requiredMarkers: ["package.json"] },
      { id: "coord", base: "sibling", sibling: "Orquesta", path: ".agents/skills/orquesta", requiredMarkers: [".orquesta/CURRENT_ORCHESTRA.md"] },
      { id: "home", base: "home", path: ".codex/skills/orquesta", requiredMarkers: [".codex"] },
    ],
  }), "utf8");
  return { repositoryRoot, coordinationRoot, homeDirectory, manifestPath };
}

test("canonical skill resolves task authority before considering Foundation bootstrap", () => {
  const skillRoot = path.resolve(__dirname, "..", "orquesta");
  const skill = readFileSync(path.join(skillRoot, "SKILL.md"), "utf8");
  const bootstrap = readFileSync(path.join(skillRoot, "references", "project-bootstrap.md"), "utf8");
  const protocol = readFileSync(path.join(skillRoot, "references", "orchestration-protocol.md"), "utf8");
  const resolveIndex = skill.indexOf("Resolve `canonical_state_root` before deciding whether Foundation bootstrap applies.");
  const bootstrapIndex = skill.indexOf("Use `references/project-bootstrap.md` only after selected-project authority");

  assert.ok(resolveIndex >= 0 && resolveIndex < bootstrapIndex);
  assert.match(skill, /An empty `\.orquesta` directory, an empty state directory, or a missing `CURRENT_ORCHESTRA\.md` alone is not bootstrap evidence\./u);
  assert.match(bootstrap, /If selected-project authority is unavailable, report an authority gap instead\./u);
  assert.match(protocol, /Apply the authority classification in `SKILL\.md` Start From the Smallest Reliable Context\./u);
  assert.match(protocol, /this protocol does not maintain a second bootstrap classifier or state machine\./u);
});

test("makes the target an exact copy of the canonical skill", () => {
  const { source, target } = fixture();
  const result = syncSkillTree({ source, target });
  assert.equal(result.copiedFiles, 2);
  assert.equal(readFileSync(path.join(target, "SKILL.md"), "utf8"), "v5\n");
  assert.equal(readFileSync(path.join(target, "references", "user-support.md"), "utf8"), "support\n");
  assert.equal(result.removedTargetOnlyFiles.includes("package.json"), true);
  assert.deepEqual(compareSourceToTarget({ source, target }), []);
});

test("removes fixed legacy browser files and every other target-only file", () => {
  const { source, target } = fixture();
  const legacyFile = LEGACY_BROWSER_FILES.find((entry) => entry === "dashboard-server.js");
  mkdirSync(path.join(target, "assets", "dashboard"), { recursive: true });
  writeFileSync(path.join(target, legacyFile), "legacy browser server\n", "utf8");
  writeFileSync(path.join(target, "assets", "dashboard", "unknown-metadata.json"), "{}\n", "utf8");
  assert.deepEqual(
    compareSourceToTarget({ source, target }).filter((item) => item.kind === "legacy_browser_surface"),
    [{ kind: "legacy_browser_surface", path: legacyFile }],
  );
  const result = syncSkillTree({ source, target });
  assert.deepEqual(result.removedLegacyFiles, [legacyFile]);
  assert.equal(result.removedTargetOnlyFiles.includes(path.join("assets", "dashboard", "unknown-metadata.json")), true);
  assert.deepEqual(result.remainingDifferences, []);
});

test("reports content drift and missing canonical files", () => {
  const { source, target } = fixture();
  assert.deepEqual(
    compareSourceToTarget({ source, target }).map((item) => item.kind).sort(),
    ["content_mismatch", "missing", "unexpected"],
  );
});

test("refuses to synchronize a directory onto itself", () => {
  const { source } = fixture();
  assert.throws(() => syncSkillTree({ source, target: source }), /must differ/u);
});

test("creates a missing target before exact synchronization", () => {
  const { source, target } = fixture();
  rmSync(target, { recursive: true, force: true });
  const result = syncSkillTree({ source, target });
  assert.equal(readFileSync(path.join(target, "SKILL.md"), "utf8"), "v5\n");
  assert.deepEqual(result.remainingDifferences, []);
});

test("resolves the declared distribution only after every base marker is valid", () => {
  const { repositoryRoot, coordinationRoot, homeDirectory, manifestPath } = distributionFixture();
  const result = loadDistributionManifest({ repoRoot: repositoryRoot, homeDirectory, manifestPath });
  assert.equal(result.source, path.join(repositoryRoot, "orquesta"));
  assert.deepEqual(result.targets.map((entry) => entry.target), [
    path.join(repositoryRoot, ".agents", "skills", "orquesta"),
    path.join(coordinationRoot, ".agents", "skills", "orquesta"),
    path.join(homeDirectory, ".codex", "skills", "orquesta"),
  ]);
});

test("fails closed on a wrong sibling before creating any distribution target", () => {
  const { repositoryRoot, coordinationRoot, homeDirectory, manifestPath } = distributionFixture();
  rmSync(path.join(coordinationRoot, ".orquesta", "CURRENT_ORCHESTRA.md"));
  assert.throws(
    () => loadDistributionManifest({ repoRoot: repositoryRoot, homeDirectory, manifestPath }),
    /missing .orquesta\/CURRENT_ORCHESTRA.md/u,
  );
  assert.equal(existsSync(path.join(repositoryRoot, ".agents", "skills", "orquesta")), false);
  assert.equal(existsSync(path.join(coordinationRoot, ".agents", "skills", "orquesta")), false);
  assert.equal(existsSync(path.join(homeDirectory, ".codex", "skills", "orquesta")), false);
});

test("rolls every target back when one promotion fails", () => {
  const { source, root } = fixture();
  const first = path.join(root, "targets", "first");
  const second = path.join(root, "targets", "second");
  mkdirSync(first, { recursive: true });
  mkdirSync(second, { recursive: true });
  writeFileSync(path.join(first, "SKILL.md"), "old-first\n", "utf8");
  writeFileSync(path.join(second, "SKILL.md"), "old-second\n", "utf8");
  let failed = false;
  const renameEntry = (from, to) => {
    if (!failed && to === second && from.endsWith(".stage")) {
      failed = true;
      throw new Error("injected_second_promotion_failure");
    }
    renameSync(from, to);
  };
  assert.throws(
    () => syncDistributionTargets({
      source,
      targets: [{ id: "first", target: first }, { id: "second", target: second }],
      transactionId: "rollback-test",
      renameEntry,
    }),
    /injected_second_promotion_failure/u,
  );
  assert.equal(readFileSync(path.join(first, "SKILL.md"), "utf8"), "old-first\n");
  assert.equal(readFileSync(path.join(second, "SKILL.md"), "utf8"), "old-second\n");
  assert.deepEqual(
    readdirSync(path.dirname(first)).filter((entry) => entry.includes("orquesta-sync-rollback-test")),
    [],
  );
});

test("synchronizes every declared target as one verified transaction", () => {
  const { repositoryRoot, homeDirectory, manifestPath } = distributionFixture();
  const distribution = loadDistributionManifest({ repoRoot: repositoryRoot, homeDirectory, manifestPath });
  const results = syncDistributionTargets({ ...distribution, transactionId: "success-test" });
  assert.equal(results.length, 3);
  for (const result of results) assert.deepEqual(result.remainingDifferences, []);
  assert.equal(new Set(results.map((result) => result.sourceDigest)).size, 1);
});

test("rolls every target back when the canonical skill changes during staging", () => {
  const { source, root } = fixture();
  const first = path.join(root, "targets", "first");
  const second = path.join(root, "targets", "second");
  mkdirSync(first, { recursive: true });
  mkdirSync(second, { recursive: true });
  writeFileSync(path.join(first, "SKILL.md"), "old-first\n", "utf8");
  writeFileSync(path.join(second, "SKILL.md"), "old-second\n", "utf8");
  let staged = 0;
  const stageTree = (input) => {
    const result = syncSkillTree(input);
    staged += 1;
    if (staged === 2) writeFileSync(path.join(source, "SKILL.md"), "changed-during-staging\n", "utf8");
    return result;
  };

  assert.throws(
    () => syncDistributionTargets({
      source,
      targets: [{ id: "first", target: first }, { id: "second", target: second }],
      transactionId: "source-drift-test",
      stageTree,
    }),
    /Canonical skill changed before distribution promotion/u,
  );
  assert.equal(readFileSync(path.join(first, "SKILL.md"), "utf8"), "old-first\n");
  assert.equal(readFileSync(path.join(second, "SKILL.md"), "utf8"), "old-second\n");
  assert.deepEqual(
    readdirSync(path.dirname(first)).filter((entry) => entry.includes("orquesta-sync-source-drift-test")),
    [],
  );
});

test("cleans a committed transaction left behind by a terminated process", () => {
  const { source, root } = fixture();
  const target = path.join(root, "targets", "current");
  const backup = path.join(root, "targets", ".current.orquesta-sync-crashed.backup");
  mkdirSync(target, { recursive: true });
  mkdirSync(backup, { recursive: true });
  syncSkillTree({ source, target });
  writeFileSync(path.join(backup, "SKILL.md"), "previous\n", "utf8");

  const [result] = syncDistributionTargets({
    source,
    targets: [{ id: "current", target }],
    transactionId: "recovered",
  });

  assert.deepEqual(result.remainingDifferences, []);
  assert.equal(existsSync(backup), false);
  assert.deepEqual(
    readdirSync(path.dirname(target)).filter((entry) => entry.includes("orquesta-sync-")),
    [],
  );
});

test("keeps manifest distribution separate from explicit one-target repair", () => {
  assert.deepEqual(parseArguments(["--check", "--all"]), {
    source: path.resolve(__dirname, "..", "orquesta"),
    targets: [],
    check: true,
    all: true,
  });
  assert.throws(() => parseArguments(["--all", "--target", "somewhere"]), /declared V5 distribution manifest/u);
  assert.throws(() => parseArguments(["--all", "--source", "somewhere"]), /declared V5 distribution manifest/u);
});

test("allows only one live distribution owner", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "orquesta-skill-lock-"));
  roots.push(root);
  const lockPath = path.join(root, "distribution.lock");
  const first = acquireDistributionLock({
    repoRoot: root,
    lockPath,
  });
  assert.throws(
    () => acquireDistributionLock({
      repoRoot: root,
      lockPath,
    }),
    { code: "SKILL_DISTRIBUTION_LOCKED" },
  );
  first.release();
  assert.equal(existsSync(lockPath), false);
});

test("recovers a lock only after its owner is confirmed dead", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "orquesta-skill-stale-lock-"));
  roots.push(root);
  const lockPath = path.join(root, "distribution.lock");
  const modulePath = path.resolve(__dirname, "sync-orquesta-skill.js");
  const child = spawnSync(process.execPath, [
    "-e",
    "require(process.argv[1]).acquireDistributionLock({ repoRoot: process.argv[3], lockPath: process.argv[2] });",
    modulePath,
    lockPath,
    root,
  ], { encoding: "utf8", windowsHide: true });
  assert.equal(child.status, 0, `${child.stderr}\n${child.stdout}`);
  assert.equal(existsSync(lockPath), true);
  const recovered = acquireDistributionLock({ repoRoot: root, lockPath });
  assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).pid, process.pid);
  recovered.release();
  assert.equal(existsSync(lockPath), false);
});
