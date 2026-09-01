const { deepFreeze } = require("./contract");

const ACTUAL_MODEL_SOURCES = Object.freeze(["app_server", "approved_hook"]);

function optionalModel(value, label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} must be a non-empty string or null`);
  }
  return value;
}

function explicitObservation(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  if (event.event_kind !== "model_observed"
      || !ACTUAL_MODEL_SOURCES.includes(event.source)) {
    return null;
  }
  const model = optionalModel(event.actual_model, "observed actual model");
  const evidenceRef = optionalModel(event.payload_ref, "actual model evidence ref");
  if (model === null) throw new TypeError("model observation must name an actual model");
  if (evidenceRef === null) throw new TypeError("model observation must include an evidence ref");
  return { model, evidenceRef };
}

function createModelEvidence({
  recommended,
  requested,
  applied,
  runtimeEvent
} = {}) {
  const events = Array.isArray(runtimeEvent) ? runtimeEvent : [runtimeEvent];
  const observations = events.map(explicitObservation).filter(Boolean);
  const models = new Set(observations.map((item) => item.model));
  if (models.size > 1) throw new Error("conflicting model observations");
  const observation = observations.at(-1) || null;

  return deepFreeze({
    recommended_model: optionalModel(recommended, "recommended model"),
    requested_model: optionalModel(requested, "requested model"),
    applied_model: optionalModel(applied, "applied model"),
    actual_model: observation?.model ?? null,
    actual_model_evidence_ref: observation?.evidenceRef ?? null
  });
}

module.exports = {
  ACTUAL_MODEL_SOURCES,
  createModelEvidence
};
