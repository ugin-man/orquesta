"use strict";

const { assertContract, canonicalJson, canonicalHash } = require("@orquesta/contracts");
const { RESPONSIBILITY } = require("@orquesta/audit");
const { createTaskIntent } = require("./task-intent");
const { compileCapabilities } = require("@orquesta/capability-compiler");
const { resolveNeed } = require("@orquesta/capability-resolver");
const { createPhaseReview, decidePhaseReview, redactAttestation, resolutionApprovalTarget } = require("./phase-review");
const { createProjectors, initialProjection } = require("./projectors");
const { createExecutionPlan, escalateExecutionPlan } = require("./execution-policy");
const { createInstallApprovalTarget } = require("./install-approval");

const COMMAND_NAMES = Object.freeze([
  "task-intent.create", "capability.compile", "execution-plan.create", "execution-plan.escalate", "inventory.refresh-local", "resolution.propose",
  "resolution.approve", "context-pack.preview", "candidate.install.request", "candidate.install.authorize",
  "phase-review.request", "phase-review.decide",
]);

function coreError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
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

function snapshotCommand(command) {
  try {
    const snapshot = JSON.parse(canonicalJson({
      command_id: command.command_id,
      name: command.name,
      payload: command.payload,
    }));
    if (typeof snapshot.command_id !== "string" || !snapshot.command_id
      || typeof snapshot.name !== "string" || !snapshot.name
      || !Object.prototype.hasOwnProperty.call(snapshot, "payload")) {
      throw coreError("CORE_COMMAND_INVALID", "Command requires command_id, name, and payload.");
    }
    return deepFreeze(snapshot);
  } catch {
    throw coreError("CORE_COMMAND_INVALID", "Command cannot be canonicalized.");
  }
}

function safeProviderFingerprint(provider) {
  return canonicalHash({
    provider_id: provider.provider_id || null,
    provider_type: provider.provider_type || null,
    source_uri: provider.source_uri || null,
    source_type: provider.source_type || null,
    capabilities: Array.isArray(provider.capabilities) ? [...provider.capabilities].sort(compareText) : [],
    trust_tier: provider.trust_tier || null,
    availability: provider.availability || null,
    version: provider.version || null,
    last_verified_at: provider.last_verified_at || null,
    provider_hash: provider.provider_hash || null,
    evidence_refs: Array.isArray(provider.evidence_refs) ? [...provider.evidence_refs].sort(compareText) : [],
  });
}

function proposalBinding(state, proposal) {
  const candidates = [...proposal.ranked_candidates, ...proposal.rejected_candidates];
  const candidateEvaluations = candidates
    .filter((candidate) => candidate && candidate.evaluation && typeof candidate.evaluation.evaluation_id === "string")
    .map((candidate) => ({
      evaluation_id: candidate.evaluation.evaluation_id,
      evaluation_hash: canonicalHash(candidate.evaluation),
    }))
    .sort((left, right) => compareText(left.evaluation_id, right.evaluation_id));
  const selected = candidates.find((candidate) => candidate && candidate.candidate_id === proposal.resolution.selected_provider_id) || null;
  const provider = selected && state.providers.find((item) => item.provider_id === selected.candidate_id);
  return {
    inventory_id: state.inventory && typeof state.inventory.inventory_id === "string" ? state.inventory.inventory_id : null,
    candidate_evaluations: candidateEvaluations,
    selected_evaluation_id: selected && selected.evaluation ? selected.evaluation.evaluation_id : null,
    selected_evaluation_hash: selected && selected.evaluation ? canonicalHash(selected.evaluation) : null,
    selected_provider_id: proposal.resolution.selected_provider_id,
    selected_provider_fingerprint: provider ? safeProviderFingerprint(provider) : null,
  };
}

function staleResolution(details) {
  throw coreError("CORE_RESOLUTION_STALE", "Resolution evidence no longer matches the current proposal or inventory.", details);
}

function assertCurrentProposalEvidence(state, resolution) {
  if (!resolution.selected_provider_id) return;
  const binding = state.resolution_bindings && state.resolution_bindings[resolution.resolution_id];
  if (!binding || binding.selected_provider_id !== resolution.selected_provider_id
    || typeof binding.selected_evaluation_id !== "string" || typeof binding.selected_evaluation_hash !== "string") {
    staleResolution({ resolution_id: resolution.resolution_id, reason: "proposal_binding_missing" });
  }
  const evaluation = state.candidate_evaluations.find((item) => item.evaluation_id === binding.selected_evaluation_id);
  const listed = Array.isArray(binding.candidate_evaluations)
    && binding.candidate_evaluations.some((item) => item.evaluation_id === binding.selected_evaluation_id
      && item.evaluation_hash === binding.selected_evaluation_hash);
  if (!listed || !evaluation || evaluation.need_id !== resolution.need_id
    || evaluation.candidate_id !== resolution.selected_provider_id || evaluation.eligibility !== "eligible"
    || canonicalHash(evaluation) !== binding.selected_evaluation_hash) {
    staleResolution({ resolution_id: resolution.resolution_id, reason: "candidate_evaluation_changed" });
  }
  if (resolution.mode === "build") return;
  const provider = state.providers.find((item) => item.provider_id === resolution.selected_provider_id);
  if (!state.inventory || state.inventory.inventory_id !== binding.inventory_id || !provider
    || safeProviderFingerprint(provider) !== binding.selected_provider_fingerprint) {
    staleResolution({ resolution_id: resolution.resolution_id, reason: "inventory_provider_changed" });
  }
}

function contextPackBindingError(details) {
  throw coreError("CORE_CONTEXT_PACK_BINDING_INVALID", "Context Pack does not bind the current lifecycle inputs.", details);
}

function assertCompiledContextPack(compiled, taskIntent, resolutions) {
  const candidate = compiled && compiled.context_pack ? compiled.context_pack : compiled;
  let contextPack;
  try {
    contextPack = clone(assertContract("context-pack", candidate));
  } catch {
    throw coreError("CORE_CONTEXT_PACK_INVALID", "Context Compiler must return a schema-valid Context Pack.");
  }
  if (contextPack.status !== "draft") {
    throw coreError("CORE_CONTEXT_PACK_NOT_DRAFT", "Only a draft Context Pack may be previewed before approval.");
  }
  const content = clone(contextPack);
  delete content.context_pack_id;
  if (contextPack.context_pack_id !== `CP-${canonicalHash(content).slice(0, 12)}`) {
    contextPackBindingError({ reason: "context_pack_id" });
  }
  const expectedResolutionIds = resolutions.map((resolution) => resolution.resolution_id).sort(compareText);
  const actualResolutionIds = [...contextPack.capability_resolutions].sort(compareText);
  if (contextPack.task_intent_id !== taskIntent.task_intent_id
    || actualResolutionIds.length !== expectedResolutionIds.length
    || actualResolutionIds.some((resolutionId, index) => resolutionId !== expectedResolutionIds[index])) {
    contextPackBindingError({ reason: "current_lifecycle_inputs" });
  }
  const requiredProvenance = [
    { kind: "task_intent", source_ref: `task_intent:${taskIntent.task_intent_id}`, source_hash: canonicalHash(taskIntent) },
    ...resolutions.map((resolution) => ({
      kind: "capability_resolution",
      source_ref: `resolution:${resolution.resolution_id}`,
      source_hash: canonicalHash(resolution),
    })),
  ];
  const provenanceByKind = new Map();
  for (const item of contextPack.provenance) {
    const bySourceRef = provenanceByKind.get(item.kind) || new Map();
    const entries = bySourceRef.get(item.source_ref) || [];
    entries.push(item);
    bySourceRef.set(item.source_ref, entries);
    provenanceByKind.set(item.kind, bySourceRef);
  }
  const duplicateKeys = [];
  for (const [kind, bySourceRef] of provenanceByKind) {
    for (const [sourceRef, entries] of bySourceRef) {
      if (entries.length > 1) duplicateKeys.push({ kind, source_ref: sourceRef });
    }
  }
  duplicateKeys.sort((left, right) => compareText(left.kind, right.kind) || compareText(left.source_ref, right.source_ref));
  if (duplicateKeys.length > 0) {
    contextPackBindingError({ reason: "provenance_duplicate", ...duplicateKeys[0] });
  }
  for (const required of requiredProvenance) {
    const entry = provenanceByKind.get(required.kind)?.get(required.source_ref)?.[0];
    if (!entry || entry.source_hash !== required.source_hash) {
      contextPackBindingError({ reason: "provenance", source_ref: required.source_ref });
    }
  }
  return contextPack;
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

function assertInstallResolution(state, target) {
  const resolution = state.resolutions.find((item) => item.resolution_id === target.resolution_id);
  if (!resolution) {
    throw coreError("CORE_INSTALL_RESOLUTION_INVALID", "Install authorization requires an approved Resolution.");
  }
  const latest = state.latest_resolution_by_need[resolution.need_id];
  if (!latest || latest.resolution_id !== resolution.resolution_id || latest.sequence !== target.resolution_revision) {
    throw coreError("CORE_INSTALL_RESOLUTION_STALE", "Install target is not bound to the current Resolution revision.");
  }
  if (resolution.status !== "approved" || resolution.approval_status !== "approved") {
    throw coreError("CORE_INSTALL_RESOLUTION_INVALID", "Install authorization requires an approved Resolution.");
  }
  assertCurrentProposalEvidence(state, resolution);
  return resolution;
}

function assertInstallProvider(state, resolution, target) {
  const provider = state.providers.find((item) => item.provider_id === resolution.selected_provider_id);
  if (!provider || target.candidate_id !== resolution.selected_provider_id
    || target.candidate_version !== provider.version || target.source_hash !== provider.provider_hash) {
    throw coreError("CORE_INSTALL_CANDIDATE_STALE", "Install target candidate evidence does not match the selected provider.");
  }
  return provider;
}

function assertInstallPacket(state, target) {
  const packet = state.artifacts.find((item) => item.artifact_ref === target.review_packet_ref);
  if (!packet || packet.kind !== "install_review_packet" || packet.artifact_hash !== target.review_packet_hash) {
    throw coreError("CORE_INSTALL_PACKET_INVALID", "Install target requires the exact persisted install review packet.");
  }
  return packet;
}

function assertInstallNotExpired(target, referenceTime) {
  const now = Date.parse(referenceTime || "");
  const expiry = Date.parse(target.expires_at || "");
  if (!Number.isFinite(now) || !Number.isFinite(expiry) || expiry <= now) {
    throw coreError("CORE_INSTALL_TARGET_EXPIRED", "Install target has expired or cannot be compared to the reference time.");
  }
}

function createCommandBoundary({ eventStore, rules, collectInventory, verifyUserApproval, compileContextPack, referenceTime } = {}) {
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
  function commit(command, identity, eventRecords, actor = { type: "system", id: "orquesta-core" }, replayed = replayResult()) {
    const events = (Array.isArray(eventRecords) ? eventRecords : [eventRecords]).map((record) => ({
      ...record,
      payload: { ...record.payload, command_identity: clone(identity) },
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
  function currentGraph(state) {
    const graph = state.capability_graphs.find((item) => item.graph_id === state.current_capability_graph_id);
    if (!graph) throw coreError("CORE_CAPABILITY_GRAPH_REQUIRED", "A Capability Graph must exist before this command.");
    return graph;
  }
  function currentResolutions(state) {
    const graph = currentGraph(state);
    const currentIds = graph.needs
      .map((need) => state.latest_resolution_by_need[need.need_id] && state.latest_resolution_by_need[need.need_id].resolution_id)
      .filter(Boolean)
      .sort(compareText);
    return currentIds.map((resolutionId) => {
      const resolution = state.resolutions.find((item) => item.resolution_id === resolutionId);
      if (!resolution) throw coreError("CORE_CONTEXT_RESOLUTION_REQUIRED", "Current Resolution evidence is unavailable.", { resolution_id: resolutionId });
      return resolution;
    });
  }
  function execute(input) {
    if (!input || typeof input !== "object" || !Object.prototype.hasOwnProperty.call(input, "payload")) {
      throw coreError("CORE_COMMAND_INVALID", "Command requires command_id, name, and payload.");
    }
    const command = snapshotCommand(input);
    if (!COMMAND_NAMES.includes(command.name)) throw coreError("CORE_COMMAND_UNKNOWN", "Command is not part of the Core boundary.", { name: command.name });
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
      const task_intent = createTaskIntent(clone(command.payload));
      return commit(command, identity, { type: "task.intent.created", payload: { task_intent, responsibility: "orchestrator" }, evidence_refs: [task_intent.raw_request_ref] }, undefined, replayed);
    }
    if (command.name === "capability.compile") {
      const graph = compileCapabilities({ taskIntent: clone(currentIntent(state)), rules });
      return commit(command, identity, [
        ...graph.needs.map((need) => ({ type: "capability.need.declared", payload: { need, responsibility: "orchestrator" }, evidence_refs: [] })),
        { type: "capability.graph.compiled", payload: { graph, responsibility: "orchestrator" }, evidence_refs: [] },
      ], undefined, replayed);
    }
    if (command.name === "execution-plan.create") {
      const taskIntent = currentIntent(state);
      currentGraph(state);
      if (state.current_execution_plan_id) {
        throw coreError("CORE_EXECUTION_PLAN_EXISTS", "An Execution Plan already exists; use escalation for a lane change.", {
          execution_plan_id: state.current_execution_plan_id
        });
      }
      const execution_plan = createExecutionPlan({ taskIntent: clone(taskIntent), riskProfile: clone(command.payload.risk_profile) });
      return commit(command, identity, {
        type: "execution.plan.created",
        payload: { execution_plan, responsibility: "orchestrator" },
        evidence_refs: [`task_intent:${taskIntent.task_intent_id}`, `capability_graph:${state.current_capability_graph_id}`]
      }, undefined, replayed);
    }
    if (command.name === "execution-plan.escalate") {
      const current = state.execution_plans.find((plan) => plan.execution_plan_id === state.current_execution_plan_id);
      if (!current) throw coreError("CORE_EXECUTION_PLAN_REQUIRED", "An Execution Plan must exist before escalation.");
      const execution_plan = escalateExecutionPlan({ executionPlan: clone(current), trigger: command.payload.trigger });
      return commit(command, identity, {
        type: "execution.plan.created",
        payload: { execution_plan, previous_execution_plan_id: current.execution_plan_id, responsibility: "orchestrator" },
        evidence_refs: [`execution_plan:${current.execution_plan_id}`]
      }, undefined, replayed);
    }
    if (command.name === "inventory.refresh-local") {
      if (typeof collectInventory !== "function") throw coreError("CORE_INVENTORY_UNAVAILABLE", "Local inventory collector is not configured.");
      const inventory = cleanInventory(collectInventory(clone(command.payload)));
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
      return commit(command, identity, events, undefined, replayed);
    }
    if (command.name === "resolution.propose") {
      const graph = currentGraph(state);
      const need = graph && graph.needs.find((item) => item.need_id === command.payload.need_id);
      if (!need) throw coreError("CORE_NEED_REQUIRED", "Resolution proposal requires a compiled Capability Need.");
      const discovered = new Map(state.providers.map((provider) => [provider.provider_id, provider]));
      const suppliedCandidates = clone(command.payload.candidates || []);
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
      const proposal = resolveNeed({ need: clone(need), scoutedCandidates: candidates, auditFacts: clone(command.payload.audit_facts || []) });
      const binding = proposalBinding(state, proposal);
      const resolutionPayload = {
        resolution: proposal.resolution,
        rejection_reasons: proposal.rejected_candidates.map((candidate) => ({ candidate_id: candidate.candidate_id, why_not_selected: candidate.why_not_selected })),
        responsibility: "orchestrator",
        responsibility_boundary: { ...RESPONSIBILITY },
        proposal_binding: binding,
        scout_skip_reason: proposal.resolution.selected_provider_id && discovered.has(proposal.resolution.selected_provider_id)
          ? "local_inventory_satisfied_need"
          : null,
      };
      return commit(command, identity, [
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
      assertCurrentProposalEvidence(state, resolution);
      if (typeof verifyUserApproval !== "function") throw coreError("CORE_APPROVAL_INVALID", "Approval verification is required.");
      const target = { ...resolutionApprovalTarget(resolution, currentRevision(replayed)), candidate_id: resolution.selected_provider_id, mode: resolution.mode, decision: "approved" };
      const verified = assertVerifiedAttestation(verifyUserApproval(clone(command.payload.approval_evidence), clone(target)), target);
      return commit(command, identity, { type: "resolution.approved", payload: { resolution_id: resolution.resolution_id, attestation: verified.attestation, proposal_revision: currentRevision(replayed), responsibility: "user" }, evidence_refs: resolution.evidence_refs }, verified.actor, replayed);
    }
    if (command.name === "context-pack.preview") {
      if (typeof compileContextPack !== "function") {
        throw coreError("CORE_CONTEXT_COMPILER_REQUIRED", "Context Pack preview requires a trusted Context Compiler.");
      }
      const taskIntent = clone(currentIntent(state));
      const resolutions = currentResolutions(state).map((resolution) => clone(resolution));
      const request = clone(command.payload);
      delete request.context_pack;
      const context_pack = assertCompiledContextPack(
        compileContextPack({ taskIntent: clone(taskIntent), resolutions: clone(resolutions), request, referenceTime: referenceTime || null }),
        taskIntent,
        resolutions,
      );
      return commit(command, identity, { type: "context.pack.created", payload: { context_pack, responsibility: "orchestrator" }, evidence_refs: [] }, undefined, replayed);
    }
    if (command.name === "candidate.install.request") {
      if (state.current_install_request && state.current_install_request.status === "pending_user") {
        throw coreError("CORE_INSTALL_REQUEST_ACTIVE", "A pending install target must be resolved before another request.");
      }
      const target = createInstallApprovalTarget(clone(command.payload));
      const resolution = assertInstallResolution(state, target);
      const provider = assertInstallProvider(state, resolution, target);
      assertInstallPacket(state, target);
      assertInstallNotExpired(target, referenceTime);
      const install_request = {
        request_id: target.target_id,
        target,
        status: "pending_user",
        requested_at: referenceTime || null
      };
      return commit(command, identity, {
        type: "candidate.install.requested",
        payload: { install_request, responsibility: "orchestrator" },
        evidence_refs: [...provider.evidence_refs, `resolution:${resolution.resolution_id}`, target.review_packet_ref]
      }, undefined, replayed);
    }
    if (command.name === "candidate.install.authorize") {
      const current = state.current_install_request;
      if (current && current.status === "authorized") {
        throw coreError("CORE_INSTALL_ALREADY_AUTHORIZED", "Install target is already authorized.");
      }
      if (!current || current.status !== "pending_user") {
        throw coreError("CORE_INSTALL_TARGET_REQUIRED", "A current pending install target is required before authorization.");
      }
      if (!command.payload.target || canonicalHash(command.payload.target) !== canonicalHash(current.target)) {
        throw coreError("CORE_INSTALL_TARGET_STALE", "Authorization must bind the exact persisted install target.");
      }
      if (state.install_authorizations.some((item) => item.target_id === current.target.target_id)) {
        throw coreError("CORE_INSTALL_ALREADY_AUTHORIZED", "Install target is already authorized.");
      }
      const resolution = assertInstallResolution(state, current.target);
      const provider = assertInstallProvider(state, resolution, current.target);
      assertInstallPacket(state, current.target);
      assertInstallNotExpired(current.target, referenceTime);
      if (typeof verifyUserApproval !== "function") throw coreError("CORE_APPROVAL_INVALID", "Approval verification is required.");
      const verified = assertVerifiedAttestation(
        verifyUserApproval(clone(command.payload.approval_evidence), clone(current.target)),
        current.target
      );
      const authorization = {
        authorization_id: `INSTALL-AUTH-${canonicalHash({ target_id: current.target.target_id, attestation: verified.attestation }).slice(0, 24)}`,
        request_id: current.request_id,
        target_id: current.target.target_id,
        target_hash: canonicalHash(current.target),
        resolution_id: current.target.resolution_id,
        resolution_revision: current.target.resolution_revision,
        status: "authorized",
        attestation: verified.attestation
      };
      return commit(command, identity, {
        type: "candidate.install.authorized",
        payload: { authorization, responsibility: "user" },
        evidence_refs: [...provider.evidence_refs, `resolution:${resolution.resolution_id}`, current.target.review_packet_ref, `install_request:${current.request_id}`]
      }, verified.actor, replayed);
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
      return commit(command, identity, { type: "phase.review.requested", payload: { review, responsibility: "orchestrator" }, evidence_refs: [review.review_packet_ref, review.build_ref] }, undefined, replayed);
    }
    const matchingReviews = state.phase_reviews.filter((item) => item.phase_id === command.payload.phase_id || item.phase_id.startsWith(`${command.payload.phase_id}:cycle-`));
    const review = matchingReviews.sort((left, right) => right.review_cycle_revision - left.review_cycle_revision)[0];
    if (!review) throw coreError("CORE_PHASE_REVIEW_REQUIRED", "A Phase Review must exist before a decision.");
    const requiresUserDecision = command.payload.decision === "approved" || command.payload.decision === "changes_requested";
    const decisionRevision = currentRevision(replayed);
    const target = { target_id: review.phase_id, target_revision: decisionRevision, review_packet_hash: review.review_packet_hash, decision: command.payload.decision };
    const verified = requiresUserDecision
      ? assertVerifiedAttestation(verifyUserApproval && verifyUserApproval(clone(command.payload.approval_evidence), clone(target)), target)
      : null;
    const decided = decidePhaseReview({
      review,
      decision: command.payload.decision,
      approval_evidence: clone(command.payload.approval_evidence),
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
    return commit(command, identity, { type: eventType, payload: { review: decided, responsibility: decided.status === "approved" || decided.status === "changes_requested" ? "user" : "orchestrator" }, evidence_refs: [decided.review_packet_ref, decided.build_ref] }, verified ? verified.actor : undefined, replayed);
  }
  return { execute, replay, projectors: reducers, reference_time: referenceTime || null };
}

module.exports = { COMMAND_NAMES, createCommandBoundary, coreError };
