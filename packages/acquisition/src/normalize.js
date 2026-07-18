"use strict";

const { assertContract, canonicalHash } = require("@orquesta/contracts");
const { createLiveSourceConnector } = require("./connector");

const MAX_BODY_BYTES = 1024 * 1024;
const SOURCE_DOMAINS = Object.freeze(["license", "maintenance", "security", "compatibility", "accessibility", "cost", "trust", "freshness"]);

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

function itemFacts(item, trustTier) {
  const facts = { trust: trustTier, freshness: "fresh" };
  for (const field of ["license", "maintenance", "security", "compatibility", "accessibility", "cost"]) {
    if (Object.hasOwn(item, field)) facts[field] = item[field];
  }
  if (!Object.hasOwn(facts, "compatibility") && Object.hasOwn(item, "runtime")) facts.compatibility = item.runtime;
  return facts;
}

function normalizeRecords({ connectorId, trustTier, trustTierForItem, response, allowedOrigins, clock, ttlMs }) {
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
    const candidateId = `${connectorId}:${item.id}`;
    const recordTrustTier = trustTierForItem ? trustTierForItem(item, sourceRef) : trustTier;
    const facts = itemFacts(item, recordTrustTier);
    const authoritativeFields = Object.keys(facts).sort();
    const unknowns = SOURCE_DOMAINS.filter((field) => !Object.hasOwn(facts, field)).sort();
    const candidate = {
      candidate_id: candidateId,
      source_ref: sourceRef,
      source_hash: responseHash,
      version: typeof item.version === "string" && item.version ? item.version : null,
      revision: typeof item.revision === "string" && item.revision ? item.revision : null,
      trust_tier: recordTrustTier,
      freshness: "fresh",
    };
    candidates.set(candidate.candidate_id, candidate);
    evidence.set(candidateId, {
      source_id: `source:${connectorId}:${item.id}`,
      candidate_id: candidateId,
      source_ref: sourceRef,
      source_hash: responseHash,
      freshness: "fresh",
      authoritative_fields: authoritativeFields,
      facts,
      unknowns,
    });
  }
  return assertContract("live-source-result", {
    connector_id: connectorId,
    trust_tier: trustTier,
    fetched_at: fetchedAt,
    expires_at: expiresAt(fetchedAt, ttlMs),
    status: candidates.size > 0 ? "success" : "empty",
    candidates: [...candidates.values()].sort((left, right) => left.candidate_id < right.candidate_id ? -1 : left.candidate_id > right.candidate_id ? 1 : 0),
    source_evidence: [...evidence.values()].sort((left, right) => left.candidate_id < right.candidate_id ? -1 : left.candidate_id > right.candidate_id ? 1 : 0),
    cache_status: "miss",
    redaction_status: "redacted"
  });
}

function createJsonConnector({ id, trustTier, trustTierForItem, baseUrl, allowedOrigins, transport, clock, ttlMs, cacheConfig }) {
  const base = parseUrl(baseUrl);
  const origins = new Set(allowedOrigins || [base.origin]);
  if (!origins.has(base.origin)) throw sourceError("SOURCE_REDIRECT_OUTSIDE_ALLOWLIST", "Connector base URL is outside its allowlist.");
  if (typeof clock !== "function") throw new TypeError("Connector requires clock.");
  return createLiveSourceConnector({
    id,
    trustTier,
    transport,
    cacheConfig: cacheConfig || { source_uri: base.toString(), trust_policy: trustTier, parser_version: "json-v1" },
    async search({ query, transport: injectedTransport }) {
      const requestUrl = new URL(base.toString());
      requestUrl.searchParams.set("q", query.query_terms.join(" "));
      const response = await injectedTransport.request({ method: "GET", url: requestUrl.toString(), headers: {}, body: null, timeout_ms: 5000 });
      return normalizeRecords({ connectorId: id, trustTier, trustTierForItem, response, allowedOrigins: origins, clock, ttlMs });
    }
  });
}

function toAuditLiveCandidateInput({ sourceResult, candidate } = {}) {
  const validResult = assertContract("live-source-result", sourceResult);
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) || typeof candidate.provider_id !== "string") {
    throw sourceError("ACQUISITION_AUDIT_BINDING_INVALID", "Audit conversion requires a candidate provider ID.");
  }
  const record = validResult.candidates.find((entry) => entry.candidate_id === candidate.provider_id);
  const evidence = validResult.source_evidence.find((entry) => entry.candidate_id === candidate.provider_id);
  if (!record || !evidence || candidate.source_ref !== record.source_ref || candidate.source_hash !== record.source_hash) {
    throw sourceError("ACQUISITION_AUDIT_BINDING_INVALID", "Audit conversion requires an exact discovered source ref and hash.", { candidate_id: candidate.provider_id });
  }
  return Object.freeze({ candidate: { ...candidate }, sourceEvidence: [{ ...evidence }] });
}

module.exports = { MAX_BODY_BYTES, createJsonConnector, sourceError, toAuditLiveCandidateInput };
