#!/usr/bin/env node

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  defaultBetaV3State,
  ensureBetaV3ReleaseState
} = require("./beta-v3-state-init");

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function makeRoot(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `orquesta-beta-v3-state-${name}-`));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

test("clean bootstrap creates the three empty Beta V3 state files", () => {
  const root = makeRoot("clean");
  try {
    const result = ensureBetaV3ReleaseState(root);
    const expected = defaultBetaV3State();
    const files = [
      [path.join(root, ".orquesta", "state", "dashboard_actions.json"), expected.dashboardActions],
      [path.join(root, ".orquesta", "failures", "incident_candidates.json"), expected.incidentCandidates],
      [path.join(root, ".orquesta", "failures", "incident_clusters.json"), expected.incidentClusters]
    ];

    assert.deepStrictEqual(result.created.sort(), [
      ".orquesta/failures/incident_candidates.json",
      ".orquesta/failures/incident_clusters.json",
      ".orquesta/state/dashboard_actions.json"
    ]);
    files.forEach(([filePath, expectedValue]) => assert.deepStrictEqual(readJson(filePath), expectedValue));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("bootstrap rerun preserves valid existing Beta V3 state exactly", () => {
  const root = makeRoot("preserve");
  try {
    ensureBetaV3ReleaseState(root);
    const actionPath = path.join(root, ".orquesta", "state", "dashboard_actions.json");
    const candidatePath = path.join(root, ".orquesta", "failures", "incident_candidates.json");
    const clusterPath = path.join(root, ".orquesta", "failures", "incident_clusters.json");
    fs.writeFileSync(actionPath, `${JSON.stringify({ version: 1, actions: [{ action_id: "DA001", status: "requested" }], retained: true }, null, 2)}\n`, "utf8");
    fs.writeFileSync(candidatePath, `${JSON.stringify({ version: 1, candidates: [{ candidate_id: "IC001", status: "candidate" }], retained: true }, null, 2)}\n`, "utf8");
    fs.writeFileSync(clusterPath, `${JSON.stringify({ version: 1, clusters: [{ cluster_id: "FC001", status: "open" }], retained: true }, null, 2)}\n`, "utf8");
    const before = [actionPath, candidatePath, clusterPath].map((filePath) => fs.readFileSync(filePath, "utf8"));

    const result = ensureBetaV3ReleaseState(root);

    assert.deepStrictEqual(result.created, []);
    assert.deepStrictEqual([actionPath, candidatePath, clusterPath].map((filePath) => fs.readFileSync(filePath, "utf8")), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("bootstrap fails closed for an invalid existing Beta V3 state file", () => {
  const root = makeRoot("invalid");
  try {
    const actionPath = path.join(root, ".orquesta", "state", "dashboard_actions.json");
    fs.mkdirSync(path.dirname(actionPath), { recursive: true });
    fs.writeFileSync(actionPath, "{not json}\n", "utf8");

    assert.throws(
      () => ensureBetaV3ReleaseState(root),
      (error) => error?.code === "BETA_V3_STATE_INVALID" && error.filePath === actionPath
    );
    assert.strictEqual(fs.readFileSync(actionPath, "utf8"), "{not json}\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const { name, fn } of tests) {
  fn();
  console.log(`ok - ${name}`);
}

console.log("beta-v3 state initialization tests passed");
