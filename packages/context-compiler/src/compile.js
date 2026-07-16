"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { assertContract, canonicalHash } = require("@orquesta/contracts");
const { contextError, getAgentContractProvenance } = require("./agent-contract");

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortUnique(values) {
  return [...new Set(values)].sort(compareText);
}

function hash(source) {
  return crypto.createHash("sha256").update(source).digest("hex");
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function assertInputContract(name, value) {
  try {
    return assertContract(name, value);
  } catch (error) {
    throw contextError("CONTEXT_INPUT_INVALID", `Invalid ${name} input.`, { contract: name });
  }
}

function normalizeReference(value) {
  if (typeof value !== "string" || !value) return null;
  const explicitWorkspace = value.startsWith("workspace:");
  const input = explicitWorkspace ? value.slice("workspace:".length) : value;
  const candidate = input.includes("#") ? input.slice(0, input.indexOf("#")) : input;
  const absolute = path.isAbsolute(candidate) || /^(?:[A-Za-z]:[\\/]|[\\/])/.test(candidate);
  if (explicitWorkspace && (!candidate || absolute || /^[a-z][a-z0-9+.-]*:/i.test(candidate))) {
    throw contextError("CONTEXT_WORKSPACE_ESCAPE", "Explicit workspace reference must name a workspace-relative file.", { source_ref: value });
  }
  if (absolute) {
    throw contextError("CONTEXT_WORKSPACE_ESCAPE", "Context reference must be workspace-relative.", { source_ref: value });
  }
  if (!candidate || /^[a-z][a-z0-9+.-]*:/i.test(candidate)) return null;
  const normalized = path.posix.normalize(candidate.replace(/\\/g, "/"));
  if (normalized === ".." || normalized.startsWith("../")) {
    throw contextError("CONTEXT_WORKSPACE_ESCAPE", "Context reference must not escape the workspace.", { source_ref: value });
  }
  return normalized === "." ? null : normalized;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function workspaceRoot(workspaceRootInput) {
  if (typeof workspaceRootInput !== "string" || !workspaceRootInput) {
    throw contextError("CONTEXT_WORKSPACE_INVALID", "A workspace root is required.");
  }
  let root;
  try {
    root = fs.realpathSync(workspaceRootInput);
  } catch (error) {
    throw contextError("CONTEXT_WORKSPACE_INVALID", "Workspace root must exist.", { workspace_root: workspaceRootInput });
  }
  if (!fs.statSync(root).isDirectory()) {
    throw contextError("CONTEXT_WORKSPACE_INVALID", "Workspace root must be a directory.", { workspace_root: workspaceRootInput });
  }
  return root;
}

function readWorkspaceFile(root, sourceRef) {
  const reference = normalizeReference(sourceRef);
  if (!reference) {
    throw contextError("CONTEXT_WORKSPACE_ESCAPE", "Context references must be workspace-relative files.", { source_ref: sourceRef });
  }
  const target = path.resolve(root, ...reference.split("/"));
  if (!isInside(root, target)) {
    throw contextError("CONTEXT_WORKSPACE_ESCAPE", "Context reference escapes the workspace.", { source_ref: reference });
  }
  if (!fs.existsSync(target)) {
    throw contextError("CONTEXT_FILE_MISSING", "Context reference does not exist.", { source_ref: reference });
  }
  const entry = fs.lstatSync(target);
  let realTarget;
  try {
    realTarget = fs.realpathSync(target);
  } catch (error) {
    throw contextError("CONTEXT_FILE_MISSING", "Context reference cannot be resolved.", { source_ref: reference });
  }
  if (!isInside(root, realTarget)) {
    throw contextError("CONTEXT_WORKSPACE_ESCAPE", "Context reference resolves outside the workspace.", { source_ref: reference });
  }
  if (!entry.isFile() && !entry.isSymbolicLink()) {
    throw contextError("CONTEXT_FILE_NOT_REGULAR", "Context reference must name a regular file.", { source_ref: reference });
  }
  if (!fs.statSync(realTarget).isFile()) {
    throw contextError("CONTEXT_FILE_NOT_REGULAR", "Context reference must resolve to a regular file.", { source_ref: reference });
  }
  const source = fs.readFileSync(realTarget);
  return { source_ref: reference, source, source_hash: hash(source) };
}

function globMatches(reference, pattern) {
  if (typeof pattern !== "string" || !pattern) return false;
  const expression = pattern.replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${expression}$`).test(reference);
}

function isInterfaceOrTestReference(reference) {
  return reference.startsWith("interfaces/") || reference.startsWith("tests/");
}

function extractAcceptanceFiles(criteria) {
  const files = [];
  for (const criterion of criteria) {
    if (typeof criterion !== "string") continue;
    for (const match of criterion.matchAll(/(?:^|(?:\band\s+then\b|\band\b|\bthen\b|[;:])\s*)(read|review|test|verify)\s+([^\s()[\]{}]+)/gi)) {
      const token = match[2].replace(/^["'`]+|["'`,.;:]+$/g, "");
      const reference = normalizeReference(token);
      if (reference && isInterfaceOrTestReference(reference)) files.push(reference);
    }
  }
  return sortUnique(files);
}

function taskOwnedBaselines(contract) {
  if (!Array.isArray(contract.required_reading)) return [];
  return contract.required_reading
    .filter((entry) => isPlainObject(entry) && typeof entry.source_ref === "string"
      && Array.isArray(entry.tags) && entry.tags.includes("task-owned"))
    .map((entry) => entry.source_ref);
}

function isAllowedTaskWrite(reference, allowedFiles) {
  return Array.isArray(allowedFiles) && allowedFiles.some((pattern) => globMatches(reference, pattern));
}

function expiryOf(resolution) {
  const records = Array.isArray(resolution.reevaluate_when) ? resolution.reevaluate_when : [];
  return records
    .filter((record) => isPlainObject(record) && typeof record.expires_at === "string")
    .map((record) => record.expires_at)
    .sort(compareText);
}

function isStrictUtcMilliseconds(value) {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthLengths = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= monthLengths[month - 1]
    && hour <= 23 && minute <= 59 && second <= 59;
}

function assertNotExpired(resolutions, referenceTime) {
  const expiryValues = resolutions.flatMap(expiryOf);
  if (!expiryValues.length) return;
  if (!isStrictUtcMilliseconds(referenceTime)) {
    throw contextError("CONTEXT_REFERENCE_TIME_REQUIRED", "Explicit deterministic reference time is required for expiry evidence.");
  }
  for (const expiresAt of expiryValues) {
    if (!isStrictUtcMilliseconds(expiresAt)) {
      throw contextError("CONTEXT_INPUT_INVALID", "Expiry evidence must be strict UTC milliseconds.", { expires_at: expiresAt });
    }
    if (expiresAt <= referenceTime) {
      throw contextError("CONTEXT_INPUT_EXPIRED", "Resolution evidence is expired.", { expires_at: expiresAt, reference_time: referenceTime });
    }
  }
}

function contractProvenance(root, contract) {
  const metadata = getAgentContractProvenance(contract);
  if (!metadata) {
    throw contextError("CONTEXT_AGENT_CONTRACT_INVALID", "Agent contract must be loaded by loadAgentContract.");
  }
  const lexicalPath = metadata.agents_path;
  const relative = path.relative(root, lexicalPath).replace(/\\/g, "/");
  if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) {
    throw contextError("CONTEXT_WORKSPACE_ESCAPE", "Agent contract file must be inside the workspace.");
  }
  let realPath;
  try {
    realPath = fs.realpathSync(lexicalPath);
  } catch (error) {
    throw contextError("CONTEXT_AGENT_CONTRACT_INVALID", "Agent contract file cannot be resolved.", { agents_path: lexicalPath });
  }
  if (!isInside(root, realPath)) {
    throw contextError("CONTEXT_WORKSPACE_ESCAPE", "Agent contract resolves outside the workspace.", { agents_path: relative });
  }
  if (!fs.statSync(realPath).isFile()) {
    throw contextError("CONTEXT_AGENT_CONTRACT_INVALID", "Agent contract must resolve to a regular file.", { agents_path: relative });
  }
  if (hash(fs.readFileSync(realPath)) !== metadata.source_hash) {
    throw contextError("CONTEXT_AGENT_CONTRACT_INVALID", "Agent contract changed after it was loaded.", { agents_path: relative });
  }
  let document;
  try {
    document = JSON.parse(fs.readFileSync(realPath, "utf8"));
  } catch (error) {
    throw contextError("CONTEXT_AGENT_CONTRACT_INVALID", "Agent contract file is not readable JSON.", { agents_path: relative });
  }
  if (!isPlainObject(document) || !Array.isArray(document.agents)) {
    throw contextError("CONTEXT_AGENT_CONTRACT_INVALID", "Agent contract file must contain an agents array.", { agents_path: relative });
  }
  const matches = document.agents.filter((agent) => isPlainObject(agent) && agent.agent_id === metadata.target_agent_id);
  if (matches.length !== 1 || contract.agent_id !== metadata.target_agent_id
    || canonicalHash(matches[0]) !== metadata.selected_object_hash
    || canonicalHash(cloneJson(contract)) !== metadata.selected_object_hash) {
    throw contextError("CONTEXT_AGENT_CONTRACT_INVALID", "Agent contract snapshot does not match the selected source contract.", { agents_path: relative });
  }
  return {
    kind: "agent_contract",
    source_ref: relative,
    source_hash: metadata.source_hash,
    target_agent_id: metadata.target_agent_id,
  };
}

function assertResolutionApprovalConsistency(resolutions) {
  const contradictions = resolutions
    .filter((resolution) => (resolution.status === "approved" && resolution.approval_status !== "approved")
      || (resolution.status === "proposed" && resolution.approval_status !== "pending_user"))
    .map((resolution) => ({
      resolution_id: resolution.resolution_id,
      status: resolution.status,
      approval_status: resolution.approval_status,
    }))
    .sort((left, right) => compareText(`${left.resolution_id}:${left.status}:${left.approval_status}`, `${right.resolution_id}:${right.status}:${right.approval_status}`));
  if (contradictions.length) {
    throw contextError("CONTEXT_RESOLUTION_APPROVAL_CONTRADICTION", "Resolution status and approval evidence are inconsistent.", { resolutions: contradictions });
  }
}

function compileContextPackV1({ taskIntent, resolutions, agentContract, workspaceRoot: workspaceRootInput, referenceTime } = {}) {
  const intent = cloneJson(assertInputContract("task-intent", taskIntent));
  if (intent.status === "superseded") {
    throw contextError("CONTEXT_INPUT_STALE", "Superseded TaskIntent cannot produce a Context Pack.", { task_intent_id: intent.task_intent_id });
  }
  if (!Array.isArray(resolutions)) throw contextError("CONTEXT_INPUT_INVALID", "Resolutions must be an array.");
  if (!resolutions.length) throw contextError("CONTEXT_RESOLUTION_REQUIRED", "At least one Resolution is required for a Context Pack.");
  const checkedResolutions = resolutions.map((resolution) => cloneJson(assertInputContract("resolution", resolution)));
  const duplicateResolutionIds = checkedResolutions
    .map((resolution) => resolution.resolution_id)
    .filter((resolutionId, index, all) => all.indexOf(resolutionId) !== index);
  if (duplicateResolutionIds.length) {
    throw contextError("CONTEXT_RESOLUTION_DUPLICATE", "Resolution IDs must be unique.", { resolution_ids: sortUnique(duplicateResolutionIds) });
  }
  const invalidResolutionStatuses = checkedResolutions
    .filter((resolution) => !["proposed", "approved"].includes(resolution.status))
    .map((resolution) => ({ resolution_id: resolution.resolution_id, status: resolution.status }))
    .sort((left, right) => compareText(`${left.resolution_id}:${left.status}`, `${right.resolution_id}:${right.status}`));
  if (invalidResolutionStatuses.length) {
    throw contextError("CONTEXT_RESOLUTION_STATUS_INVALID", "Only proposed or approved Resolutions can produce a Context Pack.", { resolutions: invalidResolutionStatuses });
  }
  assertResolutionApprovalConsistency(checkedResolutions);
  if (!isPlainObject(agentContract) || typeof agentContract.agent_id !== "string" || !agentContract.agent_id) {
    throw contextError("CONTEXT_AGENT_CONTRACT_INVALID", "Named agent contract is invalid.");
  }
  const root = workspaceRoot(workspaceRootInput);
  assertNotExpired(checkedResolutions, referenceTime);

  const agentProvenance = contractProvenance(root, agentContract);
  const selectedAgent = cloneJson(agentContract);

  const excluded = new Set((Array.isArray(selectedAgent.excluded_context) ? selectedAgent.excluded_context : [])
    .map((reference) => normalizeReference(reference))
    .filter(Boolean));
  const candidates = [];
  for (const resolution of checkedResolutions) {
    for (const evidenceRef of resolution.evidence_refs) {
      const reference = normalizeReference(evidenceRef);
      if (reference) candidates.push({ source_ref: reference, kind: "resolution_evidence", task_owned: false });
    }
  }
  for (const reference of extractAcceptanceFiles(intent.acceptance_criteria)) {
    candidates.push({ source_ref: reference, kind: "acceptance_file", task_owned: false });
  }
  for (const sourceRef of taskOwnedBaselines(selectedAgent)) {
    const reference = normalizeReference(sourceRef);
    if (reference) candidates.push({ source_ref: reference, kind: "task_owned_baseline", task_owned: true });
  }

  const byReference = new Map();
  for (const candidate of candidates) {
    const existing = byReference.get(candidate.source_ref) || { ...candidate, kinds: new Set() };
    existing.kinds.add(candidate.kind);
    existing.task_owned = existing.task_owned || candidate.task_owned;
    byReference.set(candidate.source_ref, existing);
  }

  const omitted = [];
  const included = [];
  for (const reference of [...byReference.keys()].sort(compareText)) {
    const candidate = byReference.get(reference);
    if (excluded.has(reference)) {
      omitted.push({ source_ref: reference, reason: "excluded_by_agent_contract" });
      continue;
    }
    if (candidate.task_owned && !isAllowedTaskWrite(reference, selectedAgent.allowed_files)) {
      throw contextError("CONTEXT_TASK_WRITE_OUTSIDE_ALLOWED_FILES", "Task-owned file is outside the agent's allowed files.", { source_ref: reference });
    }
    const file = readWorkspaceFile(root, reference);
    included.push({ ...file, kinds: [...candidate.kinds].sort(compareText) });
  }

  const taskProvenance = {
    kind: "task_intent",
    source_ref: `task_intent:${intent.task_intent_id}`,
    source_hash: canonicalHash(intent),
  };
  const resolutionProvenance = checkedResolutions
    .map((resolution) => ({
      kind: "capability_resolution",
      source_ref: `resolution:${resolution.resolution_id}`,
      source_hash: canonicalHash(resolution),
    }))
    .sort((left, right) => compareText(left.source_ref, right.source_ref));
  const fileProvenance = included.flatMap((file) => file.kinds.map((kind) => ({
    kind,
    source_ref: file.source_ref,
    source_hash: file.source_hash,
  }))).sort((left, right) => compareText(`${left.kind}:${left.source_ref}`, `${right.kind}:${right.source_ref}`));
  const provenance = [agentProvenance, taskProvenance, ...resolutionProvenance, ...fileProvenance]
    .sort((left, right) => compareText(`${left.kind}:${left.source_ref}`, `${right.kind}:${right.source_ref}`));
  const content = {
    task_intent_id: intent.task_intent_id,
    owner_agent_id: selectedAgent.agent_id,
    objective: intent.desired_outcome,
    acceptance_criteria: cloneJson(intent.acceptance_criteria),
    adopted_decisions: [],
    capability_resolutions: checkedResolutions.map((resolution) => resolution.resolution_id).sort(compareText),
    required_reading: included.map((file) => file.source_ref).sort(compareText),
    relevant_state_excerpts: [],
    interfaces: included
      .filter((file) => file.kinds.includes("acceptance_file") && file.source_ref.startsWith("interfaces/"))
      .map((file) => file.source_ref)
      .sort(compareText),
    allowed_files: cloneJson(selectedAgent.allowed_files),
    forbidden_actions: cloneJson(selectedAgent.forbidden_actions),
    excluded_context: cloneJson(selectedAgent.excluded_context),
    evidence_requirements: cloneJson(intent.acceptance_criteria),
    provenance,
    token_budget: null,
    expires_at: null,
    status: intent.status === "approved" && checkedResolutions.every((resolution) => resolution.status === "approved" && resolution.approval_status === "approved") ? "ready" : "draft",
  };
  const contextPack = assertContract("context-pack", {
    context_pack_id: `CP-${canonicalHash(content).slice(0, 12)}`,
    ...content,
  });
  return deepFreeze({
    context_pack: contextPack,
    omitted_context: omitted.sort((left, right) => compareText(left.source_ref, right.source_ref)),
  });
}

module.exports = { compileContextPackV1 };
