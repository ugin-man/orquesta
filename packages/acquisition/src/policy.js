"use strict";

const ACQUISITION_LIMITS = Object.freeze({
  max_requests_per_need: 8,
  max_requests_per_connector: 2,
  max_candidates: 3
});

function compareCodeUnit(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sortedUniqueConnectors(connectors, allowedIds) {
  const byId = new Map();
  for (const connector of connectors || []) {
    if (!connector || typeof connector.id !== "string" || !allowedIds.has(connector.id)) continue;
    if (!byId.has(connector.id)) byId.set(connector.id, connector);
  }
  return [...byId.values()].sort((left, right) => compareCodeUnit(left.id, right.id));
}

module.exports = { ACQUISITION_LIMITS, compareCodeUnit, sortedUniqueConnectors };
