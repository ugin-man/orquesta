"use strict";

const { assertContract } = require("@orquesta/contracts");
const { searchLiveSources, toAuditLiveCandidateInput } = require("@orquesta/acquisition");
const { auditLiveCandidate } = require("@orquesta/audit");
const { resolveNeed } = require("@orquesta/capability-resolver");
const { scoutNeed } = require("@orquesta/scouts");
const { reviseExecutionPlan } = require("./execution-policy");

const LOCAL_SOURCES = Object.freeze(["repository", "package_manifest", "package_lock", "codex", "fixture"]);
const EXTERNAL_LIMITS = Object.freeze({ max_requests_per_need: 8, max_requests_per_connector: 2, max_candidates: 3 });
const MODES = new Set(["internal_only", "local_only", "external_if_missing", "compare_external"]);

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function sortedUnique(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))].sort(compareText);
}

function defaultMode(need) {
  if (need.kind === "permission" || need.kind === "human_judgment") return "internal_only";
  if (need.kind === "code") return "local_only";
  return "external_if_missing";
}

function routeNeed(need, inventory) {
  const explicit = MODES.has(need.acquisition_mode);
  const mode = explicit ? need.acquisition_mode : defaultMode(need);
  const reasons = [explicit ? `explicit:${mode}` : `fallback:${need.kind}:${mode}`];
  if (need.status === "satisfied" || need.status === "superseded") {
    return { need_id: need.need_id, mode, action: "none", local_candidates: [], reason_codes: [...reasons, `status:${need.status}`] };
  }
  if (mode === "internal_only") {
    return { need_id: need.need_id, mode, action: need.status === "blocked" ? "ask_or_unblock" : "execute_internal", local_candidates: [], reason_codes: reasons };
  }
  if (!inventory) {
    return { need_id: need.need_id, mode, action: "inspect_local", local_candidates: [], reason_codes: [...reasons, "local_inventory:not_provided"] };
  }
  const local = scoutNeed({ need, inventory, allowed_sources: LOCAL_SOURCES, budget: { max_candidates: 3, max_sources: 4 } });
  if (mode === "compare_external") {
    return { need_id: need.need_id, mode, action: "compare_live_candidates", local_candidates: local.candidates, reason_codes: [...reasons, `local:${local.stop_reason}`] };
  }
  if (local.candidates.length > 0) {
    return { need_id: need.need_id, mode, action: "resolve_local_candidates", local_candidates: local.candidates, reason_codes: [...reasons, `local:${local.stop_reason}`] };
  }
  if (mode === "external_if_missing") {
    return { need_id: need.need_id, mode, action: "search_live_sources", local_candidates: [], reason_codes: [...reasons, `local:${local.stop_reason}`] };
  }
  return { need_id: need.need_id, mode, action: "compare_with_build", local_candidates: [], reason_codes: [...reasons, `local:${local.stop_reason}`] };
}

function overallStatus(routes, hasNeeds) {
  if (!hasNeeds) return "semantic_decomposition_required";
  if (routes.some((route) => ["search_live_sources", "compare_live_candidates"].includes(route.action))) return "live_acquisition_required";
  if (routes.some((route) => route.action === "inspect_local")) return "local_inventory_required";
  if (routes.some((route) => ["resolve_local_candidates", "compare_with_build"].includes(route.action))) return "resolution_required";
  return "skipped";
}

function planReuseDiscovery({ capabilityNeeds = [], localInventory = null } = {}) {
  if (!Array.isArray(capabilityNeeds)) throw new TypeError("capabilityNeeds must be an array");
  const needs = capabilityNeeds.map((need) => assertContract("capability-need", need));
  if (localInventory !== null && (!localInventory || !Array.isArray(localInventory.providers))) {
    throw new TypeError("localInventory must expose providers");
  }
  const needRoutes = needs.map((need) => routeNeed(need, localInventory))
    .sort((left, right) => compareText(left.need_id, right.need_id));
  const status = overallStatus(needRoutes, needs.length > 0);
  const reasonCodes = [...new Set(needRoutes.flatMap((route) => route.reason_codes))].sort(compareText);
  if (!needs.length) reasonCodes.push("capability_needs:missing");
  return Object.freeze({
    version: 1,
    status,
    local_first: true,
    need_routes: needRoutes,
    reason_codes: reasonCodes,
    budget: { ...EXTERNAL_LIMITS },
  });
}

function queryForNeed(need, connectors, requestedAt) {
  const connectorIds = sortedUnique(connectors.map((connector) => connector && connector.id));
  if (!connectorIds.length) return null;
  const queryTerms = sortedUnique([
    need.description,
    need.required_level,
    ...(Array.isArray(need.hard_constraints) ? need.hard_constraints.map(String) : []),
  ]);
  return assertContract("live-source-query", {
    need_id: need.need_id,
    query_terms: queryTerms,
    allowed_connector_ids: connectorIds,
    request_budget: {
      max_requests_per_need: EXTERNAL_LIMITS.max_requests_per_need,
      max_requests_per_connector: EXTERNAL_LIMITS.max_requests_per_connector,
    },
    candidate_limit: EXTERNAL_LIMITS.max_candidates,
    requested_at: requestedAt,
  });
}

function scoreValue(known, strong = 65, unknown = 35) {
  return known ? strong : unknown;
}

function defaultAssessment({ candidate, origin, sourceEvidence = null }) {
  const facts = sourceEvidence && sourceEvidence.facts && typeof sourceEvidence.facts === "object"
    ? sourceEvidence.facts
    : {};
  const staticMetadata = {
    ...(candidate.static_metadata && typeof candidate.static_metadata === "object" ? candidate.static_metadata : {}),
  };
  for (const field of ["license", "maintenance", "security", "accessibility"]) {
    if (Object.hasOwn(facts, field)) staticMetadata[field] = facts[field];
    else if (Object.hasOwn(candidate, field)) staticMetadata[field] = candidate[field];
  }
  if (Object.hasOwn(facts, "compatibility")) staticMetadata.runtime = facts.compatibility;
  else if (Object.hasOwn(candidate, "compatibility")) staticMetadata.runtime = candidate.compatibility;

  const unknowns = sortedUnique([
    ...(Array.isArray(candidate.unverified_fields) ? candidate.unverified_fields : []),
    ...(sourceEvidence && Array.isArray(sourceEvidence.unknowns) ? sourceEvidence.unknowns.map((field) => field === "cost" ? "total_cost" : field === "compatibility" ? "runtime" : field) : []),
  ]);
  const evidenceCount = Array.isArray(candidate.evidence_refs) ? candidate.evidence_refs.length : 0;
  const axes = {
    task_fit: { value: origin === "live" ? 55 : 65, reason: "Candidate was returned for the declared semantic Capability Need." },
    integration_ease: { value: scoreValue(Object.hasOwn(staticMetadata, "runtime")), reason: "Uses explicit compatibility evidence when available." },
    evidence_strength: { value: Math.min(85, 40 + evidenceCount * 10 + (origin === "live" ? 10 : 0)), reason: "Derived from bounded source evidence, not candidate popularity." },
    maintainability: { value: scoreValue(Object.hasOwn(staticMetadata, "maintenance"), 60, 35), reason: "Uses maintenance evidence only when the source supplies it." },
    security: { value: scoreValue(Object.hasOwn(staticMetadata, "security"), 65, 35), reason: "Uses source-bound security metadata when available." },
    license_fit: { value: scoreValue(Object.hasOwn(staticMetadata, "license"), 70, 0), reason: "Unknown licenses fail the hard gate." },
    exit_option: { value: 50, reason: "No lock-in claim is inferred from a search result." },
    cost: { value: scoreValue(Object.hasOwn(facts, "cost") || Object.hasOwn(candidate, "estimated_total_cost"), 60, 30), reason: "Uses a cost value only when explicitly evidenced." },
  };
  const assessment = {
    axes,
    uncertainty_penalty: Math.min(90, 10 + unknowns.length * 8),
    static_metadata: staticMetadata,
    unknowns,
  };
  if (Object.hasOwn(facts, "cost")) assessment.estimated_total_cost = facts.cost;
  else if (Object.hasOwn(candidate, "estimated_total_cost")) assessment.estimated_total_cost = candidate.estimated_total_cost;
  return assessment;
}

function applyAssessment({ need, candidate, origin, sourceResult = null, sourceEvidence = null, assessCandidate }) {
  const baseline = defaultAssessment({ need, candidate, origin, sourceResult, sourceEvidence });
  const supplied = typeof assessCandidate === "function"
    ? assessCandidate({ need: clone(need), candidate: clone(candidate), origin, sourceResult: clone(sourceResult), sourceEvidence: clone(sourceEvidence), baseline: clone(baseline) })
    : null;
  if (supplied !== null && supplied !== undefined && (!supplied || typeof supplied !== "object" || Array.isArray(supplied))) {
    throw new TypeError("assessCandidate must return an object when it returns a value");
  }
  const assessment = supplied ? { ...baseline, ...supplied } : baseline;
  return {
    ...candidate,
    axes: assessment.axes,
    uncertainty_penalty: assessment.uncertainty_penalty,
    static_metadata: assessment.static_metadata,
    unknowns: sortedUnique(assessment.unknowns || []),
    ...(Object.hasOwn(assessment, "estimated_total_cost") ? { estimated_total_cost: assessment.estimated_total_cost } : {}),
    ...(assessment.resolution_mode ? { resolution_mode: assessment.resolution_mode } : {}),
  };
}

function localCandidateFor(routeCandidate, localInventory) {
  const provider = localInventory.providers.find((item) => item.provider_id === routeCandidate.provider_id) || {};
  return {
    ...provider,
    ...routeCandidate,
    evidence_refs: sortedUnique([...(provider.evidence_refs || []), ...(routeCandidate.evidence_refs || [])]),
    static_metadata: {
      ...(provider.static_metadata && typeof provider.static_metadata === "object" ? provider.static_metadata : {}),
      ...(Object.hasOwn(provider, "license") ? { license: provider.license } : {}),
      ...(Object.hasOwn(provider, "compatibility") ? { runtime: provider.compatibility } : {}),
      ...(Object.hasOwn(provider, "security") ? { security: provider.security } : {}),
      ...(Object.hasOwn(provider, "maintenance") ? { maintenance: provider.maintenance } : {}),
      ...(Object.hasOwn(provider, "accessibility") ? { accessibility: provider.accessibility } : {}),
    },
  };
}

function providerType(connectorId) {
  return ({ registry: "package", github: "repository", official_docs: "knowledge", ui_catalog: "asset" })[connectorId] || "external";
}

function liveCandidateFor(need, discovered, sourceResult) {
  return {
    provider_id: discovered.candidate_id,
    provider_type: providerType(sourceResult.connector_id),
    source_type: `live:${sourceResult.connector_id}`,
    source_uri: discovered.source_ref,
    source_ref: discovered.source_ref,
    source_hash: discovered.source_hash,
    capabilities: [need.description],
    trust_tier: discovered.trust_tier,
    availability: discovered.freshness === "fresh" ? "available" : "unknown",
    version: discovered.version || discovered.revision || "unversioned",
    last_verified_at: sourceResult.fetched_at,
    evidence_refs: [`${discovered.source_ref}#${discovered.source_hash}`],
  };
}

function acquisitionForResult(result, query) {
  return {
    query,
    source_results: result.source_results,
    source_failures: result.source_failures,
    cache_evidence: result.cache_evidence,
    budget: result.budget,
  };
}

function resultStatus(route, proposal, acquisition) {
  if (["none", "execute_internal"].includes(route.action)) return "skipped";
  if (["inspect_local", "ask_or_unblock"].includes(route.action)) return "blocked";
  if (acquisition && acquisition.source_failures.length && acquisition.source_results.length === 0) return "blocked";
  if (!proposal) return "blocked";
  return proposal.resolution.mode === "ask" ? "decision_required" : "proposal_ready";
}

function overallExecutionStatus(results, hasNeeds) {
  if (!hasNeeds) return "semantic_decomposition_required";
  if (results.some((result) => result.status === "blocked")) return "partial";
  if (results.some((result) => result.status === "decision_required")) return "needs_user_review";
  if (results.some((result) => result.status === "proposal_ready")) return "proposals_ready";
  return "skipped";
}

async function executeReuseDiscovery({
  capabilityNeeds = [],
  localInventory = null,
  connectors = [],
  cache = null,
  clock = () => new Date().toISOString(),
  assessCandidate,
} = {}) {
  if (!Array.isArray(connectors)) throw new TypeError("connectors must be an array");
  if (typeof clock !== "function") throw new TypeError("clock must be a function");
  const needs = capabilityNeeds.map((need) => assertContract("capability-need", clone(need)));
  const decision = planReuseDiscovery({ capabilityNeeds: needs, localInventory });
  const needsById = new Map(needs.map((need) => [need.need_id, need]));
  const needResults = [];
  let consumedTotal = 0;

  for (const route of decision.need_routes) {
    const need = needsById.get(route.need_id);
    const localCandidates = localInventory
      ? route.local_candidates.map((candidate) => applyAssessment({ need, candidate: localCandidateFor(candidate, localInventory), origin: "local", assessCandidate }))
      : [];
    let acquisition = null;
    const liveCandidates = [];
    const auditFacts = [];

    if (["search_live_sources", "compare_live_candidates"].includes(route.action)) {
      const requestedAt = clock();
      const query = queryForNeed(need, connectors, requestedAt);
      if (query) {
        const found = await searchLiveSources({ query, connectors, cache, clock });
        acquisition = acquisitionForResult(found, query);
        consumedTotal += found.budget.consumed_total;
        for (const discovered of found.candidates) {
          const sourceResult = found.source_results.find((result) => result.candidates.some((candidate) => candidate.candidate_id === discovered.candidate_id && candidate.source_hash === discovered.source_hash));
          if (!sourceResult) continue;
          const sourceEvidence = sourceResult.source_evidence.find((evidence) => evidence.candidate_id === discovered.candidate_id && evidence.source_hash === discovered.source_hash);
          if (!sourceEvidence) continue;
          const candidate = applyAssessment({ need, candidate: liveCandidateFor(need, discovered, sourceResult), origin: "live", sourceResult, sourceEvidence, assessCandidate });
          const bound = toAuditLiveCandidateInput({ sourceResult, candidate });
          const audited = auditLiveCandidate({ ...bound, need });
          liveCandidates.push(candidate);
          auditFacts.push(audited);
        }
      } else {
        acquisition = {
          query: null,
          source_results: [],
          source_failures: [{ connector_id: "none", code: "no_connectors", message: "No live source connectors are configured." }],
          cache_evidence: [],
          budget: { consumed_total: 0, remaining_total: EXTERNAL_LIMITS.max_requests_per_need, per_connector: {} },
        };
      }
    }

    const candidates = [...localCandidates];
    const seen = new Set(candidates.map((candidate) => candidate.provider_id));
    for (const candidate of liveCandidates) {
      if (!seen.has(candidate.provider_id)) {
        seen.add(candidate.provider_id);
        candidates.push(candidate);
      }
    }
    const shouldResolve = ["resolve_local_candidates", "compare_with_build", "search_live_sources", "compare_live_candidates"].includes(route.action)
      && !(acquisition && acquisition.source_failures.length && acquisition.source_results.length === 0 && candidates.length === 0);
    const proposal = shouldResolve ? resolveNeed({ need, scoutedCandidates: candidates, auditFacts }) : null;
    const status = resultStatus(route, proposal, acquisition);
    needResults.push({
      need_id: need.need_id,
      mode: route.mode,
      route_action: route.action,
      status,
      local_candidate_ids: localCandidates.map((candidate) => candidate.provider_id).sort(compareText),
      live_candidate_ids: liveCandidates.map((candidate) => candidate.provider_id).sort(compareText),
      candidates,
      audit_facts: auditFacts,
      acquisition,
      proposal,
      reason_codes: sortedUnique([...route.reason_codes, `result:${status}`]),
    });
  }

  const status = overallExecutionStatus(needResults, needs.length > 0);
  return deepFreeze({
    version: 2,
    status,
    local_first: true,
    need_results: needResults,
    reason_codes: sortedUnique([...decision.reason_codes, `execution:${status}`]),
    budget: {
      limits: { ...EXTERNAL_LIMITS },
      consumed_total: consumedTotal,
      need_count: needResults.length,
    },
  });
}

function integrateReuseDiscovery({ executionPlan, taskProfile, discovery } = {}) {
  if (!discovery || discovery.version !== 2 || !Array.isArray(discovery.need_results)) {
    throw new TypeError("discovery must be an executed reuse discovery result");
  }
  if (!executionPlan || typeof executionPlan !== "object"
    || !taskProfile || typeof taskProfile !== "object"
    || taskProfile.task_intent_id !== executionPlan.task_intent_id) {
    throw new TypeError("taskProfile must bind the Execution Plan TaskIntent");
  }
  const planReasons = [
    `reuse_discovery:${discovery.status}`,
    ...discovery.need_results.map((result) => `reuse:${result.need_id}:${result.proposal ? result.proposal.resolution.mode : result.status}`),
  ];
  const evidenceRefs = sortedUnique(discovery.need_results.flatMap((result) => [
    ...(result.proposal ? [`resolution:${result.proposal.resolution.resolution_id}`, ...result.proposal.resolution.evidence_refs] : []),
    ...(result.acquisition ? result.acquisition.source_results.flatMap((source) => source.source_evidence.map((evidence) => `${evidence.source_ref}#${evidence.source_hash}`)) : []),
  ]));
  const execution_plan = reviseExecutionPlan({ executionPlan, reasonCodes: planReasons });
  const task_profile = deepFreeze({
    ...clone(taskProfile),
    reuse_discovery: clone(discovery),
    reason_codes: sortedUnique([...(taskProfile.reason_codes || []), ...discovery.reason_codes]),
    evidence_refs: sortedUnique([...(taskProfile.evidence_refs || []), ...evidenceRefs]),
  });
  return deepFreeze({ task_profile, execution_plan });
}

async function completeReuseDiscovery(input = {}) {
  const discovery = await executeReuseDiscovery(input);
  const hasPlan = input.executionPlan !== undefined || input.taskProfile !== undefined;
  if (!hasPlan) return { discovery };
  if (!input.executionPlan || !input.taskProfile) throw new TypeError("executionPlan and taskProfile must be supplied together");
  return { discovery, ...integrateReuseDiscovery({ executionPlan: input.executionPlan, taskProfile: input.taskProfile, discovery }) };
}

module.exports = {
  EXTERNAL_LIMITS,
  LOCAL_SOURCES,
  completeReuseDiscovery,
  executeReuseDiscovery,
  integrateReuseDiscovery,
  planReuseDiscovery,
};
