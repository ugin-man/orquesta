"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createOrganizationState } = require("../src/organization-model");
const { analyzeTaskStructure, createOrganizationPreflight, evaluateStaffing, STAFFING_ORDER } = require("../src/organization-preflight");

const timestamp = "2026-07-20T00:00:00.000Z";

function organization() {
  return createOrganizationState({
    revision: 3,
    agents: [
      { agent_id: "orchestrator", role_id: "orchestrator", organization_scope: "project", lifecycle_state: "active", operational_status: "working" },
      { agent_id: "implementation-001", role_id: "implementation", organization_scope: "line", lifecycle_state: "active", operational_status: "working" }
    ],
    teams: [{ team_id: "desktop-implementation", line_id: "desktop-line", display_name: "Desktop implementation", purpose: "Desktop work", lifecycle_state: "active" }],
    memberships: [{ membership_id: "membership-implementation", agent_id: "implementation-001", team_id: "desktop-implementation", position: "member", ordinal: 1, active_from: timestamp, active_to: null }],
    relationships: [],
    lines: [{ line_id: "desktop-line", display_name: "Desktop", goal: "Desktop deliverable", deliverable_ids: ["desktop"], completion_root_ids: ["CM-DESKTOP"], scope: ["apps/orquesta-desktop"], owner_agent_id: "orchestrator", dedicated_lead_agent_id: null, status: "active", approval_source: "setup_confirmation" }]
  });
}

function input(overrides = {}) {
  return {
    task_intent: { task_intent_id: "TI-0123456789ab" },
    organization: organization(),
    work_items: [{ work_item_id: "work-desktop", acceptance_root_id: "CM-DESKTOP", deliverable_id: "desktop", line_id: "desktop-line", scope_boundaries: ["apps/orquesta-desktop"], durable: true }],
    capability_needs: [{ need_id: "need-code", capability_id: "code.change", role_id: "implementation", verification_method: "node:test" }],
    agent_profiles: [{ agent_id: "implementation-001", availability: "available", organization_revision: 3, capabilities: [{ capability_id: "code.change", status: "verified", evidence_refs: ["evidence:code"], scope: ["apps/orquesta-desktop"] }] }],
    resolved_assets: [],
    prior_decisions: [],
    created_at: timestamp,
    ...overrides
  };
}

test("organization preflight uses the required deterministic action matrix", () => {
  const cases = [
    ["matching agent", input(), "reuse_agent", false],
    ["two acceptance roots", input({ work_items: [
      { work_item_id: "work-desktop", acceptance_root_id: "CM-DESKTOP", deliverable_id: "desktop", line_id: "desktop-line", scope_boundaries: ["apps/orquesta-desktop"], durable: true },
      { work_item_id: "work-core", acceptance_root_id: "CM-CORE", deliverable_id: "core", line_id: "desktop-line", scope_boundaries: ["packages/core"], durable: true }
    ] }), "split_task", false],
    ["durable capacity gap", input({ capacity_gap: "durable" }), "add_member", false],
    ["new capability in existing line", input({ agent_profiles: [], capability_needs: [{ need_id: "need-research", capability_id: "research.primary", role_id: "research", verification_method: "source review" }] }), "add_role", false],
    ["closed management loop", input({ management_loop: { candidate_agent_id: "implementation-001", evidence_refs: ["evidence:lead"] } }), "assign_lead", false],
    ["independent durable deliverable", input({ work_items: [{ work_item_id: "work-core", acceptance_root_id: "CM-CORE", deliverable_id: "core", line_id: null, scope_boundaries: ["packages/core"], durable: true, independent_deliverable: true }] }), "propose_line", true],
    ["missing evidence", input({ evidence_complete: false }), "blocked_unknown", false]
  ];
  for (const [name, fixture, action, approval] of cases) {
    const decision = createOrganizationPreflight(fixture);
    assert.equal(decision.selected_action, action, name);
    assert.equal(decision.requires_user_approval, approval, name);
    assert.equal(Object.hasOwn(decision, "temporary_assignment"), false, name);
  }
});

test("preflight chooses resolved assets first and reuses an unchanged decision", () => {
  const assetInput = input({
    agent_profiles: [],
    resolved_assets: [{ provider_id: "asset:local-helper", capability_ids: ["code.change"], evidence_refs: ["asset:helper"] }]
  });
  assert.equal(evaluateStaffing(assetInput, analyzeTaskStructure(assetInput)).selected_action, "reuse_agent");

  const first = createOrganizationPreflight(input());
  const cached = createOrganizationPreflight(input({ prior_decisions: [first] }));
  assert.equal(cached.cache_hit, true);
  assert.equal(cached.decision_id, first.decision_id);
  assert.deepEqual(STAFFING_ORDER, ["capability", "context_scope", "ownership", "line", "capacity", "verification"]);
});

test("preflight never creates a cross-line temporary assignment", () => {
  const crossLine = input({ work_items: [{ work_item_id: "work-core", acceptance_root_id: "CM-CORE", deliverable_id: "core", line_id: "core-line", scope_boundaries: ["packages/core"], durable: true }] });
  const decision = createOrganizationPreflight(crossLine);
  assert.equal(decision.selected_action, "add_member");
  assert.equal(JSON.stringify(decision).includes("temporary_assignment"), false);
});

test("an independent deliverable already assigned to an active line does not propose another line", () => {
  const existingLine = input({ work_items: [{
    work_item_id: "work-desktop",
    acceptance_root_id: "CM-DESKTOP",
    deliverable_id: "desktop",
    line_id: "desktop-line",
    scope_boundaries: ["apps/orquesta-desktop"],
    durable: true,
    independent_deliverable: true
  }] });

  const decision = createOrganizationPreflight(existingLine);

  assert.equal(decision.selected_action, "reuse_agent");
  assert.equal(decision.requires_user_approval, false);
});
