"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { compareCodexProfile } = require("../src");

const workspaceRoot = path.resolve("C:/workspace/project");
const auditionRoot = path.resolve("C:/workspace/temp/audition-1");
const planned = {
  allowed_roots: [workspaceRoot, auditionRoot],
  effects: ["dependency_change", "workspace_write"]
};

function actual(overrides = {}) {
  return {
    status: "available",
    verified: true,
    source: "codex-runtime-profile",
    captured_at: "2026-07-17T00:00:00.000Z",
    allowed_roots: [workspaceRoot, auditionRoot],
    effects: ["workspace_write"],
    ...overrides
  };
}

test("accepts an exact or narrower verified Codex profile and records its source and time", () => {
  const result = compareCodexProfile({ planned, actual: actual() });
  assert.equal(result.status, "compatible");
  assert.deepEqual(result.reasons, []);
  assert.equal(result.observed_profile.source, "codex-runtime-profile");
  assert.equal(result.observed_profile.captured_at, "2026-07-17T00:00:00.000Z");
});

test("blocks missing, unavailable, unverifiable, broader-root, and broader-effect profiles", () => {
  for (const profile of [
    null,
    actual({ status: "unavailable" }),
    actual({ verified: false }),
    actual({ source: "" }),
    actual({ captured_at: "" }),
    actual({ allowed_roots: [path.dirname(workspaceRoot)] }),
    actual({ effects: ["workspace_write", "network_access"] })
  ]) {
    const result = compareCodexProfile({ planned, actual: profile });
    assert.equal(result.status, "blocked");
    assert.ok(result.reasons.length > 0);
  }
});
