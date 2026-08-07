"use strict";

const { readFile, rename, writeFile, mkdir } = require("node:fs/promises");
const path = require("node:path");
function loadIndexRuntime() {
  try {
    return {
      ...require("../../packages/context-compiler/src"),
      ...require("../../packages/project-structure/src"),
    };
  } catch (error) {
    if (error?.code !== "MODULE_NOT_FOUND") throw error;
    return require("../runtime/context-v2-runtime.cjs");
  }
}

const {
  auditProjectStructure,
  buildProjectMapV2,
  createCompactProjectMapView,
  createLifecycleContextReceipt,
  createLifecycleProjection,
  createLifecycleReadBoundary,
  enrichProjectMapWithLifecycle,
  refreshSourceCatalogV2,
  renderLifecycleContextReport,
  scanProjectStructure,
} = loadIndexRuntime();

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

async function writeTextAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, value, "utf8");
  await rename(temporary, filePath);
}

async function refreshContextIndex(root, { generatedAt = new Date().toISOString() } = {}) {
  const workspaceRoot = path.resolve(root);
  const contextRoot = path.join(workspaceRoot, ".orquesta", "context");
  const catalogState = await readJson(path.join(contextRoot, "source_catalog.json"));
  const controlPlane = await readJson(path.join(contextRoot, "project_control_plane.json"));
  const priorMap = await readJson(path.join(contextRoot, "project_map.json"));
  if (!catalogState || !Array.isArray(catalogState.records)) throw new Error("context_v2_source_catalog_missing");
  if (!controlPlane) throw new Error("context_v2_project_control_plane_missing");
  const refreshed = refreshSourceCatalogV2({
    workspaceRoot,
    previousRecords: catalogState.records,
  });
  const projectMap = buildProjectMapV2({
    workspaceRoot,
    sourceCatalog: refreshed.records,
    projectControlPlane: controlPlane,
    priorMap,
    generatedAt,
  });
  const sourceCatalog = {
    ...catalogState,
    generated_at: generatedAt,
    records: refreshed.records,
    last_delta: refreshed.delta,
  };
  await Promise.all([
    writeJsonAtomic(path.join(contextRoot, "source_catalog.json"), sourceCatalog),
    writeJsonAtomic(path.join(contextRoot, "project_map.json"), projectMap),
  ]);
  return { source_catalog: sourceCatalog, project_map: projectMap };
}

function fallbackControlPlane(projectId) {
  return {
    project_id: projectId,
    active_workstream: null,
    work_graph: {},
    decision_ledger: [],
  };
}

async function refreshLifecycleContextShadow(root, {
  generatedAt = new Date().toISOString(),
  layoutRef = ".orquesta/project/layout.json",
  lifecycleRef = ".orquesta/project/lifecycle.json",
  outputRef = ".orquesta/context/shadow",
  reportRef = ".orquesta/reports/V4F-PROJECT-STRUCTURE-PHASE2.md",
} = {}) {
  const workspaceRoot = path.resolve(root);
  const layout = await readJson(path.join(workspaceRoot, layoutRef));
  const lifecycleRegistry = await readJson(path.join(workspaceRoot, lifecycleRef));
  if (!layout) throw new Error("project_layout_missing");
  if (!lifecycleRegistry) throw new Error("lifecycle_registry_missing");
  const outputRoot = path.join(workspaceRoot, outputRef);
  const priorShadowCatalog = await readJson(path.join(outputRoot, "lifecycle-source-catalog.json"));
  const productionCatalog = await readJson(path.join(workspaceRoot, ".orquesta", "context", "source_catalog.json"));
  const previousRecords = priorShadowCatalog?.records || productionCatalog?.records || [];
  const priorMap = await readJson(path.join(outputRoot, "lifecycle-project-map.json"));
  const productionControlPlane = await readJson(path.join(workspaceRoot, ".orquesta", "context", "project_control_plane.json"));
  const inventory = scanProjectStructure({
    workspaceRoot,
    layout,
    lifecycleRegistry,
    generatedAt,
  });
  const projection = createLifecycleProjection(inventory);
  const audit = auditProjectStructure({ inventory, layout, lifecycleRegistry });
  const boundary = createLifecycleReadBoundary({ inventory, projection, audit, previousRecords });
  const refreshed = boundary.status === "blocked"
    ? {
        records: [],
        delta: {
          added_source_ids: [],
          changed_source_ids: [],
          removed_source_refs: [],
          unchanged_source_ids: [],
        },
      }
    : refreshSourceCatalogV2({
        workspaceRoot,
        previousRecords: boundary.eligible_previous_records,
        sourceRefs: boundary.effective_source_refs,
      });
  const baseMap = boundary.status === "blocked" ? null : buildProjectMapV2({
    workspaceRoot,
    sourceCatalog: refreshed.records,
    projectControlPlane: productionControlPlane || fallbackControlPlane(layout.project_id),
    priorMap,
    generatedAt,
  });
  const projectMap = baseMap ? enrichProjectMapWithLifecycle({
    projectMap: baseMap,
    inventory,
    projection,
    audit,
  }) : null;
  const projectMapView = projectMap ? createCompactProjectMapView(projectMap) : null;
  const sourceCatalog = {
    version: 2,
    mode: "lifecycle_shadow",
    project_id: layout.project_id,
    generated_at: generatedAt,
    records: refreshed.records,
    last_delta: refreshed.delta,
    boundary_status: boundary.status,
  };
  const receipt = createLifecycleContextReceipt({
    boundary,
    projection,
    sourceCatalog: refreshed.records,
    projectMap,
    createdAt: generatedAt,
  });
  const report = renderLifecycleContextReport({
    inventory,
    projection,
    audit,
    boundary,
    sourceCatalog,
    projectMap,
    projectMapView,
  });
  await Promise.all([
    writeJsonAtomic(path.join(outputRoot, "lifecycle-source-catalog.json"), sourceCatalog),
    writeJsonAtomic(path.join(outputRoot, "lifecycle-read-boundary.json"), boundary),
    writeJsonAtomic(path.join(outputRoot, "lifecycle-context-receipt.json"), receipt),
    writeJsonAtomic(path.join(workspaceRoot, ".orquesta", "project", "derived", "structure-inventory.json"), inventory),
    writeJsonAtomic(path.join(workspaceRoot, ".orquesta", "project", "derived", "lifecycle-projection.json"), projection),
    writeJsonAtomic(path.join(workspaceRoot, ".orquesta", "project", "derived", "structure-audit.json"), audit),
    writeTextAtomic(path.join(workspaceRoot, reportRef), report),
    projectMap
      ? writeJsonAtomic(path.join(outputRoot, "lifecycle-project-map.json"), projectMap)
      : Promise.resolve(),
    projectMapView
      ? writeJsonAtomic(path.join(outputRoot, "lifecycle-project-map-view.json"), projectMapView)
      : Promise.resolve(),
  ]);
  return {
    mode: "lifecycle_shadow",
    status: boundary.status,
    source_catalog: sourceCatalog,
    project_map: projectMap,
    project_map_view: projectMapView,
    lifecycle_receipt: receipt,
    report: reportRef.replace(/\\/gu, "/"),
  };
}

async function runCli(argv = process.argv.slice(2), { stdout = process.stdout } = {}) {
  const rootIndex = argv.indexOf("--root");
  if (rootIndex === -1 || !argv[rootIndex + 1]) throw new Error("missing_option:root");
  const generatedAtIndex = argv.indexOf("--generated-at");
  const options = { generatedAt: generatedAtIndex === -1 ? undefined : argv[generatedAtIndex + 1] };
  const lifecycleShadow = argv.includes("--lifecycle-shadow");
  const result = lifecycleShadow
    ? await refreshLifecycleContextShadow(argv[rootIndex + 1], options)
    : await refreshContextIndex(argv[rootIndex + 1], options);
  const output = lifecycleShadow ? {
    mode: result.mode,
    status: result.status,
    catalog_records: result.source_catalog.records.length,
    current_source_records: result.lifecycle_receipt.source_catalog.effective_sources,
    candidate_sources: result.lifecycle_receipt.source_catalog.candidate_sources,
    excluded_sources: result.lifecycle_receipt.source_catalog.excluded_sources,
    estimated_candidate_tokens: result.lifecycle_receipt.source_catalog.estimated_candidate_tokens,
    project_map_id: result.project_map?.project_map_id || null,
    lifecycle_overlay_id: result.project_map?.lifecycle_overlay_id || null,
    project_map_view_id: result.project_map_view?.project_map_view_id || null,
    receipt_id: result.lifecycle_receipt.receipt_id,
    report: result.report,
  } : result;
  stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  return result;
}

if (require.main === module) {
  runCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { refreshContextIndex, refreshLifecycleContextShadow, runCli };
