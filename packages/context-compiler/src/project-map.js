"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { assertContract, canonicalHash } = require("@orquesta/contracts");

const CODE_EXTENSIONS = new Set([".js", ".cjs", ".mjs", ".ts", ".tsx", ".jsx"]);
const TEXT_EXTENSIONS = new Set([
  ...CODE_EXTENSIONS,
  ".c", ".cpp", ".css", ".csv", ".h", ".html", ".json", ".jsonl", ".md",
  ".ps1", ".py", ".sh", ".sql", ".svg", ".toml", ".txt", ".xml", ".yaml", ".yml",
]);

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim()))].sort(compareText);
}

function safeReference(workspaceRoot, reference) {
  if (typeof reference !== "string" || !reference || reference.includes(":")) return null;
  const normalized = reference.replace(/\\/gu, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//u.test(normalized)) return null;
  const root = fs.realpathSync(workspaceRoot);
  const candidate = path.resolve(root, ...normalized.split("/"));
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return candidate;
}

function sourceType(reference) {
  if (reference === ".orquesta/state/tasks.json") return "task_record";
  if (reference.includes("/directives") || reference.includes("/decisions")) return "accepted_decision";
  if (reference.startsWith("interfaces/") || reference.includes("/interfaces/")) return "interface";
  if (reference.startsWith("tests/") || reference.includes("/test/") || reference.includes("/tests/")) return "test";
  if (reference.includes("/reports/") || reference.startsWith("reports/")) return "report";
  return "project_file";
}

function artifactType(reference) {
  const extension = path.posix.extname(reference).toLowerCase();
  if (CODE_EXTENSIONS.has(extension)) return "source_code";
  if (extension === ".json" || extension === ".jsonl") return "structured_state";
  if (extension === ".md" || extension === ".txt") return "documentation";
  if ([".png", ".jpg", ".jpeg", ".svg", ".webp"].includes(extension)) return "visual_reference";
  return "project_file";
}

function recordForFile(reference, content, { status = "current" } = {}) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(String(content || ""), "utf8");
  const sourceHash = status === "missing"
    ? crypto.createHash("sha256").update(`missing\0${reference}`).digest("hex")
    : crypto.createHash("sha256").update(bytes).digest("hex");
  const record = {
    schema_version: 2,
    source_id: `SRC-${canonicalHash({ source_ref: reference, source_hash: sourceHash }).slice(0, 12)}`,
    source_ref: reference,
    source_hash: sourceHash,
    source_type: sourceType(reference),
    authority: reference.startsWith(".orquesta/") ? "canonical" : "workspace",
    freshness: status === "current" ? "current" : "unknown",
    knowledge_domains: [],
    artifact_types: [artifactType(reference)],
    supports_criteria: [],
    token_estimate: status === "missing" ? 0 : Math.max(1, Math.ceil(bytes.byteLength / 4)),
    content_mode: "reference",
    summary: null,
    status,
  };
  return assertContract("source-record", record);
}

function refreshSourceCatalogV2({
  workspaceRoot,
  previousRecords = [],
  sourceRefs = [],
} = {}) {
  if (typeof workspaceRoot !== "string" || !workspaceRoot) {
    throw new TypeError("workspaceRoot is required");
  }
  const previous = (Array.isArray(previousRecords) ? previousRecords : [])
    .map((record) => clone(assertContract("source-record", record)));
  const workspaceRefs = uniqueStrings([
    ...sourceRefs,
    ...previous.filter((record) => !record.source_ref.includes(":")).map((record) => record.source_ref),
  ]);
  const preservedSynthetic = previous.filter((record) => record.source_ref.includes(":"));
  const next = [...preservedSynthetic];
  const added = [];
  const changed = [];
  const removed = [];
  const unchanged = [];

  for (const reference of workspaceRefs) {
    const target = safeReference(workspaceRoot, reference);
    const exists = target && fs.existsSync(target) && fs.statSync(target).isFile();
    const current = recordForFile(reference, exists ? fs.readFileSync(target) : "", {
      status: exists ? "current" : "missing",
    });
    const priorForRef = previous.filter((record) => record.source_ref === reference);
    const priorCurrent = priorForRef.find((record) => record.status === "current")
      || priorForRef.find((record) => record.status === "missing");
    const same = priorCurrent
      && priorCurrent.source_hash === current.source_hash
      && priorCurrent.status === current.status;
    if (same) {
      next.push(...priorForRef);
      unchanged.push(priorCurrent.source_id);
      continue;
    }
    for (const prior of priorForRef) {
      next.push(prior.status === "current" || prior.status === "missing"
        ? { ...prior, status: "superseded", freshness: "stale" }
        : prior);
    }
    next.push(current);
    if (!priorCurrent && current.status === "current") added.push(current.source_id);
    else if (current.status === "missing") removed.push(reference);
    else changed.push(current.source_id);
  }
  const byIdentity = new Map();
  for (const record of next) {
    const validated = assertContract("source-record", record);
    byIdentity.set(`${validated.source_id}:${validated.status}`, validated);
  }
  const records = [...byIdentity.values()].sort((left, right) => (
    compareText(`${left.source_ref}:${left.status}:${left.source_id}`, `${right.source_ref}:${right.status}:${right.source_id}`)
  ));
  const delta = {
    added_source_ids: added.sort(compareText),
    changed_source_ids: changed.sort(compareText),
    removed_source_refs: removed.sort(compareText),
    unchanged_source_ids: unchanged.sort(compareText),
  };
  return Object.freeze({ records: Object.freeze(records), delta: Object.freeze(delta) });
}

function extractCodeMetadata(content) {
  const text = String(content || "");
  const symbols = [];
  const symbolPattern = /\b(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var)\s+([A-Za-z_$][\w$]*)/gu;
  for (const match of text.matchAll(symbolPattern)) symbols.push(match[1]);
  const dependencies = [];
  const patterns = [
    /\bfrom\s+["']([^"']+)["']/gu,
    /\brequire\(\s*["']([^"']+)["']\s*\)/gu,
    /\bimport\(\s*["']([^"']+)["']\s*\)/gu,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) dependencies.push(match[1]);
  }
  return { symbols: uniqueStrings(symbols), dependencies: uniqueStrings(dependencies) };
}

function firstDescription(content, reference) {
  const text = String(content || "");
  const line = text.split(/\r?\n/u)
    .map((entry) => entry.trim())
    .find((entry) => entry && !/^(?:[{}[\],]|\/\/|\/\*|\*)$/u.test(entry));
  return (line || `${artifactType(reference)} artifact`).slice(0, 240);
}

function componentFor(reference) {
  const parts = reference.split("/").filter(Boolean);
  if (parts.length <= 1) return ".";
  if (parts[0] === "packages" || parts[0] === "apps") return parts.slice(0, 2).join("/");
  return parts[0];
}

function buildProjectMapV2({
  workspaceRoot,
  sourceCatalog,
  projectControlPlane = null,
  priorMap = null,
  relatedTaskIdsByRef = {},
  generatedAt,
} = {}) {
  const currentRecords = (Array.isArray(sourceCatalog) ? sourceCatalog : [])
    .map((record) => clone(assertContract("source-record", record)))
    .filter((record) => record.status === "current" && !record.source_ref.includes(":"))
    .sort((left, right) => compareText(left.source_ref, right.source_ref));
  const details = [];
  for (const record of currentRecords) {
    const target = safeReference(workspaceRoot, record.source_ref);
    const extension = path.posix.extname(record.source_ref).toLowerCase();
    const content = target
      && TEXT_EXTENSIONS.has(extension)
      && fs.existsSync(target)
      && fs.statSync(target).isFile()
      ? fs.readFileSync(target, "utf8")
      : "";
    const code = CODE_EXTENSIONS.has(extension);
    const metadata = code ? extractCodeMetadata(content) : { symbols: [], dependencies: [] };
    details.push({
      source_id: record.source_id,
      source_ref: record.source_ref,
      source_hash: record.source_hash,
      component: componentFor(record.source_ref),
      artifact_type: record.artifact_types[0],
      description: firstDescription(content, record.source_ref),
      symbols: metadata.symbols,
      dependencies: metadata.dependencies,
      related_task_ids: uniqueStrings(relatedTaskIdsByRef[record.source_ref]),
    });
  }
  const componentMap = new Map();
  for (const detail of details) {
    const component = componentMap.get(detail.component) || {
      component: detail.component,
      source_count: 0,
      artifact_types: new Set(),
      source_refs: [],
      dependency_refs: new Set(),
    };
    component.source_count += 1;
    component.artifact_types.add(detail.artifact_type);
    component.source_refs.push(detail.source_ref);
    for (const dependency of detail.dependencies) component.dependency_refs.add(dependency);
    componentMap.set(detail.component, component);
  }
  const components = [...componentMap.values()].map((component) => ({
    component: component.component,
    source_count: component.source_count,
    artifact_types: [...component.artifact_types].sort(compareText),
    source_refs: component.source_refs.sort(compareText),
    dependency_refs: [...component.dependency_refs].sort(compareText),
    summary: `${component.source_count} sources; ${[...component.artifact_types].sort(compareText).join(", ")}`,
  })).sort((left, right) => compareText(left.component, right.component));
  const signature = {
    project_id: projectControlPlane?.project_id || "orquesta-project",
    source_hashes: details.map(({ source_ref, source_hash }) => ({ source_ref, source_hash })),
    work_graph: projectControlPlane?.work_graph || {},
    decision_ledger: projectControlPlane?.decision_ledger || [],
  };
  const priorSignatureHash = priorMap?.source_signature_hash || null;
  const sourceSignatureHash = canonicalHash(signature);
  const priorByRef = new Map((Array.isArray(priorMap?.details) ? priorMap.details : [])
    .map((detail) => [detail.source_ref, detail]));
  const currentRefs = new Set(details.map((detail) => detail.source_ref));
  const changedRefs = details
    .filter((detail) => priorByRef.get(detail.source_ref)?.source_hash !== detail.source_hash)
    .map((detail) => detail.source_ref);
  const removedRefs = [...priorByRef.keys()].filter((reference) => !currentRefs.has(reference));
  const revision = priorMap && priorSignatureHash === sourceSignatureHash
    ? priorMap.revision
    : (Number.isInteger(priorMap?.revision) ? priorMap.revision : 0) + 1;
  const content = {
    version: 2,
    project_id: signature.project_id,
    revision,
    source_signature_hash: sourceSignatureHash,
    global_summary: {
      source_count: details.length,
      component_count: components.length,
      active_workstream_id: projectControlPlane?.active_workstream?.workstream_id || null,
      accepted_decision_count: Array.isArray(projectControlPlane?.decision_ledger)
        ? projectControlPlane.decision_ledger.length
        : 0,
    },
    components,
    details,
    delta: {
      changed_source_refs: changedRefs.sort(compareText),
      removed_source_refs: removedRefs.sort(compareText),
    },
    generated_at: generatedAt || new Date().toISOString(),
  };
  const mapIdentity = {
    version: content.version,
    project_id: content.project_id,
    revision: content.revision,
    source_signature_hash: content.source_signature_hash,
    global_summary: content.global_summary,
    components: content.components,
    details: content.details,
    delta: content.delta,
  };
  return Object.freeze({
    ...content,
    project_map_id: `PM-${canonicalHash(mapIdentity).slice(0, 16)}`,
  });
}

module.exports = {
  buildProjectMapV2,
  extractCodeMetadata,
  refreshSourceCatalogV2,
};
