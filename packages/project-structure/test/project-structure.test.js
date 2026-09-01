"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { assertContract } = require("@orquesta/contracts");
const {
  auditProjectStructure,
  classifyReference,
  createProjectStructureMigrationPlan,
  createProjectStructureSetupPlan,
  createLifecycleContextReceipt,
  createLifecycleProjection,
  createLifecycleReadBoundary,
  createCompactProjectMapView,
  inspectTaskPlacementCompletion,
  enrichProjectMapWithLifecycle,
  extendProjectStructureComponents,
  inferProjectArchetype,
  inspectProjectStructureEvidence,
  matchesGlob,
  scanProjectStructure,
  resolvePlacement,
} = require("../src");

const NOW = "2026-08-01T00:00:00.000Z";

function layout() {
  return {
    schema_version: 1,
    status: "draft",
    project_id: "fixture",
    project_kind: "hybrid",
    components: [
      {
        component_id: "source",
        kind: "application",
        roots: ["src"],
        owner: "implementation",
        default_lifecycle: "current",
        default_authority: "supporting",
        default_read_policy: "task_candidate",
        include: ["**"],
        exclude: [],
      },
      {
        component_id: "history",
        kind: "documentation",
        roots: ["history"],
        owner: null,
        default_lifecycle: "superseded",
        default_authority: "supporting",
        default_read_policy: "explicit_only",
        include: ["**"],
        exclude: [],
      },
    ],
    generated_roots: ["out/**"],
    external_storage_roots: [],
    updated_at: NOW,
  };
}

function lifecycle() {
  return {
    schema_version: 1,
    status: "draft",
    rules: [
      {
        rule_id: "generated-output",
        match: ["out/**"],
        lifecycle: "current",
        authority: "derived",
        read_policy: "never",
        storage_policy: "gitignored",
        reason: "regenerated output",
      },
    ],
    overrides: [],
    canonical_claims: [{ claim_key: "fixture.entry", source_ref: "src/app.js" }],
    updated_at: NOW,
  };
}

function placementLayout(projectKind, componentId, root) {
  const value = layout();
  value.project_kind = projectKind;
  value.components = [{
    component_id: componentId,
    kind: `${projectKind}_component`,
    roots: [root],
    owner: null,
    default_lifecycle: "current",
    default_authority: "supporting",
    default_read_policy: "task_candidate",
    include: ["**"],
    exclude: [],
  }, {
    component_id: "placement-inbox",
    kind: "task_scoped_staging",
    roots: ["workbench/inbox"],
    owner: null,
    default_lifecycle: "draft",
    default_authority: "supporting",
    default_read_policy: "explicit_only",
    include: ["**"],
    exclude: [],
  }];
  return value;
}

function placementLifecycle() {
  return {
    schema_version: 1,
    status: "draft",
    rules: [{
      rule_id: "placement-inbox",
      match: ["workbench/inbox/**"],
      lifecycle: "draft",
      authority: "supporting",
      read_policy: "explicit_only",
      storage_policy: "versioned",
      reason: "Task-scoped unresolved output.",
    }],
    overrides: [],
    canonical_claims: [],
    updated_at: NOW,
  };
}

function placementRequest(overrides = {}) {
  return {
    version: 1,
    task_id: "TASK-PLACE",
    proposed_path: null,
    suggested_name: "artifact.md",
    target_component_id: "component",
    artifact_kind: "project_artifact",
    authority_intent: "supporting",
    audience: "mixed",
    retention: "project",
    replaces: [],
    claim_key: null,
    root_placement_reason: null,
    created_at: NOW,
    ...overrides,
  };
}

test("layout and lifecycle contracts validate independently of Context V2", () => {
  assert.doesNotThrow(() => assertContract("project-layout", layout()));
  assert.doesNotThrow(() => assertContract("lifecycle-registry", lifecycle()));
});

test("glob matching covers recursive generated roots without treating sibling paths as matches", () => {
  assert.equal(matchesGlob("benchmarks/demo/workspaces", "benchmarks/**/workspaces/**"), true);
  assert.equal(matchesGlob("benchmarks/demo/workspaces/run/file.json", "benchmarks/**/workspaces/**"), true);
  assert.equal(matchesGlob("benchmarks/demo/reports/file.json", "benchmarks/**/workspaces/**"), false);
});

test("shadow inventory classifies current, superseded, generated, and unclassified sources", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-structure-"));
  try {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.mkdirSync(path.join(root, "history"), { recursive: true });
    fs.mkdirSync(path.join(root, "out", "cache"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "app.js"), "export const app = true;\n", "utf8");
    fs.writeFileSync(path.join(root, "history", "v1.md"), "# old\n", "utf8");
    fs.writeFileSync(path.join(root, "out", "cache", "result.json"), "{}\n", "utf8");
    fs.writeFileSync(path.join(root, "loose.md"), "# loose\n", "utf8");
    const inventory = scanProjectStructure({
      workspaceRoot: root,
      layout: layout(),
      lifecycleRegistry: lifecycle(),
      generatedAt: NOW,
    });
    assert.equal(inventory.files.some((file) => file.source_ref.startsWith("out/")), false);
    assert.equal(inventory.skipped.some((entry) => entry.source_ref === "out"), true);
    assert.equal(inventory.files.find((file) => file.source_ref === "src/app.js").authority, "canonical");
    assert.equal(inventory.files.find((file) => file.source_ref === "history/v1.md").lifecycle, "superseded");
    assert.equal(inventory.files.find((file) => file.source_ref === "loose.md").read_policy, "explicit_only");
    const projection = createLifecycleProjection(inventory);
    assert.deepEqual(projection.selected.map((file) => file.source_ref), ["src/app.js"]);
    assert.ok(projection.excluded.some((file) => file.source_ref === "history/v1.md" && file.reason === "superseded"));
    const audit = auditProjectStructure({ inventory, layout: layout(), lifecycleRegistry: lifecycle() });
    assert.equal(audit.blocked, false);
    assert.ok(audit.issues.some((entry) => entry.code === "unclassified_sources"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("canonical claim conflicts are hard errors while duplicate content is only a suggestion", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-structure-claims-"));
  try {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "app.js"), "same\n", "utf8");
    fs.writeFileSync(path.join(root, "src", "copy.js"), "same\n", "utf8");
    const registry = lifecycle();
    registry.canonical_claims.push({ claim_key: "fixture.entry", source_ref: "src/copy.js" });
    const inventory = scanProjectStructure({
      workspaceRoot: root,
      layout: layout(),
      lifecycleRegistry: registry,
      generatedAt: NOW,
    });
    const audit = auditProjectStructure({ inventory, layout: layout(), lifecycleRegistry: registry });
    assert.equal(audit.blocked, true);
    assert.ok(audit.issues.some((entry) => entry.code === "canonical_claim_conflict" && entry.severity === "error"));
    assert.ok(audit.issues.some((entry) => entry.code === "duplicate_current_content" && entry.severity === "suggestion"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("classifyReference rejects project escapes", () => {
  assert.throws(() => classifyReference("../outside.txt", layout(), lifecycle()), /escapes the project/u);
});

test("Context V2 shadow boundary excludes lifecycle-ineligible sources with durable reasons", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-structure-context-"));
  try {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.mkdirSync(path.join(root, "history"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "app.js"), "export const app = true;\n", "utf8");
    fs.writeFileSync(path.join(root, "history", "v1.md"), "# old\n", "utf8");
    const inventory = scanProjectStructure({
      workspaceRoot: root,
      layout: layout(),
      lifecycleRegistry: lifecycle(),
      generatedAt: NOW,
    });
    const projection = createLifecycleProjection(inventory);
    const audit = auditProjectStructure({ inventory, layout: layout(), lifecycleRegistry: lifecycle() });
    const boundary = createLifecycleReadBoundary({
      inventory,
      projection,
      audit,
      previousRecords: [{ source_ref: "history/v1.md", status: "current" }],
    });
    assert.deepEqual(boundary.effective_source_refs, ["src/app.js"]);
    assert.equal(boundary.eligible_previous_records.length, 0);
    assert.deepEqual(boundary.exclusions[0], {
      source_ref: "history/v1.md",
      reason: "superseded",
      component_id: "history",
      lifecycle: "superseded",
      authority: "supporting",
      read_policy: "explicit_only",
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("canonical conflicts block effective reads and appear in the lifecycle receipt", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-structure-context-blocked-"));
  try {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "app.js"), "one\n", "utf8");
    fs.writeFileSync(path.join(root, "src", "copy.js"), "two\n", "utf8");
    const registry = lifecycle();
    registry.canonical_claims.push({ claim_key: "fixture.entry", source_ref: "src/copy.js" });
    const inventory = scanProjectStructure({ workspaceRoot: root, layout: layout(), lifecycleRegistry: registry, generatedAt: NOW });
    const projection = createLifecycleProjection(inventory);
    const audit = auditProjectStructure({ inventory, layout: layout(), lifecycleRegistry: registry });
    const boundary = createLifecycleReadBoundary({ inventory, projection, audit });
    const receipt = createLifecycleContextReceipt({ boundary, projection, createdAt: NOW });
    assert.equal(boundary.status, "blocked");
    assert.deepEqual(boundary.effective_source_refs, []);
    assert.equal(receipt.status, "blocked");
    assert.equal(receipt.canonical_claim_errors[0].code, "canonical_claim_conflict");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Project Map lifecycle overlay summarizes arbitrary manifest components without role rules", () => {
  const inventory = {
    project_id: "fixture",
    generated_at: NOW,
    stats: { indexed_files: 2 },
    files: [
      { source_ref: "world/city.md", component_id: "world-lore", lifecycle: "current", authority: "canonical", read_policy: "task_candidate" },
      { source_ref: "world/old.md", component_id: "world-lore", lifecycle: "superseded", authority: "supporting", read_policy: "explicit_only" },
    ],
  };
  const projection = {
    selected: [{ source_ref: "world/city.md" }],
    excluded: [{ source_ref: "world/old.md", reason: "superseded" }],
    stats: { selected_files: 1, excluded_files: 1, selected_token_estimate: 20 },
  };
  const projectMap = {
    project_map_id: "PM-aaaaaaaaaaaaaaaa",
    global_summary: { source_count: 1, component_count: 1 },
  };
  const result = enrichProjectMapWithLifecycle({ projectMap, inventory, projection, audit: { blocked: false } });
  assert.equal(result.lifecycle_summary.components[0].component_id, "world-lore");
  assert.equal(result.lifecycle_summary.components[0].candidate_sources, 1);
  assert.equal(result.lifecycle_summary.components[0].excluded_sources, 1);
  assert.match(result.lifecycle_overlay_id, /^LO-[a-f0-9]{16}$/u);
  const view = createCompactProjectMapView({
    ...result,
    project_id: "fixture",
    revision: 1,
    generated_at: NOW,
    components: [{
      component: "world",
      source_count: 1,
      artifact_types: ["documentation"],
      source_refs: ["world/city.md"],
      dependency_refs: [],
      summary: "1 sources; documentation",
    }],
  });
  assert.equal(view.components[0].source_refs, undefined);
  assert.equal(view.lifecycle_components[0].component_id, "world-lore");
  assert.match(view.project_map_view_id, /^PMV-[a-f0-9]{16}$/u);
});

test("Placement Resolver uses declared components for software, writing, and data without role names", () => {
  const cases = [
    { kind: "software", component: "application-code", root: "src", name: "feature.ts" },
    { kind: "writing_world", component: "world-canon", root: "world", name: "harbor-city.md" },
    { kind: "data_research", component: "curated-data", root: "data/curated", name: "observations.csv" },
  ];
  for (const entry of cases) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `orquesta-placement-${entry.kind}-`));
    try {
      fs.mkdirSync(path.join(root, ...entry.root.split("/")), { recursive: true });
      const projectLayout = placementLayout(entry.kind, entry.component, entry.root);
      const registry = placementLifecycle();
      const inventory = scanProjectStructure({ workspaceRoot: root, layout: projectLayout, lifecycleRegistry: registry, generatedAt: NOW });
      const audit = auditProjectStructure({ inventory, layout: projectLayout, lifecycleRegistry: registry });
      const decision = resolvePlacement({
        workspaceRoot: root,
        layout: projectLayout,
        lifecycleRegistry: registry,
        inventory,
        audit,
        request: placementRequest({ target_component_id: entry.component, suggested_name: entry.name }),
      });
      assert.equal(decision.status, "proposed", entry.kind);
      assert.equal(decision.target_path, `${entry.root}/${entry.name}`, entry.kind);
      assert.equal(decision.component_id, entry.component, entry.kind);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("unknown placement stays in a task inbox while a project escape is blocked", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-placement-boundary-"));
  try {
    const projectLayout = placementLayout("software", "application-code", "src");
    const registry = placementLifecycle();
    const inventory = scanProjectStructure({ workspaceRoot: root, layout: projectLayout, lifecycleRegistry: registry, generatedAt: NOW });
    const audit = auditProjectStructure({ inventory, layout: projectLayout, lifecycleRegistry: registry });
    const inbox = resolvePlacement({
      workspaceRoot: root,
      layout: projectLayout,
      lifecycleRegistry: registry,
      inventory,
      audit,
      request: placementRequest({ target_component_id: "unknown", suggested_name: "idea.md" }),
    });
    assert.equal(inbox.status, "inbox");
    assert.equal(inbox.target_path, "workbench/inbox/TASK-PLACE/idea.md");
    assert.equal(inbox.warnings[0].code, "unknown_target_component");
    const blocked = resolvePlacement({
      workspaceRoot: root,
      layout: projectLayout,
      lifecycleRegistry: registry,
      inventory,
      audit,
      request: placementRequest({ target_component_id: "application-code", proposed_path: "../outside.md" }),
    });
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.target_path, null);
    assert.equal(blocked.hard_errors[0].code, "project_write_escape");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("canonical claim and same-name files become supersedes candidates without automatic retirement", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-placement-supersedes-"));
  try {
    fs.mkdirSync(path.join(root, "world"), { recursive: true });
    fs.writeFileSync(path.join(root, "world", "city-v1.md"), "# old city\n", "utf8");
    const projectLayout = placementLayout("writing_world", "world-canon", "world");
    const registry = placementLifecycle();
    registry.canonical_claims.push({ claim_key: "world.city.canon", source_ref: "world/city-v1.md" });
    const inventory = scanProjectStructure({ workspaceRoot: root, layout: projectLayout, lifecycleRegistry: registry, generatedAt: NOW });
    const audit = auditProjectStructure({ inventory, layout: projectLayout, lifecycleRegistry: registry });
    const decision = resolvePlacement({
      workspaceRoot: root,
      layout: projectLayout,
      lifecycleRegistry: registry,
      inventory,
      audit,
      request: placementRequest({
        target_component_id: "world-canon",
        proposed_path: "world/city-v2.md",
        suggested_name: "city-v2.md",
        authority_intent: "canonical_update",
        claim_key: "world.city.canon",
      }),
    });
    assert.equal(decision.status, "proposed");
    assert.deepEqual(decision.supersedes, []);
    assert.ok(decision.supersedes_candidates.some((candidate) => (
      candidate.source_ref === "world/city-v1.md" && candidate.confidence === "high"
    )));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("completion hook warns on unresolved outputs but blocks only hard project boundaries", () => {
  const projectLayout = placementLayout("software", "application-code", "src");
  const registry = placementLifecycle();
  const warning = inspectTaskPlacementCompletion({
    taskId: "TASK-PLACE",
    changedPaths: ["workbench/inbox/TASK-PLACE/draft.md", "loose.md"],
    layout: projectLayout,
    lifecycleRegistry: registry,
    audit: { issues: [] },
    checkedAt: NOW,
  });
  assert.equal(warning.status, "warnings");
  assert.ok(warning.warnings.some((entry) => entry.code === "unresolved_placement_inbox"));
  assert.ok(warning.warnings.some((entry) => entry.code === "unclassified_task_output"));
  const blocked = inspectTaskPlacementCompletion({
    taskId: "TASK-PLACE",
    changedPaths: ["C:\\outside.txt"],
    layout: projectLayout,
    lifecycleRegistry: registry,
    audit: { issues: [] },
    checkedAt: NOW,
  });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.hard_errors[0].code, "project_write_escape");
});

test("archetype inference uses project structure as primary evidence across unrelated project kinds", () => {
  const fixtures = [
    {
      expected: "software",
      files: { "package.json": "{}", "src/app.ts": "export const app = true;\n" },
    },
    {
      expected: "writing_world",
      files: { "manuscript/chapter-1.md": "# Chapter 1\n", "world/city.md": "# City\n" },
    },
    {
      expected: "data_research",
      files: { "data/source.csv": "id,value\n1,2\n", "notebooks/study.ipynb": "{}" },
    },
    {
      expected: "asset_heavy",
      files: { "assets/hero.png": "image", "audio/theme.wav": "audio" },
    },
  ];
  for (const fixture of fixtures) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `orquesta-archetype-${fixture.expected}-`));
    try {
      for (const [reference, content] of Object.entries(fixture.files)) {
        const target = path.join(root, ...reference.split("/"));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content, "utf8");
      }
      const evidence = inspectProjectStructureEvidence({ workspaceRoot: root });
      assert.equal(inferProjectArchetype({ evidence }).archetype, fixture.expected);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("new setup plan stays minimal while existing setup is shadow-only", () => {
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-setup-plan-new-"));
  const existingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-setup-plan-existing-"));
  try {
    fs.mkdirSync(path.join(existingRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(existingRoot, "package.json"), "{}\n", "utf8");
    fs.writeFileSync(path.join(existingRoot, "src", "index.js"), "module.exports = {};\n", "utf8");
    const fresh = createProjectStructureSetupPlan({
      projectId: "new-project",
      projectName: "New Project",
      description: "Build a desktop app.",
      sourceKind: "new_project",
      setupAnswers: [{ questionId: "SETUP-Q1", answer: "Ship the first screen." }],
      evidence: inspectProjectStructureEvidence({ workspaceRoot: emptyRoot }),
      generatedAt: NOW,
    });
    assert.equal(fresh.setup.mode, "new_minimal");
    assert.equal(fresh.setup.archetype, "software");
    assert.deepEqual(fresh.setup.physical_changes.moved_paths, []);
    assert.equal(fresh.setup.physical_changes.created_files.length, 1);
    assert.equal(fresh.setup.physical_changes.created_directories.length, 1);
    assert.equal(fresh.setup.setup_answers[0].question_id, "SETUP-Q1");

    const existing = createProjectStructureSetupPlan({
      projectId: "existing-project",
      projectName: "Existing Project",
      sourceKind: "existing_folder",
      evidence: inspectProjectStructureEvidence({ workspaceRoot: existingRoot }),
      generatedAt: NOW,
    });
    assert.equal(existing.setup.mode, "existing_shadow");
    assert.deepEqual(existing.setup.physical_changes, { created_directories: [], created_files: [], moved_paths: [] });
    assert.ok(existing.layout.components.some((item) => item.roots.includes("src")));
  } finally {
    fs.rmSync(emptyRoot, { recursive: true, force: true });
    fs.rmSync(existingRoot, { recursive: true, force: true });
  }
});

test("layout can grow with a later arbitrary component without rebuilding existing components", () => {
  const current = layout();
  const extended = extendProjectStructureComponents({
    layout: current,
    components: [{
      component_id: "world-visualization",
      kind: "visualization_reference",
      roots: ["visual/world"],
      owner: null,
      default_lifecycle: "current",
      default_authority: "supporting",
      default_read_policy: "task_candidate",
      include: ["**"],
      exclude: [],
    }],
    updatedAt: "2026-08-01T00:01:00.000Z",
  });
  assert.deepEqual(extended.components.slice(0, current.components.length), current.components);
  assert.equal(extended.components.at(-1).component_id, "world-visualization");
  assert.throws(() => extendProjectStructureComponents({
    layout: extended,
    components: [extended.components.at(-1)],
  }), /component already exists/u);
});

test("migration planner produces a reversible dry-run with reference rewrites and no physical change", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-migration-plan-"));
  try {
    fs.mkdirSync(path.join(root, ".orquesta", "state"), { recursive: true });
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, ".orquesta", "state", "sessions.json.bak"), "backup\n", "utf8");
    fs.writeFileSync(path.join(root, "src", "readme.md"), "See .orquesta/state/sessions.json.bak\n", "utf8");
    const projectLayout = layout();
    projectLayout.components.push({
      component_id: "runtime-state",
      kind: "orchestration_state",
      roots: [".orquesta"],
      owner: null,
      default_lifecycle: "current",
      default_authority: "supporting",
      default_read_policy: "task_candidate",
      include: ["**"],
      exclude: [],
    });
    const registry = lifecycle();
    const inventory = scanProjectStructure({ workspaceRoot: root, layout: projectLayout, lifecycleRegistry: registry, generatedAt: NOW });
    const audit = {
      issues: [{
        severity: "warning",
        code: "runtime_ephemeral_next_to_canonical_state",
        message: "Runtime backup beside canonical state.",
        source_refs: [".orquesta/state/sessions.json.bak"],
      }],
    };
    const plan = createProjectStructureMigrationPlan({
      workspaceRoot: root,
      layout: projectLayout,
      lifecycleRegistry: registry,
      inventory,
      audit,
      candidates: [{
        action: "quarantine",
        source_ref: ".orquesta/state/sessions.json.bak",
        reason: "Fixture checks an explicit reference rewrite.",
        confidence: "high",
        reference_policy: "rewrite",
      }],
      generatedAt: NOW,
      dirtyPathCount: 3,
    });
    assert.equal(plan.status, "review_required");
    assert.equal(plan.dry_run, true);
    assert.equal(plan.operations[0].action, "quarantine");
    assert.equal(plan.operations[0].status, "planned");
    assert.match(plan.operations[0].target_ref, /^\.orquesta\/archive\/structure-migrations\/PSMP-/u);
    assert.equal(plan.reference_rewrites[0].referrer, "src/readme.md");
    assert.equal(plan.reference_rewrites[0].occurrence_count, 1);
    assert.equal(plan.rollback.reversible, true);
    assert.equal(plan.rollback.steps[0].target_ref, ".orquesta/state/sessions.json.bak");
    assert.equal(plan.approval.required, true);
    assert.equal(fs.existsSync(path.join(root, ".orquesta", "state", "sessions.json.bak")), true);
    assert.equal(fs.existsSync(path.join(root, ".orquesta", "archive")), false);
    assert.doesNotThrow(() => assertContract("project-structure-migration-plan", plan));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("migration planner blocks project escapes and never auto-retires duplicate content", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-migration-boundary-"));
  try {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "one.md"), "same\n", "utf8");
    fs.writeFileSync(path.join(root, "src", "two.md"), "same\n", "utf8");
    const projectLayout = layout();
    const registry = lifecycle();
    const inventory = scanProjectStructure({ workspaceRoot: root, layout: projectLayout, lifecycleRegistry: registry, generatedAt: NOW });
    const plan = createProjectStructureMigrationPlan({
      workspaceRoot: root,
      layout: projectLayout,
      lifecycleRegistry: registry,
      inventory,
      audit: {
        issues: [{
          severity: "suggestion",
          code: "duplicate_current_content",
          message: "Duplicate bytes.",
          source_refs: ["src/one.md", "src/two.md"],
        }],
      },
      candidates: [{
        action: "move",
        source_ref: "src/one.md",
        target_ref: "../outside.md",
        reason: "Unsafe fixture.",
        confidence: "low",
      }],
      generatedAt: NOW,
    });
    assert.equal(plan.status, "blocked");
    assert.equal(plan.operations[0].status, "blocked");
    assert.equal(plan.operations.length, 1);
    assert.equal(plan.decisions[0].decision, "manual_review");
    assert.equal(plan.decisions[0].code, "duplicate_content_not_auto_retired");
    assert.equal(fs.existsSync(path.resolve(root, "..", "outside.md")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
