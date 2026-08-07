#!/usr/bin/env node

"use strict";

const fs = require("node:fs");
const path = require("node:path");
function loadPlacementRuntime() {
  try {
    return require("../../packages/project-structure/src");
  } catch (error) {
    if (error?.code !== "MODULE_NOT_FOUND") throw error;
    return require("../runtime/context-v2-runtime.cjs");
  }
}

const {
  auditCanonicalClaimsForPlacement,
  inspectTaskPlacementCompletion,
  resolvePlacement,
  scanProjectStructure,
} = loadPlacementRuntime();

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch (cleanupError) {
      if (cleanupError.code !== "ENOENT") error.cleanupError = cleanupError;
    }
    throw error;
  }
}

function loadPlacementManifests(rootPath) {
  const root = fs.realpathSync(rootPath);
  const layoutPath = path.join(root, ".orquesta", "project", "layout.json");
  const lifecyclePath = path.join(root, ".orquesta", "project", "lifecycle.json");
  if (!fs.existsSync(layoutPath) || !fs.existsSync(lifecyclePath)) {
    return { configured: false, root, layout: null, lifecycleRegistry: null };
  }
  return {
    configured: true,
    root,
    layout: readJson(layoutPath),
    lifecycleRegistry: readJson(lifecyclePath),
  };
}

function loadOrScanInventory(state, generatedAt) {
  const cachedPath = path.join(
    state.root,
    ".orquesta",
    "project",
    "derived",
    "structure-inventory.json",
  );
  if (fs.existsSync(cachedPath)) {
    const cached = readJson(cachedPath);
    if (cached?.project_id === state.layout.project_id && Array.isArray(cached.files)) return cached;
  }
  return scanProjectStructure({
    workspaceRoot: state.root,
    layout: state.layout,
    lifecycleRegistry: state.lifecycleRegistry,
    generatedAt,
  });
}

function resolvePlacementAtRoot({ rootPath, request, outputPath = null } = {}) {
  const state = loadPlacementManifests(rootPath);
  if (!state.configured) throw new Error("placement_manifests_missing");
  const inventory = loadOrScanInventory(state, request.created_at);
  const audit = auditCanonicalClaimsForPlacement({
    workspaceRoot: state.root,
    layout: state.layout,
    lifecycleRegistry: state.lifecycleRegistry,
  });
  const decision = resolvePlacement({
    workspaceRoot: state.root,
    layout: state.layout,
    lifecycleRegistry: state.lifecycleRegistry,
    inventory,
    audit,
    request,
  });
  const target = outputPath || path.join(
    state.root,
    ".orquesta",
    "project",
    "derived",
    "placement",
    `${encodeURIComponent(request.task_id)}.json`,
  );
  writeJsonAtomic(target, decision);
  return { decision, output_path: path.relative(state.root, target).replace(/\\/gu, "/") };
}

function runPlacementCompletionHook({ rootPath, taskId, changedPaths, checkedAt, persist = true } = {}) {
  const state = loadPlacementManifests(rootPath);
  if (!state.configured) {
    return Object.freeze({
      schema_version: 1,
      mode: "completion_hook",
      task_id: String(taskId),
      status: "not_configured",
      checked_at: checkedAt || new Date().toISOString(),
      changed_paths: [...new Set(changedPaths || [])].sort(),
      warnings: [],
      hard_errors: [],
      inventory_file_count: 0,
    });
  }
  const canonicalAudit = auditCanonicalClaimsForPlacement({
    workspaceRoot: state.root,
    layout: state.layout,
    lifecycleRegistry: state.lifecycleRegistry,
  });
  const result = inspectTaskPlacementCompletion({
    taskId,
    changedPaths,
    layout: state.layout,
    lifecycleRegistry: state.lifecycleRegistry,
    audit: canonicalAudit,
    checkedAt,
  });
  if (persist) {
    writeJsonAtomic(path.join(
      state.root,
      ".orquesta",
      "project",
      "derived",
      "placement-completion",
      `${encodeURIComponent(taskId)}.json`,
    ), result);
  }
  return result;
}

function argumentValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function main(args = process.argv.slice(2)) {
  const rootPath = path.resolve(argumentValue(args, "--root") || process.cwd());
  const requestPath = argumentValue(args, "--request");
  const outputPath = argumentValue(args, "--output");
  const request = requestPath ? readJson(path.resolve(requestPath)) : {
    version: 1,
    task_id: argumentValue(args, "--task-id"),
    proposed_path: argumentValue(args, "--proposed-path"),
    suggested_name: argumentValue(args, "--name"),
    target_component_id: argumentValue(args, "--component"),
    artifact_kind: argumentValue(args, "--artifact-kind"),
    authority_intent: argumentValue(args, "--authority-intent") || "supporting",
    audience: argumentValue(args, "--audience") || "mixed",
    retention: argumentValue(args, "--retention") || "project",
    replaces: (argumentValue(args, "--replaces") || "").split(",").filter(Boolean),
    claim_key: argumentValue(args, "--claim-key"),
    root_placement_reason: argumentValue(args, "--root-reason"),
    created_at: new Date().toISOString(),
  };
  const result = resolvePlacementAtRoot({
    rootPath,
    request,
    outputPath: outputPath ? path.resolve(outputPath) : null,
  });
  process.stdout.write(`${JSON.stringify({
    status: result.decision.status,
    decision_id: result.decision.decision_id,
    target_path: result.decision.target_path,
    component_id: result.decision.component_id,
    warnings: result.decision.warnings.length,
    hard_errors: result.decision.hard_errors.length,
    output_path: result.output_path,
  }, null, 2)}\n`);
  if (result.decision.status === "blocked") process.exitCode = 1;
  return result;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  loadPlacementManifests,
  loadOrScanInventory,
  main,
  resolvePlacementAtRoot,
  runPlacementCompletionHook,
  writeJsonAtomic,
};
