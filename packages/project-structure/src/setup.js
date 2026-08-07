"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { assertContract, canonicalHash } = require("@orquesta/contracts");
const { normalizeRef } = require("./patterns");

const PROJECT_STRUCTURE_TEMPLATE_VERSION = "project-structure-v1";
const ARCHETYPES = Object.freeze(["software", "writing_world", "data_research", "asset_heavy"]);
const GENERATED_DIRECTORY_NAMES = new Set([
  ".git", ".orquesta", ".cache", ".next", ".turbo", "coverage", "dist", "dist-electron",
  "node_modules", "out", "output", "release", "target",
]);
const CODE_EXTENSIONS = new Set([".c", ".cjs", ".cpp", ".cs", ".go", ".h", ".java", ".js", ".jsx", ".mjs", ".php", ".py", ".rb", ".rs", ".swift", ".ts", ".tsx"]);
const DATA_EXTENSIONS = new Set([".arrow", ".csv", ".db", ".feather", ".ipynb", ".parquet", ".r", ".rmd", ".sql", ".tsv"]);
const ASSET_EXTENSIONS = new Set([".aac", ".avi", ".blend", ".flac", ".gif", ".glb", ".gltf", ".jpeg", ".jpg", ".m4a", ".mov", ".mp3", ".mp4", ".ogg", ".png", ".psd", ".svg", ".wav", ".webm", ".webp"]);

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim()))].sort(compareText);
}

function safeWorkspaceRoot(workspaceRoot) {
  if (typeof workspaceRoot !== "string" || !workspaceRoot) throw new TypeError("workspaceRoot is required");
  const root = fs.realpathSync(workspaceRoot);
  if (!fs.statSync(root).isDirectory()) throw new TypeError("workspaceRoot must be a directory");
  return root;
}

function inspectProjectStructureEvidence({ workspaceRoot, maxEntries = 384, maxDepth = 3 } = {}) {
  const root = safeWorkspaceRoot(workspaceRoot);
  const entries = [];
  const topLevelDirectories = new Set();
  const extensionCounts = {};

  function visit(directory, relativeDirectory, depth) {
    if (entries.length >= maxEntries || depth > maxDepth) return;
    const children = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => compareText(left.name.toLowerCase(), right.name.toLowerCase()));
    for (const child of children) {
      if (entries.length >= maxEntries) break;
      const reference = normalizeRef(relativeDirectory === "." ? child.name : `${relativeDirectory}/${child.name}`);
      if (child.isSymbolicLink()) continue;
      if (child.isDirectory()) {
        if (GENERATED_DIRECTORY_NAMES.has(child.name.toLowerCase())) continue;
        entries.push({ source_ref: reference, kind: "directory" });
        if (depth === 0) topLevelDirectories.add(child.name);
        visit(path.join(directory, child.name), reference, depth + 1);
        continue;
      }
      if (!child.isFile()) continue;
      const extension = path.posix.extname(reference).toLowerCase();
      entries.push({ source_ref: reference, kind: "file", extension });
      extensionCounts[extension || "(none)"] = (extensionCounts[extension || "(none)"] || 0) + 1;
    }
  }

  visit(root, ".", 0);
  return Object.freeze({
    workspace_root: root,
    bounded: entries.length >= maxEntries,
    max_entries: maxEntries,
    entries: Object.freeze(entries),
    source_refs: Object.freeze(entries.map((entry) => entry.source_ref)),
    top_level_directories: Object.freeze([...topLevelDirectories].sort(compareText)),
    extension_counts: Object.freeze(Object.fromEntries(Object.entries(extensionCounts).sort(([left], [right]) => compareText(left, right)))),
  });
}

function inferProjectArchetype({ evidence, description = "" } = {}) {
  if (!evidence || !Array.isArray(evidence.source_refs)) throw new TypeError("evidence is required");
  const refs = evidence.source_refs.map((reference) => reference.toLowerCase());
  const scores = Object.fromEntries(ARCHETYPES.map((archetype) => [archetype, { score: 0, evidence: [] }]));
  const add = (archetype, points, reason) => {
    scores[archetype].score += points;
    if (!scores[archetype].evidence.includes(reason)) scores[archetype].evidence.push(reason);
  };
  const hasRef = (pattern) => refs.some((reference) => pattern.test(reference));
  const countExtensions = (extensions) => Object.entries(evidence.extension_counts || {})
    .reduce((total, [extension, count]) => total + (extensions.has(extension) ? Number(count) : 0), 0);

  if (hasRef(/(?:^|\/)(?:package\.json|cargo\.toml|go\.mod|pyproject\.toml|requirements\.txt)$/u)) add("software", 6, "software_manifest");
  if (hasRef(/^(?:src|app|apps|packages|lib|crates)(?:\/|$)/u)) add("software", 5, "software_source_root");
  const codeCount = countExtensions(CODE_EXTENSIONS);
  if (codeCount > 0) add("software", Math.min(5, 1 + Math.floor(Math.log2(codeCount + 1))), `code_files:${codeCount}`);

  if (hasRef(/^(?:manuscript|chapters|world|worldbuilding|lore|characters|locations|timeline|novel(?:[_-]world)?|story)(?:\/|$)/u)) add("writing_world", 6, "writing_or_world_root");
  const markdownCount = Number(evidence.extension_counts?.[".md"] || 0);
  if (markdownCount >= 3) add("writing_world", Math.min(4, Math.floor(markdownCount / 3)), `markdown_volume:${markdownCount}`);

  if (hasRef(/^(?:data|datasets|notebooks|analysis|experiments)(?:\/|$)/u)) add("data_research", 6, "data_or_analysis_root");
  const dataCount = countExtensions(DATA_EXTENSIONS);
  if (dataCount > 0) add("data_research", Math.min(6, 2 + Math.floor(Math.log2(dataCount + 1))), `data_files:${dataCount}`);

  if (hasRef(/^(?:assets|art|images|sprites|audio|video|media|renders|exports)(?:\/|$)/u)) add("asset_heavy", 6, "asset_root");
  const assetCount = countExtensions(ASSET_EXTENSIONS);
  if (assetCount > 0) add("asset_heavy", Math.min(6, 2 + Math.floor(Math.log2(assetCount + 1))), `asset_files:${assetCount}`);

  const text = String(description || "").toLowerCase();
  const descriptionSignals = [
    ["software", /(?:software|application|\bapp\b|desktop|web|api|library|code|実装|開発|アプリ|システム)/u, "description:software"],
    ["writing_world", /(?:novel|story|manuscript|worldbuilding|lore|小説|物語|世界観|設定資料)/u, "description:writing_world"],
    ["data_research", /(?:dataset|analytics|analysis|research data|データ|分析|統計|研究)/u, "description:data_research"],
    ["asset_heavy", /(?:asset|illustration|animation|video|audio|sprite|画像|映像|音声|素材)/u, "description:asset_heavy"],
  ];
  for (const [archetype, pattern, reason] of descriptionSignals) {
    if (pattern.test(text)) add(archetype, 2, reason);
  }

  const candidates = ARCHETYPES.map((archetype) => ({ archetype, ...scores[archetype] }))
    .sort((left, right) => right.score - left.score || compareText(left.archetype, right.archetype));
  const top = candidates[0];
  const meaningful = candidates.filter((candidate) => candidate.score >= 4 && candidate.score >= Math.max(4, Math.floor(top.score * 0.55)));
  const archetype = top.score === 0 || meaningful.length > 1 ? "hybrid" : top.archetype;
  const confidence = top.score === 0 ? "low" : meaningful.length > 1 ? "mixed" : top.score >= 9 ? "high" : "medium";
  return Object.freeze({
    archetype,
    confidence,
    candidates: Object.freeze(candidates.map((candidate) => Object.freeze({
      archetype: candidate.archetype,
      score: candidate.score,
      evidence: Object.freeze([...candidate.evidence].sort(compareText)),
    }))),
  });
}

function component({ componentId, kind, roots, owner = null, lifecycle = "current", authority = "supporting", readPolicy = "task_candidate", include = ["**"], exclude = [] }) {
  return {
    component_id: componentId,
    kind,
    roots: uniqueStrings(roots.map(normalizeRef)),
    owner,
    default_lifecycle: lifecycle,
    default_authority: authority,
    default_read_policy: readPolicy,
    include: uniqueStrings(include),
    exclude: uniqueStrings(exclude),
  };
}

function normalizeSetupAnswers(values) {
  return (Array.isArray(values) ? values : []).map((answer) => ({
    question_id: String(answer.question_id ?? answer.questionId ?? "").trim(),
    answer: String(answer.answer ?? ""),
  })).filter((answer) => answer.question_id);
}

function hasRoot(evidence, root) {
  const normalized = root.toLowerCase();
  return (evidence.top_level_directories || []).some((directory) => directory.toLowerCase() === normalized);
}

function createComponents({ archetypeResult, evidence, isNewProject }) {
  const components = [];
  const usedRoots = new Set([".", ".orquesta", "workbench/inbox"]);
  const add = (definition) => {
    const roots = definition.roots.filter((root) => !usedRoots.has(normalizeRef(root)));
    if (!roots.length) return;
    for (const root of roots) usedRoots.add(normalizeRef(root));
    components.push(component({ ...definition, roots }));
  };

  components.push(component({
    componentId: "repository-entry",
    kind: "repository_metadata",
    roots: ["."],
    readPolicy: "bootstrap_candidate",
    include: ["README*", "*.md", "*.txt", "*.json", "*.toml", "*.yaml", "*.yml", "LICENSE*", ".gitignore", ".gitattributes"],
  }));
  components.push(component({
    componentId: "runtime-state",
    kind: "orchestration_state",
    roots: [".orquesta"],
    readPolicy: "explicit_only",
  }));
  components.push(component({
    componentId: "placement-inbox",
    kind: "task_scoped_staging",
    roots: ["workbench/inbox"],
    lifecycle: "draft",
    readPolicy: "explicit_only",
  }));

  const activeArchetypes = archetypeResult.archetype === "hybrid"
    ? archetypeResult.candidates.filter((candidate) => candidate.score >= 4).map((candidate) => candidate.archetype)
    : [archetypeResult.archetype];
  const effectiveArchetypes = activeArchetypes;

  if (effectiveArchetypes.includes("software")) {
    if (hasRoot(evidence, "apps")) add({ componentId: "applications", kind: "application", roots: ["apps"], exclude: ["**/node_modules/**", "**/dist/**", "**/coverage/**"] });
    if (hasRoot(evidence, "packages")) add({ componentId: "libraries", kind: "software_modules", roots: ["packages"], exclude: ["**/node_modules/**", "**/dist/**", "**/coverage/**"] });
    const sourceRoots = ["src", "app", "lib", "crates"].filter((root) => hasRoot(evidence, root));
    if (sourceRoots.length) add({ componentId: "application-code", kind: "source_code", roots: sourceRoots, exclude: ["**/node_modules/**", "**/dist/**"] });
    else if (isNewProject) add({ componentId: "application-code", kind: "source_code", roots: ["src"] });
    const testRoots = ["test", "tests"].filter((root) => hasRoot(evidence, root));
    if (testRoots.length) add({ componentId: "tests", kind: "verification", roots: testRoots, readPolicy: "explicit_only" });
  }

  if (effectiveArchetypes.includes("writing_world")) {
    const manuscriptRoots = ["manuscript", "chapters", "novel", "story"].filter((root) => hasRoot(evidence, root));
    if (manuscriptRoots.length) add({ componentId: "manuscript", kind: "writing_manuscript", roots: manuscriptRoots });
    else if (isNewProject) add({ componentId: "manuscript", kind: "writing_manuscript", roots: ["manuscript"] });
    const canonRoots = ["world", "lore", "characters", "locations", "timeline"].filter((root) => hasRoot(evidence, root));
    if (canonRoots.length) add({ componentId: "world-canon", kind: "world_canon", roots: canonRoots, authority: "canonical" });
    if (hasRoot(evidence, "drafts")) add({ componentId: "writing-drafts", kind: "writing_draft", roots: ["drafts"], lifecycle: "draft" });
  }

  if (effectiveArchetypes.includes("data_research")) {
    const dataRoots = ["data", "datasets"].filter((root) => hasRoot(evidence, root));
    if (dataRoots.length) add({ componentId: "project-data", kind: "data", roots: dataRoots, readPolicy: "explicit_only" });
    else if (isNewProject) add({ componentId: "project-data", kind: "data", roots: ["data"], readPolicy: "explicit_only" });
    if (hasRoot(evidence, "notebooks")) add({ componentId: "notebooks", kind: "analysis_notebook", roots: ["notebooks"], readPolicy: "explicit_only" });
    if (hasRoot(evidence, "analysis")) add({ componentId: "analysis", kind: "analysis_code", roots: ["analysis"] });
  }

  if (effectiveArchetypes.includes("asset_heavy")) {
    const assetRoots = ["assets", "art", "images", "sprites", "audio", "video", "media"].filter((root) => hasRoot(evidence, root));
    if (assetRoots.length) add({ componentId: "source-assets", kind: "source_asset", roots: assetRoots, readPolicy: "explicit_only" });
    else if (isNewProject) add({ componentId: "source-assets", kind: "source_asset", roots: ["assets"], readPolicy: "explicit_only" });
    const exportRoots = ["exports", "renders"].filter((root) => hasRoot(evidence, root));
    if (exportRoots.length) add({ componentId: "asset-exports", kind: "asset_export", roots: exportRoots, authority: "derived", readPolicy: "explicit_only" });
  }

  if (hasRoot(evidence, "docs")) add({ componentId: "project-docs", kind: "documentation", roots: ["docs"] });
  if (hasRoot(evidence, "research")) add({ componentId: "research", kind: "research", roots: ["research"], readPolicy: "explicit_only" });
  if (hasRoot(evidence, "reports")) add({ componentId: "reports", kind: "report", roots: ["reports"], readPolicy: "explicit_only" });
  if (hasRoot(evidence, "tools")) add({ componentId: "tooling", kind: "development_tooling", roots: ["tools"] });
  if (hasRoot(evidence, "scripts")) add({ componentId: "scripts", kind: "development_tooling", roots: ["scripts"] });

  if (isNewProject && components.every((item) => ["repository-entry", "runtime-state", "placement-inbox"].includes(item.component_id))) {
    add({ componentId: "project-content", kind: "project_content", roots: ["project"] });
  }

  const uncovered = (evidence.top_level_directories || [])
    .filter((root) => !GENERATED_DIRECTORY_NAMES.has(root.toLowerCase()))
    .filter((root) => !usedRoots.has(normalizeRef(root)));
  if (uncovered.length) add({ componentId: "existing-project-content", kind: "project_content", roots: uncovered });
  return components;
}

function lifecycleRegistry(updatedAt, entryRef = null) {
  const claims = [
    { claim_key: "orquesta.project.structure.layout", source_ref: ".orquesta/project/layout.json" },
    { claim_key: "orquesta.project.structure.lifecycle", source_ref: ".orquesta/project/lifecycle.json" },
    { claim_key: "orquesta.project.structure.setup", source_ref: ".orquesta/project/structure-setup.json" },
  ];
  if (entryRef) claims.push({ claim_key: "project.entry", source_ref: entryRef });
  return {
    schema_version: 1,
    status: "draft",
    rules: [
      {
        rule_id: "generated-roots",
        match: ["**/node_modules/**", "**/dist/**", "**/dist-electron/**", "**/out/**", "**/output/**", "**/release/**", "**/coverage/**", "**/.cache/**"],
        lifecycle: "current",
        authority: "derived",
        read_policy: "never",
        storage_policy: "gitignored",
        reason: "Generated and dependency content is excluded from normal project context.",
      },
      {
        rule_id: "canonical-orquesta-state",
        match: [".orquesta/state/*.json", ".orquesta/state/*.jsonl", ".orquesta/setup/*.json", ".orquesta/project/*.json", ".orquesta/user_tasks/*.json", ".orquesta/failures/*.json", ".orquesta/vision/*.json"],
        lifecycle: "current",
        authority: "canonical",
        read_policy: "task_candidate",
        storage_policy: "versioned",
        reason: "File-backed Orquesta project state.",
      },
      {
        rule_id: "derived-orquesta-state",
        match: [".orquesta/project/derived/**", ".orquesta/context/shadow/**"],
        lifecycle: "current",
        authority: "derived",
        read_policy: "never",
        storage_policy: "ephemeral",
        reason: "Reconstructed structure and context artifacts do not enter normal task context.",
      },
      {
        rule_id: "placement-inbox",
        match: ["workbench/inbox/**"],
        lifecycle: "draft",
        authority: "supporting",
        read_policy: "explicit_only",
        storage_policy: "versioned",
        reason: "Unresolved task outputs remain isolated until their component is known.",
      },
    ],
    overrides: [],
    canonical_claims: claims,
    updated_at: updatedAt,
  };
}

function createProjectStructureSetupPlan({
  projectId,
  projectName,
  description = "",
  sourceKind = "detected_root",
  setupAnswers = [],
  evidence,
  generatedAt,
} = {}) {
  if (!projectId || !projectName || !evidence || !generatedAt) throw new TypeError("projectId, projectName, evidence, and generatedAt are required");
  const nonOrquestaFiles = evidence.entries.filter((entry) => entry.kind === "file");
  const isNewProject = sourceKind === "new_project" || (sourceKind === "detected_root" && nonOrquestaFiles.length === 0);
  const archetypeResult = inferProjectArchetype({ evidence, description });
  const components = createComponents({ archetypeResult, evidence, isNewProject });
  const readmeRef = evidence.source_refs.find((reference) => /^readme(?:\.[^/]+)?$/iu.test(reference)) || (isNewProject ? "README.md" : null);
  const layout = assertContract("project-layout", {
    schema_version: 1,
    status: "draft",
    project_id: projectId,
    project_kind: archetypeResult.archetype,
    components,
    generated_roots: ["**/node_modules/**", "**/dist/**", "**/dist-electron/**", "**/out/**", "**/output/**", "**/release/**", "**/coverage/**", "**/.cache/**"],
    external_storage_roots: [],
    updated_at: generatedAt,
  });
  const lifecycle = assertContract("lifecycle-registry", lifecycleRegistry(generatedAt, readmeRef));
  const primaryDirectory = isNewProject
    ? components.find((item) => !["repository-entry", "runtime-state", "placement-inbox"].includes(item.component_id))?.roots[0] || null
    : null;
  const physicalChanges = {
    created_directories: primaryDirectory ? [primaryDirectory] : [],
    created_files: readmeRef === "README.md" ? ["README.md"] : [],
    moved_paths: [],
  };
  const setup = assertContract("project-structure-setup", {
    schema_version: 1,
    template_version: PROJECT_STRUCTURE_TEMPLATE_VERSION,
    status: "ready",
    mode: isNewProject ? "new_minimal" : "existing_shadow",
    project_id: projectId,
    source_kind: sourceKind,
    archetype: archetypeResult.archetype,
    archetype_candidates: archetypeResult.candidates,
    setup_answers: normalizeSetupAnswers(setupAnswers),
    manifests: {
      layout_ref: ".orquesta/project/layout.json",
      lifecycle_ref: ".orquesta/project/lifecycle.json",
      manifest_source: "generated",
    },
    physical_changes: physicalChanges,
    created_at: generatedAt,
    updated_at: generatedAt,
  });
  const entryContent = readmeRef === "README.md" ? [
    `# ${String(projectName).trim()}`,
    "",
    String(description || "Project initialized with Orquesta.").trim() || "Project initialized with Orquesta.",
    "",
  ].join("\n") : null;
  return Object.freeze({
    layout: Object.freeze(layout),
    lifecycle: Object.freeze(lifecycle),
    setup: Object.freeze(setup),
    entry: entryContent ? Object.freeze({ source_ref: "README.md", content: entryContent }) : null,
    evidence,
  });
}

function createPreservedProjectStructureSetup({
  projectId,
  sourceKind = "existing_folder",
  archetypeResult,
  setupAnswers = [],
  previousSetup = null,
  generatedAt,
} = {}) {
  if (!projectId || !archetypeResult || !generatedAt) throw new TypeError("projectId, archetypeResult, and generatedAt are required");
  const previous = previousSetup && typeof previousSetup === "object" ? previousSetup : null;
  const archetype = archetypeResult.archetype === "hybrid_software_product" ? "hybrid" : archetypeResult.archetype;
  return assertContract("project-structure-setup", {
    schema_version: 1,
    template_version: previous?.template_version || PROJECT_STRUCTURE_TEMPLATE_VERSION,
    status: "ready",
    mode: previous?.mode || "existing_shadow",
    project_id: projectId,
    source_kind: previous?.source_kind || sourceKind,
    archetype: previous?.archetype || archetype,
    archetype_candidates: previous?.archetype_candidates || archetypeResult.candidates,
    setup_answers: normalizeSetupAnswers(setupAnswers.length ? setupAnswers : previous?.setup_answers),
    manifests: {
      layout_ref: ".orquesta/project/layout.json",
      lifecycle_ref: ".orquesta/project/lifecycle.json",
      manifest_source: previous?.manifests?.manifest_source || "preserved",
    },
    physical_changes: previous?.physical_changes || {
      created_directories: [],
      created_files: [],
      moved_paths: [],
    },
    created_at: previous?.created_at || generatedAt,
    updated_at: generatedAt,
  });
}

function extendProjectStructureComponents({ layout, components, updatedAt = new Date().toISOString() } = {}) {
  const current = assertContract("project-layout", layout);
  const additions = Array.isArray(components) ? components : [];
  if (!additions.length) return current;
  const ids = new Set(current.components.map((item) => item.component_id));
  const normalized = additions.map((item) => component({
    componentId: item.component_id,
    kind: item.kind,
    roots: item.roots,
    owner: item.owner ?? null,
    lifecycle: item.default_lifecycle || "current",
    authority: item.default_authority || "supporting",
    readPolicy: item.default_read_policy || "task_candidate",
    include: Array.isArray(item.include) ? item.include : ["**"],
    exclude: Array.isArray(item.exclude) ? item.exclude : [],
  }));
  for (const addition of normalized) {
    if (ids.has(addition.component_id)) throw new Error(`component already exists: ${addition.component_id}`);
    ids.add(addition.component_id);
  }
  return assertContract("project-layout", {
    ...current,
    components: [...current.components, ...normalized],
    updated_at: updatedAt,
  });
}

function createInitialStructureContextView({ layout, setup, inventory, projection, audit, goal = "", generatedAt } = {}) {
  const projectLayout = assertContract("project-layout", layout);
  const setupRecord = assertContract("project-structure-setup", setup);
  if (!inventory || !projection || !audit || !generatedAt) throw new TypeError("inventory, projection, audit, and generatedAt are required");
  const candidateRefs = new Set(projection.selected.map((item) => item.source_ref));
  const components = projectLayout.components.map((item) => {
    const files = inventory.files.filter((file) => file.component_id === item.component_id);
    return {
      component_id: item.component_id,
      kind: item.kind,
      roots: [...item.roots],
      indexed_sources: files.length,
      candidate_sources: files.filter((file) => candidateRefs.has(file.source_ref)).length,
    };
  });
  const content = {
    version: 1,
    project_id: projectLayout.project_id,
    template_version: setupRecord.template_version,
    archetype: setupRecord.archetype,
    setup_mode: setupRecord.mode,
    goal: String(goal || "").trim(),
    components,
    sources: {
      indexed_count: inventory.stats.indexed_files,
      candidate_count: projection.stats.selected_files,
      excluded_count: projection.stats.excluded_files,
      candidate_source_refs: projection.selected.map((item) => item.source_ref).slice(0, 24),
    },
    warnings: audit.issues
      .filter((issue) => issue.severity !== "suggestion")
      .map((issue) => issue.code)
      .slice(0, 12),
    generated_at: generatedAt,
  };
  const identity = { ...content };
  delete identity.generated_at;
  return assertContract("project-structure-context-view", {
    ...content,
    view_id: `PSCV-${canonicalHash(identity).slice(0, 16)}`,
  });
}

module.exports = {
  PROJECT_STRUCTURE_TEMPLATE_VERSION,
  createInitialStructureContextView,
  createPreservedProjectStructureSetup,
  createProjectStructureSetupPlan,
  extendProjectStructureComponents,
  inferProjectArchetype,
  inspectProjectStructureEvidence,
  normalizeSetupAnswers,
};
