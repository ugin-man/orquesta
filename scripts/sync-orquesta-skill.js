"use strict";

const { createHash, randomUUID } = require("node:crypto");
const {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
} = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  acquireExclusiveProcessLock,
  releaseExclusiveProcessLock,
} = require("../packages/execution-kernel/src/exclusive-process-lock-v1");

const LEGACY_BROWSER_FILES = Object.freeze([
  "assets/dashboard/app.js",
  "assets/dashboard/index.html",
  "assets/dashboard/styles.css",
  "assets/dashboard/vendor/dagre.min.js",
  "assets/dashboard/vendor/dagre.min.js.LEGAL.txt",
  "dashboard-server.js",
  "scripts/dashboard-dom-smoke.js",
  "scripts/dashboard-port-selection.js",
  "scripts/dashboard-port-selection.test.js",
  "scripts/dashboard-report-review.test.js",
  "scripts/dashboard-state-cache.js",
  "scripts/dashboard-state-cache.test.js",
]);

function canonical(value) {
  return path.resolve(value);
}

function sourceFiles(root, relative = "") {
  const directory = path.join(root, relative);
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(root, child));
    else if (entry.isFile()) files.push(child);
    else throw new Error(`Unsupported skill entry: ${child}`);
  }
  return files;
}

function assertDistinct(source, target) {
  if (canonical(source).toLowerCase() === canonical(target).toLowerCase()) {
    throw new Error("Source and target skill directories must differ");
  }
}

function compareSourceToTarget({ source, target }) {
  const sourceRoot = canonical(source);
  const targetRoot = canonical(target);
  assertDistinct(sourceRoot, targetRoot);
  const differences = [];
  for (const relativePath of LEGACY_BROWSER_FILES) {
    try {
      lstatSync(path.join(targetRoot, relativePath));
      differences.push({ kind: "legacy_browser_surface", path: relativePath });
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
    }
  }
  for (const relativePath of sourceFiles(sourceRoot)) {
    const sourcePath = path.join(sourceRoot, relativePath);
    const targetPath = path.join(targetRoot, relativePath);
    let targetStat;
    try {
      targetStat = statSync(targetPath);
    } catch (error) {
      if (error && error.code === "ENOENT") {
        differences.push({ kind: "missing", path: relativePath });
        continue;
      }
      throw error;
    }
    if (!targetStat.isFile() || !readFileSync(sourcePath).equals(readFileSync(targetPath))) {
      differences.push({ kind: "content_mismatch", path: relativePath });
    }
  }
  const sourceSet = new Set(sourceFiles(sourceRoot));
  for (const relativePath of sourceFiles(targetRoot)) {
    if (!sourceSet.has(relativePath)) differences.push({ kind: "unexpected", path: relativePath });
  }
  return differences;
}

function removeLegacyBrowserFiles(targetRoot) {
  const removed = [];
  for (const relativePath of LEGACY_BROWSER_FILES) {
    const targetPath = path.join(targetRoot, relativePath);
    let targetStat;
    try {
      targetStat = lstatSync(targetPath);
    } catch (error) {
      if (error && error.code === "ENOENT") continue;
      throw error;
    }
    if (!targetStat.isFile() && !targetStat.isSymbolicLink()) continue;
    unlinkSync(targetPath);
    removed.push(relativePath);
  }
  return removed;
}

function removeTargetOnlyFiles(sourceRoot, targetRoot) {
  const sourceSet = new Set(sourceFiles(sourceRoot));
  const removed = [];
  for (const relativePath of sourceFiles(targetRoot)) {
    if (sourceSet.has(relativePath)) continue;
    unlinkSync(path.join(targetRoot, relativePath));
    removed.push(relativePath);
  }
  return removed;
}

function removeTreeSync(target) {
  if (!existsSync(target)) return;
  const targetStat = lstatSync(target);
  if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
    unlinkSync(target);
    return;
  }
  for (const entry of readdirSync(target)) removeTreeSync(path.join(target, entry));
  rmdirSync(target);
}

function distributionLockPath(repoRoot = path.resolve(__dirname, "..")) {
  const identity = createHash("sha256")
    .update(canonical(repoRoot).toLowerCase())
    .digest("hex")
    .slice(0, 24);
  return path.join(os.tmpdir(), `orquesta-skill-distribution-${identity}.lock`);
}

function acquireDistributionLock({
  repoRoot = path.resolve(__dirname, ".."),
  lockPath = distributionLockPath(repoRoot),
} = {}) {
  const lock = acquireExclusiveProcessLock({
    rootPath: path.dirname(lockPath),
    lockPath,
    codePrefix: "SKILL_DISTRIBUTION",
  });
  return {
    lockPath,
    owner: lock.metadata,
    release() {
      releaseExclusiveProcessLock(lock);
    },
  };
}

function syncSkillTree({ source, target }) {
  const sourceRoot = canonical(source);
  const targetRoot = canonical(target);
  assertDistinct(sourceRoot, targetRoot);
  mkdirSync(targetRoot, { recursive: true });
  const removedLegacyFiles = removeLegacyBrowserFiles(targetRoot);
  const removedTargetOnlyFiles = removeTargetOnlyFiles(sourceRoot, targetRoot);
  const files = sourceFiles(sourceRoot);
  for (const relativePath of files) {
    const sourcePath = path.join(sourceRoot, relativePath);
    const targetPath = path.join(targetRoot, relativePath);
    mkdirSync(path.dirname(targetPath), { recursive: true });
    copyFileSync(sourcePath, targetPath);
  }
  return {
    source: sourceRoot,
    target: targetRoot,
    copiedFiles: files.length,
    removedLegacyFiles,
    removedTargetOnlyFiles,
    remainingDifferences: compareSourceToTarget({ source: sourceRoot, target: targetRoot }),
  };
}

function ensureWithin(base, target, label) {
  const baseRoot = canonical(base);
  const targetRoot = canonical(target);
  if (targetRoot === baseRoot || !targetRoot.startsWith(`${baseRoot}${path.sep}`)) {
    throw new Error(`${label} must stay inside its declared base`);
  }
  return targetRoot;
}

function loadDistributionManifest({
  repoRoot = path.resolve(__dirname, ".."),
  homeDirectory = os.homedir(),
  manifestPath = path.resolve(__dirname, "orquesta-skill-distribution.v1.json"),
} = {}) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest?.schemaVersion !== 1 || manifest?.source !== "orquesta" || !Array.isArray(manifest.targets)) {
    throw new Error("Invalid Orquesta skill distribution manifest");
  }
  const repository = canonical(repoRoot);
  const source = ensureWithin(repository, path.join(repository, manifest.source), "Skill source");
  if (!existsSync(path.join(source, "SKILL.md"))) throw new Error("Canonical Orquesta skill source is unavailable");
  const targets = manifest.targets.map((entry) => {
    let base;
    if (entry.base === "repository") base = repository;
    else if (entry.base === "home") base = canonical(homeDirectory);
    else if (entry.base === "sibling") base = canonical(path.join(repository, "..", entry.sibling));
    else throw new Error(`Unsupported skill distribution base: ${entry.base}`);
    for (const marker of entry.requiredMarkers || []) {
      if (!existsSync(path.join(base, marker))) {
        throw new Error(`Skill distribution target ${entry.id} is unavailable: missing ${marker}`);
      }
    }
    return {
      id: entry.id,
      target: ensureWithin(base, path.join(base, entry.path), `Skill distribution target ${entry.id}`),
    };
  });
  const identities = new Set();
  for (const entry of targets) {
    const identity = entry.target.toLowerCase();
    if (identities.has(identity)) throw new Error(`Duplicate skill distribution target: ${entry.id}`);
    identities.add(identity);
    assertDistinct(source, entry.target);
  }
  return { source, targets };
}

function skillTreeDigest(root) {
  const hash = createHash("sha256");
  for (const relativePath of sourceFiles(root)) {
    const bytes = readFileSync(path.join(root, relativePath));
    hash.update(Buffer.from(relativePath, "utf8"));
    hash.update(Buffer.from([0]));
    hash.update(bytes);
    hash.update(Buffer.from([0]));
  }
  return hash.digest("hex");
}

function syncDistributionTargets({
  source,
  targets,
  transactionId = randomUUID(),
  renameEntry = renameSync,
  removeEntry = removeTreeSync,
  stageTree = syncSkillTree,
} = {}) {
  const sourceRoot = canonical(source);
  const snapshotRoot = path.join(os.tmpdir(), `orquesta-skill-source-${transactionId}`);
  if (existsSync(snapshotRoot)) throw new Error("Skill distribution source snapshot already exists");
  let states = [];
  try {
    syncSkillTree({ source: sourceRoot, target: snapshotRoot });
    if (compareSourceToTarget({ source: sourceRoot, target: snapshotRoot }).length > 0) {
      throw new Error("Canonical skill changed while its distribution snapshot was created");
    }
    const sourceDigest = skillTreeDigest(snapshotRoot);
    states = targets.map((entry) => {
      const target = canonical(entry.target);
      const parent = path.dirname(target);
      if (!existsSync(parent)) throw new Error(`Skill distribution parent is unavailable: ${entry.id}`);
      const suffix = `.orquesta-sync-${transactionId}`;
      return {
        id: entry.id,
        target,
        stage: path.join(parent, `.${path.basename(target)}${suffix}.stage`),
        backup: path.join(parent, `.${path.basename(target)}${suffix}.backup`),
        targetExisted: existsSync(target),
        backupCreated: false,
        promoted: false,
      };
    });
    for (const state of states) {
      const prefix = `.${path.basename(state.target)}.orquesta-sync-`;
      const transactionArtifacts = readdirSync(path.dirname(state.target))
        .filter((entry) => entry.startsWith(prefix) && (entry.endsWith(".stage") || entry.endsWith(".backup")))
        .map((entry) => path.join(path.dirname(state.target), entry));
      const backups = transactionArtifacts.filter((entry) => entry.endsWith(".backup"));
      for (const backup of backups) {
        const stage = `${backup.slice(0, -".backup".length)}.stage`;
        if (existsSync(state.target)) {
          if (compareSourceToTarget({ source: snapshotRoot, target: state.target }).length > 0) {
            throw new Error(`Ambiguous interrupted skill distribution transaction: ${state.id}`);
          }
          removeEntry(backup);
        } else {
          renameEntry(backup, state.target);
        }
        if (existsSync(stage)) removeEntry(stage);
      }
      for (const stage of transactionArtifacts.filter((entry) => entry.endsWith(".stage"))) {
        if (existsSync(stage)) removeEntry(stage);
      }
      state.targetExisted = existsSync(state.target);
    }
    let results;
    try {
      for (const state of states) {
        if (existsSync(state.stage) || existsSync(state.backup)) throw new Error(`Skill distribution transaction path exists: ${state.id}`);
        stageTree({ source: snapshotRoot, target: state.stage });
        if (compareSourceToTarget({ source: snapshotRoot, target: state.stage }).length > 0) {
          throw new Error(`Skill distribution staging verification failed: ${state.id}`);
        }
      }
      if (compareSourceToTarget({ source: sourceRoot, target: snapshotRoot }).length > 0) {
        throw new Error("Canonical skill changed before distribution promotion");
      }
      for (const state of states) {
        if (state.targetExisted) {
          renameEntry(state.target, state.backup);
          state.backupCreated = true;
        }
        renameEntry(state.stage, state.target);
        state.promoted = true;
        if (compareSourceToTarget({ source: snapshotRoot, target: state.target }).length > 0) {
          throw new Error(`Skill distribution promoted verification failed: ${state.id}`);
        }
      }
      if (compareSourceToTarget({ source: sourceRoot, target: snapshotRoot }).length > 0) {
        throw new Error("Canonical skill changed before distribution commit");
      }
      results = states.map((state) => ({
        id: state.id,
        source: sourceRoot,
        sourceDigest,
        target: state.target,
        copiedFiles: sourceFiles(snapshotRoot).length,
        remainingDifferences: compareSourceToTarget({ source: snapshotRoot, target: state.target }),
      }));
      if (results.some((result) => result.remainingDifferences.length > 0)) {
        throw new Error("Skill distribution committed targets do not share one exact source generation");
      }
    } catch (error) {
      for (const state of [...states].reverse()) {
        if (state.promoted && existsSync(state.target)) renameEntry(state.target, state.stage);
        if (state.backupCreated && existsSync(state.backup)) renameEntry(state.backup, state.target);
        if (existsSync(state.stage)) removeEntry(state.stage);
      }
      throw error;
    }
    for (const state of states) {
      if (existsSync(state.backup)) removeEntry(state.backup);
    }
    return results;
  } finally {
    if (existsSync(snapshotRoot)) removeEntry(snapshotRoot);
  }
}

function parseArguments(argv) {
  const result = {
    source: path.resolve(__dirname, "..", "orquesta"),
    targets: [],
    check: false,
    all: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--source") result.source = argv[++index];
    else if (argument === "--target") result.targets.push(argv[++index]);
    else if (argument === "--check") result.check = true;
    else if (argument === "--all") result.all = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (result.all && (result.targets.length > 0 || argv.includes("--source"))) {
    throw new Error("--all uses only the declared V5 distribution manifest");
  }
  result.targets = [...new Map(result.targets.map((target) => [canonical(target).toLowerCase(), target])).values()];
  if (!result.all && result.targets.length === 0) throw new Error("At least one explicit --target is required");
  return result;
}

function main() {
  const input = parseArguments(process.argv.slice(2));
  let results;
  if (input.all) {
    const distribution = loadDistributionManifest();
    const lock = acquireDistributionLock();
    try {
      results = input.check
        ? distribution.targets.map((entry) => ({
            id: entry.id,
            target: entry.target,
            differences: compareSourceToTarget({ source: distribution.source, target: entry.target }),
          }))
        : syncDistributionTargets(distribution);
    } finally {
      lock.release();
    }
  } else {
    results = input.targets.map((target) => (
      input.check
        ? { target: canonical(target), differences: compareSourceToTarget({ source: input.source, target }) }
        : syncSkillTree({ source: input.source, target })
    ));
  }
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  if (input.check && results.some((result) => result.differences.length > 0)) process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  LEGACY_BROWSER_FILES,
  acquireDistributionLock,
  compareSourceToTarget,
  distributionLockPath,
  parseArguments,
  removeLegacyBrowserFiles,
  removeTargetOnlyFiles,
  loadDistributionManifest,
  removeTreeSync,
  syncDistributionTargets,
  syncSkillTree,
};
