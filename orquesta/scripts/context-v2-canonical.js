"use strict";

function loadContextRuntime() {
  try {
    return require("../../packages/context-compiler/src");
  } catch (error) {
    if (error?.code !== "MODULE_NOT_FOUND") throw error;
    return require("../runtime/context-v2-runtime.cjs");
  }
}

const { evaluateContextV2Activation } = loadContextRuntime();

const LIMITED_CONTEXT_QUALIFICATION = Object.freeze({
  version: 2,
  qualification_id: "context-v2-limited-2026-07-31",
  scope: "structurally_eligible_limited_context",
  passed: true,
  blockers: [],
  evidence_refs: [
    "benchmarks/orquesta-v4-product/reports/context-canary-20260731-consolidated.md",
    "docs/design/2026-07-31-orquesta-adaptive-context-router-v2.md",
  ],
  qualified_at: "2026-07-31T00:00:00.000Z",
});

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function bindGeneratedContextV2({ tasksState, batch, contextV2, generatedAt }) {
  const comparisons = new Map((contextV2?.shadowIndex?.comparisons || []).map((entry) => [entry.task_id, entry]));
  const requirements = new Map((contextV2?.requirements || []).map((entry) => [entry.requirement_id, entry]));
  const packs = new Map((contextV2?.packs || []).map((entry) => [entry.context_pack_id, entry]));
  const sourceRefs = new Map((contextV2?.sourceCatalog?.records || []).map((entry) => [entry.source_id, entry.source_ref]));
  const activations = [];

  function profileFor(taskId, currentProfile = {}) {
    const comparison = comparisons.get(taskId);
    if (!comparison) return clone(currentProfile) || {};
    const requirement = requirements.get(comparison.context_requirement_id) || currentProfile.context_requirement;
    const pack = packs.get(comparison.context_pack_id);
    if (!requirement || !pack) return clone(currentProfile) || {};
    const evaluated = evaluateContextV2Activation({
      featureMode: "limited",
      contextRequirement: requirement,
      contextPack: pack,
      variantComparison: LIMITED_CONTEXT_QUALIFICATION,
    });
    const route = {
      ...evaluated,
      task_id: taskId,
      selected_source_refs: evaluated.fallback
        ? []
        : (pack.selected_sources || []).map((sourceId) => sourceRefs.get(sourceId)).filter(Boolean).sort(),
      qualification_id: LIMITED_CONTEXT_QUALIFICATION.qualification_id,
      generated_at: generatedAt,
    };
    activations.push(route);
    return {
      ...clone(currentProfile),
      context_requirement: clone(requirement),
      context_pack_id: pack.context_pack_id,
      context_route: route,
    };
  }

  const nextTasks = {
    ...clone(tasksState),
    tasks: (tasksState?.tasks || []).map((task) => ({
      ...task,
      task_profile: profileFor(task.task_id, task.task_profile),
    })),
    updated_at: generatedAt,
  };
  const activationByTask = new Map(activations.map((entry) => [entry.task_id, entry]));
  const nextBatch = {
    ...clone(batch),
    requests: (batch?.requests || []).map((request) => {
      const task = nextTasks.tasks.find((entry) => entry.task_id === request.task_id);
      return task ? { ...request, task_profile: clone(task.task_profile) } : request;
    }),
    updated_at: generatedAt,
  };
  return {
    tasksState: nextTasks,
    batch: nextBatch,
    activations: [...activationByTask.values()].sort((left, right) => left.task_id.localeCompare(right.task_id)),
    qualification: clone(LIMITED_CONTEXT_QUALIFICATION),
  };
}

module.exports = {
  LIMITED_CONTEXT_QUALIFICATION,
  bindGeneratedContextV2,
};
