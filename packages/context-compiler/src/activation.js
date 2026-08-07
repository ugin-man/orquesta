"use strict";

const REQUIRED_VARIANTS = Object.freeze([
  "v1",
  "fixed_minimal",
  "v2_initial",
  "v2_bounded_retrieval",
]);

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function normalizeVariantRows(rows) {
  const byScenario = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== "object" || !REQUIRED_VARIANTS.includes(row.variant)) continue;
    const scenarioId = typeof row.scenario_id === "string" && row.scenario_id.trim()
      ? row.scenario_id.trim()
      : "default";
    const byVariant = byScenario.get(scenarioId) || new Map();
    byVariant.set(row.variant, {
      scenario_id: scenarioId,
      variant: row.variant,
      quality_passed: row.quality_passed === true,
      major_regression: row.major_regression === true,
      user_corrections: Number.isInteger(row.user_corrections) ? row.user_corrections : null,
      incorrect_project_facts: Number.isInteger(row.incorrect_project_facts)
        ? row.incorrect_project_facts
        : null,
      cold_cost_explainable: row.cold_cost_explainable === true,
      steady_cost_explainable: row.steady_cost_explainable === true,
      prompt_tokens: Number.isInteger(row.prompt_tokens) ? row.prompt_tokens : null,
      wall_time_ms: Number.isInteger(row.wall_time_ms) ? row.wall_time_ms : null,
      retrieval_required: row.retrieval_required === true,
    });
    byScenario.set(scenarioId, byVariant);
  }
  return byScenario;
}

function summarizeContextVariantComparison(rows) {
  const scenarios = normalizeVariantRows(rows);
  const blockers = [];
  if (scenarios.size === 0) blockers.push("missing_scenarios");
  const scenarioSummaries = [];
  for (const [scenarioId, variants] of [...scenarios.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const missing = REQUIRED_VARIANTS.filter((variant) => !variants.has(variant));
    if (missing.length) blockers.push(`${scenarioId}:missing_variants:${missing.join(",")}`);
    const baseline = variants.get("v1");
    const retrievalRequired = [...variants.values()].some((row) => row.retrieval_required === true);
    for (const variant of ["v2_initial", "v2_bounded_retrieval"]) {
      const row = variants.get(variant);
      if (!row || !baseline) continue;
      const expectedInsufficientInitial = retrievalRequired && variant === "v2_initial";
      if (!expectedInsufficientInitial) {
        if (!row.quality_passed || row.major_regression) blockers.push(`${scenarioId}:${variant}:quality_regression`);
        if (row.user_corrections === null || baseline.user_corrections === null
          || row.user_corrections > baseline.user_corrections) {
          blockers.push(`${scenarioId}:${variant}:user_corrections_not_bounded`);
        }
        if (row.incorrect_project_facts === null || baseline.incorrect_project_facts === null
          || row.incorrect_project_facts > baseline.incorrect_project_facts) {
          blockers.push(`${scenarioId}:${variant}:project_fact_regression`);
        }
      }
      if (!row.cold_cost_explainable || !row.steady_cost_explainable) {
        blockers.push(`${scenarioId}:${variant}:cost_not_explainable`);
      }
    }
    scenarioSummaries.push({
      scenario_id: scenarioId,
      retrieval_required: retrievalRequired,
      rows: REQUIRED_VARIANTS.map((variant) => variants.get(variant)).filter(Boolean),
    });
  }
  return Object.freeze({
    version: 2,
    required_variants: [...REQUIRED_VARIANTS],
    scenario_count: scenarioSummaries.length,
    scenarios: scenarioSummaries,
    rows: scenarioSummaries.flatMap((scenario) => scenario.rows),
    blockers: [...new Set(blockers)].sort(),
    passed: blockers.length === 0,
  });
}

function structuralEligibility(requirement) {
  const authority = requirement?.decision_authority;
  const scope = requirement?.project_scope;
  const domainCount = Array.isArray(requirement?.knowledge_domains)
    ? requirement.knowledge_domains.length
    : 0;
  if (authority === "read_only" || authority === "proposal_only") {
    return {
      eligible: true,
      class: domainCount >= 2 ? "multi_domain_read_or_plan" : "read_or_proposal",
    };
  }
  if (authority === "bounded_execution" && scope === "local") {
    return { eligible: true, class: "bounded_local_execution" };
  }
  return { eligible: false, class: "outside_limited_boundary" };
}

function evaluateContextV2Activation({
  featureMode = "shadow",
  contextRequirement,
  contextPack,
  variantComparison = null,
} = {}) {
  if (!["shadow", "limited", "disabled"].includes(featureMode)) {
    throw new TypeError("featureMode must be disabled, shadow, or limited");
  }
  const eligibility = structuralEligibility(contextRequirement);
  const reasons = [];
  if (featureMode !== "limited") reasons.push(`feature_mode:${featureMode}`);
  if (!eligibility.eligible) reasons.push(`structural_class:${eligibility.class}`);
  if (contextRequirement?.status !== "ready") reasons.push("requirement_not_ready");
  if (contextPack?.fallback_reason) reasons.push(`pack_fallback:${contextPack.fallback_reason}`);
  if (contextPack?.staleness?.state !== "current") reasons.push("pack_not_current");
  if (contextPack?.budget_receipt?.mandatory_overflow > 0) reasons.push("mandatory_budget_overflow");
  if (!variantComparison?.passed) reasons.push("variant_comparison_not_passed");
  const fallback = reasons.length > 0;
  return Object.freeze({
    version: 2,
    feature_mode: featureMode,
    structural_class: eligibility.class,
    route: fallback
      ? "v1_fallback"
      : contextPack?.retrieval_permissions?.expand ? "v2_bounded_retrieval" : "v2_initial",
    fallback,
    reasons: [...new Set(reasons)].sort(),
    context_pack_id: contextPack?.context_pack_id || null,
  });
}

module.exports = {
  REQUIRED_VARIANTS,
  evaluateContextV2Activation,
  structuralEligibility,
  summarizeContextVariantComparison,
};
