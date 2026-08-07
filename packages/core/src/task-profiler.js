"use strict";

const { assertContract } = require("@orquesta/contracts");
const { createTaskEnvelopeV2, deriveContextRequirementV2 } = require("@orquesta/context-compiler");
const { planReuseDiscovery } = require("./reuse-discovery");

const SIGNAL_NAMES = [
  "ambiguity", "consequence", "reversibility", "context_breadth",
  "aesthetic_judgment", "verifiability", "novelty", "failure_history"
];
const LEVELS = new Set(["low", "medium", "high"]);
const VERIFICATION_METHODS = new Set(["deterministic", "mixed", "human_only"]);
const EXECUTION_CHANNEL_BY_MODE = Object.freeze({
  audit: "independent_review",
  coordination: "coordination",
  creative: "creative_production",
  exploration: "research",
  implementation: "product_implementation",
  live_operation: "live_operation",
  operation: "live_operation",
  orchestration: "coordination",
  report_only: "independent_review",
  research: "research",
  review: "independent_review",
  semantic_decision: "coordination",
  visual: "creative_production",
  worldbuilding: "creative_production",
});
const CRITICAL_EFFECTS = new Set([
  "external_write", "public_release", "credential_access", "payment", "destructive_operation", "data_migration", "security_boundary"
]);

function level(value, fallback) {
  const normalized = String(value || "").toLowerCase();
  return LEVELS.has(normalized) ? normalized : fallback;
}

function list(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()) : [];
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safePaths(value) {
  const paths = list(value);
  for (const item of paths) {
    if (item !== "." && (item.startsWith("/") || item.startsWith("\\") || /^[a-zA-Z]:[\\/]/.test(item) || item.split(/[\\/]/).includes(".."))) {
      throw new TypeError("context manifest paths must be relative safe paths");
    }
  }
  return paths;
}

function textOf(intent) {
  const authority = intent.authority_boundary || {};
  return [
    intent.desired_outcome,
    ...list(intent.acceptance_criteria),
    ...list(intent.constraints),
    ...list(authority.agent_may)
  ].join(" ").toLowerCase();
}

function inferEffects(text) {
  const effects = [];
  const publicAction = /\b(publish|release|deploy)\b|公開|配備/u.test(text);
  const publicTarget = /\b(public|production)\b|公開環境|本番環境/u.test(text);
  const externalAction = /\b(submit|send|post|upload)\b|提出|送信|投稿|アップロード/u.test(text);
  const externalTarget = /\b(external|third[- ]party|remote service|outside organization)\b|外部サービス|第三者/u.test(text);
  const credentialAction = /\b(access|read|use|rotate)\b|アクセス|参照|利用|更新/u.test(text);
  const credentialTarget = /\b(credential|password|secret|api key|access token)\b|認証情報|資格情報|パスワード|秘密鍵/u.test(text);
  if (publicAction && publicTarget) effects.push("public_release");
  if (externalAction && externalTarget) effects.push("external_write");
  if (/(\bdrop\b|\bwipe\b|\bpurge\b|destructive operation|production[- ]data deletion|本番データ.*削除|不可逆.*削除|破棄|移行)/u.test(text)) effects.push("destructive_operation");
  if (credentialAction && credentialTarget) effects.push("credential_access");
  if (/(payment|charge|refund|決済|支払|返金)/u.test(text)) effects.push("payment");
  if (/(write|edit|modify|create|implement|update|rename|修正|作成|実装|更新|記録|変更|追加)/u.test(text)) effects.push("workspace_write");
  if (!effects.length && /(read|inspect|review|audit|analy[sz]e|確認|調査|監査|閲覧)/u.test(text)) effects.push("local_read");
  return [...new Set(effects)].sort();
}

function inferVerification(text) {
  const human = /(human|user|visual|aesthetic|design|taste|人間|利用者|視覚|審美|デザイン)/u.test(text);
  const deterministic = /(test|check|assert|validat|lint|テスト|検証|確認)/u.test(text);
  if (human && deterministic) return "mixed";
  if (human) return "human_only";
  if (deterministic) return "deterministic";
  return null;
}

function executionChannel(work) {
  if (typeof work.execution_channel === "string") return work.execution_channel;
  const mode = String(work.work_mode || "").toLowerCase();
  return EXECUTION_CHANNEL_BY_MODE[mode] || "product_implementation";
}

function profileTask({ taskIntent, workItem = {}, projectUnderstanding = {}, capabilityNeeds = [], localInventory = null, failureHistory = [] } = {}) {
  if (!taskIntent) throw new TypeError("taskIntent is required");
  const intent = assertContract("task-intent", taskIntent);
  const work = workItem && typeof workItem === "object" && !Array.isArray(workItem) ? workItem : {};
  const project = projectUnderstanding && typeof projectUnderstanding === "object" && !Array.isArray(projectUnderstanding) ? projectUnderstanding : {};
  const reasons = [];
  const evidence = [`task_intent:${intent.task_intent_id}`];
  const scopes = safePaths(work.scope_boundaries);
  const text = textOf(intent);
  const explicitEffects = list(work.effects);
  const inferredEffects = inferEffects(text);
  const criticalSemanticFloor = explicitEffects.length
    ? inferredEffects.filter((effect) => CRITICAL_EFFECTS.has(effect))
    : [];
  const effects = explicitEffects.length
    ? [...new Set([...explicitEffects, ...criticalSemanticFloor])].sort()
    : inferredEffects;
  const verificationMethod = VERIFICATION_METHODS.has(work.verification_method) ? work.verification_method : null;
  const inferredVerification = verificationMethod ? null : inferVerification(text);
  const explicitSignals = work.control_signals && typeof work.control_signals === "object" ? work.control_signals : {};
  const failures = Array.isArray(failureHistory) ? failureHistory.length : Number.isInteger(failureHistory) && failureHistory > 0 ? failureHistory : 0;

  if (scopes.length) {
    reasons.push("explicit:work_item.scope_boundaries");
    evidence.push("work_item:scope_boundaries");
  } else {
    reasons.push("inferred:missing_scope");
    evidence.push("inference:insufficient_explicit_evidence");
  }
  if (effects.length) {
    if (explicitEffects.length) {
      reasons.push("explicit:work_item.effects");
      evidence.push("work_item:effects");
      if (criticalSemanticFloor.length) {
        reasons.push(...criticalSemanticFloor.map((effect) => `inferred:critical_semantic_floor:${effect}`));
        evidence.push("task_intent:critical_semantic_effect_inference");
      }
    } else {
      reasons.push(...effects.map((effect) => `inferred:effect:${effect}`));
      evidence.push("task_intent:semantic_effect_inference");
    }
  }
  if (verificationMethod) {
    reasons.push("explicit:work_item.verification_method");
    evidence.push("work_item:verification_method");
  } else if (inferredVerification) {
    reasons.push(`inferred:verification:${inferredVerification}`);
    evidence.push("task_intent:semantic_verification_inference");
  } else {
    reasons.push("inferred:missing_verification_method");
    evidence.push("inference:insufficient_explicit_evidence");
  }
  if (Object.keys(explicitSignals).length) {
    reasons.push("explicit:work_item.control_signals");
    evidence.push("work_item:control_signals");
  }
  if (project.goal || project.stack || project.evidence) evidence.push("project_understanding:provided");
  if (Array.isArray(capabilityNeeds) && capabilityNeeds.length) evidence.push("capability_needs:provided");
  if (failures > 0) {
    reasons.push("explicit:failure_history");
    reasons.push("failure_escalation");
    evidence.push("failure_history:provided");
  }

  const verification = verificationMethod || inferredVerification || "mixed";
  const scope = scopes.length > 1 || scopes.includes(".") ? "multiple_boundaries" : "single_boundary";
  const explicitRisk = intent.risk || {};
  if (explicitRisk.impact) {
    reasons.push("explicit:task_intent.risk.impact");
    evidence.push("task_intent:risk.impact");
  }
  if (explicitRisk.reversible === false) {
    reasons.push("explicit:task_intent.risk.reversible");
    evidence.push("task_intent:risk.reversible");
  }
  const uncertainty = scopes.length && (verificationMethod || inferredVerification) ? "low" : "high";
  const controlSignals = Object.fromEntries(SIGNAL_NAMES.map((name) => [name, "low"]));
  controlSignals.context_breadth = scope === "multiple_boundaries" ? "high" : "low";
  controlSignals.verifiability = verification === "deterministic" ? "high" : verification === "mixed" ? "medium" : "low";
  controlSignals.ambiguity = uncertainty === "high" ? "high" : "low";
  controlSignals.failure_history = failures >= 2 ? "high" : failures === 1 ? "medium" : "low";
  const inferredSemantic = /(visual|aesthetic|design|taste|direction|方針|審美|デザイン|視覚)/u.test(text);
  if (inferredSemantic) {
    controlSignals.aesthetic_judgment = "high";
    reasons.push("inferred:semantic_judgment");
    evidence.push("task_intent:semantic_judgment_inference");
  }
  for (const name of SIGNAL_NAMES) {
    if (explicitSignals[name] !== undefined) controlSignals[name] = level(explicitSignals[name], controlSignals[name]);
  }
  if (explicitRisk.impact === "high") controlSignals.consequence = "high";
  else if (explicitRisk.impact === "medium" && controlSignals.consequence === "low") controlSignals.consequence = "medium";
  if (explicitRisk.reversible === false) controlSignals.reversibility = "high";

  const critical = effects.some((effect) => CRITICAL_EFFECTS.has(effect));
  if (critical) {
    controlSignals.consequence = "high";
    reasons.push(...effects.filter((effect) => CRITICAL_EFFECTS.has(effect)).map((effect) => `critical_effect:${effect}`));
  }
  const semantic = controlSignals.ambiguity === "high" || controlSignals.aesthetic_judgment === "high";
  if (semantic) reasons.push("semantic_judgment");
  const contextManifest = work.context_manifest && typeof work.context_manifest === "object" ? work.context_manifest : {};
  const requiredReading = safePaths(contextManifest.required_reading);
  const allowedFiles = safePaths(contextManifest.allowed_files);
  const excludedContext = list(contextManifest.excluded_context);
  const suppliedEnvelope = object(work.task_envelope);
  const suppliedEnvelopeExecution = object(suppliedEnvelope.execution);
  const envelopeOptions = {
    ...suppliedEnvelope,
    execution_channel: suppliedEnvelopeExecution.execution_channel
      || suppliedEnvelope.execution_channel
      || executionChannel(work),
    conversation_history_policy: suppliedEnvelopeExecution.conversation_history_policy
      || suppliedEnvelope.conversation_history_policy,
  };
  const taskEnvelope = createTaskEnvelopeV2({ taskIntent: intent, options: envelopeOptions });
  const contextRequirement = deriveContextRequirementV2({
    taskIntent: intent,
    taskEnvelope,
    workItem: {
      ...work,
      context_manifest: {
        required_reading: requiredReading.length ? requiredReading : ["canonical_task_record", ...scopes],
        allowed_files: allowedFiles.length ? allowedFiles : scopes,
        excluded_context: excludedContext.length ? excludedContext : ["unrelated_project_context"],
        missing_context_behavior: contextManifest.missing_context_behavior || "needs_context"
      }
    },
    capabilityNeeds
  });
  const reuseDiscovery = planReuseDiscovery({ capabilityNeeds, localInventory });

  return Object.freeze({
    version: 1,
    recommended_work_mode: semantic ? "semantic_decision" : String(work.work_mode || "implementation"),
    risk_profile: {
      reversibility: explicitRisk.reversible === false || critical ? "irreversible" : "easy",
      scope,
      verification,
      uncertainty,
      effects: effects.length ? effects : ["local_read"],
      repeated_failures: failures,
      user_review: critical || explicitRisk.impact === "high" ? "strict" : "default"
    },
    control_signals: controlSignals,
    context_manifest: {
      required_reading: requiredReading.length ? requiredReading : ["canonical_task_record", ...scopes],
      allowed_files: allowedFiles.length ? allowedFiles : scopes,
      excluded_context: excludedContext.length ? excludedContext : ["unrelated_project_context"],
      missing_context_behavior: contextManifest.missing_context_behavior || "needs_context"
    },
    task_envelope: taskEnvelope,
    context_requirement: contextRequirement,
    reuse_discovery: reuseDiscovery,
    context_v2_mode: "limited",
    reason_codes: [...new Set([...reasons, "context_v2:limited"])].sort(),
    evidence_refs: [...new Set([
      ...evidence,
      `task_envelope:${taskEnvelope.task_envelope_id}`,
      `context_requirement:${contextRequirement.requirement_id}`
    ])].sort()
  });
}

module.exports = { profileTask };
