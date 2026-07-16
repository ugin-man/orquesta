"use strict";

const { FIXTURE_IDS } = require("../../../scripts/v4/run-fixture");

function createStateView({ currentFixture = null, results = new Map() } = {}) {
  const current = currentFixture ? results.get(currentFixture) : null;
  return {
    product: "Orquesta V4 Preview",
    phase_id: "phase-1",
    current_fixture: currentFixture,
    fixtures: FIXTURE_IDS.map((fixtureId) => {
      const result = results.get(fixtureId);
      return {
        fixture_id: fixtureId,
        status: result ? "loaded" : "not_loaded",
        review_view: result ? result.review_view : null,
      };
    }),
    journal: current ? { ...current.journal } : { batch_count: 0, event_count: 0, fixture_ids: [] },
    limitations: [
      "Local fixture sources only",
      "No installation, external search, Codex dispatch, or Audition in Phase 1",
      "Final adoption and phase approval happen in the Codex task",
      "Actual model evidence is unavailable",
    ],
  };
}

module.exports = { createStateView };
