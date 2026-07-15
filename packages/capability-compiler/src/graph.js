"use strict";

const { assertContract, canonicalHash } = require("@orquesta/contracts");
const { compareText, normalizeText } = require("./normalize");
const { compilerError } = require("./rule-source");

function needKey({ kind, description, verification_method }) {
  return canonicalHash({ kind, description: normalizeText(description), verification_method: normalizeText(verification_method) });
}

function needId(candidate) {
  return `CN-${needKey(candidate).slice(0, 12)}`;
}

function detectCycles(needs) {
  const byId = new Map(needs.map((need) => [need.need_id, need]));
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) throw compilerError("CAPABILITY_GRAPH_CYCLE", "Capability graph contains a dependency cycle", { need_id: id });
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id).dependencies) {
      if (!byId.has(dependency)) throw compilerError("CAPABILITY_GRAPH_UNKNOWN_DEPENDENCY", "Capability graph dependency does not exist", { need_id: id, dependency });
      visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  };
  needs.forEach((need) => visit(need.need_id));
}

function buildGraph({ taskIntent, matches }) {
  const candidates = [];
  for (const { rule, matched_fields: matchedFields } of matches) {
    rule.emits.forEach((emit, index) => {
      candidates.push({
        candidate_id: `${rule.rule_id}:${index}`,
        rule_id: rule.rule_id,
        matched_fields: matchedFields,
        emit_index: index,
        kind: emit.kind,
        description: emit.description,
        verification_method: emit.verification_method,
        dependencies: emit.depends_on_emit.map((dependency) => `${rule.rule_id}:${dependency}`),
      });
    });
  }
  if (candidates.length === 0) {
    candidates.push({
      candidate_id: "unmatched:0",
      rule_id: null,
      matched_fields: [],
      emit_index: 0,
      kind: "human_judgment",
      description: `未解決の成果: ${taskIntent.desired_outcome}`,
      verification_method: "利用者または担当者の判断を記録する",
      dependencies: [],
    });
  }

  const byCandidate = new Map(candidates.map((candidate) => [candidate.candidate_id, candidate]));
  for (const candidate of candidates) {
    for (const dependency of candidate.dependencies) {
      if (!byCandidate.has(dependency)) {
        throw compilerError("CAPABILITY_GRAPH_UNKNOWN_DEPENDENCY", "Rule emit depends on an unknown emit", { candidate_id: candidate.candidate_id, dependency });
      }
    }
  }

  const deduped = new Map();
  for (const candidate of candidates) {
    const key = needKey(candidate);
    if (!deduped.has(key)) deduped.set(key, { ...candidate, candidate_ids: [], dependency_ids: new Set(), provenance: [] });
    const record = deduped.get(key);
    record.candidate_ids.push(candidate.candidate_id);
    for (const field of candidate.matched_fields) record.provenance.push({ rule_id: candidate.rule_id, matched_field: field });
  }
  const candidateNeedIds = new Map();
  for (const record of deduped.values()) {
    const id = needId(record);
    record.need_id = id;
    record.candidate_ids.forEach((candidateId) => candidateNeedIds.set(candidateId, id));
  }
  for (const record of deduped.values()) {
    for (const candidateId of record.candidate_ids) {
      for (const dependency of byCandidate.get(candidateId).dependencies) record.dependency_ids.add(candidateNeedIds.get(dependency));
    }
  }

  const needs = [...deduped.values()].map((record) => {
    const need = {
      need_id: record.need_id,
      description: record.description,
      kind: record.kind,
      required_level: "required",
      hard_constraints: taskIntent.constraints,
      dependencies: [...record.dependency_ids].sort(compareText),
      verification_method: record.verification_method,
      status: "open",
      confidence: record.kind === "human_judgment" ? 0 : 100,
    };
    return assertContract("capability-need", need);
  }).sort((left, right) => compareText(left.need_id, right.need_id));
  detectCycles(needs);
  const edges = needs.flatMap((need) => need.dependencies.map((from_need_id) => ({ from_need_id, to_need_id: need.need_id })))
    .sort((left, right) => compareText(left.from_need_id, right.from_need_id) || compareText(left.to_need_id, right.to_need_id));
  const provenance = [...deduped.values()].flatMap((record) => record.provenance.map((source) => ({ need_id: record.need_id, ...source })))
    .sort((left, right) => compareText(left.need_id, right.need_id) || compareText(left.rule_id || "", right.rule_id || "") || compareText(left.matched_field || "", right.matched_field || ""));
  const unresolved_need_ids = needs.filter((need) => need.kind === "human_judgment").map((need) => need.need_id);
  const content = {
    task_intent_id: taskIntent.task_intent_id,
    compiler_version: 1,
    needs,
    edges,
    unresolved_need_ids,
    provenance,
  };
  const graph_hash = canonicalHash(content);
  return { graph_id: `CG-${graph_hash.slice(0, 12)}`, ...content, graph_hash };
}

module.exports = { buildGraph };
