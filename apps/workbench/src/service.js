"use strict";

const { FIXTURE_IDS, runFixture } = require("../../../scripts/v4/run-fixture");
const { createStateView } = require("./state-view");

function serviceError(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function createWorkbenchService({ stateRoot } = {}) {
  if (typeof stateRoot !== "string" || !stateRoot) throw serviceError("V4_STATE_ROOT_REQUIRED", "A state root is required.", 500);
  const results = new Map();
  let currentFixture = null;

  function state() {
    return createStateView({ currentFixture, results });
  }

  function load(fixtureId) {
    if (!FIXTURE_IDS.includes(fixtureId)) throw serviceError("V4_FIXTURE_UNKNOWN", `Unknown fixture: ${fixtureId}`, 404);
    const result = runFixture({ fixtureId, stateRoot });
    results.set(fixtureId, result);
    currentFixture = fixtureId;
    return state();
  }

  function replay() {
    if (!currentFixture) throw serviceError("V4_FIXTURE_REQUIRED", "Load a fixture before replay.", 409);
    return load(currentFixture);
  }

  return { state, load, replay };
}

module.exports = { createWorkbenchService, serviceError };
