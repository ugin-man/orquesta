"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { canonicalHash, validateContract } = require("@orquesta/contracts");
const { createTaskIntent } = require("../../core/src/task-intent");
const { compileCapabilities } = require("../src");

function input(overrides = {}) {
  return {
    rawRequestRef: "fixture:compiler-v1",
    desiredOutcome: "UI画面を確認できるようにする",
    acceptanceCriteria: ["ブラウザで確認する"],
    constraints: ["network禁止"],
    risk: { impact: "low", reversible: true },
    authorityBoundary: { agent_may: ["inspect", "propose"], user_only: ["approve"] },
    assumptions: [],
    ...overrides,
  };
}

function rules(entries) {
  return { catalog_version: 1, rules: entries };
}

const browserRule = {
  rule_id: "ui-browser-evidence-v1",
  match: { any_terms: ["ui", "画面", "workbench"], acceptance_terms: ["browser", "ブラウザ"] },
  emits: [
    {
      kind: "asset",
      description: "再利用可能なUI構成要素",
      verification_method: "候補のsource pathを確認する",
    },
    {
      kind: "evidence",
      description: "実ブラウザ操作証拠",
      verification_method: "console errorなしでfixture完走を記録する",
      depends_on_emit: [0],
    },
  ],
};
const fixtureRules = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures/v4/phase1/compiler-rules.json"), "utf8"));

function reorderKeys(value) {
  if (Array.isArray(value)) return value.map(reorderKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).reverse().map((key) => [key, reorderKeys(value[key])]));
}

test("TaskIntent is a deterministic validated outcome contract", () => {
  const first = createTaskIntent(input());
  const second = createTaskIntent(reorderKeys(input()));
  assert.deepEqual(first, second);
  assert.match(first.task_intent_id, /^TI-[a-f0-9]{12}$/u);
  assert.equal(first.task_intent_id, `TI-${canonicalHash({
    raw_request_ref: first.raw_request_ref,
    desired_outcome: first.desired_outcome,
    acceptance_criteria: first.acceptance_criteria,
    constraints: first.constraints,
    risk: first.risk,
    authority_boundary: first.authority_boundary,
    assumptions: first.assumptions,
    status: first.status,
  }).slice(0, 12)}`);
  assert.equal(validateContract("task-intent", first).ok, true);
  assert.throws(() => createTaskIntent(input({ acceptanceCriteria: [] })), /task-intent/u);
  assert.throws(() => createTaskIntent(input({ status: "" })), /task-intent/u);
});

test("compiler produces a stable normalized graph with rule provenance", () => {
  const taskIntent = createTaskIntent(input());
  const catalog = fixtureRules;
  const graphA = compileCapabilities({ taskIntent, rules: catalog });
  const graphB = compileCapabilities({ taskIntent: reorderKeys(taskIntent), rules: reorderKeys(catalog) });
  assert.deepEqual(graphA, graphB);
  assert.match(graphA.graph_id, /^CG-[a-f0-9]{12}$/u);
  assert.match(graphA.graph_hash, /^[a-f0-9]{64}$/u);
  assert.equal(graphA.compiler_version, 1);
  assert.equal(graphA.task_intent_id, taskIntent.task_intent_id);
  assert.deepEqual(Object.keys(graphA).sort(), [
    "compiler_version",
    "edges",
    "graph_hash",
    "graph_id",
    "needs",
    "provenance",
    "task_intent_id",
    "unresolved_need_ids",
  ]);
  assert.equal(graphA.needs.every((need) => need.verification_method || need.unresolved_reason), true);
  assert.equal(graphA.needs.every((need) => validateContract("capability-need", need).ok), true);
  assert.deepEqual([...new Set(graphA.provenance.map((item) => item.matched_field))].sort(), ["acceptance_criteria", "desired_outcome"]);
  assert.equal(graphA.provenance.every((item) => item.rule_id === "ui-browser-evidence-v1" && /^CN-[a-f0-9]{12}$/u.test(item.need_id)), true);
  assert.equal(graphA.edges.length, 1);
  assert.deepEqual(
    compileCapabilities({ taskIntent, rules: catalog, providerDescriptions: ["untrusted web text"] }),
    graphA,
  );
});

test("compiler normalizes NFKC and dedupes only an identical verification need", () => {
  const taskIntent = createTaskIntent(input({ desiredOutcome: "ＵＩ画面を確認できるようにする" }));
  const duplicate = {
    ...browserRule,
    rule_id: "ui-browser-duplicate-v1",
    emits: [browserRule.emits[0]],
  };
  const distinctVerification = {
    ...browserRule,
    rule_id: "ui-browser-distinct-verification-v1",
    emits: [{
      ...browserRule.emits[0],
      verification_method: "候補のlicenseを確認する",
    }],
  };
  const graph = compileCapabilities({ taskIntent, rules: rules([browserRule, duplicate, distinctVerification]) });
  const matchingNeeds = graph.needs.filter((need) => need.description === "再利用可能なUI構成要素");
  assert.equal(matchingNeeds.length, 2);
  assert.ok(graph.provenance.some((item) => item.rule_id === "ui-browser-duplicate-v1"));
});

test("compiler keeps ASCII terms on token boundaries without weakening UI or Japanese matches", () => {
  const falsePositive = compileCapabilities({
    taskIntent: createTaskIntent(input({
      desiredOutcome: "build a compiler",
      acceptanceCriteria: ["browser evidence"],
    })),
    rules: fixtureRules,
  });
  assert.equal(falsePositive.needs.length, 1);
  assert.equal(falsePositive.needs[0].kind, "human_judgment");
  assert.deepEqual(falsePositive.provenance, []);
  assert.equal(falsePositive.needs.some((need) => ["asset", "evidence", "code"].includes(need.kind)), false);

  for (const desiredOutcome of ["UI画面を確認する", "ui画面を確認する", "ＵＩ画面を確認する", "画面を確認する"]) {
    const matched = compileCapabilities({
      taskIntent: createTaskIntent(input({ desiredOutcome, acceptanceCriteria: ["ブラウザで確認する"] })),
      rules: fixtureRules,
    });
    assert.equal(matched.needs.some((need) => need.kind === "asset"), true, desiredOutcome);
    assert.equal(matched.needs.some((need) => need.kind === "evidence"), true, desiredOutcome);
  }
});

test("compiler rejects ASCII terms embedded in Unicode Latin or decimal tokens", () => {
  for (const desiredOutcome of ["éuiéを確認する", "١ui٢を確認する"]) {
    const graph = compileCapabilities({
      taskIntent: createTaskIntent(input({ desiredOutcome, acceptanceCriteria: ["browser evidence"] })),
      rules: fixtureRules,
    });
    assert.equal(graph.needs.length, 1, desiredOutcome);
    assert.equal(graph.needs[0].kind, "human_judgment", desiredOutcome);
    assert.deepEqual(graph.provenance, [], desiredOutcome);
    assert.equal(graph.needs.some((need) => ["asset", "evidence", "code"].includes(need.kind)), false, desiredOutcome);
  }
});

test("compiler rejects ASCII terms separated from Unicode token neighbors only by combining marks", () => {
  for (const desiredOutcome of ["İuiを確認する", "I\u0307uiを確認する", "a\u034Fuiを確認する", "ui\u0338を確認する"]) {
    const graph = compileCapabilities({
      taskIntent: createTaskIntent(input({ desiredOutcome, acceptanceCriteria: ["browser evidence"] })),
      rules: fixtureRules,
    });
    assert.equal(graph.needs.length, 1, desiredOutcome);
    assert.equal(graph.needs[0].kind, "human_judgment", desiredOutcome);
    assert.deepEqual(graph.provenance, [], desiredOutcome);
    assert.equal(graph.needs.some((need) => ["asset", "evidence", "code"].includes(need.kind)), false, desiredOutcome);
  }
});

test("compiler rejects cyclic and unknown emit dependencies", () => {
  const taskIntent = createTaskIntent(input());
  const cycle = [{
    ...browserRule,
    emits: [
      { ...browserRule.emits[0], depends_on_emit: [1] },
      { ...browserRule.emits[1], depends_on_emit: [0] },
    ],
  }];
  const unknown = [{
    ...browserRule,
    emits: [{ ...browserRule.emits[0], depends_on_emit: [9] }],
  }];
  assert.throws(() => compileCapabilities({ taskIntent, rules: rules(cycle) }), { code: "CAPABILITY_GRAPH_CYCLE" });
  assert.throws(() => compileCapabilities({ taskIntent, rules: rules(unknown) }), { code: "CAPABILITY_GRAPH_UNKNOWN_DEPENDENCY" });
});

test("compiler emits one honest human judgment need when no rule matches", () => {
  const taskIntent = createTaskIntent(input({ desiredOutcome: "庭の写真を選ぶ", acceptanceCriteria: ["色を比較する"] }));
  const graph = compileCapabilities({ taskIntent, rules: rules([browserRule]) });
  assert.equal(graph.needs.length, 1);
  assert.equal(graph.needs[0].kind, "human_judgment");
  assert.equal(graph.needs[0].verification_method, "利用者または担当者の判断を記録する");
  assert.deepEqual(graph.unresolved_need_ids, [graph.needs[0].need_id]);
  assert.deepEqual(graph.provenance, []);
});

test("compiler accepts semantic declared needs without keyword rules", () => {
  const taskIntent = createTaskIntent(input({
    desiredOutcome: "架空都市の宗教と物流の矛盾を解消する",
    acceptanceCriteria: ["設定同士の因果関係が説明できる"],
  }));
  const declaredNeeds = [{
    need_id: "CN-world-causality",
    description: "世界観内の宗教制度と物流網を結ぶ因果モデル",
    kind: "knowledge",
    required_level: "required",
    hard_constraints: ["既存設定を破壊しない"],
    dependencies: [],
    verification_method: "矛盾一覧と修正後の因果鎖を照合する",
    status: "open",
    confidence: 85,
    acquisition_mode: "external_if_missing",
  }];
  const graph = compileCapabilities({ taskIntent, rules: rules([]), declaredNeeds });
  assert.equal(graph.compiler_version, 2);
  assert.deepEqual(graph.needs, declaredNeeds);
  assert.deepEqual(graph.provenance, [{ need_id: "CN-world-causality", rule_id: null, matched_field: "declared_need" }]);
  assert.equal(graph.needs[0].acquisition_mode, "external_if_missing");
});

test("declared needs reject duplicate ids and unknown dependencies", () => {
  const taskIntent = createTaskIntent(input());
  const base = {
    need_id: "CN-declared",
    description: "任意の能力",
    kind: "tool",
    required_level: "required",
    hard_constraints: [],
    dependencies: [],
    verification_method: "動作確認",
    status: "open",
    confidence: 80,
  };
  assert.throws(() => compileCapabilities({ taskIntent, rules: rules([]), declaredNeeds: [base, base] }), { code: "CAPABILITY_DECLARED_NEEDS_INVALID" });
  assert.throws(() => compileCapabilities({
    taskIntent,
    rules: rules([]),
    declaredNeeds: [{ ...base, dependencies: ["CN-missing"] }],
  }), { code: "CAPABILITY_GRAPH_UNKNOWN_DEPENDENCY" });
});
