"use strict";

const { assertContract, canonicalHash } = require("@orquesta/contracts");
const { RESPONSIBILITY } = require("@orquesta/audit");
const { createTaskIntent } = require("./task-intent");
const { compileCapabilities } = require("@orquesta/capability-compiler");
const { resolveNeed } = require("@orquesta/capability-resolver");
const { createPhaseReview, decidePhaseReview, redactAttestation, resolutionApprovalTarget } = require("./phase-review");
const { createProjectors, initialProjection } = require("./projectors");

const COMMAND_NAMES = Object.freeze([
  "task-intent.create", "capability.compile", "inventory.refresh-local", "resolution.propose",
  "resolution.approve", "context-pack.preview", "phase-review.request", "phase-review.decide",
]);

function coreError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function eventId(commandId, type, payload) {
  return `EV-${canonicalHash({ command_id: commandId, type, payload }).slice(0, 24)}`;
}

function commandIdentity(command) {
  try {
    return { command_id: command.command_id, name: command.name, payload_hash: canonicalHash(command.payload) };
  } catch {
    throw coreError("CORE_COMMAND_INVALID", "Command payload cannot be canonicalized.");
  }
}

function cleanInventory(inventory) {
  const providers = Array.isArray(inventory && inventory.providers) ? inventory.providers : [];
  const conflicts = Array.isArray(inventory && inventory.conflicts) ? inventory.conflicts : [];
  const cleanedProviders = providers.map((provider) => ({
      provider_id: provider.provider_id, provider_type: provider.provider_type || null, source_uri: provider.source_uri || null,
      source_type: provider.source_type || null, capabilities: Array.isArray(provider.capabilities) ? [...provider.capabilities].sort(compareText) : [],
      trust_tier: provider.trust_tier || null, availability: provider.availability || null, version: provider.version || null,
      last_verified_at: provider.last_verified_at || null, provider_hash: provider.provider_hash || null,
      evidence_refs: [...new Set(provider.evidence_refs || [])].sort(compareText),
    })).sort((left, right) => compareText(left.provider_id, right.provider_id));
  const cleanedConflicts = conflicts.map((conflict, index) => ({
      conflict_id: typeof conflict === "object" && typeof conflict.conflict_id === "string" ? conflict.conflict_id : `conflict-${index + 1}`,
      kind: typeof conflict === "object" && typeof conflict.kind === "string" ? conflict.kind : null,
    })).sort((left, right) => compareText(left.conflict_id, right.conflict_id));
  const content = {
    version: inventory && inventory.version || 1,
    providers: cleanedProviders,
    conflicts: cleanedConflicts,
  };
  return {
    inventory_id: `INV-${canonicalHash(content).slice(0, 12)}`,
    ...content,
  };
}

function assertVerifiedAttestation(verified, target) {
  if (!verified || !verified.attestation || !verified.actor || verified.actor.type !== "user") {
    throw coreError("CORE_APPROVAL_INVALID", "Approval verifier must return a verified user and attestation.");
  }
  const attestation = verified.attestation;
  if (attestation.target_id !== target.target_id || attestation.target_revision !== target.target_revision
    || attestation.review_packet_hash !== target.review_packet_hash) {
    throw coreError("CORE_APPROVAL_INVALID", "Verified approval does not bind the active target.");
  }
  if (typeof verified.actor.id !== "string" || !verified.actor.id) {
    throw coreError("CORE_APPROVAL_INVALID", "Approval verifier must return a stable verified user id.");
  }
  try {
    return { actor: { type: "user", id: verified.actor.id }, attestation: redactAttestation(attestation, target) };
  } catch (error) {
    throw coreError("CORE_APPROVAL_INVALID", "Approval verifier did not return a valid redacted attestation.", { cause_code: error.code || null });
  }
}

function createCommandBoundary({ eventStore, rules, collectInventory, verifyUserApproval, referenceTime } = {}) {
  if (!eventStore || typeof eventStore.commit !== "function" || typeof eventStore.replay !== "function") {
    throw new TypeError("An EventStore is required.");
  }
  const reducers = createProjectors();
  function replayResult() {
    return eventStore.replay({ reducers, initialState: initialProjection() });
  }
  function replay() {
    return replayResult().state;
  }
  function currentRevision(result) {
    const revision = result && result.watermark && result.watermark.journal_sequence;
    if (!Number.isInteger(revision) || revision < 0) {
      throw coreError("CORE_JOURNAL_WATERMARK_INVALID", "EventStore replay must expose a nonnegative journal watermark.");
    }
    return revision;
  }
  function commit(command, eventRecords, actor = { type: "system", id: "orquesta-core" }, replayed = replayResult()) {
    const state = replayed.state;
    const existing = state.timeline.find((entry) => entry.batch_id === command.command_id);
    const identity = commandIdentity(command);
    const events = (Array.isArray(eventRecords) ? eventRecords : [eventRecords]).map((record) => ({
      ...record,
      payload: { ...record.payload, command_identity: identity },
    }));
    const request = {
      expected_revision: currentRevision(replayed),
      batch_id: command.command_id,
      actor,
      correlation_id: command.command_id,
      events: events.map((record) => ({
        event_id: eventId(command.command_id, record.type, record.payload), schema_version: 1, type: record.type,
        payload: record.payload, evidence_refs: [...new Set(record.evidence_refs || [])].sort(),
      })),
    };
    return eventStore.commit(request);
  }
  function currentIntent(state) {
    const intent = state.task_intents.find((item) => item.task_intent_id === state.current_task_intent_id);
    if (!intent) throw coreError("CORE_TASK_INTENT_REQUIRED", "A TaskIntent must exist before this command.");
    return intent;
  }
  function execute(command) {
    if (!command || typeof command !== "object" || typeof command.command_id !== "string" || !command.command_id
      || typeof command.name !== "string" || !Object.prototype.hasOwnProperty.call(command, "payload")) {
      throw coreError("CORE_COMMAND_INVALID", "Command requires command_id, name, and payload.");
    }
    if (!COMMAND_NAMES.includes(command.name)) throw coreError("CORE_COMMAND_UNKNOWN", "Command is not part of the Phase 1 Core boundary.", { name: command.name });
    const replayed = replayResult();
    const state = replayed.state;
    const identity = commandIdentity(command);
    const existing = state.timeline.find((entry) => entry.batch_id === command.command_id);
    if (existing) {
      if (existing.command_identity && existing.command_identity.name === identity.name && existing.command_identity.payload_hash === identity.payload_hash) {
        return { status: "idempotent", sequence: existing.sequence };
      }
      throw coreError("CORE_COMMAND_ID_CONFLICT", "Command ID was already used with different immutable content.", { command_id: command.command_id });
    }
    if (command.name === "task-intent.create") {
      const task_intent = createTaskIntent(command.payload);
      return commit(command, { type: "task.intent.created", payload: { task_intent, responsibility: "orchestrator" }, evidence_refs: [task_intent.raw_request_ref] }, undefined, replayed);
    }
    if (command.name === "capability.compile") {
      const graph = compileCapabilities({ taskIntent: currentIntent(state), rules });
      return commit(command, [
        ...graph.needs.map((need) => ({ type: "capability.need.declared", payload: { need, responsibility: "orchestrator" }, evidence_refs: [] })),
        { type: "capability.graph.compiled", payload: { graph, responsibility: "orchestrator" }, evidence_refs: [] },
      ], undefined, replayed);
    }
    if (command.name === "inventory.refresh-local") {
      if (typeof collectInventory !== "function") throw coreError("CORE_INVENTORY_UNAVAILABLE", "Local inventory collector is not configured.");
      const inventory = cleanInventory(collectInventory(command.payload));
      const events = inventory.providers.map((provider) => ({ type: "capability.provider.discovered", payload: { provider, responsibility: "scout" }, evidence_refs: provider.evidence_refs }));
      events.push({
        type: "capability.inventory.refreshed",
        payload: {
          inventory_id: inventory.inventory_id,
          provider_ids: inventory.providers.map((provider) => provider.provider_id),
          conflicts: inventory.conflicts,
          responsibility: "scout",
        },
        evidence_refs: [],
      });
      return commit(command, events, undefined, replayed);
    }
    if (command.name === "resolution.propose") {
      const graph = state.capability_graphs.find((item) => item.graph_id === state.current_capability_graph_id);
      const need = graph && graph.needs.find((item) => item.need_id === command.payload.need_id);
      if (!need) throw coreError("CORE_NEED_REQUIRED", "Resolution proposal requires a compiled Capability Need.");
      const discovered = new Map(state.providers.map((provider) => [provider.provider_id, provider]));
      const suppliedCandidates = command.payload.candidates || [];
      const candidates = suppliedCandidates.map((candidate) => {
        if (!candidate || candidate.provider_type === "new_build") {
          throw coreError("CORE_CANDIDATE_NOT_DISCOVERED", "Resolution proposal candidates must be discovered providers; synthetic builds are Resolver-owned.", { provider_id: candidate && candidate.provider_id || null });
        }
        const provider = discovered.get(candidate.provider_id);
        if (!provider) throw coreError("CORE_CANDIDATE_NOT_DISCOVERED", "Resolution proposal candidate was not discovered by local inventory.", { provider_id: candidate && candidate.provider_id || null });
        const candidateEvidence = Array.isArray(candidate.evidence_refs) ? candidate.evidence_refs : [];
        if (candidateEvidence.some((reference) => !provider.evidence_refs.includes(reference))
          || (candidate.source_type && candidate.source_type !== provider.source_type)
          || (candidate.source_uri && candidate.source_uri !== provider.source_uri)) {
          throw coreError("CORE_CANDIDATE_PROVENANCE_CONFLICT", "Resolution proposal candidate conflicts with discovered provider provenance.", { provider_id: candidate.provider_id });
        }
        return { ...candidate, ...provider, evidence_refs: [...provider.evidence_refs] };
      });
      const proposal = resolveNeed({ need, scoutedCandidates: candidates, auditFacts: command.payload.audit_facts || [] });
      const resolutionPayload = {
        resolution: proposal.resolution,
        rejection_reasons: proposal.rejected_candidates.map((candidate) => ({ candidate_id: candidate.candidate_id, why_not_selected: candidate.why_not_selected })),
        responsibility: "orchestrator",
        responsibility_boundary: { ...RESPONSIBILITY },
        scout_skip_reason: proposal.resolution.selected_provider_id && discovered.has(proposal.resolution.selected_provider_id)
          ? "local_inventory_satisfied_need"
          : null,
      };
      return commit(command, [
        ...[...proposal.ranked_candidates, ...proposal.rejected_candidates].map((candidate) => ({
          type: "candidate.evaluated",
          payload: { evaluation: candidate.evaluation, responsibility: "static_audit", responsibility_boundary: { ...RESPONSIBILITY } },
          evidence_refs: [...(discovered.get(candidate.candidate_id)?.evidence_refs || [])],
        })),
        { type: "resolution.proposed", payload: resolutionPayload, evidence_refs: proposal.resolution.evidence_refs },
      ], undefined, replayed);
    }
    if (command.name === "resolution.approve") {
      const resolution = state.resolutions.find((item) => item.resolution_id === command.payload.resolution_id);
      if (!resolution || resolution.status !== "proposed" || resolution.approval_status !== "pending_user") throw coreError("CORE_RESOLUTION_APPROVAL_INVALID", "Only a current proposed Resolution can be approved.");
      const latest = state.latest_resolution_by_need[resolution.need_id];
      if (!latest || latest.resolution_id !== resolution.resolution_id) {
        throw coreError("CORE_RESOLUTION_STALE", "Only the latest proposed Resolution for a Capability Need can be approved.", { resolution_id: resolution.resolution_id, need_id: resolution.need_id });
      }
      const evaluations = state.candidate_evaluations.filter((evaluation) => evaluation.need_id === resolution.need_id);
      if (resolution.selected_provider_id && !evaluations.some((evaluation) => evaluation.candidate_id === resolution.selected_provider_id && evaluation.eligibility === "eligible")) {
        throw coreError("CORE_RESOLUTION_HARD_GATE_FAILED", "Selected provider no longer passes its static hard gates.");
      }
      if (typeof verifyUserApproval !== "function") throw coreError("CORE_APPROVAL_INVALID", "Approval verification is required.");
      const target = { ...resolutionApprovalTarget(resolution, currentRevision(replayed)), candidate_id: resolution.selected_provider_id, mode: resolution.mode, decision: "approved" };
      const verified = assertVerifiedAttestation(verifyUserApproval(command.payload.approval_evidence, target), target);
      return commit(command, { type: "resolution.approved", payload: { resolution_id: resolution.resolution_id, attestation: verified.attestation, proposal_revision: currentRevision(replayed), responsibility: "user" }, evidence_refs: resolution.evidence_refs }, verified.actor, replayed);
    }
    if (command.name === "context-pack.preview") {
      let context_pack;
      try { context_pack = clone(assertContract("context-pack", command.payload.context_pack)); } catch {
        throw coreError("CORE_CONTEXT_PACK_INVALID", "Context Pack preview requires a schema-valid Context Pack.");
      }
      if (context_pack.status !== "draft") throw coreError("CORE_CONTEXT_PACK_NOT_DRAFT", "Only a draft Context Pack may be previewed before approval.");
      return commit(command, { type: "context.pack.created", payload: { context_pack, responsibility: "orchestrator" }, evidence_refs: [] }, undefined, replayed);
    }
    if (command.name === "phase-review.request") {
      const packet = state.artifacts.find((item) => item.artifact_ref === command.payload.review_packet_ref);
      if (!packet || packet.kind !== "phase_review_packet" || packet.artifact_hash !== command.payload.review_packet_hash) {
        throw coreError("CORE_PHASE_PACKET_REQUIRED", "Phase review requires a current review-packet artifact reference and matching hash.");
      }
      const existingCycles = state.phase_reviews.filter((item) => item.phase_id === command.payload.phase_id || item.phase_id.startsWith(`${command.payload.phase_id}:cycle-`));
      const active = existingCycles.find((item) => item.status !== "approved");
      if (active) throw coreError("CORE_PHASE_REVIEW_ACTIVE", "An active Phase Review cycle cannot be replaced.", { phase_id: active.phase_id, status: active.status });
      const revision = currentRevision(replayed);
      const phase_id = existingCycles.length ? `${command.payload.phase_id}:cycle-${revision}` : command.payload.phase_id;
      const review = createPhaseReview({
        phase_id,
        build_ref: command.payload.build_ref,
        review_packet_ref: packet.artifact_ref,
        review_packet_hash: packet.artifact_hash,
        checks: command.payload.checks,
        revision,
      });
      return commit(command, { type: "phase.review.requested", payload: { review, responsibility: "orchestrator" }, evidence_refs: [review.review_packet_ref, review.build_ref] }, undefined, replayed);
    }
    const matchingReviews = state.phase_reviews.filter((item) => item.phase_id === command.payload.phase_id || item.phase_id.startsWith(`${command.payload.phase_id}:cycle-`));
    const review = matchingReviews.sort((left, right) => right.review_cycle_revision - left.review_cycle_revision)[0];
    if (!review) throw coreError("CORE_PHASE_REVIEW_REQUIRED", "A Phase Review must exist before a decision.");
    const requiresUserDecision = command.payload.decision === "approved" || command.payload.decision === "changes_requested";
    const decisionRevision = currentRevision(replayed);
    const target = { target_id: review.phase_id, target_revision: decisionRevision, review_packet_hash: review.review_packet_hash, decision: command.payload.decision };
    const verified = requiresUserDecision
      ? assertVerifiedAttestation(verifyUserApproval && verifyUserApproval(command.payload.approval_evidence, target), target)
      : null;
    const decided = decidePhaseReview({
      review,
      decision: command.payload.decision,
      approval_evidence: command.payload.approval_evidence,
      verifyUserApproval: requiresUserDecision
        ? () => verified
        : undefined,
      revision: requiresUserDecision ? decisionRevision : undefined,
    });
    const eventType = {
      ready_for_user_review: "phase.review.ready_for_user_review",
      changes_requested: "phase.review.changes_requested",
      approved: "phase.review.approved",
    }[decided.status];
    return commit(command, { type: eventType, payload: { review: decided, responsibility: decided.status === "approved" || decided.status === "changes_requested" ? "user" : "orchestrator" }, evidence_refs: [decided.review_packet_ref, decided.build_ref] }, verified ? verified.actor : undefined, replayed);
  }
  return { execute, replay, projectors: reducers, reference_time: referenceTime || null };
}

module.exports = { COMMAND_NAMES, createCommandBoundary, coreError };
