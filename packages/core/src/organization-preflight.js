"use strict";

const { assertContract, canonicalHash } = require("@orquesta/contracts");

const STAFFING_ORDER = Object.freeze([
  "capability",
  "context_scope",
  "ownership",
  "line",
  "capacity",
  "verification"
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function reasonCodes(values) {
  return [...new Set(values)].sort(compareText);
}

function preflightInput(input) {
  const { prior_decisions, ...content } = input || {};
  return content;
}

function analyzeTaskStructure(input) {
  const items = Array.isArray(input && input.work_items) ? input.work_items : [];
  if (input && input.evidence_complete === false || items.length === 0) {
    return { mode: "deep", selected_action: "blocked_unknown", reason_codes: ["USER_DECISION_REQUIRED"] };
  }
  if (items.some((item) => item && item.independent_deliverable && item.durable)) {
    return { mode: "deep", selected_action: "propose_line", reason_codes: ["INDEPENDENT_DELIVERABLE", "NEW_LINE_CANDIDATE"] };
  }
  const roots = new Set(items.map((item) => item && item.acceptance_root_id).filter(Boolean));
  if (roots.size > 1) {
    return { mode: "deep", selected_action: "split_task", reason_codes: ["MULTIPLE_ACCEPTANCE_ROOTS"] };
  }
  return { mode: "fast", selected_action: "reuse_agent", reason_codes: ["CAPABILITY_MATCH"] };
}

function membershipLine(organization, agentId) {
  const membership = (organization.memberships || []).find((item) => item.agent_id === agentId && item.active_to === null);
  const team = membership && (organization.teams || []).find((item) => item.team_id === membership.team_id);
  return team ? team.line_id : null;
}

function satisfiesNeed(provider, need) {
  return provider && Array.isArray(provider.capability_ids) && provider.capability_ids.includes(need.capability_id);
}

function evaluateStaffing(input, structure = analyzeTaskStructure(input)) {
  if (structure.selected_action !== "reuse_agent") return structure;
  const needs = Array.isArray(input.capability_needs) ? input.capability_needs : [];
  const targetLine = input.work_items && input.work_items[0] && input.work_items[0].line_id;
  const assets = Array.isArray(input.resolved_assets) ? input.resolved_assets : [];
  if (needs.length > 0 && needs.every((need) => assets.some((asset) => satisfiesNeed(asset, need)))) {
    return { mode: "fast", selected_action: "reuse_agent", reason_codes: ["CAPABILITY_MATCH"] };
  }
  if (input.management_loop && input.management_loop.candidate_agent_id && Array.isArray(input.management_loop.evidence_refs) && input.management_loop.evidence_refs.length > 0) {
    return { mode: "deep", selected_action: "assign_lead", reason_codes: ["DEDICATED_LEAD_CANDIDATE"] };
  }
  const profiles = Array.isArray(input.agent_profiles) ? input.agent_profiles : [];
  const matching = profiles.filter((profile) => profile && profile.organization_revision === input.organization.revision
    && profile.availability === "available"
    && needs.every((need) => (profile.capabilities || []).some((capability) => capability.status === "verified" && capability.capability_id === need.capability_id)));
  const sameLine = matching.filter((profile) => membershipLine(input.organization, profile.agent_id) === targetLine);
  if (input.capacity_gap === "durable" && (sameLine.length > 0 || matching.length > 0)) {
    return { mode: "deep", selected_action: "add_member", reason_codes: ["CAPACITY_DURABLE"] };
  }
  if (sameLine.length > 0) return { mode: "fast", selected_action: "reuse_agent", reason_codes: ["CAPABILITY_MATCH"] };
  if (matching.length > 0) return { mode: "deep", selected_action: "add_member", reason_codes: ["CONTEXT_SCOPE_MISMATCH"] };
  return { mode: "deep", selected_action: "add_role", reason_codes: ["CAPABILITY_GAP"] };
}

function proposedLine(input) {
  const item = input.work_items[0];
  const deliverable = item.deliverable_id;
  return {
    line_id: `${deliverable}-line`,
    display_name: deliverable,
    goal: `${deliverable} deliverable`,
    deliverable_ids: [deliverable],
    completion_root_ids: [item.acceptance_root_id],
    scope: [...item.scope_boundaries].sort(compareText),
    owner_agent_id: "orchestrator"
  };
}

function createOrganizationPreflight(input) {
  if (!input || !input.task_intent || !input.organization) throw new TypeError("organization preflight requires task intent and organization state");
  const input_hash = canonicalHash(preflightInput(input));
  const cached = (input.prior_decisions || []).find((decision) => decision
    && decision.input_hash === input_hash
    && decision.organization_revision === input.organization.revision);
  if (cached) return { ...clone(cached), cache_hit: true };
  const structure = analyzeTaskStructure(input);
  const staffing = evaluateStaffing(input, structure);
  const selected_action = staffing.selected_action;
  const lineAction = selected_action === "propose_line";
  const decision = {
    decision_id: `OD-${canonicalHash({ input_hash, organization_revision: input.organization.revision, selected_action }).slice(0, 12)}`,
    task_intent_id: input.task_intent.task_intent_id,
    organization_revision: input.organization.revision,
    input_hash,
    mode: staffing.mode,
    selected_action,
    reason_codes: reasonCodes(staffing.reason_codes),
    requires_user_approval: lineAction,
    approval_state: lineAction ? "pending_user" : "not_required",
    proposed_line: lineAction ? proposedLine(input) : null,
    created_at: input.created_at
  };
  assertContract("organization-decision", decision);
  return { ...decision, cache_hit: false };
}

module.exports = { STAFFING_ORDER, analyzeTaskStructure, evaluateStaffing, createOrganizationPreflight };
