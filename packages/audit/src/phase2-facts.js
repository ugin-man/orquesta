"use strict";

const { auditError } = require("./score");

const SOURCE_FIELDS = new Set([
  "license",
  "maintenance",
  "security",
  "runtime",
  "compatibility",
  "accessibility",
  "cost",
  "trust",
  "freshness",
]);

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
  return field;
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
  return field === "cost" ? "total_cost" : field;
}

function reconcileLiveEvidence({ candidate, sourceEvidence }) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)
    || typeof candidate.provider_id !== "string" || !candidate.provider_id) {
    throw liveError("AUDIT_CANDIDATE_INVALID", "Candidate requires a stable provider_id.");
  }
  if (!Array.isArray(sourceEvidence)) {
    throw liveError("AUDIT_LIVE_EVIDENCE_INVALID", "Live Audit requires a sourceEvidence array.");
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
  let estimatedTotalCost = Object.hasOwn(candidate, "estimated_total_cost")
    ? candidate.estimated_total_cost
    : undefined;

  for (const evidence of sortedEvidence) {
    if (evidence.freshness !== "fresh") {
      unknowns.add("freshness");
      continue;
    }

    for (const unknown of evidence.unknowns) unknowns.add(unknown);
    for (const rawField of evidence.authoritative_fields) {
      const field = sourceField(rawField);
      if (!Object.hasOwn(evidence.facts, field)) continue;
      if (seenAuthority.has(field)) {
        throw liveError(
          "AUDIT_LIVE_FACT_CONFLICT",
          "Live source evidence provides duplicate authority for a field.",
          { candidate_id: candidate.provider_id, fields: [field] },
        );
      }
      seenAuthority.add(field);
      const value = evidence.facts[field];
      if (field === "cost") {
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
          throw liveError("AUDIT_LIVE_FACT_INVALID", "Live source cost must be a finite nonnegative number.", { field });
        }
        estimatedTotalCost = value;
        unknowns.delete("total_cost");
      } else if (field !== "freshness") {
        staticMetadata[STATIC_FIELD_FOR[field] || field] = value;
      }
      provenance.push({
        field,
        source_id: evidence.source_id,
        source_ref: evidence.source_ref,
        source_hash: evidence.source_hash,
      });
    }
  }

  if (!Object.hasOwn(staticMetadata, "maintenance")) unknowns.add("maintenance");
  if (estimatedTotalCost === undefined) unknowns.add("total_cost");
  const reconciledCandidate = {
    ...candidate,
    static_metadata: staticMetadata,
    unknowns: [...unknowns].sort(compareText),
  };
  if (estimatedTotalCost !== undefined) reconciledCandidate.estimated_total_cost = estimatedTotalCost;
  return {
    candidate: reconciledCandidate,
    fact_provenance: provenance.sort((left, right) => compareText(left.field, right.field)),
  };
}

module.exports = { reconcileLiveEvidence };
