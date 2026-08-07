"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createLiveSourceConnector } = require("@orquesta/acquisition");
const { createTaskIntent } = require("../src/task-intent");
const { createProfiledExecutionPlan } = require("../src/profiled-execution-plan");
const { completeReuseDiscovery, executeReuseDiscovery, planReuseDiscovery } = require("../src/reuse-discovery");

const taskFixture = require("../../../fixtures/v4/phase1/local-reuse/task-intent.json");

function need(overrides = {}) {
  return {
    need_id: "CN-reuse",
    description: "再利用可能な管理画面UI kit",
    kind: "asset",
    required_level: "required",
    hard_constraints: [],
    dependencies: [],
    verification_method: "候補を表示して比較する",
    status: "open",
    confidence: 90,
    ...overrides,
  };
}

function inventory(providers = []) {
  return { providers, conflicts: [] };
}

test("missing semantic needs request decomposition instead of keyword guessing", () => {
  const plan = planReuseDiscovery();
  assert.equal(plan.status, "semantic_decomposition_required");
  assert.ok(plan.reason_codes.includes("capability_needs:missing"));
});

test("local code and human judgment do not trigger live acquisition", () => {
  const plan = planReuseDiscovery({
    capabilityNeeds: [
      need({ need_id: "CN-code", kind: "code", description: "既存関数の局所修正" }),
      need({ need_id: "CN-human", kind: "human_judgment", description: "色の最終判断", confidence: 0 }),
    ],
    localInventory: inventory(),
  });
  assert.equal(plan.status, "resolution_required");
  assert.deepEqual(plan.need_routes.map((route) => [route.need_id, route.action]), [
    ["CN-code", "compare_with_build"],
    ["CN-human", "execute_internal"],
  ]);
});

test("external-if-missing stays local-first and searches live only after a local miss", () => {
  const beforeInventory = planReuseDiscovery({ capabilityNeeds: [need({ acquisition_mode: "external_if_missing" })] });
  assert.equal(beforeInventory.status, "local_inventory_required");
  const afterMiss = planReuseDiscovery({ capabilityNeeds: [need({ acquisition_mode: "external_if_missing" })], localInventory: inventory() });
  assert.equal(afterMiss.status, "live_acquisition_required");
  assert.equal(afterMiss.need_routes[0].action, "search_live_sources");
  assert.deepEqual(afterMiss.budget, { max_requests_per_need: 8, max_requests_per_connector: 2, max_candidates: 3 });
});

test("a matching local provider routes to resolution without live search", () => {
  const provider = {
    provider_id: "local-ui-kit",
    provider_type: "package",
    source_type: "package_manifest",
    capabilities: ["管理画面UI kit"],
    evidence_refs: ["workspace:package.json#local-ui-kit"],
    license: "MIT",
    compatibility: "compatible",
  };
  const plan = planReuseDiscovery({
    capabilityNeeds: [need({ acquisition_mode: "external_if_missing" })],
    localInventory: inventory([provider]),
  });
  assert.equal(plan.status, "resolution_required");
  assert.equal(plan.need_routes[0].action, "resolve_local_candidates");
  assert.equal(plan.need_routes[0].local_candidates[0].provider_id, "local-ui-kit");
});

test("routing is driven by declared acquisition policy across unfamiliar domains", () => {
  const cases = [
    ["worldbuilding", need({ need_id: "CN-world", kind: "knowledge", description: "架空世界の潮汐暦", acquisition_mode: "external_if_missing" }), "search_live_sources"],
    ["dataset", need({ need_id: "CN-data", kind: "data", description: "地域別の公開統計", acquisition_mode: "compare_external" }), "compare_live_candidates"],
    ["internal tool", need({ need_id: "CN-tool", kind: "tool", description: "専用変換器", acquisition_mode: "internal_only" }), "execute_internal"],
    ["bounded code", need({ need_id: "CN-local-code", kind: "code", description: "既存parserの境界修正", acquisition_mode: "local_only" }), "compare_with_build"],
  ];
  for (const [label, capabilityNeed, expectedAction] of cases) {
    const plan = planReuseDiscovery({ capabilityNeeds: [capabilityNeed], localInventory: inventory() });
    assert.equal(plan.need_routes[0].action, expectedAction, label);
  }
});

function liveResult() {
  const sourceHash = "a".repeat(64);
  const sourceRef = "https://docs.example.test/ui-kit";
  const facts = {
    accessibility: "met",
    compatibility: "compatible",
    cost: 0,
    freshness: "fresh",
    license: "MIT",
    maintenance: "active",
    security: "low",
    trust: "official",
  };
  return {
    connector_id: "official_docs",
    trust_tier: "official",
    fetched_at: "2026-08-02T00:00:00.000Z",
    expires_at: "2026-08-03T00:00:00.000Z",
    status: "success",
    candidates: [{ candidate_id: "official_docs:ui-kit", source_ref: sourceRef, source_hash: sourceHash, version: "1.0.0", revision: null, trust_tier: "official", freshness: "fresh" }],
    source_evidence: [{
      source_id: "source:official_docs:ui-kit",
      candidate_id: "official_docs:ui-kit",
      source_ref: sourceRef,
      source_hash: sourceHash,
      freshness: "fresh",
      authoritative_fields: Object.keys(facts).sort(),
      facts,
      unknowns: [],
    }],
    cache_status: "miss",
    redaction_status: "redacted",
  };
}

test("live discovery searches, audits, compares reuse with build, and revises the plan", async () => {
  const calls = [];
  const connector = createLiveSourceConnector({
    id: "official_docs",
    trustTier: "official",
    transport: {
      async request(request) {
        calls.push(request);
        return { status: 200 };
      },
    },
    async search({ query, transport }) {
      await transport.request({ method: "GET", url: "https://docs.example.test/search", body: null });
      assert.deepEqual(query.query_terms, ["required", "再利用可能な管理画面UI kit"]);
      return liveResult();
    },
  });
  const capabilityNeed = need({ acquisition_mode: "external_if_missing" });
  const taskIntent = createTaskIntent(taskFixture.task_intent);
  const initial = createProfiledExecutionPlan({
    taskIntent,
    capabilityNeeds: [capabilityNeed],
    localInventory: inventory(),
    workItem: { effects: ["workspace_write"] },
  });
  const completed = await completeReuseDiscovery({
    capabilityNeeds: [capabilityNeed],
    localInventory: inventory(),
    connectors: [connector],
    clock: () => "2026-08-02T00:00:00.000Z",
    executionPlan: initial.execution_plan,
    taskProfile: initial.task_profile,
  });

  assert.equal(calls.length, 1);
  assert.equal(completed.discovery.status, "proposals_ready");
  assert.equal(completed.discovery.need_results[0].proposal.resolution.mode, "reuse");
  assert.equal(completed.discovery.need_results[0].proposal.resolution.selected_provider_id, "official_docs:ui-kit");
  assert.equal(completed.execution_plan.revision, initial.execution_plan.revision + 1);
  assert.equal(completed.execution_plan.supersedes_execution_plan_id, initial.execution_plan.execution_plan_id);
  assert.ok(completed.execution_plan.reason_codes.includes("reuse:CN-reuse:reuse"));
  assert.equal(completed.task_profile.reuse_discovery.version, 2);
  assert.ok(completed.task_profile.evidence_refs.some((reference) => reference.startsWith("https://docs.example.test/ui-kit#")));
});

test("external-if-missing does not call live connectors when local inventory satisfies the Need", async () => {
  let calls = 0;
  const connector = createLiveSourceConnector({
    id: "official_docs",
    trustTier: "official",
    transport: { request() { calls += 1; } },
    search() { calls += 1; return liveResult(); },
  });
  const capabilityNeed = need({ acquisition_mode: "external_if_missing" });
  const result = await executeReuseDiscovery({
    capabilityNeeds: [capabilityNeed],
    localInventory: inventory([{
      provider_id: "local-ui-kit",
      provider_type: "package",
      source_type: "package_manifest",
      capabilities: ["管理画面UI kit"],
      evidence_refs: ["workspace:package.json#local-ui-kit"],
      license: "MIT",
      compatibility: "compatible",
      estimated_total_cost: 0,
    }]),
    connectors: [connector],
  });

  assert.equal(calls, 0);
  assert.equal(result.need_results[0].acquisition, null);
  assert.deepEqual(result.need_results[0].local_candidate_ids, ["local-ui-kit"]);
});

test("live discovery fails closed into a partial plan when no connector is configured", async () => {
  const result = await executeReuseDiscovery({
    capabilityNeeds: [need({ acquisition_mode: "external_if_missing" })],
    localInventory: inventory(),
    connectors: [],
    clock: () => "2026-08-02T00:00:00.000Z",
  });
  assert.equal(result.status, "partial");
  assert.equal(result.need_results[0].status, "blocked");
  assert.equal(result.need_results[0].acquisition.source_failures[0].code, "no_connectors");
});
