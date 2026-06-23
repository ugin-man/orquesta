#!/usr/bin/env node

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  buildDashboardStateEtag,
  collectDashboardStateEntries
} = require("./dashboard-state-cache");

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data)}\n`, "utf8");
}

function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-state-cache-"));
  try {
    writeJson(path.join(root, ".orquesta", "state", "agents.json"), { agents: [] });
    writeJson(path.join(root, ".orquesta", "state", "tasks.json"), { tasks: [] });

    const firstEntries = collectDashboardStateEntries(root);
    const firstEtag = buildDashboardStateEtag(root);
    const secondEtag = buildDashboardStateEtag(root);

    assert(firstEntries.some((entry) => entry.endsWith("/.orquesta/state/agents.json")));
    assert.strictEqual(firstEtag, secondEtag);

    writeJson(path.join(root, ".orquesta", "state", "tasks.json"), { tasks: [{ task_id: "T001" }] });
    const changedEtag = buildDashboardStateEtag(root);

    assert.notStrictEqual(changedEtag, firstEtag);
    assert.match(changedEtag, /^"orquesta-[a-f0-9]{40}"$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log("dashboard state cache tests passed");
}

main();
