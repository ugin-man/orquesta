"use strict";

const { deriveLifecycleSnapshot } = require("./lifecycle");

const BUSINESS_DESKTOP_READ_SCHEMA_VERSION = 1;
const BUSINESS_DESKTOP_READ_CONSUMER = "orquesta.business-work-orders.read";
const BUSINESS_DESKTOP_READ_FEATURES = Object.freeze([
  "authoritative-lifecycle-mode.v1",
  "journal-prefix-continuity.v1",
  "provider-delivery-separate-from-acceptance.v1",
  "root-journal-all-business-project-refs.v1",
  "work-order-index.v1",
]);
const BUSINESS_DESKTOP_READ_LIMITS = Object.freeze({
  maxResultBytes: 1_048_576,
  indexPageSize: 25,
  branchPageSize: 64,
  recordPageSize: 16,
});

class BusinessDesktopReadError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "BusinessDesktopReadError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new BusinessDesktopReadError(code, message, details);
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("BUSINESS_DESKTOP_READ_INVALID", `${label} must be an object`);
  }
  return value;
}

function text(value, label, maximum = 512) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    fail("BUSINESS_DESKTOP_READ_INVALID", `${label} must be a bounded string`);
  }
  return value;
}

function negotiateConsumer(value) {
  const consumer = object(value, "consumer");
  if (consumer.name !== BUSINESS_DESKTOP_READ_CONSUMER
      || consumer.major !== 1
      || !Number.isSafeInteger(consumer.minMinor)
      || consumer.minMinor < 0
      || !Array.isArray(consumer.requiredFeatures)) {
    fail("BUSINESS_DESKTOP_CAPABILITY_MISMATCH", "The Desktop consumer contract is not supported");
  }
  const missing = consumer.requiredFeatures.filter(
    (feature) => !BUSINESS_DESKTOP_READ_FEATURES.includes(feature),
  );
  if (missing.length !== 0) {
    fail("BUSINESS_DESKTOP_CAPABILITY_MISMATCH", "Required Desktop features are unavailable", { missing });
  }
}

function capability() {
  return {
    name: BUSINESS_DESKTOP_READ_CONSUMER,
    major: 1,
    minor: 0,
    features: [...BUSINESS_DESKTOP_READ_FEATURES],
    businessProjectionVersion: 2,
    journalVersion: 1,
    supportedEngineContracts: [1, 2],
    limits: { ...BUSINESS_DESKTOP_READ_LIMITS },
  };
}

function countBy(items, field) {
  const output = {};
  for (const item of items) {
    const value = typeof item?.[field] === "string" ? item[field] : "unknown";
    output[value] = (output[value] || 0) + 1;
  }
  return output;
}

function lifecycleSummary(projection, workOrder) {
  try {
    const snapshot = deriveLifecycleSnapshot({
      workOrder,
      outbox: projection.outbox,
      attention: workOrder.attention,
    });
    const branches = Object.values(snapshot.branches || {});
    return {
      mode: snapshot.mode,
      automationState: snapshot.automation?.state || "unknown",
      blockingEffectCount: branches.reduce(
        (count, branch) => count + (Array.isArray(branch.blocking_effect_ids)
          ? branch.blocking_effect_ids.length
          : 0),
        0,
      ),
      violationCount: Array.isArray(snapshot.violations) ? snapshot.violations.length : 0,
    };
  } catch (error) {
    return {
      mode: "invalid",
      automationState: "paused",
      blockingEffectCount: 0,
      violationCount: Array.isArray(error?.details?.violations)
        ? error.details.violations.length
        : 1,
    };
  }
}

function deliverySummary(projection, workOrder) {
  const effects = Object.values(projection.outbox).filter(
    (effect) => effect?.work_order_id === workOrder.work_order_id,
  );
  const byStatus = countBy(effects, "status");
  return {
    total: effects.length,
    accepted: (byStatus.delivered || 0),
    notSent: (byStatus.not_sent || 0),
    deliveryUnknown: (byStatus.delivery_unknown || 0),
    unresolved: effects.filter((effect) => [
      "pending", "claimed", "sending", "delivery_unknown",
    ].includes(effect?.status)).length,
  };
}

function acceptanceSummary(workOrder) {
  return {
    decision: workOrder.acceptance?.decision?.decision || null,
    reviewCount: Object.keys(workOrder.acceptance?.reviews || {}).length,
  };
}

function indexItem(projection, workOrder) {
  const branches = Object.values(workOrder.branches || {});
  return {
    key: workOrder.work_order_id,
    workOrderId: workOrder.work_order_id,
    projectRef: workOrder.plan?.project_ref || null,
    title: workOrder.plan?.title || workOrder.work_order_id,
    status: workOrder.status,
    revision: workOrder.revision,
    engineContractVersion: workOrder.engine_contract_version || 1,
    createdAt: workOrder.created_at,
    deadlineAt: workOrder.deadline_at,
    branchCounts: {
      total: branches.length,
      byState: countBy(branches, "state"),
    },
    lifecycle: lifecycleSummary(projection, workOrder),
    providerDelivery: deliverySummary(projection, workOrder),
    acceptance: acceptanceSummary(workOrder),
  };
}

function indexPage(projection, query) {
  const limit = query.limit === undefined ? BUSINESS_DESKTOP_READ_LIMITS.indexPageSize : query.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > BUSINESS_DESKTOP_READ_LIMITS.indexPageSize) {
    fail("BUSINESS_DESKTOP_READ_INVALID", "index.limit is outside the supported page size");
  }
  const afterKey = query.afterKey === null || query.afterKey === undefined
    ? null
    : text(query.afterKey, "index.afterKey");
  const items = Object.values(projection.work_orders)
    .map((workOrder) => indexItem(projection, workOrder))
    .sort((left, right) => left.key.localeCompare(right.key));
  const start = afterKey === null ? 0 : items.findIndex((item) => item.key > afterKey);
  const selected = start === -1 ? [] : items.slice(start, start + limit);
  const finalKey = selected.at(-1)?.key || null;
  const hasMore = finalKey !== null && items.some((item) => item.key > finalKey);
  return {
    kind: "index",
    items: selected,
    nextAfterKey: hasMore ? finalKey : null,
  };
}

const PAGE_BUILDERS = Object.freeze({ index: indexPage });

function projectScope(projection) {
  const projectRefs = [...new Set(Object.values(projection.work_orders)
    .map((workOrder) => workOrder.plan?.project_ref)
    .filter((value) => typeof value === "string"))].sort();
  return {
    mode: projectRefs.length === 0 ? "none" : projectRefs.length === 1 ? "single" : "multiple",
    projectRefs,
  };
}

function createBusinessDesktopReadResultV1(input) {
  const request = object(input?.request, "request");
  const projection = object(input?.projection, "projection");
  const cursor = object(input?.cursor, "cursor");
  const runtimeProjectId = text(input?.runtimeProjectId, "runtimeProjectId");
  const continuity = text(input?.continuity, "continuity", 32);
  if (!["initial", "unchanged", "advanced"].includes(continuity)) {
    fail(
      "BUSINESS_DESKTOP_SOURCE_RECOVERY_REQUIRED",
      "The Business journal no longer continues the retained Desktop cursor",
      { reason: continuity },
    );
  }
  if (request.projectId !== runtimeProjectId) {
    fail("BUSINESS_DESKTOP_PROJECT_MISMATCH", "The request does not match the active runtime project");
  }
  negotiateConsumer(request.consumer);
  const query = object(request.query, "query");
  const kind = text(query.kind, "query.kind", 64);
  const builder = Object.hasOwn(PAGE_BUILDERS, kind) ? PAGE_BUILDERS[kind] : null;
  if (typeof builder !== "function") {
    fail("BUSINESS_DESKTOP_READ_QUERY_UNSUPPORTED", `Unsupported Business read query: ${kind}`);
  }
  const result = {
    schemaVersion: BUSINESS_DESKTOP_READ_SCHEMA_VERSION,
    runtimeProjectId,
    capability: capability(),
    continuity,
    cursor: { ...cursor },
    businessProjectScope: projectScope(projection),
    providerSettlement: {
      active: projection.provider_settlement_epoch !== null,
      cutoverId: projection.provider_settlement_epoch?.cutover_id || null,
    },
    page: builder(projection, query),
  };
  const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
  if (bytes >= BUSINESS_DESKTOP_READ_LIMITS.maxResultBytes) {
    fail("BUSINESS_DESKTOP_RESULT_TOO_LARGE", "The bounded Desktop result exceeds its transport budget", { bytes });
  }
  return result;
}

module.exports = {
  BUSINESS_DESKTOP_READ_CONSUMER,
  BUSINESS_DESKTOP_READ_FEATURES,
  BUSINESS_DESKTOP_READ_LIMITS,
  BUSINESS_DESKTOP_READ_SCHEMA_VERSION,
  BusinessDesktopReadError,
  createBusinessDesktopReadResultV1,
};
