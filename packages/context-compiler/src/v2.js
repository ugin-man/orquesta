"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { assertContract, canonicalHash } = require("@orquesta/contracts");

const PROJECT_SCOPES = new Set(["none", "local", "component", "global"]);
const DETAIL_LEVELS = new Set(["minimal", "bounded", "deep"]);
const DECISION_AUTHORITIES = new Set(["read_only", "proposal_only", "bounded_execution", "user_only"]);
const EXECUTION_CHANNELS = new Set([
  "coordination",
  "live_operation",
  "product_implementation",
  "independent_review",
  "creative_production",
  "research",
]);
const CONTINUE_POLICIES = new Set(["continue_until_terminal", "return_after_local", "await_user"]);
const CHECKPOINT_POLICIES = new Set(["non_blocking", "blocking_canary", "final_acceptance"]);
const HISTORY_POLICIES = new Set(["fresh", "filtered", "existing_delta"]);
const BUDGETS = Object.freeze({
  none: Object.freeze({ initial: 2_000, expansion: 2_000 }),
  local: Object.freeze({ initial: 6_000, expansion: 4_000 }),
  component: Object.freeze({ initial: 10_000, expansion: 8_000 }),
  global: Object.freeze({ initial: 12_000, expansion: 12_000 }),
});

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortUnique(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))]
    .sort(compareText);
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function records(value) {
  return Array.isArray(value) ? value.filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry)) : [];
}

function boundedInteger(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function id(prefix, value) {
  return `${prefix}-${canonicalHash(value).slice(0, 12)}`;
}

function validateChoice(value, choices, fallback) {
  return choices.has(value) ? value : fallback;
}

function normalizeWorkspaceReference(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const candidate = value.trim().replace(/\\/g, "/");
  if (candidate === "." || candidate.startsWith("/") || /^[A-Za-z]:\//u.test(candidate)) return null;
  if (/^[a-z][a-z0-9+.-]*:/iu.test(candidate)) return null;
  const normalized = path.posix.normalize(candidate);
  if (normalized === ".." || normalized.startsWith("../")) return null;
  return normalized;
}

function estimateTokens(value) {
  return Math.max(1, Math.ceil(Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8") / 4));
}

function createTaskEnvelopeV2({ taskIntent, options = {} } = {}) {
  const intent = clone(assertContract("task-intent", taskIntent));
  const input = object(options);
  const parentGoalId = typeof input.parent_goal_id === "string" && input.parent_goal_id.trim()
    ? input.parent_goal_id.trim()
    : null;
  const continuePolicy = validateChoice(
    input.continue_policy,
    CONTINUE_POLICIES,
    parentGoalId ? "continue_until_terminal" : "return_after_local",
  );
  const executionChannel = validateChoice(
    input.execution_channel,
    EXECUTION_CHANNELS,
    "product_implementation",
  );
  const checkpointPolicy = validateChoice(input.checkpoint_policy, CHECKPOINT_POLICIES, "non_blocking");
  const historyPolicy = validateChoice(input.conversation_history_policy, HISTORY_POLICIES, "filtered");
  const content = {
    schema_version: 2,
    task_intent_id: intent.task_intent_id,
    parent_goal_id: parentGoalId,
    workstream_id: String(input.workstream_id || `workstream:${intent.task_intent_id}`),
    terminal_outcome: String(input.terminal_outcome || intent.desired_outcome),
    local_deliverable: String(input.local_deliverable || intent.desired_outcome),
    continue_policy: continuePolicy,
    checkpoint_policy: checkpointPolicy,
    escalation_conditions: sortUnique(Array.isArray(input.escalation_conditions)
      ? input.escalation_conditions
      : ["external_access_blocked", "required_user_action", "terminal_outcome_impossible"]),
    notification_policy: {
      silent_progress: input.silent_progress !== false,
      notify_on: sortUnique(Array.isArray(input.notify_on)
        ? input.notify_on
        : ["blocker", "exceptional_duration", "terminal", "user_action"]),
    },
    execution: {
      execution_channel: executionChannel,
      inbox_policy: input.inbox_policy === "queued" ? "queued" : "exclusive",
      accepted_command_types: sortUnique(Array.isArray(input.accepted_command_types)
        ? input.accepted_command_types
        : [`${executionChannel}.execute`]),
      exclusive_active_command: input.exclusive_active_command !== false,
      conversation_history_policy: historyPolicy,
    },
    status: input.status === "superseded" ? "superseded" : input.status === "draft" ? "draft" : "ready",
  };
  const envelope = {
    ...content,
    task_envelope_id: id("TE", content),
  };
  return Object.freeze(assertContract("task-envelope", envelope));
}

function inferProjectScope(workItem) {
  const explicit = workItem.project_scope;
  if (PROJECT_SCOPES.has(explicit)) return explicit;
  const boundaries = sortUnique(Array.isArray(workItem.scope_boundaries) ? workItem.scope_boundaries : []);
  if (!boundaries.length) return "none";
  if (boundaries.includes(".")) return "global";
  return boundaries.length === 1 ? "local" : "component";
}

function inferDecisionAuthority(intent, workItem) {
  if (DECISION_AUTHORITIES.has(workItem.decision_authority)) return workItem.decision_authority;
  const authority = object(intent.authority_boundary);
  const agentMay = sortUnique(Array.isArray(authority.agent_may) ? authority.agent_may : []);
  const userOnly = sortUnique(Array.isArray(authority.user_only) ? authority.user_only : []);
  if (!agentMay.length && userOnly.length) return "user_only";
  if (agentMay.length && agentMay.every((entry) => /^(?:read|inspect|review|analyze)$/iu.test(entry))) return "read_only";
  return userOnly.length ? "proposal_only" : "bounded_execution";
}

function dependencyInputs(workItem) {
  return records(workItem.dependency_inputs)
    .filter((entry) => typeof entry.task_id === "string" && entry.task_id.trim()
      && typeof entry.required_output === "string" && entry.required_output.trim())
    .map((entry) => ({
      task_id: entry.task_id.trim(),
      required_output: entry.required_output.trim(),
    }))
    .sort((left, right) => compareText(`${left.task_id}:${left.required_output}`, `${right.task_id}:${right.required_output}`));
}

function capabilityDomains(capabilityNeeds) {
  const values = [];
  for (const need of records(capabilityNeeds)) {
    if (typeof need.capability_id === "string") values.push(need.capability_id);
    else if (typeof need.kind === "string") values.push(`capability.${need.kind}`);
    if (Array.isArray(need.knowledge_domains)) values.push(...need.knowledge_domains);
  }
  return sortUnique(values);
}

function deriveContextRequirementV2({
  taskIntent,
  taskEnvelope,
  workItem = {},
  capabilityNeeds = [],
} = {}) {
  const intent = clone(assertContract("task-intent", taskIntent));
  const envelope = clone(assertContract("task-envelope", taskEnvelope));
  if (envelope.task_intent_id !== intent.task_intent_id) {
    throw new TypeError("TaskEnvelope must bind the same TaskIntent.");
  }
  const work = object(workItem);
  const projectScope = inferProjectScope(work);
  const budget = BUDGETS[projectScope];
  const requiredReading = sortUnique([
    ...(Array.isArray(object(work.context_manifest).required_reading)
      ? object(work.context_manifest).required_reading
      : []),
    ...(Array.isArray(work.required_reading) ? work.required_reading : []),
  ]);
  const exclusions = sortUnique([
    ...(Array.isArray(object(work.context_manifest).excluded_context)
      ? object(work.context_manifest).excluded_context
      : []),
    ...(Array.isArray(work.excluded_context) ? work.excluded_context : []),
    "superseded",
    "unrelated_private_context",
  ]);
  const explicitDomains = Array.isArray(work.knowledge_domains) ? work.knowledge_domains : [];
  const artifactTypes = sortUnique(Array.isArray(work.artifact_types) && work.artifact_types.length
    ? work.artifact_types
    : ["task_intent"]);
  const evidenceNeeds = intent.acceptance_criteria.map((criterion, index) => (
    typeof criterion === "string" && criterion.trim()
      ? `acceptance:${index + 1}`
      : null
  )).filter(Boolean);
  const content = {
    version: 2,
    task_intent_id: intent.task_intent_id,
    task_envelope_id: envelope.task_envelope_id,
    project_scope: projectScope,
    knowledge_domains: sortUnique([...explicitDomains, ...capabilityDomains(capabilityNeeds)]),
    artifact_types: artifactTypes,
    dependency_inputs: dependencyInputs(work),
    decision_authority: inferDecisionAuthority(intent, work),
    detail_level: validateChoice(
      work.detail_level,
      DETAIL_LEVELS,
      projectScope === "global" || projectScope === "component"
        ? "deep"
        : projectScope === "local" ? "bounded" : "minimal",
    ),
    freshness: work.freshness === "allow_stale_with_warning" ? "allow_stale_with_warning" : "current",
    evidence_needs: evidenceNeeds.length ? evidenceNeeds : ["acceptance:1"],
    must_include: sortUnique([
      `task_intent:${intent.task_intent_id}`,
      `task_envelope:${envelope.task_envelope_id}`,
      ...requiredReading,
    ]),
    must_exclude: exclusions,
    initial_token_budget: boundedInteger(work.initial_token_budget, budget.initial),
    expansion_budget: boundedInteger(work.expansion_budget, budget.expansion),
    missing_context_policy: ["needs_user", "stop"].includes(work.missing_context_policy)
      ? work.missing_context_policy
      : "request_bounded_expansion",
    status: work.context_requirement_status === "needs_user"
      ? "needs_user"
      : work.context_requirement_status === "draft" ? "draft" : "ready",
  };
  const requirement = {
    ...content,
    requirement_id: id("CR", content),
  };
  return Object.freeze(assertContract("context-requirement", requirement));
}

function sourceType(reference) {
  if (reference === ".orquesta/state/tasks.json") return "task_record";
  if (reference.includes("/directives") || reference.includes("/decisions")) return "accepted_decision";
  if (reference.startsWith("interfaces/") || reference.includes("/interfaces/")) return "interface";
  if (reference.startsWith("tests/") || reference.includes("/test/") || reference.includes("/tests/")) return "test";
  if (reference.includes("/reports/") || reference.startsWith("reports/")) return "report";
  return "project_file";
}

function artifactType(reference) {
  const extension = path.posix.extname(reference).toLowerCase();
  if ([".js", ".cjs", ".mjs", ".ts", ".tsx", ".jsx"].includes(extension)) return "source_code";
  if (extension === ".json" || extension === ".jsonl") return "structured_state";
  if (extension === ".md" || extension === ".txt") return "documentation";
  if ([".png", ".jpg", ".jpeg", ".svg", ".webp"].includes(extension)) return "visual_reference";
  return "project_file";
}

function sourceRecordForValue({
  sourceRef,
  value,
  sourceType: kind,
  authority,
  artifactTypes,
  knowledgeDomains = [],
  supportsCriteria = [],
  status = "current",
  freshness = "current",
}) {
  const serialized = Buffer.isBuffer(value)
    ? value
    : Buffer.from(typeof value === "string" ? value : JSON.stringify(value), "utf8");
  const sourceHash = crypto.createHash("sha256").update(serialized).digest("hex");
  const content = {
    schema_version: 2,
    source_ref: sourceRef,
    source_hash: sourceHash,
    source_type: kind,
    authority,
    freshness,
    knowledge_domains: sortUnique(knowledgeDomains),
    artifact_types: sortUnique(artifactTypes),
    supports_criteria: sortUnique(supportsCriteria),
    token_estimate: status === "missing" ? 0 : Math.max(1, Math.ceil(serialized.byteLength / 4)),
    content_mode: "reference",
    summary: null,
    status,
  };
  return assertContract("source-record", {
    ...content,
    source_id: id("SRC", { source_ref: sourceRef, source_hash: sourceHash }),
  });
}

function buildSourceCatalogV2({
  workspaceRoot,
  taskIntent,
  taskEnvelope,
  contextRequirement,
  sourceRefs = [],
  sourceRecords = [],
} = {}) {
  const intent = clone(assertContract("task-intent", taskIntent));
  const envelope = clone(assertContract("task-envelope", taskEnvelope));
  const requirement = clone(assertContract("context-requirement", contextRequirement));
  if (intent.task_intent_id !== envelope.task_intent_id
    || intent.task_intent_id !== requirement.task_intent_id
    || envelope.task_envelope_id !== requirement.task_envelope_id) {
    throw new TypeError("Source catalog inputs must bind the same task and envelope.");
  }
  const criteria = intent.acceptance_criteria.map((_, index) => `acceptance:${index + 1}`);
  const catalog = [
    sourceRecordForValue({
      sourceRef: `task_intent:${intent.task_intent_id}`,
      value: intent,
      sourceType: "task_record",
      authority: "canonical",
      artifactTypes: ["task_intent"],
      knowledgeDomains: requirement.knowledge_domains,
    }),
    sourceRecordForValue({
      sourceRef: `task_envelope:${envelope.task_envelope_id}`,
      value: envelope,
      sourceType: "task_record",
      authority: "canonical",
      artifactTypes: ["task_envelope"],
      knowledgeDomains: requirement.knowledge_domains,
    }),
  ];
  for (const record of sourceRecords) catalog.push(clone(assertContract("source-record", record)));

  const requestedRefs = sortUnique([
    ...sourceRefs,
    ...requirement.must_include.map(normalizeWorkspaceReference).filter(Boolean),
  ]);
  const root = typeof workspaceRoot === "string" && workspaceRoot
    ? fs.realpathSync(workspaceRoot)
    : null;
  for (const reference of requestedRefs) {
    const target = root ? path.resolve(root, ...reference.split("/")) : null;
    const relative = root && target ? path.relative(root, target) : null;
    const inside = root && target && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    let body = "";
    let status = "missing";
    if (inside && fs.existsSync(target) && fs.statSync(target).isFile()) {
      body = fs.readFileSync(target);
      status = "current";
    }
    const supported = intent.acceptance_criteria
      .map((criterion, index) => typeof criterion === "string" && criterion.includes(reference) ? criteria[index] : null)
      .filter(Boolean);
    catalog.push(sourceRecordForValue({
      sourceRef: reference,
      value: body,
      sourceType: sourceType(reference),
      authority: reference.startsWith(".orquesta/") ? "canonical" : "workspace",
      artifactTypes: [artifactType(reference)],
      // A path being present in a task's bounded candidate catalog is not
      // evidence that it belongs to every requested knowledge domain. Domain
      // tags must come from an explicit SourceRecord or a later indexer.
      knowledgeDomains: [],
      supportsCriteria: supported,
      status,
      freshness: status === "current" ? "current" : "unknown",
    }));
  }

  const byIdentity = new Map();
  for (const record of catalog) {
    const key = `${record.source_ref}:${record.source_hash}`;
    if (!byIdentity.has(key)) byIdentity.set(key, record);
  }
  return Object.freeze([...byIdentity.values()]
    .sort((left, right) => compareText(`${left.source_ref}:${left.source_id}`, `${right.source_ref}:${right.source_id}`))
    .map((record) => Object.freeze(record)));
}

function intersects(left, right) {
  const values = new Set(left);
  return right.some((value) => values.has(value));
}

function isExcluded(record, requirement) {
  return requirement.must_exclude.some((entry) => (
    entry === record.source_id
    || entry === record.source_ref
    || entry === record.source_type
    || entry === record.status
  ));
}

function relevance(record, requirement) {
  const mandatory = requirement.must_include.includes(record.source_id)
    || requirement.must_include.includes(record.source_ref);
  const criterionMatches = record.supports_criteria.length;
  const domainMatch = intersects(record.knowledge_domains, requirement.knowledge_domains);
  const artifactMatch = intersects(record.artifact_types, requirement.artifact_types);
  if (!mandatory && criterionMatches === 0 && !domainMatch && !artifactMatch) {
    return { mandatory: false, score: -1 };
  }
  let score = mandatory ? 10_000 : 0;
  score += criterionMatches * 500;
  if (domainMatch) score += 100;
  if (artifactMatch) score += 75;
  if (record.authority === "canonical") score += 40;
  else if (record.authority === "accepted") score += 30;
  else if (record.authority === "workspace") score += 20;
  if (record.freshness === "current") score += 25;
  score -= Math.min(record.token_estimate, 10_000) / 10_000;
  return { mandatory, score };
}

function compileContextPackV2Shadow({
  taskIntent,
  taskEnvelope,
  contextRequirement,
  agentCapabilityProfile,
  sourceCatalog,
} = {}) {
  const intent = clone(assertContract("task-intent", taskIntent));
  const envelope = clone(assertContract("task-envelope", taskEnvelope));
  const requirement = clone(assertContract("context-requirement", contextRequirement));
  const capability = clone(assertContract("agent-capability-profile", agentCapabilityProfile));
  if (intent.task_intent_id !== envelope.task_intent_id
    || intent.task_intent_id !== requirement.task_intent_id
    || envelope.task_envelope_id !== requirement.task_envelope_id) {
    throw new TypeError("Context Pack V2 inputs must bind the same task and envelope.");
  }
  const catalog = sourceCatalog.map((record) => clone(assertContract("source-record", record)));
  const candidates = [];
  const omitted = [];
  for (const record of catalog) {
    if (isExcluded(record, requirement)) {
      omitted.push({ source_id: record.source_id, reason: "excluded" });
      continue;
    }
    if (record.status === "superseded") {
      omitted.push({ source_id: record.source_id, reason: "superseded" });
      continue;
    }
    if (record.status === "missing") continue;
    if (record.status === "stale" && requirement.freshness === "current") {
      omitted.push({ source_id: record.source_id, reason: "stale" });
      continue;
    }
    candidates.push({ record, ...relevance(record, requirement) });
  }
  candidates.sort((left, right) => (
    Number(right.mandatory) - Number(left.mandatory)
    || right.score - left.score
    || compareText(left.record.source_ref, right.record.source_ref)
  ));

  const deduplicated = [];
  const seenHashes = new Set();
  for (const candidate of candidates) {
    if (seenHashes.has(candidate.record.source_hash)) {
      omitted.push({ source_id: candidate.record.source_id, reason: "duplicate" });
      continue;
    }
    seenHashes.add(candidate.record.source_hash);
    deduplicated.push(candidate);
  }

  const selected = [];
  let selectedTokens = 0;
  let mandatoryTokens = 0;
  for (const candidate of deduplicated) {
    if (candidate.mandatory) {
      selected.push(candidate.record);
      selectedTokens += candidate.record.token_estimate;
      mandatoryTokens += candidate.record.token_estimate;
      continue;
    }
    if (candidate.score <= 0) {
      omitted.push({ source_id: candidate.record.source_id, reason: "low_relevance" });
      continue;
    }
    if (selectedTokens + candidate.record.token_estimate > requirement.initial_token_budget) {
      omitted.push({ source_id: candidate.record.source_id, reason: "budget" });
      continue;
    }
    selected.push(candidate.record);
    selectedTokens += candidate.record.token_estimate;
  }
  const selectedIds = new Set(selected.map((record) => record.source_id));
  const coverageMatrix = intent.acceptance_criteria.map((_, index) => {
    const criterionId = `acceptance:${index + 1}`;
    const supporting = selected
      .filter((record) => record.supports_criteria.includes(criterionId))
      .map((record) => record.source_ref)
      .sort(compareText);
    const known = catalog.some((record) => record.supports_criteria.includes(criterionId));
    return {
      criterion_id: criterionId,
      status: supporting.length ? "covered" : known ? "partial" : "uncovered",
      source_refs: supporting,
    };
  });
  const staleIds = selected
    .filter((record) => record.freshness !== "current" || record.status === "stale")
    .map((record) => record.source_id)
    .sort(compareText);
  const omittedTokens = catalog
    .filter((record) => !selectedIds.has(record.source_id))
    .reduce((total, record) => total + record.token_estimate, 0);
  const incomplete = coverageMatrix.some((entry) => entry.status !== "covered");
  const mandatoryOverflow = Math.max(0, mandatoryTokens - requirement.initial_token_budget);
  const fallbackReason = mandatoryOverflow > 0
    ? "mandatory_context_exceeds_initial_budget"
    : incomplete ? "acceptance_coverage_incomplete" : null;
  const provenance = selected.map((record) => ({
    source_ref: record.source_ref,
    source_hash: record.source_hash,
    reason: requirement.must_include.includes(record.source_ref) || requirement.must_include.includes(record.source_id)
      ? "must_include"
      : record.supports_criteria.length ? "acceptance_coverage" : "relevance_rank",
  })).sort((left, right) => compareText(left.source_ref, right.source_ref));
  const content = {
    version: 2,
    requirement_id: requirement.requirement_id,
    task_intent_id: intent.task_intent_id,
    task_envelope_id: envelope.task_envelope_id,
    owner_agent_id: capability.agent_id,
    status: "shadow",
    pack_layers: [
      { layer: "universal_contract", source_refs: ["contract:universal-operating-v2"] },
      { layer: "task_envelope", source_refs: [`task_envelope:${envelope.task_envelope_id}`] },
      { layer: "capability_slice", source_refs: [`agent-capability:${capability.agent_id}`] },
      { layer: "project_sources", source_refs: selected.map((record) => record.source_ref).sort(compareText) },
    ],
    selected_sources: selected.map((record) => record.source_id).sort(compareText),
    coverage_matrix: coverageMatrix,
    budget_receipt: {
      initial_budget: requirement.initial_token_budget,
      selected_tokens: selectedTokens,
      omitted_tokens: omittedTokens,
      mandatory_overflow: mandatoryOverflow,
    },
    retrieval_permissions: {
      search: true,
      open: true,
      expand: requirement.expansion_budget > 0,
      explain: true,
      max_expansion_tokens: requirement.expansion_budget,
    },
    staleness: {
      state: staleIds.length ? "contains_stale" : "current",
      stale_source_ids: staleIds,
    },
    omitted_context: omitted
      .sort((left, right) => compareText(`${left.source_id}:${left.reason}`, `${right.source_id}:${right.reason}`)),
    fallback_reason: fallbackReason,
    provenance,
  };
  const contextPack = assertContract("context-pack-v2", {
    ...content,
    context_pack_id: id("CP2", content),
  });
  return Object.freeze({
    context_pack: Object.freeze(contextPack),
    selected_source_records: Object.freeze(selected.map((record) => Object.freeze(record))),
    shadow_assessment: Object.freeze({
      would_be_ready: fallbackReason === null && staleIds.length === 0,
      fallback_reason: fallbackReason,
    }),
  });
}

function createContextReceiptV2({
  contextPack,
  agentId,
  usedSourceIds = [],
  additionalTokens = 0,
  readEvents = [],
  missingContext = [],
  userCorrections = 0,
  incorrectProjectFacts = 0,
  compactionCount = 0,
  acceptanceResults = [],
  createdAt,
} = {}) {
  const pack = clone(assertContract("context-pack-v2", contextPack));
  const used = sortUnique(usedSourceIds);
  const selected = sortUnique(pack.selected_sources);
  const usedSet = new Set(used);
  const reads = records(readEvents)
    .filter((entry) => typeof entry.source_id === "string" && typeof entry.source_ref === "string")
    .map((entry) => ({
      source_id: entry.source_id,
      source_ref: entry.source_ref,
      bytes: boundedInteger(entry.bytes, 0),
      tokens: boundedInteger(entry.tokens, 0),
      truncated: entry.truncated === true,
    }));
  const content = {
    version: 2,
    context_pack_id: pack.context_pack_id,
    task_intent_id: pack.task_intent_id,
    agent_id: String(agentId || pack.owner_agent_id),
    initial_token_estimate: pack.budget_receipt.selected_tokens,
    additional_tokens: boundedInteger(additionalTokens, 0),
    opened_bytes: reads.reduce((total, entry) => total + entry.bytes, 0),
    opened_tokens: reads.reduce((total, entry) => total + entry.tokens, 0),
    read_events: reads,
    used_source_ids: used,
    unused_source_ids: selected.filter((sourceId) => !usedSet.has(sourceId)),
    missing_context: sortUnique(missingContext),
    user_corrections: boundedInteger(userCorrections, 0),
    incorrect_project_facts: boundedInteger(incorrectProjectFacts, 0),
    compaction_count: boundedInteger(compactionCount, 0),
    acceptance_results: records(acceptanceResults)
      .filter((entry) => typeof entry.criterion_id === "string")
      .map((entry) => ({
        criterion_id: entry.criterion_id,
        status: ["passed", "failed"].includes(entry.status) ? entry.status : "unknown",
        evidence_refs: sortUnique(Array.isArray(entry.evidence_refs) ? entry.evidence_refs : []),
      }))
      .sort((left, right) => compareText(left.criterion_id, right.criterion_id)),
    created_at: createdAt || new Date().toISOString(),
  };
  return Object.freeze(assertContract("context-receipt", {
    ...content,
    receipt_id: id("CE", content),
  }));
}

function createProjectControlPlaneV2({
  projectId,
  revision = 0,
  activeWorkstream = null,
  projectBrief = {},
  userIntent = {},
  workGraph = {},
  organizationMap = {},
  decisionLedger = [],
  riskAndApproval = {},
  backgroundWorkstreams = [],
  updatedAt,
} = {}) {
  return Object.freeze(assertContract("project-control-plane", {
    version: 2,
    project_id: String(projectId || "orquesta-project"),
    revision: boundedInteger(revision, 0),
    active_workstream: activeWorkstream ? clone(activeWorkstream) : null,
    project_brief: clone(object(projectBrief)),
    user_intent: clone(object(userIntent)),
    work_graph: clone(object(workGraph)),
    organization_map: clone(object(organizationMap)),
    decision_ledger: clone(Array.isArray(decisionLedger) ? decisionLedger : []),
    risk_and_approval: clone(object(riskAndApproval)),
    background_workstreams: records(backgroundWorkstreams)
      .map((entry) => ({
        workstream_id: String(entry.workstream_id || ""),
        state: String(entry.state || ""),
        summary: String(entry.summary || ""),
      }))
      .filter((entry) => entry.workstream_id && entry.state && entry.summary)
      .sort((left, right) => compareText(left.workstream_id, right.workstream_id)),
    updated_at: updatedAt || new Date().toISOString(),
  }));
}

module.exports = {
  buildSourceCatalogV2,
  compileContextPackV2Shadow,
  createContextReceiptV2,
  createProjectControlPlaneV2,
  createTaskEnvelopeV2,
  deriveContextRequirementV2,
};
