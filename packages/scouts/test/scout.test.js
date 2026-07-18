"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { scoutNeed } = require("../src");

function provider(providerId, capability, sourceType = "fixture") {
  return {
    provider_id: providerId,
    provider_type: sourceType === "repository" ? "repository_code" : sourceType,
    source_type: sourceType,
    capabilities: [capability],
    evidence_refs: [`fixture:${providerId}`],
    provider_hash: providerId.padEnd(64, "0").slice(0, 64)
  };
}

test("bounds Scout v1 to three candidates and four source families", () => {
  const inventory = {
    providers: [
      provider("candidate-a", "browser QA", "repository"),
      provider("candidate-b", "browser QA", "package_manifest"),
      provider("candidate-c", "browser QA", "package_lock"),
      provider("candidate-d", "browser QA", "codex_skill"),
      provider("candidate-e", "browser QA", "fixture")
    ]
  };

  const result = scoutNeed({
    need: { need_id: "NEED-QA", description: "Reproducible browser QA" },
    inventory,
    budget: { max_candidates: 99, max_sources: 99 },
    allowed_sources: ["repository", "package_manifest", "package_lock", "codex", "fixture"]
  });

  assert.equal(result.candidates.length, 3);
  assert.equal(result.sources_considered.length, 4);
  assert.deepEqual(result.candidates.map((item) => item.provider_id), ["candidate-a", "candidate-b", "candidate-c"]);
  assert.equal(result.stop_reason, "candidate_budget_reached");
});

test("rejects Phase 2 source families before considering candidates", () => {
  for (const source of ["web", "registry", "remote"]) {
    assert.throws(
      () => scoutNeed({
        need: { need_id: "NEED-1", description: "Anything" },
        inventory: { providers: [] },
        budget: { max_candidates: 3, max_sources: 4 },
        allowed_sources: ["repository", source]
      }),
      (error) => error && error.code === "SCOUT_SOURCE_NOT_ALLOWED_PHASE1"
    );
  }
});

test("returns an unresolved empty result without inventing a build candidate", () => {
  const result = scoutNeed({
    need: { need_id: "NEED-MISSING", description: "Capability that is not local" },
    inventory: { providers: [] },
    budget: { max_candidates: 3, max_sources: 4 },
    allowed_sources: ["repository", "fixture"]
  });

  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.evidence_refs, []);
  assert.equal(result.stop_reason, "no_local_candidates");
  assert.equal(result.unresolved, true);
  assert.equal(JSON.stringify(result).includes("build"), false);
});

test("stops deterministically with unresolved evidence when inventory contains a provider conflict", () => {
  const conflicting = provider("conflicted-provider", "browser QA");
  const result = scoutNeed({
    need: { need_id: "NEED-CONFLICT", description: "browser QA" },
    inventory: {
      providers: [conflicting],
      conflicts: [{
        provider_id: "conflicted-provider",
        status: "conflict",
        hashes: ["a".repeat(64), "b".repeat(64)]
      }]
    },
    budget: { max_candidates: 3, max_sources: 4 },
    allowed_sources: ["fixture"]
  });

  assert.deepEqual(result.candidates, []);
  assert.equal(result.stop_reason, "inventory_conflict");
  assert.equal(result.unresolved, true);
  assert.deepEqual(result.conflicts, [{
    provider_id: "conflicted-provider",
    status: "conflict",
    hashes: ["a".repeat(64), "b".repeat(64)]
  }]);
  assert.deepEqual(result.evidence_refs, [
    `provider:conflicted-provider#sha256:${"a".repeat(64)}`,
    `provider:conflicted-provider#sha256:${"b".repeat(64)}`
  ]);
});

test("orders equal-source candidates by deterministic code-unit order", () => {
  const result = scoutNeed({
    need: { need_id: "NEED-ORDER", description: "deterministic ordering" },
    inventory: {
      providers: [
        provider("a-provider", "deterministic ordering"),
        provider("B-provider", "deterministic ordering")
      ]
    },
    budget: { max_candidates: 3, max_sources: 4 },
    allowed_sources: ["fixture"]
  });

  assert.deepEqual(result.candidates.map((item) => item.provider_id), ["B-provider", "a-provider"]);
});

test("all inventory sources and Scout run with fetch, http, and https trapped in a child process", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-no-network-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const projectRoot = path.join(root, "project");
  const codexHome = path.join(root, "codex");
  fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "src", "helper.js"), "module.exports = {};\n", "utf8");
  fs.writeFileSync(path.join(projectRoot, "package.json"), '{"name":"network-trap","version":"1.0.0"}\n', "utf8");
  fs.writeFileSync(path.join(projectRoot, "package-lock.json"), '{"name":"network-trap","lockfileVersion":3,"packages":{}}\n', "utf8");
  fs.writeFileSync(
    path.join(projectRoot, "orquesta.capabilities.json"),
    '{"version":1,"providers":[{"provider_id":"local-helper","provider_type":"repository_code","source_ref":"src/helper.js","capabilities":["local helper"],"trust_tier":"local","license":"MIT"}]}\n',
    "utf8"
  );
  const catalogPath = path.join(projectRoot, "providers.json");
  fs.writeFileSync(catalogPath, '{"version":1,"providers":[]}\n', "utf8");
  spawnSync("git", ["init", "--quiet"], { cwd: projectRoot, encoding: "utf8" });
  spawnSync("git", ["-c", "core.autocrlf=false", "add", "."], { cwd: projectRoot, encoding: "utf8" });
  const commit = spawnSync(
    "git",
    ["-c", "user.name=Task Six Test", "-c", "user.email=task6@example.invalid", "commit", "--quiet", "-m", "fixture"],
    { cwd: projectRoot, encoding: "utf8" }
  );
  assert.equal(commit.status, 0, commit.stderr);

  const entryPath = path.resolve(__dirname, "../src");
  const childScript = [
    'const http = require("node:http");',
    'const https = require("node:https");',
    'const trap = () => { throw new Error("NETWORK_PATH_REACHED"); };',
    'global.fetch = trap;',
    'http.request = trap;',
    'https.request = trap;',
    `const { collectLocalInventory, scoutNeed } = require(${JSON.stringify(entryPath)});`,
    `const inventory = collectLocalInventory({ projectRoot: ${JSON.stringify(projectRoot)}, codexHome: ${JSON.stringify(codexHome)}, fixtureCatalogPath: ${JSON.stringify(catalogPath)}, clock: () => "2026-07-15T00:00:00.000Z" });`,
    'const result = scoutNeed({ need: { need_id: "NEED-LOCAL", description: "local helper" }, inventory, budget: { max_candidates: 3, max_sources: 4 }, allowed_sources: ["repository", "package_manifest", "package_lock", "codex"] });',
    'if (result.candidates.length !== 1) throw new Error("EXPECTED_LOCAL_CANDIDATE");'
  ].join("\n");

  const child = spawnSync(process.execPath, ["-e", childScript], { encoding: "utf8" });
  assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
});
