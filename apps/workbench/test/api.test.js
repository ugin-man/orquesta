"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { startWorkbench } = require("../server");

function tempState() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-workbench-"));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("requires the explicit V4 feature flag", async () => {
  const state = tempState();
  try {
    await assert.rejects(() => startWorkbench({ feature: null, stateRoot: state.root, port: 0 }), { code: "V4_FEATURE_FLAG_REQUIRED" });
  } finally {
    state.cleanup();
  }
});

test("loads and replays the three local fixtures through a loopback API", async () => {
  const state = tempState();
  const app = await startWorkbench({ feature: "v4", stateRoot: state.root, port: 0 });
  try {
    const initial = await fetch(`${app.url}/api/v4/state`).then((response) => response.json());
    assert.equal(initial.product, "Orquesta V4 Preview");
    assert.equal(initial.phase_id, "phase-1");
    assert.equal(initial.current_fixture, null);
    assert.deepEqual(initial.fixtures.map((fixture) => fixture.fixture_id), ["local-reuse", "adapt-vs-build", "blocked-candidate"]);

    const expectedModes = new Map([
      ["local-reuse", "reuse"],
      ["adapt-vs-build", "adapt"],
      ["blocked-candidate", "build"],
    ]);
    for (const [fixtureId, expectedMode] of expectedModes) {
      const loadedResponse = await fetch(`${app.url}/api/v4/fixtures/${fixtureId}/load`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: app.url },
        body: "{}",
      });
      assert.equal(loadedResponse.status, 200, fixtureId);
      const loaded = await loadedResponse.json();
      assert.equal(loaded.current_fixture, fixtureId);
      const fixture = loaded.fixtures.find((item) => item.fixture_id === fixtureId);
      assert.equal(fixture.review_view.proposed_mode, expectedMode);
      assert.equal(fixture.review_view.scout_invoked, false);
      assert.equal(fixture.review_view.approval_status, "pending_user");
      assert.equal(fixture.review_view.context_pack_status, "draft");
    }

    const replayResponse = await fetch(`${app.url}/api/v4/replay`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: app.url },
      body: "{}",
    });
    assert.equal(replayResponse.status, 200);
    const replayed = await replayResponse.json();
    assert.equal(replayed.journal.batch_count, 18);
    assert.equal(replayed.journal.event_count, 42);
    assert.deepEqual(replayed.journal.fixture_ids, ["adapt-vs-build", "blocked-candidate", "local-reuse"]);
  } finally {
    await app.close();
    state.cleanup();
  }
});

test("keeps fixture mutation local and exposes only the fixed Phase 1 surface", async () => {
  const state = tempState();
  const app = await startWorkbench({ feature: "v4", stateRoot: state.root, port: 0 });
  try {
    const post = (route, overrides = {}) => fetch(`${app.url}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://example.invalid" },
      body: "{}",
      ...overrides,
    });
    const wrongOrigin = await post("/api/v4/fixtures/local-reuse/load");
    assert.equal(wrongOrigin.status, 403);

    const missingOrigin = await post("/api/v4/replay", { headers: { "content-type": "application/json" } });
    assert.equal(missingOrigin.status, 403);

    for (const route of [
      "/api/v4/install",
      "/api/v4/dispatch",
      "/api/v4/web-search",
      "/api/v4/approvals/challenge",
      "/api/v4/resolutions/CR-001/decision",
      "/api/v4/phase-review/decision",
      "/api/v4/fixtures/unknown/load",
    ]) {
      const response = await fetch(`${app.url}${route}`, { method: "POST", headers: { "content-type": "application/json", origin: app.url }, body: "{}" });
      assert.equal(response.status, 404, route);
    }

    const invalidJson = await fetch(`${app.url}/api/v4/replay`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: app.url },
      body: "{",
    });
    assert.equal(invalidJson.status, 400);

    const wrongType = await fetch(`${app.url}/api/v4/replay`, {
      method: "POST",
      headers: { "content-type": "text/plain", origin: app.url },
      body: "{}",
    });
    assert.equal(wrongType.status, 415);

    const tooLarge = await fetch(`${app.url}/api/v4/replay`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: app.url },
      body: JSON.stringify({ value: "x".repeat(1024 * 1024) }),
    });
    assert.equal(tooLarge.status, 413);

    assert.equal((await fetch(app.url)).status, 404);
  } finally {
    await app.close();
    state.cleanup();
  }
});

test("selects a loopback fallback when the preferred Workbench port is occupied", async () => {
  const state = tempState();
  const blocker = net.createServer();
  let ownsPreferredPort = false;
  try {
    await new Promise((resolve, reject) => {
      blocker.once("error", (error) => error.code === "EADDRINUSE" ? resolve() : reject(error));
      blocker.listen(4181, "127.0.0.1", () => { ownsPreferredPort = true; resolve(); });
    });
    const app = await startWorkbench({ feature: "v4", stateRoot: state.root, port: 4181 });
    try {
      assert.match(app.url, /^http:\/\/127\.0\.0\.1:\d+$/u);
      assert.notEqual(app.port, 4181);
      assert.equal((await fetch(`${app.url}/api/v4/state`)).status, 200);
    } finally {
      await app.close();
    }
  } finally {
    if (ownsPreferredPort) await new Promise((resolve) => blocker.close(resolve));
    state.cleanup();
  }
});
