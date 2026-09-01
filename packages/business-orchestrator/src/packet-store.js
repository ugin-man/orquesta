"use strict";

const crypto = require("node:crypto");
const path = require("node:path");

const { canonicalHash, canonicalJson } = require("@orquesta/contracts");
const {
  V2_EFFECT_IDENTITY_FIELDS,
  V2_MUTATING_EFFECT_KINDS,
} = require("./lifecycle");
const {
  BusinessSendAuthorizationError,
  normalizeSendAuthorizationOperationScopeBindingV2,
} = require("./send-authorization");

const DISPATCH_PACKET_CONTRACT_VERSION = 1;
const DISPATCH_PACKET_VERIFICATION_RECEIPT_VERSION = 1;

const DISPATCH_PACKET_STORE_LIMITS = deepFreeze({
  max_packet_bytes: 1_048_576,
  max_input_depth: 24,
  max_input_nodes: 32_768,
  max_string_bytes: 262_144,
  max_array_items: 512,
  max_ref_bytes: 256,
  max_runtime_ms: 604_800_000,
  max_output_bytes: 1_073_741_824,
  max_tool_calls: 100_000,
});

const PACKET_FIELDS = new Set([
  "schema_version",
  "work_order",
  "plan",
  "branch",
  "provider",
  "workspace",
  "context",
  "authority",
  "effect_ceiling",
]);
const WORK_ORDER_FIELDS = new Set([
  "work_order_id",
  "work_order_revision",
  "engine_contract_version",
]);
const PLAN_FIELDS = new Set(["plan_snapshot_ref", "plan_hash"]);
const BRANCH_FIELDS = new Set([
  "branch_ref",
  "next_attempt",
  "task_intent_ref",
  "execution_plan_ref",
  "attempt_packet_ref",
]);
const PROVIDER_FIELDS = new Set(["provider_ref", "configuration_ref"]);
const WORKSPACE_FIELDS = new Set([
  "workspace_ref",
  "checkpoint_ref",
  "isolation_mode",
]);
const CONTEXT_FIELDS = new Set([
  "context_pack_ref",
  "context_manifest_ref",
  "request_payload",
  "user_input_request_id",
  "user_input_response_ref",
]);
const AUTHORITY_FIELDS = new Set([
  "authority_ref",
  "principal_type",
  "principal_id",
  "project_ref",
  "permission_mode",
  "allowed_provider_refs",
  "allowed_effects",
]);
const EFFECT_CEILING_FIELDS = new Set([
  "allowed_effect_kinds",
  "deadline_at",
  "max_runtime_ms",
  "max_output_bytes",
  "max_tool_calls",
]);
const CONTENT_REF_FIELDS = new Set(["id", "hash"]);
const RUNTIME_IDENTITY_FIELDS = new Set(["operation_id", "thread_id", "turn_id"]);
const LIMIT_FIELDS = new Set(Object.keys(DISPATCH_PACKET_STORE_LIMITS));
const SECURITY_PROOF_FIELDS = new Set([
  "proof_version",
  "platform",
  "root_realpath",
  "privacy_enforcement",
  "owner_only_directories",
  "owner_only_files",
  "private_acl_verified",
  "symlink_components_rejected",
  "no_follow_reads",
  "exclusive_temp_creation",
  "atomic_no_replace_rename",
  "file_fsync",
  "directory_fsync",
  "coordinated_recovery",
  "directory_handle_pinned",
]);
const RECOVERY_PROOF_FIELDS = new Set([
  "recovery_version",
  "root_realpath",
  "exclusive_recovery",
  "stale_temps_handled",
  "directory_fsynced",
]);
const VERIFICATION_RECEIPT_FIELDS = new Set([
  "schema_version",
  "disposition",
  "failure_class",
  "failure_taxonomy_version",
  "delivery_disposition",
  "verification_scope",
  "retry_authorization",
  "packet_ref",
  "packet_binding",
  "effect_identity",
  "dispatch_identity_hash",
  "effect_identity_hash",
  "effect_identifier_seed_hash",
  "generation_binding_hash",
  "receipt_ref",
  "receipt_hash",
]);
const SEND_AUTHORIZATION_VERIFICATION_FIELDS = new Set([
  "authorization_verification_version",
  "packet_verification_receipt",
  "operation_scope_binding",
]);
const VERIFICATION_BINDING_FIELDS = new Set([
  "work_order_id",
  "work_order_revision",
  "engine_contract_version",
  "plan_snapshot_ref",
  "plan_hash",
  "branch_ref",
  "next_attempt",
  "task_intent_ref",
  "execution_plan_ref",
  "dispatch_packet_ref",
  "provider_ref",
  "provider_configuration_ref",
  "workspace_ref",
  "workspace_checkpoint_ref",
  "isolation_mode",
  "context_pack_ref",
  "context_manifest_ref",
  "context_binding_hash",
  "authority_ref",
  "principal_type",
  "principal_id",
  "project_ref",
  "permission_mode",
  "authority_ceiling_hash",
  "effect_ceiling_hash",
]);
const PLATFORM_ADAPTER_METHODS = Object.freeze([
  "openStore",
  "recoverInterruptedWrites",
  "readFileNoFollow",
  "openTempExclusive",
  "writeAll",
  "fsyncFile",
  "closeFile",
  "renameTempNoReplace",
  "unlinkTempNoFollow",
  "fsyncDirectory",
  "closeStore",
]);
const EFFECT_KIND_SET = new Set(V2_MUTATING_EFFECT_KINDS);
const PERMISSION_MODES = new Set(["read-only", "workspace-write"]);
const ISOLATION_MODES = new Set(["read-only", "worktree", "sandbox", "remote"]);
const PRINCIPAL_TYPES = new Set(["agent", "user", "system"]);
const RESERVED_PACKET_KEYS = new Set(["dispatch_id", "effect_id"]);

const FAILURE_CLASS_BY_CODE = Object.freeze({
  BUSINESS_PACKET_STORE_CONFIGURATION_INVALID: "storage_unavailable",
  BUSINESS_PACKET_STORE_UNTRUSTED_PLATFORM: "storage_unavailable",
  BUSINESS_PACKET_STORE_SECURITY_UNVERIFIED: "storage_unavailable",
  BUSINESS_PACKET_STORE_RECOVERY_FAILED: "storage_unavailable",
  BUSINESS_PACKET_STORE_WRITE_FAILED: "storage_unavailable",
  BUSINESS_PACKET_STORE_DURABILITY_UNCERTAIN: "durability_uncertain",
  BUSINESS_PACKET_STORE_PATH_UNSAFE: "storage_unavailable",
  BUSINESS_DISPATCH_PACKET_INVALID: "packet_invalid",
  BUSINESS_DISPATCH_PACKET_LIMIT: "packet_invalid",
  BUSINESS_DISPATCH_PACKET_REFERENCE_INVALID: "packet_invalid",
  BUSINESS_DISPATCH_PACKET_NOT_FOUND: "packet_missing",
  BUSINESS_DISPATCH_PACKET_TAMPERED: "packet_tampered",
  BUSINESS_DISPATCH_PACKET_CONFLICT: "packet_tampered",
  BUSINESS_DISPATCH_PACKET_CAPABILITY_MISMATCH: "capability_mismatch",
  BUSINESS_DISPATCH_PACKET_POLICY_MISMATCH: "policy_mismatch",
  BUSINESS_DISPATCH_PACKET_EFFECT_BINDING: "policy_mismatch",
});

class BusinessPacketStoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "BusinessPacketStoreError";
    this.code = code;
    this.disposition = "rejected";
    this.failure_class = FAILURE_CLASS_BY_CODE[code] || "storage_unavailable";
    this.retry_authorization = "not_evaluated";
    this.details = deepFreeze({ ...details });
  }
}

function packetError(code, message, details) {
  return new BusinessPacketStoreError(code, message, details);
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactObject(value, fields, fieldPath) {
  if (!isPlainObject(value)) {
    throw packetError(
      "BUSINESS_DISPATCH_PACKET_INVALID",
      `${fieldPath} must be an exact object`,
      { path: fieldPath },
    );
  }
  const keys = Object.keys(value);
  if (keys.length !== fields.size
      || keys.some((key) => !fields.has(key))
      || [...fields].some((key) => !Object.hasOwn(value, key))) {
    throw packetError(
      "BUSINESS_DISPATCH_PACKET_INVALID",
      `${fieldPath} has unsupported or missing fields`,
      { path: fieldPath },
    );
  }
  return value;
}

function text(value, fieldPath, maximumBytes) {
  if (typeof value !== "string"
      || value.trim() === ""
      || value.trim() !== value
      || Buffer.byteLength(value, "utf8") > maximumBytes) {
    throw packetError(
      "BUSINESS_DISPATCH_PACKET_INVALID",
      `${fieldPath} must be bounded non-empty text`,
      { path: fieldPath },
    );
  }
  return value;
}

function portableRef(value, fieldPath, limits) {
  const normalized = text(value, fieldPath, limits.max_ref_bytes);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@+\-]*$/u.test(normalized)) {
    throw packetError(
      "BUSINESS_DISPATCH_PACKET_INVALID",
      `${fieldPath} must be a portable reference`,
      { path: fieldPath },
    );
  }
  return normalized;
}

function sha256(value, fieldPath) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw packetError(
      "BUSINESS_DISPATCH_PACKET_INVALID",
      `${fieldPath} must be a lowercase SHA-256 hash`,
      { path: fieldPath },
    );
  }
  return value;
}

function integer(value, fieldPath, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw packetError(
      "BUSINESS_DISPATCH_PACKET_INVALID",
      `${fieldPath} must be an integer from ${minimum} to ${maximum}`,
      { path: fieldPath },
    );
  }
  return value;
}

function timestamp(value, fieldPath) {
  if (typeof value !== "string" || value.length > 64) {
    throw packetError(
      "BUSINESS_DISPATCH_PACKET_INVALID",
      `${fieldPath} must be a canonical UTC timestamp`,
      { path: fieldPath },
    );
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw packetError(
      "BUSINESS_DISPATCH_PACKET_INVALID",
      `${fieldPath} must be a canonical UTC timestamp`,
      { path: fieldPath },
    );
  }
  return value;
}

function contentRef(value, fieldPath, limits) {
  const ref = exactObject(value, CONTENT_REF_FIELDS, fieldPath);
  return {
    id: portableRef(ref.id, `${fieldPath}.id`, limits),
    hash: sha256(ref.hash, `${fieldPath}.hash`),
  };
}

function nullableContentRef(value, fieldPath, limits) {
  return value === null ? null : contentRef(value, fieldPath, limits);
}

function nullablePortableRef(value, fieldPath, limits) {
  return value === null ? null : portableRef(value, fieldPath, limits);
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function stringSet(value, fieldPath, limits, {
  minimum = 1,
  allowed = null,
} = {}) {
  if (!Array.isArray(value)
      || value.length < minimum
      || value.length > limits.max_array_items) {
    throw packetError(
      "BUSINESS_DISPATCH_PACKET_INVALID",
      `${fieldPath} must be a bounded list`,
      { path: fieldPath },
    );
  }
  const normalized = value.map((entry, index) => (
    portableRef(entry, `${fieldPath}[${index}]`, limits)
  ));
  if (new Set(normalized).size !== normalized.length
      || (allowed && normalized.some((entry) => !allowed.has(entry)))) {
    throw packetError(
      "BUSINESS_DISPATCH_PACKET_INVALID",
      `${fieldPath} must contain unique supported values`,
      { path: fieldPath },
    );
  }
  return normalized.sort(compareText);
}

function scanCanonicalInput(value, limits, {
  rejectReservedPacketKeys = true,
  rootPath = "packet",
} = {}) {
  let nodes = 0;
  const ancestors = new Set();

  function visit(entry, depth, fieldPath) {
    nodes += 1;
    if (nodes > limits.max_input_nodes || depth > limits.max_input_depth) {
      throw packetError(
        "BUSINESS_DISPATCH_PACKET_LIMIT",
        "Dispatch packet canonical input exceeds its structural limit",
        { path: fieldPath },
      );
    }
    if (entry === null || typeof entry === "boolean") return;
    if (typeof entry === "number") {
      if (!Number.isFinite(entry)) {
        throw packetError(
          "BUSINESS_DISPATCH_PACKET_INVALID",
          `${fieldPath} contains a non-finite number`,
          { path: fieldPath },
        );
      }
      return;
    }
    if (typeof entry === "string") {
      if (Buffer.byteLength(entry, "utf8") > limits.max_string_bytes) {
        throw packetError(
          "BUSINESS_DISPATCH_PACKET_LIMIT",
          `${fieldPath} contains oversized text`,
          { path: fieldPath },
        );
      }
      return;
    }
    if (typeof entry !== "object") {
      throw packetError(
        "BUSINESS_DISPATCH_PACKET_INVALID",
        `${fieldPath} is not canonical JSON`,
        { path: fieldPath },
      );
    }
    if (ancestors.has(entry)) {
      throw packetError(
        "BUSINESS_DISPATCH_PACKET_INVALID",
        `${fieldPath} contains a cycle`,
        { path: fieldPath },
      );
    }
    const symbolCount = Object.getOwnPropertySymbols(entry).length;
    if (symbolCount !== 0) {
      throw packetError(
        "BUSINESS_DISPATCH_PACKET_INVALID",
        `${fieldPath} contains symbol fields`,
        { path: fieldPath },
      );
    }
    ancestors.add(entry);
    try {
      if (Array.isArray(entry)) {
        if (entry.length > limits.max_array_items) {
          throw packetError(
            "BUSINESS_DISPATCH_PACKET_LIMIT",
            `${fieldPath} contains too many items`,
            { path: fieldPath },
          );
        }
        const names = Object.getOwnPropertyNames(entry);
        if (names.some((name) => name !== "length"
            && (!/^\d+$/u.test(name) || Number(name) >= entry.length))
            || entry.some((_, index) => !Object.hasOwn(entry, index))) {
          throw packetError(
            "BUSINESS_DISPATCH_PACKET_INVALID",
            `${fieldPath} is not a dense canonical array`,
            { path: fieldPath },
          );
        }
        for (let index = 0; index < entry.length; index += 1) {
          if (!Object.hasOwn(entry, index)) {
            throw packetError(
              "BUSINESS_DISPATCH_PACKET_INVALID",
              `${fieldPath} is not a dense canonical array`,
              { path: fieldPath },
            );
          }
          visit(entry[index], depth + 1, `${fieldPath}[${index}]`);
        }
        return;
      }
      if (!isPlainObject(entry)) {
        throw packetError(
          "BUSINESS_DISPATCH_PACKET_INVALID",
          `${fieldPath} must contain only plain objects`,
          { path: fieldPath },
        );
      }
      const descriptors = Object.getOwnPropertyDescriptors(entry);
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
          throw packetError(
            "BUSINESS_DISPATCH_PACKET_INVALID",
            `${fieldPath} contains hidden or computed fields`,
            { path: fieldPath },
          );
        }
        if (rejectReservedPacketKeys && RESERVED_PACKET_KEYS.has(key)) {
          throw packetError(
            "BUSINESS_DISPATCH_PACKET_INVALID",
            `Dispatch packets cannot contain ${key}`,
            { path: `${fieldPath}.${key}` },
          );
        }
        // Arbitrary request-payload keys can themselves contain sensitive
        // content. Never echo them through a validation path or error detail.
        visit(descriptor.value, depth + 1, `${fieldPath}.*`);
      }
    } finally {
      ancestors.delete(entry);
    }
  }

  visit(value, 0, rootPath);
}

function canonicalClone(value, limits) {
  scanCanonicalInput(value, limits);
  let serialized;
  try {
    serialized = canonicalJson(value);
  } catch (error) {
    throw packetError(
      "BUSINESS_DISPATCH_PACKET_INVALID",
      "Dispatch packet must be canonical JSON",
      { cause_code: error?.code || null },
    );
  }
  if (Buffer.byteLength(serialized, "utf8") > limits.max_packet_bytes) {
    throw packetError(
      "BUSINESS_DISPATCH_PACKET_LIMIT",
      "Dispatch packet exceeds its byte limit",
    );
  }
  return JSON.parse(serialized);
}

function normalizeDispatchPacketV1(input, inputLimits) {
  const limits = normalizeLimits(inputLimits);
  const packet = canonicalClone(input, limits);
  exactObject(packet, PACKET_FIELDS, "packet");
  if (packet.schema_version !== DISPATCH_PACKET_CONTRACT_VERSION) {
    throw packetError(
      "BUSINESS_DISPATCH_PACKET_INVALID",
      "packet.schema_version must be DispatchPacketV1",
      { path: "packet.schema_version" },
    );
  }

  const workOrder = exactObject(packet.work_order, WORK_ORDER_FIELDS, "packet.work_order");
  const plan = exactObject(packet.plan, PLAN_FIELDS, "packet.plan");
  const branch = exactObject(packet.branch, BRANCH_FIELDS, "packet.branch");
  const provider = exactObject(packet.provider, PROVIDER_FIELDS, "packet.provider");
  const workspace = exactObject(packet.workspace, WORKSPACE_FIELDS, "packet.workspace");
  const context = exactObject(packet.context, CONTEXT_FIELDS, "packet.context");
  const authority = exactObject(packet.authority, AUTHORITY_FIELDS, "packet.authority");
  const effectCeiling = exactObject(
    packet.effect_ceiling,
    EFFECT_CEILING_FIELDS,
    "packet.effect_ceiling",
  );

  const normalized = {
    schema_version: DISPATCH_PACKET_CONTRACT_VERSION,
    work_order: {
      work_order_id: portableRef(
        workOrder.work_order_id,
        "packet.work_order.work_order_id",
        limits,
      ),
      work_order_revision: integer(
        workOrder.work_order_revision,
        "packet.work_order.work_order_revision",
        0,
        1_000_000_000,
      ),
      engine_contract_version: integer(
        workOrder.engine_contract_version,
        "packet.work_order.engine_contract_version",
        2,
        2,
      ),
    },
    plan: {
      plan_snapshot_ref: portableRef(
        plan.plan_snapshot_ref,
        "packet.plan.plan_snapshot_ref",
        limits,
      ),
      plan_hash: sha256(plan.plan_hash, "packet.plan.plan_hash"),
    },
    branch: {
      branch_ref: portableRef(branch.branch_ref, "packet.branch.branch_ref", limits),
      next_attempt: integer(
        branch.next_attempt,
        "packet.branch.next_attempt",
        1,
        1_000_000,
      ),
      task_intent_ref: contentRef(
        branch.task_intent_ref,
        "packet.branch.task_intent_ref",
        limits,
      ),
      execution_plan_ref: contentRef(
        branch.execution_plan_ref,
        "packet.branch.execution_plan_ref",
        limits,
      ),
      attempt_packet_ref: nullableContentRef(
        branch.attempt_packet_ref,
        "packet.branch.attempt_packet_ref",
        limits,
      ),
    },
    provider: {
      provider_ref: portableRef(provider.provider_ref, "packet.provider.provider_ref", limits),
      configuration_ref: contentRef(
        provider.configuration_ref,
        "packet.provider.configuration_ref",
        limits,
      ),
    },
    workspace: {
      workspace_ref: portableRef(workspace.workspace_ref, "packet.workspace.workspace_ref", limits),
      checkpoint_ref: contentRef(
        workspace.checkpoint_ref,
        "packet.workspace.checkpoint_ref",
        limits,
      ),
      isolation_mode: portableRef(
        workspace.isolation_mode,
        "packet.workspace.isolation_mode",
        limits,
      ),
    },
    context: {
      context_pack_ref: contentRef(
        context.context_pack_ref,
        "packet.context.context_pack_ref",
        limits,
      ),
      context_manifest_ref: contentRef(
        context.context_manifest_ref,
        "packet.context.context_manifest_ref",
        limits,
      ),
      request_payload: context.request_payload,
      user_input_request_id: nullablePortableRef(
        context.user_input_request_id,
        "packet.context.user_input_request_id",
        limits,
      ),
      user_input_response_ref: nullableContentRef(
        context.user_input_response_ref,
        "packet.context.user_input_response_ref",
        limits,
      ),
    },
    authority: {
      authority_ref: contentRef(
        authority.authority_ref,
        "packet.authority.authority_ref",
        limits,
      ),
      principal_type: portableRef(
        authority.principal_type,
        "packet.authority.principal_type",
        limits,
      ),
      principal_id: portableRef(
        authority.principal_id,
        "packet.authority.principal_id",
        limits,
      ),
      project_ref: portableRef(authority.project_ref, "packet.authority.project_ref", limits),
      permission_mode: portableRef(
        authority.permission_mode,
        "packet.authority.permission_mode",
        limits,
      ),
      allowed_provider_refs: stringSet(
        authority.allowed_provider_refs,
        "packet.authority.allowed_provider_refs",
        limits,
      ),
      allowed_effects: stringSet(
        authority.allowed_effects,
        "packet.authority.allowed_effects",
        limits,
      ),
    },
    effect_ceiling: {
      allowed_effect_kinds: stringSet(
        effectCeiling.allowed_effect_kinds,
        "packet.effect_ceiling.allowed_effect_kinds",
        limits,
        { allowed: EFFECT_KIND_SET },
      ),
      deadline_at: timestamp(effectCeiling.deadline_at, "packet.effect_ceiling.deadline_at"),
      max_runtime_ms: integer(
        effectCeiling.max_runtime_ms,
        "packet.effect_ceiling.max_runtime_ms",
        1,
        limits.max_runtime_ms,
      ),
      max_output_bytes: integer(
        effectCeiling.max_output_bytes,
        "packet.effect_ceiling.max_output_bytes",
        1,
        limits.max_output_bytes,
      ),
      max_tool_calls: integer(
        effectCeiling.max_tool_calls,
        "packet.effect_ceiling.max_tool_calls",
        0,
        limits.max_tool_calls,
      ),
    },
  };

  if (!ISOLATION_MODES.has(normalized.workspace.isolation_mode)
      || !PRINCIPAL_TYPES.has(normalized.authority.principal_type)
      || !PERMISSION_MODES.has(normalized.authority.permission_mode)) {
    throw packetError(
      "BUSINESS_DISPATCH_PACKET_INVALID",
      "Dispatch packet workspace or authority mode is unsupported",
    );
  }
  if (!normalized.authority.allowed_provider_refs.includes(normalized.provider.provider_ref)
      || normalized.effect_ceiling.allowed_effect_kinds.some(
        (effectKind) => !normalized.authority.allowed_effects.includes(effectKind),
      )) {
    throw packetError(
      "BUSINESS_DISPATCH_PACKET_CAPABILITY_MISMATCH",
      "Packet provider and effect ceilings must be covered by its authority",
    );
  }
  const hasRequestId = normalized.context.user_input_request_id !== null;
  const hasResponseRef = normalized.context.user_input_response_ref !== null;
  if (hasRequestId !== hasResponseRef) {
    throw packetError(
      "BUSINESS_DISPATCH_PACKET_INVALID",
      "User-input request and response bindings must be present together",
    );
  }
  return deepFreeze(normalized);
}

function packetReferenceFromHash(hash) {
  return deepFreeze({ id: `dispatch-packet:${hash}`, hash });
}

function normalizePacketReference(value, limits) {
  let ref;
  try {
    ref = contentRef(value, "packet_ref", limits);
  } catch (error) {
    if (error instanceof BusinessPacketStoreError) {
      throw packetError(
        "BUSINESS_DISPATCH_PACKET_REFERENCE_INVALID",
        "Packet reference is invalid",
      );
    }
    throw error;
  }
  if (ref.id !== `dispatch-packet:${ref.hash}`) {
    throw packetError(
      "BUSINESS_DISPATCH_PACKET_REFERENCE_INVALID",
      "Packet reference and hash do not address the same content",
    );
  }
  return deepFreeze(ref);
}

function packetFileName(hash) {
  return `dispatch-packet-${hash}.json`;
}

function normalizeLimits(value) {
  if (value === undefined) return DISPATCH_PACKET_STORE_LIMITS;
  if (!isPlainObject(value)
      || Object.keys(value).some((key) => !LIMIT_FIELDS.has(key))) {
    throw packetError(
      "BUSINESS_PACKET_STORE_CONFIGURATION_INVALID",
      "PacketStore limits may contain only known non-weakened ceilings",
    );
  }
  const normalized = {};
  for (const field of LIMIT_FIELDS) {
    const maximum = DISPATCH_PACKET_STORE_LIMITS[field];
    const candidate = Object.hasOwn(value, field) ? value[field] : maximum;
    const minimum = field === "max_tool_calls" ? 0 : 1;
    if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
      throw packetError(
        "BUSINESS_PACKET_STORE_CONFIGURATION_INVALID",
        `PacketStore limit ${field} cannot weaken the built-in ceiling`,
      );
    }
    normalized[field] = candidate;
  }
  return deepFreeze(normalized);
}

function validatePlatformAdapter(adapter) {
  if (!adapter || typeof adapter !== "object" || Array.isArray(adapter)
      || PLATFORM_ADAPTER_METHODS.some((method) => typeof adapter[method] !== "function")) {
    throw packetError(
      "BUSINESS_PACKET_STORE_CONFIGURATION_INVALID",
      "A complete trusted PacketStore platform adapter is required",
    );
  }
  return adapter;
}

function validateRootPath(rootPath) {
  if (typeof rootPath !== "string"
      || rootPath.trim() === ""
      || rootPath !== path.resolve(rootPath)
      || path.normalize(rootPath) !== rootPath) {
    throw packetError(
      "BUSINESS_PACKET_STORE_CONFIGURATION_INVALID",
      "root_path must be one normalized absolute path",
    );
  }
  return rootPath;
}

function validateSecurityProof(proof, rootPath) {
  if (process.platform === "win32" || proof?.platform === "win32") {
    throw packetError(
      "BUSINESS_PACKET_STORE_UNTRUSTED_PLATFORM",
      "Dispatch PacketStore is fail-closed on Windows",
    );
  }
  if (!isPlainObject(proof)
      || Object.keys(proof).length !== SECURITY_PROOF_FIELDS.size
      || Object.keys(proof).some((field) => !SECURITY_PROOF_FIELDS.has(field))
      || proof.proof_version !== 1
      || proof.platform === "win32"
      || typeof proof.platform !== "string"
      || proof.root_realpath !== rootPath
      || typeof proof.privacy_enforcement !== "string"
      || proof.privacy_enforcement.trim() === ""
      || /chmod/iu.test(proof.privacy_enforcement)
      || proof.owner_only_directories !== true
      || proof.owner_only_files !== true
      || proof.private_acl_verified !== true
      || proof.symlink_components_rejected !== true
      || proof.no_follow_reads !== true
      || proof.exclusive_temp_creation !== true
      || proof.atomic_no_replace_rename !== true
      || proof.file_fsync !== true
      || proof.directory_fsync !== true
      || proof.coordinated_recovery !== true
      || proof.directory_handle_pinned !== true) {
    throw packetError(
      "BUSINESS_PACKET_STORE_SECURITY_UNVERIFIED",
      "Platform adapter did not prove a private, symlink-safe, durable PacketStore",
    );
  }
  return proof;
}

function validateRecoveryProof(proof, rootPath) {
  if (!isPlainObject(proof)
      || Object.keys(proof).length !== RECOVERY_PROOF_FIELDS.size
      || Object.keys(proof).some((field) => !RECOVERY_PROOF_FIELDS.has(field))
      || proof.recovery_version !== 1
      || proof.root_realpath !== rootPath
      || proof.exclusive_recovery !== true
      || proof.stale_temps_handled !== true
      || proof.directory_fsynced !== true) {
    throw packetError(
      "BUSINESS_PACKET_STORE_RECOVERY_FAILED",
      "Platform adapter did not complete coordinated PacketStore recovery",
    );
  }
  return proof;
}

function adapterErrorCode(error) {
  return typeof error?.code === "string" ? error.code : null;
}

function isMissing(error) {
  return adapterErrorCode(error) === "ENOENT";
}

function isExists(error) {
  return adapterErrorCode(error) === "EEXIST";
}

function isUnsafePath(error) {
  return ["ELOOP", "ENOTDIR", "PACKET_STORE_UNSAFE_PATH"].includes(adapterErrorCode(error));
}

function normalizeStoredPacketBytes(bytes, ref, limits, { conflict = false } = {}) {
  const failureCode = conflict
    ? "BUSINESS_DISPATCH_PACKET_CONFLICT"
    : "BUSINESS_DISPATCH_PACKET_TAMPERED";
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > limits.max_packet_bytes + 1) {
    throw packetError(failureCode, "Stored DispatchPacket bytes are invalid", {
      packet_ref: ref.id,
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw packetError(failureCode, "Stored DispatchPacket is not JSON", {
      packet_ref: ref.id,
    });
  }
  let normalized;
  try {
    normalized = normalizeDispatchPacketV1(parsed, limits);
  } catch (error) {
    throw packetError(failureCode, "Stored DispatchPacket does not satisfy Packet V1", {
      packet_ref: ref.id,
      cause_code: error?.code || null,
    });
  }
  const canonicalBytes = Buffer.from(`${canonicalJson(normalized)}\n`, "utf8");
  const actualHash = canonicalHash(normalized);
  if (!bytes.equals(canonicalBytes) || actualHash !== ref.hash) {
    throw packetError(failureCode, "Stored DispatchPacket content address does not verify", {
      packet_ref: ref.id,
    });
  }
  return normalized;
}

function normalizeRuntimeIdentity(value, fieldPath, limits) {
  if (value === null) return null;
  const identity = exactObject(value, RUNTIME_IDENTITY_FIELDS, fieldPath);
  const normalized = {};
  for (const field of RUNTIME_IDENTITY_FIELDS) {
    normalized[field] = identity[field] === null
      ? null
      : portableRef(identity[field], `${fieldPath}.${field}`, limits);
  }
  if (Object.values(normalized).every((entry) => entry === null)) {
    throw packetError(
      "BUSINESS_DISPATCH_PACKET_EFFECT_BINDING",
      `${fieldPath} must identify a provider operation`,
    );
  }
  return normalized;
}

function canonicalEffectCandidate(value, limits) {
  try {
    scanCanonicalInput(value, limits, {
      rejectReservedPacketKeys: false,
      rootPath: "effect",
    });
    const serialized = canonicalJson(value);
    if (Buffer.byteLength(serialized, "utf8") > limits.max_packet_bytes) throw new Error("limit");
    return JSON.parse(serialized);
  } catch {
    throw packetError(
      "BUSINESS_DISPATCH_PACKET_EFFECT_BINDING",
      "verifyForEffect requires one bounded canonical Effect V2 identity",
    );
  }
}

function exactEffectCandidate(value, limits) {
  const candidate = canonicalEffectCandidate(value, limits);
  if (!isPlainObject(candidate)
      || Object.keys(candidate).length !== V2_EFFECT_IDENTITY_FIELDS.length
      || Object.keys(candidate).some((field) => !V2_EFFECT_IDENTITY_FIELDS.includes(field))) {
    throw packetError(
      "BUSINESS_DISPATCH_PACKET_EFFECT_BINDING",
      "verifyForEffect requires the exact immutable Effect V2 identity",
    );
  }
  return candidate;
}

function locateEffectPacket(value, limits) {
  const candidate = exactEffectCandidate(value, limits);
  let ref;
  try {
    ref = normalizePacketReference({
      id: candidate.packet_ref,
      hash: candidate.packet_hash,
    }, limits);
  } catch {
    throw packetError(
      "BUSINESS_DISPATCH_PACKET_EFFECT_BINDING",
      "Effect packet fields do not form one content address",
    );
  }
  return { candidate, ref };
}

function normalizeEffectIdentityV2(value, limits) {
  const candidate = exactEffectCandidate(value, limits);
  const normalized = {
    effect_id: portableRef(candidate.effect_id, "effect.effect_id", limits),
    effect_contract_version: integer(
      candidate.effect_contract_version,
      "effect.effect_contract_version",
      2,
      2,
    ),
    work_order_id: portableRef(candidate.work_order_id, "effect.work_order_id", limits),
    branch_ref: portableRef(candidate.branch_ref, "effect.branch_ref", limits),
    attempt: integer(candidate.attempt, "effect.attempt", 1, 1_000_000),
    dispatch_id: portableRef(candidate.dispatch_id, "effect.dispatch_id", limits),
    effect_kind: portableRef(candidate.effect_kind, "effect.effect_kind", limits),
    origin_source_id: portableRef(candidate.origin_source_id, "effect.origin_source_id", limits),
    operation_scope_hash: sha256(candidate.operation_scope_hash, "effect.operation_scope_hash"),
    operation_generation: integer(
      candidate.operation_generation,
      "effect.operation_generation",
      1,
      1_000_000,
    ),
    generation_predecessor_effect_id: nullablePortableRef(
      candidate.generation_predecessor_effect_id,
      "effect.generation_predecessor_effect_id",
      limits,
    ),
    provider_ref: portableRef(candidate.provider_ref, "effect.provider_ref", limits),
    packet_ref: portableRef(candidate.packet_ref, "effect.packet_ref", limits),
    packet_hash: sha256(candidate.packet_hash, "effect.packet_hash"),
    predecessor_effect_id: nullablePortableRef(
      candidate.predecessor_effect_id,
      "effect.predecessor_effect_id",
      limits,
    ),
    predecessor_delivery_hash: candidate.predecessor_delivery_hash === null
      ? null
      : sha256(candidate.predecessor_delivery_hash, "effect.predecessor_delivery_hash"),
    target_runtime_identity: normalizeRuntimeIdentity(
      candidate.target_runtime_identity,
      "effect.target_runtime_identity",
      limits,
    ),
    idempotency_key: portableRef(candidate.idempotency_key, "effect.idempotency_key", limits),
    created_at: timestamp(candidate.created_at, "effect.created_at"),
  };
  if (!EFFECT_KIND_SET.has(normalized.effect_kind)
      || ((normalized.operation_generation === 1)
        !== (normalized.generation_predecessor_effect_id === null))
      || ((normalized.predecessor_effect_id === null)
        !== (normalized.predecessor_delivery_hash === null))) {
    throw packetError(
      "BUSINESS_DISPATCH_PACKET_EFFECT_BINDING",
      "Effect V2 stage and generation bindings are invalid",
    );
  }
  const isThreadCreate = normalized.effect_kind === "provider.thread.create";
  const requiresTarget = !isThreadCreate;
  if (isThreadCreate
      ? (normalized.predecessor_effect_id !== null
        || normalized.predecessor_delivery_hash !== null
        || normalized.target_runtime_identity !== null)
      : (normalized.predecessor_effect_id === null
        || normalized.predecessor_delivery_hash === null
        || normalized.target_runtime_identity === null)) {
    throw packetError(
      "BUSINESS_DISPATCH_PACKET_EFFECT_BINDING",
      requiresTarget
        ? "Follow-on effects require exact predecessor delivery and runtime identity"
        : "Thread creation cannot carry predecessor or runtime identity",
    );
  }
  return deepFreeze(normalized);
}

function effectSeed(effect) {
  return Object.fromEntries(V2_EFFECT_IDENTITY_FIELDS
    .filter((field) => !["effect_id", "idempotency_key", "created_at"].includes(field))
    .map((field) => [field, effect[field]]));
}

function deterministicId(prefix, value) {
  return `${prefix}-${canonicalHash(value).slice(0, 32)}`;
}

function verifyPacketEffectBinding(packet, packetRef, effect) {
  if (effect.packet_ref !== packetRef.id || effect.packet_hash !== packetRef.hash
      || effect.work_order_id !== packet.work_order.work_order_id
      || effect.branch_ref !== packet.branch.branch_ref
      || effect.attempt !== packet.branch.next_attempt
      || effect.provider_ref !== packet.provider.provider_ref) {
    throw packetError(
      "BUSINESS_DISPATCH_PACKET_EFFECT_BINDING",
      "Effect does not bind the exact packet Work Order, branch, attempt, and provider",
    );
  }
  if (!packet.effect_ceiling.allowed_effect_kinds.includes(effect.effect_kind)
      || !packet.authority.allowed_effects.includes(effect.effect_kind)
      || !packet.authority.allowed_provider_refs.includes(effect.provider_ref)) {
    throw packetError(
      "BUSINESS_DISPATCH_PACKET_CAPABILITY_MISMATCH",
      "Effect exceeds the packet provider or effect capability ceiling",
    );
  }
  if (Date.parse(effect.created_at) > Date.parse(packet.effect_ceiling.deadline_at)) {
    throw packetError(
      "BUSINESS_DISPATCH_PACKET_POLICY_MISMATCH",
      "Effect was created after the packet deadline ceiling",
    );
  }

  const isAttemptPacket = ["provider.thread.create", "provider.turn.start"]
    .includes(effect.effect_kind);
  const dispatchPacketRef = isAttemptPacket
    ? packetRef
    : packet.branch.attempt_packet_ref;
  if (dispatchPacketRef === null) {
    throw packetError(
      "BUSINESS_DISPATCH_PACKET_EFFECT_BINDING",
      "A follow-on packet must bind its original attempt packet reference",
    );
  }
  if (isAttemptPacket && packet.branch.attempt_packet_ref !== null) {
    throw packetError(
      "BUSINESS_DISPATCH_PACKET_EFFECT_BINDING",
      "An attempt packet cannot replace its own content address with another basis",
    );
  }
  const dispatchSeed = {
    work_order_id: effect.work_order_id,
    branch_ref: effect.branch_ref,
    attempt: effect.attempt,
    packet_ref: dispatchPacketRef,
  };
  if (effect.dispatch_id !== deterministicId("DSP", dispatchSeed)) {
    throw packetError(
      "BUSINESS_DISPATCH_PACKET_EFFECT_BINDING",
      "Effect dispatch identifier does not derive from the immutable attempt packet",
    );
  }

  const operationBindingCandidate = {
    effect_kind: effect.effect_kind,
    provider_ref: effect.provider_ref,
    packet_ref: effect.packet_ref,
    packet_hash: effect.packet_hash,
    predecessor_effect_id: effect.predecessor_effect_id,
    predecessor_delivery_hash: effect.predecessor_delivery_hash,
    target_runtime_identity: effect.target_runtime_identity,
    request_id: packet.context.user_input_request_id,
    response_ref: packet.context.user_input_response_ref,
  };
  let operationBinding;
  try {
    operationBinding = normalizeSendAuthorizationOperationScopeBindingV2(
      operationBindingCandidate,
      effect,
    );
  } catch (error) {
    if (!(error instanceof BusinessSendAuthorizationError)) throw error;
    throw packetError(
      "BUSINESS_DISPATCH_PACKET_EFFECT_BINDING",
      "Effect operation scope does not derive from the verified packet and stage binding",
      { cause_code: error.code },
    );
  }

  const seed = effectSeed(effect);
  if (effect.effect_id !== deterministicId("FX", seed)
      || effect.idempotency_key !== deterministicId("IDEM", seed)) {
    throw packetError(
      "BUSINESS_DISPATCH_PACKET_EFFECT_BINDING",
      "Effect and idempotency identifiers do not derive from the immutable Effect V2 identity",
    );
  }
  return { dispatchSeed, dispatchPacketRef, effectSeed: seed, operationBinding };
}

function redactedPacketBinding(packet, dispatchPacketRef) {
  return {
    work_order_id: packet.work_order.work_order_id,
    work_order_revision: packet.work_order.work_order_revision,
    engine_contract_version: packet.work_order.engine_contract_version,
    plan_snapshot_ref: packet.plan.plan_snapshot_ref,
    plan_hash: packet.plan.plan_hash,
    branch_ref: packet.branch.branch_ref,
    next_attempt: packet.branch.next_attempt,
    task_intent_ref: packet.branch.task_intent_ref,
    execution_plan_ref: packet.branch.execution_plan_ref,
    dispatch_packet_ref: dispatchPacketRef,
    provider_ref: packet.provider.provider_ref,
    provider_configuration_ref: packet.provider.configuration_ref,
    workspace_ref: packet.workspace.workspace_ref,
    workspace_checkpoint_ref: packet.workspace.checkpoint_ref,
    isolation_mode: packet.workspace.isolation_mode,
    context_pack_ref: packet.context.context_pack_ref,
    context_manifest_ref: packet.context.context_manifest_ref,
    context_binding_hash: canonicalHash(packet.context),
    authority_ref: packet.authority.authority_ref,
    principal_type: packet.authority.principal_type,
    principal_id: packet.authority.principal_id,
    project_ref: packet.authority.project_ref,
    permission_mode: packet.authority.permission_mode,
    authority_ceiling_hash: canonicalHash(packet.authority),
    effect_ceiling_hash: canonicalHash(packet.effect_ceiling),
  };
}

function verificationReceipt(packet, packetRef, effect, verified) {
  const body = {
    schema_version: DISPATCH_PACKET_VERIFICATION_RECEIPT_VERSION,
    disposition: "verified",
    failure_class: null,
    failure_taxonomy_version: 1,
    delivery_disposition: "not_evaluated",
    verification_scope: "packet_integrity_and_effect_binding_only",
    retry_authorization: "not_evaluated",
    packet_ref: packetRef,
    packet_binding: redactedPacketBinding(packet, verified.dispatchPacketRef),
    effect_identity: effect,
    dispatch_identity_hash: canonicalHash(verified.dispatchSeed),
    effect_identity_hash: canonicalHash(effect),
    effect_identifier_seed_hash: canonicalHash(verified.effectSeed),
    generation_binding_hash: canonicalHash({
      operation_scope_hash: effect.operation_scope_hash,
      operation_generation: effect.operation_generation,
      generation_predecessor_effect_id: effect.generation_predecessor_effect_id,
    }),
  };
  const receiptHash = canonicalHash(body);
  return deepFreeze({
    ...body,
    receipt_ref: `dispatch-packet-verification:${receiptHash}`,
    receipt_hash: receiptHash,
  });
}

function normalizeDispatchPacketVerificationReceiptV1(input, limits) {
  const normalizedLimits = normalizeLimits(limits);
  let candidate;
  try {
    scanCanonicalInput(input, normalizedLimits, {
      rejectReservedPacketKeys: false,
      rootPath: "verification_receipt",
    });
    const serialized = canonicalJson(input);
    if (Buffer.byteLength(serialized, "utf8") > normalizedLimits.max_packet_bytes) {
      throw new Error("limit");
    }
    candidate = JSON.parse(serialized);
  } catch {
    throw packetError(
      "BUSINESS_DISPATCH_PACKET_EFFECT_BINDING",
      "Packet verification receipt must be bounded canonical JSON",
    );
  }
  const receipt = exactObject(
    candidate,
    VERIFICATION_RECEIPT_FIELDS,
    "verification_receipt",
  );
  const rawBinding = exactObject(
    receipt.packet_binding,
    VERIFICATION_BINDING_FIELDS,
    "verification_receipt.packet_binding",
  );
  const packetRef = contentRef(
    receipt.packet_ref,
    "verification_receipt.packet_ref",
    normalizedLimits,
  );
  const binding = {
    work_order_id: portableRef(
      rawBinding.work_order_id,
      "verification_receipt.packet_binding.work_order_id",
      normalizedLimits,
    ),
    work_order_revision: integer(
      rawBinding.work_order_revision,
      "verification_receipt.packet_binding.work_order_revision",
      1,
      1_000_000_000,
    ),
    engine_contract_version: integer(
      rawBinding.engine_contract_version,
      "verification_receipt.packet_binding.engine_contract_version",
      2,
      2,
    ),
    plan_snapshot_ref: portableRef(
      rawBinding.plan_snapshot_ref,
      "verification_receipt.packet_binding.plan_snapshot_ref",
      normalizedLimits,
    ),
    plan_hash: sha256(
      rawBinding.plan_hash,
      "verification_receipt.packet_binding.plan_hash",
    ),
    branch_ref: portableRef(
      rawBinding.branch_ref,
      "verification_receipt.packet_binding.branch_ref",
      normalizedLimits,
    ),
    next_attempt: integer(
      rawBinding.next_attempt,
      "verification_receipt.packet_binding.next_attempt",
      1,
      1_000_000,
    ),
    task_intent_ref: contentRef(
      rawBinding.task_intent_ref,
      "verification_receipt.packet_binding.task_intent_ref",
      normalizedLimits,
    ),
    execution_plan_ref: contentRef(
      rawBinding.execution_plan_ref,
      "verification_receipt.packet_binding.execution_plan_ref",
      normalizedLimits,
    ),
    dispatch_packet_ref: contentRef(
      rawBinding.dispatch_packet_ref,
      "verification_receipt.packet_binding.dispatch_packet_ref",
      normalizedLimits,
    ),
    provider_ref: portableRef(
      rawBinding.provider_ref,
      "verification_receipt.packet_binding.provider_ref",
      normalizedLimits,
    ),
    provider_configuration_ref: contentRef(
      rawBinding.provider_configuration_ref,
      "verification_receipt.packet_binding.provider_configuration_ref",
      normalizedLimits,
    ),
    workspace_ref: portableRef(
      rawBinding.workspace_ref,
      "verification_receipt.packet_binding.workspace_ref",
      normalizedLimits,
    ),
    workspace_checkpoint_ref: contentRef(
      rawBinding.workspace_checkpoint_ref,
      "verification_receipt.packet_binding.workspace_checkpoint_ref",
      normalizedLimits,
    ),
    isolation_mode: portableRef(
      rawBinding.isolation_mode,
      "verification_receipt.packet_binding.isolation_mode",
      normalizedLimits,
    ),
    context_pack_ref: contentRef(
      rawBinding.context_pack_ref,
      "verification_receipt.packet_binding.context_pack_ref",
      normalizedLimits,
    ),
    context_manifest_ref: contentRef(
      rawBinding.context_manifest_ref,
      "verification_receipt.packet_binding.context_manifest_ref",
      normalizedLimits,
    ),
    context_binding_hash: sha256(
      rawBinding.context_binding_hash,
      "verification_receipt.packet_binding.context_binding_hash",
    ),
    authority_ref: contentRef(
      rawBinding.authority_ref,
      "verification_receipt.packet_binding.authority_ref",
      normalizedLimits,
    ),
    principal_type: portableRef(
      rawBinding.principal_type,
      "verification_receipt.packet_binding.principal_type",
      normalizedLimits,
    ),
    principal_id: portableRef(
      rawBinding.principal_id,
      "verification_receipt.packet_binding.principal_id",
      normalizedLimits,
    ),
    project_ref: portableRef(
      rawBinding.project_ref,
      "verification_receipt.packet_binding.project_ref",
      normalizedLimits,
    ),
    permission_mode: portableRef(
      rawBinding.permission_mode,
      "verification_receipt.packet_binding.permission_mode",
      normalizedLimits,
    ),
    authority_ceiling_hash: sha256(
      rawBinding.authority_ceiling_hash,
      "verification_receipt.packet_binding.authority_ceiling_hash",
    ),
    effect_ceiling_hash: sha256(
      rawBinding.effect_ceiling_hash,
      "verification_receipt.packet_binding.effect_ceiling_hash",
    ),
  };
  if (!ISOLATION_MODES.has(binding.isolation_mode)
      || !PRINCIPAL_TYPES.has(binding.principal_type)
      || !PERMISSION_MODES.has(binding.permission_mode)) {
    throw packetError(
      "BUSINESS_DISPATCH_PACKET_EFFECT_BINDING",
      "Packet verification receipt carries an unsupported security binding",
    );
  }
  const effect = normalizeEffectIdentityV2(receipt.effect_identity, normalizedLimits);
  const normalized = {
    schema_version: integer(
      receipt.schema_version,
      "verification_receipt.schema_version",
      DISPATCH_PACKET_VERIFICATION_RECEIPT_VERSION,
      DISPATCH_PACKET_VERIFICATION_RECEIPT_VERSION,
    ),
    disposition: receipt.disposition,
    failure_class: receipt.failure_class,
    failure_taxonomy_version: integer(
      receipt.failure_taxonomy_version,
      "verification_receipt.failure_taxonomy_version",
      1,
      1,
    ),
    delivery_disposition: receipt.delivery_disposition,
    verification_scope: receipt.verification_scope,
    retry_authorization: receipt.retry_authorization,
    packet_ref: packetRef,
    packet_binding: binding,
    effect_identity: effect,
    dispatch_identity_hash: sha256(
      receipt.dispatch_identity_hash,
      "verification_receipt.dispatch_identity_hash",
    ),
    effect_identity_hash: sha256(
      receipt.effect_identity_hash,
      "verification_receipt.effect_identity_hash",
    ),
    effect_identifier_seed_hash: sha256(
      receipt.effect_identifier_seed_hash,
      "verification_receipt.effect_identifier_seed_hash",
    ),
    generation_binding_hash: sha256(
      receipt.generation_binding_hash,
      "verification_receipt.generation_binding_hash",
    ),
    receipt_ref: portableRef(
      receipt.receipt_ref,
      "verification_receipt.receipt_ref",
      normalizedLimits,
    ),
    receipt_hash: sha256(receipt.receipt_hash, "verification_receipt.receipt_hash"),
  };
  if (normalized.disposition !== "verified"
      || normalized.failure_class !== null
      || normalized.delivery_disposition !== "not_evaluated"
      || normalized.verification_scope !== "packet_integrity_and_effect_binding_only"
      || normalized.retry_authorization !== "not_evaluated") {
    throw packetError(
      "BUSINESS_DISPATCH_PACKET_EFFECT_BINDING",
      "Packet verification receipt does not prove the restricted verification scope",
    );
  }
  const dispatchSeed = {
    work_order_id: effect.work_order_id,
    branch_ref: effect.branch_ref,
    attempt: effect.attempt,
    packet_ref: binding.dispatch_packet_ref,
  };
  const expectedSeed = effectSeed(effect);
  const expectedGenerationBindingHash = canonicalHash({
    operation_scope_hash: effect.operation_scope_hash,
    operation_generation: effect.operation_generation,
    generation_predecessor_effect_id: effect.generation_predecessor_effect_id,
  });
  if (packetRef.id !== effect.packet_ref
      || packetRef.hash !== effect.packet_hash
      || binding.work_order_id !== effect.work_order_id
      || binding.branch_ref !== effect.branch_ref
      || binding.next_attempt !== effect.attempt
      || binding.provider_ref !== effect.provider_ref
      || effect.dispatch_id !== deterministicId("DSP", dispatchSeed)
      || normalized.dispatch_identity_hash !== canonicalHash(dispatchSeed)
      || normalized.effect_identity_hash !== canonicalHash(effect)
      || normalized.effect_identifier_seed_hash !== canonicalHash(expectedSeed)
      || normalized.generation_binding_hash !== expectedGenerationBindingHash) {
    throw packetError(
      "BUSINESS_DISPATCH_PACKET_EFFECT_BINDING",
      "Packet verification receipt does not bind the exact immutable Effect",
    );
  }
  const body = { ...normalized };
  delete body.receipt_ref;
  delete body.receipt_hash;
  const expectedReceiptHash = canonicalHash(body);
  if (normalized.receipt_hash !== expectedReceiptHash
      || normalized.receipt_ref !== `dispatch-packet-verification:${expectedReceiptHash}`) {
    throw packetError(
      "BUSINESS_DISPATCH_PACKET_EFFECT_BINDING",
      "Packet verification receipt content address does not verify",
    );
  }
  return deepFreeze(normalized);
}

function normalizeDispatchPacketSendAuthorizationVerificationV1(input, limits) {
  const normalizedLimits = normalizeLimits(limits);
  let candidate;
  try {
    scanCanonicalInput(input, normalizedLimits, {
      rejectReservedPacketKeys: false,
      rootPath: "send_authorization_verification",
    });
    const serialized = canonicalJson(input);
    if (Buffer.byteLength(serialized, "utf8") > normalizedLimits.max_packet_bytes) {
      throw new Error("limit");
    }
    candidate = exactObject(
      JSON.parse(serialized),
      SEND_AUTHORIZATION_VERIFICATION_FIELDS,
      "send_authorization_verification",
    );
  } catch {
    throw packetError(
      "BUSINESS_DISPATCH_PACKET_EFFECT_BINDING",
      "Send authorization verification must be bounded canonical JSON",
    );
  }
  const receipt = normalizeDispatchPacketVerificationReceiptV1(
    candidate.packet_verification_receipt,
    normalizedLimits,
  );
  let operationScopeBinding;
  try {
    operationScopeBinding = normalizeSendAuthorizationOperationScopeBindingV2(
      candidate.operation_scope_binding,
      receipt.effect_identity,
    );
  } catch (error) {
    if (!(error instanceof BusinessSendAuthorizationError)) throw error;
    throw packetError(
      "BUSINESS_DISPATCH_PACKET_EFFECT_BINDING",
      "Send authorization verification has an invalid operation scope binding",
      { cause_code: error.code },
    );
  }
  if (integer(
    candidate.authorization_verification_version,
    "send_authorization_verification.authorization_verification_version",
    1,
    1,
  ) !== 1) {
    throw packetError(
      "BUSINESS_DISPATCH_PACKET_EFFECT_BINDING",
      "Send authorization verification version is unsupported",
    );
  }
  return deepFreeze({
    authorization_verification_version: 1,
    packet_verification_receipt: receipt,
    operation_scope_binding: operationScopeBinding,
  });
}

function createDispatchPacketStore({ root_path: rootPath, platform_adapter: inputAdapter, limits } = {}) {
  if (process.platform === "win32") {
    throw packetError(
      "BUSINESS_PACKET_STORE_UNTRUSTED_PLATFORM",
      "Dispatch PacketStore is fail-closed on Windows",
    );
  }
  const normalizedRootPath = validateRootPath(rootPath);
  const adapter = validatePlatformAdapter(inputAdapter);
  const normalizedLimits = normalizeLimits(limits);

  async function withSecureStore(operation, { recoverTarget = null } = {}) {
    let session;
    try {
      session = await adapter.openStore({ root_path: normalizedRootPath });
    } catch (error) {
      throw packetError(
        "BUSINESS_PACKET_STORE_SECURITY_UNVERIFIED",
        "Trusted platform adapter could not open the PacketStore boundary",
        { cause_code: adapterErrorCode(error) },
      );
    }
    if (!isPlainObject(session) || !Object.hasOwn(session, "handle")
        || !Object.hasOwn(session, "proof") || session.handle === null) {
      throw packetError(
        "BUSINESS_PACKET_STORE_SECURITY_UNVERIFIED",
        "Trusted platform adapter returned an invalid secure store session",
      );
    }
    let primaryError = null;
    try {
      validateSecurityProof(session.proof, normalizedRootPath);
      if (recoverTarget !== null) {
        let recovery;
        try {
          recovery = await adapter.recoverInterruptedWrites({
            store_handle: session.handle,
            target_name: recoverTarget,
            temp_prefix: `.${recoverTarget}.`,
          });
        } catch (error) {
          throw packetError(
            "BUSINESS_PACKET_STORE_RECOVERY_FAILED",
            "PacketStore interrupted-write recovery failed",
            { cause_code: adapterErrorCode(error) },
          );
        }
        validateRecoveryProof(recovery, normalizedRootPath);
      }
      return await operation(session.handle);
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      try {
        await adapter.closeStore({ store_handle: session.handle });
      } catch (error) {
        if (primaryError === null) {
          throw packetError(
            "BUSINESS_PACKET_STORE_SECURITY_UNVERIFIED",
            "Trusted platform adapter could not close the pinned store boundary",
            { cause_code: adapterErrorCode(error) },
          );
        }
      }
    }
  }

  async function readTarget(storeHandle, ref, { conflict = false } = {}) {
    let bytes;
    try {
      bytes = await adapter.readFileNoFollow({
        store_handle: storeHandle,
        name: packetFileName(ref.hash),
        max_bytes: normalizedLimits.max_packet_bytes + 1,
      });
    } catch (error) {
      if (isMissing(error)) {
        throw packetError(
          "BUSINESS_DISPATCH_PACKET_NOT_FOUND",
          "DispatchPacket content is missing",
          { packet_ref: ref.id },
        );
      }
      if (isUnsafePath(error)) {
        throw packetError(
          "BUSINESS_PACKET_STORE_PATH_UNSAFE",
          "DispatchPacket path is a link, traversal, or non-file boundary",
          { packet_ref: ref.id, cause_code: adapterErrorCode(error) },
        );
      }
      throw packetError(
        "BUSINESS_PACKET_STORE_SECURITY_UNVERIFIED",
        "DispatchPacket could not be read through the no-follow boundary",
        { packet_ref: ref.id, cause_code: adapterErrorCode(error) },
      );
    }
    return normalizeStoredPacketBytes(bytes, ref, normalizedLimits, { conflict });
  }

  async function tryReadTarget(storeHandle, ref, { conflict = false } = {}) {
    try {
      return await readTarget(storeHandle, ref, { conflict });
    } catch (error) {
      if (error?.code === "BUSINESS_DISPATCH_PACKET_NOT_FOUND") return null;
      throw error;
    }
  }

  async function removeTemp(storeHandle, tempName) {
    try {
      await adapter.unlinkTempNoFollow({ store_handle: storeHandle, name: tempName });
    } catch (error) {
      if (!isMissing(error)) {
        throw packetError(
          "BUSINESS_PACKET_STORE_RECOVERY_FAILED",
          "PacketStore could not remove its interrupted temporary file",
          { cause_code: adapterErrorCode(error) },
        );
      }
    }
  }

  async function create(input) {
    const packet = normalizeDispatchPacketV1(input, normalizedLimits);
    const hash = canonicalHash(packet);
    const ref = packetReferenceFromHash(hash);
    const targetName = packetFileName(hash);
    const bytes = Buffer.from(`${canonicalJson(packet)}\n`, "utf8");

    return withSecureStore(async (storeHandle) => {
      const existing = await tryReadTarget(storeHandle, ref, { conflict: true });
      if (existing !== null) return ref;

      const tempName = `.${targetName}.${crypto.randomBytes(24).toString("hex")}.tmp`;
      let fileHandle = null;
      let tempExists = false;
      let renamed = false;
      try {
        try {
          fileHandle = await adapter.openTempExclusive({
            store_handle: storeHandle,
            name: tempName,
            mode: 0o600,
          });
          tempExists = true;
        } catch (error) {
          throw packetError(
            "BUSINESS_PACKET_STORE_WRITE_FAILED",
            "PacketStore could not create an exclusive temporary file",
            { cause_code: adapterErrorCode(error) },
          );
        }
        try {
          await adapter.writeAll({ file_handle: fileHandle, bytes });
          await adapter.fsyncFile({ file_handle: fileHandle });
        } catch (error) {
          throw packetError(
            "BUSINESS_PACKET_STORE_WRITE_FAILED",
            "PacketStore temporary write or file fsync failed",
            { cause_code: adapterErrorCode(error) },
          );
        } finally {
          if (fileHandle !== null) {
            try {
              await adapter.closeFile({ file_handle: fileHandle });
              fileHandle = null;
            } catch (error) {
              throw packetError(
                "BUSINESS_PACKET_STORE_WRITE_FAILED",
                "PacketStore temporary file could not be closed",
                { cause_code: adapterErrorCode(error) },
              );
            }
          }
        }

        try {
          await adapter.renameTempNoReplace({
            store_handle: storeHandle,
            from_name: tempName,
            to_name: targetName,
          });
          renamed = true;
          tempExists = false;
        } catch (error) {
          if (!isExists(error)) {
            if (isUnsafePath(error)) {
              throw packetError(
                "BUSINESS_PACKET_STORE_PATH_UNSAFE",
                "PacketStore target changed into an unsafe path",
                { cause_code: adapterErrorCode(error) },
              );
            }
            throw packetError(
              "BUSINESS_PACKET_STORE_WRITE_FAILED",
              "PacketStore atomic no-replace rename failed",
              { cause_code: adapterErrorCode(error) },
            );
          }
        }

        if (!renamed) {
          await removeTemp(storeHandle, tempName);
          tempExists = false;
          const winner = await tryReadTarget(storeHandle, ref, { conflict: true });
          if (winner === null) {
            throw packetError(
              "BUSINESS_DISPATCH_PACKET_CONFLICT",
              "Concurrent PacketStore writer did not leave verifiable target content",
              { packet_ref: ref.id },
            );
          }
        }

        try {
          await adapter.fsyncDirectory({ store_handle: storeHandle });
        } catch (error) {
          throw packetError(
            "BUSINESS_PACKET_STORE_DURABILITY_UNCERTAIN",
            "PacketStore target exists but directory durability is unconfirmed",
            { packet_ref: ref.id, cause_code: adapterErrorCode(error) },
          );
        }
        await readTarget(storeHandle, ref, { conflict: true });
        return ref;
      } catch (error) {
        if (fileHandle !== null) {
          try {
            await adapter.closeFile({ file_handle: fileHandle });
          } catch {
            // The recovery adapter owns leaked-handle recovery after a primary failure.
          }
        }
        if (tempExists) {
          try {
            await removeTemp(storeHandle, tempName);
          } catch (cleanupError) {
            throw packetError(
              "BUSINESS_PACKET_STORE_RECOVERY_FAILED",
              "PacketStore write failed and its temporary file needs coordinated recovery",
              {
                cause_code: error?.code || adapterErrorCode(error),
                cleanup_code: cleanupError?.code || adapterErrorCode(cleanupError),
              },
            );
          }
        }
        throw error;
      }
    }, { recoverTarget: targetName });
  }

  async function read(inputRef) {
    const ref = normalizePacketReference(inputRef, normalizedLimits);
    return withSecureStore(
      (storeHandle) => readTarget(storeHandle, ref),
      { recoverTarget: packetFileName(ref.hash) },
    );
  }

  async function readVerifiedEffect(storeHandle, inputEffect) {
    const located = locateEffectPacket(inputEffect, normalizedLimits);
    // Content verification deliberately precedes every semantic Effect
    // check. The caller-supplied FX/DSP/IDEM fields never establish trust.
    const packet = await readTarget(storeHandle, located.ref);
    let effect;
    try {
      effect = normalizeEffectIdentityV2(located.candidate, normalizedLimits);
    } catch (error) {
      if (error?.code === "BUSINESS_DISPATCH_PACKET_EFFECT_BINDING") throw error;
      throw packetError(
        "BUSINESS_DISPATCH_PACKET_EFFECT_BINDING",
        "Effect is not one exact immutable V2 identity",
      );
    }
    const verified = verifyPacketEffectBinding(packet, located.ref, effect);
    if (!["provider.thread.create", "provider.turn.start"].includes(effect.effect_kind)) {
      const attemptPacket = await readTarget(storeHandle, verified.dispatchPacketRef);
      if (attemptPacket.branch.attempt_packet_ref !== null
          || attemptPacket.work_order.work_order_id !== packet.work_order.work_order_id
          || attemptPacket.plan.plan_snapshot_ref !== packet.plan.plan_snapshot_ref
          || attemptPacket.plan.plan_hash !== packet.plan.plan_hash
          || attemptPacket.branch.branch_ref !== packet.branch.branch_ref
          || attemptPacket.branch.next_attempt !== packet.branch.next_attempt
          || attemptPacket.provider.provider_ref !== packet.provider.provider_ref) {
        throw packetError(
          "BUSINESS_DISPATCH_PACKET_EFFECT_BINDING",
          "Follow-on packet does not bind one verified original attempt packet",
        );
      }
    }
    return { located, packet, effect, verified };
  }

  async function verifyForEffect(inputEffect) {
    const located = locateEffectPacket(inputEffect, normalizedLimits);
    return withSecureStore(async (storeHandle) => {
      const verifiedEffect = await readVerifiedEffect(storeHandle, inputEffect);
      return verificationReceipt(
        verifiedEffect.packet,
        verifiedEffect.located.ref,
        verifiedEffect.effect,
        verifiedEffect.verified,
      );
    }, { recoverTarget: packetFileName(located.ref.hash) });
  }

  async function verifyForSendAuthorization(inputEffect) {
    const located = locateEffectPacket(inputEffect, normalizedLimits);
    return withSecureStore(async (storeHandle) => {
      const verifiedEffect = await readVerifiedEffect(storeHandle, inputEffect);
      return deepFreeze({
        authorization_verification_version: 1,
        packet_verification_receipt: verificationReceipt(
          verifiedEffect.packet,
          verifiedEffect.located.ref,
          verifiedEffect.effect,
          verifiedEffect.verified,
        ),
        operation_scope_binding: verifiedEffect.verified.operationBinding,
      });
    }, { recoverTarget: packetFileName(located.ref.hash) });
  }

  return deepFreeze({ create, read, verifyForEffect, verifyForSendAuthorization });
}

module.exports = {
  BusinessPacketStoreError,
  DISPATCH_PACKET_CONTRACT_VERSION,
  DISPATCH_PACKET_STORE_LIMITS,
  DISPATCH_PACKET_VERIFICATION_RECEIPT_VERSION,
  createDispatchPacketStore,
  normalizeDispatchPacketV1,
  normalizeDispatchPacketSendAuthorizationVerificationV1,
  normalizeDispatchPacketVerificationReceiptV1,
};
