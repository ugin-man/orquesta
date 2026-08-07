"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createExecutionPlan, createTaskIntent, profileTask } = require("../src");

function intent(id, desiredOutcome, acceptanceCriteria = ["Run a deterministic check."]) {
  return createTaskIntent({
    rawRequestRef: `test:${id}`,
    desiredOutcome,
    acceptanceCriteria,
    constraints: [],
    risk: { impact: "medium", reversible: true },
    authorityBoundary: { agent_may: ["write"], user_only: [] },
    assumptions: [],
    status: "compiled"
  });
}

test("profiles five materially different task shapes from explicit evidence", () => {
  const profiles = {
    tiny: profileTask({
      taskIntent: intent("TI-TINY", "Rename one local constant."),
      workItem: { scope_boundaries: ["packages/core/src/example.js"], verification_method: "deterministic" }
    }),
    multiple: profileTask({
      taskIntent: intent("TI-MULTI", "Update setup flow and routing."),
      workItem: { scope_boundaries: ["orquesta/scripts", "packages/core/src"], verification_method: "deterministic" }
    }),
    aesthetic: profileTask({
      taskIntent: intent("TI-AESTHETIC", "Choose an interface direction."),
      workItem: { scope_boundaries: ["apps/desktop"], verification_method: "human_only", control_signals: { ambiguity: "high", aesthetic_judgment: "high" } }
    }),
    external: profileTask({
      taskIntent: intent("TI-EXTERNAL", "Release an approved artifact."),
      workItem: { scope_boundaries: ["release"], effects: ["public_release"], verification_method: "mixed" }
    }),
    repeated: profileTask({
      taskIntent: intent("TI-REPEATED", "Repair a focused local check."),
      workItem: { scope_boundaries: ["orquesta/scripts"], verification_method: "deterministic" },
      failureHistory: [{ kind: "failed_check" }, { kind: "failed_check" }]
    })
  };

  assert.equal(createExecutionPlan({ taskIntent: intent("TI-TINY", "Rename one local constant."), riskProfile: profiles.tiny.risk_profile }).lane, "fast");
  assert.equal(createExecutionPlan({ taskIntent: intent("TI-MULTI", "Update setup and routing."), riskProfile: profiles.multiple.risk_profile }).lane, "standard");
  assert.equal(profiles.multiple.risk_profile.scope, "multiple_boundaries");
  assert.equal(profiles.aesthetic.control_signals.ambiguity, "high");
  assert.equal(profiles.aesthetic.control_signals.aesthetic_judgment, "high");
  assert.equal(profiles.aesthetic.risk_profile.verification, "human_only");
  assert.equal(createExecutionPlan({ taskIntent: intent("TI-EXTERNAL", "Release an approved artifact."), riskProfile: profiles.external.risk_profile }).lane, "critical");
  assert.ok(profiles.external.risk_profile.effects.includes("public_release"));
  assert.equal(profiles.repeated.risk_profile.repeated_failures, 2);
  assert.equal(profiles.repeated.control_signals.failure_history, "high");
  assert.ok(profiles.tiny.reason_codes.includes("explicit:work_item.verification_method"));
  assert.ok(profiles.tiny.evidence_refs.some((item) => item.startsWith("task_intent:TI-")));
  assert.equal(profiles.tiny.context_v2_mode, "limited");
  assert.ok(profiles.tiny.reason_codes.includes("context_v2:limited"));
  assert.equal(profiles.tiny.task_envelope.execution.execution_channel, "product_implementation");
  assert.equal(profiles.tiny.context_requirement.project_scope, "local");
  assert.ok(profiles.tiny.evidence_refs.some((item) => item.startsWith("context_requirement:CR-")));
});

test("requires a task intent and raises uncertainty when evidence is absent", () => {
  assert.throws(() => profileTask({ workItem: {} }), /taskIntent/);
  const profile = profileTask({ taskIntent: intent("TI-UNKNOWN", "Do work.") });
  assert.equal(profile.risk_profile.uncertainty, "high");
  assert.ok(profile.reason_codes.includes("inferred:missing_scope"));
  assert.ok(profile.evidence_refs.includes("inference:insufficient_explicit_evidence"));
  assert.equal(profile.context_requirement.project_scope, "none");
  assert.equal(profile.reuse_discovery.status, "semantic_decomposition_required");
});

test("profiles a structured reusable capability as local-first", () => {
  const capabilityNeeds = [{
    need_id: "CN-ui-assets",
    description: "再利用可能なデスクトップUI部品",
    kind: "asset",
    required_level: "required",
    hard_constraints: [],
    dependencies: [],
    verification_method: "候補の見た目とlicenseを確認する",
    status: "open",
    confidence: 90,
    acquisition_mode: "external_if_missing",
  }];
  const profile = profileTask({
    taskIntent: intent("TI-REUSE", "管理画面を作る"),
    workItem: { scope_boundaries: ["apps/desktop"], verification_method: "mixed" },
    capabilityNeeds,
  });
  assert.equal(profile.reuse_discovery.status, "local_inventory_required");
  assert.equal(profile.reuse_discovery.need_routes[0].action, "inspect_local");
  assert.ok(profile.evidence_refs.includes("capability_needs:provided"));
});

test("honors explicit task intent risk and records general semantic inferences", () => {
  const critical = profileTask({
    taskIntent: createTaskIntent({
      rawRequestRef: "test:read-only",
      desiredOutcome: "Inspect a record.",
      acceptanceCriteria: ["Read the result."],
      constraints: [],
      risk: { impact: "medium", reversible: true },
      authorityBoundary: { agent_may: ["read"], user_only: [] },
      assumptions: [],
      status: "compiled"
    }),
    workItem: {
      scope_boundaries: ["records"],
      verification_method: "deterministic",
      control_signals: { consequence: "low", reversibility: "low" }
    }
  });
  const explicit = profileTask({
    taskIntent: createTaskIntent({
      rawRequestRef: "test:explicit-risk",
      desiredOutcome: "Inspect a local record.",
      acceptanceCriteria: ["Read the result."],
      constraints: [],
      risk: { impact: "high", reversible: false },
      authorityBoundary: { agent_may: ["read"], user_only: [] },
      assumptions: [],
      status: "compiled"
    }),
    workItem: { scope_boundaries: ["records"], verification_method: "deterministic" }
  });
  const inferred = profileTask({
    taskIntent: intent("TI-INFER", "Deploy an approved release to public production.", ["Obtain human visual review."]),
    workItem: { scope_boundaries: ["output"] }
  });

  assert.ok(critical.risk_profile.effects.includes("local_read"));
  assert.ok(!critical.risk_profile.effects.includes("workspace_write"));
  assert.equal(explicit.risk_profile.reversibility, "irreversible");
  assert.equal(explicit.control_signals.consequence, "high");
  assert.equal(explicit.control_signals.reversibility, "high");
  assert.ok(explicit.reason_codes.includes("explicit:task_intent.risk.impact"));
  assert.ok(inferred.risk_profile.effects.includes("public_release"));
  assert.equal(inferred.recommended_work_mode, "semantic_decision");
  assert.ok(inferred.reason_codes.includes("semantic_judgment"));
  assert.throws(() => profileTask({
    taskIntent: intent("TI-PATH", "Inspect a local record."),
    workItem: { context_manifest: { allowed_files: ["../outside"] } }
  }), /relative safe path/);
});

test("requires action-plus-target evidence for critical inferred effects", () => {
  const internalReport = profileTask({
    taskIntent: intent("TI-INTERNAL", "Analyze token usage and send a report to the orchestrator."),
    workItem: { scope_boundaries: ["reports"], verification_method: "deterministic" }
  });
  const localProductionEdit = profileTask({
    taskIntent: intent("TI-LOCAL", "Update production source code locally without deploying."),
    workItem: { scope_boundaries: ["src"], verification_method: "deterministic" }
  });
  const localRemoval = profileTask({
    taskIntent: intent("TI-REMOVE", "Remove an obsolete local constant."),
    workItem: { scope_boundaries: ["src"], verification_method: "deterministic" }
  });
  const publicDeployment = profileTask({
    taskIntent: intent("TI-DEPLOY", "Deploy a release to public production."),
    workItem: { scope_boundaries: ["release"], verification_method: "mixed" }
  });
  const publicDeploymentFloor = profileTask({
    taskIntent: intent("TI-DEPLOY-FLOOR", "Deploy a release to public production."),
    workItem: { scope_boundaries: ["release"], effects: ["local_read"], verification_method: "deterministic" }
  });
  const externalWriteFloor = profileTask({
    taskIntent: intent("TI-EXTERNAL-FLOOR", "Send an approved record to an external service."),
    workItem: { scope_boundaries: ["records"], effects: ["local_read"], verification_method: "deterministic" }
  });

  for (const profile of [internalReport, localProductionEdit, localRemoval]) {
    assert.ok(!profile.risk_profile.effects.includes("external_write"));
    assert.ok(!profile.risk_profile.effects.includes("credential_access"));
    assert.ok(!profile.risk_profile.effects.includes("public_release"));
    assert.notEqual(createExecutionPlan({ taskIntent: intent(`TI-CHECK-${profile.evidence_refs[0]}`, "Inspect a local record."), riskProfile: profile.risk_profile }).lane, "critical");
  }
  assert.ok(publicDeployment.risk_profile.effects.includes("public_release"));
  for (const [profile, effect] of [[publicDeploymentFloor, "public_release"], [externalWriteFloor, "external_write"]]) {
    assert.ok(profile.risk_profile.effects.includes(effect));
    assert.equal(createExecutionPlan({ taskIntent: intent(`TI-FLOOR-${effect}`, "Inspect a local record."), riskProfile: profile.risk_profile }).lane, "critical");
    assert.ok(profile.reason_codes.includes(`inferred:critical_semantic_floor:${effect}`));
    assert.ok(profile.evidence_refs.includes("task_intent:critical_semantic_effect_inference"));
  }
});

test("execution channels use explicit structured modes instead of substring keyword routing", () => {
  const unusualIntent = intent("TI-UNUSUAL", "Produce an unusual specialist artifact.", ["The artifact is complete."]);
  const unknown = profileTask({
    taskIntent: unusualIntent,
    workItem: { work_mode: "post_operation_story_review", scope_boundaries: ["artifact"] }
  });
  assert.equal(unknown.task_envelope.execution.execution_channel, "product_implementation");

  const explicit = profileTask({
    taskIntent: unusualIntent,
    workItem: {
      work_mode: "post_operation_story_review",
      execution_channel: "creative_production",
      scope_boundaries: ["artifact"]
    }
  });
  assert.equal(explicit.task_envelope.execution.execution_channel, "creative_production");
});
