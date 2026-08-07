"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { assertContract } = require("@orquesta/contracts");
const { createContextReceiptV2 } = require("./v2");

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function nonempty(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${field} must be a non-empty string`);
  return value.trim();
}

function boundedInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isInteger(value) && value >= 0 ? Math.min(value, maximum) : fallback;
}

function words(value) {
  return [...new Set(String(value || "").toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(Boolean))];
}

function safeWorkspaceFile(workspaceRoot, sourceRef) {
  if (!workspaceRoot || sourceRef.includes(":")) return null;
  const root = fs.realpathSync(workspaceRoot);
  const candidate = path.resolve(root, ...sourceRef.split("/"));
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`source_outside_workspace:${sourceRef}`);
  }
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) return null;
  const real = fs.realpathSync(candidate);
  const realRelative = path.relative(root, real);
  if (realRelative === ".." || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
    throw new Error(`source_symlink_outside_workspace:${sourceRef}`);
  }
  return real;
}

function createContextBrokerV2({
  workspaceRoot = null,
  contextPack,
  contextRequirement,
  sourceCatalog,
  inlineSources = {},
  session = {},
} = {}) {
  const pack = clone(assertContract("context-pack-v2", contextPack));
  const requirement = clone(assertContract("context-requirement", contextRequirement));
  if (pack.requirement_id !== requirement.requirement_id
    || pack.task_intent_id !== requirement.task_intent_id
    || pack.task_envelope_id !== requirement.task_envelope_id) {
    throw new TypeError("Context Broker inputs must bind the same requirement, task, and envelope.");
  }
  const catalog = (Array.isArray(sourceCatalog) ? sourceCatalog : [])
    .map((record) => clone(assertContract("source-record", record)));
  const byId = new Map(catalog.map((record) => [record.source_id, record]));
  const byRef = new Map(catalog.map((record) => [record.source_ref, record]));
  const selected = new Set(pack.selected_sources);
  const initialSelected = new Set(pack.selected_sources);
  const used = new Set();
  const missingContext = new Set();
  const expansions = [];
  const readEvents = [];
  let expansionTokens = 0;
  for (const sourceId of Array.isArray(session.expanded_source_ids) ? session.expanded_source_ids : []) {
    const record = byId.get(sourceId);
    if (!record || selected.has(record.source_id)) continue;
    if (record.status !== "current"
      || expansionTokens + record.token_estimate > pack.retrieval_permissions.max_expansion_tokens) continue;
    selected.add(record.source_id);
    expansionTokens += record.token_estimate;
    expansions.push({
      source_id: record.source_id,
      source_ref: record.source_ref,
      token_estimate: record.token_estimate,
      already_selected: false,
    });
  }
  for (const sourceId of Array.isArray(session.used_source_ids) ? session.used_source_ids : []) {
    if (selected.has(sourceId)) used.add(sourceId);
  }
  for (const description of Array.isArray(session.missing_context) ? session.missing_context : []) {
    if (typeof description === "string" && description.trim()) missingContext.add(description.trim());
  }
  for (const event of Array.isArray(session.read_events) ? session.read_events : []) {
    if (!event || typeof event !== "object" || typeof event.source_id !== "string") continue;
    readEvents.push({
      source_id: event.source_id,
      source_ref: String(event.source_ref || ""),
      bytes: boundedInteger(event.bytes, 0),
      tokens: boundedInteger(event.tokens, 0),
      truncated: event.truncated === true,
    });
  }

  function recordFor(source) {
    const key = nonempty(source, "source");
    const record = byId.get(key) || byRef.get(key);
    if (!record) throw new Error(`source_not_cataloged:${key}`);
    return record;
  }

  function provenanceFor(record) {
    return pack.provenance.find((entry) => entry.source_ref === record.source_ref)?.reason
      || (selected.has(record.source_id) ? "selected" : "not_selected");
  }

  function sourceBytes(record) {
    let content = inlineSources[record.source_ref];
    if (content === undefined) content = inlineSources[record.source_id];
    if (content === undefined) {
      const file = safeWorkspaceFile(workspaceRoot, record.source_ref);
      if (file) content = fs.readFileSync(file);
    }
    if (content === undefined) return null;
    return Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");
  }

  function sourceIndex() {
    return [...selected]
      .map((sourceId) => byId.get(sourceId))
      .filter(Boolean)
      .map((record) => ({
        source_id: record.source_id,
        source_ref: record.source_ref,
        source_type: record.source_type,
        authority: record.authority,
        freshness: record.freshness,
        summary: record.summary,
        token_estimate: record.token_estimate,
        supports_criteria: [...record.supports_criteria],
        initial: initialSelected.has(record.source_id),
        expanded: !initialSelected.has(record.source_id),
        used: used.has(record.source_id),
        provenance_reason: provenanceFor(record),
      }))
      .sort((left, right) => left.source_ref.localeCompare(right.source_ref));
  }

  function search(query, {
    limit = 10,
    knowledgeDomains = [],
    artifactTypes = [],
  } = {}) {
    if (!pack.retrieval_permissions.search) throw new Error("context_search_not_permitted");
    const terms = words(nonempty(query, "query"));
    const domainSet = new Set(knowledgeDomains);
    const artifactSet = new Set(artifactTypes);
    return catalog
      .filter((record) => record.status !== "missing" && record.status !== "superseded")
      .map((record) => {
        const haystack = words([
          record.source_ref,
          record.summary || "",
          ...record.knowledge_domains,
          ...record.artifact_types,
          ...record.supports_criteria,
        ].join(" "));
        const wordSet = new Set(haystack);
        const matches = terms.filter((term) => wordSet.has(term)).length;
        const domainMatches = record.knowledge_domains.filter((item) => domainSet.has(item)).length;
        const artifactMatches = record.artifact_types.filter((item) => artifactSet.has(item)).length;
        return {
          source_id: record.source_id,
          source_ref: record.source_ref,
          selected: selected.has(record.source_id),
          status: record.status,
          token_estimate: record.token_estimate,
          score: matches * 100 + domainMatches * 25 + artifactMatches * 20,
        };
      })
      .filter((result) => result.score > 0)
      .sort((left, right) => right.score - left.score || left.source_ref.localeCompare(right.source_ref))
      .slice(0, boundedInteger(limit, 10, 50));
  }

  function expand(sources) {
    if (!pack.retrieval_permissions.expand) throw new Error("context_expansion_not_permitted");
    const requested = [...new Set((Array.isArray(sources) ? sources : [sources]).map((source) => nonempty(source, "source")))];
    const added = [];
    const rejected = [];
    for (const source of requested) {
      const record = recordFor(source);
      if (selected.has(record.source_id)) {
        added.push({ source_id: record.source_id, source_ref: record.source_ref, token_estimate: 0, already_selected: true });
        continue;
      }
      const omission = pack.omitted_context.find((entry) => entry.source_id === record.source_id);
      if (["excluded", "superseded", "stale", "duplicate"].includes(omission?.reason) || record.status !== "current") {
        rejected.push({ source_id: record.source_id, source_ref: record.source_ref, reason: omission?.reason || record.status });
        continue;
      }
      if (expansionTokens + record.token_estimate > pack.retrieval_permissions.max_expansion_tokens) {
        rejected.push({ source_id: record.source_id, source_ref: record.source_ref, reason: "expansion_budget" });
        continue;
      }
      selected.add(record.source_id);
      expansionTokens += record.token_estimate;
      const addition = {
        source_id: record.source_id,
        source_ref: record.source_ref,
        token_estimate: record.token_estimate,
        already_selected: false,
      };
      expansions.push(addition);
      added.push(addition);
    }
    return {
      added,
      rejected,
      expansion_tokens: expansionTokens,
      remaining_expansion_tokens: Math.max(0, pack.retrieval_permissions.max_expansion_tokens - expansionTokens),
    };
  }

  function open(source, { maxTokens = null } = {}) {
    if (!pack.retrieval_permissions.open) throw new Error("context_open_not_permitted");
    const record = recordFor(source);
    if (!selected.has(record.source_id)) throw new Error(`source_not_selected:${record.source_ref}`);
    const tokenLimit = Math.max(1, boundedInteger(maxTokens, record.token_estimate || 1, record.token_estimate || 1));
    const byteLimit = tokenLimit * 4;
    const bytes = sourceBytes(record);
    if (!bytes) {
      missingContext.add(record.source_ref);
      return {
        source_id: record.source_id,
        source_ref: record.source_ref,
        content: null,
        truncated: false,
        token_estimate: 0,
        status: "unavailable",
      };
    }
    const sliced = bytes.subarray(0, byteLimit);
    used.add(record.source_id);
    const readEvent = {
      source_id: record.source_id,
      source_ref: record.source_ref,
      bytes: sliced.byteLength,
      tokens: Math.max(1, Math.ceil(sliced.byteLength / 4)),
      truncated: sliced.byteLength < bytes.byteLength,
    };
    readEvents.push(readEvent);
    return {
      source_id: record.source_id,
      source_ref: record.source_ref,
      content: sliced.toString("utf8"),
      truncated: readEvent.truncated,
      byte_count: readEvent.bytes,
      token_estimate: readEvent.tokens,
      status: "opened",
    };
  }

  function explain(source) {
    if (!pack.retrieval_permissions.explain) throw new Error("context_explain_not_permitted");
    const record = recordFor(source);
    const provenance = pack.provenance.find((entry) => entry.source_ref === record.source_ref);
    const omission = pack.omitted_context.find((entry) => entry.source_id === record.source_id);
    return {
      source_id: record.source_id,
      source_ref: record.source_ref,
      selected: selected.has(record.source_id),
      initially_selected: initialSelected.has(record.source_id),
      reason: selected.has(record.source_id) && !initialSelected.has(record.source_id)
        ? "bounded_expansion"
        : provenance?.reason || omission?.reason || (selected.has(record.source_id) ? "selected" : "not_selected"),
      authority: record.authority,
      freshness: record.freshness,
      supports_criteria: [...record.supports_criteria],
    };
  }

  function reportMissingContext(description) {
    missingContext.add(nonempty(description, "description"));
  }

  function rehydrate() {
    const index = sourceIndex();
    const opened = [];
    const deferred = [];
    const staleSourceIds = [];
    for (const entry of index) {
      const record = byId.get(entry.source_id);
      const taskAnchor = record.source_type === "task_record" && record.authority === "canonical";
      const acceptedAnchor = ["accepted_decision", "user_directive"].includes(record.source_type)
        && record.authority === "accepted";
      const covered = ["must_include", "acceptance_coverage"].includes(entry.provenance_reason);
      if (!taskAnchor && !acceptedAnchor && !covered) {
        deferred.push(entry);
        continue;
      }
      const bytes = sourceBytes(record);
      const actualHash = bytes && crypto.createHash("sha256").update(bytes).digest("hex");
      if (!bytes || actualHash !== record.source_hash) {
        staleSourceIds.push(record.source_id);
        continue;
      }
      opened.push(open(record.source_id));
    }
    const status = staleSourceIds.length ? "needs_refresh" : "rehydrated";
    return {
      strategy: "post_compaction_progressive_rehydration",
      status,
      index,
      opened,
      deferred,
      stale_source_ids: staleSourceIds.sort(),
      opened_tokens: opened.reduce((total, entry) => total + (entry.token_estimate || 0), 0),
      next_action: staleSourceIds.length ? "refresh_source_index" : deferred.length ? "open_deferred_from_index" : "continue_task",
    };
  }

  function snapshot() {
    return {
      context_pack_id: pack.context_pack_id,
      requirement_id: requirement.requirement_id,
      initially_selected_source_ids: [...initialSelected].sort(),
      currently_selected_source_ids: [...selected].sort(),
      used_source_ids: [...used].sort(),
      expansion_tokens: expansionTokens,
      remaining_expansion_tokens: Math.max(0, pack.retrieval_permissions.max_expansion_tokens - expansionTokens),
      expansions: clone(expansions),
      missing_context: [...missingContext].sort(),
      read_events: clone(readEvents),
      opened_bytes: readEvents.reduce((total, event) => total + event.bytes, 0),
      opened_tokens: readEvents.reduce((total, event) => total + event.tokens, 0),
    };
  }

  function finalize({
    userCorrections = 0,
    incorrectProjectFacts = 0,
    compactionCount = 0,
    acceptanceResults = [],
    createdAt,
  } = {}) {
    return createContextReceiptV2({
      contextPack: pack,
      agentId: pack.owner_agent_id,
      usedSourceIds: [...used],
      additionalTokens: expansionTokens,
      missingContext: [...missingContext],
      readEvents,
      userCorrections,
      incorrectProjectFacts,
      compactionCount,
      acceptanceResults,
      createdAt,
    });
  }

  return Object.freeze({
    explain,
    expand,
    finalize,
    open,
    reportMissingContext,
    rehydrate,
    search,
    sourceIndex,
    snapshot,
  });
}

module.exports = { createContextBrokerV2 };
