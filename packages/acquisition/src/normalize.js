"use strict";

const { assertContract, canonicalHash } = require("@orquesta/contracts");
const { createLiveSourceConnector } = require("./connector");

const MAX_BODY_BYTES = 1024 * 1024;

function sourceError(code, message, details = {}) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function parseUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw sourceError("SOURCE_URL_INVALID", "Source URL is invalid.");
  }
  if (parsed.username || parsed.password) throw sourceError("SOURCE_URL_CREDENTIALS", "Credential-bearing URLs are forbidden.");
  if (parsed.protocol !== "https:") throw sourceError("SOURCE_URL_INVALID", "Only HTTPS source URLs are allowed.");
  return parsed;
}

function canonicalSourceUri(value, allowedOrigins) {
  const parsed = parseUrl(value);
  if (!allowedOrigins.has(parsed.origin)) throw sourceError("SOURCE_REDIRECT_OUTSIDE_ALLOWLIST", "Source URL is outside the connector allowlist.");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function retryAfterMs(headers) {
  const value = headers && (headers["retry-after"] || headers["Retry-After"]);
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 0;
}

function expiresAt(fetchedAt, ttlMs) {
  const value = Date.parse(fetchedAt);
  if (!Number.isFinite(value)) throw sourceError("SOURCE_TIMESTAMP_INVALID", "Transport captured_at must be valid.");
  return new Date(value + ttlMs).toISOString();
}

function normalizeRecords({ connectorId, trustTier, response, allowedOrigins, clock, ttlMs }) {
  const fetchedAt = response.captured_at || clock();
  if (response.status === 404) {
    return assertContract("live-source-result", {
      connector_id: connectorId,
      trust_tier: trustTier,
      fetched_at: fetchedAt,
      expires_at: expiresAt(fetchedAt, ttlMs),
      status: "empty",
      candidates: [],
      source_evidence: [],
      cache_status: "miss",
      redaction_status: "redacted"
    });
  }
  if (response.status === 429) throw sourceError("SOURCE_RATE_LIMITED", "Connector is rate limited.", { retry_after_ms: retryAfterMs(response.headers) });
  if (response.status < 200 || response.status >= 300) throw sourceError("SOURCE_SERVER_ERROR", `Connector returned ${response.status}.`);
  if (response.url) canonicalSourceUri(response.url, allowedOrigins);
  const body = typeof response.body === "string" ? response.body : "";
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) throw sourceError("SOURCE_BODY_TOO_LARGE", "Connector body exceeds 1 MiB.");
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw sourceError("SOURCE_JSON_INVALID", "Connector body is not valid JSON.");
  }
  if (!payload || !Array.isArray(payload.items)) throw sourceError("SOURCE_JSON_INVALID", "Connector response must contain items.");

  const responseHash = canonicalHash(body);
  const candidates = new Map();
  const evidence = new Map();
  for (const item of payload.items) {
    if (!item || typeof item.id !== "string" || !item.id || typeof item.source_uri !== "string") continue;
    const sourceRef = canonicalSourceUri(item.source_uri, allowedOrigins);
    const candidate = { candidate_id: `${connectorId}:${item.id}`, source_ref: sourceRef, source_hash: responseHash };
    candidates.set(candidate.candidate_id, candidate);
    evidence.set(sourceRef, { source_ref: sourceRef, source_hash: responseHash });
    if (typeof item.license === "string" && item.license) {
      evidence.set(`${sourceRef}#license`, { source_ref: `${sourceRef}#license`, source_hash: responseHash });
    }
  }
  return assertContract("live-source-result", {
    connector_id: connectorId,
    trust_tier: trustTier,
    fetched_at: fetchedAt,
    expires_at: expiresAt(fetchedAt, ttlMs),
    status: candidates.size > 0 ? "success" : "empty",
    candidates: [...candidates.values()].sort((left, right) => left.candidate_id < right.candidate_id ? -1 : left.candidate_id > right.candidate_id ? 1 : 0),
    source_evidence: [...evidence.values()].sort((left, right) => left.source_ref < right.source_ref ? -1 : left.source_ref > right.source_ref ? 1 : 0),
    cache_status: "miss",
    redaction_status: "redacted"
  });
}

function createJsonConnector({ id, trustTier, baseUrl, allowedOrigins, transport, clock, ttlMs }) {
  const base = parseUrl(baseUrl);
  const origins = new Set(allowedOrigins || [base.origin]);
  if (!origins.has(base.origin)) throw sourceError("SOURCE_REDIRECT_OUTSIDE_ALLOWLIST", "Connector base URL is outside its allowlist.");
  if (typeof clock !== "function") throw new TypeError("Connector requires clock.");
  return createLiveSourceConnector({
    id,
    trustTier,
    transport,
    async search({ query, transport: injectedTransport }) {
      const requestUrl = new URL(base.toString());
      requestUrl.searchParams.set("q", query.query_terms.join(" "));
      const response = await injectedTransport.request({ method: "GET", url: requestUrl.toString(), headers: {}, body: null, timeout_ms: 5000 });
      return normalizeRecords({ connectorId: id, trustTier, response, allowedOrigins: origins, clock, ttlMs });
    }
  });
}

module.exports = { MAX_BODY_BYTES, createJsonConnector, sourceError };
