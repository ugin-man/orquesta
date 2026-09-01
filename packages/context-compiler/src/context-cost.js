"use strict";

const CATEGORY_ORDER = Object.freeze([
  "codex_harness_baseline",
  "universal_contract",
  "task_envelope",
  "project_control_plane",
  "specialist_capability_slice",
  "selected_project_sources",
  "tool_results",
  "conversation_history",
]);

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function estimateTokens(value) {
  if (value === undefined || value === null) return 0;
  const serialized = Buffer.isBuffer(value)
    ? value
    : Buffer.from(typeof value === "string" ? value : JSON.stringify(value), "utf8");
  return Math.max(0, Math.ceil(serialized.byteLength / 4));
}

function categoryMeasurement(value, evidenceRef) {
  if (value === undefined) {
    return { tokens: 0, measurement: "unknown", evidence_ref: evidenceRef };
  }
  if (value && typeof value === "object" && !Array.isArray(value)
    && (Object.hasOwn(value, "tokens") || Object.hasOwn(value, "content"))) {
    const observed = nonNegativeInteger(value.tokens);
    if (observed !== null) {
      return {
        tokens: observed,
        measurement: value.measurement === "estimated" ? "estimated" : "observed",
        evidence_ref: value.evidence_ref || evidenceRef,
      };
    }
    if (Object.hasOwn(value, "content")) {
      return {
        tokens: estimateTokens(value.content),
        measurement: "estimated",
        evidence_ref: value.evidence_ref || evidenceRef,
      };
    }
  }
  return {
    tokens: estimateTokens(value),
    measurement: "estimated",
    evidence_ref: evidenceRef,
  };
}

function selectedSourcesMeasurement(value) {
  if (Array.isArray(value) && value.every((entry) => (
    entry && typeof entry === "object" && Number.isInteger(entry.token_estimate)
  ))) {
    return {
      tokens: value.reduce((total, entry) => total + Math.max(0, entry.token_estimate), 0),
      measurement: "estimated",
      evidence_ref: "context_pack.selected_sources",
    };
  }
  return categoryMeasurement(value, "context_pack.selected_sources");
}

function normalizeReadEvents(events) {
  return (Array.isArray(events) ? events : [])
    .filter((event) => event && typeof event === "object")
    .map((event) => ({
      source_id: typeof event.source_id === "string" ? event.source_id : null,
      source_ref: typeof event.source_ref === "string" ? event.source_ref : null,
      bytes: nonNegativeInteger(event.bytes),
      tokens: nonNegativeInteger(event.tokens),
      truncated: event.truncated === true,
    }))
    .filter((event) => event.source_id || event.source_ref);
}

function createContextCostReport({
  runId = null,
  startupMode,
  codexHarnessBaseline,
  universalContract,
  taskEnvelope,
  projectControlPlane,
  specialistCapabilitySlice,
  selectedProjectSources = [],
  toolResults = "",
  conversationHistory = "",
  observedFullPromptTokens = null,
  fileReadEvents = [],
  fileReadMeasurementComplete = false,
  foundation = {},
  generatedAt,
} = {}) {
  if (!["cold", "steady"].includes(startupMode)) {
    throw new TypeError("startupMode must be cold or steady");
  }
  const categories = {
    codex_harness_baseline: categoryMeasurement(codexHarnessBaseline, "codex_runtime.baseline"),
    universal_contract: categoryMeasurement(universalContract, "orquesta.contract.universal"),
    task_envelope: categoryMeasurement(taskEnvelope, "task_envelope"),
    project_control_plane: categoryMeasurement(projectControlPlane, "project_control_plane"),
    specialist_capability_slice: categoryMeasurement(specialistCapabilitySlice, "agent_capability_profile"),
    selected_project_sources: selectedSourcesMeasurement(selectedProjectSources),
    tool_results: categoryMeasurement(toolResults, "runtime.tool_results"),
    conversation_history: categoryMeasurement(conversationHistory, "runtime.conversation_history"),
  };
  const estimatedPromptTokens = CATEGORY_ORDER.reduce(
    (total, category) => total + categories[category].tokens,
    0,
  );
  const observedPrompt = nonNegativeInteger(observedFullPromptTokens);
  const reads = normalizeReadEvents(fileReadEvents);
  const readCoverage = fileReadMeasurementComplete
    && reads.every((event) => event.bytes !== null && event.tokens !== null)
    ? "observed"
    : reads.length ? "partial" : fileReadMeasurementComplete ? "observed" : "unknown";
  const readBytes = reads.reduce((total, event) => total + (event.bytes || 0), 0);
  const readTokens = reads.reduce((total, event) => total + (event.tokens || 0), 0);
  const foundationGenerationCount = nonNegativeInteger(foundation.generation_count) ?? 0;
  const foundationReuseCount = nonNegativeInteger(foundation.reuse_count) ?? 0;
  const report = {
    version: 2,
    run_id: typeof runId === "string" && runId ? runId : null,
    startup_mode: startupMode,
    generated_at: generatedAt || new Date().toISOString(),
    categories,
    prompt: {
      estimated_tokens: estimatedPromptTokens,
      observed_tokens: observedPrompt,
      coverage: observedPrompt === null ? "estimated" : "observed",
      estimation_delta: observedPrompt === null ? null : observedPrompt - estimatedPromptTokens,
    },
    file_reading: {
      coverage: readCoverage,
      event_count: reads.length,
      bytes: readCoverage === "unknown" ? null : readBytes,
      tokens: readCoverage === "unknown" ? null : readTokens,
      events: reads,
    },
    foundation: {
      generation_count: foundationGenerationCount,
      reuse_count: foundationReuseCount,
      reused: foundationReuseCount > 0,
    },
  };
  report.explainable = report.prompt.coverage !== "unknown"
    && report.file_reading.coverage !== "unknown"
    && CATEGORY_ORDER.every((category) => categories[category].measurement !== "unknown");
  return Object.freeze(clone(report));
}

function compareColdAndSteadyContextCosts(coldReport, steadyReport) {
  const cold = clone(coldReport);
  const steady = clone(steadyReport);
  if (cold?.startup_mode !== "cold" || steady?.startup_mode !== "steady") {
    throw new TypeError("A cold report and a steady report are required.");
  }
  const coldTokens = cold.prompt?.observed_tokens ?? cold.prompt?.estimated_tokens;
  const steadyTokens = steady.prompt?.observed_tokens ?? steady.prompt?.estimated_tokens;
  const comparable = Number.isInteger(coldTokens) && Number.isInteger(steadyTokens)
    && cold.file_reading?.coverage !== "unknown"
    && steady.file_reading?.coverage !== "unknown";
  return Object.freeze({
    version: 2,
    comparable,
    cold_run_id: cold.run_id,
    steady_run_id: steady.run_id,
    prompt_token_delta: comparable ? steadyTokens - coldTokens : null,
    prompt_token_ratio: comparable && coldTokens > 0 ? steadyTokens / coldTokens : null,
    file_read_token_delta: comparable
      ? (steady.file_reading.tokens || 0) - (cold.file_reading.tokens || 0)
      : null,
    foundation_generation_delta: comparable
      ? steady.foundation.generation_count - cold.foundation.generation_count
      : null,
    steady_reused_foundation: steady.foundation.reused === true,
    explainable: cold.explainable === true && steady.explainable === true,
  });
}

module.exports = {
  CATEGORY_ORDER,
  compareColdAndSteadyContextCosts,
  createContextCostReport,
  estimateTokens,
};
