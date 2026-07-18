"use strict";

const { auditError } = require("./score");

const SOURCE_DOMAINS = Object.freeze([
  "license",
  "maintenance",
  "security",
  "compatibility",
  "accessibility",
  "cost",
  "trust",
  "freshness",
]);

const SOURCE_FIELDS = new Set([...SOURCE_DOMAINS, "runtime"]);

const STATIC_FIELD_FOR = Object.freeze({
  compatibility: "runtime",
});

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function liveError(code, message, details = {}) {
  return auditError(code, message, details);
}

function sourceField(field) {
  if (typeof field !== "string" || !SOURCE_FIELDS.has(field)) {
    throw liveError("AUDIT_LIVE_FACT_INVALID", "Live source authority names an unsupported field.", { field });
  }
  return field === "runtime" ? "compatibility" : field;
}

function assertEvidence(entry) {
  if (!isPlainObject(entry)
    || typeof entry.source_id !== "string" || !entry.source_id
    || typeof entry.source_ref !== "string" || !entry.source_ref
    || typeof entry.source_hash !== "string" || !/^[a-f0-9]{64}$/.test(entry.source_hash)
    || !["fresh", "stale"].includes(entry.freshness)
    || !Array.isArray(entry.authoritative_fields)
    || !isPlainObject(entry.facts)
    || !Array.isArray(entry.unknowns)) {
    throw liveError("AUDIT_LIVE_EVIDENCE_INVALID", "Live source evidence must have a stable source binding and explicit freshness.");
  }
  for (const field of entry.authoritative_fields) sourceField(field);
  for (const field of Object.keys(entry.facts)) sourceField(field);
  for (const unknown of entry.unknowns) {
    if (typeof unknown !== "string" || !unknown) {
      throw liveError("AUDIT_LIVE_EVIDENCE_INVALID", "Live source evidence unknowns must be stable nonempty codes.");
    }
  }
  return entry;
}

function codeForSourceField(field) {
  if (field === "cost") return "total_cost";
  if (field === "compatibility") return "runtime";
  return field;
}

function reconcileLiveEvidence({ candidate, sourceEvidence }) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)
    || typeof candidate.provider_id !== "string" || !candidate.provider_id) {
    throw liveError("AUDIT_CANDIDATE_INVALID", "Candidate requires a stable provider_id.");
  }
  if (!Array.isArray(sourceEvidence)) {
    throw liveError("AUDIT_LIVE_EVIDENCE_INVALID", "Live Audit requires a sourceEvidence array.");
  }

  if (typeof candidate.source_ref !== "string" || !candidate.source_ref
    || typeof candidate.source_hash !== "string" || !/^[a-f0-9]{64}$/.test(candidate.source_hash)) {
    throw liveError("AUDIT_LIVE_EVIDENCE_UNBOUND", "Live Audit requires the candidate source ref and hash.", { candidate_id: candidate.provider_id });
  }

  const sortedEvidence = sourceEvidence.map(assertEvidence).slice().sort((left, right) => (
    compareText(left.source_id, right.source_id)
    || compareText(left.source_ref, right.source_ref)
    || compareText(left.source_hash, right.source_hash)
  ));
  const staticMetadata = {
    ...(isPlainObject(candidate.static_metadata) ? candidate.static_metadata : {}),
  };
  const unknowns = new Set(Array.isArray(candidate.unknowns)
    ? candidate.unknowns.filter((code) => typeof code === "string" && code)
    : []);
  const provenance = [];
  const seenAuthority = new Set();
  const domainEvidence = Object.fromEntries(SOURCE_DOMAINS.map((field) => [field, "unknown"]));
  let estimatedTotalCost = Object.hasOwn(candidate, "estimated_total_cost")
    ? candidate.estimated_total_cost
    : undefined;

  for (const evidence of sortedEvidence) {
    if (evidence.source_ref !== candidate.source_ref || evidence.source_hash !== candidate.source_hash) {
      throw liveError("AUDIT_LIVE_EVIDENCE_UNBOUND", "Live Audit evidence must exactly bind the candidate source ref and hash.", {
        candidate_id: candidate.provider_id,
        source_ref: evidence.source_ref,
        source_hash: evidence.source_hash,
      });
    }
    if (evidence.freshness !== "fresh") {
      unknowns.add("freshness");
      continue;
    }

    for (const rawUnknown of evidence.unknowns) {
      const field = rawUnknown === "total_cost" ? "cost" : sourceField(rawUnknown);
      if (domainEvidence[field] !== "fact") domainEvidence[field] = "unknown";
      unknowns.add(codeForSourceField(field));
    }
    const explicitUnknowns = new Set(evidence.unknowns.map((rawUnknown) => (
      rawUnknown === "total_cost" ? "cost" : sourceField(rawUnknown)
    )));
    for (const rawField of evidence.authoritative_fields) {
      const field = sourceField(rawField);
      const factKey = Object.hasOwn(evidence.facts, rawField) ? rawField : field;
      if (!Object.hasOwn(evidence.facts, factKey)) continue;
      if (seenAuthority.has(field)) {
        throw liveError(
          "AUDIT_LIVE_FACT_CONFLICT",
          "Live source evidence provides duplicate authority for a field.",
          { candidate_id: candidate.provider_id, fields: [field] },
        );
      }
      seenAuthority.add(field);
      domainEvidence[field] = explicitUnknowns.has(field) ? "unknown" : "fact";
      const value = evidence.facts[factKey];
      if (field === "cost") {
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
          throw liveError("AUDIT_LIVE_FACT_INVALID", "Live source cost must be a finite nonnegative number.", { field });
        }
        estimatedTotalCost = value;
        unknowns.delete("total_cost");
      } else if (field !== "freshness") {
        staticMetadata[STATIC_FIELD_FOR[field] || field] = value;
      }
      if (!explicitUnknowns.has(field)) unknowns.delete(codeForSourceField(field));
      provenance.push({
        field,
        source_id: evidence.source_id,
        source_ref: evidence.source_ref,
        source_hash: evidence.source_hash,
      });
    }
  }

  for (const field of SOURCE_DOMAINS) {
    if (domainEvidence[field] !== "fact") unknowns.add(codeForSourceField(field));
  }
  const reconciledCandidate = {
    ...candidate,
    static_metadata: staticMetadata,
    unknowns: [...unknowns].sort(compareText),
  };
  if (estimatedTotalCost !== undefined) reconciledCandidate.estimated_total_cost = estimatedTotalCost;
  return {
    candidate: reconciledCandidate,
    fact_provenance: provenance.sort((left, right) => compareText(left.field, right.field)),
    domain_evidence: domainEvidence,
  };
}

module.exports = { reconcileLiveEvidence };
