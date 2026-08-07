"use strict";

const assert = require("node:assert/strict");
const { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { execFile } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { promisify } = require("node:util");
const { routeContextForTask } = require("./context-v2-route");

const NOW = "2026-07-31T00:00:00.000Z";
const execFileAsync = promisify(execFile);

test("limited route activates only after four-way evidence and persists Desktop handoff data", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orquesta-context-route-"));
  try {
    const stateRoot = path.join(root, ".orquesta", "state");
    const setupRoot = path.join(root, ".orquesta", "setup");
    const contextRoot = path.join(root, ".orquesta", "context");
    await Promise.all([
      mkdir(stateRoot, { recursive: true }),
      mkdir(setupRoot, { recursive: true }),
      mkdir(path.join(contextRoot, "packs"), { recursive: true }),
    ]);
    const requirement = {
      status: "ready",
      decision_authority: "read_only",
      project_scope: "component",
      knowledge_domains: ["visual", "product"],
    };
    const profile = {
      context_requirement: requirement,
      context_pack_id: "CP2-123456789abc",
    };
    await writeFile(path.join(stateRoot, "tasks.json"), JSON.stringify({
      tasks: [{ task_id: "T1", task_profile: profile }],
    }), "utf8");
    await writeFile(path.join(setupRoot, "provisioning_batch.json"), JSON.stringify({
      requests: [{ task_id: "T1", task_profile: profile }],
    }), "utf8");
    await writeFile(path.join(contextRoot, "packs", "CP2-123456789abc.json"), JSON.stringify({
      context_pack_id: "CP2-123456789abc",
      fallback_reason: null,
      staleness: { state: "current" },
      budget_receipt: { mandatory_overflow: 0 },
      retrieval_permissions: { expand: true },
      selected_sources: ["SRC-123456789abc"],
    }), "utf8");
    await writeFile(path.join(contextRoot, "source_catalog.json"), JSON.stringify({
      records: [{ source_id: "SRC-123456789abc", source_ref: "src/app.js" }],
    }), "utf8");
    await writeFile(path.join(contextRoot, "variant_comparison.json"), JSON.stringify({
      passed: true,
      blockers: [],
    }), "utf8");
    const active = await routeContextForTask(root, "T1", {
      featureMode: "limited",
      generatedAt: NOW,
    });
    assert.equal(active.route, "v2_bounded_retrieval");
    assert.deepEqual(active.selected_source_refs, ["src/app.js"]);
    const tasks = JSON.parse(await readFile(path.join(stateRoot, "tasks.json"), "utf8"));
    assert.equal(tasks.tasks[0].task_profile.context_route.fallback, false);

    const portableRoot = path.join(root, "portable-skill");
    await mkdir(path.join(portableRoot, "scripts"), { recursive: true });
    await mkdir(path.join(portableRoot, "runtime"), { recursive: true });
    await copyFile(path.join(__dirname, "context-v2-route.js"), path.join(portableRoot, "scripts", "context-v2-route.js"));
    await copyFile(path.join(__dirname, "..", "runtime", "context-v2-runtime.cjs"), path.join(portableRoot, "runtime", "context-v2-runtime.cjs"));
    const portable = await execFileAsync(process.execPath, [
      path.join(portableRoot, "scripts", "context-v2-route.js"), "--root", root, "--task", "T1",
    ], { encoding: "utf8" });
    assert.equal(JSON.parse(portable.stdout).route, "v2_bounded_retrieval");

    await writeFile(path.join(contextRoot, "variant_comparison.json"), JSON.stringify({
      passed: false,
      blockers: ["v2_initial:quality_regression"],
    }), "utf8");
    const fallback = await routeContextForTask(root, "T1", {
      featureMode: "limited",
      generatedAt: NOW,
    });
    assert.equal(fallback.route, "v1_fallback");
    assert.deepEqual(fallback.selected_source_refs, []);

    await writeFile(path.join(contextRoot, "variant_comparison.json"), JSON.stringify({ passed: true, blockers: [] }), "utf8");
    await writeFile(path.join(contextRoot, "packs", "CP2-123456789abc.json"), JSON.stringify({
      context_pack_id: "CP2-123456789abc", fallback_reason: null, staleness: { state: "stale" },
      budget_receipt: { mandatory_overflow: 0 }, retrieval_permissions: { expand: true }, selected_sources: [],
    }), "utf8");
    assert.equal((await routeContextForTask(root, "T1", { generatedAt: NOW })).route, "v1_fallback");

    await writeFile(path.join(contextRoot, "packs", "CP2-123456789abc.json"), JSON.stringify({
      context_pack_id: "CP2-123456789abc", fallback_reason: null, staleness: { state: "current" },
      budget_receipt: { mandatory_overflow: 1 }, retrieval_permissions: { expand: true }, selected_sources: [],
    }), "utf8");
    assert.equal((await routeContextForTask(root, "T1", { generatedAt: NOW })).route, "v1_fallback");

    tasks.tasks[0].task_profile.context_requirement.decision_authority = "bounded_execution";
    tasks.tasks[0].task_profile.context_requirement.project_scope = "component";
    await writeFile(path.join(stateRoot, "tasks.json"), JSON.stringify(tasks), "utf8");
    await writeFile(path.join(contextRoot, "packs", "CP2-123456789abc.json"), JSON.stringify({
      context_pack_id: "CP2-123456789abc", fallback_reason: null, staleness: { state: "current" },
      budget_receipt: { mandatory_overflow: 0 }, retrieval_permissions: { expand: true }, selected_sources: [],
    }), "utf8");
    assert.equal((await routeContextForTask(root, "T1", { generatedAt: NOW })).route, "v1_fallback");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
