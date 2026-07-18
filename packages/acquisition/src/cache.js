"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { canonicalHash } = require("@orquesta/contracts");

let tempSequence = 0;

function validTimestamp(value) {
  if (typeof value !== "string") return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function safeRedactedHeaders(headers) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return {};
  return Object.fromEntries(Object.entries(headers)
    .filter(([key]) => !/authorization|cookie|secret|token/i.test(key))
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => [key, String(value)]));
}

function createAcquisitionCache({ cacheRoot, clock } = {}) {
  if (typeof cacheRoot !== "string" || !cacheRoot) throw new TypeError("Acquisition cache requires cacheRoot.");
  if (typeof clock !== "function") throw new TypeError("Acquisition cache requires clock.");

  function entryPath(query) {
    return path.join(cacheRoot, `${canonicalHash(query)}.json`);
  }

  function read({ query, sourceIdentity } = {}) {
    const filePath = entryPath(query);
    if (!fs.existsSync(filePath)) return { status: "miss" };
    let entry;
    try {
      entry = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      return { status: "invalid" };
    }
    if (!entry || typeof entry !== "object"
      || entry.query_hash !== canonicalHash(query)
      || entry.source_identity !== sourceIdentity
      || !validTimestamp(entry.fetched_at)
      || !validTimestamp(entry.expires_at)
      || entry.payload_hash !== canonicalHash(entry.value)) {
      return { status: "invalid" };
    }
    if (Date.parse(clock()) >= Date.parse(entry.expires_at)) return { status: "stale", entry };
    return { status: "hit", value: entry.value, entry };
  }

  function write({ query, sourceIdentity, fetchedAt, expiresAt, value, redactedHeaders } = {}) {
    if (typeof sourceIdentity !== "string" || !sourceIdentity) throw new TypeError("Cache source identity is required.");
    if (!validTimestamp(fetchedAt) || !validTimestamp(expiresAt) || Date.parse(expiresAt) <= Date.parse(fetchedAt)) {
      throw new TypeError("Cache timestamps must be ordered UTC timestamps.");
    }
    const queryHash = canonicalHash(query);
    const entry = {
      query_hash: queryHash,
      source_identity: sourceIdentity,
      fetched_at: fetchedAt,
      expires_at: expiresAt,
      payload_hash: canonicalHash(value),
      value,
      redacted_headers: safeRedactedHeaders(redactedHeaders)
    };
    fs.mkdirSync(cacheRoot, { recursive: true });
    const target = path.join(cacheRoot, `${queryHash}.json`);
    const temp = path.join(cacheRoot, `.${queryHash}.${process.pid}.${++tempSequence}.tmp`);
    fs.writeFileSync(temp, `${JSON.stringify(entry)}\n`, "utf8");
    fs.renameSync(temp, target);
    return entry;
  }

  return Object.freeze({ read, write });
}

module.exports = { createAcquisitionCache };
